const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const {
    MAP_SIZE, SHOOT_RANGE, SHOOT_COOLDOWN, SPAWN_PROTECTION,
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
    players.forEach((p, id) => list.push({ id, name: p.username, team: p.team, isBot: p.isBot, x: Math.round(p.x), z: Math.round(p.z), health: p.health }));
    res.json({ players: list, total: players.size, clients: wss.clients.size });
});

console.log('Collision walls loaded from shared/collision.js');

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

// Track disconnected players for rejoin (username -> saved state)
const disconnectedPlayers = new Map();
const AFK_TIMEOUT = 120; // seconds before AFK player becomes bot-controlled
const REJOIN_WINDOW = 300; // seconds to rejoin and recover state

function createPlayer(id, name, team, isBot) {
    const pos = spawnPos(team);
    return {
        id, username: name, team, isBot,
        x: pos.x, z: pos.z, y: terrainY(pos.x, pos.z) + 0.5,
        rot: 0, health: 100, kills: 0, deaths: 0,
        price: 1.0, gold: 0, streak: 0,
        spawnProt: SPAWN_PROTECTION, windwalk: false, windwalkTimer: 0,
        farsight: false, farsightX: 0, farsightZ: 0, farsightTimer: 0,
        shootCd: 0, shootRange: SHOOT_RANGE, shootCooldownTime: SHOOT_COOLDOWN, aimRot: 0,
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

function encodeState(viewerTeam) {
    // Filter: send all allies, but only visible enemies
    const visible = [];
    players.forEach(function(p) {
        if (p.team === viewerTeam) {
            visible.push(p);
        } else if (p.health <= 0) {
            visible.push(p); // Dead enemies always sent (for scoreboard)
        } else if (p.windwalk) {
            // Windwalking enemies hidden
        } else {
            // Check if any allied player can see this enemy
            let seen = false;
            players.forEach(function(ally) {
                if (seen) return;
                if (ally.team === viewerTeam && ally.health > 0) {
                    var vr = 50; // VISION_RADIUS
                    if (ally.farsight) {
                        // Also check farsight
                        var fdx = p.x - ally.farsightX, fdz = p.z - ally.farsightZ;
                        if (fdx * fdx + fdz * fdz <= 70 * 70) { seen = true; return; }
                    }
                    var dx = p.x - ally.x, dz = p.z - ally.z;
                    if (dx * dx + dz * dz <= vr * vr) { seen = true; }
                }
            });
            if (seen) visible.push(p);
        }
    });

    const count = visible.length;
    const ab = new ArrayBuffer(2 + count * BYTES_PER_PLAYER);
    const view = new DataView(ab);
    view.setUint16(0, count, true);
    let off = 2;
    for (let i = 0; i < visible.length; i++) {
        const p = visible[i];
        view.setUint16(off, p.id, true); off += 2;
        view.setFloat32(off, p.x, true); off += 4;
        view.setFloat32(off, p.z, true); off += 4;
        view.setFloat32(off, p.rot, true); off += 4;
        view.setUint8(off, p.health > 0 ? 1 : 0); off += 1;
        view.setInt16(off, p.kills, true); off += 2;
        view.setInt16(off, p.deaths, true); off += 2;
        view.setFloat32(off, p.price, true); off += 4;
        // flags: bit0=windwalk, bit1=spawnProt, bit2=isBot, bit3=blue team
        let flags = 0;
        if (p.windwalk) flags |= 1;
        if (p.spawnProt > 0) flags |= 2;
        if (p.isBot) flags |= 4;
        if (p.team === 'blue') flags |= 8;
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

// Check if a point is clear (no wall collision)
function isClear(x, z, r) { return !collidesWithWall(x, z, r || 1.0); }

// Cast a ray from (x,z) in direction (dx,dz), return distance to first wall
function raycast(x, z, dx, dz, maxDist) {
    for (var d = 1.0; d <= maxDist; d += 1.0) {
        if (collidesWithWall(x + dx * d, z + dz * d, 0.8)) return d;
    }
    return maxDist;
}

// Find best movement direction using feeler rays (steering-based avoidance)
function steerAroundWalls(bot, goalDx, goalDz, spd) {
    var goalAngle = Math.atan2(goalDz, goalDx);
    var lookahead = 6;

    // Test 24 directions evenly spread + goal-biased
    var candidates = [0, 0.3, -0.3, 0.6, -0.6, 1.0, -1.0, 1.4, -1.4,
        Math.PI/2, -Math.PI/2, 2.0, -2.0, 2.5, -2.5, Math.PI,
        0.15, -0.15, 0.45, -0.45, 0.8, -0.8, 1.2, -1.2];
    var bestAngle = null;
    var bestScore = -Infinity;

    for (var i = 0; i < candidates.length; i++) {
        var angle = goalAngle + candidates[i];
        var cdx = Math.cos(angle), cdz = Math.sin(angle);
        var clearDist = raycast(bot.x, bot.z, cdx, cdz, lookahead);

        var directionBonus = (1.0 - Math.abs(candidates[i]) / Math.PI) * lookahead * 0.5;
        var score = clearDist + directionBonus;

        if (score > bestScore && clearDist > 1.2) {
            bestScore = score;
            bestAngle = angle;
        }
    }

    // Fallback: if no direction has 1.2 clearance, try ANY direction that's immediately clear
    if (bestAngle === null) {
        for (var a = 0; a < Math.PI * 2; a += Math.PI / 8) {
            var fx = bot.x + Math.cos(a) * 0.5;
            var fz = bot.z + Math.sin(a) * 0.5;
            if (isClear(fx, fz, 0.8)) {
                bestAngle = a;
                break;
            }
        }
    }

    // Last resort: just go backward from goal
    if (bestAngle === null) bestAngle = goalAngle + Math.PI;

    return { dx: Math.cos(bestAngle), dz: Math.sin(bestAngle) };
}

function pickExploreTarget(bot) {
    // Favor center and own half — avoid spawns
    var bias = bot.team === 'red' ? -0.2 : 0.2;
    for (var attempt = 0; attempt < 10; attempt++) {
        var tx = (Math.random() - 0.5 + bias) * MAP_SIZE * 0.7;
        var tz = (Math.random() - 0.5 + bias) * MAP_SIZE * 0.7;
        // Don't target enemy spawn area
        var esx = bot.team === 'red' ? 70 : -70;
        if (Math.sqrt((tx-esx)*(tx-esx)+(tz-esx)*(tz-esx)) < 25) continue;
        // Don't target inside a wall
        if (!isClear(tx, tz)) continue;
        return { x: tx, z: tz };
    }
    return { x: (Math.random()-0.5) * MAP_SIZE * 0.4, z: (Math.random()-0.5) * MAP_SIZE * 0.4 };
}

function updateBot(bot, dt) {
    if (bot.health <= 0) return;

    // Find closest enemy
    var closestEnemy = null, closestDist = Infinity;
    players.forEach(function(e) {
        if (e !== bot && e.team !== bot.team && e.health > 0 && !e.windwalk) {
            var d = dist(bot, e);
            if (d < closestDist) { closestDist = d; closestEnemy = e; }
        }
    });

    // (camping disabled)

    // Chase if enemy in vision range
    if (closestEnemy && closestDist < 50) {
        bot.botState = 'chase';
        bot.botTarget = { x: closestEnemy.x, z: closestEnemy.z };
    }

    // Pick new explore target if needed
    if (!bot.botTarget || dist(bot, bot.botTarget) < 3) {
        // Chance to camp at current position
        // No camping — keep moving
        bot.botState = 'explore';
        bot.botTarget = pickExploreTarget(bot);
    }

    // Move toward target with steering-based obstacle avoidance
    if (bot.botTarget) {
        var dx = bot.botTarget.x - bot.x;
        var dz = bot.botTarget.z - bot.z;
        var d = Math.sqrt(dx * dx + dz * dz);
        var spd = (bot.windwalk ? bot.windwalkSpeed : bot.speed) * dt;
        var dirX = d > 0.1 ? dx / d : 0, dirZ = d > 0.1 ? dz / d : 1;

        // Steer around obstacles
        var steer = steerAroundWalls(bot, dirX, dirZ, spd);
        var nx = bot.x + steer.dx * spd;
        var nz = bot.z + steer.dz * spd;

        if (isClear(nx, nz)) {
            bot.x = Math.max(-MAP_SIZE/2+2, Math.min(MAP_SIZE/2-2, nx));
            bot.z = Math.max(-MAP_SIZE/2+2, Math.min(MAP_SIZE/2-2, nz));
            bot.stuckFrames = 0;
        } else {
            bot.stuckFrames++;
            if (bot.stuckFrames > 3) {
                bot.botTarget = pickExploreTarget(bot);
                bot.stuckFrames = 0;
            }
        }
        bot.y = terrainY(bot.x, bot.z) + 0.5;
        if (d > 0.1) bot.rot = Math.atan2(dx, dz);
    }

    // Aim at closest visible enemy (so tryShoot's FOV cone works)
    if (closestEnemy && closestDist <= bot.shootRange) {
        bot.aimRot = Math.atan2(closestEnemy.x - bot.x, closestEnemy.z - bot.z);
    } else {
        bot.aimRot = bot.rot;
    }

    // Bot auto-buy on gold accumulation
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
    if (attacker.shootCd > 0) return;

    // Use aimRot (from client mouse/weapon aim) if available, otherwise movement rot
    const aimDir = attacker.aimRot !== undefined ? attacker.aimRot : attacker.rot;

    let closest = null, closestDist = Infinity;
    players.forEach(function(p) {
        if (p === attacker || p.team === attacker.team || p.health <= 0) return;
        if (p.windwalk) return;
        const d = dist(attacker, p);
        if (d < closestDist && d <= attacker.shootRange) {
            // FOV cone: 30 degrees from aim direction
            const dx = p.x - attacker.x, dz = p.z - attacker.z;
            const angle = Math.atan2(dx, dz);
            let diff = angle - aimDir;
            while (diff > Math.PI) diff -= 2 * Math.PI;
            while (diff < -Math.PI) diff += 2 * Math.PI;
            if (Math.abs(diff) < (30 * Math.PI / 180)) {
                if (hasLineOfSight(attacker.x, attacker.z, p.x, p.z)) {
                    closest = p;
                    closestDist = d;
                }
            }
        }
    });

    if (!closest) return;
    if (matchOver) return; // No kills during end state
    attacker.shootCd = attacker.shootCooldownTime;

    // Spawn protection blocks damage
    if (closest.spawnProt > 0) return;

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
        p.y = terrainY(pos.x, pos.z) + 0.5;
        p.spawnProt = SPAWN_PROTECTION;
        p.streak = 0;
        p.moveTarget = null;
        p.botTarget = null;
        p.botState = 'explore';
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
            // Human player movement
            const dx = p.moveTarget.x - p.x;
            const dz = p.moveTarget.z - p.z;
            const d = Math.sqrt(dx * dx + dz * dz);
            if (d < 1) {
                p.moveTarget = null;
            } else {
                const spd = (p.windwalk ? p.windwalkSpeed : p.speed) * dt;
                const nx = p.x + dx / d * spd;
                const nz = p.z + dz / d * spd;
                if (!collidesWithWall(nx, nz, 1.0)) {
                    p.x = Math.max(-MAP_SIZE / 2 + 2, Math.min(MAP_SIZE / 2 - 2, nx));
                    p.z = Math.max(-MAP_SIZE / 2 + 2, Math.min(MAP_SIZE / 2 - 2, nz));
                } else if (!collidesWithWall(nx, p.z, 1.0)) {
                    p.x = Math.max(-MAP_SIZE / 2 + 2, Math.min(MAP_SIZE / 2 - 2, nx));
                } else if (!collidesWithWall(p.x, nz, 1.0)) {
                    p.z = Math.max(-MAP_SIZE / 2 + 2, Math.min(MAP_SIZE / 2 - 2, nz));
                }
                p.y = terrainY(p.x, p.z) + 0.5;
                p.rot = Math.atan2(dx, dz);
            }
        }

        // Auto-shoot
        if (p.shootCd <= 0) tryShoot(p);
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

            if (msg.t === 'join') {
                const name = (msg.n || 'Sniper').slice(0, 12);
                const team = msg.m === 'blue' ? 'blue' : 'red';

                // Remove a bot from this team to make room
                for (const [id, p] of players) {
                    if (p.isBot && p.team === team) {
                        players.delete(id);
                        break;
                    }
                }

                const player = createPlayer(nextId++, name, team, false);

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
                if (p) { p.aimRot = msg.r || 0; p.rot = msg.r || 0; p.lastInput = Date.now(); }
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
                // Save state for potential rejoin
                disconnectedPlayers.set(p.username.toLowerCase(), {
                    username: p.username, team: p.team,
                    kills: p.kills, deaths: p.deaths, price: p.price,
                    gold: p.gold, streak: p.streak, inventory: { ...p.inventory },
                    savedAt: Date.now()
                });
                players.delete(ws.playerId);
                // Replace with bot
                const bot = createPlayer(
                    nextId++,
                    BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)],
                    team, true
                );
                players.set(bot.id, bot);
                broadcast(JSON.stringify({ t: 'pl', n: p.username }));
                console.log(p.username + ' left (state saved for rejoin)');
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
        p.x = pos.x; p.z = pos.z; p.y = terrainY(pos.x, pos.z) + 0.5;
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
