// Challenge request system tests — full pipeline via HTTPS API
const https = require('https');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let passed = 0, failed = 0;
const failures = [];

function test(name, result) {
    if (result === true) { passed++; console.log('  \u2713 ' + name); }
    else { failed++; failures.push(name + ': ' + result); console.log('  \u2717 ' + name + ' -- ' + result); }
}

function api(method, path, token, body) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: 'localhost',
            port: 443,
            path: '/api' + path,
            method,
            headers: { 'Content-Type': 'application/json' },
            rejectUnauthorized: false,
        };
        if (token) opts.headers.Authorization = 'Bearer ' + token;
        const req = https.request(opts, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, ...JSON.parse(d) }); }
                catch (e) { resolve({ status: res.statusCode, raw: d }); }
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Dev tokens: dev:<userId>:<twitterHandle>:<wallet>
const CREATOR_TOKEN  = 'dev:did:privy:test-creator:creator_handle:CREATORwa11et111111111111111111111111111111';
const CHALLENGER1_TOKEN = 'dev:did:privy:test-challenger1:challenger1_handle:CHALLENGER1wa11et1111111111111111111111111';
const CHALLENGER2_TOKEN = 'dev:did:privy:test-challenger2:challenger2_handle:CHALLENGER2wa11et1111111111111111111111111';

const CREATOR_ID = 'did:privy:test-creator';
const CHALLENGER1_ID = 'did:privy:test-challenger1';
const CHALLENGER2_ID = 'did:privy:test-challenger2';

// Track match IDs for cleanup
const matchesToClean = [];

async function run() {
    console.log('\n========== CHALLENGE REQUEST SYSTEM TESTS ==========\n');

    // Clear stale test data from previous runs
    try {
        const db = require('./db/index');
        db.clearTestChallengeDeclines('did:privy:test-creator', 'did:privy:test-challenger1');
        db.clearTestChallengeDeclines('did:privy:test-creator', 'did:privy:test-challenger2');
        console.log('  (Cleared stale test decline data)');
    } catch(e) { console.log('  (Could not clear test data:', e.message, ')'); }

    // --- Setup: Register users ---
    console.log('--- Setup ---');
    const r1 = await api('POST', '/auth/verify', CREATOR_TOKEN, {});
    test('1. Register creator', r1.success === true || 'status=' + r1.status + ' err=' + (r1.error || r1.raw));
    const r2 = await api('POST', '/auth/verify', CHALLENGER1_TOKEN, {});
    test('   Register challenger1', r2.success === true || 'status=' + r2.status + ' err=' + (r2.error || r2.raw));
    const r3 = await api('POST', '/auth/verify', CHALLENGER2_TOKEN, {});
    test('   Register challenger2', r3.success === true || 'status=' + r3.status + ' err=' + (r3.error || r3.raw));

    // --- Open Mode (existing behavior) ---
    console.log('\n--- Open Mode (existing behavior) ---');

    const openMatch = await api('POST', '/matches', CREATOR_TOKEN, {
        stakeAmount: 10000000, stakeToken: 'SOL', killTarget: 5, matchMode: 'open',
    });
    test('2. Create OPEN match', openMatch.success === true || 'err=' + (openMatch.error || openMatch.raw));
    const openId = openMatch.data?.id;
    if (openId) matchesToClean.push(openId);
    test('   match_mode is open', openMatch.data?.match_mode === 'open' || 'got ' + openMatch.data?.match_mode);

    const joinOpen = await api('POST', '/matches/' + openId + '/join', CHALLENGER1_TOKEN, {});
    test('3. Join OPEN match directly', joinOpen.success === true || 'err=' + (joinOpen.error || joinOpen.raw));

    const cancelOpen = await api('POST', '/matches/' + openId + '/cancel', CREATOR_TOKEN, {});
    test('4. Cancel open match (cleanup)', cancelOpen.success === true || 'err=' + (cancelOpen.error || cancelOpen.raw));

    // --- Selective Mode: Basic Flow ---
    console.log('\n--- Selective Mode: Basic Flow ---');

    const selMatch = await api('POST', '/matches', CREATOR_TOKEN, {
        stakeAmount: 10000000, stakeToken: 'SOL', killTarget: 5, matchMode: 'selective',
    });
    test('5. Create SELECTIVE match', selMatch.success === true || 'err=' + (selMatch.error || selMatch.raw));
    const selId = selMatch.data?.id;
    if (selId) matchesToClean.push(selId);
    test('   match_mode is selective', selMatch.data?.match_mode === 'selective' || 'got ' + selMatch.data?.match_mode);

    const joinSel = await api('POST', '/matches/' + selId + '/join', CHALLENGER1_TOKEN, {});
    test('6. Direct JOIN on selective match fails', joinSel.success === false || 'should have failed');
    test('   Error mentions selective/challenge', (joinSel.error || '').toLowerCase().includes('selective') || (joinSel.error || '').toLowerCase().includes('challenge') || 'err=' + joinSel.error);

    const ch1 = await api('POST', '/matches/' + selId + '/challenge', CHALLENGER1_TOKEN, {});
    test('7. Submit challenge as challenger1', ch1.success === true || 'err=' + (ch1.error || ch1.raw));
    const ch1Id = ch1.data?.id;

    const ch1dup = await api('POST', '/matches/' + selId + '/challenge', CHALLENGER1_TOKEN, {});
    test('8. Duplicate challenge fails', ch1dup.success === false || 'should have failed');

    const ch2 = await api('POST', '/matches/' + selId + '/challenge', CHALLENGER2_TOKEN, {});
    test('9. Submit challenge as challenger2', ch2.success === true || 'err=' + (ch2.error || ch2.raw));
    const ch2Id = ch2.data?.id;

    const listCh = await api('GET', '/matches/' + selId + '/challenges', CREATOR_TOKEN);
    test('10. Get challenges as creator returns 2', (listCh.data || []).length === 2 || 'got ' + (listCh.data || []).length);

    const listChBad = await api('GET', '/matches/' + selId + '/challenges', CHALLENGER1_TOKEN);
    test('11. Get challenges as non-creator fails (403)', listChBad.status === 403 || 'status=' + listChBad.status);

    // --- Selective Mode: Accept ---
    console.log('\n--- Selective Mode: Accept ---');

    const accept1 = await api('POST', '/matches/' + selId + '/challenges/' + ch1Id + '/accept', CREATOR_TOKEN, {});
    test('12. Accept challenger1', accept1.success === true || 'err=' + (accept1.error || accept1.raw));
    test('    Match has joiner_id', !!accept1.data?.joiner_id || 'no joiner_id');

    // Check challenger2's request is expired
    const myChallenge2 = await api('GET', '/matches/' + selId + '/my-challenge', CHALLENGER2_TOKEN);
    test('13. Challenger2 request expired', myChallenge2.data?.status === 'expired' || 'got ' + myChallenge2.data?.status);

    const myChallenge1 = await api('GET', '/matches/' + selId + '/my-challenge', CHALLENGER1_TOKEN);
    test('14. my-challenge as challenger1 = accepted', myChallenge1.data?.status === 'accepted' || 'got ' + myChallenge1.data?.status);

    test('15. my-challenge as challenger2 = expired', myChallenge2.data?.status === 'expired' || 'got ' + myChallenge2.data?.status);

    // Cleanup accepted match
    const cancelSel = await api('POST', '/matches/' + selId + '/cancel', CREATOR_TOKEN, {});

    // --- Selective Mode: Decline ---
    console.log('\n--- Selective Mode: Decline ---');

    const selMatch2 = await api('POST', '/matches', CREATOR_TOKEN, {
        stakeAmount: 10000000, stakeToken: 'SOL', killTarget: 5, matchMode: 'selective',
    });
    test('16. Create new SELECTIVE match', selMatch2.success === true || 'err=' + (selMatch2.error || selMatch2.raw));
    const sel2Id = selMatch2.data?.id;
    if (sel2Id) matchesToClean.push(sel2Id);

    const ch3 = await api('POST', '/matches/' + sel2Id + '/challenge', CHALLENGER1_TOKEN, {});
    test('17. Submit challenge as challenger1', ch3.success === true || 'err=' + (ch3.error || ch3.raw));
    const ch3Id = ch3.data?.id;

    const decline1 = await api('POST', '/matches/' + sel2Id + '/challenges/' + ch3Id + '/decline', CREATOR_TOKEN, {});
    test('18. Decline challenger1', decline1.success === true || 'err=' + (decline1.error || decline1.raw));

    const myDeclined = await api('GET', '/matches/' + sel2Id + '/my-challenge', CHALLENGER1_TOKEN);
    test('19. my-challenge as challenger1 = declined', myDeclined.data?.status === 'declined' || 'got ' + myDeclined.data?.status);

    // After decline, challenger can submit again (declined != pending, so getMyPendingChallenge returns null)
    const ch3again = await api('POST', '/matches/' + sel2Id + '/challenge', CHALLENGER1_TOKEN, {});
    test('20. Challenger1 can re-challenge after decline', ch3again.success === true || 'err=' + (ch3again.error || ch3again.raw));

    // Cleanup
    await api('POST', '/matches/' + sel2Id + '/cancel', CREATOR_TOKEN, {});

    // --- Edge Cases ---
    console.log('\n--- Edge Cases ---');

    const chBadMatch = await api('POST', '/matches/nonexistent-id-12345/challenge', CHALLENGER1_TOKEN, {});
    test('21. Challenge non-existent match fails', chBadMatch.success === false || 'should have failed');

    // Challenge own match
    const selMatch3 = await api('POST', '/matches', CREATOR_TOKEN, {
        stakeAmount: 10000000, stakeToken: 'SOL', killTarget: 5, matchMode: 'selective',
    });
    const sel3Id = selMatch3.data?.id;
    if (sel3Id) matchesToClean.push(sel3Id);

    const chOwn = await api('POST', '/matches/' + sel3Id + '/challenge', CREATOR_TOKEN, {});
    test('22. Challenge own match fails', chOwn.success === false || 'should have failed');

    // Accept already-accepted request (reuse ch1Id from the first selective match — already accepted)
    const acceptAgain = await api('POST', '/matches/' + selId + '/challenges/' + ch1Id + '/accept', CREATOR_TOKEN, {});
    test('23. Accept already-accepted request fails', acceptAgain.success === false || 'should have failed');

    // Challenge a match that is not open (cancelled match)
    const chCancelled = await api('POST', '/matches/' + sel2Id + '/challenge', CHALLENGER2_TOKEN, {});
    test('24. Challenge cancelled match fails', chCancelled.success === false || 'should have failed');

    // --- Cleanup ---
    console.log('\n--- Cleanup ---');
    let cleaned = 0;
    for (const id of matchesToClean) {
        const r = await api('POST', '/matches/' + id + '/cancel', CREATOR_TOKEN, {});
        if (r.success) cleaned++;
    }
    test('25. Cleanup test matches', true);

    // === Decline Cooldown Tests ===
    console.log('\n--- Decline Cooldown ---');

    // Clear declines from earlier tests so cooldown starts fresh
    try {
        const db = require('./db/index');
        db.clearTestChallengeDeclines('did:privy:test-creator', 'did:privy:test-challenger1');
    } catch(e) {}

    // Create a selective match for cooldown testing
    const cdMatch = await api('POST', '/matches', CREATOR_TOKEN, { stakeAmount: 10000000, stakeToken: 'SOL', killTarget: 5, matchMode: 'selective' });
    if (!cdMatch.success) { console.log('  Cooldown match creation failed:', cdMatch.error || cdMatch.status); process.exit(1); }
    const cdMatchId = cdMatch.data.id;
    matchesToClean.push(cdMatchId);

    // Challenge #1 → decline
    const cd1 = await api('POST', '/matches/' + cdMatchId + '/challenge', CHALLENGER1_TOKEN);
    test('26. First challenge for cooldown test', cd1.success === true);
    const cd1Id = cd1.data?.id;
    const dec1 = await api('POST', '/matches/' + cdMatchId + '/challenges/' + cd1Id + '/decline', CREATOR_TOKEN);
    test('27. First decline', dec1.success === true);

    // Challenge #2 → decline (should work — only 1 decline so far)
    const cd2 = await api('POST', '/matches/' + cdMatchId + '/challenge', CHALLENGER1_TOKEN);
    test('28. Second challenge after first decline', cd2.success === true);
    const cd2Id = cd2.data?.id;
    const dec2 = await api('POST', '/matches/' + cdMatchId + '/challenges/' + cd2Id + '/decline', CREATOR_TOKEN);
    test('29. Second decline', dec2.success === true);

    // Challenge #3 → should be BLOCKED (2 declines in 30 min)
    const cd3 = await api('POST', '/matches/' + cdMatchId + '/challenge', CHALLENGER1_TOKEN);
    test('30. Third challenge blocked by cooldown', cd3.success === false);
    test('31. Cooldown error message', (cd3.error || '').includes('declined'));

    // Challenger2 should NOT be affected by challenger1's cooldown
    const cd4 = await api('POST', '/matches/' + cdMatchId + '/challenge', CHALLENGER2_TOKEN);
    test('32. Challenger2 not affected by challenger1 cooldown', cd4.success === true);

    // Cleanup cooldown match
    await api('POST', '/matches/' + cdMatchId + '/cancel', CREATOR_TOKEN, {});

    // === Results ===
    console.log('\n========== RESULTS ==========');
    console.log(passed + ' passed, ' + failed + ' failed');
    if (failures.length > 0) {
        console.log('\nFailures:');
        failures.forEach(f => console.log('  - ' + f));
    }
    console.log('');

    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
