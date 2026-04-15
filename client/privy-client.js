import { Buffer } from 'buffer';
if (typeof window !== 'undefined' && !window.Buffer) window.Buffer = Buffer;

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
async function _registerWithServer(accessToken, profilePicture) {
    const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
        body: JSON.stringify({ profile_picture: profilePicture || null }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.success ? body.data : null;
}

export function initPrivy(appId) {
    _appId = appId;
    const restored = _loadSession();

    try {
        _privyClient = new Privy({
            appId,
            storage: new LocalStorage(),
        });
        console.log('[Privy] SDK initialized');

        
        _initWalletIframe();
    } catch (e) {
        console.warn('[Privy] SDK init failed:', e.message);
    }

    if (restored) {
        setTimeout(() => _notifyListeners(), 0);
    
        if (_privyClient) {
            _privyClient.initialize().then(() => {
                console.log('[Privy] Session restored, user:', _privyClient.user ? 'loaded' : 'null');
            }).catch(e => {
                console.warn('[Privy] Session restore failed:', e.message);
            });
        }
    }
    handleOAuthCallback();

    return { authenticated: restored, user: _user };
}
export async function login() {
    if (!_privyClient) {
        console.warn('[Privy] No client, falling back to dev login');
        return _devLogin();
    }

    return new Promise((resolve) => {
        // Show login modal with both options
        const overlay = document.createElement('div');
        overlay.id = 'authOverlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.95);z-index:20000;display:flex;align-items:center;justify-content:center;font-family:Arial,Helvetica,sans-serif;';

        overlay.innerHTML = `
            <div style="background:#1a1a1a;border:1px solid #333;padding:2rem;width:min(90%,360px);text-align:center;">
                <div style="font-family:'Courier New',monospace;font-size:1.2rem;font-weight:700;color:#ffcc00;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:0.4rem;">ENTER THE ARENA</div>
                <div style="color:#ccc;font-size:0.75rem;margin-bottom:0.3rem;">Connect to compete in wager duels</div>
                <div style="color:#888;font-size:0.6rem;margin-bottom:1.5rem;">Every match is public. Every win and loss is recorded.</div>

                <button id="authTwitterBtn" style="width:100%;padding:12px;background:#000;border:1px solid #ffcc00;color:#ffcc00;font-family:Arial,Helvetica,sans-serif;font-size:0.85rem;font-weight:600;cursor:pointer;margin-bottom:0.75rem;display:flex;align-items:center;justify-content:center;gap:10px;">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="#ffcc00"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                    Sign in with X
                </button>

                <div id="authStatus" style="color:#888;font-size:0.65rem;margin:0.5rem 0;min-height:1.2em;"></div>

                <div style="border-top:1px solid #333;margin:1rem 0 0.8rem;"></div>
                <div style="color:#888;font-size:0.55rem;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.5rem;">Dev Mode</div>

                <input id="authHandleInput" type="text" placeholder="@handle"
                    style="width:100%;padding:10px;background:#000;border:1px solid #333;color:#fff;font-family:Arial,Helvetica,sans-serif;font-size:0.8rem;text-align:center;box-sizing:border-box;margin-bottom:0.5rem;" />

                <button id="authDevBtn" style="width:100%;padding:10px;background:#000;border:1px solid #333;color:#888;font-family:Arial,Helvetica,sans-serif;font-size:0.7rem;cursor:pointer;text-transform:uppercase;letter-spacing:0.06em;">
                    Dev Login
                </button>

                <div id="authCancelBtn" style="color:#888;font-size:0.65rem;cursor:pointer;margin-top:0.8rem;">
                    Cancel
                </div>
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

    
                const twitterAccount = user.linked_accounts?.find(a => a.type === 'twitter_oauth');
                const profilePic = twitterAccount?.profile_picture_url || twitterAccount?.profilePictureUrl || null;
                console.log('[Privy] Twitter pfp:', profilePic ? profilePic.slice(0, 50) + '...' : 'none');

                const serverUser = await _registerWithServer(accessToken, profilePic);
                if (serverUser) {
        
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

    
        let privyUser = null;
        try {
            const result = await _privyClient.user.get();
            privyUser = result?.user || result;
        } catch(e) {
            console.warn('[Privy] user.get() failed:', e.message);
            try {
                await _privyClient.initialize();
                const result = await _privyClient.user.get();
                privyUser = result?.user || result;
            } catch(e2) {
                console.warn('[Privy] user.get() retry failed:', e2.message);
            }
        }
        if (!privyUser || !privyUser.linked_accounts) {
            console.warn('[Privy] No user with linked_accounts');
            return null;
        }
        console.log('[Privy] User loaded:', privyUser.linked_accounts.length, 'linked accounts');

    
        let solWallet = null;
        try {
            solWallet = getUserEmbeddedSolanaWallet(privyUser);
        } catch(e) {
            console.warn('[Privy] getUserEmbeddedSolanaWallet error:', e.message);

            if (privyUser.linked_accounts) {
                solWallet = privyUser.linked_accounts.find(a =>
                    a.type === 'wallet' && a.chain_type === 'solana' && a.wallet_client_type === 'privy'
                );
            }
        }

        if (!solWallet) {

            const dbUser = getUser();
            if (dbUser?.privy_wallet) {
                console.log('[Privy] Using wallet address from DB:', dbUser.privy_wallet);
                solWallet = { address: dbUser.privy_wallet };
            }
        }

        if (!solWallet) {
            console.warn('[Privy] No Solana wallet found');
            return null;
        }
        console.log('[Privy] Found Solana wallet:', solWallet.address);

    
        let entropyId, entropyIdVerifier;
        try {
            const entropy = getEntropyDetailsFromUser(privyUser);
            entropyId = entropy.entropyId;
            entropyIdVerifier = entropy.entropyIdVerifier;
        } catch(e) {
            console.warn('[Privy] Entropy details not available:', e.message);
        }

    
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

export function getToken() {
    return _token;
}

export async function refreshToken() {
    if (!_privyClient) return _token;
    try {
        const newToken = await _privyClient.getAccessToken();
        if (newToken) {
            _token = newToken;
            _saveSession();
        }
        return _token;
    } catch(e) {
        console.warn('[Privy] Token refresh failed:', e.message);
        return _token;
    }
}
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
