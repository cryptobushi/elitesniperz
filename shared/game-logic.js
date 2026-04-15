// shared/game-logic.js — Shared game logic used by both server.js and wager-match.js
// Consolidates duplicated movement, tick, state encoding, and shooting helpers.

const {
    MAP_SIZE, SHOOT_RANGE, SHOOT_COOLDOWN, SPAWN_PROTECTION,
    BYTES_PER_PLAYER, terrainY, spawnPos, isNearSpawn, dist
} = require('./constants');
const { collidesWithWall, hasLineOfSight } = require('./collision');

// === PLAYER CREATION ===

/**
 * Create a base player object with all shared fields.
 * @param {number} id - Player ID
 * @param {string} team - 'red' or 'blue'
 * @param {object} [extra] - Additional fields to merge (e.g. bot AI fields)
 * @returns {object}
 */
function createBasePlayer(id, team, extra) {
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
        lastInput: Date.now(),
        afk: false,
        ...extra
    };
}

// === PLAYER TICK (cooldowns, timers, movement) ===

/**
 * Update shared per-player tick state: spawn protection, cooldowns, ability timers.
 * @param {object} p - Player object
 * @param {number} dt - Delta time in seconds
 * @param {object} [opts] - Options: { wwCooldownKey, fsCooldownKey }
 */
function tickPlayerTimers(p, dt, opts) {
    const wwKey = (opts && opts.wwCooldownKey) || 'wwCooldown';
    const fsKey = (opts && opts.fsCooldownKey) || 'fsCooldown';

    // Spawn protection countdown
    if (p.spawnProt > 0) {
        p.spawnProt -= dt;
        if (!isNearSpawn(p.x, p.z, p.team)) p.spawnProt = 0;
    }

    // Shoot cooldown
    if (p.shootCd > 0) p.shootCd -= dt;

    // Ability cooldowns
    if (p[wwKey] > 0) p[wwKey] -= dt;
    if (p[fsKey] > 0) p[fsKey] -= dt;

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
}

// === MOVEMENT ===

/**
 * Move a player toward their moveTarget with wall-sliding collision.
 * Clears moveTarget when close enough. Updates y and rot.
 * @param {object} p - Player with x, z, moveTarget, windwalk, etc.
 * @param {number} dt - Delta time
 */
function movePlayerToTarget(p, dt) {
    if (!p.moveTarget) return;
    const dx = p.moveTarget.x - p.x;
    const dz = p.moveTarget.z - p.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < 1) {
        p.moveTarget = null;
        return;
    }
    const spd = (p.windwalk ? p.windwalkSpeed : p.speed) * dt;
    const nx = p.x + dx / d * spd;
    const nz = p.z + dz / d * spd;
    const half = MAP_SIZE / 2 - 2;
    if (!collidesWithWall(nx, nz, 0.8)) {
        p.x = Math.max(-half, Math.min(half, nx));
        p.z = Math.max(-half, Math.min(half, nz));
    } else if (!collidesWithWall(nx, p.z, 0.8)) {
        p.x = Math.max(-half, Math.min(half, nx));
    } else if (!collidesWithWall(p.x, nz, 0.8)) {
        p.z = Math.max(-half, Math.min(half, nz));
    }
    p.y = terrainY(p.x, p.z) + 0.6;
    p.rot = Math.atan2(dx, dz);
}

// === STATE ENCODING ===

/**
 * Compute which enemy player IDs are visible to a given team.
 * @param {Map|Array} players - Players collection (iterable of player objects)
 * @param {string} viewerTeam - 'red' or 'blue'
 * @param {number} visionRange - Range for vision check
 * @returns {Set} - Set of visible enemy IDs
 */
function computeVisibleEnemies(players, viewerTeam, visionRange) {
    const enemyVisible = new Set();
    const forEach = players.forEach ? players.forEach.bind(players) : (fn) => players.forEach(fn);

    forEach(function(target) {
        if (target.team === viewerTeam || target.health <= 0) return;
        if (target.windwalk) return;

        forEach(function(viewer) {
            if (enemyVisible.has(target.id)) return;
            if (viewer.team !== viewerTeam || viewer.health <= 0) return;
            if (viewer.farsight) {
                const fdx = target.x - viewer.farsightX;
                const fdz = target.z - viewer.farsightZ;
                if (fdx * fdx + fdz * fdz <= 75 * 75) { enemyVisible.add(target.id); return; }
            }
            const dx = target.x - viewer.x;
            const dz = target.z - viewer.z;
            if (dx * dx + dz * dz <= visionRange * visionRange) {
                enemyVisible.add(target.id);
            }
        });
    });

    return enemyVisible;
}

/**
 * Encode player state into a binary buffer.
 * @param {object[]} allPlayers - Array of player objects
 * @param {string} viewerTeam - Team perspective
 * @param {Set} enemyVisible - Set of visible enemy IDs
 * @returns {Buffer}
 */
function encodePlayerState(allPlayers, viewerTeam, enemyVisible) {
    const count = allPlayers.length;
    const ab = new ArrayBuffer(2 + count * BYTES_PER_PLAYER);
    const view = new DataView(ab);
    view.setUint16(0, count, true);
    let off = 2;
    for (let i = 0; i < count; i++) {
        const p = allPlayers[i];
        const isEnemy = p.team !== viewerTeam;
        const inFog = isEnemy && p.health > 0 && !enemyVisible.has(p.id);

        view.setUint16(off, p.id, true); off += 2;
        view.setFloat32(off, inFog ? 0 : p.x, true); off += 4;
        view.setFloat32(off, inFog ? 0 : p.z, true); off += 4;
        view.setFloat32(off, inFog ? 0 : p.rot, true); off += 4;
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

// === SHOOTING ===

/**
 * Find the closest shootable enemy for an attacker within FOV and LOS.
 * @param {object} attacker - The attacking player
 * @param {Map|Array} players - All players
 * @param {object} [opts] - Options: { fovDeg }
 * @returns {{ target: object|null, dist: number }}
 */
function findShootTarget(attacker, players, opts) {
    const fovDeg = (opts && opts.fovDeg) || 30;
    const aimDir = attacker.aimRot !== undefined ? attacker.aimRot : attacker.rot;
    let closest = null;
    let closestDist = Infinity;

    const forEach = players.forEach ? players.forEach.bind(players) : (fn) => players.forEach(fn);

    forEach(function(p) {
        if (p === attacker || p.team === attacker.team || p.health <= 0) return;
        if (p.windwalk) return;
        if (p.spawnProt > 0) return;
        if (p.godMode) return;

        // Must be within vision range
        const vdx = p.x - attacker.x;
        const vdz = p.z - attacker.z;
        if (vdx * vdx + vdz * vdz > SHOOT_RANGE * SHOOT_RANGE) return;

        const d = dist(attacker, p);
        if (d > attacker.shootRange) return;

        // FOV cone check
        const dx = p.x - attacker.x;
        const dz = p.z - attacker.z;
        const angle = Math.atan2(dx, dz);
        let diff = angle - aimDir;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        const fovRad = fovDeg * Math.PI / 180;
        if (Math.abs(diff) >= fovRad) return;

        if (!hasLineOfSight(attacker.x, attacker.z, p.x, p.z)) return;

        if (d < closestDist) {
            closest = p;
            closestDist = d;
        }
    });

    return { target: closest, dist: closestDist };
}

module.exports = {
    createBasePlayer,
    tickPlayerTimers,
    movePlayerToTarget,
    computeVisibleEnemies,
    encodePlayerState,
    findShootTarget,
};
