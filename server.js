const { Server } = require('colyseus');
const { WebSocketTransport } = require('@colyseus/ws-transport');
const { Schema, MapSchema, type, defineTypes } = require('@colyseus/schema');
const { Room } = require('colyseus');
const express = require('express');
const http = require('http');
const path = require('path');

// === SCHEMA DEFINITIONS ===
class PlayerState extends Schema {
    constructor() {
        super();
        this.username = '';
        this.team = '';
        this.isBot = false;
        this.x = 0;
        this.z = 0;
        this.y = 0;
        this.rotation = 0;
        this.health = 100;
        this.kills = 0;
        this.deaths = 0;
        this.price = 1.0;
        this.gold = 0;
        this.streak = 0;
        this.spawnProtection = 0;
        this.isWindwalking = false;
    }
}
defineTypes(PlayerState, {
    username: 'string',
    team: 'string',
    isBot: 'boolean',
    x: 'float32',
    z: 'float32',
    y: 'float32',
    rotation: 'float32',
    health: 'int16',
    kills: 'int16',
    deaths: 'int16',
    price: 'float32',
    gold: 'int32',
    streak: 'int16',
    spawnProtection: 'float32',
    isWindwalking: 'boolean',
});

class GameState extends Schema {
    constructor() {
        super();
        this.players = new MapSchema();
        this.firstBlood = false;
    }
}
defineTypes(GameState, {
    players: { map: PlayerState },
    firstBlood: 'boolean',
});

// === CONSTANTS ===
const MAP_SIZE = 200;
const TICK_RATE = 20;
const MAX_PLAYERS = 10;
const SHOOT_RANGE = 45;
const SHOOT_COOLDOWN = 1.0;
const VISION_RADIUS = 50;
const SPAWN_PROTECTION = 1.5;
const BOT_NAMES = ['Archon', 'Vex', 'Nyx', 'Zara', 'Kael', 'Drax', 'Luna', 'Hex', 'Rune', 'Ash'];

function terrainY(x, z) {
    return Math.sin(x * 0.1) * Math.cos(z * 0.1) * 2;
}

function dist(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
}

function spawnPos(team) {
    const sx = team === 'red' ? -70 : 70;
    const sz = team === 'red' ? -70 : 70;
    const x = sx + (Math.random() * 10 - 5);
    const z = sz + (Math.random() * 10 - 5);
    return { x, z, y: terrainY(x, z) + 0.5 };
}

function isNearSpawn(p) {
    const sx = p.team === 'red' ? -70 : 70;
    const sz = p.team === 'red' ? -70 : 70;
    return Math.sqrt((p.x - sx) ** 2 + (p.z - sz) ** 2) < 15;
}

// === GAME ROOM ===
class EliteSnipersRoom extends Room {
    onCreate(options) {
        this.setState(new GameState());
        this.maxClients = MAX_PLAYERS;
        this.botCount = 0;
        this._moveTargets = new Map(); // sessionId -> { x, z }
        this._shootCooldowns = new Map(); // playerId -> cooldown
        this._botStates = new Map(); // botId -> { state, target, campTimer, etc. }

        // Create bots to fill slots
        for (let i = 0; i < MAX_PLAYERS; i++) {
            this._addBot(i < 5 ? 'red' : 'blue', BOT_NAMES[i]);
        }

        // Game loop
        this.setSimulationInterval((dt) => this.gameLoop(dt), 1000 / TICK_RATE);

        // Handle messages
        this.onMessage('move', (client, msg) => {
            this._moveTargets.set(client.sessionId, { x: msg.x, z: msg.z });
        });

        this.onMessage('ability', (client, msg) => {
            const player = this.state.players.get(client.sessionId);
            if (!player) return;
            if (msg.ability === 'windwalk') {
                player.isWindwalking = true;
                this.clock.setTimeout(() => {
                    if (player) player.isWindwalking = false;
                }, 3000);
            }
        });

        this.onMessage('chat', (client, msg) => {
            const player = this.state.players.get(client.sessionId);
            if (!player || !msg.text) return;
            this.broadcast('chat', {
                username: player.username,
                team: player.team,
                text: String(msg.text).slice(0, 200),
            });
        });

        console.log('EliteSnipers room created');
    }

    onJoin(client, options) {
        const username = (options.username || 'Sniper').slice(0, 12);
        const team = options.team === 'blue' ? 'blue' : 'red';

        // Remove a bot from this team
        this._removeBot(team);

        const pos = spawnPos(team);
        const player = new PlayerState();
        player.username = username;
        player.team = team;
        player.isBot = false;
        player.x = pos.x;
        player.z = pos.z;
        player.y = pos.y;
        player.health = 100;
        player.spawnProtection = SPAWN_PROTECTION;
        player.price = 1.0;

        this.state.players.set(client.sessionId, player);
        this._shootCooldowns.set(client.sessionId, 0);

        this.broadcast('playerJoined', { username, team });
        console.log(`${username} joined ${team}. Players: ${this._realPlayerCount()}, Bots: ${this.botCount}`);
    }

    onLeave(client) {
        const player = this.state.players.get(client.sessionId);
        if (player) {
            this.broadcast('playerLeft', { username: player.username });
            console.log(`${player.username} left`);
            const team = player.team;
            this.state.players.delete(client.sessionId);
            this._moveTargets.delete(client.sessionId);
            this._shootCooldowns.delete(client.sessionId);
            // Add bot back
            this._addBot(team);
        }
    }

    _realPlayerCount() {
        let count = 0;
        this.state.players.forEach(p => { if (!p.isBot) count++; });
        return count;
    }

    _addBot(team, name) {
        const botId = `bot_${this.botCount++}`;
        const pos = spawnPos(team);
        const bot = new PlayerState();
        bot.username = name || BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
        bot.team = team;
        bot.isBot = true;
        bot.x = pos.x;
        bot.z = pos.z;
        bot.y = pos.y;
        bot.health = 100;
        bot.spawnProtection = SPAWN_PROTECTION;
        bot.price = 1.0;

        this.state.players.set(botId, bot);
        this._shootCooldowns.set(botId, 0);
        this._botStates.set(botId, {
            state: 'explore',
            target: null,
            campTimer: 0,
        });
    }

    _removeBot(team) {
        for (const [id, p] of this.state.players) {
            if (p.isBot && p.team === team) {
                this.state.players.delete(id);
                this._botStates.delete(id);
                this._shootCooldowns.delete(id);
                return;
            }
        }
    }

    // === GAME LOOP ===
    gameLoop(dt) {
        const deltaTime = dt / 1000;

        this.state.players.forEach((player, id) => {
            if (player.health <= 0) return;

            // Spawn protection
            if (player.spawnProtection > 0) {
                player.spawnProtection -= deltaTime;
                if (!isNearSpawn(player)) player.spawnProtection = 0;
            }

            // Shoot cooldown
            const cd = this._shootCooldowns.get(id) || 0;
            if (cd > 0) this._shootCooldowns.set(id, cd - deltaTime);

            // Movement
            if (player.isBot) {
                this._updateBot(id, player, deltaTime);
            } else {
                this._updatePlayer(id, player, deltaTime);
            }

            // Auto-shoot
            if ((this._shootCooldowns.get(id) || 0) <= 0) {
                this._tryShoot(id, player);
            }
        });
    }

    _updatePlayer(id, player, deltaTime) {
        const target = this._moveTargets.get(id);
        if (!target) return;

        const dx = target.x - player.x;
        const dz = target.z - player.z;
        const d = Math.sqrt(dx * dx + dz * dz);

        if (d < 1) {
            this._moveTargets.delete(id);
            return;
        }

        const speed = (player.isWindwalking ? 14 : 8) * deltaTime;
        player.x += (dx / d) * speed;
        player.z += (dz / d) * speed;
        player.x = Math.max(-MAP_SIZE/2 + 2, Math.min(MAP_SIZE/2 - 2, player.x));
        player.z = Math.max(-MAP_SIZE/2 + 2, Math.min(MAP_SIZE/2 - 2, player.z));
        player.y = terrainY(player.x, player.z) + 0.5;
        player.rotation = Math.atan2(dx, dz);
    }

    _updateBot(id, bot, deltaTime) {
        const bs = this._botStates.get(id);
        if (!bs) return;

        // Find enemies
        let closestEnemy = null;
        let closestDist = Infinity;
        this.state.players.forEach((p, pid) => {
            if (pid === id || p.team === bot.team || p.health <= 0) return;
            const d = dist(bot, p);
            if (d < closestDist) { closestDist = d; closestEnemy = p; }
        });

        // Camp
        if (bs.state === 'camp') {
            bs.campTimer += deltaTime;
            if (bs.campTimer > 5) bs.state = 'explore';
            if (closestEnemy && closestDist < VISION_RADIUS) bs.state = 'chase';
            return;
        }

        // Chase
        if (closestEnemy && closestDist < VISION_RADIUS) {
            bs.state = 'chase';
            bs.target = { x: closestEnemy.x, z: closestEnemy.z };
        }

        // Pick explore target
        if (!bs.target || dist(bot, { x: bs.target.x, z: bs.target.z }) < 3) {
            if (Math.random() < 0.15) {
                bs.state = 'camp';
                bs.campTimer = 0;
                bs.target = null;
                return;
            }
            bs.state = 'explore';
            bs.target = {
                x: (Math.random() - 0.5) * MAP_SIZE * 0.7,
                z: (Math.random() - 0.5) * MAP_SIZE * 0.7,
            };
        }

        // Move
        if (bs.target) {
            const dx = bs.target.x - bot.x;
            const dz = bs.target.z - bot.z;
            const d = Math.sqrt(dx * dx + dz * dz);
            if (d > 0.5) {
                const speed = 8 * deltaTime;
                bot.x += (dx / d) * speed;
                bot.z += (dz / d) * speed;
                bot.x = Math.max(-MAP_SIZE/2 + 2, Math.min(MAP_SIZE/2 - 2, bot.x));
                bot.z = Math.max(-MAP_SIZE/2 + 2, Math.min(MAP_SIZE/2 - 2, bot.z));
                bot.y = terrainY(bot.x, bot.z) + 0.5;
                bot.rotation = Math.atan2(dx, dz);
            }
        }
    }

    _tryShoot(attackerId, attacker) {
        let closest = null;
        let closestId = null;
        let closestDist = Infinity;

        this.state.players.forEach((p, pid) => {
            if (pid === attackerId || p.team === attacker.team || p.health <= 0) return;
            const d = dist(attacker, p);
            if (d < closestDist && d <= SHOOT_RANGE) {
                closest = p;
                closestId = pid;
                closestDist = d;
            }
        });

        if (!closest) return;

        this._shootCooldowns.set(attackerId, SHOOT_COOLDOWN);

        // Spawn protection blocks
        if (closest.spawnProtection > 0) return;

        // Kill
        closest.health = 0;
        closest.deaths++;
        closest.price = Math.max(0.10, closest.price * 0.5);

        attacker.kills++;
        attacker.streak++;
        const pumpAmount = 0.5 + closest.price * 0.3;
        attacker.price += pumpAmount;

        const goldReward = 50 + (attacker.streak * 10) + Math.round(closest.price * 10);
        attacker.gold += goldReward;

        const isFirstBlood = !this.state.firstBlood;
        if (isFirstBlood) this.state.firstBlood = true;

        // Broadcast kill event
        this.broadcast('kill', {
            killerId: attackerId,
            killerName: attacker.username,
            victimId: closestId,
            victimName: closest.username,
            gold: goldReward,
            price: attacker.price,
            streak: attacker.streak,
            firstBlood: isFirstBlood,
        });

        // Respawn after 5s
        this.clock.setTimeout(() => {
            if (!this.state.players.has(closestId)) return;
            const pos = spawnPos(closest.team);
            closest.health = 100;
            closest.x = pos.x;
            closest.z = pos.z;
            closest.y = pos.y;
            closest.spawnProtection = SPAWN_PROTECTION;
            closest.streak = 0;

            this.broadcast('respawn', { id: closestId, x: pos.x, z: pos.z });
        }, 5000);
    }
}

// === SERVER SETUP ===
const app = express();
app.use(express.static(path.join(__dirname)));

const httpServer = http.createServer(app);
const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define('game', EliteSnipersRoom);

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Elite Snipers Colyseus server on port ${PORT}`);
});
