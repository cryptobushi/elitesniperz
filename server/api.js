'use strict';

/** @typedef {import('../shared/types').MatchRow} MatchRow */
/** @typedef {import('../shared/types').MatchResponse} MatchResponse */
/** @typedef {import('../shared/types').UserRow} UserRow */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { authMiddleware } = require('./auth');
const db = require('../db/index');
const { VALID_TOKENS, WAGER_KILL_TARGETS: VALID_KILL_TARGETS } = require('../shared/constants');

const router = express.Router();
const BCRYPT_ROUNDS = 10;
const MIN_STAKE = { SOL: 10000000, USDC: 1000000 }; // 0.01 SOL, 1 USDC in base units
const MAX_STAKE = { SOL: 100000000000, USDC: 10000000000 }; // 100 SOL, 10000 USDC in base units

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function success(data) {
    return { success: true, data };
}

// Check if user has enough balance for a match stake
async function checkBalance(userId, stakeAmount, stakeToken) {
    const user = db.getUser(userId);
    if (!user?.privy_wallet) return { ok: false, error: 'No wallet' };
    if (!escrow.isReady()) return { ok: true }; // Skip check if escrow not configured (dev mode)
    const balance = await escrow.getBalance(user.privy_wallet, stakeToken);
    if (balance === null) return { ok: true }; // Can't verify, allow
    if (balance < stakeAmount) {
        const human = stakeToken === 'SOL' ? (stakeAmount / 1e9) : (stakeAmount / 1e6);
        const has = stakeToken === 'SOL' ? (balance / 1e9) : (balance / 1e6);
        return { ok: false, error: `Insufficient balance. Need ${human} ${stakeToken}, have ${has.toFixed(4)} ${stakeToken}` };
    }
    return { ok: true };
}

function fail(msg) {
    return { success: false, error: msg };
}

// ---------------------------------------------------------------------------
// POST /auth/verify — verify Privy token, upsert user, return profile
// ---------------------------------------------------------------------------
router.post('/auth/verify', authMiddleware, (req, res) => {
    try {
        const pu = req.privyUser;
        // Extract twitter — could be in .twitter or .linked_accounts
        const twitter = pu.twitter || {};
        const linkedTwitter = (pu.linked_accounts || []).find(a => a.type === 'twitter_oauth') || {};
        const twitterHandle = twitter.username || linkedTwitter.username || twitter.handle || 'unknown';
        const twitterId = twitter.subject || linkedTwitter.subject || twitter.id || null;
        const displayName = twitter.name || linkedTwitter.name || twitterHandle;

        // Extract Solana wallet — could be in .wallet, .linked_accounts, or .mfa
        const wallet = pu.wallet || {};
        const linkedSolWallet = (pu.linked_accounts || []).find(a =>
            (a.type === 'wallet' && a.chain_type === 'solana') ||
            a.type === 'solana_wallet'
        ) || {};
        const walletAddress = wallet.address || linkedSolWallet.address || null;

        // Profile picture — server-side Privy doesn't include it, accept from client body
        const profilePicture = twitter.profile_picture_url || linkedTwitter.profile_picture_url
            || req.body?.profile_picture || null;

        const now = Date.now();
        const user = db.upsertUser({
            id: req.privyUserId,
            twitter_handle: twitterHandle,
            twitter_id: twitterId,
            privy_wallet: walletAddress,
            display_name: displayName,
            profile_picture: profilePicture,
            last_seen: now,
        });

        return res.json(success(user));
    } catch (e) {
        console.error('auth/verify error:', e);
        return res.status(500).json(fail('Failed to verify user'));
    }
});

// ---------------------------------------------------------------------------
// GET /profile/me — own full profile
// ---------------------------------------------------------------------------
router.get('/profile/me', authMiddleware, (req, res) => {
    try {
        const user = db.getUser(req.privyUserId);
        if (!user) return res.status(404).json(fail('User not found'));
        return res.json(success(user));
    } catch (e) {
        console.error('profile/me error:', e);
        return res.status(500).json(fail('Failed to fetch profile'));
    }
});

// ---------------------------------------------------------------------------
// GET /profile/:userId — public profile
// ---------------------------------------------------------------------------
router.get('/profile/:userId', (req, res) => {
    try {
        const user = db.getUser(req.params.userId);
        if (!user) return res.status(404).json(fail('User not found'));

        const publicFields = {
            id: user.id,
            twitter_handle: user.twitter_handle,
            display_name: user.display_name,
            wins: user.wins,
            losses: user.losses,
            draws: user.draws,
            total_earned: user.total_earned,
            elo: user.elo,
            funding_wallet: user.funding_wallet,
            created_at: user.created_at,
        };

        return res.json(success(publicFields));
    } catch (e) {
        console.error('profile/:userId error:', e);
        return res.status(500).json(fail('Failed to fetch profile'));
    }
});

// ---------------------------------------------------------------------------
// POST /matches — create wager match
// ---------------------------------------------------------------------------
router.post('/matches', authMiddleware, async (req, res) => {
    try {
        const { stakeAmount, stakeToken, killTarget, password, matchMode } = req.body || {};

        if (!Number.isInteger(stakeAmount) || stakeAmount <= 0) {
            return res.status(400).json(fail('stakeAmount must be a positive integer in base units'));
        }
        if (!VALID_TOKENS.includes(stakeToken)) {
            return res.status(400).json(fail(`stakeToken must be one of: ${VALID_TOKENS.join(', ')}`));
        }
        if (stakeAmount < MIN_STAKE[stakeToken]) {
            const human = stakeToken === 'SOL' ? (MIN_STAKE[stakeToken] / 1e9) : (MIN_STAKE[stakeToken] / 1e6);
            return res.status(400).json(fail(`Minimum stake is ${human} ${stakeToken}`));
        }
        if (stakeAmount > MAX_STAKE[stakeToken]) {
            const human = stakeToken === 'SOL' ? (MAX_STAKE[stakeToken] / 1e9) : (MAX_STAKE[stakeToken] / 1e6);
            return res.status(400).json(fail(`Maximum stake is ${human} ${stakeToken}`));
        }
        if (!VALID_KILL_TARGETS.includes(killTarget)) {
            return res.status(400).json(fail(`killTarget must be one of: ${VALID_KILL_TARGETS.join(', ')}`));
        }

        // Limit open matches per user
        const openCount = db.db.prepare("SELECT COUNT(*) as cnt FROM matches WHERE creator_id = ? AND status IN ('open', 'matched', 'funded_creator', 'funded_joiner')").get(req.privyUserId)?.cnt || 0;
        if (openCount >= 5) {
            return res.status(429).json(fail('Maximum 5 open matches. Cancel existing matches first.'));
        }
        const mode = matchMode || 'open';
        if (!['open', 'selective'].includes(mode)) {
            return res.status(400).json(fail('matchMode must be "open" or "selective"'));
        }

        // Balance check — creator must have enough to cover their stake
        const balCheck = await checkBalance(req.privyUserId, stakeAmount, stakeToken);
        if (!balCheck.ok) return res.status(400).json(fail(balCheck.error));

        let passwordHash = null;
        if (password) {
            passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        }

        const match = db.createMatch({
            id: uuidv4(),
            creator_id: req.privyUserId,
            stake_amount: stakeAmount,
            stake_token: stakeToken,
            kill_target: killTarget,
            password_hash: passwordHash,
            match_mode: mode,
            status: 'open',
            created_at: Date.now(),
        });

        return res.status(201).json(success(match));
    } catch (e) {
        console.error('POST /matches error:', e);
        return res.status(500).json(fail('Failed to create match'));
    }
});

// ---------------------------------------------------------------------------
// GET /matches — list open matches
// ---------------------------------------------------------------------------
router.get('/matches', (req, res) => {
    try {
        const token = req.query.token || null;
        const minStake = req.query.minStake ? Number(req.query.minStake) : null;
        const maxStake = req.query.maxStake ? Number(req.query.maxStake) : null;
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

        const matches = db.listOpenMatches({ token, minStake, maxStake, limit, offset });

        // Strip password_hash, add passwordProtected boolean + creator info
        const sanitized = matches.map((m) => {
            const { password_hash, ...rest } = m;
            const creator = db.getUser(m.creator_id);
            return {
                ...rest,
                passwordProtected: !!password_hash,
                creator_twitter: creator?.twitter_handle || null,
                creator_pfp: creator?.profile_picture || null,
                creator_wins: creator?.wins || 0,
                creator_losses: creator?.losses || 0,
                creator_elo: creator?.elo || 1000,
            };
        });

        return res.json(success(sanitized));
    } catch (e) {
        console.error('GET /matches error:', e);
        return res.status(500).json(fail('Failed to fetch matches'));
    }
});

// ---------------------------------------------------------------------------
// GET /matches/:id — match details
// ---------------------------------------------------------------------------
router.get('/matches/:id', (req, res) => {
    try {
        const match = db.getMatch(req.params.id);
        if (!match) return res.status(404).json(fail('Match not found'));

        const { password_hash, ...rest } = match;
        const creator = db.getUser(match.creator_id);
        const joiner = match.joiner_id ? db.getUser(match.joiner_id) : null;
        return res.json(success({
            ...rest,
            passwordProtected: !!password_hash,
            creator_twitter: creator?.twitter_handle || null,
            creator_pfp: creator?.profile_picture || null,
            creator_wins: creator?.wins || 0,
            creator_losses: creator?.losses || 0,
            creator_elo: creator?.elo || 1000,
            joiner_twitter: joiner?.twitter_handle || null,
            joiner_pfp: joiner?.profile_picture || null,
            joiner_wins: joiner?.wins || 0,
            joiner_losses: joiner?.losses || 0,
            joiner_elo: joiner?.elo || 1000,
        }));
    } catch (e) {
        console.error('GET /matches/:id error:', e);
        return res.status(500).json(fail('Failed to fetch match'));
    }
});

// ---------------------------------------------------------------------------
// POST /matches/:id/join — join a match
// ---------------------------------------------------------------------------
router.post('/matches/:id/join', authMiddleware, async (req, res) => {
    try {
        const match = db.getMatch(req.params.id);
        if (!match) return res.status(404).json(fail('Match not found'));

        if (match.status !== 'open' && match.status !== 'funded_creator') {
            return res.status(400).json(fail('Match is not available to join'));
        }

        if (match.match_mode === 'selective') {
            return res.status(400).json(fail('This is a selective duel. Submit a challenge request instead.'));
        }

        // Balance check
        const balCheck = await checkBalance(req.privyUserId, match.stake_amount, match.stake_token);
        if (!balCheck.ok) return res.status(400).json(fail(balCheck.error));

        if (match.creator_id === req.privyUserId) {
            return res.status(400).json(fail('Cannot join your own match'));
        }

        if (match.joiner_id) {
            return res.status(400).json(fail('Match already has a joiner'));
        }

        // Password check
        if (match.password_hash) {
            const { password } = req.body || {};
            if (!password) {
                return res.status(403).json(fail('This match requires a password'));
            }
            const valid = await bcrypt.compare(password, match.password_hash);
            if (!valid) {
                return res.status(403).json(fail('Incorrect password'));
            }
        }

        const updated = db.joinMatch(req.params.id, req.privyUserId);
        // Move to 'matched' — both players are now connected
        db.updateMatch(req.params.id, { status: 'matched' });
        const refreshed = db.getMatch(req.params.id);
        const { password_hash: pw, ...rest } = refreshed;
        return res.json(success({ ...rest, passwordProtected: !!pw }));
    } catch (e) {
        console.error('POST /matches/:id/join error:', e);
        return res.status(500).json(fail('Failed to join match'));
    }
});

// ---------------------------------------------------------------------------
// POST /matches/:id/cancel — cancel a match (creator only)
// ---------------------------------------------------------------------------
router.post('/matches/:id/cancel', authMiddleware, async (req, res) => {
    try {
        const match = db.getMatch(req.params.id);
        if (!match) return res.status(404).json(fail('Match not found'));

        // Either player can cancel before match starts
        const userId = req.privyUserId;
        if (userId !== match.creator_id && userId !== match.joiner_id) {
            return res.status(403).json(fail('Not in this match'));
        }

        const cancellable = ['open', 'matched', 'funded_creator', 'funded_joiner'];
        if (!cancellable.includes(match.status)) {
            return res.status(400).json(fail('Match cannot be cancelled in its current state'));
        }

        // Refund if creator deposited
        if (match.status === 'funded_creator') {
            const creator = db.getUser(match.creator_id);
            const token = req.headers.authorization?.replace('Bearer ', '') || '';
            const isDevToken = ALLOW_DEV_TOKENS && token.startsWith('dev:');

            if (!isDevToken && creator?.privy_wallet && escrow.isReady()) {
                try {
                    const result = await escrow.sendPayout(creator.privy_wallet, match.stake_amount, match.stake_token);
                    if (result?.signature) {
                        const { v4: uuidv4 } = require('uuid');
                        db.createTransaction({
                            id: uuidv4(), match_id: match.id, user_id: match.creator_id,
                            tx_type: 'refund', amount: match.stake_amount, token: match.stake_token,
                            tx_signature: result.signature, from_wallet: 'escrow', to_wallet: creator.privy_wallet
                        });
                    }
                } catch (e) {
                    console.error('[CANCEL] Refund error:', e);
                }
            }
        }

        db.updateMatch(req.params.id, { status: 'cancelled' });
        db.expireChallengeRequests(req.params.id);
        cleanupPendingLockIn(req.params.id);
        return res.json(success({ cancelled: true }));
    } catch (e) {
        console.error('POST /matches/:id/cancel error:', e);
        return res.status(500).json(fail('Failed to cancel match'));
    }
});

// ---------------------------------------------------------------------------
// POST /matches/:id/challenge — submit a challenge request (selective mode)
// ---------------------------------------------------------------------------
router.post('/matches/:id/challenge', authMiddleware, async (req, res) => {
    try {
        const match = db.getMatch(req.params.id);
        if (!match) return res.status(404).json(fail('Match not found'));

        if (match.match_mode !== 'selective') {
            return res.status(400).json(fail('This match is open. Use join instead.'));
        }
        if (match.status !== 'open' && match.status !== 'funded_creator') {
            return res.status(400).json(fail('Match is not available for challenges'));
        }
        // Balance check
        const balCheck = await checkBalance(req.privyUserId, match.stake_amount, match.stake_token);
        if (!balCheck.ok) return res.status(400).json(fail(balCheck.error));

        if (match.creator_id === req.privyUserId) {
            return res.status(400).json(fail('Cannot challenge your own match'));
        }
        if (match.joiner_id) {
            return res.status(400).json(fail('Match already has an opponent'));
        }

        const existing = db.getMyPendingChallenge(req.params.id, req.privyUserId);
        if (existing) {
            return res.status(400).json(fail('You already have a pending challenge for this match'));
        }

        // Cooldown: if creator declined this challenger 2+ times in 30 min, block for 60 min
        const declineCount = db.getRecentDeclineCount(match.creator_id, req.privyUserId, 30 * 60 * 1000);
        if (declineCount >= 2) {
            return res.status(429).json(fail('This player has declined your challenges. You can challenge them again in 60 minutes.'));
        }

        const challenge = db.createChallengeRequest({
            id: uuidv4(),
            match_id: req.params.id,
            challenger_id: req.privyUserId,
        });

        return res.status(201).json(success(challenge));
    } catch (e) {
        console.error('POST /matches/:id/challenge error:', e);
        return res.status(500).json(fail('Failed to submit challenge'));
    }
});

// ---------------------------------------------------------------------------
// GET /matches/:id/challenges — list pending challenge requests (creator only)
// ---------------------------------------------------------------------------
router.get('/matches/:id/challenges', authMiddleware, (req, res) => {
    try {
        const match = db.getMatch(req.params.id);
        if (!match) return res.status(404).json(fail('Match not found'));

        if (match.creator_id !== req.privyUserId) {
            return res.status(403).json(fail('Only the match creator can view challenges'));
        }

        const challenges = db.getChallengeRequests(req.params.id);
        return res.json(success(challenges));
    } catch (e) {
        console.error('GET /matches/:id/challenges error:', e);
        return res.status(500).json(fail('Failed to fetch challenges'));
    }
});

// ---------------------------------------------------------------------------
// POST /matches/:id/challenges/:requestId/accept — accept a challenger
// ---------------------------------------------------------------------------
router.post('/matches/:id/challenges/:requestId/accept', authMiddleware, (req, res) => {
    try {
        const match = db.getMatch(req.params.id);
        if (!match) return res.status(404).json(fail('Match not found'));

        if (match.creator_id !== req.privyUserId) {
            return res.status(403).json(fail('Only the match creator can accept challenges'));
        }
        if (match.status !== 'open' && match.status !== 'funded_creator') {
            return res.status(400).json(fail('Match is no longer available'));
        }
        if (match.joiner_id) {
            return res.status(400).json(fail('Match already has an opponent'));
        }

        const challenge = db.getChallengeRequest(req.params.requestId);
        if (!challenge) return res.status(404).json(fail('Challenge request not found'));
        if (challenge.match_id !== req.params.id) return res.status(400).json(fail('Challenge does not belong to this match'));
        if (challenge.status !== 'pending') return res.status(400).json(fail('Challenge is no longer pending'));

        // Set the challenger as joiner
        const joined = db.joinMatch(req.params.id, challenge.challenger_id);
        if (!joined) return res.status(400).json(fail('Failed to set challenger as opponent'));

        // Move to matched
        db.updateMatch(req.params.id, { status: 'matched' });

        // Mark this request accepted, expire all others
        db.updateChallengeRequest(req.params.requestId, 'accepted');
        db.expireChallengeRequests(req.params.id);

        const refreshed = db.getMatch(req.params.id);
        const { password_hash: pw, ...rest } = refreshed;
        return res.json(success({ ...rest, passwordProtected: !!pw }));
    } catch (e) {
        console.error('POST /matches/:id/challenges/:requestId/accept error:', e);
        return res.status(500).json(fail('Failed to accept challenge'));
    }
});

// ---------------------------------------------------------------------------
// POST /matches/:id/challenges/:requestId/decline — decline a challenger
// ---------------------------------------------------------------------------
router.post('/matches/:id/challenges/:requestId/decline', authMiddleware, (req, res) => {
    try {
        const match = db.getMatch(req.params.id);
        if (!match) return res.status(404).json(fail('Match not found'));

        if (match.creator_id !== req.privyUserId) {
            return res.status(403).json(fail('Only the match creator can decline challenges'));
        }

        const challenge = db.getChallengeRequest(req.params.requestId);
        if (!challenge) return res.status(404).json(fail('Challenge request not found'));
        if (challenge.match_id !== req.params.id) return res.status(400).json(fail('Challenge does not belong to this match'));
        if (challenge.status !== 'pending') return res.status(400).json(fail('Challenge is no longer pending'));

        db.updateChallengeRequest(req.params.requestId, 'declined');
        return res.json(success({ declined: true }));
    } catch (e) {
        console.error('POST /matches/:id/challenges/:requestId/decline error:', e);
        return res.status(500).json(fail('Failed to decline challenge'));
    }
});

// ---------------------------------------------------------------------------
// GET /matches/:id/my-challenge — get the current user's challenge for a match
// ---------------------------------------------------------------------------
router.get('/matches/:id/my-challenge', authMiddleware, (req, res) => {
    try {
        const match = db.getMatch(req.params.id);
        if (!match) return res.status(404).json(fail('Match not found'));

        const challenge = db.getMyChallenge(req.params.id, req.privyUserId);
        if (!challenge) return res.status(404).json(fail('No challenge found'));

        return res.json(success(challenge));
    } catch (e) {
        console.error('GET /matches/:id/my-challenge error:', e);
        return res.status(500).json(fail('Failed to fetch challenge status'));
    }
});

// ---------------------------------------------------------------------------
// GET /leaderboard — top 50 players by wins
// ---------------------------------------------------------------------------
router.get('/leaderboard', (req, res) => {
    try {
        const leaders = db.getLeaderboard(50);
        return res.json(success(leaders));
    } catch (e) {
        console.error('GET /leaderboard error:', e);
        return res.status(500).json(fail('Failed to fetch leaderboard'));
    }
});

// ---------------------------------------------------------------------------
// GET /matches/:id/deposit-tx — get unsigned deposit transaction
// ---------------------------------------------------------------------------
const escrow = require('./escrow');
const { ALLOW_DEV_TOKENS } = require('./auth');

router.get('/matches/:id/deposit-tx', authMiddleware, async (req, res) => {
    try {
        const match = db.getMatch(req.params.id);
        if (!match) return res.status(404).json(fail('Match not found'));

        const userId = req.privyUserId;
        if (userId !== match.creator_id && userId !== match.joiner_id) {
            return res.status(403).json(fail('Not in this match'));
        }

        // Dev mode: return a mock transaction
        const token = req.headers.authorization?.replace('Bearer ', '') || '';
        if (ALLOW_DEV_TOKENS && token.startsWith('dev:')) {
            return res.json(success({ transaction: 'dev-mock-tx', devMode: true }));
        }

        const user = db.getUser(userId);
        if (!user || !user.privy_wallet) return res.status(400).json(fail('No wallet'));
        if (!escrow.isReady()) return res.status(503).json(fail('Escrow not configured'));

        const txData = await escrow.createDepositTransaction(user.privy_wallet, match.stake_amount, match.stake_token);
        if (!txData) return res.status(500).json(fail('Failed to create transaction'));

        return res.json(success({
            transaction: txData.transaction,  // Full serialized tx (base64)
            message: txData.message,          // Message bytes to sign (base64)
        }));
    } catch (e) {
        console.error('GET /matches/:id/deposit-tx error:', e);
        return res.status(500).json(fail('Failed to create deposit transaction'));
    }
});

// ---------------------------------------------------------------------------
// In-memory storage for signed transactions pending both lock-ins
const _pendingLockIns = new Map(); // matchId -> { creator: {tx,sig}, joiner: {tx,sig} }
const _lockInProgress = new Set(); // matchId set to prevent concurrent lock-in races

// POST /matches/:id/lock-in — store signed tx, submit BOTH when both locked
router.post('/matches/:id/lock-in', authMiddleware, async (req, res) => {
    try {
        const match = db.getMatch(req.params.id);
        if (!match) return res.status(404).json(fail('Match not found'));

        const userId = req.privyUserId;
        const isCreator = userId === match.creator_id;
        const isJoiner = userId === match.joiner_id;
        if (!isCreator && !isJoiner) return res.status(403).json(fail('Not in this match'));

        if (_lockInProgress.has(match.id)) return res.status(409).json(fail('Lock-in in progress'));
        _lockInProgress.add(match.id);

        const { transaction, signature } = req.body;
        if (!transaction || !signature) { _lockInProgress.delete(match.id); return res.status(400).json(fail('Missing transaction or signature')); }

        // Balance check before accepting lock-in
        const balCheck = await checkBalance(userId, match.stake_amount, match.stake_token);
        if (!balCheck.ok) {
            _lockInProgress.delete(match.id);
            // Kick them from the match if they're the joiner
            if (isJoiner) {
                db.updateMatch(match.id, { status: 'open' });
                db.db.prepare('UPDATE matches SET joiner_id = NULL WHERE id = ?').run(match.id);
            }
            return res.status(400).json(fail(balCheck.error));
        }

        // Store the signed tx
        if (!_pendingLockIns.has(match.id)) _pendingLockIns.set(match.id, {});
        const pending = _pendingLockIns.get(match.id);
        const role = isCreator ? 'creator' : 'joiner';
        pending[role] = { transaction, signature };

        // Update match status
        const currentStatus = db.getMatch(match.id).status;
        const otherRole = isCreator ? 'joiner' : 'creator';
        const bothLocked = pending[role] && pending[otherRole];

        if (!bothLocked) {
            // Only one locked so far
            if (isCreator) {
                if (['open', 'matched'].includes(currentStatus)) {
                    db.updateMatch(match.id, { status: 'funded_creator', funded_at: Date.now() });
                }
            } else {
                if (['open', 'matched'].includes(currentStatus)) {
                    db.updateMatch(match.id, { status: 'funded_joiner', funded_at: Date.now() });
                } else if (currentStatus === 'funded_creator') {
                    // Will be set to funded_both below after submission
                }
            }
            const newStatus = db.getMatch(match.id).status;
            console.log('[LOCK-IN]', role, 'locked for match', match.id, 'status:', newStatus);
            _lockInProgress.delete(match.id);
            return res.json(success({ status: newStatus, locked: role }));
        }

        // Both locked — submit both transactions to Solana
        console.log('[LOCK-IN] Both locked for match', match.id, '— submitting to Solana...');

        const token = req.headers.authorization?.replace('Bearer ', '') || '';
        const isDevToken = (ALLOW_DEV_TOKENS && token.startsWith('dev:')) || pending.creator.transaction === 'dev-mock' || pending.joiner.transaction === 'dev-mock';

        if (!isDevToken) {
            const { Connection, Transaction, PublicKey } = require('@solana/web3.js');
            const conn = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');

            // Validate blockhashes before submitting
            const creatorTxCheck = Transaction.from(Buffer.from(pending.creator.transaction, 'base64'));
            const joinerTxCheck = Transaction.from(Buffer.from(pending.joiner.transaction, 'base64'));

            const [creatorBhValid, joinerBhValid] = await Promise.all([
                escrow.isBlockhashValid(creatorTxCheck.recentBlockhash),
                escrow.isBlockhashValid(joinerTxCheck.recentBlockhash),
            ]);

            if (!creatorBhValid || !joinerBhValid) {
                _pendingLockIns.delete(match.id);
                _lockInProgress.delete(match.id);
                db.updateMatch(match.id, { status: 'matched' });
                console.log('[LOCK-IN] Blockhash expired for match', match.id, 'creator:', creatorBhValid, 'joiner:', joinerBhValid);
                return res.status(400).json(fail('Transaction expired. Please re-lock.'));
            }

            // Submit creator's tx
            const creatorUser = db.getUser(match.creator_id);
            const creatorTx = Transaction.from(Buffer.from(pending.creator.transaction, 'base64'));
            creatorTx.addSignature(new PublicKey(creatorUser.privy_wallet), Buffer.from(pending.creator.signature, 'base64'));
            const creatorSig = await conn.sendRawTransaction(creatorTx.serialize(), { skipPreflight: false });
            console.log('[LOCK-IN] Creator tx submitted:', creatorSig);

            // Submit joiner's tx
            const joinerUser = db.getUser(match.joiner_id);
            const joinerTx = Transaction.from(Buffer.from(pending.joiner.transaction, 'base64'));
            joinerTx.addSignature(new PublicKey(joinerUser.privy_wallet), Buffer.from(pending.joiner.signature, 'base64'));
            const joinerSig = await conn.sendRawTransaction(joinerTx.serialize(), { skipPreflight: false });
            console.log('[LOCK-IN] Joiner tx submitted:', joinerSig);

            // Wait for both confirmations
            await Promise.all([
                conn.confirmTransaction(creatorSig, 'confirmed'),
                conn.confirmTransaction(joinerSig, 'confirmed'),
            ]);
            console.log('[LOCK-IN] Both confirmed on-chain');

            // Log transactions
            const { v4: uuidv4 } = require('uuid');
            db.createTransaction({ id: uuidv4(), match_id: match.id, user_id: match.creator_id, tx_type: 'deposit', amount: match.stake_amount, token: match.stake_token, tx_signature: creatorSig, from_wallet: creatorUser.privy_wallet, to_wallet: 'escrow' });
            db.createTransaction({ id: uuidv4(), match_id: match.id, user_id: match.joiner_id, tx_type: 'deposit', amount: match.stake_amount, token: match.stake_token, tx_signature: joinerSig, from_wallet: joinerUser.privy_wallet, to_wallet: 'escrow' });
        }

        // Both funded
        db.updateMatch(match.id, { status: 'funded_both', funded_at: Date.now() });
        _pendingLockIns.delete(match.id);
        console.log('[LOCK-IN] Match', match.id, 'fully funded');

        _lockInProgress.delete(match.id);
        return res.json(success({ status: 'funded_both', locked: 'both' }));
    } catch (e) {
        _lockInProgress.delete(req.params.id);
        console.error('POST /matches/:id/lock-in error:', e);
        return res.status(500).json(fail('Lock-in failed: ' + e.message));
    }
});

// Clean up pending lock-ins when matches are cancelled
function cleanupPendingLockIn(matchId) {
    _pendingLockIns.delete(matchId);
}

// POST /matches/:id/submit-signed-tx — LEGACY, kept for compatibility
// ---------------------------------------------------------------------------
router.post('/matches/:id/submit-signed-tx', authMiddleware, async (req, res) => {
    try {
        const match = db.getMatch(req.params.id);
        if (!match) return res.status(404).json(fail('Match not found'));

        const userId = req.privyUserId;
        if (userId !== match.creator_id && userId !== match.joiner_id) {
            return res.status(403).json(fail('Not in this match'));
        }

        const { transaction: txBase64, signature: sigBase64 } = req.body;
        if (!txBase64 || !sigBase64) return res.status(400).json(fail('Missing transaction or signature'));

        if (!escrow.isReady()) return res.status(503).json(fail('Escrow not configured'));

        const { Connection, Transaction, PublicKey } = require('@solana/web3.js');
        const conn = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');

        // Reconstruct the transaction and add the user's signature
        const txBytes = Buffer.from(txBase64, 'base64');
        const transaction = Transaction.from(txBytes);

        const user = db.getUser(userId);
        if (!user?.privy_wallet) return res.status(400).json(fail('No wallet'));

        const userPubkey = new PublicKey(user.privy_wallet);
        const sigBuffer = Buffer.from(sigBase64, 'base64');
        transaction.addSignature(userPubkey, sigBuffer);

        // Submit to Solana
        const rawTx = transaction.serialize();
        const txSignature = await conn.sendRawTransaction(rawTx, { skipPreflight: false });
        console.log('[DEPOSIT] Submitted tx:', txSignature);

        // Wait for confirmation
        await conn.confirmTransaction(txSignature, 'confirmed');
        console.log('[DEPOSIT] Confirmed tx:', txSignature);

        // Now do the confirm-deposit logic
        const isCreator = userId === match.creator_id;
        const { v4: uuidv4 } = require('uuid');
        db.createTransaction({
            id: uuidv4(), match_id: match.id, user_id: userId,
            tx_type: 'deposit', amount: match.stake_amount, token: match.stake_token,
            tx_signature: txSignature, from_wallet: user.privy_wallet, to_wallet: 'escrow'
        });
        db.confirmTransaction(txSignature, Date.now());

        // Update match status
        const currentStatus = db.getMatch(match.id).status;
        if (isCreator) {
            if (currentStatus === 'funded_joiner') {
                db.updateMatch(match.id, { status: 'funded_both', funded_at: Date.now() });
            } else if (['open', 'matched'].includes(currentStatus)) {
                db.updateMatch(match.id, { status: 'funded_creator', funded_at: Date.now() });
            }
        } else {
            if (currentStatus === 'funded_creator') {
                db.updateMatch(match.id, { status: 'funded_both', funded_at: Date.now() });
            } else if (['open', 'matched'].includes(currentStatus)) {
                db.updateMatch(match.id, { status: 'funded_joiner', funded_at: Date.now() });
            }
        }

        return res.json(success({ txSignature, status: db.getMatch(match.id).status }));
    } catch (e) {
        console.error('POST /matches/:id/submit-signed-tx error:', e);
        return res.status(500).json(fail('Transaction submission failed: ' + e.message));
    }
});

// ---------------------------------------------------------------------------
// POST /matches/:id/confirm-deposit — confirm deposit tx signature
// ---------------------------------------------------------------------------
router.post('/matches/:id/confirm-deposit', authMiddleware, async (req, res) => {
    try {
        const match = db.getMatch(req.params.id);
        if (!match) return res.status(404).json(fail('Match not found'));

        const userId = req.privyUserId;
        const isCreator = userId === match.creator_id;
        const isJoiner = userId === match.joiner_id;
        if (!isCreator && !isJoiner) return res.status(403).json(fail('Not in this match'));

        const { txSignature } = req.body;
        if (!txSignature) return res.status(400).json(fail('Missing txSignature'));

        const user = db.getUser(userId);
        const token = req.headers.authorization?.replace('Bearer ', '') || '';
        const isDevToken = ALLOW_DEV_TOKENS && token.startsWith('dev:');
        const skipVerification = isDevToken;

        if (!skipVerification) {
            if (!user || !user.privy_wallet) return res.status(400).json(fail('No wallet'));

            // Verify on-chain
            const result = await escrow.confirmDeposit(txSignature, match.stake_amount, match.stake_token, user.privy_wallet);
            if (!result || !result.confirmed) {
                return res.status(400).json(fail('Deposit not confirmed: ' + (result?.error || 'unknown')));
            }

            // Record funding wallet if first deposit
            if (result.fromWallet && !user.funding_wallet) {
                db.upsertUser({ id: userId, twitter_handle: user.twitter_handle, funding_wallet: result.fromWallet });
            }
        }

        // Log transaction
        const { v4: uuidv4 } = require('uuid');
        db.createTransaction({
            id: uuidv4(), match_id: match.id, user_id: userId,
            tx_type: 'deposit', amount: match.stake_amount, token: match.stake_token,
            tx_signature: txSignature, from_wallet: user.privy_wallet, to_wallet: 'escrow'
        });
        db.confirmTransaction(txSignature, Date.now());

        // Update match status — track who has deposited
        // States: open/matched → funded_creator (creator deposited) or funded_joiner (joiner deposited first)
        //         funded_creator + joiner deposits → funded_both
        //         funded_joiner + creator deposits → funded_both
        const currentStatus = db.getMatch(match.id).status; // Re-read in case of race
        if (isCreator) {
            if (currentStatus === 'funded_joiner') {
                db.updateMatch(match.id, { status: 'funded_both', funded_at: Date.now() });
            } else if (['open', 'matched'].includes(currentStatus)) {
                db.updateMatch(match.id, { status: 'funded_creator', funded_at: Date.now() });
            }
        } else if (isJoiner) {
            if (currentStatus === 'funded_creator') {
                db.updateMatch(match.id, { status: 'funded_both', funded_at: Date.now() });
            } else if (['open', 'matched'].includes(currentStatus)) {
                db.updateMatch(match.id, { status: 'funded_joiner', funded_at: Date.now() });
            }
        }

        return res.json(success({ confirmed: true, status: db.getMatch(match.id).status }));
    } catch (e) {
        console.error('POST /matches/:id/confirm-deposit error:', e);
        return res.status(500).json(fail('Deposit confirmation failed'));
    }
});

// ---------------------------------------------------------------------------
// GET /wallet/balance — user's Privy wallet balance
// ---------------------------------------------------------------------------
router.get('/wallet/balance', authMiddleware, async (req, res) => {
    try {
        const user = db.getUser(req.privyUserId);
        if (!user || !user.privy_wallet) return res.json(success({ sol: 0, usdc: 0 }));
        if (!escrow.isReady()) return res.json(success({ sol: 0, usdc: 0 }));

        const solLamports = await escrow.getBalance(user.privy_wallet, 'SOL');
        const usdcBase = await escrow.getBalance(user.privy_wallet, 'USDC');
        const sol = (solLamports || 0) / 1e9;
        const usdc = (usdcBase || 0) / 1e6;
        return res.json(success({ sol, usdc, solLamports: solLamports || 0, usdcBase: usdcBase || 0 }));
    } catch (e) {
        return res.status(500).json(fail('Balance check failed'));
    }
});

// ---------------------------------------------------------------------------
// POST /wallet/withdraw-tx — create unsigned withdrawal transaction
// ---------------------------------------------------------------------------
router.post('/wallet/withdraw-tx', authMiddleware, async (req, res) => {
    try {
        const { destination, amount, token } = req.body;
        if (!destination || !amount || !token) return res.status(400).json(fail('Missing destination, amount, or token'));
        if (!['SOL', 'USDC'].includes(token)) return res.status(400).json(fail('Token must be SOL or USDC'));
        if (amount <= 0) return res.status(400).json(fail('Amount must be positive'));

        const user = db.getUser(req.privyUserId);
        if (!user?.privy_wallet) return res.status(400).json(fail('No wallet'));

        const { Connection, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
        const conn = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');

        const fromPubkey = new PublicKey(user.privy_wallet);
        let toPubkey;
        try { toPubkey = new PublicKey(destination); } catch(e) {
            return res.status(400).json(fail('Invalid destination address'));
        }

        const tx = new Transaction();
        const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        tx.feePayer = fromPubkey;

        if (token === 'SOL') {
            const lamports = Math.round(amount * LAMPORTS_PER_SOL);
            tx.add(SystemProgram.transfer({ fromPubkey, toPubkey, lamports }));
        } else {
            const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createTransferInstruction } = require('@solana/spl-token');
            const fromAta = await getAssociatedTokenAddress(escrow.USDC_MINT, fromPubkey);
            const toAta = await getAssociatedTokenAddress(escrow.USDC_MINT, toPubkey);
            // Check if destination ATA exists
            try { await require('@solana/spl-token').getAccount(conn, toAta); } catch(e) {
                tx.add(createAssociatedTokenAccountInstruction(fromPubkey, toAta, toPubkey, escrow.USDC_MINT));
            }
            const baseUnits = Math.round(amount * 1e6);
            tx.add(createTransferInstruction(fromAta, toAta, fromPubkey, baseUnits));
        }

        const message = tx.serializeMessage();
        const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });

        return res.json(success({
            transaction: serialized.toString('base64'),
            message: message.toString('base64'),
        }));
    } catch (e) {
        console.error('POST /wallet/withdraw-tx error:', e);
        return res.status(500).json(fail('Failed to create withdrawal transaction'));
    }
});

// ---------------------------------------------------------------------------
// POST /wallet/submit-withdraw — submit signed withdrawal transaction
// ---------------------------------------------------------------------------
router.post('/wallet/submit-withdraw', authMiddleware, async (req, res) => {
    try {
        const { transaction: txBase64, signature: sigBase64 } = req.body;
        if (!txBase64 || !sigBase64) return res.status(400).json(fail('Missing transaction or signature'));

        const { Connection, Transaction, PublicKey } = require('@solana/web3.js');
        const conn = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');

        const user = db.getUser(req.privyUserId);
        if (!user?.privy_wallet) return res.status(400).json(fail('No wallet'));

        const txBytes = Buffer.from(txBase64, 'base64');
        const transaction = Transaction.from(txBytes);
        const userPubkey = new PublicKey(user.privy_wallet);
        const sigBuffer = Buffer.from(sigBase64, 'base64');
        transaction.addSignature(userPubkey, sigBuffer);

        const rawTx = transaction.serialize();
        const txSignature = await conn.sendRawTransaction(rawTx, { skipPreflight: false });
        await conn.confirmTransaction(txSignature, 'confirmed');

        return res.json(success({ txSignature }));
    } catch (e) {
        console.error('POST /wallet/submit-withdraw error:', e);
        return res.status(500).json(fail('Withdrawal failed: ' + e.message));
    }
});

// === LOCK-IN EXPIRY — every 60 seconds ===
setInterval(() => {
    try {
        const stale = db.getStaleFundedMatches(Date.now() - 10 * 60 * 1000);
        for (const match of stale) {
            db.updateMatch(match.id, { status: 'cancelled' });
            db.expireChallengeRequests(match.id);
            _pendingLockIns.delete(match.id);
            console.log('[CLEANUP] Lock-in expired for match ' + match.id);
        }
    } catch (e) {
        console.error('[CLEANUP] Lock-in expiry error:', e.message);
    }
}, 60 * 1000);

module.exports = router;
