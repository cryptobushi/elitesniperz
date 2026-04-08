'use strict';

const { PrivyClient } = require('@privy-io/server-auth');

const PRIVY_APP_ID = process.env.PRIVY_APP_ID || 'your-privy-app-id';
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET || 'your-privy-app-secret';

const privy = new PrivyClient(PRIVY_APP_ID, PRIVY_APP_SECRET);

/**
 * Express middleware — verifies Privy auth token, attaches user to request.
 */
async function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Missing authorization token' });
    }

    const token = authHeader.replace('Bearer ', '');
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
 * Verify a Privy token for WebSocket connections.
 * Returns {userId, user} on success, null on failure.
 */
async function verifyWsToken(token) {
    try {
        const claims = await privy.verifyAuthToken(token);
        const user = await privy.getUser(claims.userId);
        return { userId: claims.userId, user };
    } catch (e) {
        return null;
    }
}

module.exports = { privy, authMiddleware, verifyWsToken };
