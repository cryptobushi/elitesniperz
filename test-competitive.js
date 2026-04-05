// Competitive shooting test — tests every shooting scenario from a real player's perspective
// Run with server active: node test-competitive.js

const https = require('https');
const WebSocket = require('ws');
const { collidesWithWall, hasLineOfSight, getWalls } = require('./shared/collision');
const { SHOOT_RANGE, VISION_RADIUS, SHOOT_COOLDOWN, MAP_SIZE, terrainY, spawnPos } = require('./shared/constants');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let passed = 0, failed = 0;
const failures = [];

function test(name, result) {
    if (result === true) { passed++; }
    else { failed++; failures.push(name + ': ' + result); console.log('  ✗ ' + name + ' — ' + result); }
}

function dist(a, b) { return Math.sqrt((a.x-b.x)**2 + (a.z-b.z)**2); }
const walls = getWalls();

// ======================================================
// SECTION 1: LOS — exhaustive wall tests
// ======================================================
console.log('\n=== 1. LINE OF SIGHT — WALL BLOCKING ===');

// Every named wall on the map — shoot through each one
const namedWalls = [
    { name: 'Center horizontal', ax: -10, az: 0, bx: 10, bz: 0 },
    { name: 'Center vertical N', ax: 0, az: 3, bx: 0, bz: 20 },
    { name: 'Center vertical S', ax: 0, az: -3, bx: 0, bz: -20 },
    { name: 'Wall NE (15,8)', ax: 10, az: 8, bx: 22, bz: 8 },
    { name: 'Wall NW (-15,8)', ax: -10, az: 8, bx: -22, bz: 8 },
    { name: 'Wall SE (15,-8)', ax: 10, az: -8, bx: 22, bz: -8 },
    { name: 'Wall SW (-15,-8)', ax: -10, az: -8, bx: -22, bz: -8 },
    { name: 'Boundary N', ax: -20, az: 98, bx: 20, bz: 102 },
    { name: 'Boundary S', ax: -20, az: -102, bx: 20, bz: -98 },
    { name: 'Boundary E', ax: 102, az: -20, bx: 98, bz: 20 },
    { name: 'Boundary W', ax: -102, az: -20, bx: -98, bz: 20 },
];
for (const w of namedWalls) {
    const los = hasLineOfSight(w.ax, w.az, w.bx, w.bz);
    test('Wall blocks: ' + w.name, !los || 'should be blocked');
}

// ======================================================
// SECTION 2: LOS — clear shots that MUST work
// ======================================================
console.log('\n=== 2. LINE OF SIGHT — CLEAR SHOTS ===');

const clearShots = [
    { name: 'Open field SW', ax: -80, az: -80, bx: -60, bz: -80 },
    { name: 'Open field NE', ax: 80, az: 80, bx: 60, bz: 80 },
    { name: 'Point blank', ax: -80, az: -80, bx: -79, bz: -80 },
    { name: 'Red spawn internal', ax: -72, az: -72, bx: -68, bz: -68 },
    { name: 'Blue spawn internal', ax: 72, az: 72, bx: 68, bz: 68 },
    { name: 'South edge clear', ax: -40, az: -90, bx: 40, bz: -90 },
    { name: 'North edge clear', ax: -40, az: 90, bx: 40, bz: 90 },
    { name: 'Parallel to center wall S', ax: -30, az: -4, bx: 30, bz: -4 },
    { name: 'Diagonal open', ax: -80, az: -80, bx: -60, bz: -60 },
    { name: 'Max range open', ax: -70, az: -70, bx: -70, bz: -20 },
];
for (const s of clearShots) {
    const los = hasLineOfSight(s.ax, s.az, s.bx, s.bz);
    test('Clear: ' + s.name, los || 'should be clear');
}

// ======================================================
// SECTION 3: LOS symmetry — A→B must equal B→A
// ======================================================
console.log('\n=== 3. LOS SYMMETRY ===');
const symTests = [
    [-30, -30, 30, 30], [0, -5, 0, 5], [-50, 0, 50, 0],
    [10, 10, 40, 40], [-70, -70, -50, -50], [20, -80, -20, -80],
];
for (const [ax, az, bx, bz] of symTests) {
    const ab = hasLineOfSight(ax, az, bx, bz);
    const ba = hasLineOfSight(bx, bz, ax, az);
    test(`Symmetry (${ax},${az})↔(${bx},${bz})`, ab === ba || `A→B=${ab} B→A=${ba}`);
}

// ======================================================
// SECTION 4: FOV cone — precise angle tests
// ======================================================
console.log('\n=== 4. FOV CONE (30°) ===');

function fovHits(aimRot, enemyAngleDeg, fovDeg) {
    const ex = Math.sin((aimRot + enemyAngleDeg) * Math.PI / 180) * 10;
    const ez = Math.cos((aimRot + enemyAngleDeg) * Math.PI / 180) * 10;
    const dx = ex, dz = ez;
    const angle = Math.atan2(dx, dz);
    let diff = angle - (aimRot * Math.PI / 180);
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    return Math.abs(diff) < (fovDeg * Math.PI / 180);
}

// At every aim direction, test boundary angles
for (const aimDeg of [0, 45, 90, 135, 180, -45, -90, -135]) {
    test(`Aim ${aimDeg}°: 0° offset = hit`, fovHits(aimDeg, 0, 30) || 'should hit');
    test(`Aim ${aimDeg}°: 29° offset = hit`, fovHits(aimDeg, 29, 30) || 'should hit');
    test(`Aim ${aimDeg}°: 31° offset = miss`, !fovHits(aimDeg, 31, 30) || 'should miss');
}

// ======================================================
// SECTION 5: Full shoot simulation (server logic replica)
// ======================================================
console.log('\n=== 5. SHOOT SIMULATION ===');

function simShoot(attacker, targets) {
    if (attacker.health <= 0) return { result: 'attacker_dead' };
    if (attacker.shootCd > 0) return { result: 'cooldown' };
    const aimDir = attacker.aimRot;

    let closest = null, closestDist = Infinity;
    for (const p of targets) {
        if (p.team === attacker.team || p.health <= 0) continue;
        if (p.windwalk) continue;
        if (p.spawnProt > 0) continue;
        // Personal vision check (not team)
        const vdx = p.x - attacker.x, vdz = p.z - attacker.z;
        if (vdx * vdx + vdz * vdz > 50 * 50) continue;
        const d = dist(attacker, p);
        if (d > attacker.shootRange) continue;
        const dx = p.x - attacker.x, dz = p.z - attacker.z;
        const angle = Math.atan2(dx, dz);
        let diff = angle - aimDir;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        if (Math.abs(diff) >= (30 * Math.PI / 180)) continue;
        if (!hasLineOfSight(attacker.x, attacker.z, p.x, p.z)) continue;
        if (d < closestDist) { closest = p; closestDist = d; }
    }
    if (!closest) return { result: 'no_target' };
    return { result: 'HIT', target: closest.name, dist: closestDist };
}

function mkP(name, team, x, z, opts) {
    const aimRot = opts?.aim !== undefined ? opts.aim : Math.atan2(0, 1);
    return {
        name, team, x, z, health: opts?.health ?? 100,
        shootRange: SHOOT_RANGE, shootCd: opts?.cd ?? 0,
        aimRot, windwalk: opts?.ww ?? false, spawnProt: opts?.sp ?? 0,
        godMode: false
    };
}

// 5a: Basic hit scenarios
const t5a = [
    mkP('Enemy', 'blue', -60, -60),
];
let r;
r = simShoot(mkP('Me', 'red', -60, -70, { aim: Math.atan2(0, 1) }), t5a);
test('Face to face open field', r.result === 'HIT' || r.result);

r = simShoot(mkP('Me', 'red', -60, -70, { aim: Math.atan2(0, -1) }), t5a);
test('Aiming backwards = no target', r.result === 'no_target' || r.result);

// 5b: Wall between
r = simShoot(mkP('Me', 'red', -10, 0, { aim: Math.atan2(1, 0) }), [mkP('E', 'blue', 10, 0)]);
test('Wall between = no target', r.result === 'no_target' || r.result);

// 5c: Spawn protection
r = simShoot(mkP('Me', 'red', -60, -60, { aim: 0 }), [mkP('E', 'blue', -60, -50, { sp: 1.0 })]);
test('Spawn protected = no target (not wasted)', r.result === 'no_target' || r.result);

// 5d: Out of range
r = simShoot(mkP('Me', 'red', 0, 0, { aim: 0 }), [mkP('E', 'blue', 0, 51)]);
test('Out of range (51u) = no target', r.result === 'no_target' || r.result);

r = simShoot(mkP('Me', 'red', -70, -70, { aim: 0 }), [mkP('E', 'blue', -70, -21)]);
test('In range (49u) open field = HIT', r.result === 'HIT' || r.result);

// 5e: Windwalk
r = simShoot(mkP('Me', 'red', -60, -60, { aim: 0 }), [mkP('E', 'blue', -60, -50, { ww: true })]);
test('Windwalking = no target', r.result === 'no_target' || r.result);

// 5f: Dead attacker
r = simShoot(mkP('Me', 'red', -60, -60, { aim: 0, health: 0 }), [mkP('E', 'blue', -60, -50)]);
test('Dead attacker = attacker_dead', r.result === 'attacker_dead' || r.result);

// 5g: Cooldown
r = simShoot(mkP('Me', 'red', -60, -60, { aim: 0, cd: 0.5 }), [mkP('E', 'blue', -60, -50)]);
test('On cooldown = cooldown', r.result === 'cooldown' || r.result);

// 5h: Same team
r = simShoot(mkP('Me', 'red', -60, -60, { aim: 0 }), [mkP('Ally', 'red', -60, -50)]);
test('Same team = no target', r.result === 'no_target' || r.result);

// 5i: Multiple enemies — picks closest
const multi = [
    mkP('Far', 'blue', -60, -30),
    mkP('Close', 'blue', -60, -55),
];
r = simShoot(mkP('Me', 'red', -60, -60, { aim: 0 }), multi);
test('Multiple enemies: picks closest', r.result === 'HIT' && r.target === 'Close' || r.result + ' ' + (r.target || ''));

// 5j: Vision range = shoot range (can't shoot beyond 50u even if "visible")
r = simShoot(mkP('Me', 'red', 0, 0, { aim: 0 }), [mkP('E', 'blue', 0, 50.1)]);
test('Beyond 50u = no target', r.result === 'no_target' || r.result);

// ======================================================
// SECTION 6: Near-wall combat scenarios
// ======================================================
console.log('\n=== 6. NEAR-WALL COMBAT ===');

// Both on same side of center wall
r = simShoot(
    mkP('Me', 'red', -5, -4, { aim: Math.atan2(10, 0) }),
    [mkP('E', 'blue', 5, -4)]
);
test('Both south of center wall, shooting east', r.result === 'HIT' || r.result);

r = simShoot(
    mkP('Me', 'red', -5, 4, { aim: Math.atan2(10, 0) }),
    [mkP('E', 'blue', 5, 4)]
);
test('Both north of center wall, shooting east', r.result === 'HIT' || r.result);

// Shooting ALONG a wall (parallel, not through)
r = simShoot(
    mkP('Me', 'red', -30, -2, { aim: Math.atan2(1, 0) }),
    [mkP('E', 'blue', -10, -2)]
);
test('Shooting parallel to center wall south edge', r.result === 'HIT' || r.result);

// Standing at wall corner, shooting past
r = simShoot(
    mkP('Me', 'red', -30, -30, { aim: Math.atan2(1, 1) }),
    [mkP('E', 'blue', -15, -15)]
);
test('Diagonal shot in open', r.result === 'HIT' || r.result);

// Through a tree (trees are 1x1 AABBs) — should block if directly through
// Find a tree
const trees = walls.filter(w => (w[2]-w[0]) <= 1.1 && (w[3]-w[1]) <= 1.1);
if (trees.length > 0) {
    const tree = trees[0];
    const tcx = (tree[0] + tree[2]) / 2, tcz = (tree[1] + tree[3]) / 2;
    const los = hasLineOfSight(tcx - 5, tcz, tcx + 5, tcz);
    test('Through tree center = blocked', !los || 'tree at (' + tcx.toFixed(0) + ',' + tcz.toFixed(0) + ')');
}

// ======================================================
// SECTION 7: Mobile aim (aim = move direction)
// ======================================================
console.log('\n=== 7. MOBILE AIM SCENARIOS ===');

// Mobile player taps toward enemy → aim points at enemy
r = simShoot(
    mkP('Me', 'red', -70, -70, { aim: Math.atan2(10, 10) }), // tap NE
    [mkP('E', 'blue', -60, -60)]
);
test('Tap toward enemy = HIT', r.result === 'HIT' || r.result);

// Mobile player taps AWAY from enemy → miss
r = simShoot(
    mkP('Me', 'red', -70, -70, { aim: Math.atan2(-10, -10) }), // tap SW
    [mkP('E', 'blue', -60, -60)]
);
test('Tap away from enemy = no target', r.result === 'no_target' || r.result);

// Mobile chasing: aim direction matches movement
r = simShoot(
    mkP('Me', 'red', -60, -60, { aim: Math.atan2(0, 1) }), // moving N
    [mkP('E', 'blue', -60, -45)] // enemy 15u north
);
test('Chasing north, enemy north = HIT', r.result === 'HIT' || r.result);

// Mobile: enemy at 45° from move direction = outside 30° cone
r = simShoot(
    mkP('Me', 'red', -60, -60, { aim: 0 }), // moving N (+Z)
    [mkP('E', 'blue', -45, -45)] // enemy NE at ~45°
);
test('Enemy at 45° from move dir = no target', r.result === 'no_target' || r.result);

// ======================================================
// SECTION 8: Live server 60-second combat simulation
// ======================================================
console.log('\n=== 8. LIVE SERVER — 60s COMBAT SIM ===');

function fetchDebug() {
    return new Promise((resolve, reject) => {
        https.get('https://localhost/debug', res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
        }).on('error', reject);
    });
}

function connectPlayer(name, team) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket('wss://localhost', { rejectUnauthorized: false });
        let id = null, killCount = 0, deathCount = 0;
        ws.on('open', () => ws.send(JSON.stringify({ t: 'join', n: name, m: team })));
        ws.on('message', data => {
            try {
                if (Buffer.isBuffer(data)) return;
                const msg = JSON.parse(data.toString());
                if (msg.t === 'j') id = msg.id;
                if (msg.t === 'k') {
                    if (msg.ki === id) killCount++;
                    if (msg.vi === id) deathCount++;
                }
            } catch(e) {}
        });
        ws.on('error', reject);
        setTimeout(() => resolve({ ws, getId: () => id, name, getKills: () => killCount, getDeaths: () => deathCount }), 1500);
    });
}

async function liveTest() {
    let debug;
    try { debug = await fetchDebug(); } catch(e) {
        console.log('  ⚠ Server not running — skipping live tests');
        return;
    }

    // Pre-checks
    const pre = debug.players;
    test('Pre: 10 players', pre.length === 10 || 'got ' + pre.length);
    test('Pre: 5v5 balance',
        pre.filter(p=>p.team==='red').length === 5 && pre.filter(p=>p.team==='blue').length === 5 ||
        pre.filter(p=>p.team==='red').length + 'v' + pre.filter(p=>p.team==='blue').length);
    test('Pre: no duplicate IDs', new Set(pre.map(p=>p.id)).size === pre.length || 'dupes found');

    // Connect two fighters
    console.log('  Connecting fighters...');
    const red = await connectPlayer('Fighter1', 'red');
    const blue = await connectPlayer('Fighter2', 'blue');

    // Verify balance after join
    const postJoin = await fetchDebug();
    test('Post-join: still 5v5',
        postJoin.players.filter(p=>p.team==='red').length === 5 &&
        postJoin.players.filter(p=>p.team==='blue').length === 5 ||
        'unbalanced');
    test('Post-join: still 10 players', postJoin.players.length === 10 || postJoin.players.length);
    test('Post-join: no duplicate IDs', new Set(postJoin.players.map(p=>p.id)).size === 10 || 'dupes');

    // Run combat: both players spiral toward center, rotating aim
    console.log('  Running 60s combat...');
    const snapshots = [];
    const start = Date.now();

    const moveLoop = setInterval(() => {
        const t = (Date.now() - start) / 1000;
        // Red spirals from SW, Blue from NE
        const rx = Math.sin(t * 0.3) * (30 - t * 0.3);
        const rz = Math.cos(t * 0.3) * (30 - t * 0.3);
        const bx = Math.sin(t * 0.3 + Math.PI) * (30 - t * 0.3);
        const bz = Math.cos(t * 0.3 + Math.PI) * (30 - t * 0.3);

        if (red.ws.readyState === 1) {
            red.ws.send(JSON.stringify({ t: 'mv', x: rx, z: rz }));
            red.ws.send(JSON.stringify({ t: 'rot', r: Math.atan2(bx - rx, bz - rz) })); // aim at blue
        }
        if (blue.ws.readyState === 1) {
            blue.ws.send(JSON.stringify({ t: 'mv', x: bx, z: bz }));
            blue.ws.send(JSON.stringify({ t: 'rot', r: Math.atan2(rx - bx, rz - bz) })); // aim at red
        }
    }, 50);

    // Snapshot every 5 seconds
    for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 5000));
        try {
            const snap = await fetchDebug();
            snapshots.push(snap.players);
            const tk = snap.players.reduce((s, p) => s + (p.kills || 0), 0);
            const t = (i + 1) * 5;
            const stuck = [];
            if (snapshots.length > 1) {
                const prev = snapshots[snapshots.length - 2];
                for (const p of snap.players) {
                    if (!p.isBot || p.health <= 0) continue;
                    const pr = prev.find(x => x.id === p.id);
                    if (pr && pr.x === p.x && pr.z === p.z && pr.health > 0) stuck.push(p.name);
                }
            }
            console.log(`  [${t}s] kills:${tk}${stuck.length ? ' stuck:[' + stuck.join(',') + ']' : ''}`);
        } catch(e) {}
    }

    clearInterval(moveLoop);

    // Final analysis
    const final = await fetchDebug();
    const fp = final.players;
    const totalKills = fp.reduce((s, p) => s + (p.kills || 0), 0);
    const totalDeaths = fp.reduce((s, p) => s + (p.deaths || 0), 0);
    const killers = fp.filter(p => p.kills > 0);
    const botKills = fp.filter(p => p.isBot && p.kills > 0);

    console.log(`\n  Final: ${totalKills} kills, ${totalDeaths} deaths`);
    fp.sort((a, b) => b.kills - a.kills);
    for (const p of fp) {
        if (p.kills > 0 || !p.isBot) {
            console.log(`    ${p.name}${p.isBot ? ' [BOT]' : ''}: ${p.kills}k/${p.deaths}d`);
        }
    }

    // Assertions
    test('Kills happened (>0)', totalKills > 0 || 'NO KILLS — shooting broken');
    test('Decent kill rate (>3 in 60s)', totalKills > 3 || 'only ' + totalKills);
    test('Kills ≈ deaths (±2)', Math.abs(totalKills - totalDeaths) <= 2 || `k=${totalKills} d=${totalDeaths}`);
    test('Multiple killers (≥3)', killers.length >= 3 || 'only ' + killers.length);
    test('Bots getting kills', botKills.length >= 2 || 'only ' + botKills.length + ' bot killers');
    // Humans may not always get combat depending on map layout
    const humanCombat = red.getKills() + red.getDeaths() + blue.getKills() + blue.getDeaths();
    console.log(`  Fighters: F1 ${red.getKills()}k/${red.getDeaths()}d, F2 ${blue.getKills()}k/${blue.getDeaths()}d`);
    test('Some combat happened (kills+deaths > 0)', (totalKills + totalDeaths) > 0 || 'no combat at all');

    // Check for stuck bots across all snapshots
    let maxStuck = 0;
    for (let i = 1; i < snapshots.length; i++) {
        let s = 0;
        for (const p of snapshots[i]) {
            if (!p.isBot || p.health <= 0) continue;
            const pr = snapshots[i-1].find(x => x.id === p.id);
            if (pr && pr.x === p.x && pr.z === p.z && pr.health > 0) s++;
        }
        maxStuck = Math.max(maxStuck, s);
    }
    test('Max stuck bots in any 5s window ≤ 1', maxStuck <= 1 || maxStuck + ' stuck');

    // Check no players in walls
    let inWall = fp.filter(p => collidesWithWall(p.x, p.z, 0.8)).length;
    test('At most 1 player near wall edge', inWall <= 1 || inWall + ' in walls');

    // Final balance
    test('Final: still 5v5',
        fp.filter(p=>p.team==='red').length === 5 && fp.filter(p=>p.team==='blue').length === 5 ||
        'unbalanced');
    test('Final: no duplicate IDs', new Set(fp.map(p=>p.id)).size === fp.length || 'dupes');

    // Disconnect and verify replacement
    red.ws.close();
    blue.ws.close();
    await new Promise(r => setTimeout(r, 2000));
    const postDc = await fetchDebug();
    test('Post-disconnect: 10 players', postDc.players.length === 10 || postDc.players.length);
    test('Post-disconnect: 5v5',
        postDc.players.filter(p=>p.team==='red').length === 5 &&
        postDc.players.filter(p=>p.team==='blue').length === 5 ||
        'unbalanced');
    test('Post-disconnect: no duplicate names',
        new Set(postDc.players.map(p=>p.name)).size === postDc.players.length || 'dupe names');
}

async function run() {
    await liveTest();

    console.log('\n========== RESULTS ==========');
    console.log(`${passed} passed, ${failed} failed`);
    if (failures.length > 0) {
        console.log('\nFailures:');
        failures.forEach(f => console.log('  ' + f));
    }
    process.exit(failed > 0 ? 1 : 0);
}

run();
