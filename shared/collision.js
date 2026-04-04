// shared/collision.js — AABB collision + line of sight
// CommonJS module. Client loads via fetch() or inline.

const mapData = (typeof require !== 'undefined')
    ? require('../map-data.json')
    : null; // Client will call initCollision(data) instead

// AABB list: [minX, minZ, maxX, maxZ]
let WALLS = [];

function buildWalls(data) {
    WALLS = [];
    // Boundary walls
    data.walls.forEach(function(w) {
        WALLS.push([w.x - w.w/2, w.z - w.d/2, w.x + w.w/2, w.z + w.d/2]);
    });
    // Trees (trunk radius ~0.5)
    data.trees.forEach(function(t) {
        WALLS.push([t.x - 0.5, t.z - 0.5, t.x + 0.5, t.z + 0.5]);
    });
    // Rocks
    data.rocks.forEach(function(r) {
        WALLS.push([r.x - r.s, r.z - r.s, r.x + r.s, r.z + r.s]);
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
    var steps = Math.ceil(len / 1.0);
    for (var i = 1; i < steps; i++) {
        var t = i / steps;
        var px = ax + dx * t, pz = az + dz * t;
        if (collidesWithWall(px, pz, 0.1)) return false;
    }
    return true;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { initCollision, getWalls, collidesWithWall, hasLineOfSight, buildWalls };
}
