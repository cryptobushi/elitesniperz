require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const {
    MAP_SIZE, SHOOT_RANGE, SHOOT_COOLDOWN, SPAWN_PROTECTION,
    MAX_PLAYERS, TICK_RATE, SEND_RATE, BOT_NAMES, SHOP_ITEMS,
    BYTES_PER_PLAYER, terrainY, spawnPos, isNearSpawn, dist, getRakePercent
} = require('./shared/constants');
const { collidesWithWall, hasLineOfSight } = require('./shared/collision');
const {
    tickPlayerTimers, movePlayerToTarget,
    computeVisibleEnemies, encodePlayerState, findShootTarget
} = require('./shared/game-logic');

const app = express();
app.use(express.json());
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use((req, res, next) => {
    const blocked = ['/server/', '/db/', '/node_modules/', '/.env', '/.git', '/test-'];
    const lower = req.path.toLowerCase();
    if (blocked.some(b => lower.startsWith(b))) return res.status(403).send('Forbidden');
    next();
});
app.use(express.static(path.join(__dirname), { dotfiles: 'deny' }));

app.get('/auth/callback', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const apiRouter = require('./server/api');
const { verifyWsToken } = require('./server/auth');
const WagerMatch = require('./server/wager-match');
const escrow = require('./server/escrow');
const db = require('./db/index');
app.use('/api', apiRouter);

const activeWagerMatches = new Map();

async function recoverStuckMatches() {
    try {
        const stuckMatches = db.getStuckMatches();
        for (const match of stuckMatches) {
            const existingRefunds = db.getRefundTransactions(match.id);
            const refundedUserIds = new Set(existingRefunds.map(r => r.user_id));

            if (match.status === 'in_progress' || match.status === 'funded_both') {
                const targetStatus = match.status === 'in_progress' ? 'disputed' : 'cancelled';
                // Refund both players
                for (const userId of [match.creator_id, match.joiner_id]) {
                    if (!userId || refundedUserIds.has(userId)) {
                        console.log('[RECOVERY] Skipping already-refunded user ' + userId + ' for match ' + match.id);
                        continue;
                    }
                    const user = db.getUser(userId);
                    if (user && user.privy_wallet && escrow.isReady()) {
                        try {
                            const result = await escrow.sendPayout(user.privy_wallet, match.stake_amount, match.stake_token);
                            if (result && result.signature) {
                                const refTxId = uuidv4();
                                db.createTransaction({
                                    id: refTxId, match_id: match.id, user_id: userId,
                                    tx_type: 'refund', amount: match.stake_amount, token: match.stake_token,
                                    tx_signature: result.signature, from_wallet: 'escrow', to_wallet: user.privy_wallet
                                });
                                db.confirmTransaction(refTxId, Date.now());
                                console.log('[RECOVERY] Refunded ' + userId + ' for match ' + match.id + ' (' + targetStatus + ') sig=' + result.signature);
                            }
                        } catch (e) {
                            console.error('[RECOVERY] Refund error for user ' + userId + ' match ' + match.id + ':', e.message);
                        }
                    }
                }
                db.updateMatch(match.id, { status: targetStatus, ended_at: Date.now() });
                console.log('[RECOVERY] Match ' + match.id + ' set to ' + targetStatus);
            } else if (match.status === 'completed') {
        
                const winner = match.winner_id ? db.getUser(match.winner_id) : null;
                if (winner && winner.privy_wallet && escrow.isReady()) {
                    const totalPot = match.stake_amount * 2;
                    const rake = Math.floor(totalPot * getRakePercent(match.stake_token));
                    const payout = totalPot - rake;
                    try {
                        const payoutResult = await escrow.sendPayout(winner.privy_wallet, payout, match.stake_token);
                        if (payoutResult && payoutResult.signature) {
                            const recPayTxId = uuidv4();
                            db.createTransaction({
                                id: recPayTxId, match_id: match.id, user_id: match.winner_id,
                                tx_type: 'payout', amount: payout, token: match.stake_token,
                                tx_signature: payoutResult.signature, from_wallet: 'escrow', to_wallet: winner.privy_wallet
                            });
                            db.confirmTransaction(recPayTxId, Date.now());
                            db.updateMatch(match.id, { status: 'settled', rake_amount: rake });
                            console.log('[RECOVERY] Payout retry succeeded for match ' + match.id + ' winner=' + match.winner_id + ' sig=' + payoutResult.signature);
                        }
                    } catch (e) {
                        console.error('[RECOVERY] Payout retry failed for match ' + match.id + ':', e.message);
                        // Leave as completed for next restart attempt
                    }
                } else if (!winner || !winner.privy_wallet) {
                    console.log('[RECOVERY] Match ' + match.id + ' completed but no winner wallet — skipping');
                }
            } else if (match.status === 'submitting') {
        
                db.updateMatch(match.id, { status: 'cancelled', ended_at: Date.now() });
                console.log('[RECOVERY] Match ' + match.id + ' (submitting) set to cancelled');
            }
        }
        if (stuckMatches.length > 0) {
            console.log('[RECOVERY] Processed ' + stuckMatches.length + ' stuck matches');
        }
    } catch (e) {
        console.error('[RECOVERY] Error:', e.message);
    }
}
recoverStuckMatches();

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

app.get('/debug', (req, res) => {
    if (!process.env.ADMIN_SECRET || req.query.secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'forbidden' });
    const list = [];
    players.forEach((p, id) => list.push({ id, name: p.username, team: p.team, isBot: p.isBot, x: Math.round(p.x), z: Math.round(p.z), health: p.health, kills: p.kills, deaths: p.deaths }));
    res.json({ players: list, total: players.size, clients: wss.clients.size });
});

// 30s-delayed spectator feed for landing page background
const SPECTATOR_DELAY = 30;
const _spectatorBuffer = [];
const SPECTATOR_SNAPSHOT_RATE = 500;

setInterval(() => {
    const snapshot = [];
    players.forEach((p, id) => {
        snapshot.push({ id, team: p.team, x: Math.round(p.x * 10) / 10, z: Math.round(p.z * 10) / 10, alive: p.health > 0 });
    });
    _spectatorBuffer.push({ t: Date.now(), players: snapshot });
    const cutoff = Date.now() - 60000;
    while (_spectatorBuffer.length > 0 && _spectatorBuffer[0].t < cutoff) _spectatorBuffer.shift();
}, SPECTATOR_SNAPSHOT_RATE);

app.get('/spectate', (req, res) => {
    const targetTime = Date.now() - SPECTATOR_DELAY * 1000;
    let best = null;
    for (let i = _spectatorBuffer.length - 1; i >= 0; i--) {
        if (_spectatorBuffer[i].t <= targetTime) { best = _spectatorBuffer[i]; break; }
    }
    if (!best && _spectatorBuffer.length > 0) best = _spectatorBuffer[0];
    res.json(best ? best.players : []);
});

console.log('Collision walls loaded from shared/collision.js');

app.get('/test-mode', (req, res) => {
    if (!process.env.ADMIN_SECRET || req.query.secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'forbidden' });
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
    dummy._passive = false;
    players.set(dummy.id, dummy);
    broadcastRoster();
    console.log('[TEST MODE] Entered — 1 passive bot at center');
}

function exitTestMode() {
    TEST_MODE = false;
    players.clear();
    nextId = 1;
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
const KILL_LIMIT = 50;
const TIME_LIMIT = 20 * 60;
const RESTART_DELAY = 12;

const players = new Map();
let nextId = 1;
let firstBlood = false;
let teamKills = { red: 0, blue: 0 };
let matchStartTime = Date.now();
let matchOver = false;
let matchTimer = null;
let TEST_MODE = false;

const disconnectedPlayers = new Map();
const AFK_TIMEOUT = 120;
const REJOIN_WINDOW = 300;

function createPlayer(id, name, team, isBot) {
    let pos = spawnPos(team);
    for (let tries = 0; tries < 10 && collidesWithWall(pos.x, pos.z, 0.8); tries++) {
        pos = spawnPos(team);
    }
    return {
        id, username: name, team, isBot,
        x: pos.x, z: pos.z, y: terrainY(pos.x, pos.z) + 0.6,
        rot: 0, health: 100, kills: 0, deaths: 0,
        price: 1.0, gold: 0, streak: 0,
        spawnProt: SPAWN_PROTECTION, windwalk: false, windwalkTimer: 0,
        farsight: false, farsightX: 0, farsightZ: 0, farsightTimer: 0,
        shootCd: 0, shootRange: SHOOT_RANGE, shootCooldownTime: SHOOT_COOLDOWN, aimRot: 0,
        speed: 8, normalSpeed: 8, windwalkSpeed: 14,
        hasShield: false, goldMultiplier: 1.0,
        inventory: {},
        moveTarget: null,
        botState: 'explore', botTarget: null, campTimer: 0, stuckFrames: 0,
        lastX: pos.x, lastZ: pos.z,
        lastInput: Date.now(),
        afk: false
    };
}

for (let i = 0; i < MAX_PLAYERS; i++) {
    const team = i < 5 ? 'red' : 'blue';
    const bot = createPlayer(nextId++, BOT_NAMES[i], team, true);
    players.set(bot.id, bot);
}
console.log(`Initialized ${players.size} bots`);

const _teamVisible = { red: new Set(), blue: new Set() };

function encodeState(viewerTeam) {
    const enemyVisible = new Set();
    const prevVisible = _teamVisible[viewerTeam];
    players.forEach(function(p) {
        if (p.team === viewerTeam || p.health <= 0) return;
        if (p.windwalk) return;
        // Hysteresis: wider exit range prevents flicker at vision edge
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

    const all = [];
    players.forEach(function(p) { all.push(p); });
    return encodePlayerState(all, viewerTeam, enemyVisible);
}

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

    p.gold -= item.cost;
    p.inventory[itemId] = true;
    applyItems(p);
    return true;
}

function pickTarget(bot) {
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
    return { x: (Math.random()-0.5) * 30, z: (Math.random()-0.5) * 30 };
}

var BOT_RADIUS = 0.8;
var MOVE_RADIUS = BOT_RADIUS + 0.15;
function tryMove(bot, nx, nz) {
    nx = Math.max(-MAP_SIZE/2+2, Math.min(MAP_SIZE/2-2, nx));
    nz = Math.max(-MAP_SIZE/2+2, Math.min(MAP_SIZE/2-2, nz));

    if (!collidesWithWall(nx, nz, MOVE_RADIUS)) {
        bot.x = nx; bot.z = nz; return true;
    }
    if (!collidesWithWall(nx, bot.z, MOVE_RADIUS)) {
        bot.x = nx; return true;
    }
    if (!collidesWithWall(bot.x, nz, MOVE_RADIUS)) {
        bot.z = nz; return true;
    }
    return false;
}

function updateBot(bot, dt) {
    if (bot.health <= 0) return;
    if (bot._passive) return;

    if (!bot._lastRealX) { bot._lastRealX = bot.x; bot._lastRealZ = bot.z; bot._idleTicks = 0; }
    var moved = Math.abs(bot.x - bot._lastRealX) > 0.5 || Math.abs(bot.z - bot._lastRealZ) > 0.5;
    if (moved) {
        bot._lastRealX = bot.x; bot._lastRealZ = bot.z; bot._idleTicks = 0;
    } else {
        bot._idleTicks++;
        if (bot._idleTicks > 48) {
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

    // Push bot out if stuck inside or touching a wall (use larger check radius to catch edge cases)
    if (collidesWithWall(bot.x, bot.z, BOT_RADIUS + 0.2)) {
        var escaped = false;
        for (var radius = 1.5; radius <= 10 && !escaped; radius += 0.5) {
            for (var a = 0; a < Math.PI * 2; a += Math.PI / 16) {
                var px = bot.x + Math.cos(a) * radius;
                var pz = bot.z + Math.sin(a) * radius;
                if (!collidesWithWall(px, pz, BOT_RADIUS + 0.3) && Math.abs(px) < MAP_SIZE/2 - 2 && Math.abs(pz) < MAP_SIZE/2 - 2) {
                    bot.x = px; bot.z = pz; escaped = true; break;
                }
            }
        }
        if (!escaped) {
            var pos = spawnPos(bot.team);
            bot.x = pos.x; bot.z = pos.z;
        }
        bot.botTarget = null;
        bot.stuckFrames = 0;
    }

    var closestEnemy = null, closestDist = Infinity;
    players.forEach(function(e) {
        if (e !== bot && e.team !== bot.team && e.health > 0 && !e.windwalk) {
            var d = dist(bot, e);
            if (d < closestDist) { closestDist = d; closestEnemy = e; }
        }
    });

    if (closestEnemy && closestDist < SHOOT_RANGE * 1.5) {
        if (hasLineOfSight(bot.x, bot.z, closestEnemy.x, closestEnemy.z)) {
            bot.botTarget = { x: closestEnemy.x, z: closestEnemy.z };
            bot.chaseDetour = false;
            bot.stuckFrames = 0;
        } else if (!bot.chaseDetour || bot.stuckFrames > 10) {
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

    if (!bot.botTarget || dist(bot, bot.botTarget) < 3) {
        bot.botTarget = pickTarget(bot);
        bot.chaseDetour = false;
        bot.stuckFrames = 0;
    }
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

            if (bot.stuckFrames > 5) {
                bot.botTarget = null;
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
    if (closestEnemy && closestDist <= bot.shootRange && hasLineOfSight(bot.x, bot.z, closestEnemy.x, closestEnemy.z)) {

        if (!bot.losTarget || bot.losTarget !== closestEnemy.id) {
            bot.losTarget = closestEnemy.id;
            bot.losTimer = 1.0 + Math.random() * 1.5; // 1.0–2.5s reaction time
        }
        if (bot.losTimer > 0) {
            bot.losTimer -= dt;
        }

        var targetRot = Math.atan2(closestEnemy.x - bot.x, closestEnemy.z - bot.z);

        var turnSpeed = 2.0 * dt;
        var diff = targetRot - bot.rot;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        if (Math.abs(diff) < turnSpeed) {
            bot.rot = targetRot;
        } else {
            bot.rot += (diff > 0 ? 1 : -1) * turnSpeed;
        }
        bot.aimRot = (bot.losTimer <= 0) ? bot.rot : bot.rot + Math.PI; // aim away until ready
    } else {
        bot.aimRot = bot.rot;
        bot.losTarget = null;
        bot.losTimer = 0;
    }
    if (bot.gold >= 100) {
        botShop(bot);
    }
}

function botShop(bot) {
    const priorities = ['boots1', 'scope1', 'shield', 'rapidfire', 'boots2', 'scope2', 'bounty', 'cloak1'];
    for (const id of priorities) {
        buyItem(bot, id);
    }
}
function tryShoot(attacker) {
    if (attacker.health <= 0) return;
    if (attacker._passive) return; // Test dummy doesn't shoot
    if (attacker.shootCd > 0) return;
    const aimDir = attacker.aimRot !== undefined ? attacker.aimRot : attacker.rot;

    const isLog = TEST_MODE && !attacker.isBot; // Log human shots in test mode
    if (isLog) console.log('[SHOOT] ' + attacker.username + ' at(' + attacker.x.toFixed(1) + ',' + attacker.z.toFixed(1) + ') aimRot=' + (aimDir * 180 / Math.PI).toFixed(1) + '°');

    let closest = null, closestDist = Infinity;
    players.forEach(function(p) {
        if (p === attacker || p.team === attacker.team || p.health <= 0) return;
        if (p.windwalk) { if (isLog) console.log('  → ' + p.username + ' SKIP windwalk'); return; }
        if (p.spawnProt > 0) { if (isLog) console.log('  → ' + p.username + ' SKIP spawnProt'); return; }
        if (p.godMode) { if (isLog) console.log('  → ' + p.username + ' SKIP godMode'); return; }

        var vdx = p.x - attacker.x, vdz = p.z - attacker.z;
        var visionDist2 = vdx * vdx + vdz * vdz;
        if (visionDist2 > SHOOT_RANGE * SHOOT_RANGE) { if (isLog) console.log('  → ' + p.username + ' SKIP vision dist=' + Math.sqrt(visionDist2).toFixed(1)); return; }
        const d = dist(attacker, p);
        if (d > attacker.shootRange) { if (isLog) console.log('  → ' + p.username + ' SKIP range dist=' + d.toFixed(1) + ' range=' + attacker.shootRange); return; }

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
        let pos = spawnPos(p.team);

        for (let tries = 0; tries < 10 && collidesWithWall(pos.x, pos.z, 0.8); tries++) {
            pos = spawnPos(p.team);
        }
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

function broadcast(data) {
    wss.clients.forEach(function(ws) {
        if (ws.readyState === 1 && !ws._isWager) ws.send(data);
    });
}

let tickCount = 0;
const sendEvery = Math.round(TICK_RATE / SEND_RATE);

setInterval(function() {
    const dt = 1 / TICK_RATE;
    tickCount++;

    players.forEach(function(p) {
        if (p.health <= 0) return;

        tickPlayerTimers(p, dt, { wwCooldownKey: '_wwCooldown', fsCooldownKey: '_fsCooldown' });
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
        if (p.isBot || p.afk) {
            updateBot(p, dt);
        } else {
            movePlayerToTarget(p, dt);
        }
        if (p.shootCd <= 0) tryShoot(p);
    });
    if (tickCount % sendEvery === 0) {
        wss.clients.forEach(function(ws) {
            if (ws.readyState !== 1 || !ws.playerId || ws._isWager) return;
            const p = players.get(ws.playerId);
            if (!p) return;
            const buf = encodeState(p.team);
            ws.send(buf);
        });
    }
}, 1000 / TICK_RATE);

const _settlementInProgress = new Set();

async function settleWagerMatch(matchId, winnerId, reason, stats) {
    if (_settlementInProgress.has(matchId)) return;
    _settlementInProgress.add(matchId);

    try {
    const match = db.getMatch(matchId);
    if (!match || match.status === 'settled') { _settlementInProgress.delete(matchId); return; }

    // === DRAW PATH ===
    if (winnerId === null) {
        const creatorStats = stats[match.creator_id] || {};
        const joinerStats = stats[match.joiner_id] || {};

        // Refund both players (full stake, no rake)
        const creator = db.getUser(match.creator_id);
        const joiner = db.getUser(match.joiner_id);

        let drawRefundsOk = true;
        if (escrow.isReady()) {
            if (creator && creator.privy_wallet) {
                try {
                    const result = await escrow.sendPayout(creator.privy_wallet, match.stake_amount, match.stake_token);
                    if (result && result.signature) {
                        const drawTxId1 = uuidv4();
                        db.createTransaction({
                            id: drawTxId1, match_id: matchId, user_id: match.creator_id,
                            tx_type: 'refund', amount: match.stake_amount, token: match.stake_token,
                            tx_signature: result.signature, from_wallet: 'escrow', to_wallet: creator.privy_wallet
                        });
                        db.confirmTransaction(drawTxId1, Date.now());
                    }
                } catch (e) {
                    console.error('[WAGER] Draw refund error (creator):', e);
                    drawRefundsOk = false;
                }
            }
            if (joiner && joiner.privy_wallet) {
                try {
                    const result = await escrow.sendPayout(joiner.privy_wallet, match.stake_amount, match.stake_token);
                    if (result && result.signature) {
                        const drawTxId2 = uuidv4();
                        db.createTransaction({
                            id: drawTxId2, match_id: matchId, user_id: match.joiner_id,
                            tx_type: 'refund', amount: match.stake_amount, token: match.stake_token,
                            tx_signature: result.signature, from_wallet: 'escrow', to_wallet: joiner.privy_wallet
                        });
                        db.confirmTransaction(drawTxId2, Date.now());
                    }
                } catch (e) {
                    console.error('[WAGER] Draw refund error (joiner):', e);
                    drawRefundsOk = false;
                }
            }
        }

        if (!drawRefundsOk) {
            console.log('[WAGER] Draw refund(s) failed for match ' + matchId + ' — leaving as completed for retry');
            db.updateMatch(matchId, {
                status: 'completed', winner_id: null, win_reason: 'draw',
                creator_kills: creatorStats.kills ?? 0, joiner_kills: joinerStats.kills ?? 0,
                creator_deaths: creatorStats.deaths ?? 0, joiner_deaths: joinerStats.deaths ?? 0,
                ended_at: Date.now(), rake_amount: 0
            });
            activeWagerMatches.delete(matchId);
            return;
        }

        db.updateMatch(matchId, {
            status: 'settled', winner_id: null, win_reason: 'draw',
            creator_kills: creatorStats.kills ?? 0, joiner_kills: joinerStats.kills ?? 0,
            creator_deaths: creatorStats.deaths ?? 0, joiner_deaths: joinerStats.deaths ?? 0,
            ended_at: Date.now(), rake_amount: 0
        });

        // Update draw counts (incremental)
        db.updateUserStats(match.creator_id, { draws: 1 });
        db.updateUserStats(match.joiner_id, { draws: 1 });

        // Write match history for both
        const now = Date.now();
        db.createMatchHistory({
            match_id: matchId, user_id: match.creator_id, opponent_id: match.joiner_id, result: 'draw',
            kills: creatorStats.kills ?? 0, deaths: creatorStats.deaths ?? 0,
            stake_amount: match.stake_amount, stake_token: match.stake_token, payout: match.stake_amount, played_at: now
        });
        db.createMatchHistory({
            match_id: matchId, user_id: match.joiner_id, opponent_id: match.creator_id, result: 'draw',
            kills: joinerStats.kills ?? 0, deaths: joinerStats.deaths ?? 0,
            stake_amount: match.stake_amount, stake_token: match.stake_token, payout: match.stake_amount, played_at: now
        });

        activeWagerMatches.delete(matchId);
        console.log('[WAGER] Draw settled for match ' + matchId + ' — both players refunded');
        return;
    }

    const loserId = winnerId === match.creator_id ? match.joiner_id : match.creator_id;
    const totalPot = match.stake_amount * 2;
    const rake = Math.floor(totalPot * getRakePercent(match.stake_token));
    const payout = totalPot - rake;

    // Extract kills/deaths from stats (keyed by userId)
    const creatorStats = stats[match.creator_id] || {};
    const joinerStats = stats[match.joiner_id] || {};

    db.updateMatch(matchId, {
        status: 'completed',
        winner_id: winnerId,
        win_reason: reason,
        creator_kills: creatorStats.kills ?? 0,
        joiner_kills: joinerStats.kills ?? 0,
        creator_deaths: creatorStats.deaths ?? 0,
        joiner_deaths: joinerStats.deaths ?? 0,
        ended_at: Date.now()
    });

    // Get winner's wallet for payout
    const winner = db.getUser(winnerId);
    const loser = db.getUser(loserId);

    // Update user stats
    db.updateUserStats(winnerId, { wins: 1, total_earned: payout, total_wagered: match.stake_amount });
    db.updateUserStats(loserId, { losses: 1, total_wagered: match.stake_amount });

    // Write match history for both
    const now = Date.now();
    const winnerStats = stats[winnerId] || {};
    const loserStats = stats[loserId] || {};
    db.createMatchHistory({
        match_id: matchId, user_id: winnerId, opponent_id: loserId, result: 'win',
        kills: winnerStats.kills ?? 0, deaths: winnerStats.deaths ?? 0,
        stake_amount: match.stake_amount, stake_token: match.stake_token, payout, played_at: now
    });
    db.createMatchHistory({
        match_id: matchId, user_id: loserId, opponent_id: winnerId, result: 'loss',
        kills: loserStats.kills ?? 0, deaths: loserStats.deaths ?? 0,
        stake_amount: match.stake_amount, stake_token: match.stake_token, payout: 0, played_at: now
    });

    if (winner && winner.privy_wallet && escrow.isReady()) {
        try {
            // Send payout to winner
            const payoutResult = await escrow.sendPayout(winner.privy_wallet, payout, match.stake_token);
            if (payoutResult && payoutResult.signature) {
                const payoutTxId = uuidv4();
                db.createTransaction({
                    id: payoutTxId, match_id: matchId, user_id: winnerId,
                    tx_type: 'payout', amount: payout, token: match.stake_token,
                    tx_signature: payoutResult.signature, from_wallet: 'escrow', to_wallet: winner.privy_wallet
                });
                db.confirmTransaction(payoutTxId, Date.now());
            }

            // Send rake to treasury
            const rakeResult = await escrow.sendRake(rake, match.stake_token);
            if (rakeResult && rakeResult.signature) {
                const rakeTxId = uuidv4();
                db.createTransaction({
                    id: rakeTxId, match_id: matchId, user_id: null,
                    tx_type: 'rake', amount: rake, token: match.stake_token,
                    tx_signature: rakeResult.signature, from_wallet: 'escrow', to_wallet: 'treasury'
                });
                db.confirmTransaction(rakeTxId, Date.now());
            }

            // Payout succeeded — mark as settled
            db.updateMatch(matchId, { status: 'settled', rake_amount: rake });
            console.log('[WAGER] Settled match ' + matchId + ' winner=' + winnerId + ' payout=' + payout + ' rake=' + rake);
        } catch (e) {
            // Payout failed — keep status as 'completed' so it can be retried
            console.error('[WAGER] Payout error for match ' + matchId + ':', e);
            console.log('[WAGER] Match ' + matchId + ' staying in completed status for retry');
        }
    } else {
        // No escrow configured (dev mode) — mark as settled immediately
        db.updateMatch(matchId, { status: 'settled', rake_amount: rake });
        console.log('[WAGER] Settled match ' + matchId + ' (no escrow) winner=' + winnerId);
    }

    activeWagerMatches.delete(matchId);
    } finally {
        _settlementInProgress.delete(matchId);
    }
}
function handleWagerWs(ws, userId, matchId) {
    const match = db.getMatch(matchId);
    if (!match) { ws.send(JSON.stringify({ t: 'error', msg: 'Match not found' })); ws.close(); return; }
    if (userId !== match.creator_id && userId !== match.joiner_id) { ws.send(JSON.stringify({ t: 'error', msg: 'Not in this match' })); ws.close(); return; }

    const isCreator = userId === match.creator_id;

    // Create or get WagerMatch instance
    if (!activeWagerMatches.has(matchId)) {
        const wm = new WagerMatch(matchId, match.creator_id, match.joiner_id, match.kill_target, (winnerId, reason, stats) => {
            settleWagerMatch(matchId, winnerId, reason, stats);
        });
        activeWagerMatches.set(matchId, { match: wm, creatorWs: null, joinerWs: null });
    }

    const entry = activeWagerMatches.get(matchId);
    if (isCreator) entry.creatorWs = ws; else entry.joinerWs = ws;
    entry.match.setPlayerWs(userId, ws);

    // Send lobby info
    const creator = db.getUser(match.creator_id);
    const joiner = db.getUser(match.joiner_id);
    ws.send(JSON.stringify({
        t: 'wager_lobby', matchId, killTarget: match.kill_target,
        stake: { amount: match.stake_amount, token: match.stake_token },
        creator: creator ? { twitter: creator.twitter_handle, wins: creator.wins, losses: creator.losses } : null,
        joiner: joiner ? { twitter: joiner.twitter_handle, wins: joiner.wins, losses: joiner.losses } : null,
        status: match.status
    }));

    ws.on('message', function(data) {
        try {
            const str = typeof data === 'string' ? data : data.toString();
            const msg = JSON.parse(str);
            if (msg.t === 'wager_ready') {
                entry.match.setReady(userId);
                // Re-read match status from DB (may have changed since initial load)
                const currentMatch = db.getMatch(matchId);
                if (currentMatch && currentMatch.status === 'funded_both' && !entry.match.running) {
                    // Check both players are connected
                    if (entry.creatorWs && entry.joinerWs) {
                        entry.match.start();
                        db.updateMatch(matchId, { status: 'in_progress', started_at: Date.now() });
                        const startMsg = JSON.stringify({ t: 'wager_start', matchId, killTarget: currentMatch.kill_target, creatorId: currentMatch.creator_id });
                        entry.creatorWs.send(startMsg);
                        entry.joinerWs.send(startMsg);
                        console.log('[WAGER] Match ' + matchId + ' started!');
                    }
                }
            } else if (msg.t === 'wager_forfeit') {
                const winnerId = isCreator ? match.joiner_id : match.creator_id;
                entry.match.stop();
                const stats = entry.match.getState();
                settleWagerMatch(matchId, winnerId, 'forfeit', stats);
            } else {
                // Game messages (mv, rot, ab) — forward to WagerMatch
                entry.match.handleMessage(userId, msg);
            }
        } catch (e) {
            // Binary data (state updates from server) — ignore parse errors
        }
    });

    ws.on('close', () => {
        // WagerMatch handles disconnect countdown internally via setPlayerWs
    });
}

wss.on('connection', function(ws) {
    ws.playerId = null;
    ws._isWager = false;
    ws._msgCount = 0;
    ws._msgResetTime = Date.now();

    ws.on('message', function(data) {
        ws._msgCount++;
        const now = Date.now();
        if (now - ws._msgResetTime > 1000) { ws._msgCount = 1; ws._msgResetTime = now; }
        if (ws._msgCount > 64) return; // Drop excess messages

        try {
            const msg = JSON.parse(data);

            // Wager auth — first message routes to wager mode
            if (msg.t === 'wager_auth' && !ws._isWager && !ws.playerId) {
                ws._isWager = true;
                verifyWsToken(msg.token).then(result => {
                    if (!result) { ws.send(JSON.stringify({ t: 'error', msg: 'Auth failed' })); ws.close(); return; }
                    ws._wagerUserId = result.userId;
                    ws.send(JSON.stringify({ t: 'wager_authed', userId: result.userId }));
                    // If matchId provided, join immediately
                    if (msg.matchId) handleWagerWs(ws, result.userId, msg.matchId);
                }).catch(() => { ws.close(); });
                return;
            }
            // Wager join after auth
            if (msg.t === 'wager_join' && ws._isWager && ws._wagerUserId) {
                handleWagerWs(ws, ws._wagerUserId, msg.matchId);
                return;
            }
            // Skip normal game handling for wager connections
            if (ws._isWager) return;

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

                    team = 'red';
                    const player = createPlayer(nextId++, name, team, false);
                    player.godMode = true; // Can't die in test mode
                    console.log('[TEST] ' + name + ' joined test mode (god mode ON)');

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

            
                let redCount = 0, blueCount = 0;
                players.forEach(p => { if (p.team === 'red') redCount++; else blueCount++; });

        
                if (team === 'red' && redCount >= 5 && blueCount < 5) team = 'blue';
                else if (team === 'blue' && blueCount >= 5 && redCount < 5) team = 'red';

        
                let removed = false;
                for (const [id, p] of players) {
                    if (p.isBot && p.team === team) {
                        players.delete(id);
                        removed = true;
                        break;
                    }
                }
        
                if (!removed && (team === 'red' ? redCount : blueCount) >= 5) {
                    ws.send(JSON.stringify({ t: 'err', x: 'Team is full' }));
                    return;
                }

                const player = createPlayer(nextId++, name, team, false);

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
                    const mx = Math.max(-MAP_SIZE / 2, Math.min(MAP_SIZE / 2, Number(msg.x) || 0));
                    const mz = Math.max(-MAP_SIZE / 2, Math.min(MAP_SIZE / 2, Number(msg.z) || 0));
                    p.moveTarget = { x: mx, z: mz };
                    p.lastInput = Date.now();
                }
            }
            else if (msg.t === 'rot' && ws.playerId) {
                const p = players.get(ws.playerId);
                if (p) {
                    p.aimRot = typeof msg.r === 'number' ? msg.r : 0; p.rot = typeof msg.r === 'number' ? msg.r : 0; p.lastInput = Date.now();

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
                if (TEST_MODE) {
                    const p = players.get(ws.playerId);
                    if (p) { p.godMode = !p.godMode; console.log(p.username + ' god mode: ' + p.godMode); }
                }
            }
            else if (msg.t === 'ab' && ws.playerId) {
                const p = players.get(ws.playerId);
                if (!p || p.health <= 0) return;

                if (msg.a === 'ww') {
                    if (!p._wwCooldown) p._wwCooldown = 0;
                    if (p._wwCooldown > 0) return;
                    p._wwCooldown = 10;
                    p.windwalk = true;
                    p.windwalkTimer = 3.0;
                }
                else if (msg.a === 'fs' && typeof msg.x === 'number' && typeof msg.z === 'number') {
                    if (!p._fsCooldown) p._fsCooldown = 0;
                    if (p._fsCooldown > 0) return;
                    p._fsCooldown = 15;
                    p.farsight = true;
                    p.farsightX = Math.max(-MAP_SIZE/2, Math.min(MAP_SIZE/2, Number(msg.x) || 0));
                    p.farsightZ = Math.max(-MAP_SIZE/2, Math.min(MAP_SIZE/2, Number(msg.z) || 0));
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
                if (ws._lastChat && Date.now() - ws._lastChat < 1000) return;
                ws._lastChat = Date.now();
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
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('close', function() {
        if (ws.playerId) {
            const p = players.get(ws.playerId);
            if (p) {
                const team = p.team;
                players.delete(ws.playerId);

                if (TEST_MODE) {

                    console.log('[TEST] ' + p.username + ' disconnected');
                    broadcast(JSON.stringify({ t: 'pl', n: p.username }));
                    return;
                }
                disconnectedPlayers.set(p.username.toLowerCase(), {
                    username: p.username, team: p.team,
                    kills: p.kills, deaths: p.deaths, price: p.price,
                    gold: p.gold, streak: p.streak, inventory: { ...p.inventory },
                    savedAt: Date.now()
                });
                var usedNames = new Set();
                players.forEach(function(pl) { usedNames.add(pl.username); });
                var botName = BOT_NAMES.find(n => !usedNames.has(n)) || 'Bot' + nextId;
                const bot = createPlayer(nextId++, botName, team, true);
                players.set(bot.id, bot);
                broadcast(JSON.stringify({ t: 'pl', n: p.username }));

                var roster = [];
                players.forEach(function(rp) { roster.push({ id: rp.id, n: rp.username, m: rp.team, b: rp.isBot ? 1 : 0 }); });
                broadcast(JSON.stringify({ t: 'roster', roster: roster }));
                console.log(p.username + ' left, replaced by ' + bot.username + ' (id:' + bot.id + ')');
            }
        }
    });
});
function endMatch(winTeam, reason) {
    if (matchOver) return;
    matchOver = true;
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
    matchTimer = setTimeout(resetMatch, RESTART_DELAY * 1000);
}

function resetMatch() {
    matchOver = false;
    firstBlood = false;
    teamKills = { red: 0, blue: 0 };
    matchStartTime = Date.now();
    disconnectedPlayers.clear();
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

    const now = Date.now();
    for (const [name, saved] of disconnectedPlayers) {
        if (now - saved.savedAt > REJOIN_WINDOW * 1000) disconnectedPlayers.delete(name);
    }
}, 30000);

// Stale match expiry — every 5 minutes
setInterval(function() {
    try {

        const openResult = db.expireStaleMatches(Date.now() - 30 * 60 * 1000);

        const matchedResult = db.db.prepare("UPDATE matches SET status = 'expired' WHERE status = 'matched' AND created_at < ?")
            .run(Date.now() - 15 * 60 * 1000);
        const total = (openResult?.changes ?? 0) + (matchedResult?.changes ?? 0);
        if (total > 0) {

            const expiredMatches = db.db.prepare("SELECT id FROM matches WHERE status = 'expired'").all();
            for (const em of expiredMatches) {
                db.expireChallengeRequests(em.id);
            }
            console.log('[CLEANUP] Expired ' + total + ' stale matches');
        }
    } catch (e) {
        console.error('[CLEANUP] Stale match expiry error:', e.message);
    }
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;

if (hasTLS) {

    server.listen(443, '0.0.0.0', () =>
        console.log('HTTPS + WSS on :443 (' + players.size + ' bots, ' + TICK_RATE + 'hz tick, ' + SEND_RATE + 'hz send)'));

    const redirect = express();
    redirect.all('/{*splat}', (req, res) => res.redirect('https://' + req.headers.host + req.url));
    http.createServer(redirect).listen(80, '0.0.0.0', () => console.log('HTTP :80 → HTTPS redirect'));
} else {
    server.listen(PORT, '0.0.0.0', function() {
        console.log('Elite Snipers server on port ' + PORT + ' (' + players.size + ' bots, ' + TICK_RATE + 'hz tick, ' + SEND_RATE + 'hz send)');
    });
}
