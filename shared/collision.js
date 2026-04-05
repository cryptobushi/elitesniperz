// shared/collision.js — AABB collision + line of sight
// CommonJS module. Client loads via fetch() or inline.

const mapData = (typeof require !== 'undefined')
    ? require('../map-data.json')
    : null; // Client will call initCollision(data) instead

// AABB list: [minX, minZ, maxX, maxZ]
let WALLS = [];     // All obstacles (movement collision)
let LOS_WALLS = []; // Only walls + rocks (LOS blocking — trees don't block shots)

function buildWalls(data) {
    WALLS = [];
    LOS_WALLS = [];
    // Boundary walls
    data.walls.forEach(function(w) {
        var aabb = [w.x - w.w/2, w.z - w.d/2, w.x + w.w/2, w.z + w.d/2];
        WALLS.push(aabb);
        LOS_WALLS.push(aabb);
    });
    // Trees (block movement only, NOT shots)
    data.trees.forEach(function(t) {
        WALLS.push([t.x - 0.5, t.z - 0.5, t.x + 0.5, t.z + 0.5]);
    });
    // Rocks (block both movement and shots)
    data.rocks.forEach(function(r) {
        var aabb = [r.x - r.s, r.z - r.s, r.x + r.s, r.z + r.s];
        WALLS.push(aabb);
        LOS_WALLS.push(aabb);
    });
    return WALLS;
}

// Auto-init on server (has require)
if (mapData) {
    buildWalls(mapData);
}

function initCollision(data) {
    buildWalls(data);
}

function getWalls() {
    return WALLS;
}

function collidesWithWall(x, z, r) {
    if (r === undefined) r = 1.0;
    for (var i = 0; i < WALLS.length; i++) {
        var w = WALLS[i];
        if (x + r > w[0] && x - r < w[2] && z + r > w[1] && z - r < w[3]) return true;
    }
    return false;
}

function hasLineOfSight(ax, az, bx, bz) {
    var dx = bx - ax, dz = bz - az;
    var len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.1) return true;
    // Check every 0.5 units — only walls and rocks block LOS (not trees)
    var steps = Math.ceil(len / 0.5);
    for (var i = 1; i < steps; i++) {
        var t = i / steps;
        var px = ax + dx * t, pz = az + dz * t;
        for (var j = 0; j < LOS_WALLS.length; j++) {
            var w = LOS_WALLS[j];
            if (px > w[0] && px < w[2] && pz > w[1] && pz < w[3]) return false;
        }
    }
    return true;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { initCollision, getWalls, collidesWithWall, hasLineOfSight, buildWalls };
}
