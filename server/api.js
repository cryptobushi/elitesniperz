'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { authMiddleware } = require('./auth');
const db = require('../db/index');

const router = express.Router();

const VALID_TOKENS = ['SOL', 'USDC'];
const VALID_KILL_TARGETS = [5, 7, 10];
const BCRYPT_ROUNDS = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function success(data) {
    return { success: true, data };
}

function fail(msg) {
    return { success: false, error: msg };
}

// ---------------------------------------------------------------------------
// POST /auth/verify — verify Privy token, upsert user, return profile
// ---------------------------------------------------------------------------
router.post('/auth/verify', authMiddleware, (req, res) => {
    try {
        const twitter = req.privyUser.twitter || {};
        const wallet = req.privyUser.wallet || {};

        const now = Date.now();
        const user = db.upsertUser({
            id: req.privyUserId,
            twitter_handle: twitter.username || twitter.handle || 'unknown',
            twitter_id: twitter.subject || twitter.id || null,
            privy_wallet: wallet.address || null,
            display_name: twitter.name || twitter.username || null,
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
        const { stakeAmount, stakeToken, killTarget, password } = req.body || {};

        if (!stakeAmount || stakeAmount <= 0) {
            return res.status(400).json(fail('stakeAmount must be greater than 0'));
        }
        if (!VALID_TOKENS.includes(stakeToken)) {
            return res.status(400).json(fail(`stakeToken must be one of: ${VALID_TOKENS.join(', ')}`));
        }
        if (!VALID_KILL_TARGETS.includes(killTarget)) {
            return res.status(400).json(fail(`killTarget must be one of: ${VALID_KILL_TARGETS.join(', ')}`));
        }

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
        return res.json(success({ ...rest, passwordProtected: !!password_hash }));
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
        const { password_hash, ...rest } = updated;
        return res.json(success({ ...rest, passwordProtected: !!password_hash }));
    } catch (e) {
        console.error('POST /matches/:id/join error:', e);
        return res.status(500).json(fail('Failed to join match'));
    }
});

// ---------------------------------------------------------------------------
// POST /matches/:id/cancel — cancel a match (creator only)
// ---------------------------------------------------------------------------
router.post('/matches/:id/cancel', authMiddleware, (req, res) => {
    try {
        const match = db.getMatch(req.params.id);
        if (!match) return res.status(404).json(fail('Match not found'));

        if (match.creator_id !== req.privyUserId) {
            return res.status(403).json(fail('Only the creator can cancel'));
        }

        const cancellable = ['open', 'funded_creator'];
        if (!cancellable.includes(match.status)) {
            return res.status(400).json(fail('Match cannot be cancelled in its current state'));
        }

        // Can't cancel if joiner already joined (and match is funded_creator)
        if (match.status === 'funded_creator' && match.joiner_id) {
            return res.status(400).json(fail('Cannot cancel after opponent has joined'));
        }

        const updated = db.updateMatch(req.params.id, { status: 'cancelled' });
        return res.json(success(updated));
    } catch (e) {
        console.error('POST /matches/:id/cancel error:', e);
        return res.status(500).json(fail('Failed to cancel match'));
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

router.get('/matches/:id/deposit-tx', authMiddleware, async (req, res) => {
    try {
        const match = db.getMatch(req.params.id);
        if (!match) return res.status(404).json(fail('Match not found'));

        const userId = req.privyUserId;
        if (userId !== match.creator_id && userId !== match.joiner_id) {
            return res.status(403).json(fail('Not in this match'));
        }

        const user = db.getUser(userId);
        if (!user || !user.privy_wallet) return res.status(400).json(fail('No wallet'));
        if (!escrow.isReady()) return res.status(503).json(fail('Escrow not configured'));

        const tx = await escrow.createDepositTransaction(user.privy_wallet, match.stake_amount, match.stake_token);
        if (!tx) return res.status(500).json(fail('Failed to create transaction'));

        return res.json(success({ transaction: tx }));
    } catch (e) {
        console.error('GET /matches/:id/deposit-tx error:', e);
        return res.status(500).json(fail('Failed to create deposit transaction'));
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

        // Log transaction
        const { v4: uuidv4 } = require('uuid');
        db.createTransaction({
            id: uuidv4(), match_id: match.id, user_id: userId,
            tx_type: 'deposit', amount: match.stake_amount, token: match.stake_token,
            tx_signature: txSignature, from_wallet: user.privy_wallet, to_wallet: 'escrow'
        });
        db.confirmTransaction(txSignature, Date.now());

        // Update match status
        if (isCreator && (match.status === 'open' || match.status === 'open')) {
            db.updateMatch(match.id, { status: match.joiner_id ? 'funded_both' : 'funded_creator', funded_at: Date.now() });
        } else if (isJoiner) {
            db.updateMatch(match.id, { status: 'funded_both', funded_at: Date.now() });
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

        const sol = await escrow.getBalance(user.privy_wallet, 'SOL');
        const usdc = await escrow.getBalance(user.privy_wallet, 'USDC');
        return res.json(success({ sol: sol || 0, usdc: usdc || 0 }));
    } catch (e) {
        return res.status(500).json(fail('Balance check failed'));
    }
});

module.exports = router;
