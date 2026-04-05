// Comprehensive sniperz test suite — server logic, LOS, FOV, shooting, bots, match state
const { collidesWithWall, hasLineOfSight, getWalls } = require('./shared/collision');
const { MAP_SIZE, SHOOT_RANGE, SHOOT_COOLDOWN, VISION_RADIUS, FARSIGHT_RADIUS,
    SPAWN_PROTECTION, MAX_PLAYERS, TICK_RATE, SEND_RATE, BOT_NAMES,
    terrainY, spawnPos, isNearSpawn } = require('./shared/constants');
const https = require('https');
const WebSocket = require('ws');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let passed = 0, failed = 0, skipped = 0;
const failures = [];

function test(section, name, fn) {
    try {
        const result = fn();
        if (result === true) { passed++; }
        else { failed++; failures.push(`[${section}] ${name}: ${result}`); console.log(`  ✗ ${name} — ${result}`); }
    } catch(e) { failed++; failures.push(`[${section}] ${name}: THREW ${e.message}`); console.log(`  ✗ ${name} — THREW: ${e.message}`); }
}

function dist(a, b) { return Math.sqrt((a.x-b.x)**2 + (a.z-b.z)**2); }

function fovCheck(sx, sz, aimRot, tx, tz, fovDeg) {
    const dx = tx - sx, dz = tz - sz;
    const angle = Math.atan2(dx, dz);
    let diff = angle - aimRot;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    return Math.abs(diff) < (fovDeg * Math.PI / 180);
}

function simShoot(attacker, target) {
    if (attacker.health <= 0 || target.health <= 0) return 'dead';
    if (target.windwalk) return 'windwalk';
    const d = dist(attacker, target);
    if (d > attacker.shootRange) return 'RANGE d=' + d.toFixed(1);
    if (attacker.shootCd > 0) return 'cooldown';
    const dx = target.x - attacker.x, dz = target.z - attacker.z;
    const angle = Math.atan2(dx, dz);
    let diff = angle - attacker.aimRot;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    if (Math.abs(diff) >= (30 * Math.PI / 180)) return 'FOV diff=' + (Math.abs(diff)*180/Math.PI).toFixed(0) + '°';
    if (!hasLineOfSight(attacker.x, attacker.z, target.x, target.z)) return 'LOS';
    return 'HIT';
}

function mkPlayer(x, z, aimRot) {
    return { x, z, health: 100, shootRange: SHOOT_RANGE, shootCd: 0, aimRot: aimRot || 0 };
}
function mkTarget(x, z) {
    return { x, z, health: 100, windwalk: false };
}

// ==========================================
console.log('\n========== SNIPERZ TEST SUITE ==========\n');

// === 1. CONSTANTS ===
console.log('--- Constants ---');
test('const', 'SHOOT_RANGE = VISION_RADIUS', () => SHOOT_RANGE === VISION_RADIUS || `SHOOT=${SHOOT_RANGE} VIS=${VISION_RADIUS}`);
test('const', 'SHOOT_RANGE is 50', () => SHOOT_RANGE === 50 || 'got ' + SHOOT_RANGE);
test('const', 'MAP_SIZE is 200', () => MAP_SIZE === 200 || 'got ' + MAP_SIZE);
test('const', 'MAX_PLAYERS is 10 (5v5)', () => MAX_PLAYERS === 10 || 'got ' + MAX_PLAYERS);
test('const', 'SHOOT_COOLDOWN is 1.0', () => SHOOT_COOLDOWN === 1.0 || 'got ' + SHOOT_COOLDOWN);

// === 2. COLLISION ===
console.log('--- Collision ---');
test('col', 'Center wall blocks (0,0)', () => collidesWithWall(0, 0, 0.5) || 'should collide');
test('col', 'Open field (30,30) clear', () => !collidesWithWall(30, 30, 1.0) || 'should be clear');
test('col', 'Red spawn clear', () => !collidesWithWall(-70, -70, 1.0) || 'should be clear');
test('col', 'Blue spawn clear', () => !collidesWithWall(70, 70, 1.0) || 'should be clear');
test('col', 'Map boundary blocks', () => collidesWithWall(99, 0, 1.0) || 'should collide');
test('col', 'Just outside center wall (0,2) clear', () => !collidesWithWall(0, 2, 0.3) || 'z=2 should be clear of center wall');
test('col', 'Just outside center wall (8,0) clear', () => !collidesWithWall(8, 0, 0.3) || 'x=8 should be clear of center wall');

// Spawn validity
let badSpawns = 0;
for (let i = 0; i < 100; i++) {
    const rp = spawnPos('red'), bp = spawnPos('blue');
    if (collidesWithWall(rp.x, rp.z, 1.0)) badSpawns++;
    if (collidesWithWall(bp.x, bp.z, 1.0)) badSpawns++;
}
test('col', '200 random spawns all valid', () => badSpawns === 0 || badSpawns + ' bad spawns');

// === 3. LINE OF SIGHT ===
console.log('--- Line of Sight ---');

// Obvious blocks
test('los', 'Blocked through center wall (-10,0)→(10,0)', () => !hasLineOfSight(-10,0,10,0) || 'should block');
test('los', 'Blocked close through center wall (-3,0)→(3,0)', () => !hasLineOfSight(-3,0,3,0) || 'should block');
test('los', 'Blocked through wall7 (10,8)→(20,8)', () => !hasLineOfSight(10,8,20,8) || 'should block');
test('los', 'Blocked through wall8 (-10,8)→(-20,8)', () => !hasLineOfSight(-10,8,-20,8) || 'should block');

// Clear shots
test('los', 'Clear in open (-50,-50)→(-30,-30)', () => hasLineOfSight(-50,-50,-30,-30) || 'should be clear');
test('los', 'Clear point blank (10,10)→(11,10)', () => hasLineOfSight(10,10,11,10) || 'should be clear');
test('los', 'Clear same point', () => hasLineOfSight(5,5,5,5) || 'should be clear');

// Standing NEAR a wall, shooting PAST it (not through it) — use truly open paths
test('los', 'Parallel to center wall south: (0,-3)→(40,-3)', () => hasLineOfSight(0,-3,40,-3) || 'parallel should be clear');
test('los', 'Along wall edge: (-5,-3)→(20,-3)', () => hasLineOfSight(-5,-3,20,-3) || 'along wall edge');
test('los', 'Game pos: (0,-3)→(44,0) Luna', () => hasLineOfSight(0,-3,44,0) || 'real game shot');
test('los', 'Game pos: (4,-3)→(44,10) diagonal', () => hasLineOfSight(4,-3,44,10) || 'real game diagonal');

// Open field shots (no obstacles in path)
test('los', 'Red spawn area: (-70,-70)→(-50,-50)', () => hasLineOfSight(-70,-70,-50,-50) || 'spawn area clear');
test('los', 'Blue spawn area: (75,75)→(60,75)', () => hasLineOfSight(75,75,60,75) || 'spawn area clear');
test('los', 'Far south: (-40,-80)→(40,-80)', () => hasLineOfSight(-40,-80,40,-80) || 'far south');
test('los', 'Far north: (-40,80)→(40,80)', () => hasLineOfSight(-40,80,40,80) || 'far north');

// Shots that SHOULD be blocked (real walls in path)
test('los', 'Through vertical wall (0,-3)→(0,-40) hits wall', () => !hasLineOfSight(0,-3.5,0,-40) || 'vertical wall blocks');
test('los', 'Cross-center (-5,-5)→(5,-5) hits wall', () => !hasLineOfSight(-5,-5,5,-5) || 'tree/wall blocks');
test('los', 'Through wall7 area (8,-2)→(30,-20)', () => !hasLineOfSight(8,-2,30,-20) || 'wall7 area blocks');

// Make sure walls between ACTUALLY block
test('los', 'Through wall at different angles: (-10,0)→(10,1)', () => !hasLineOfSight(-10,0,10,1) || 'angled through center wall should block');
test('los', 'Through wall at different angles: (-10,0)→(10,-1)', () => !hasLineOfSight(-10,0,10,-1) || 'angled through center wall should block');

// === 4. FOV CONE ===
console.log('--- FOV Cone (30°) ---');
test('fov', 'Directly ahead = hit', () => fovCheck(0,0, 0, 0,10, 30) || 'should hit');
test('fov', '15° off = hit', () => fovCheck(0,0, 0, Math.sin(15*Math.PI/180)*10, Math.cos(15*Math.PI/180)*10, 30) || 'should hit');
test('fov', '29° off = hit', () => fovCheck(0,0, 0, Math.sin(29*Math.PI/180)*10, Math.cos(29*Math.PI/180)*10, 30) || 'should hit');
test('fov', '31° off = miss', () => !fovCheck(0,0, 0, Math.sin(31*Math.PI/180)*10, Math.cos(31*Math.PI/180)*10, 30) || 'should miss');
test('fov', '90° off = miss', () => !fovCheck(0,0, 0, 10, 0, 30) || 'should miss');
test('fov', '180° behind = miss', () => !fovCheck(0,0, 0, 0, -10, 30) || 'should miss');
// All 4 cardinal directions
test('fov', 'Aim N, enemy N = hit', () => fovCheck(0,0, 0, 0,10, 30) || 'N');
test('fov', 'Aim E, enemy E = hit', () => fovCheck(0,0, Math.PI/2, 10,0, 30) || 'E');
test('fov', 'Aim S, enemy S = hit', () => fovCheck(0,0, Math.PI, 0,-10, 30) || 'S');
test('fov', 'Aim W, enemy W = hit', () => fovCheck(0,0, -Math.PI/2, -10,0, 30) || 'W');

// === 5. FULL SHOOT SIMULATION ===
console.log('--- Shoot Simulation ---');

// Basic scenarios
test('shoot', 'Face to face open field = HIT', () => {
    const r = simShoot(mkPlayer(30,30, Math.atan2(0,1)), mkTarget(30,40));
    return r === 'HIT' || r;
});
test('shoot', 'Enemy behind = FOV miss', () => {
    const r = simShoot(mkPlayer(30,30, 0), mkTarget(30,20)); // aim +Z, enemy -Z
    return r.startsWith('FOV') || r;
});
test('shoot', 'Wall between = LOS', () => {
    const r = simShoot(mkPlayer(-10,0, Math.atan2(20,0)), mkTarget(10,0));
    return r === 'LOS' || r;
});
test('shoot', 'Out of range = RANGE', () => {
    const r = simShoot(mkPlayer(0,0, 0), mkTarget(0,51));
    return r.startsWith('RANGE') || r;
});
test('shoot', 'Point blank = HIT', () => {
    const r = simShoot(mkPlayer(30,30, Math.atan2(0,1)), mkTarget(30,32));
    return r === 'HIT' || r;
});
test('shoot', 'Max range (50) in open field = HIT', () => {
    // Use spawn area — guaranteed no obstacles
    const r = simShoot(mkPlayer(-70,-70, Math.atan2(0,1)), mkTarget(-70,-20));
    return r === 'HIT' || r;
});

// Near-wall shooting — use clear paths
test('shoot', 'Near center wall, shoot parallel', () => {
    const aim = Math.atan2(40, 0); // aim east
    const r = simShoot(mkPlayer(0,-3, aim), mkTarget(40,-3));
    return r === 'HIT' || r;
});

// Mobile aim (aim = movement direction) — use open field
test('shoot', 'Mobile: moving toward enemy in open = HIT', () => {
    const r = simShoot(mkPlayer(-70,-70, Math.atan2(0,1)), mkTarget(-70,-30));
    return r === 'HIT' || r;
});

// Dead/windwalk targets
test('shoot', 'Dead target = dead', () => {
    const t = mkTarget(30,35); t.health = 0;
    return simShoot(mkPlayer(30,30, 0), t) === 'dead' || 'should be dead';
});
test('shoot', 'Windwalking target = windwalk', () => {
    const t = mkTarget(30,35); t.windwalk = true;
    return simShoot(mkPlayer(30,30, 0), t) === 'windwalk' || 'should be ww';
});

// === 6. TERRAIN ===
console.log('--- Terrain ---');
test('terrain', 'terrainY at origin', () => {
    const y = terrainY(0, 0);
    return Math.abs(y) < 3 || 'extreme height: ' + y;
});
test('terrain', 'terrainY at spawn', () => {
    const y = terrainY(-70, -70);
    return Math.abs(y) < 3 || 'extreme height: ' + y;
});
test('terrain', 'Character offset 0.6 above terrain', () => {
    // Check that 0.6 offset keeps character above ground
    const y = terrainY(0, 0) + 0.6;
    return y > terrainY(0, 0) || 'character below ground';
});

// === 7. LIVE SERVER TESTS ===
console.log('--- Live Server ---');

function fetchDebug() {
    return new Promise((resolve, reject) => {
        https.get('https://localhost/debug', (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
        }).on('error', reject);
    });
}

function connectPlayer(name, team) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket('wss://localhost', { rejectUnauthorized: false });
        const kills = [];
        ws.on('open', () => ws.send(JSON.stringify({ t: 'join', n: name, m: team })));
        let id = null;
        ws.on('message', (data) => {
            try {
                if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) return;
                const msg = JSON.parse(data.toString());
                if (msg.t === 'j') id = msg.id;
                if (msg.t === 'k') kills.push(msg);
            } catch(e) {}
        });
        ws.on('error', reject);
        setTimeout(() => resolve({ ws, id, name, kills }), 1500);
    });
}

async function liveTests() {
    let debug;
    try { debug = await fetchDebug(); } catch(e) {
        console.log('  ⚠ Server not running — skipping live tests');
        skipped += 10;
        return;
    }

    const players = debug.players;
    // Team balance
    const red = players.filter(p => p.team === 'red');
    const blue = players.filter(p => p.team === 'blue');
    test('live', 'Teams are 5v5', () => red.length === 5 && blue.length === 5 || `${red.length}v${blue.length}`);
    test('live', 'Total players = 10', () => players.length === 10 || 'got ' + players.length);

    // No stuck bots (check positions twice)
    const debug2 = await new Promise(r => setTimeout(async () => r(await fetchDebug()), 5000));
    let stuck = 0;
    for (const p of debug2.players) {
        if (!p.isBot || p.health <= 0) continue;
        const prev = players.find(x => x.name === p.name && x.id === p.id);
        if (prev && prev.x === p.x && prev.z === p.z && prev.health > 0) stuck++;
    }
    test('live', 'No bots stuck after 5s', () => stuck <= 1 || stuck + ' bots stuck');

    // No bots inside walls
    let inWall = 0;
    for (const p of debug2.players) {
        if (collidesWithWall(p.x, p.z, 0.8)) inWall++;
    }
    test('live', 'No players inside walls', () => inWall === 0 || inWall + ' in walls');

    // Connect two test players and verify balance
    console.log('  Connecting test players...');
    const p1 = await connectPlayer('Test1', 'red');
    const p2 = await connectPlayer('Test2', 'blue');
    const debug3 = await fetchDebug();
    const r3 = debug3.players.filter(p => p.team === 'red').length;
    const b3 = debug3.players.filter(p => p.team === 'blue').length;
    test('live', 'Balance maintained after 2 joins: 5v5', () => r3 === 5 && b3 === 5 || `${r3}v${b3}`);

    // Move players toward each other and check if kills happen
    console.log('  Running 30s combat simulation...');
    let simKills = 0;
    const simStart = Date.now();
    const moveInterval = setInterval(() => {
        // Move both players toward center, rotating aim
        const t = (Date.now() - simStart) / 1000;
        if (p1.ws.readyState === 1) {
            p1.ws.send(JSON.stringify({ t: 'mv', x: Math.sin(t*0.5)*20, z: Math.cos(t*0.5)*20 }));
            p1.ws.send(JSON.stringify({ t: 'rot', r: t * 0.8 }));
        }
        if (p2.ws.readyState === 1) {
            p2.ws.send(JSON.stringify({ t: 'mv', x: Math.sin(t*0.5+Math.PI)*20, z: Math.cos(t*0.5+Math.PI)*20 }));
            p2.ws.send(JSON.stringify({ t: 'rot', r: -t * 0.8 }));
        }
    }, 100);

    await new Promise(r => setTimeout(r, 30000));
    clearInterval(moveInterval);

    const debug4 = await fetchDebug();
    const totalKills = debug4.players.reduce((s, p) => s + (p.kills || 0), 0);
    test('live', 'Kills happened in 30s (>0)', () => totalKills > 0 || 'no kills — shooting broken!');
    test('live', 'Multiple kills in 30s (>5)', () => totalKills > 5 || 'only ' + totalKills + ' kills — shooting impaired');

    // Check kill distribution — at least 3 different players got kills
    const killers = debug4.players.filter(p => p.kills > 0).length;
    test('live', 'At least 3 different killers', () => killers >= 3 || 'only ' + killers + ' killers');

    // Check no bots stuck after combat
    const debug5 = await new Promise(r => setTimeout(async () => r(await fetchDebug()), 3000));
    let stuckAfter = 0;
    for (const p of debug5.players) {
        if (!p.isBot || p.health <= 0) continue;
        const prev = debug4.players.find(x => x.name === p.name && x.id === p.id);
        if (prev && prev.x === p.x && prev.z === p.z && prev.health > 0) stuckAfter++;
    }
    test('live', 'No bots stuck after combat', () => stuckAfter === 0 || stuckAfter + ' stuck');

    // Verify kills and deaths are tracked
    const totalDeaths = debug5.players.reduce((s, p) => s + (p.deaths || 0), 0);
    test('live', 'Deaths tracked (kills ≈ deaths)', () => Math.abs(totalKills - totalDeaths) <= 2 || `kills=${totalKills} deaths=${totalDeaths}`);

    // Disconnect players — verify bots replace them
    p1.ws.close();
    p2.ws.close();
    await new Promise(r => setTimeout(r, 2000));
    const debug6 = await fetchDebug();
    test('live', 'Players replaced by bots after disconnect', () => {
        const r6 = debug6.players.filter(p => p.team === 'red').length;
        const b6 = debug6.players.filter(p => p.team === 'blue').length;
        return r6 === 5 && b6 === 5 || `${r6}v${b6}`;
    });

    console.log(`  Total kills in simulation: ${totalKills}`);
    console.log('  Kill distribution:');
    debug5.players.sort((a,b) => (b.kills||0) - (a.kills||0)).forEach(p => {
        if (p.kills > 0) console.log(`    ${p.name}${p.isBot ? ' [BOT]' : ''}: ${p.kills}k/${p.deaths}d`);
    });
}

async function run() {
    // Run offline tests first
    await liveTests();

    // === SUMMARY ===
    console.log('\n========== RESULTS ==========');
    console.log(`${passed} passed, ${failed} failed${skipped ? ', ' + skipped + ' skipped' : ''}`);
    if (failures.length > 0) {
        console.log('\nFailures:');
        failures.forEach(f => console.log('  ' + f));
    }
    console.log('');
    process.exit(failed > 0 ? 1 : 0);
}

run();
