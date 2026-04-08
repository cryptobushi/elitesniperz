/**
 * privy-client.js — Privy auth for sniperz wager system
 * Bundled via esbuild to dist/privy-bundle.js
 */
import Privy, { LocalStorage, getUserEmbeddedSolanaWallet, getEntropyDetailsFromUser } from '@privy-io/js-sdk-core';

const SESSION_KEY = 'sniperz_auth';
let _appId = null;
let _privyClient = null;
let _user = null;
let _token = null;
let _listeners = [];

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

// Initialize embedded wallet iframe proxy
let _walletIframeReady = false;
function _initWalletIframe() {
    if (!_privyClient) return;
    try {
        const iframeUrl = _privyClient.embeddedWallet.getURL();
        if (!iframeUrl) {
            console.warn('[Privy] No iframe URL from embeddedWallet.getURL()');
            return;
        }
        console.log('[Privy] Loading wallet iframe:', iframeUrl.slice(0, 80) + '...');
        const iframe = document.createElement('iframe');
        iframe.src = iframeUrl;
        iframe.id = 'privy-wallet-iframe';
        iframe.style.cssText = 'display:none;width:0;height:0;border:none;position:absolute;';
        iframe.allow = 'publickey-credentials-get *';
        document.body.appendChild(iframe);

        iframe.onload = () => {
            try {
                _privyClient.setMessagePoster(iframe.contentWindow);
                _walletIframeReady = true;
                console.log('[Privy] Wallet iframe ready');
            } catch (e) {
                console.warn('[Privy] Failed to set message poster:', e.message);
            }
        };

        // Listen for messages from the iframe
        window.addEventListener('message', (e) => {
            try {
                if (_privyClient && _privyClient.embeddedWallet) {
                    _privyClient.embeddedWallet.onMessage(e.data);
                }
            } catch (err) {
                // Ignore non-privy messages
            }
        });
    } catch (e) {
        console.warn('[Privy] Wallet iframe init error:', e.message);
    }
}

// Wait for wallet iframe to be ready (with timeout)
function _waitForWalletIframe(timeoutMs = 5000) {
    if (_walletIframeReady) return Promise.resolve(true);
    return new Promise((resolve) => {
        const start = Date.now();
        const check = () => {
            if (_walletIframeReady) return resolve(true);
            if (Date.now() - start > timeoutMs) return resolve(false);
            setTimeout(check, 100);
        };
        check();
    });
}

// Register with our server
async function _registerWithServer(accessToken) {
    const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken }
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.success ? body.data : null;
}

/**
 * Initialize Privy
 */
export function initPrivy(appId) {
    _appId = appId;
    const restored = _loadSession();

    try {
        _privyClient = new Privy({
            appId,
            storage: new LocalStorage(),
        });
        console.log('[Privy] SDK initialized');

        // Initialize embedded wallet iframe proxy
        _initWalletIframe();
    } catch (e) {
        console.warn('[Privy] SDK init failed:', e.message);
    }

    if (restored) {
        setTimeout(() => _notifyListeners(), 0);
        // Re-initialize Privy session so _privyClient.user is populated
        if (_privyClient) {
            _privyClient.initialize().then(() => {
                console.log('[Privy] Session restored, user:', _privyClient.user ? 'loaded' : 'null');
            }).catch(e => {
                console.warn('[Privy] Session restore failed:', e.message);
            });
        }
    }

    // Check for OAuth callback after SDK is ready
    handleOAuthCallback();

    return { authenticated: restored, user: _user };
}

/**
 * Login via Twitter/X using Privy OAuth
 */
export async function login() {
    if (!_privyClient) {
        console.warn('[Privy] No client, falling back to dev login');
        return _devLogin();
    }

    return new Promise((resolve) => {
        // Show login modal with both options
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

                <div id="authStatus" style="color:#888;font-size:0.7rem;margin:0.5rem 0;min-height:1.2em;"></div>

                <div style="color:#444;font-size:0.65rem;margin:0.8rem 0;">— or dev mode —</div>

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
        const statusEl = () => document.getElementById('authStatus');

        // Twitter/X login via Privy OAuth
        document.getElementById('authTwitterBtn').addEventListener('click', async () => {
            if (statusEl()) statusEl().textContent = 'Connecting to X...';
            try {
                const redirectUrl = window.location.origin + '/auth/callback';
                const oauthData = await _privyClient.auth.oauth.generateURL('twitter', redirectUrl);
                console.log('[Privy] OAuth URL generated:', oauthData);

                if (oauthData && oauthData.url) {
                    sessionStorage.setItem('privy_oauth_state', JSON.stringify({ matchId: null }));
                    window.location.href = oauthData.url;
                } else if (typeof oauthData === 'string') {
                    window.location.href = oauthData;
                } else {
                    if (statusEl()) statusEl().textContent = 'Failed to get OAuth URL. Try dev login.';
                }
            } catch (e) {
                console.error('[Privy] OAuth error:', e);
                if (statusEl()) statusEl().textContent = 'OAuth error: ' + e.message;
            }
        });

        // Dev login
        document.getElementById('authDevBtn').addEventListener('click', async () => {
            const handle = document.getElementById('authHandleInput').value.trim().replace(/^@/, '');
            if (!handle) { document.getElementById('authHandleInput').style.borderColor = '#ff4444'; return; }
            cleanup();
            resolve(await _doDevLogin(handle));
        });

        document.getElementById('authHandleInput').addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                const handle = document.getElementById('authHandleInput').value.trim().replace(/^@/, '');
                if (!handle) return;
                cleanup();
                resolve(await _doDevLogin(handle));
            }
        });

        document.getElementById('authCancelBtn').addEventListener('click', () => {
            cleanup();
            resolve({ success: false, error: 'Login cancelled' });
        });

        setTimeout(() => document.getElementById('authHandleInput')?.focus(), 100);
    });
}

// Handle OAuth callback (called on page load if URL has callback params)
export async function handleOAuthCallback() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('privy_oauth_code') || params.get('code');
    const state = params.get('privy_oauth_state') || params.get('state');
    const provider = params.get('privy_oauth_provider') || 'twitter';

    // Not a callback URL
    if (!code) return false;

    console.log('[Privy] OAuth callback detected, provider:', provider, 'code:', code.slice(0, 10) + '...');

    if (!_privyClient) {
        console.error('[Privy] No client for callback — redirecting home');
        window.location.href = '/';
        return false;
    }

    try {
        console.log('[Privy] Calling loginWithCode...');
        const session = await _privyClient.auth.oauth.loginWithCode(code, state);
        console.log('[Privy] loginWithCode result:', session ? 'success' : 'null');

        if (session) {
            const user = session.user || session;
            console.log('[Privy] User:', JSON.stringify(user).slice(0, 200));

            // Get or create Solana wallet
            let solanaWallet = null;
            try {
                solanaWallet = getUserEmbeddedSolanaWallet(user);
                if (solanaWallet) {
                    console.log('[Privy] Existing Solana wallet:', solanaWallet.address);
                }
            } catch(e) {}

            if (!solanaWallet) {
                try {
                    console.log('[Privy] Waiting for wallet iframe...');
                    const iframeOk = await _waitForWalletIframe(8000);
                    if (iframeOk) {
                        console.log('[Privy] Creating Solana wallet...');
                        const walletResult = await _privyClient.embeddedWallet.createSolana();
                        solanaWallet = getUserEmbeddedSolanaWallet(walletResult.user || walletResult);
                        console.log('[Privy] Created Solana wallet:', solanaWallet?.address);
                    } else {
                        console.warn('[Privy] Wallet iframe not ready, skipping wallet creation');
                    }
                } catch(e) {
                    console.warn('[Privy] Failed to create Solana wallet:', e.message);
                }
            }

            const accessToken = await _privyClient.getAccessToken();
            console.log('[Privy] Access token:', accessToken ? accessToken.slice(0, 20) + '...' : 'null');

            if (accessToken) {
                _token = accessToken;

                // Extract twitter info from linked accounts
                const twitterAccount = user.linked_accounts?.find(a => a.type === 'twitter_oauth');

                const serverUser = await _registerWithServer(accessToken);
                if (serverUser) {
                    // Enrich with wallet address from Privy
                    if (solanaWallet?.address && !serverUser.privy_wallet) {
                        serverUser.privy_wallet = solanaWallet.address;
                    }
                    _user = serverUser;
                    _saveSession();
                    _notifyListeners();
                    console.log('[Privy] Login complete, wallet:', solanaWallet?.address, 'redirecting...');
                    window.location.href = '/';
                    return true;
                }
            }
        }
    } catch (e) {
        console.error('[Privy] OAuth callback error:', e);
    }

    // Failed — redirect home anyway
    console.warn('[Privy] Callback failed, redirecting home');
    window.location.href = '/';
    return false;
}

// Dev mode login
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

/**
 * Get the Privy Solana provider for signing transactions.
 * Returns a provider with signAndSendTransaction() or null.
 */
export async function getSolanaProvider() {
    if (!_privyClient) return null;
    const ready = await _waitForWalletIframe(5000);
    if (!ready) { console.warn('[Privy] Wallet iframe not ready for signing'); return null; }

    try {
        const accessToken = await _privyClient.getAccessToken();
        if (!accessToken) return null;

        // Ensure Privy user is loaded
        let privyUser = _privyClient.user;
        if (!privyUser) {
            console.log('[Privy] User not loaded, initializing...');
            try {
                await _privyClient.initialize();
                privyUser = _privyClient.user;
            } catch(e) {}
        }
        if (!privyUser) {
            console.warn('[Privy] No privy user object after initialize');
            return null;
        }

        // Find the embedded Solana wallet account
        const solWallet = getUserEmbeddedSolanaWallet(privyUser);
        if (!solWallet) {
            console.warn('[Privy] No embedded Solana wallet found in user');
            return null;
        }
        console.log('[Privy] Found Solana wallet:', solWallet.address);

        // Get entropy details for wallet access
        const { entropyId, entropyIdVerifier } = getEntropyDetailsFromUser(privyUser);

        // Get Solana provider
        const provider = await _privyClient.embeddedWallet.getSolanaProvider(
            solWallet, entropyId, entropyIdVerifier
        );
        console.log('[Privy] Got Solana provider');
        return provider;
    } catch (e) {
        console.error('[Privy] Failed to get Solana provider:', e);
        return null;
    }
}

export function logout() {
    _token = null;
    _user = null;
    sessionStorage.removeItem(SESSION_KEY);
    if (_privyClient) {
        try { _privyClient.logout(); } catch(e) {}
    }
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

// OAuth callback is checked after initPrivy() is called
