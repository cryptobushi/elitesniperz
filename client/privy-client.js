/**
 * privy-client.js — Privy auth module for sniperz wager system
 *
 * Mock implementation for dev/testing. Provides login via Twitter handle prompt,
 * generates mock Privy user IDs and Solana wallets, and registers with the server.
 *
 * PRODUCTION REPLACEMENT:
 * -----------------------------------------------------------------------
 * To swap in the real Privy SDK:
 *
 * 1. Add to index.html:
 *    <script src="https://cdn.privy.io/js-sdk-core@latest"></script>
 *
 * 2. Replace initPrivy() with:
 *    import { PrivyClient } from '@privy-io/js-sdk-core';
 *    const privyClient = new PrivyClient({ appId });
 *
 * 3. Replace login() with:
 *    const { user, token } = await privyClient.login({ loginMethods: ['twitter'] });
 *    Store token, extract user.twitter and user.wallet.address.
 *
 * 4. Replace getToken() to return privyClient.getAccessToken().
 *
 * 5. Replace getWalletAddress() to return privyClient.user.wallet.address.
 * -----------------------------------------------------------------------
 */

const SESSION_KEY = 'sniperz_auth';

let _appId = null;
let _user = null;
let _token = null;
let _listeners = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a deterministic mock Privy user ID from a twitter handle. */
function mockPrivyUserId(handle) {
    let hash = 0;
    for (let i = 0; i < handle.length; i++) {
        hash = ((hash << 5) - hash + handle.charCodeAt(i)) | 0;
    }
    const hex = Math.abs(hash).toString(16).padStart(8, '0');
    return `did:privy:mock-${hex}`;
}

/** Generate a deterministic mock Solana wallet address from a handle. */
function mockSolanaWallet(handle) {
    // Base58 alphabet
    const b58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let seed = 0;
    for (let i = 0; i < handle.length; i++) {
        seed = ((seed << 7) - seed + handle.charCodeAt(i)) | 0;
    }
    let addr = '';
    let s = Math.abs(seed);
    for (let i = 0; i < 44; i++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        addr += b58[s % 58];
    }
    return addr;
}

function _saveSession() {
    if (_token && _user) {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token: _token, user: _user }));
    } else {
        sessionStorage.removeItem(SESSION_KEY);
    }
}

function _loadSession() {
    try {
        const raw = sessionStorage.getItem(SESSION_KEY);
        if (!raw) return false;
        const data = JSON.parse(raw);
        if (data.token && data.user) {
            _token = data.token;
            _user = data.user;
            return true;
        }
    } catch { /* ignore */ }
    return false;
}

function _notifyListeners() {
    const authed = isAuthenticated();
    for (const cb of _listeners) {
        try { cb(authed, _user); } catch (e) { console.error('Auth listener error:', e); }
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the Privy client. Restores session from sessionStorage if present.
 * @param {string} appId — Privy app ID (stored for future real SDK use)
 * @returns {{ authenticated: boolean, user: object|null }}
 */
export function initPrivy(appId) {
    _appId = appId;
    const restored = _loadSession();
    if (restored) {
        // Fire listeners async so callers can register after init
        setTimeout(() => _notifyListeners(), 0);
    }
    return { authenticated: restored, user: _user };
}

/**
 * Log in via Twitter. In dev mode, prompts for a handle and registers with the server.
 * @returns {Promise<{ success: boolean, user?: object, error?: string }>}
 */
export async function login() {
    // Prompt for twitter handle
    const handle = prompt('Enter your Twitter/X handle (without @):');
    if (!handle || !handle.trim()) {
        return { success: false, error: 'Login cancelled' };
    }

    const cleanHandle = handle.trim().replace(/^@/, '');
    const userId = mockPrivyUserId(cleanHandle);
    const wallet = mockSolanaWallet(cleanHandle);

    // Generate a dev mock token matching server's parseMockToken format:
    // "dev:<userId>:<twitterHandle>:<wallet>"
    const mockToken = `dev:${userId}:${cleanHandle}:${wallet}`;

    try {
        const res = await fetch('/api/auth/verify', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${mockToken}`,
            },
        });

        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            return { success: false, error: body.error || `Server returned ${res.status}` };
        }

        const body = await res.json();
        if (!body.success) {
            return { success: false, error: body.error || 'Verification failed' };
        }

        _token = mockToken;
        _user = body.data;
        _saveSession();
        _notifyListeners();

        return { success: true, user: _user };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

/**
 * Log out — clears session and notifies listeners.
 */
export function logout() {
    _token = null;
    _user = null;
    sessionStorage.removeItem(SESSION_KEY);
    _notifyListeners();
}

/**
 * Get the current auth token for API calls.
 * @returns {string|null}
 */
export function getToken() {
    return _token;
}

/**
 * Get the cached user profile.
 * @returns {object|null} — { id, twitter_handle, privy_wallet, wins, losses, elo, ... }
 */
export function getUser() {
    return _user;
}

/**
 * Check if the user is authenticated.
 * @returns {boolean}
 */
export function isAuthenticated() {
    return !!_token && !!_user;
}

/**
 * Get the user's Privy-managed Solana wallet address.
 * @returns {string|null}
 */
export function getWalletAddress() {
    return _user?.privy_wallet || null;
}

/**
 * Register a callback for auth state changes.
 * Callback receives (isAuthenticated: boolean, user: object|null).
 * @param {function} callback
 * @returns {function} unsubscribe function
 */
export function onAuthChange(callback) {
    _listeners.push(callback);
    return () => {
        _listeners = _listeners.filter(cb => cb !== callback);
    };
}

/**
 * Refresh the user profile from the server.
 * Useful after a match completes to get updated wins/losses/elo.
 * @returns {Promise<object|null>}
 */
export async function refreshProfile() {
    if (!_token) return null;
    try {
        const res = await fetch('/api/profile/me', {
            headers: { 'Authorization': `Bearer ${_token}` },
        });
        if (!res.ok) return null;
        const body = await res.json();
        if (body.success && body.data) {
            _user = body.data;
            _saveSession();
            return _user;
        }
    } catch { /* ignore */ }
    return null;
}
