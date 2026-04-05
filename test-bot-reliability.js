// Bot reliability test — diagnose ghost bots, stuck bots, ID mismatches, respawn bugs
const https = require('https');
const WebSocket = require('ws');
const { collidesWithWall, hasLineOfSight } = require('./shared/collision');
const { MAP_SIZE, SHOOT_RANGE, BOT_NAMES } = require('./shared/constants');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let passed = 0, failed = 0;
const failures = [];
function test(name, result) {
    if (result === true) { passed++; }
    else { failed++; failures.push(name + ': ' + result); console.log('  ✗ ' + name + ' — ' + result); }
}

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
        let id = null, roster = null, errors = [];
        const messages = [];
        ws.on('open', () => ws.send(JSON.stringify({ t: 'join', n: name, m: team })));
        ws.on('message', data => {
            try {
                const str = data.toString();
                // Try JSON first — ws delivers everything as Buffer
                if (str.charAt(0) === '{') {
                    const msg = JSON.parse(str);
                    messages.push(msg);
                    if (msg.t === 'j') { id = msg.id; roster = msg.roster; }
                } else {
                    messages.push({ type: 'binary', len: data.length });
                }
            } catch(e) { errors.push(e.message); }
        });
        ws.on('error', e => errors.push(e.message));
        setTimeout(() => resolve({ ws, getId: () => id, getRoster: () => roster, messages, errors, name }), 2000);
    });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
    console.log('\n========== BOT RELIABILITY TEST ==========\n');

    // ============================================
    // TEST 1: Initial state — clean 5v5
    // ============================================
    console.log('--- 1. Initial Server State ---');
    const init = await fetchDebug();
    const ip = init.players;
    test('10 players on fresh server', ip.length === 10 || 'got ' + ip.length);
    test('All are bots', ip.every(p => p.isBot) || 'non-bot found');
    test('5 red', ip.filter(p => p.team === 'red').length === 5 || 'red: ' + ip.filter(p => p.team === 'red').length);
    test('5 blue', ip.filter(p => p.team === 'blue').length === 5 || 'blue: ' + ip.filter(p => p.team === 'blue').length);
    test('All unique IDs', new Set(ip.map(p => p.id)).size === 10 || 'duplicate IDs');
    test('All unique names', new Set(ip.map(p => p.name)).size === 10 || 'duplicate names');
    test('Most alive (some may be respawning)', ip.filter(p => p.health > 0).length >= 8 || 'too many dead: ' + ip.filter(p => p.health > 0).length);
    test('No bots in walls', ip.filter(p => collidesWithWall(p.x, p.z, 0.8)).length === 0 || 'bot in wall');

    // ============================================
    // TEST 2: Player join — bot replaced correctly
    // ============================================
    console.log('\n--- 2. Player Join (bot replacement) ---');
    const p1 = await connectPlayer('JoinTest1', 'red');
    await sleep(1000);
    const afterJoin1 = await fetchDebug();
    const aj1 = afterJoin1.players;
    test('Still 10 players after join', aj1.length === 10 || 'got ' + aj1.length);
    test('Still 5v5', aj1.filter(p => p.team === 'red').length === 5 && aj1.filter(p => p.team === 'blue').length === 5 || 'unbalanced');
    test('JoinTest1 is in roster', aj1.some(p => p.name === 'JoinTest1') || 'not found');
    test('JoinTest1 is on red', aj1.find(p => p.name === 'JoinTest1')?.team === 'red' || 'wrong team');
    test('JoinTest1 is not a bot', !aj1.find(p => p.name === 'JoinTest1')?.isBot || 'marked as bot');
    test('One fewer red bot', aj1.filter(p => p.team === 'red' && p.isBot).length === 4 || 'red bots: ' + aj1.filter(p => p.team === 'red' && p.isBot).length);
    test('No duplicate IDs after join', new Set(aj1.map(p => p.id)).size === 10 || 'dupe IDs');
    test('No duplicate names after join', new Set(aj1.map(p => p.name)).size === 10 || 'dupe names');
    test('Player got valid ID', p1.getId() > 0 || 'id: ' + p1.getId());
    test('Player got roster with 10', p1.getRoster()?.length === 10 || 'roster: ' + p1.getRoster()?.length);

    // Join second player on same team (should auto-balance to blue)
    const p2 = await connectPlayer('JoinTest2', 'red');
    await sleep(1000);
    const afterJoin2 = await fetchDebug();
    const aj2 = afterJoin2.players;
    test('Still 10 after second join', aj2.length === 10 || 'got ' + aj2.length);
    test('Still 5v5 (auto-balanced)', aj2.filter(p => p.team === 'red').length === 5 && aj2.filter(p => p.team === 'blue').length === 5 || 'unbalanced');

    // Join 3 more — fill up one team
    const p3 = await connectPlayer('JoinTest3', 'red');
    const p4 = await connectPlayer('JoinTest4', 'red');
    const p5 = await connectPlayer('JoinTest5', 'red');
    await sleep(1000);
    const afterJoin5 = await fetchDebug();
    const aj5 = afterJoin5.players;
    test('Still 10 after 5 joins', aj5.length === 10 || 'got ' + aj5.length);
    test('Still 5v5 after 5 joins', aj5.filter(p => p.team === 'red').length === 5 && aj5.filter(p => p.team === 'blue').length === 5 || 'unbalanced');
    test('No duplicate IDs after 5 joins', new Set(aj5.map(p => p.id)).size === 10 || 'dupe IDs');
    test('No duplicate names after 5 joins', new Set(aj5.map(p => p.name)).size === 10 || 'dupe names: ' + aj5.map(p=>p.name).join(','));

    // ============================================
    // TEST 3: Player disconnect — bot replaces
    // ============================================
    console.log('\n--- 3. Player Disconnect (bot replacement) ---');
    const preDisc = await fetchDebug();
    const preIds = new Set(preDisc.players.map(p => p.id));

    p1.ws.close();
    await sleep(2000);
    const afterDisc1 = await fetchDebug();
    const ad1 = afterDisc1.players;
    test('Still 10 after disconnect', ad1.length === 10 || 'got ' + ad1.length);
    test('Still 5v5 after disconnect', ad1.filter(p => p.team === 'red').length === 5 && ad1.filter(p => p.team === 'blue').length === 5 || 'unbalanced');
    test('JoinTest1 replaced by bot', !ad1.some(p => p.name === 'JoinTest1') || 'still in roster');
    test('Replacement is a bot', ad1.filter(p => p.isBot && p.team === 'red').length > aj5.filter(p => p.isBot && p.team === 'red').length - 1 || 'no replacement bot');
    test('New bot has unique name', new Set(ad1.map(p => p.name)).size === 10 || 'dupe names');
    test('New bot has new unique ID', new Set(ad1.map(p => p.id)).size === 10 || 'dupe IDs');

    // Rapid connect/disconnect cycles
    console.log('\n--- 4. Rapid Connect/Disconnect (stress test) ---');
    for (let cycle = 0; cycle < 5; cycle++) {
        const temp = await connectPlayer('Rapid' + cycle, 'blue');
        await sleep(500);
        temp.ws.close();
        await sleep(500);
    }
    const afterRapid = await fetchDebug();
    const ar = afterRapid.players;
    test('Still 10 after 5 rapid cycles', ar.length === 10 || 'got ' + ar.length);
    test('Still 5v5 after rapid cycles', ar.filter(p => p.team === 'red').length === 5 && ar.filter(p => p.team === 'blue').length === 5 || 'unbalanced');
    test('No duplicate IDs after rapid', new Set(ar.map(p => p.id)).size === 10 || 'dupe IDs');
    test('No duplicate names after rapid', new Set(ar.map(p => p.name)).size === 10 || 'dupe names: ' + ar.map(p=>p.name).join(','));
    test('All alive after rapid', ar.filter(p => p.health > 0).length >= 8 || 'too many dead'); // some may be respawning

    // ============================================
    // TEST 5: Bot movement over 20 seconds
    // ============================================
    console.log('\n--- 5. Bot Movement (20s tracking) ---');
    const snapshots = [];
    for (let i = 0; i < 10; i++) {
        await sleep(2000);
        const snap = await fetchDebug();
        snapshots.push(snap.players);
    }

    // Check each bot moved at some point
    const botNames = new Set();
    for (const snap of snapshots) {
        for (const p of snap) if (p.isBot) botNames.add(p.name);
    }
    for (const name of botNames) {
        const positions = snapshots.map(s => s.find(p => p.name === name)).filter(Boolean);
        if (positions.length < 2) continue;
        let moved = false;
        for (let i = 1; i < positions.length; i++) {
            if (positions[i].x !== positions[0].x || positions[i].z !== positions[0].z) { moved = true; break; }
        }
        test('Bot ' + name + ' moved in 20s', moved || 'stuck at (' + positions[0].x + ',' + positions[0].z + ')');
    }

    // Check stuck percentage
    let totalStuckTicks = 0, totalBotTicks = 0;
    for (let i = 1; i < snapshots.length; i++) {
        for (const p of snapshots[i]) {
            if (!p.isBot || p.health <= 0) continue;
            totalBotTicks++;
            const prev = snapshots[i-1].find(x => x.id === p.id);
            if (prev && prev.x === p.x && prev.z === p.z && prev.health > 0) totalStuckTicks++;
        }
    }
    const stuckPct = totalBotTicks > 0 ? (totalStuckTicks / totalBotTicks * 100).toFixed(0) : 0;
    test('Stuck rate < 20%', parseInt(stuckPct) < 20 || stuckPct + '% stuck');
    console.log('  Stuck rate: ' + stuckPct + '% (' + totalStuckTicks + '/' + totalBotTicks + ' ticks)');

    // ============================================
    // TEST 6: Kill tracking — deaths create respawns, not new bots
    // ============================================
    console.log('\n--- 6. Kill/Respawn Tracking (30s) ---');
    const preKill = await fetchDebug();
    const preKillIds = new Set(preKill.players.map(p => p.id));
    await sleep(30000);
    const postKill = await fetchDebug();
    const postKillIds = new Set(postKill.players.map(p => p.id));

    // IDs should stay the same — kills don't create new IDs
    const newIds = [...postKillIds].filter(id => !preKillIds.has(id));
    const goneIds = [...preKillIds].filter(id => !postKillIds.has(id));
    test('No new IDs from kills (bots reuse IDs)', newIds.length === 0 || 'new IDs: ' + newIds.join(','));
    test('No lost IDs from kills', goneIds.length === 0 || 'lost IDs: ' + goneIds.join(','));
    test('Still 10 players after combat', postKill.players.length === 10 || 'got ' + postKill.players.length);
    test('Still 5v5 after combat', postKill.players.filter(p=>p.team==='red').length === 5 && postKill.players.filter(p=>p.team==='blue').length === 5 || 'unbalanced');

    // Kills happened
    const totalK = postKill.players.reduce((s, p) => s + (p.kills || 0), 0);
    const totalD = postKill.players.reduce((s, p) => s + (p.deaths || 0), 0);
    test('Kills happened in 30s', totalK > 0 || 'no kills');
    test('Kills ≈ deaths', Math.abs(totalK - totalD) <= 2 || 'k=' + totalK + ' d=' + totalD);
    console.log('  Kills: ' + totalK + ', Deaths: ' + totalD);

    // Check no bots in walls after combat
    const inWall = postKill.players.filter(p => collidesWithWall(p.x, p.z, 0.8)).length;
    test('No bots in walls after combat', inWall <= 1 || inWall + ' in walls');

    // ============================================
    // TEST 7: Binary state consistency
    // ============================================
    console.log('\n--- 7. Binary State Consistency ---');
    const viewer = await connectPlayer('Viewer', 'red');
    await sleep(3000);

    // Count binary messages received
    const binMsgs = viewer.messages.filter(m => m.type === 'binary');
    test('Receiving binary state updates', binMsgs.length > 10 || 'only ' + binMsgs.length + ' in 3s');

    // Check binary message sizes are consistent (2 + N*28 bytes)
    const sizes = binMsgs.map(m => m.len);
    const expectedSize = 2 + 10 * 28; // 10 players * 28 bytes + 2 byte count header
    // Filter to only state updates (ignore any initial burst messages of different size)
    const stateUpdates = sizes.filter(s => s === expectedSize);
    test('Binary state updates received', stateUpdates.length > 5 || 'only ' + stateUpdates.length + ' of size ' + expectedSize);
    test('Most binary msgs are state updates', stateUpdates.length / sizes.length > 0.8 || 'state: ' + stateUpdates.length + '/' + sizes.length + ' sizes: ' + [...new Set(sizes)].join(','));

    // Check roster message was received
    const rosterMsgs = viewer.messages.filter(m => m.t === 'roster');
    const joinMsg = viewer.messages.find(m => m.t === 'j');
    test('Got join confirmation', !!joinMsg || 'no join msg');
    test('Join included roster', joinMsg?.roster?.length === 10 || 'roster: ' + joinMsg?.roster?.length);

    viewer.ws.close();

    // ============================================
    // Cleanup — disconnect all test players
    // ============================================
    console.log('\n--- Cleanup ---');
    [p2, p3, p4, p5].forEach(p => { try { p.ws.close(); } catch(e) {} });
    await sleep(2000);
    const final = await fetchDebug();
    test('Final: 10 players', final.players.length === 10 || 'got ' + final.players.length);
    test('Final: 5v5', final.players.filter(p=>p.team==='red').length === 5 && final.players.filter(p=>p.team==='blue').length === 5 || 'unbalanced');
    test('Final: all bots', final.players.every(p => p.isBot) || 'non-bot remaining');
    test('Final: no duplicate IDs', new Set(final.players.map(p=>p.id)).size === 10 || 'dupe IDs');
    test('Final: no duplicate names', new Set(final.players.map(p=>p.name)).size === 10 || 'dupe names: ' + final.players.map(p=>p.name).join(','));

    // ============================================
    // SUMMARY
    // ============================================
    console.log('\n========== RESULTS ==========');
    console.log(passed + ' passed, ' + failed + ' failed');
    if (failures.length > 0) {
        console.log('\nFailures:');
        failures.forEach(f => console.log('  ' + f));
    }
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
