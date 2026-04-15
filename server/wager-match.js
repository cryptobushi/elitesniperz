
const {
    MAP_SIZE, SHOOT_RANGE, SHOOT_COOLDOWN, SPAWN_PROTECTION,
    TICK_RATE, SEND_RATE, BYTES_PER_PLAYER, terrainY, spawnPos, isNearSpawn, dist,
    WAGER_AFK_TIMEOUT, WAGER_DISCONNECT_TIMEOUT
} = require('../shared/constants');
const { collidesWithWall, hasLineOfSight } = require('../shared/collision');
const {
    createBasePlayer, tickPlayerTimers, movePlayerToTarget,
    computeVisibleEnemies, encodePlayerState, findShootTarget
} = require('../shared/game-logic');
const AFK_TIMEOUT = WAGER_AFK_TIMEOUT || 30;
const DISCONNECT_TIMEOUT = WAGER_DISCONNECT_TIMEOUT || 30;
const TIME_LIMIT = 10 * 60;       // 10 minutes
const RESPAWN_DELAY = 3000;

/**
 * Creates a fresh player object for wager matches.
 */
function createPlayer(id, team) {
    return createBasePlayer(id, team, {
        wwCooldown: 0, fsCooldown: 0,
    });
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
        this.wsMap = new Map();
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

    setReady(userId) {
        if (!this._ready) this._ready = new Set();
        this._ready.add(userId);
    }

    setPlayerWs(userId, ws) {
        this.wsMap.set(userId, ws);
        const p = this.players.get(userId);
        if (p) p.lastInput = Date.now();
        if (this.disconnectTimers.has(userId)) {
            this.disconnectTimers.delete(userId);
    
            this._broadcast(JSON.stringify({ t: 'wager_rc' }));
        }
        ws.on('close', () => {
            if (this.ended) return;
            this.wsMap.delete(userId);
            this.disconnectTimers.set(userId, Date.now());
        });
    }

    start() {
        if (this.started) return;
        this.started = true;
        this.startTime = Date.now();
        this.players.forEach(p => {
            p.spawnProt = SPAWN_PROTECTION;
            p.lastInput = Date.now();
        });
        const sendEvery = Math.round(TICK_RATE / SEND_RATE);
        this._tickInterval = setInterval(() => {
            if (this.ended) return;
            this._tick();
            this._tickCount++;
            if (this._tickCount % sendEvery === 0) {
                this._sendState();
            }
        }, 1000 / TICK_RATE);
        this._timerInterval = setInterval(() => {
            if (this.ended) return;
            this._checkTimers();
        }, 1000);
    }

    stop() {
        this.ended = true;
        if (this._tickInterval) { clearInterval(this._tickInterval); this._tickInterval = null; }
        if (this._timerInterval) { clearInterval(this._timerInterval); this._timerInterval = null; }
    }

    /**
     * @param {string} userId
     * @param {object} msg - Parsed JSON message
     */
    handleMessage(userId, msg) {
        const p = this.players.get(userId);
        if (!p) return;
        if (msg.t === 'join') {
            const ws = this.wsMap.get(userId);
            if (!ws) return;
            p.username = msg.n || p.username;
    
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

            if (msg.a === 'ww') {
                if (p.wwCooldown > 0) return;
                p.wwCooldown = 10;
                p.windwalk = true;
                p.windwalkTimer = 3.0;
            } else if (msg.a === 'fs' && typeof msg.x === 'number' && typeof msg.z === 'number') {
                if (p.fsCooldown > 0) return;
                p.fsCooldown = 15;
                p.farsight = true;
                p.farsightX = Math.max(-MAP_SIZE/2, Math.min(MAP_SIZE/2, msg.x || 0));
                p.farsightZ = Math.max(-MAP_SIZE/2, Math.min(MAP_SIZE/2, msg.z || 0));
                p.farsightTimer = 5.0;
            }
        }
    }

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

    _tick() {
        const dt = 1 / TICK_RATE;

        this.players.forEach(p => {
            if (p.health <= 0) return;

            tickPlayerTimers(p, dt);
            movePlayerToTarget(p, dt);

    
            if (p.shootCd <= 0) this._tryShoot(p);
        });
    }

    _tryShoot(attacker) {
        if (attacker.health <= 0) return;
        if (attacker.shootCd > 0) return;

        const { target: closest } = findShootTarget(attacker, this.players);
        if (!closest) return;
        if (this.ended) return;

        attacker.shootCd = attacker.shootCooldownTime;

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
        if (attacker.kills >= this.killTarget) {
            this._endMatch(this._userIdForPlayer(attacker), 'kill_target');
            return;
        }
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
                } else {
                    // Grace period still active — notify connected player
                    const opponent = this._getOpponent(userId);
                    const opWs = this.wsMap.get(opponent);
                    if (opWs && opWs.readyState === 1) {
                        opWs.send(JSON.stringify({ t: 'wager_dc', remaining: Math.ceil(DISCONNECT_TIMEOUT - elapsed) }));
                    }
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

    _encodeState(viewerTeam) {
        const all = [];
        this.players.forEach(p => all.push(p));
        const enemyVisible = computeVisibleEnemies(this.players, viewerTeam, SHOOT_RANGE);
        return encodePlayerState(all, viewerTeam, enemyVisible);
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
