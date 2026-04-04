const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static files
app.use(express.static(path.join(__dirname)));

// === GAME CONSTANTS ===
const MAP_SIZE = 200;
const TICK_RATE = 20; // 20 ticks per second
const MAX_PLAYERS = 10; // 5 per team
const SHOOT_RANGE = 45;
const SHOOT_COOLDOWN = 1.0;
const VISION_RADIUS = 50;
const SPAWN_PROTECTION = 1.5;
const BOT_NAMES = ['Archon', 'Vex', 'Nyx', 'Zara', 'Kael', 'Drax', 'Luna', 'Hex', 'Rune', 'Ash'];

// === GAME STATE ===
const gameState = {
    players: new Map(), // id -> player state
    bots: [],
    projectiles: [],
    nextId: 1,
    firstBlood: false,
    tickCount: 0,
};

// === QUEUE ===
const queue = []; // { ws, username, team }

// === PLAYER STATE ===
function createPlayerState(id, username, team, isBot = false) {
    const spawnX = team === 'red' ? -70 + (Math.random() * 10 - 5) : 70 + (Math.random() * 10 - 5);
    const spawnZ = team === 'red' ? -70 + (Math.random() * 10 - 5) : 70 + (Math.random() * 10 - 5);
    return {
        id,
        username,
        team,
        isBot,
        x: spawnX,
        z: spawnZ,
        y: terrainY(spawnX, spawnZ) + 0.5,
        rotation: 0,
        health: 100,
        kills: 0,
        deaths: 0,
        price: 1.0,
        gold: 0,
        speed: 8,
        shootRange: SHOOT_RANGE,
        shootCooldown: 0,
        spawnProtection: SPAWN_PROTECTION,
        inventory: {},
        moveTarget: null, // { x, z }
        velocity: { x: 0, z: 0 },
        isWindwalking: false,
        windwalkTimer: 0,
        _streak: 0,
        _botState: 'explore',
        _botTarget: null,
        _stuckFrames: 0,
        _wallSlideFrames: 0,
        _campTimer: 0,
        _campDuration: 0,
    };
}

function terrainY(x, z) {
    return Math.sin(x * 0.1) * Math.cos(z * 0.1) * 2;
}

function distBetween(a, b) {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dz * dz);
}

function isNearSpawn(p) {
    const sx = p.team === 'red' ? -70 : 70;
    const sz = p.team === 'red' ? -70 : 70;
    return Math.sqrt((p.x - sx) ** 2 + (p.z - sz) ** 2) < 15;
}

// === INITIALIZE BOTS ===
function initBots() {
    gameState.bots = [];
    for (let i = 0; i < MAX_PLAYERS; i++) {
        const team = i < 5 ? 'red' : 'blue';
        const bot = createPlayerState(gameState.nextId++, BOT_NAMES[i], team, true);
        gameState.bots.push(bot);
    }
}
initBots();

// === BOT AI ===
function updateBotAI(bot, deltaTime) {
    if (bot.health <= 0) return;

    // Spawn protection countdown
    if (bot.spawnProtection > 0) {
        bot.spawnProtection -= deltaTime;
        if (!isNearSpawn(bot)) bot.spawnProtection = 0;
    }

    // Shoot cooldown
    if (bot.shootCooldown > 0) bot.shootCooldown -= deltaTime;

    // Simple AI: find closest enemy in range, move toward or away
    const allUnits = [...gameState.players.values(), ...gameState.bots];
    const enemies = allUnits.filter(e => e !== bot && e.team !== bot.team && e.health > 0);

    let closestEnemy = null;
    let closestDist = Infinity;
    for (const e of enemies) {
        const d = distBetween(bot, e);
        if (d < closestDist) {
            closestDist = d;
            closestEnemy = e;
        }
    }

    // Shoot if enemy in range
    if (closestEnemy && closestDist <= bot.shootRange && bot.shootCooldown <= 0) {
        shoot(bot, closestEnemy);
    }

    // Movement AI
    if (bot._botState === 'camp') {
        bot._campTimer += deltaTime;
        if (bot._campTimer >= bot._campDuration) {
            bot._botState = 'explore';
        }
        return;
    }

    // Chase nearby enemy
    if (closestEnemy && closestDist < VISION_RADIUS) {
        bot._botState = 'chase';
        bot.moveTarget = { x: closestEnemy.x, z: closestEnemy.z };
    }

    // Pick new explore target
    if (!bot.moveTarget || distBetween(bot, { x: bot.moveTarget.x, z: bot.moveTarget.z }) < 3) {
        if (Math.random() < 0.2 && bot._botState !== 'chase') {
            bot._botState = 'camp';
            bot._campTimer = 0;
            bot._campDuration = 3 + Math.random() * 6;
            bot.moveTarget = null;
            return;
        }
        bot._botState = 'explore';
        bot.moveTarget = {
            x: (Math.random() - 0.5) * MAP_SIZE * 0.7,
            z: (Math.random() - 0.5) * MAP_SIZE * 0.7,
        };
    }

    // Move toward target
    if (bot.moveTarget) {
        const dx = bot.moveTarget.x - bot.x;
        const dz = bot.moveTarget.z - bot.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > 0.5) {
            const speed = bot.speed * deltaTime;
            const nx = bot.x + (dx / dist) * speed;
            const nz = bot.z + (dz / dist) * speed;
            // Bounds check
            if (Math.abs(nx) < MAP_SIZE / 2 - 2 && Math.abs(nz) < MAP_SIZE / 2 - 2) {
                bot.x = nx;
                bot.z = nz;
                bot.y = terrainY(bot.x, bot.z) + 0.5;
                bot.rotation = Math.atan2(dx, dz);
            } else {
                bot.moveTarget = null; // Hit edge, pick new target
            }
        }
    }
}

// === SHOOTING ===
function shoot(attacker, target) {
    if (attacker.health <= 0 || target.health <= 0) return;
    if (attacker.shootCooldown > 0) return;

    const dist = distBetween(attacker, target);
    if (dist > attacker.shootRange) return;

    attacker.shootCooldown = SHOOT_COOLDOWN;

    // Spawn protection
    if (target.spawnProtection > 0) return;

    // Kill
    target.health = 0;
    target.deaths++;
    attacker.kills++;
    attacker._streak++;

    // Price system
    const pumpAmount = 0.5 + target.price * 0.3;
    attacker.price += pumpAmount;
    target.price = Math.max(0.10, target.price * 0.5);

    // Gold
    const goldReward = 50 + (attacker._streak * 10) + Math.round(target.price * 10);
    attacker.gold += goldReward;

    // Broadcast kill
    broadcast({
        type: 'kill',
        killerId: attacker.id,
        killerName: attacker.username,
        victimId: target.id,
        victimName: target.username,
        gold: goldReward,
        price: attacker.price,
        streak: attacker._streak,
        firstBlood: !gameState.firstBlood,
    });

    if (!gameState.firstBlood) gameState.firstBlood = true;

    // Respawn after 5 seconds
    setTimeout(() => respawn(target), 5000);
}

function respawn(player) {
    player.health = 100;
    player.spawnProtection = SPAWN_PROTECTION;
    player._streak = 0;
    player.inventory = {};
    const sx = player.team === 'red' ? -70 : 70;
    const sz = player.team === 'red' ? -70 : 70;
    player.x = sx + (Math.random() * 10 - 5);
    player.z = sz + (Math.random() * 10 - 5);
    player.y = terrainY(player.x, player.z) + 0.5;
    player.moveTarget = null;

    broadcast({ type: 'respawn', id: player.id, x: player.x, z: player.z });
}

// === PLAYER MOVEMENT (from client input) ===
function handlePlayerMove(player, target) {
    player.moveTarget = target;
}

function updatePlayerMovement(player, deltaTime) {
    if (player.health <= 0 || !player.moveTarget) return;

    // Spawn protection
    if (player.spawnProtection > 0) {
        player.spawnProtection -= deltaTime;
        if (!isNearSpawn(player)) player.spawnProtection = 0;
    }

    // Shoot cooldown
    if (player.shootCooldown > 0) player.shootCooldown -= deltaTime;

    // Auto-shoot closest enemy
    const allUnits = [...gameState.players.values(), ...gameState.bots];
    const enemies = allUnits.filter(e => e !== player && e.team !== player.team && e.health > 0);
    let closestEnemy = null;
    let closestDist = Infinity;
    for (const e of enemies) {
        const d = distBetween(player, e);
        if (d < closestDist && d <= player.shootRange) {
            closestDist = d;
            closestEnemy = e;
        }
    }
    if (closestEnemy && player.shootCooldown <= 0) {
        shoot(player, closestEnemy);
    }

    // Move
    const dx = player.moveTarget.x - player.x;
    const dz = player.moveTarget.z - player.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < 1) {
        player.moveTarget = null;
        return;
    }

    const speed = player.speed * deltaTime;
    const nx = player.x + (dx / dist) * speed;
    const nz = player.z + (dz / dist) * speed;

    if (Math.abs(nx) < MAP_SIZE / 2 - 2 && Math.abs(nz) < MAP_SIZE / 2 - 2) {
        player.x = nx;
        player.z = nz;
        player.y = terrainY(player.x, player.z) + 0.5;
        player.rotation = Math.atan2(dx, dz);
    }
}

// === GAME TICK ===
function gameTick() {
    const deltaTime = 1 / TICK_RATE;
    gameState.tickCount++;

    // Update bots
    gameState.bots.forEach(bot => updateBotAI(bot, deltaTime));

    // Update players
    gameState.players.forEach(player => updatePlayerMovement(player, deltaTime));

    // Build state snapshot
    const allUnits = [...gameState.players.values(), ...gameState.bots];
    const snapshot = {
        type: 'state',
        tick: gameState.tickCount,
        players: allUnits.map(p => ({
            id: p.id,
            username: p.username,
            team: p.team,
            isBot: p.isBot,
            x: p.x,
            z: p.z,
            y: p.y,
            rotation: p.rotation,
            health: p.health,
            kills: p.kills,
            deaths: p.deaths,
            price: p.price,
            gold: p.gold,
            spawnProtection: p.spawnProtection,
            isWindwalking: p.isWindwalking,
            streak: p._streak,
        })),
    };

    // Send to each client (with fog — only show enemies in vision)
    const snapshotStr = JSON.stringify(snapshot);
    wss.clients.forEach(ws => {
        if (ws.readyState === 1 && ws.playerId) {
            ws.send(snapshotStr);
        }
    });
}

setInterval(gameTick, 1000 / TICK_RATE);

// === WEBSOCKET HANDLING ===
function broadcast(msg) {
    const str = JSON.stringify(msg);
    wss.clients.forEach(ws => {
        if (ws.readyState === 1) ws.send(str);
    });
}

function getTeamCounts() {
    const counts = { red: 0, blue: 0 };
    gameState.players.forEach(p => counts[p.team]++);
    return counts;
}

function removeBotForTeam(team) {
    const idx = gameState.bots.findIndex(b => b.team === team);
    if (idx !== -1) {
        gameState.bots.splice(idx, 1);
        return true;
    }
    return false;
}

function addBotForTeam(team) {
    const name = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
    const bot = createPlayerState(gameState.nextId++, name, team, true);
    gameState.bots.push(bot);
}

function tryJoinFromQueue() {
    while (queue.length > 0) {
        const counts = getTeamCounts();
        const totalPlayers = counts.red + counts.blue;
        if (totalPlayers >= MAX_PLAYERS) break;

        const entry = queue.shift();
        if (entry.ws.readyState !== 1) continue; // Disconnected while waiting

        joinPlayer(entry.ws, entry.username, entry.team);
    }
}

function joinPlayer(ws, username, team) {
    const id = gameState.nextId++;
    const player = createPlayerState(id, username, team, false);

    // Remove a bot from this team
    removeBotForTeam(team);

    gameState.players.set(id, player);
    ws.playerId = id;

    ws.send(JSON.stringify({
        type: 'joined',
        id,
        username,
        team,
        x: player.x,
        z: player.z,
    }));

    broadcast({
        type: 'playerJoined',
        id,
        username,
        team,
    });

    console.log(`${username} joined team ${team} (id: ${id}). Players: ${gameState.players.size}, Bots: ${gameState.bots.length}`);
}

wss.on('connection', (ws) => {
    console.log('Client connected');

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);

            switch (msg.type) {
                case 'join': {
                    const username = (msg.username || 'Sniper').slice(0, 12);
                    const team = msg.team === 'blue' ? 'blue' : 'red';
                    const counts = getTeamCounts();
                    const totalPlayers = counts.red + counts.blue;

                    if (totalPlayers >= MAX_PLAYERS) {
                        queue.push({ ws, username, team });
                        ws.send(JSON.stringify({
                            type: 'queued',
                            position: queue.length,
                        }));
                        console.log(`${username} queued (position ${queue.length})`);
                    } else {
                        joinPlayer(ws, username, team);
                    }
                    break;
                }

                case 'move': {
                    const player = gameState.players.get(ws.playerId);
                    if (player && msg.x !== undefined && msg.z !== undefined) {
                        handlePlayerMove(player, { x: msg.x, z: msg.z });
                    }
                    break;
                }

                case 'ability': {
                    const player = gameState.players.get(ws.playerId);
                    if (player && msg.ability === 'windwalk') {
                        player.isWindwalking = true;
                        player.speed = 14;
                        setTimeout(() => {
                            player.isWindwalking = false;
                            player.speed = 8;
                        }, 3000);
                    }
                    break;
                }

                case 'chat': {
                    const player = gameState.players.get(ws.playerId);
                    if (player && msg.text && msg.text.length <= 200) {
                        broadcast({
                            type: 'chat',
                            username: player.username,
                            team: player.team,
                            text: msg.text.slice(0, 200),
                        });
                    }
                    break;
                }
            }
        } catch (e) {}
    });

    ws.on('close', () => {
        // Remove from queue
        const qIdx = queue.findIndex(q => q.ws === ws);
        if (qIdx !== -1) queue.splice(qIdx, 1);

        // Remove from game, add bot back
        if (ws.playerId) {
            const player = gameState.players.get(ws.playerId);
            if (player) {
                console.log(`${player.username} disconnected from team ${player.team}`);
                gameState.players.delete(ws.playerId);
                addBotForTeam(player.team);

                broadcast({
                    type: 'playerLeft',
                    id: ws.playerId,
                    username: player.username,
                });
            }
        }

        tryJoinFromQueue();
    });
});

// === START ===
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Elite Snipers server running on port ${PORT}`);
    console.log(`${gameState.bots.length} bots initialized`);
});
