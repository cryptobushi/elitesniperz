/**
 * privy-client.js — Privy auth via js-sdk-core for sniperz wager system
 * Uses OAuth redirect flow for Twitter login + embedded Solana wallet
 */

const SESSION_KEY = 'sniperz_auth';
let _appId = null;
let _user = null;
let _token = null;
let _listeners = [];
let _privyClient = null;
let _initPromise = null;

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

/**
 * Initialize the Privy client.
 */
export function initPrivy(appId) {
    _appId = appId;
    const restored = _loadSession();
    if (restored) {
        setTimeout(() => _notifyListeners(), 0);
    }

    // Dynamically import and initialize Privy SDK
    _initPromise = _initPrivySDK(appId);

    return { authenticated: restored, user: _user };
}

async function _initPrivySDK(appId) {
    // Real Privy SDK requires a bundler (vite/esbuild) to resolve node_modules.
    // For now, we use the dev login modal. When bundled, uncomment below:
    // try {
    //     const { PrivyClient } = await import('@privy-io/js-sdk-core');
    //     _privyClient = new PrivyClient({ appId });
    //     console.log('[Privy] SDK initialized');
    // } catch (e) {
    //     console.warn('[Privy] SDK not available:', e.message);
    // }
}

/**
 * Log in via Twitter/X. Shows a login modal.
 */
export async function login() {
    // Try real Privy SDK first
    if (_initPromise) await _initPromise;

    if (_privyClient) {
        try {
            return await _loginWithPrivy();
        } catch (e) {
            console.warn('[Privy] Real login failed:', e.message, '— falling back to dev');
        }
    }

    // Dev fallback: show custom login modal
    return _devLogin();
}

async function _loginWithPrivy() {
    // Generate OAuth URL for Twitter
    const redirectUrl = window.location.origin + '/auth/callback';
    const oauthData = await _privyClient.auth.oauth.generateURL('twitter', redirectUrl);

    // Open in popup
    const popup = window.open(oauthData.url, 'privy_login', 'width=500,height=700,left=200,top=100');

    // Wait for callback
    return new Promise((resolve, reject) => {
        const interval = setInterval(() => {
            try {
                if (popup.closed) {
                    clearInterval(interval);
                    // Check if session was set by callback page
                    if (_loadSession()) {
                        _notifyListeners();
                        resolve({ success: true, user: _user });
                    } else {
                        resolve({ success: false, error: 'Login cancelled' });
                    }
                }
                // Check if popup redirected to our callback
                if (popup.location.href.includes('/auth/callback')) {
                    const url = new URL(popup.location.href);
                    popup.close();
                    clearInterval(interval);
                    // Handle callback
                    _handleOAuthCallback(url.searchParams).then(result => {
                        resolve(result);
                    });
                }
            } catch (e) {
                // Cross-origin — popup still on Twitter, keep waiting
            }
        }, 500);

        // Timeout after 2 minutes
        setTimeout(() => {
            clearInterval(interval);
            try { popup.close(); } catch(e) {}
            resolve({ success: false, error: 'Login timed out' });
        }, 120000);
    });
}

async function _handleOAuthCallback(params) {
    try {
        const session = await _privyClient.auth.oauth.handleCallback();
        if (session && session.user) {
            const accessToken = await _privyClient.getAccessToken();
            _token = accessToken;

            // Register with our server
            const res = await fetch('/api/auth/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken }
            });
            const body = await res.json();
            if (body.success) {
                _user = body.data;
                _saveSession();
                _notifyListeners();
                return { success: true, user: _user };
            }
        }
        return { success: false, error: 'OAuth callback failed' };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

/**
 * Dev mode login — shows a styled modal instead of prompt()
 */
function _devLogin() {
    return new Promise((resolve) => {
        // Create modal
        const overlay = document.createElement('div');
        overlay.id = 'authOverlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:20000;display:flex;align-items:center;justify-content:center;font-family:"Courier New",monospace;';

        overlay.innerHTML = `
            <div style="background:#0a0a1a;border:2px solid #333;border-radius:8px;padding:2rem;width:min(90%,380px);text-align:center;">
                <div style="font-size:1.3rem;font-weight:bold;color:#ffcc00;margin-bottom:0.5rem;">SIGN IN</div>
                <div style="color:#888;font-size:0.75rem;margin-bottom:1.5rem;">Connect to play wager matches</div>

                <button id="authTwitterBtn" style="width:100%;padding:12px;background:#1DA1F2;border:none;border-radius:6px;color:#fff;font-family:inherit;font-size:0.9rem;font-weight:bold;cursor:pointer;margin-bottom:0.75rem;display:flex;align-items:center;justify-content:center;gap:8px;">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                    Sign in with X
                </button>

                <div style="color:#444;font-size:0.65rem;margin:1rem 0;">— or dev mode —</div>

                <input id="authHandleInput" type="text" placeholder="Enter Twitter/X handle"
                    style="width:100%;padding:10px;background:#111;border:1px solid #333;border-radius:4px;color:#fff;font-family:inherit;font-size:0.85rem;text-align:center;box-sizing:border-box;margin-bottom:0.75rem;" />

                <button id="authDevBtn" style="width:100%;padding:10px;background:#222;border:1px solid #444;border-radius:4px;color:#aaa;font-family:inherit;font-size:0.8rem;cursor:pointer;">
                    Dev Login
                </button>

                <button id="authCancelBtn" style="width:100%;padding:8px;background:none;border:none;color:#666;font-family:inherit;font-size:0.75rem;cursor:pointer;margin-top:0.5rem;">
                    Cancel
                </button>
            </div>
        `;

        document.body.appendChild(overlay);

        const cleanup = () => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); };

        // X/Twitter button — try real Privy, fall back to dev
        document.getElementById('authTwitterBtn').addEventListener('click', async () => {
            if (_privyClient) {
                cleanup();
                try {
                    const result = await _loginWithPrivy();
                    resolve(result);
                } catch (e) {
                    resolve({ success: false, error: e.message });
                }
                return;
            }
            // No SDK — use the handle input as dev login
            const handle = document.getElementById('authHandleInput').value.trim().replace(/^@/, '');
            if (!handle) {
                document.getElementById('authHandleInput').style.borderColor = '#ff4444';
                return;
            }
            cleanup();
            resolve(await _doDevLogin(handle));
        });

        // Dev login button
        document.getElementById('authDevBtn').addEventListener('click', async () => {
            const handle = document.getElementById('authHandleInput').value.trim().replace(/^@/, '');
            if (!handle) {
                document.getElementById('authHandleInput').style.borderColor = '#ff4444';
                return;
            }
            cleanup();
            resolve(await _doDevLogin(handle));
        });

        // Enter key on input
        document.getElementById('authHandleInput').addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                const handle = document.getElementById('authHandleInput').value.trim().replace(/^@/, '');
                if (!handle) return;
                cleanup();
                resolve(await _doDevLogin(handle));
            }
        });

        // Cancel
        document.getElementById('authCancelBtn').addEventListener('click', () => {
            cleanup();
            resolve({ success: false, error: 'Login cancelled' });
        });

        // Focus input
        setTimeout(() => document.getElementById('authHandleInput')?.focus(), 100);
    });
}

async function _doDevLogin(handle) {
    const userId = _mockUserId(handle);
    const wallet = _mockWallet(handle);
    const mockToken = `dev:${userId}:${handle}:${wallet}`;

    try {
        const res = await fetch('/api/auth/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${mockToken}` }
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            return { success: false, error: body.error || `Server ${res.status}` };
        }
        const body = await res.json();
        if (!body.success) return { success: false, error: body.error };

        _token = mockToken;
        _user = body.data;
        _saveSession();
        _notifyListeners();
        return { success: true, user: _user };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

function _mockUserId(handle) {
    let hash = 0;
    for (let i = 0; i < handle.length; i++) hash = ((hash << 5) - hash + handle.charCodeAt(i)) | 0;
    return `did:privy:mock-${Math.abs(hash).toString(16).padStart(8, '0')}`;
}

function _mockWallet(handle) {
    const b58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let s = 0;
    for (let i = 0; i < handle.length; i++) s = ((s << 7) - s + handle.charCodeAt(i)) | 0;
    s = Math.abs(s);
    let addr = '';
    for (let i = 0; i < 44; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; addr += b58[s % 58]; }
    return addr;
}

export function logout() {
    _token = null;
    _user = null;
    sessionStorage.removeItem(SESSION_KEY);
    _notifyListeners();
}

export function getToken() { return _token; }
export function getUser() { return _user; }
export function isAuthenticated() { return !!_token && !!_user; }
export function getWalletAddress() { return _user?.privy_wallet || null; }

export function onAuthChange(callback) {
    _listeners.push(callback);
    return () => { _listeners = _listeners.filter(cb => cb !== callback); };
}

export async function refreshProfile() {
    if (!_token) return null;
    try {
        const res = await fetch('/api/profile/me', { headers: { 'Authorization': `Bearer ${_token}` } });
        if (!res.ok) return null;
        const body = await res.json();
        if (body.success && body.data) { _user = body.data; _saveSession(); return _user; }
    } catch { /* ignore */ }
    return null;
}
