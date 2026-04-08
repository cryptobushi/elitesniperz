'use strict';

const PRIVY_APP_ID = process.env.PRIVY_APP_ID || '';
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET || '';
const DEV_MODE = !PRIVY_APP_ID || PRIVY_APP_ID === 'your-privy-app-id';

let privy = null;
if (!DEV_MODE) {
    const { PrivyClient } = require('@privy-io/server-auth');
    privy = new PrivyClient(PRIVY_APP_ID, PRIVY_APP_SECRET);
}

if (DEV_MODE) console.log('[AUTH] Dev mode — mock tokens accepted (set PRIVY_APP_ID for production)');

/**
 * Parse dev mock token: "dev:<userId>:<twitterHandle>:<wallet>"
 */
function parseMockToken(token) {
    if (!token.startsWith('dev:')) return null;
    const parts = token.split(':');
    if (parts.length < 4) return null;
    return {
        userId: parts[1],
        user: {
            id: parts[1],
            twitter: { username: parts[2], subject: parts[2] },
            wallet: { address: parts[3] },
        }
    };
}

/**
 * Express middleware — verifies Privy auth token (or mock in dev mode).
 */
async function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Missing authorization token' });
    }

    const token = authHeader.replace('Bearer ', '');

    // Dev mode: accept mock tokens
    if (DEV_MODE) {
        const mock = parseMockToken(token);
        if (mock) {
            req.privyUserId = mock.userId;
            req.privyUser = mock.user;
            return next();
        }
        return res.status(401).json({ success: false, error: 'Invalid dev token (use dev:userId:twitter:wallet)' });
    }

    // Production: verify with Privy
    try {
        const claims = await privy.verifyAuthToken(token);
        const user = await privy.getUser(claims.userId);
        req.privyUserId = claims.userId;
        req.privyUser = user;
        next();
    } catch (e) {
        return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
}

/**
 * Verify a token for WebSocket connections.
 * Returns {userId, user} on success, null on failure.
 */
async function verifyWsToken(token) {
    // Dev mode
    if (DEV_MODE) {
        const mock = parseMockToken(token);
        return mock || null;
    }

    // Production
    try {
        const claims = await privy.verifyAuthToken(token);
        const user = await privy.getUser(claims.userId);
        return { userId: claims.userId, user };
    } catch (e) {
        return null;
    }
}

module.exports = { privy, authMiddleware, verifyWsToken, DEV_MODE };
