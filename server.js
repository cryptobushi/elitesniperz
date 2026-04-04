const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const {
    MAP_SIZE, SHOOT_RANGE, SHOOT_COOLDOWN, SPAWN_PROTECTION,
    MAX_PLAYERS, TICK_RATE, SEND_RATE, BOT_NAMES, SHOP_ITEMS,
    terrainY, spawnPos, isNearSpawn
} = require('./shared/constants');
const { collidesWithWall, hasLineOfSight } = require('./shared/collision');

// === EXPRESS + STATIC ===
const app = express();
app.use(express.static(path.join(__dirname)));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

console.log('Collision walls loaded from shared/collision.js');

// === HELPER ===
function dist(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
}

// === STATE ===
const players = new Map(); // id -> state
let nextId = 1;
let firstBlood = false;

function createPlayer(id, name, team, isBot) {
    const pos = spawnPos(team);
    return {
        id, username: name, team, isBot,
        x: pos.x, z: pos.z, y: terrainY(pos.x, pos.z) + 0.5,
        rot: 0, health: 100, kills: 0, deaths: 0,
        price: 1.0, gold: 0, streak: 0,
        spawnProt: SPAWN_PROTECTION, windwalk: false, windwalkTimer: 0,
        farsight: false, farsightX: 0, farsightZ: 0, farsightTimer: 0,
        shootCd: 0, shootRange: SHOOT_RANGE, shootCooldownTime: SHOOT_COOLDOWN,
        speed: 8, normalSpeed: 8, windwalkSpeed: 14,
        hasShield: false, goldMultiplier: 1.0,
        inventory: {},
        moveTarget: null,
        // Bot AI
        botState: 'explore', botTarget: null, campTimer: 0, stuckFrames: 0,
        lastX: pos.x, lastZ: pos.z
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
    const buf = new ArrayBuffer(2 + count * BYTES_PER_PLAYER);
    const view = new DataView(buf);
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
    return buf;
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
function updateBot(bot, dt) {
    if (bot.health <= 0) return;

    // Find closest enemy
    let closestEnemy = null, closestDist = Infinity;
    players.forEach(function(e) {
        if (e !== bot && e.team !== bot.team && e.health > 0) {
            const d = dist(bot, e);
            if (d < closestDist) { closestDist = d; closestEnemy = e; }
        }
    });

    // State: camp
    if (bot.botState === 'camp') {
        bot.campTimer += dt;
        if (bot.campTimer > 5 || (closestEnemy && closestDist < 50)) {
            bot.botState = 'explore';
        }
        // Slowly rotate while camping
        bot.rot += dt * 0.5;
        return;
    }

    // Chase if enemy close
    if (closestEnemy && closestDist < 50) {
        bot.botTarget = { x: closestEnemy.x, z: closestEnemy.z };
        bot.botState = 'chase';
    }

    // Pick new explore target
    if (!bot.botTarget || dist(bot, { x: bot.botTarget.x, z: bot.botTarget.z }) < 3) {
        if (Math.random() < 0.15 && bot.botState !== 'chase') {
            bot.botState = 'camp';
            bot.campTimer = 0;
            bot.botTarget = null;
            return;
        }
        bot.botState = 'explore';
        bot.botTarget = {
            x: (Math.random() - 0.5) * MAP_SIZE * 0.7,
            z: (Math.random() - 0.5) * MAP_SIZE * 0.7
        };
    }

    // Move toward target
    if (bot.botTarget) {
        const dx = bot.botTarget.x - bot.x;
        const dz = bot.botTarget.z - bot.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d > 0.5) {
            const spd = (bot.windwalk ? bot.windwalkSpeed : bot.speed) * dt;
            const nx = bot.x + dx / d * spd;
            const nz = bot.z + dz / d * spd;
            if (!collidesWithWall(nx, nz, 1.0)) {
                bot.x = Math.max(-MAP_SIZE / 2 + 2, Math.min(MAP_SIZE / 2 - 2, nx));
                bot.z = Math.max(-MAP_SIZE / 2 + 2, Math.min(MAP_SIZE / 2 - 2, nz));
                bot.stuckFrames = 0;
            } else {
                // Wall slide: try X only, then Z only
                if (!collidesWithWall(nx, bot.z, 1.0)) {
                    bot.x = Math.max(-MAP_SIZE / 2 + 2, Math.min(MAP_SIZE / 2 - 2, nx));
                    bot.stuckFrames = 0;
                } else if (!collidesWithWall(bot.x, nz, 1.0)) {
                    bot.z = Math.max(-MAP_SIZE / 2 + 2, Math.min(MAP_SIZE / 2 - 2, nz));
                    bot.stuckFrames = 0;
                } else {
                    bot.stuckFrames++;
                    if (bot.stuckFrames > 10) {
                        bot.botTarget = {
                            x: (Math.random() - 0.5) * MAP_SIZE * 0.5,
                            z: (Math.random() - 0.5) * MAP_SIZE * 0.5
                        };
                        bot.stuckFrames = 0;
                    }
                }
            }
            bot.y = terrainY(bot.x, bot.z) + 0.5;
            bot.rot = Math.atan2(dx, dz);
        }
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

    let closest = null, closestDist = Infinity;
    players.forEach(function(p) {
        if (p === attacker || p.team === attacker.team || p.health <= 0) return;
        if (p.windwalk) return; // Can't shoot invisible
        const d = dist(attacker, p);
        if (d < closestDist && d <= attacker.shootRange) {
            // FOV check: 30 degrees
            const dx = p.x - attacker.x, dz = p.z - attacker.z;
            const angle = Math.atan2(dx, dz);
            let diff = angle - attacker.rot;
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

    broadcast(JSON.stringify({
        t: 'k',
        ki: attacker.id, kn: attacker.username,
        vi: closest.id, vn: closest.username,
        g: gold, p: attacker.price, s: attacker.streak,
        fb: fb ? 1 : 0,
        kx: attacker.x, kz: attacker.z,
        vx: closest.x, vz: closest.z,
        kt: attacker.team, vt: closest.team
    }));

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

        // Bot AI
        if (p.isBot) {
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
                players.set(player.id, player);
                ws.playerId = player.id;

                // Send join confirmation + roster
                const roster = [];
                players.forEach(function(p) {
                    roster.push({ id: p.id, n: p.username, m: p.team, b: p.isBot ? 1 : 0 });
                });
                ws.send(JSON.stringify({ t: 'j', id: player.id, roster: roster }));
                broadcast(JSON.stringify({ t: 'pj', n: name, m: team }));
                console.log(name + ' joined ' + team + '. Total: ' + players.size);
            }
            else if (msg.t === 'mv' && ws.playerId) {
                const p = players.get(ws.playerId);
                if (p && p.health > 0) {
                    // Validate coords are within map bounds
                    const mx = Math.max(-MAP_SIZE / 2, Math.min(MAP_SIZE / 2, msg.x || 0));
                    const mz = Math.max(-MAP_SIZE / 2, Math.min(MAP_SIZE / 2, msg.z || 0));
                    p.moveTarget = { x: mx, z: mz };
                }
            }
            else if (msg.t === 'rot' && ws.playerId) {
                // Weapon rotation update for FOV-based shooting
                const p = players.get(ws.playerId);
                if (p) p.rot = msg.r || 0;
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

    ws.on('close', function() {
        if (ws.playerId) {
            const p = players.get(ws.playerId);
            if (p) {
                const team = p.team;
                players.delete(ws.playerId);
                // Replace with bot
                const bot = createPlayer(
                    nextId++,
                    BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)],
                    team, true
                );
                players.set(bot.id, bot);
                broadcast(JSON.stringify({ t: 'pl', n: p.username }));
                console.log(p.username + ' left, bot added');
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', function() {
    console.log('Elite Snipers server on port ' + PORT + ' (' + players.size + ' bots, ' + TICK_RATE + 'hz tick, ' + SEND_RATE + 'hz send)');
});
