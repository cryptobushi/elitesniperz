const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const {
    MAP_SIZE, SHOOT_RANGE, SHOOT_COOLDOWN, FPS_SHOOT_FOV, SPAWN_PROTECTION,
    MAX_PLAYERS, TICK_RATE, SEND_RATE, BOT_NAMES, SHOP_ITEMS,
    terrainY, spawnPos, isNearSpawn
} = require('./shared/constants');
const { collidesWithWall, hasLineOfSight } = require('./shared/collision');

// === EXPRESS + STATIC ===
const app = express();
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.static(path.join(__dirname)));

// === TLS (Let's Encrypt) ===
const CERT_DIR = '/etc/letsencrypt/live/sniperz.fun';
let server, hasTLS = false;
try {
    server = https.createServer({
        cert: fs.readFileSync(path.join(CERT_DIR, 'fullchain.pem')),
        key: fs.readFileSync(path.join(CERT_DIR, 'privkey.pem'))
    }, app);
    hasTLS = true;
} catch (e) {
    console.log('No TLS certs, falling back to HTTP:', e.message);
    server = http.createServer(app);
}
const wss = new WebSocketServer({ server });

// /debug needs wss defined
app.get('/debug', (req, res) => {
    const list = [];
    players.forEach((p, id) => list.push({ id, name: p.username, team: p.team, isBot: p.isBot, x: Math.round(p.x), z: Math.round(p.z), health: p.health, kills: p.kills, deaths: p.deaths }));
    res.json({ players: list, total: players.size, clients: wss.clients.size });
});

console.log('Collision walls loaded from shared/collision.js');

// === TEST MODE ===
// GET /test-mode?on=1  → enter test mode (1 passive bot at center, verbose logs)
// GET /test-mode?on=0  → exit test mode (restore normal 5v5)
app.get('/test-mode', (req, res) => {
    if (req.query.on === '1') {
        enterTestMode();
        res.json({ mode: 'test', players: players.size });
    } else {
        exitTestMode();
        res.json({ mode: 'normal', players: players.size });
    }
});

function enterTestMode() {
    TEST_MODE = true;
    // Clear all players
    players.clear();
    // Spawn one passive bot near map center on enemy team (blue)
    const dummy = createPlayer(nextId++, 'TargetDummy', 'blue', true);
    dummy.x = -3; dummy.z = -3; dummy.y = terrainY(-3, -3) + 0.6;
    dummy._passive = false; // Uses normal bot AI — moves and explores but won't shoot player (god mode)
    players.set(dummy.id, dummy);
    // Broadcast roster update
    broadcastRoster();
    console.log('[TEST MODE] Entered — 1 passive bot at center');
}

function exitTestMode() {
    TEST_MODE = false;
    // Remove passive bots
    players.clear();
    nextId = 1;
    // Re-init normal 5v5
    for (let i = 0; i < MAX_PLAYERS; i++) {
        const team = i < 5 ? 'red' : 'blue';
        const bot = createPlayer(nextId++, BOT_NAMES[i], team, true);
        players.set(bot.id, bot);
    }
    broadcastRoster();
    console.log('[TEST MODE] Exited — normal 5v5 restored');
}

function broadcastRoster() {
    const roster = [];
    players.forEach(function(p) {
        roster.push({ id: p.id, n: p.username, m: p.team, b: p.isBot ? 1 : 0 });
    });
    broadcast(JSON.stringify({ t: 'roster', r: roster }));
}

// === HELPER ===
function dist(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
}

// === MATCH CONFIG ===
const KILL_LIMIT = 50;
const TIME_LIMIT = 20 * 60; // 20 minutes in seconds
const RESTART_DELAY = 12; // seconds between match end and new match

// === STATE ===
const players = new Map(); // id -> state
let nextId = 1;
let firstBlood = false;
let teamKills = { red: 0, blue: 0 };
let matchStartTime = Date.now();
let matchOver = false;
let matchTimer = null;
let TEST_MODE = false; // Activated via ?test — single passive bot, verbose logging

// Track disconnected players for rejoin (username -> saved state)
const disconnectedPlayers = new Map();
const AFK_TIMEOUT = 120; // seconds before AFK player becomes bot-controlled
const REJOIN_WINDOW = 300; // seconds to rejoin and recover state

function createPlayer(id, name, team, isBot) {
    const pos = spawnPos(team);
    return {
        id, username: name, team, isBot,
        x: pos.x, z: pos.z, y: terrainY(pos.x, pos.z) + 0.6,
        rot: 0, health: 100, kills: 0, deaths: 0,
        price: 1.0, gold: 0, streak: 0,
        spawnProt: SPAWN_PROTECTION, windwalk: false, windwalkTimer: 0,
        farsight: false, farsightX: 0, farsightZ: 0, farsightTimer: 0,
        shootCd: 0, shootRange: SHOOT_RANGE, shootCooldownTime: SHOOT_COOLDOWN, aimRot: 0, fpsMode: false,
        speed: 8, normalSpeed: 8, windwalkSpeed: 14,
        hasShield: false, goldMultiplier: 1.0,
        inventory: {},
        moveTarget: null,
        // Bot AI
        botState: 'explore', botTarget: null, campTimer: 0, stuckFrames: 0,
        lastX: pos.x, lastZ: pos.z,
        // AFK tracking (humans only)
        lastInput: Date.now(),
        afk: false
    };
}

// Init bots: 5 red, 5 blue
for (let i = 0; i < MAX_PLAYERS; i++) {
    const team = i < 5 ? 'red' : 'blue';
    const bot = createPlayer(nextId++, BOT_NAMES[i], team, true);
    players.set(bot.id, bot);
}
console.log(`Initialized ${players.size} bots`);

// === BINARY STATE ENCODING ===
// Per-player: id(2) + x(f32) + z(f32) + rot(f32) + health(1) + kills(i16) + deaths(i16) + price(f32) + flags(1) + streak(i16) + gold(i16) = 28 bytes
const BYTES_PER_PLAYER = 28;

// Track which enemies each team has seen (for hysteresis)
const _teamVisible = { red: new Set(), blue: new Set() };

function encodeState(viewerTeam) {
    // Determine which enemies are visible in FOW (with hysteresis)
    const enemyVisible = new Set();
    const prevVisible = _teamVisible[viewerTeam];
    players.forEach(function(p) {
        if (p.team === viewerTeam || p.health <= 0) return;
        if (p.windwalk) return;
        // Hysteresis: 50 units to enter vision, 53 to leave (small buffer)
        var enterRange = SHOOT_RANGE, exitRange = SHOOT_RANGE + 3;
        var wasVisible = prevVisible.has(p.id);
        var vr = wasVisible ? exitRange : enterRange;
        players.forEach(function(ally) {
            if (enemyVisible.has(p.id)) return;
            if (ally.team === viewerTeam && ally.health > 0) {
                if (ally.farsight) {
                    var fdx = p.x - ally.farsightX, fdz = p.z - ally.farsightZ;
                    if (fdx * fdx + fdz * fdz <= 75 * 75) { enemyVisible.add(p.id); return; }
                }
                var dx = p.x - ally.x, dz = p.z - ally.z;
                if (dx * dx + dz * dz <= vr * vr) { enemyVisible.add(p.id); }
            }
        });
    });
    _teamVisible[viewerTeam] = enemyVisible;

    // Always send ALL players — client uses inFog flag to hide position
    const all = [];
    players.forEach(function(p) { all.push(p); });

    const count = all.length;
    const ab = new ArrayBuffer(2 + count * BYTES_PER_PLAYER);
    const view = new DataView(ab);
    view.setUint16(0, count, true);
    let off = 2;
    for (let i = 0; i < all.length; i++) {
        const p = all[i];
        const isEnemy = p.team !== viewerTeam;
        const inFog = isEnemy && p.health > 0 && !enemyVisible.has(p.id);

        view.setUint16(off, p.id, true); off += 2;
        // Send last-known position for fog enemies (won't be rendered anyway)
        view.setFloat32(off, p.x, true); off += 4;
        view.setFloat32(off, p.z, true); off += 4;
        view.setFloat32(off, p.rot, true); off += 4;
        view.setUint8(off, p.health > 0 ? 1 : 0); off += 1;
        view.setInt16(off, p.kills, true); off += 2;
        view.setInt16(off, p.deaths, true); off += 2;
        view.setFloat32(off, p.price, true); off += 4;
        // flags: bit0=windwalk, bit1=spawnProt, bit2=isBot, bit3=blue team, bit4=inFog
        let flags = 0;
        if (p.windwalk) flags |= 1;
        if (p.spawnProt > 0) flags |= 2;
        if (p.isBot) flags |= 4;
        if (p.team === 'blue') flags |= 8;
        if (inFog) flags |= 16;
        view.setUint8(off, flags); off += 1;
        view.setInt16(off, p.streak, true); off += 2;
        view.setInt16(off, Math.min(p.gold, 32767), true); off += 2;
    }
    return Buffer.from(ab);
}

// === APPLY ITEMS ===
function applyItems(p) {
    p.normalSpeed = 8;
    p.shootRange = SHOOT_RANGE;
    p.shootCooldownTime = SHOOT_COOLDOWN;
    p.goldMultiplier = 1.0;
    p.hasShield = false;

    for (const id of Object.keys(p.inventory)) {
        const item = SHOP_ITEMS[id];
        if (!item) continue;
        if (item.stat === 'speed') p.normalSpeed = 8 * item.mult;
        if (item.stat === 'range') p.shootRange = SHOOT_RANGE * item.mult;
        if (item.stat === 'firerate') p.shootCooldownTime = SHOOT_COOLDOWN * item.mult;
        if (item.stat === 'goldMult') p.goldMultiplier *= item.mult;
        if (item.stat === 'shield') p.hasShield = true;
    }
    p.speed = p.normalSpeed;
    p.windwalkSpeed = p.normalSpeed * 1.75;
}

function buyItem(p, itemId) {
    const item = SHOP_ITEMS[itemId];
    if (!item) return false;
    if (p.gold < item.cost) return false;
    if (p.inventory[itemId] && !item.stackable) return false;
    if (item.requires && !p.inventory[item.requires]) return false;
    if (!isNearSpawn(p.x, p.z, p.team)) return false;

    p.gold -= item.cost;
    p.inventory[itemId] = true;
    applyItems(p);
    return true;
}

// === BOT AI ===

function pickTarget(bot) {
    // 60% chance to patrol center area (where combat happens), 40% wider map
    var centerBias = Math.random() < 0.6;
    for (var i = 0; i < 20; i++) {
        var tx, tz;
        if (centerBias) {
            tx = (Math.random() - 0.5) * MAP_SIZE * 0.4; // center 40%
            tz = (Math.random() - 0.5) * MAP_SIZE * 0.4;
        } else {
            var bias = bot.team === 'red' ? -0.15 : 0.15;
            tx = (Math.random() - 0.5 + bias) * MAP_SIZE * 0.7;
            tz = (Math.random() - 0.5 + bias) * MAP_SIZE * 0.7;
        }
        var esx = bot.team === 'red' ? 70 : -70;
        if (Math.sqrt((tx-esx)*(tx-esx)+(tz-esx)*(tz-esx)) < 25) continue;
        if (collidesWithWall(tx, tz, 1.0)) continue;
        return { x: tx, z: tz };
    }
    // Fallback to center
    return { x: (Math.random()-0.5) * 30, z: (Math.random()-0.5) * 30 };
}

// Try to move bot from current pos toward (nx, nz). Returns true if moved.
var BOT_RADIUS = 0.8; // Slightly smaller than 1.0 so bots fit through gaps
function tryMove(bot, nx, nz) {
    // Clamp to map
    nx = Math.max(-MAP_SIZE/2+2, Math.min(MAP_SIZE/2-2, nx));
    nz = Math.max(-MAP_SIZE/2+2, Math.min(MAP_SIZE/2-2, nz));

    // Direct move
    if (!collidesWithWall(nx, nz, BOT_RADIUS)) {
        bot.x = nx; bot.z = nz; return true;
    }
    // Wall slide X
    if (!collidesWithWall(nx, bot.z, BOT_RADIUS)) {
        bot.x = nx; return true;
    }
    // Wall slide Z
    if (!collidesWithWall(bot.x, nz, BOT_RADIUS)) {
        bot.z = nz; return true;
    }
    return false;
}

function updateBot(bot, dt) {
    if (bot.health <= 0) return;
    if (bot._passive) return;

    // Track real movement — if barely moved in 0.75s, pick totally new target
    if (!bot._lastRealX) { bot._lastRealX = bot.x; bot._lastRealZ = bot.z; bot._idleTicks = 0; }
    var moved = Math.abs(bot.x - bot._lastRealX) > 0.5 || Math.abs(bot.z - bot._lastRealZ) > 0.5;
    if (moved) {
        bot._lastRealX = bot.x; bot._lastRealZ = bot.z; bot._idleTicks = 0;
    } else {
        bot._idleTicks++;
        if (bot._idleTicks > 48) { // ~0.75 seconds — give up fast
            // Pick a random direction that's clear, not a strategic target
            for (var attempt = 0; attempt < 10; attempt++) {
                var escAngle = Math.random() * Math.PI * 2;
                var escDist = 10 + Math.random() * 20;
                var ex = bot.x + Math.cos(escAngle) * escDist;
                var ez = bot.z + Math.sin(escAngle) * escDist;
                ex = Math.max(-MAP_SIZE/2+5, Math.min(MAP_SIZE/2-5, ex));
                ez = Math.max(-MAP_SIZE/2+5, Math.min(MAP_SIZE/2-5, ez));
                if (!collidesWithWall(ex, ez, BOT_RADIUS)) {
                    bot.botTarget = { x: ex, z: ez };
                    break;
                }
            }
            bot.stuckFrames = 0; bot.chaseDetour = false;
            bot._idleTicks = 0;
            bot._nudgeSide = Math.random() < 0.5 ? 1 : -1;
        }
    }

    // If bot is inside a wall, push it out
    if (collidesWithWall(bot.x, bot.z, BOT_RADIUS)) {
        var pushSpd = bot.speed * dt * 4;
        for (var a = 0; a < Math.PI * 2; a += Math.PI / 16) {
            var px = bot.x + Math.cos(a) * pushSpd;
            var pz = bot.z + Math.sin(a) * pushSpd;
            if (!collidesWithWall(px, pz, BOT_RADIUS)) {
                bot.x = px; bot.z = pz; break;
            }
        }
    }

    // Find closest enemy
    var closestEnemy = null, closestDist = Infinity;
    players.forEach(function(e) {
        if (e !== bot && e.team !== bot.team && e.health > 0 && !e.windwalk) {
            var d = dist(bot, e);
            if (d < closestDist) { closestDist = d; closestEnemy = e; }
        }
    });

    // Chase enemy in vision range
    if (closestEnemy && closestDist < SHOOT_RANGE * 1.5) {
        if (hasLineOfSight(bot.x, bot.z, closestEnemy.x, closestEnemy.z)) {
            bot.botTarget = { x: closestEnemy.x, z: closestEnemy.z };
            bot.chaseDetour = false;
            bot.stuckFrames = 0;
        } else if (!bot.chaseDetour || bot.stuckFrames > 10) {
            // Try to go around — test both sides, pick the one that's clear
            var angle = Math.atan2(closestEnemy.z - bot.z, closestEnemy.x - bot.x);
            var detourDist = 6 + Math.random() * 8;
            var bestWP = null;
            for (var side = -1; side <= 1; side += 2) {
                for (var spread = 0.4; spread <= 1.2; spread += 0.4) {
                    var da = angle + side * (Math.PI * spread);
                    var wx = bot.x + Math.cos(da) * detourDist;
                    var wz = bot.z + Math.sin(da) * detourDist;
                    wx = Math.max(-MAP_SIZE/2+5, Math.min(MAP_SIZE/2-5, wx));
                    wz = Math.max(-MAP_SIZE/2+5, Math.min(MAP_SIZE/2-5, wz));
                    if (!collidesWithWall(wx, wz, BOT_RADIUS)) {
                        bestWP = { x: wx, z: wz }; break;
                    }
                }
                if (bestWP) break;
            }
            if (bestWP) bot.botTarget = bestWP;
            else bot.botTarget = pickTarget(bot); // give up on this enemy
            bot.chaseDetour = true;
            bot.stuckFrames = 0;
        }
    }

    // Pick new target when needed
    if (!bot.botTarget || dist(bot, bot.botTarget) < 3) {
        bot.botTarget = pickTarget(bot);
        bot.chaseDetour = false;
        bot.stuckFrames = 0;
    }

    // Move toward target
    var dx = bot.botTarget.x - bot.x;
    var dz = bot.botTarget.z - bot.z;
    var d = Math.sqrt(dx * dx + dz * dz);
    if (d > 0.1) {
        var spd = (bot.windwalk ? bot.windwalkSpeed : bot.speed) * dt;
        var nx = bot.x + (dx / d) * spd;
        var nz = bot.z + (dz / d) * spd;

        if (!tryMove(bot, nx, nz)) {
            bot.stuckFrames++;
            if (!bot._nudgeSide) bot._nudgeSide = Math.random() < 0.5 ? 1 : -1;
            var moveAngle = Math.atan2(dz, dx);
            var nudged = false;

            // Try both sides at multiple angles — 6 attempts total
            for (var ni = 1; ni <= 3 && !nudged; ni++) {
                var na = moveAngle + bot._nudgeSide * (ni * Math.PI / 4);
                nudged = tryMove(bot, bot.x + Math.cos(na) * spd * 2, bot.z + Math.sin(na) * spd * 2);
            }
            if (!nudged) {
                // Try other side
                for (var ni2 = 1; ni2 <= 3 && !nudged; ni2++) {
                    var na2 = moveAngle - bot._nudgeSide * (ni2 * Math.PI / 4);
                    nudged = tryMove(bot, bot.x + Math.cos(na2) * spd * 2, bot.z + Math.sin(na2) * spd * 2);
                }
            }

            if (bot.stuckFrames > 8) {
                // Stuck — immediately pick new target in a clear direction
                bot.botTarget = null; // forces pickTarget next frame
                bot.chaseDetour = false;
                bot.stuckFrames = 0;
                bot._nudgeSide *= -1;
            }
        } else {
            bot.stuckFrames = 0;
        }

        bot.y = terrainY(bot.x, bot.z) + 0.6;
        bot.rot = Math.atan2(dx, dz);
    }

    // Aim at closest enemy — bot must turn to face + reaction delay before shooting
    if (closestEnemy && closestDist <= bot.shootRange && hasLineOfSight(bot.x, bot.z, closestEnemy.x, closestEnemy.z)) {
        // Reaction delay: when first spotting an enemy, wait before shooting
        if (!bot.losTarget || bot.losTarget !== closestEnemy.id) {
            bot.losTarget = closestEnemy.id;
            bot.losTimer = 1.0 + Math.random() * 1.5; // 1.0–2.5s reaction time
        }
        if (bot.losTimer > 0) {
            bot.losTimer -= dt;
        }

        var targetRot = Math.atan2(closestEnemy.x - bot.x, closestEnemy.z - bot.z);
        // Turn toward enemy gradually (~120°/sec)
        var turnSpeed = 2.0 * dt;
        var diff = targetRot - bot.rot;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        if (Math.abs(diff) < turnSpeed) {
            bot.rot = targetRot;
        } else {
            bot.rot += (diff > 0 ? 1 : -1) * turnSpeed;
        }

        // Only allow shooting after reaction delay expires
        bot.aimRot = (bot.losTimer <= 0) ? bot.rot : bot.rot + Math.PI; // aim away until ready
    } else {
        bot.aimRot = bot.rot;
        bot.losTarget = null;
        bot.losTimer = 0;
    }

    // Auto-buy
    if (bot.gold >= 100 && isNearSpawn(bot.x, bot.z, bot.team)) {
        botShop(bot);
    }
}

function botShop(bot) {
    const priorities = ['boots1', 'scope1', 'shield', 'rapidfire', 'boots2', 'scope2', 'bounty', 'cloak1'];
    for (const id of priorities) {
        buyItem(bot, id);
    }
}

// === SHOOTING ===
function tryShoot(attacker) {
    if (attacker.health <= 0) return;
    if (attacker._passive) return; // Test dummy doesn't shoot
    if (attacker.shootCd > 0) return;

    // Use aimRot (from client mouse/weapon aim) if available, otherwise movement rot
    const aimDir = attacker.aimRot !== undefined ? attacker.aimRot : attacker.rot;

    const isLog = TEST_MODE && !attacker.isBot; // Log human shots in test mode
    if (isLog) console.log('[SHOOT] ' + attacker.username + ' at(' + attacker.x.toFixed(1) + ',' + attacker.z.toFixed(1) + ') aimRot=' + (aimDir * 180 / Math.PI).toFixed(1) + '°');

    let closest = null, closestDist = Infinity;
    players.forEach(function(p) {
        if (p === attacker || p.team === attacker.team || p.health <= 0) return;
        if (p.windwalk) { if (isLog) console.log('  → ' + p.username + ' SKIP windwalk'); return; }
        if (p.spawnProt > 0) { if (isLog) console.log('  → ' + p.username + ' SKIP spawnProt'); return; }
        if (p.godMode) { if (isLog) console.log('  → ' + p.username + ' SKIP godMode'); return; }
        // Must be within attacker's personal vision (same as client fog radius)
        var vdx = p.x - attacker.x, vdz = p.z - attacker.z;
        var visionDist2 = vdx * vdx + vdz * vdz;
        if (visionDist2 > SHOOT_RANGE * SHOOT_RANGE) { if (isLog) console.log('  → ' + p.username + ' SKIP vision dist=' + Math.sqrt(visionDist2).toFixed(1)); return; }
        const d = dist(attacker, p);
        if (d > attacker.shootRange) { if (isLog) console.log('  → ' + p.username + ' SKIP range dist=' + d.toFixed(1) + ' range=' + attacker.shootRange); return; }
        // FOV cone: 30° for everyone
        const fovDeg = 30;
        const dx = p.x - attacker.x, dz = p.z - attacker.z;
        const angle = Math.atan2(dx, dz);
        let diff = angle - aimDir;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        const fovRad = fovDeg * Math.PI / 180;
        if (Math.abs(diff) >= fovRad) {
            if (isLog) console.log('  → ' + p.username + ' SKIP fov angle=' + (diff * 180 / Math.PI).toFixed(1) + '° (max ±' + fovDeg + '°) target(' + p.x.toFixed(1) + ',' + p.z.toFixed(1) + ')');
            return;
        }
        const los = hasLineOfSight(attacker.x, attacker.z, p.x, p.z);
        if (!los) {
            if (isLog) console.log('  → ' + p.username + ' SKIP no LOS from(' + attacker.x.toFixed(1) + ',' + attacker.z.toFixed(1) + ') to(' + p.x.toFixed(1) + ',' + p.z.toFixed(1) + ')');
            return;
        }
        if (isLog) console.log('  → ' + p.username + ' CANDIDATE dist=' + d.toFixed(1) + ' fov=' + (diff * 180 / Math.PI).toFixed(1) + '° LOS=✓');
        if (d < closestDist) {
            closest = p;
            closestDist = d;
        }
    });

    if (!closest) { if (isLog) console.log('  → NO TARGET'); return; }
    if (matchOver) return;
    if (isLog) console.log('  → KILL ' + closest.username + ' dist=' + closestDist.toFixed(1));
    attacker.shootCd = attacker.shootCooldownTime;

    // Shield blocks one hit
    if (closest.hasShield) {
        closest.hasShield = false;
        delete closest.inventory['shield'];
        applyItems(closest);
        broadcast(JSON.stringify({ t: 'shld', vi: closest.id }));
        return;
    }

    // KILL
    closest.health = 0;
    closest.deaths++;
    closest.price = Math.max(0.1, closest.price * 0.5);
    closest.streak = 0;
    // Lose items on death
    closest.inventory = {};
    applyItems(closest);

    attacker.kills++;
    attacker.streak++;
    attacker.price += 0.5 + closest.price * 0.3;
    const baseGold = 50;
    const streakBonus = attacker.streak * 10;
    const victimBonus = Math.round(closest.price * 10);
    const gold = Math.round((baseGold + streakBonus + victimBonus) * attacker.goldMultiplier);
    attacker.gold += gold;

    const fb = !firstBlood;
    if (fb) firstBlood = true;

    teamKills[attacker.team]++;

    broadcast(JSON.stringify({
        t: 'k',
        ki: attacker.id, kn: attacker.username,
        vi: closest.id, vn: closest.username,
        g: gold, p: attacker.price, s: attacker.streak,
        fb: fb ? 1 : 0,
        kx: attacker.x, kz: attacker.z,
        vx: closest.x, vz: closest.z,
        kt: attacker.team, vt: closest.team,
        rk: teamKills.red, bk: teamKills.blue
    }));

    // Check win condition
    if (teamKills[attacker.team] >= KILL_LIMIT) {
        endMatch(attacker.team, 'kill_limit');
    }

    // Respawn after 5s
    const deadId = closest.id;
    setTimeout(function() {
        const p = players.get(deadId);
        if (!p) return;
        const pos = spawnPos(p.team);
        p.health = 100;
        p.x = pos.x;
        p.z = pos.z;
        p.y = terrainY(pos.x, pos.z) + 0.6;
        p.spawnProt = SPAWN_PROTECTION;
        p.streak = 0;
        p.moveTarget = null;
        p.botTarget = null;
        p.botState = 'explore';
        if (p.isBot) botShop(p);
        broadcast(JSON.stringify({ t: 'r', id: p.id, x: pos.x, z: pos.z }));
    }, 5000);
}

// FPS manual shooting — tighter FOV, client sends aim direction
// Ray-cylinder intersection: does ray from origin+dir hit a vertical cylinder?
// Cylinder centered at (cx, cz) with radius cr, from y=cy to y=cy+ch
// Returns distance along ray or Infinity if miss
function rayCylinder(ox, oy, oz, dx, dy, dz, cx, cy, cz, cr, ch) {
    // Project to XZ plane for infinite cylinder test
    const ax = ox - cx, az = oz - cz;
    const a = dx * dx + dz * dz;
    const b = 2 * (ax * dx + az * dz);
    const c = ax * ax + az * az - cr * cr;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return Infinity;
    const sqrtDisc = Math.sqrt(disc);
    const t1 = (-b - sqrtDisc) / (2 * a);
    const t2 = (-b + sqrtDisc) / (2 * a);

    // Check both intersection points against cylinder height
    for (const t of [t1, t2]) {
        if (t < 0) continue;
        const hitY = oy + dy * t;
        if (hitY >= cy && hitY <= cy + ch) return t;
    }
    // Check caps (top and bottom)
    if (Math.abs(dy) > 0.0001) {
        for (const capY of [cy, cy + ch]) {
            const t = (capY - oy) / dy;
            if (t < 0) continue;
            const hx = ox + dx * t - cx;
            const hz = oz + dz * t - cz;
            if (hx * hx + hz * hz <= cr * cr) return t;
        }
    }
    return Infinity;
}

function tryFpsShoot(attacker, yaw, pitch) {
    if (attacker.health <= 0) return;
    if (attacker.shootCd > 0) return;

    // Ray origin: attacker eye position
    const eyeH = 1.4;
    const ox = attacker.x, oy = attacker.y + eyeH, oz = attacker.z;
    // Ray direction from yaw + pitch
    const cosPitch = Math.cos(pitch || 0);
    const rdx = Math.sin(yaw) * cosPitch;
    const rdy = Math.sin(pitch || 0);
    const rdz = Math.cos(yaw) * cosPitch;

    // Hitbox: cylinder radius 0.8, height 2.4 (feet to head)
    const HIT_RADIUS = 0.8;
    const HIT_HEIGHT = 2.4;

    let closest = null, closestDist = Infinity;

    players.forEach(function(p) {
        if (p === attacker || p.team === attacker.team || p.health <= 0) return;
        if (p.windwalk) return;
        if (p.spawnProt > 0) return;
        if (p.godMode) return;
        // Quick range check first
        var vdx = p.x - attacker.x, vdz = p.z - attacker.z;
        if (vdx * vdx + vdz * vdz > attacker.shootRange * attacker.shootRange) return;
        if (!hasLineOfSight(attacker.x, attacker.z, p.x, p.z)) return;
        // Ray-cylinder intersection
        const cylBase = p.y - 0.6; // p.y is center, feet are lower
        const t = rayCylinder(ox, oy, oz, rdx, rdy, rdz, p.x, cylBase, p.z, HIT_RADIUS, HIT_HEIGHT);
        if (t < Infinity && t < closestDist) {
            closest = p;
            closestDist = t;
        }
    });

    // Always consume cooldown on FPS shot (even miss)
    attacker.shootCd = attacker.shootCooldownTime;

    if (!closest) {
        // Miss — broadcast tracer for visual feedback
        broadcast(JSON.stringify({ t: 'miss', id: attacker.id, yaw: yaw, pitch: pitch || 0, x: attacker.x, z: attacker.z }));
        return;
    }
    if (matchOver) return;

    // Same kill logic as tryShoot
    if (closest.hasShield) {
        closest.hasShield = false;
        delete closest.inventory['shield'];
        applyItems(closest);
        broadcast(JSON.stringify({ t: 'shld', vi: closest.id }));
        return;
    }

    closest.health = 0;
    closest.deaths++;
    closest.price = Math.max(0.1, closest.price * 0.5);
    closest.streak = 0;
    closest.inventory = {};
    applyItems(closest);

    attacker.kills++;
    attacker.streak++;
    attacker.price += 0.5 + closest.price * 0.3;
    const baseGold = 50;
    const streakBonus = attacker.streak * 10;
    const victimBonus = Math.round(closest.price * 10);
    const gold = Math.round((baseGold + streakBonus + victimBonus) * attacker.goldMultiplier);
    attacker.gold += gold;

    const fb = !firstBlood;
    if (fb) firstBlood = true;
    teamKills[attacker.team]++;

    broadcast(JSON.stringify({
        t: 'k',
        ki: attacker.id, kn: attacker.username,
        vi: closest.id, vn: closest.username,
        g: gold, p: attacker.price, s: attacker.streak,
        fb: fb ? 1 : 0,
        kx: attacker.x, kz: attacker.z,
        vx: closest.x, vz: closest.z,
        kt: attacker.team, vt: closest.team,
        rk: teamKills.red, bk: teamKills.blue
    }));

    if (teamKills[attacker.team] >= KILL_LIMIT) {
        endMatch(attacker.team, 'kill_limit');
    }

    const deadId = closest.id;
    setTimeout(function() {
        const p = players.get(deadId);
        if (!p) return;
        const pos = spawnPos(p.team);
        p.health = 100;
        p.x = pos.x; p.z = pos.z; p.y = terrainY(pos.x, pos.z) + 0.6;
        p.spawnProt = SPAWN_PROTECTION;
        p.streak = 0; p.moveTarget = null; p.botTarget = null; p.botState = 'explore';
        if (p.isBot) botShop(p);
        broadcast(JSON.stringify({ t: 'r', id: p.id, x: pos.x, z: pos.z }));
    }, 5000);
}

function broadcast(data) {
    wss.clients.forEach(function(ws) {
        if (ws.readyState === 1) ws.send(data);
    });
}

function broadcastExcept(data, excludeWs) {
    wss.clients.forEach(function(ws) {
        if (ws.readyState === 1 && ws !== excludeWs) ws.send(data);
    });
}

// === GAME LOOP ===
let tickCount = 0;
const sendEvery = Math.round(TICK_RATE / SEND_RATE);

setInterval(function() {
    const dt = 1 / TICK_RATE;
    tickCount++;

    players.forEach(function(p) {
        if (p.health <= 0) return;

        // Spawn protection countdown
        if (p.spawnProt > 0) {
            p.spawnProt -= dt;
            if (!isNearSpawn(p.x, p.z, p.team)) p.spawnProt = 0;
        }

        // Shoot cooldown
        if (p.shootCd > 0) p.shootCd -= dt;

        // Windwalk timer
        if (p.windwalk) {
            p.windwalkTimer -= dt;
            if (p.windwalkTimer <= 0) {
                p.windwalk = false;
                p.windwalkTimer = 0;
            }
        }

        // Farsight timer
        if (p.farsight) {
            p.farsightTimer -= dt;
            if (p.farsightTimer <= 0) {
                p.farsight = false;
                p.farsightTimer = 0;
            }
        }

        // AFK detection for human players
        if (!p.isBot) {
            const idleTime = (Date.now() - p.lastInput) / 1000;
            if (idleTime >= AFK_TIMEOUT && !p.afk) {
                p.afk = true;
                broadcast(JSON.stringify({ t: 'ch', n: 'Server', m: 'system', x: p.username + ' is now AFK' }));
            } else if (idleTime < AFK_TIMEOUT && p.afk) {
                p.afk = false;
                broadcast(JSON.stringify({ t: 'ch', n: 'Server', m: 'system', x: p.username + ' is back' }));
            }
        }

        // Bot AI (or AFK human auto-pilot)
        if (p.isBot || p.afk) {
            updateBot(p, dt);
        } else if (p.moveTarget) {
            // Human player movement — smaller radius for smoother wall sliding
            const dx = p.moveTarget.x - p.x;
            const dz = p.moveTarget.z - p.z;
            const d = Math.sqrt(dx * dx + dz * dz);
            if (d < 1) {
                p.moveTarget = null;
            } else {
                const spd = (p.windwalk ? p.windwalkSpeed : p.speed) * dt;
                const nx = p.x + dx / d * spd;
                const nz = p.z + dz / d * spd;
                if (!collidesWithWall(nx, nz, 0.8)) {
                    p.x = Math.max(-MAP_SIZE / 2 + 2, Math.min(MAP_SIZE / 2 - 2, nx));
                    p.z = Math.max(-MAP_SIZE / 2 + 2, Math.min(MAP_SIZE / 2 - 2, nz));
                } else if (!collidesWithWall(nx, p.z, 0.8)) {
                    p.x = Math.max(-MAP_SIZE / 2 + 2, Math.min(MAP_SIZE / 2 - 2, nx));
                } else if (!collidesWithWall(p.x, nz, 0.8)) {
                    p.z = Math.max(-MAP_SIZE / 2 + 2, Math.min(MAP_SIZE / 2 - 2, nz));
                }
                p.y = terrainY(p.x, p.z) + 0.6;
                p.rot = Math.atan2(dx, dz);
            }
        }

        // Auto-shoot — disabled for FPS mode players (they shoot manually)
        if (p.shootCd <= 0 && !p.fpsMode) tryShoot(p);
    });

    // Send state snapshots at lower rate
    if (tickCount % sendEvery === 0) {
        wss.clients.forEach(function(ws) {
            if (ws.readyState !== 1 || !ws.playerId) return;
            const p = players.get(ws.playerId);
            if (!p) return;
            const buf = encodeState(p.team);
            ws.send(buf);
        });
    }
}, 1000 / TICK_RATE);

// === CONNECTIONS ===
wss.on('connection', function(ws) {
    ws.playerId = null;

    ws.on('message', function(data) {
        try {
            const msg = JSON.parse(data);

            // Test mode: log all incoming messages (throttled for mv/rot)
            if (TEST_MODE && msg.t !== 'rot') {
                if (msg.t === 'mv') {
                    if (!ws._lastMvLog || Date.now() - ws._lastMvLog > 1000) {
                        ws._lastMvLog = Date.now();
                        const p = players.get(ws.playerId);
                        console.log('[TEST IN] mv x=' + (msg.x||0).toFixed(1) + ' z=' + (msg.z||0).toFixed(1) + ' server-pos(' + (p?p.x.toFixed(1):'?') + ',' + (p?p.z.toFixed(1):'?') + ')');
                    }
                } else {
                    console.log('[TEST IN] ' + msg.t + ' ' + JSON.stringify(msg).slice(0, 100));
                }
            }

            if (msg.t === 'join') {
                const name = (msg.n || 'Sniper').slice(0, 12);
                let team = msg.m === 'blue' ? 'blue' : 'red';

                if (TEST_MODE) {
                    // Test mode: player always joins red, no bot removal needed
                    team = 'red';
                    const player = createPlayer(nextId++, name, team, false);
                    player.godMode = true; // Can't die in test mode
                    console.log('[TEST] ' + name + ' joined test mode (god mode ON)');

                    // Skip normal bot removal / balance logic
                    // Jump to player registration below
                    players.set(player.id, player);
                    ws.playerId = player.id;
                    const roster = [];
                    players.forEach(function(p) {
                        roster.push({ id: p.id, n: p.username, m: p.team, b: p.isBot ? 1 : 0 });
                    });
                    const elapsed = Math.round((Date.now() - matchStartTime) / 1000);
                    ws.send(JSON.stringify({
                        t: 'j', id: player.id, roster: roster,
                        rk: teamKills.red, bk: teamKills.blue,
                        limit: KILL_LIMIT, timeLimit: TIME_LIMIT, elapsed: elapsed
                    }));
                    broadcast(JSON.stringify({ t: 'pj', n: name, m: team }));
                    return;
                }

                // Count players per team
                let redCount = 0, blueCount = 0;
                players.forEach(p => { if (p.team === 'red') redCount++; else blueCount++; });

                // Auto-balance: if requested team is full (5) or has more, put on other team
                if (team === 'red' && redCount >= 5 && blueCount < 5) team = 'blue';
                else if (team === 'blue' && blueCount >= 5 && redCount < 5) team = 'red';

                // Remove a bot from this team to make room (keep 5v5)
                let removed = false;
                for (const [id, p] of players) {
                    if (p.isBot && p.team === team) {
                        players.delete(id);
                        removed = true;
                        break;
                    }
                }
                // If no bot on that team, refuse join (server full for that team)
                if (!removed && (team === 'red' ? redCount : blueCount) >= 5) {
                    ws.send(JSON.stringify({ t: 'err', x: 'Team is full' }));
                    return;
                }

                const player = createPlayer(nextId++, name, team, false);
                // God mode available via G key (desktop) or 'god' message

                // Check for rejoin — restore saved state
                const saved = disconnectedPlayers.get(name.toLowerCase());
                if (saved && (Date.now() - saved.savedAt) < REJOIN_WINDOW * 1000 && saved.team === team) {
                    player.kills = saved.kills;
                    player.deaths = saved.deaths;
                    player.price = saved.price;
                    player.gold = saved.gold;
                    player.streak = saved.streak;
                    player.inventory = saved.inventory;
                    applyItems(player);
                    disconnectedPlayers.delete(name.toLowerCase());
                    console.log(name + ' rejoined — state restored');
                    broadcast(JSON.stringify({ t: 'ch', n: 'Server', m: 'system', x: name + ' reconnected' }));
                }

                players.set(player.id, player);
                ws.playerId = player.id;

                // Send join confirmation + roster
                const roster = [];
                players.forEach(function(p) {
                    roster.push({ id: p.id, n: p.username, m: p.team, b: p.isBot ? 1 : 0 });
                });
                const elapsed = Math.round((Date.now() - matchStartTime) / 1000);
                ws.send(JSON.stringify({
                    t: 'j', id: player.id, roster: roster,
                    rk: teamKills.red, bk: teamKills.blue,
                    limit: KILL_LIMIT, timeLimit: TIME_LIMIT, elapsed: elapsed
                }));
                broadcast(JSON.stringify({ t: 'pj', n: name, m: team }));
                console.log(name + ' joined ' + team + '. Total: ' + players.size);
            }
            else if (msg.t === 'mv' && ws.playerId) {
                const p = players.get(ws.playerId);
                if (p && p.health > 0) {
                    const mx = Math.max(-MAP_SIZE / 2, Math.min(MAP_SIZE / 2, msg.x || 0));
                    const mz = Math.max(-MAP_SIZE / 2, Math.min(MAP_SIZE / 2, msg.z || 0));
                    p.moveTarget = { x: mx, z: mz };
                    p.lastInput = Date.now();
                }
            }
            else if (msg.t === 'rot' && ws.playerId) {
                const p = players.get(ws.playerId);
                if (p) {
                    p.aimRot = msg.r || 0; p.rot = msg.r || 0; p.lastInput = Date.now();
                    // Throttled aim logging in test mode
                    if (TEST_MODE && !p.isBot) {
                        const now = Date.now();
                        if (!p._lastAimLog || now - p._lastAimLog > 1000) {
                            p._lastAimLog = now;
                            // Find dummy bot and log relative info
                            let dummyInfo = '';
                            players.forEach(dp => {
                                if (dp._passive) {
                                    const d = dist(p, dp);
                                    const dx = dp.x - p.x, dz = dp.z - p.z;
                                    const angleToTarget = Math.atan2(dx, dz);
                                    let fovDiff = angleToTarget - p.aimRot;
                                    while (fovDiff > Math.PI) fovDiff -= 2 * Math.PI;
                                    while (fovDiff < -Math.PI) fovDiff += 2 * Math.PI;
                                    const los = hasLineOfSight(p.x, p.z, dp.x, dp.z);
                                    dummyInfo = ' → dummy dist=' + d.toFixed(1) + ' fov=' + (fovDiff * 180 / Math.PI).toFixed(1) + '° LOS=' + los;
                                }
                            });
                            console.log('[TEST] pos(' + p.x.toFixed(1) + ',' + p.z.toFixed(1) + ') aim=' + (p.aimRot * 180 / Math.PI).toFixed(1) + '°' + dummyInfo);
                        }
                    }
                }
            }
            else if (msg.t === 'god' && ws.playerId) {
                const p = players.get(ws.playerId);
                if (p) { p.godMode = !p.godMode; console.log(p.username + ' god mode: ' + p.godMode); }
            }
            else if (msg.t === 'fps_move' && ws.playerId) {
                const p = players.get(ws.playerId);
                if (p && p.health > 0 && p.fpsMode) {
                    const nx = Math.max(-MAP_SIZE / 2 + 2, Math.min(MAP_SIZE / 2 - 2, msg.x || 0));
                    const nz = Math.max(-MAP_SIZE / 2 + 2, Math.min(MAP_SIZE / 2 - 2, msg.z || 0));
                    // Validate: not too far from current pos (anti-cheat: max ~2 units per tick)
                    const ddx = nx - p.x, ddz = nz - p.z;
                    const moveDist = Math.sqrt(ddx * ddx + ddz * ddz);
                    if (moveDist < 3 && !collidesWithWall(nx, nz, 0.8)) {
                        p.x = nx;
                        p.z = nz;
                        p.y = terrainY(nx, nz) + 0.6;
                    }
                    p.moveTarget = null;
                    p.lastInput = Date.now();
                }
            }
            else if (msg.t === 'vmode' && ws.playerId) {
                const p = players.get(ws.playerId);
                if (p) { p.fpsMode = !!msg.fps; p.lastInput = Date.now(); }
            }
            else if (msg.t === 'fps_shoot' && ws.playerId) {
                const p = players.get(ws.playerId);
                if (p && p.fpsMode && p.health > 0) {
                    tryFpsShoot(p, msg.yaw || 0, msg.pitch || 0);
                }
            }
            else if (msg.t === 'ab' && ws.playerId) {
                const p = players.get(ws.playerId);
                if (!p || p.health <= 0) return;

                if (msg.a === 'ww') {
                    p.windwalk = true;
                    p.windwalkTimer = 3.0;
                }
                else if (msg.a === 'fs' && typeof msg.x === 'number' && typeof msg.z === 'number') {
                    p.farsight = true;
                    p.farsightX = msg.x;
                    p.farsightZ = msg.z;
                    p.farsightTimer = 5.0;
                }
            }
            else if (msg.t === 'buy' && ws.playerId) {
                const p = players.get(ws.playerId);
                if (p && msg.i) {
                    const ok = buyItem(p, msg.i);
                    if (ok) {
                        ws.send(JSON.stringify({ t: 'bought', i: msg.i, g: p.gold }));
                    }
                }
            }
            else if (msg.t === 'ch' && ws.playerId) {
                const p = players.get(ws.playerId);
                if (p && msg.x) {
                    broadcast(JSON.stringify({
                        t: 'ch', n: p.username, m: p.team,
                        x: String(msg.x).slice(0, 200)
                    }));
                }
            }
        } catch (e) { /* ignore malformed messages */ }
    });

    // Ping/pong for timeout detection
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('close', function() {
        if (ws.playerId) {
            const p = players.get(ws.playerId);
            if (p) {
                const team = p.team;
                players.delete(ws.playerId);

                if (TEST_MODE) {
                    // Test mode: just remove player, don't replace with bot
                    console.log('[TEST] ' + p.username + ' disconnected');
                    broadcast(JSON.stringify({ t: 'pl', n: p.username }));
                    return;
                }

                // Save state for potential rejoin
                disconnectedPlayers.set(p.username.toLowerCase(), {
                    username: p.username, team: p.team,
                    kills: p.kills, deaths: p.deaths, price: p.price,
                    gold: p.gold, streak: p.streak, inventory: { ...p.inventory },
                    savedAt: Date.now()
                });
                // Replace with bot
                // Pick a bot name not already in use
                var usedNames = new Set();
                players.forEach(function(pl) { usedNames.add(pl.username); });
                var botName = BOT_NAMES.find(n => !usedNames.has(n)) || 'Bot' + nextId;
                const bot = createPlayer(nextId++, botName, team, true);
                players.set(bot.id, bot);
                broadcast(JSON.stringify({ t: 'pl', n: p.username }));
                // Broadcast full roster so clients register the new bot
                var roster = [];
                players.forEach(function(rp) { roster.push({ id: rp.id, n: rp.username, m: rp.team, b: rp.isBot ? 1 : 0 }); });
                broadcast(JSON.stringify({ t: 'roster', roster: roster }));
                console.log(p.username + ' left, replaced by ' + bot.username + ' (id:' + bot.id + ')');
            }
        }
    });
});

// === MATCH END / RESET ===
function endMatch(winTeam, reason) {
    if (matchOver) return;
    matchOver = true;

    // Collect final stats
    const stats = [];
    players.forEach(function(p) {
        stats.push({
            id: p.id, n: p.username, m: p.team, b: p.isBot ? 1 : 0,
            k: p.kills, d: p.deaths, p: p.price, g: p.gold, s: p.streak
        });
    });
    stats.sort((a, b) => b.k - a.k);

    const elapsed = Math.round((Date.now() - matchStartTime) / 1000);
    broadcast(JSON.stringify({
        t: 'gameover',
        win: winTeam,
        reason: reason, // 'kill_limit' or 'time_limit'
        rk: teamKills.red,
        bk: teamKills.blue,
        time: elapsed,
        limit: KILL_LIMIT,
        stats: stats
    }));

    console.log('Match over — ' + winTeam + ' wins (' + reason + ') ' + teamKills.red + '-' + teamKills.blue + ' in ' + elapsed + 's');

    // Auto-restart after delay
    matchTimer = setTimeout(resetMatch, RESTART_DELAY * 1000);
}

function resetMatch() {
    matchOver = false;
    firstBlood = false;
    teamKills = { red: 0, blue: 0 };
    matchStartTime = Date.now();
    disconnectedPlayers.clear();

    // Reset all players in-place (keep connections, bots, teams)
    players.forEach(function(p) {
        const pos = spawnPos(p.team);
        p.x = pos.x; p.z = pos.z; p.y = terrainY(pos.x, pos.z) + 0.6;
        p.rot = 0; p.health = 100; p.kills = 0; p.deaths = 0;
        p.price = 1.0; p.gold = 0; p.streak = 0;
        p.spawnProt = SPAWN_PROTECTION; p.windwalk = false; p.windwalkTimer = 0;
        p.farsight = false; p.farsightTimer = 0;
        p.shootCd = 0; p.aimRot = 0;
        p.hasShield = false; p.goldMultiplier = 1.0;
        p.inventory = {};
        applyItems(p);
        p.moveTarget = null; p.botTarget = null; p.botState = 'explore';
        p.afk = false; p.lastInput = Date.now();
    });

    // Send roster for new match
    const roster = [];
    players.forEach(function(p) {
        roster.push({ id: p.id, n: p.username, m: p.team, b: p.isBot ? 1 : 0 });
    });
    broadcast(JSON.stringify({ t: 'newmatch', limit: KILL_LIMIT, timeLimit: TIME_LIMIT, roster: roster }));
    console.log('New match started');
}

// Time limit check — every second
setInterval(function() {
    if (matchOver) return;
    const elapsed = (Date.now() - matchStartTime) / 1000;
    if (elapsed >= TIME_LIMIT) {
        const winner = teamKills.red > teamKills.blue ? 'red' :
                       teamKills.blue > teamKills.red ? 'blue' : 'draw';
        endMatch(winner, 'time_limit');
    }
}, 1000);

// Ping all clients every 30s — drop dead connections
setInterval(function() {
    wss.clients.forEach(function(ws) {
        if (!ws.isAlive) { ws.terminate(); return; }
        ws.isAlive = false;
        ws.ping();
    });
    // Clean up expired rejoin states
    const now = Date.now();
    for (const [name, saved] of disconnectedPlayers) {
        if (now - saved.savedAt > REJOIN_WINDOW * 1000) disconnectedPlayers.delete(name);
    }
}, 30000);

const PORT = process.env.PORT || 3000;

if (hasTLS) {
    // HTTPS + WSS on 443
    server.listen(443, '0.0.0.0', () =>
        console.log('HTTPS + WSS on :443 (' + players.size + ' bots, ' + TICK_RATE + 'hz tick, ' + SEND_RATE + 'hz send)'));
    // HTTP :80 → redirect to HTTPS
    const redirect = express();
    redirect.all('/{*splat}', (req, res) => res.redirect('https://' + req.headers.host + req.url));
    http.createServer(redirect).listen(80, '0.0.0.0', () => console.log('HTTP :80 → HTTPS redirect'));
} else {
    server.listen(PORT, '0.0.0.0', function() {
        console.log('Elite Snipers server on port ' + PORT + ' (' + players.size + ' bots, ' + TICK_RATE + 'hz tick, ' + SEND_RATE + 'hz send)');
    });
}
