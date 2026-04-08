// server/wager-match.js — Isolated 1v1 wager match instance (CommonJS)
// Replicates game logic from server.js without importing it.

const {
    MAP_SIZE, SHOOT_RANGE, SHOOT_COOLDOWN, SPAWN_PROTECTION,
    TICK_RATE, SEND_RATE, terrainY, spawnPos, isNearSpawn
} = require('../shared/constants');
const { collidesWithWall, hasLineOfSight } = require('../shared/collision');

// === CONSTANTS ===
const AFK_TIMEOUT = 0;             // 0 = disabled
const DISCONNECT_TIMEOUT = 0;      // 0 = disabled
const TIME_LIMIT = 10 * 60;       // 10 minutes
const RESPAWN_DELAY = 3000;       // 3s respawn in 1v1
const BYTES_PER_PLAYER = 28;      // Same binary format as main server

// === HELPER ===
function dist(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
}

/**
 * Creates a fresh player object matching server.js createPlayer() structure.
 */
function createPlayer(id, team) {
    const pos = spawnPos(team);
    return {
        id, username: '', team, isBot: false,
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
        // Wager-specific
        lastInput: Date.now(),
        afk: false
    };
}

class WagerMatch {
    /**
     * @param {string} matchId - Unique match identifier
     * @param {string} creatorUserId - Creator's user ID
     * @param {string} joinerUserId - Joiner's user ID
     * @param {number} killTarget - Kills needed to win
     * @param {function} onEnd - Callback: onEnd(winnerId, reason, stats)
     */
    constructor(matchId, creatorUserId, joinerUserId, killTarget, onEnd) {
        this.matchId = matchId;
        this.killTarget = killTarget;
        this.onEnd = onEnd;
        this.started = false;
        this.ended = false;
        this.startTime = null;

        // Player map: userId -> player object
        this.players = new Map();
        this.wsMap = new Map();           // userId -> ws
        this.userIds = [creatorUserId, joinerUserId];

        // Creator = red, Joiner = blue
        const p1 = createPlayer(1, 'red');
        p1.username = creatorUserId;
        this.players.set(creatorUserId, p1);

        const p2 = createPlayer(2, 'blue');
        p2.username = joinerUserId;
        this.players.set(joinerUserId, p2);

        // Disconnect tracking: userId -> disconnect timestamp
        this.disconnectTimers = new Map();

        // Intervals
        this._tickInterval = null;
        this._sendInterval = null;
        this._timerInterval = null;
        this._tickCount = 0;
    }

    /**
     * Assign a WebSocket to a player.
     */
    setReady(userId) {
        if (!this._ready) this._ready = new Set();
        this._ready.add(userId);
    }

    setPlayerWs(userId, ws) {
        this.wsMap.set(userId, ws);
        const p = this.players.get(userId);
        if (p) p.lastInput = Date.now();

        // Clear disconnect timer if reconnecting
        if (this.disconnectTimers.has(userId)) {
            this.disconnectTimers.delete(userId);
        }

        // Handle ws close
        ws.on('close', () => {
            if (this.ended) return;
            this.wsMap.delete(userId);
            this.disconnectTimers.set(userId, Date.now());
        });
    }

    /**
     * Start the match — begins tick loop, send loop, and timer checks.
     */
    start() {
        if (this.started) return;
        this.started = true;
        this.startTime = Date.now();

        // Reset spawn protection
        this.players.forEach(p => {
            p.spawnProt = SPAWN_PROTECTION;
            p.lastInput = Date.now();
        });

        // Roster is sent when players send 'join' message (handleMessage)

        // Game tick at 64hz
        const sendEvery = Math.round(TICK_RATE / SEND_RATE);
        this._tickInterval = setInterval(() => {
            if (this.ended) return;
            this._tick();
            this._tickCount++;

            // Send binary state at 30hz
            if (this._tickCount % sendEvery === 0) {
                this._sendState();
            }
        }, 1000 / TICK_RATE);

        // AFK / disconnect / time limit check every second
        this._timerInterval = setInterval(() => {
            if (this.ended) return;
            this._checkTimers();
        }, 1000);
    }

    /**
     * Stop the match — clean up intervals.
     */
    stop() {
        this.ended = true;
        if (this._tickInterval) { clearInterval(this._tickInterval); this._tickInterval = null; }
        if (this._timerInterval) { clearInterval(this._timerInterval); this._timerInterval = null; }
    }

    /**
     * Handle an incoming message from a player.
     * @param {string} userId
     * @param {object} msg - Parsed JSON message
     */
    handleMessage(userId, msg) {
        const p = this.players.get(userId);
        if (!p) return;

        // Handle join message — send back join confirmation + roster
        if (msg.t === 'join') {
            const ws = this.wsMap.get(userId);
            if (!ws) return;
            p.username = msg.n || p.username;
            // Build roster (just 2 players)
            const roster = [];
            this.players.forEach((pl, uid) => {
                roster.push({ id: pl.id, n: pl.username, m: pl.team, b: 0 });
            });
            ws.send(JSON.stringify({
                t: 'j',
                id: p.id,
                roster,
                limit: this.killTarget,
                timeLimit: 600,
                elapsed: 0,
                rk: 0,
                bk: 0
            }));
            return;
        }

        if (this.ended || !this.started) return;

        p.lastInput = Date.now();
        p.afk = false;

        if (msg.t === 'mv') {
            if (p.health > 0) {
                const mx = Math.max(-MAP_SIZE / 2, Math.min(MAP_SIZE / 2, msg.x || 0));
                const mz = Math.max(-MAP_SIZE / 2, Math.min(MAP_SIZE / 2, msg.z || 0));
                p.moveTarget = { x: mx, z: mz };
            }
        } else if (msg.t === 'rot') {
            p.aimRot = msg.r || 0;
            p.rot = msg.r || 0;
        } else if (msg.t === 'ab') {
            if (p.health <= 0) return;
            // Only windwalk and farsight allowed in wager matches (no shop)
            if (msg.a === 'ww') {
                p.windwalk = true;
                p.windwalkTimer = 3.0;
            } else if (msg.a === 'fs' && typeof msg.x === 'number' && typeof msg.z === 'number') {
                p.farsight = true;
                p.farsightX = msg.x;
                p.farsightZ = msg.z;
                p.farsightTimer = 5.0;
            }
        }
    }

    /**
     * Get current match state for external inspection.
     */
    getState() {
        const stats = {};
        this.players.forEach((p, uid) => {
            stats[uid] = {
                kills: p.kills,
                deaths: p.deaths,
                team: p.team,
                health: p.health,
                connected: this.wsMap.has(uid)
            };
        });
        const elapsed = this.startTime ? Math.round((Date.now() - this.startTime) / 1000) : 0;
        return {
            matchId: this.matchId,
            started: this.started,
            ended: this.ended,
            killTarget: this.killTarget,
            elapsed,
            players: stats
        };
    }

    // === INTERNAL: TICK ===

    _tick() {
        const dt = 1 / TICK_RATE;

        this.players.forEach(p => {
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

            // Movement (same logic as server.js human movement)
            if (p.moveTarget) {
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

            // Auto-shoot
            if (p.shootCd <= 0) this._tryShoot(p);
        });
    }

    // === INTERNAL: SHOOTING (replicated from server.js tryShoot) ===

    _tryShoot(attacker) {
        if (attacker.health <= 0) return;
        if (attacker.shootCd > 0) return;

        const aimDir = attacker.aimRot !== undefined ? attacker.aimRot : attacker.rot;

        let closest = null;
        let closestDist = Infinity;

        this.players.forEach(p => {
            if (p === attacker || p.team === attacker.team || p.health <= 0) return;
            if (p.windwalk) return;
            if (p.spawnProt > 0) return;

            // Must be within vision range
            const vdx = p.x - attacker.x;
            const vdz = p.z - attacker.z;
            const visionDist2 = vdx * vdx + vdz * vdz;
            if (visionDist2 > SHOOT_RANGE * SHOOT_RANGE) return;

            const d = dist(attacker, p);
            if (d > attacker.shootRange) return;

            // FOV cone: 30 degrees
            const fovDeg = 30;
            const dx = p.x - attacker.x;
            const dz = p.z - attacker.z;
            const angle = Math.atan2(dx, dz);
            let diff = angle - aimDir;
            while (diff > Math.PI) diff -= 2 * Math.PI;
            while (diff < -Math.PI) diff += 2 * Math.PI;
            const fovRad = fovDeg * Math.PI / 180;
            if (Math.abs(diff) >= fovRad) return;

            const los = hasLineOfSight(attacker.x, attacker.z, p.x, p.z);
            if (!los) return;

            if (d < closestDist) {
                closest = p;
                closestDist = d;
            }
        });

        if (!closest) return;
        if (this.ended) return;

        attacker.shootCd = attacker.shootCooldownTime;

        // No shield in wager matches (no shop)

        // KILL
        closest.health = 0;
        closest.deaths++;
        closest.price = Math.max(0.1, closest.price * 0.5);
        closest.streak = 0;

        attacker.kills++;
        attacker.streak++;
        attacker.price += 0.5 + closest.price * 0.3;
        const goldEarned = 50 + attacker.streak * 10;
        attacker.gold += goldEarned;

        // Broadcast kill event to both players
        this._broadcast(JSON.stringify({
            t: 'k',
            ki: attacker.id, kn: attacker.username,
            vi: closest.id, vn: closest.username,
            g: goldEarned, p: attacker.price, s: attacker.streak,
            fb: 0,
            kx: attacker.x, kz: attacker.z,
            vx: closest.x, vz: closest.z,
            kt: attacker.team, vt: closest.team,
            rk: this._teamKills('red'), bk: this._teamKills('blue')
        }));

        // Check win condition
        if (attacker.kills >= this.killTarget) {
            this._endMatch(this._userIdForPlayer(attacker), 'kill_target');
            return;
        }

        // Respawn after delay
        const deadPlayerId = closest.id;
        setTimeout(() => {
            if (this.ended) return;
            const p = this._getPlayerById(deadPlayerId);
            if (!p) return;
            const pos = spawnPos(p.team);
            p.health = 100;
            p.x = pos.x;
            p.z = pos.z;
            p.y = terrainY(pos.x, pos.z) + 0.6;
            p.spawnProt = SPAWN_PROTECTION;
            p.streak = 0;
            p.moveTarget = null;
            this._broadcast(JSON.stringify({ t: 'r', id: p.id, x: pos.x, z: pos.z }));
        }, RESPAWN_DELAY);
    }

    // === INTERNAL: TIMER CHECKS ===

    _checkTimers() {
        const now = Date.now();

        // AFK detection (disabled when timeout = 0)
        if (AFK_TIMEOUT > 0) {
            this.players.forEach((p, userId) => {
                if (this.ended) return;
                const idleTime = (now - p.lastInput) / 1000;
                if (idleTime >= AFK_TIMEOUT) {
                    const opponent = this._getOpponent(userId);
                    this._endMatch(opponent, 'afk_forfeit');
                }
            });
        }

        // Disconnect detection (disabled when timeout = 0)
        if (DISCONNECT_TIMEOUT > 0) {
            for (const [userId, disconnectTime] of this.disconnectTimers) {
                if (this.ended) break;
                const elapsed = (now - disconnectTime) / 1000;
                if (elapsed >= DISCONNECT_TIMEOUT) {
                    const opponent = this._getOpponent(userId);
                    this._endMatch(opponent, 'disconnect_forfeit');
                }
            }
        }

        // Time limit
        if (this.startTime && !this.ended) {
            const elapsed = (now - this.startTime) / 1000;
            if (elapsed >= TIME_LIMIT) {
                const redKills = this._teamKills('red');
                const blueKills = this._teamKills('blue');
                if (redKills > blueKills) {
                    this._endMatch(this.userIds[0], 'time_limit');
                } else if (blueKills > redKills) {
                    this._endMatch(this.userIds[1], 'time_limit');
                } else {
                    this._endMatch(null, 'draw');
                }
            }
        }
    }

    // === INTERNAL: STATE ENCODING (same binary format as server.js) ===

    _encodeState(viewerTeam) {
        const all = [];
        this.players.forEach(p => all.push(p));
        const count = all.length;

        // FOW: each player sees enemy only if within SHOOT_RANGE and not windwalking
        const enemyVisible = new Set();
        this.players.forEach(viewer => {
            if (viewer.team !== viewerTeam || viewer.health <= 0) return;
            this.players.forEach(target => {
                if (target.team === viewerTeam || target.health <= 0) return;
                if (target.windwalk) return;
                if (viewer.farsight) {
                    const fdx = target.x - viewer.farsightX;
                    const fdz = target.z - viewer.farsightZ;
                    if (fdx * fdx + fdz * fdz <= 75 * 75) { enemyVisible.add(target.id); return; }
                }
                const dx = target.x - viewer.x;
                const dz = target.z - viewer.z;
                if (dx * dx + dz * dz <= SHOOT_RANGE * SHOOT_RANGE) {
                    enemyVisible.add(target.id);
                }
            });
        });

        const ab = new ArrayBuffer(2 + count * BYTES_PER_PLAYER);
        const view = new DataView(ab);
        view.setUint16(0, count, true);
        let off = 2;
        for (let i = 0; i < all.length; i++) {
            const p = all[i];
            const isEnemy = p.team !== viewerTeam;
            const inFog = isEnemy && p.health > 0 && !enemyVisible.has(p.id);

            view.setUint16(off, p.id, true); off += 2;
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

    _sendState() {
        this.wsMap.forEach((ws, userId) => {
            if (ws.readyState !== 1) return;
            const p = this.players.get(userId);
            if (!p) return;
            const buf = this._encodeState(p.team);
            ws.send(buf);
        });
    }

    _sendRoster() {
        const roster = [];
        this.players.forEach(p => {
            roster.push({ id: p.id, n: p.username, m: p.team, b: 0 });
        });
        this._broadcast(JSON.stringify({
            t: 'j_wager',
            matchId: this.matchId,
            killTarget: this.killTarget,
            timeLimit: TIME_LIMIT,
            roster
        }));
    }

    // === INTERNAL: HELPERS ===

    _broadcast(data) {
        this.wsMap.forEach((ws) => {
            if (ws.readyState === 1) ws.send(data);
        });
    }

    _teamKills(team) {
        let total = 0;
        this.players.forEach(p => {
            if (p.team === team) total += p.kills;
        });
        return total;
    }

    _getPlayerById(id) {
        for (const [, p] of this.players) {
            if (p.id === id) return p;
        }
        return null;
    }

    _userIdForPlayer(player) {
        for (const [userId, p] of this.players) {
            if (p === player) return userId;
        }
        return null;
    }

    _getOpponent(userId) {
        return this.userIds[0] === userId ? this.userIds[1] : this.userIds[0];
    }

    _endMatch(winnerId, reason) {
        if (this.ended) return;
        this.ended = true;
        this.stop();

        const stats = {};
        this.players.forEach((p, uid) => {
            stats[uid] = {
                kills: p.kills,
                deaths: p.deaths,
                team: p.team
            };
        });

        const elapsed = this.startTime ? Math.round((Date.now() - this.startTime) / 1000) : 0;

        // Notify both players
        this._broadcast(JSON.stringify({
            t: 'wager_end',
            matchId: this.matchId,
            winner: winnerId,
            reason,
            rk: this._teamKills('red'),
            bk: this._teamKills('blue'),
            time: elapsed,
            killTarget: this.killTarget,
            stats
        }));

        // Fire callback for settlement
        if (this.onEnd) {
            this.onEnd(winnerId, reason, { ...stats, elapsed, matchId: this.matchId });
        }
    }
}

module.exports = WagerMatch;
