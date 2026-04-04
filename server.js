const { Server } = require('colyseus');
const { WebSocketTransport } = require('@colyseus/ws-transport');
const { Schema, MapSchema, type } = require('@colyseus/schema');
const { Room } = require('colyseus');
const express = require('express');
const http = require('http');
const path = require('path');

// === SCHEMA ===
class PlayerState extends Schema {}
type('string')(PlayerState.prototype, 'username');
type('string')(PlayerState.prototype, 'team');
type('boolean')(PlayerState.prototype, 'isBot');
type('float32')(PlayerState.prototype, 'x');
type('float32')(PlayerState.prototype, 'z');
type('float32')(PlayerState.prototype, 'y');
type('float32')(PlayerState.prototype, 'rotation');
type('int16')(PlayerState.prototype, 'health');
type('int16')(PlayerState.prototype, 'kills');
type('int16')(PlayerState.prototype, 'deaths');
type('float32')(PlayerState.prototype, 'price');
type('int32')(PlayerState.prototype, 'gold');
type('int16')(PlayerState.prototype, 'streak');
type('float32')(PlayerState.prototype, 'spawnProtection');
type('boolean')(PlayerState.prototype, 'isWindwalking');

class GameState extends Schema {}
type({ map: PlayerState })(GameState.prototype, 'players');
type('boolean')(GameState.prototype, 'firstBlood');

// === CONSTANTS ===
const MAP_SIZE = 200;
const TICK_RATE = 20;
const MAX_PLAYERS = 10;
const SHOOT_RANGE = 45;
const SHOOT_COOLDOWN = 1.0;
const VISION_RADIUS = 50;
const SPAWN_PROTECTION = 1.5;
const BOT_NAMES = ['Archon', 'Vex', 'Nyx', 'Zara', 'Kael', 'Drax', 'Luna', 'Hex', 'Rune', 'Ash'];

function terrainY(x, z) { return Math.sin(x * 0.1) * Math.cos(z * 0.1) * 2; }
function dist(a, b) { return Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2); }
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
    onCreate() {
        const state = new GameState();
        state.players = new MapSchema();
        state.firstBlood = false;
        this.setState(state);

        this.maxClients = MAX_PLAYERS;
        this._botId = 0;
        this._moveTargets = new Map();
        this._shootCooldowns = new Map();
        this._botStates = new Map();

        // Fill with bots
        for (let i = 0; i < MAX_PLAYERS; i++) {
            this._addBot(i < 5 ? 'red' : 'blue', BOT_NAMES[i]);
        }

        this.setSimulationInterval((dt) => this.gameLoop(dt), 1000 / TICK_RATE);

        this.onMessage('move', (client, msg) => {
            this._moveTargets.set(client.sessionId, { x: msg.x, z: msg.z });
        });

        this.onMessage('ability', (client, msg) => {
            const p = this.state.players.get(client.sessionId);
            if (p && msg.ability === 'windwalk') {
                p.isWindwalking = true;
                this.clock.setTimeout(() => { if (p) p.isWindwalking = false; }, 3000);
            }
        });

        this.onMessage('chat', (client, msg) => {
            const p = this.state.players.get(client.sessionId);
            if (p && msg.text) {
                this.broadcast('chat', { username: p.username, team: p.team, text: String(msg.text).slice(0, 200) });
            }
        });

        console.log('Room created with', MAX_PLAYERS, 'bots');
    }

    onJoin(client, options) {
        const username = (options.username || 'Sniper').slice(0, 12);
        const team = options.team === 'blue' ? 'blue' : 'red';

        this._removeBot(team);

        const pos = spawnPos(team);
        const p = new PlayerState();
        p.username = username; p.team = team; p.isBot = false;
        p.x = pos.x; p.z = pos.z; p.y = pos.y;
        p.health = 100; p.price = 1.0; p.spawnProtection = SPAWN_PROTECTION;

        this.state.players.set(client.sessionId, p);
        this._shootCooldowns.set(client.sessionId, 0);

        this.broadcast('playerJoined', { username, team });
        console.log(`${username} joined ${team}`);
    }

    onLeave(client) {
        const p = this.state.players.get(client.sessionId);
        if (p) {
            const team = p.team;
            this.broadcast('playerLeft', { username: p.username });
            this.state.players.delete(client.sessionId);
            this._moveTargets.delete(client.sessionId);
            this._shootCooldowns.delete(client.sessionId);
            this._addBot(team);
            console.log(`${p.username} left, bot added to ${team}`);
        }
    }

    _addBot(team, name) {
        const id = `bot_${this._botId++}`;
        const pos = spawnPos(team);
        const p = new PlayerState();
        p.username = name || BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
        p.team = team; p.isBot = true;
        p.x = pos.x; p.z = pos.z; p.y = pos.y;
        p.health = 100; p.price = 1.0; p.spawnProtection = SPAWN_PROTECTION;

        this.state.players.set(id, p);
        this._shootCooldowns.set(id, 0);
        this._botStates.set(id, { state: 'explore', target: null, campTimer: 0 });
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

    gameLoop(dt) {
        const delta = dt / 1000;
        this.state.players.forEach((p, id) => {
            if (p.health <= 0) return;
            if (p.spawnProtection > 0) {
                p.spawnProtection -= delta;
                if (!isNearSpawn(p)) p.spawnProtection = 0;
            }
            const cd = this._shootCooldowns.get(id) || 0;
            if (cd > 0) this._shootCooldowns.set(id, cd - delta);

            if (p.isBot) this._updateBot(id, p, delta);
            else this._updatePlayer(id, p, delta);

            if ((this._shootCooldowns.get(id) || 0) <= 0) this._tryShoot(id, p);
        });
    }

    _updatePlayer(id, p, dt) {
        const t = this._moveTargets.get(id);
        if (!t) return;
        const dx = t.x - p.x, dz = t.z - p.z;
        const d = Math.sqrt(dx*dx + dz*dz);
        if (d < 1) { this._moveTargets.delete(id); return; }
        const spd = (p.isWindwalking ? 14 : 8) * dt;
        p.x = Math.max(-MAP_SIZE/2+2, Math.min(MAP_SIZE/2-2, p.x + (dx/d)*spd));
        p.z = Math.max(-MAP_SIZE/2+2, Math.min(MAP_SIZE/2-2, p.z + (dz/d)*spd));
        p.y = terrainY(p.x, p.z) + 0.5;
        p.rotation = Math.atan2(dx, dz);
    }

    _updateBot(id, bot, dt) {
        const bs = this._botStates.get(id);
        if (!bs) return;

        let closestEnemy = null, closestDist = Infinity;
        this.state.players.forEach((e, eid) => {
            if (eid === id || e.team === bot.team || e.health <= 0) return;
            const d = dist(bot, e);
            if (d < closestDist) { closestDist = d; closestEnemy = e; }
        });

        if (bs.state === 'camp') {
            bs.campTimer += dt;
            if (bs.campTimer > 5 || (closestEnemy && closestDist < VISION_RADIUS)) bs.state = 'explore';
            return;
        }

        if (closestEnemy && closestDist < VISION_RADIUS) {
            bs.target = { x: closestEnemy.x, z: closestEnemy.z };
        }

        if (!bs.target || dist(bot, {x:bs.target.x, z:bs.target.z}) < 3) {
            if (Math.random() < 0.15) { bs.state = 'camp'; bs.campTimer = 0; bs.target = null; return; }
            bs.state = 'explore';
            bs.target = { x: (Math.random()-0.5)*MAP_SIZE*0.7, z: (Math.random()-0.5)*MAP_SIZE*0.7 };
        }

        if (bs.target) {
            const dx = bs.target.x - bot.x, dz = bs.target.z - bot.z;
            const d = Math.sqrt(dx*dx + dz*dz);
            if (d > 0.5) {
                const spd = 8 * dt;
                bot.x = Math.max(-MAP_SIZE/2+2, Math.min(MAP_SIZE/2-2, bot.x + (dx/d)*spd));
                bot.z = Math.max(-MAP_SIZE/2+2, Math.min(MAP_SIZE/2-2, bot.z + (dz/d)*spd));
                bot.y = terrainY(bot.x, bot.z) + 0.5;
                bot.rotation = Math.atan2(dx, dz);
            }
        }
    }

    _tryShoot(attackerId, attacker) {
        let closest = null, closestId = null, closestDist = Infinity;
        this.state.players.forEach((p, pid) => {
            if (pid === attackerId || p.team === attacker.team || p.health <= 0) return;
            const d = dist(attacker, p);
            if (d < closestDist && d <= SHOOT_RANGE) { closest = p; closestId = pid; closestDist = d; }
        });
        if (!closest) return;

        this._shootCooldowns.set(attackerId, SHOOT_COOLDOWN);
        if (closest.spawnProtection > 0) return;

        closest.health = 0;
        closest.deaths++;
        closest.price = Math.max(0.10, closest.price * 0.5);
        attacker.kills++;
        attacker.streak++;
        attacker.price += 0.5 + closest.price * 0.3;
        attacker.gold += 50 + attacker.streak * 10 + Math.round(closest.price * 10);

        const fb = !this.state.firstBlood;
        if (fb) this.state.firstBlood = true;

        this.broadcast('kill', {
            killerId: attackerId, killerName: attacker.username,
            victimId: closestId, victimName: closest.username,
            gold: attacker.gold, price: attacker.price, streak: attacker.streak, firstBlood: fb,
        });

        this.clock.setTimeout(() => {
            if (!this.state.players.has(closestId)) return;
            const pos = spawnPos(closest.team);
            closest.health = 100; closest.x = pos.x; closest.z = pos.z; closest.y = pos.y;
            closest.spawnProtection = SPAWN_PROTECTION; closest.streak = 0;
            this.broadcast('respawn', { id: closestId, x: pos.x, z: pos.z });
        }, 5000);
    }
}

// === SERVER ===
const app = express();
app.use(express.static(path.join(__dirname)));
// Serve node_modules for client SDK
app.use('/node_modules', express.static(path.join(__dirname, 'node_modules')));

const httpServer = http.createServer(app);
const gameServer = new Server({ transport: new WebSocketTransport({ server: httpServer }) });
gameServer.define('game', EliteSnipersRoom);

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Elite Snipers Colyseus server on port ${PORT}`);
});
