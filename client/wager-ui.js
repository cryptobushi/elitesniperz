// wager-ui.js — Wager lobby, create match, waiting room, and in-game HUD
import { isAuthenticated, getUser, getToken, getWalletAddress, login, logout } from '../dist/privy-bundle.js';
import { requestDeposit, checkBalance } from './deposit-flow.js';

// ── API helper ──────────────────────────────────────────────────────────────
async function api(path, options = {}) {
    let token = getToken();
    const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) };
    let res = await fetch('/api' + path, { ...options, headers });

    // If token expired, refresh from Privy and retry once
    if (res.status === 401 && token) {
        try {
            const { refreshToken } = await import('../dist/privy-bundle.js');
            const newToken = await refreshToken();
            if (newToken && newToken !== token) {
                headers.Authorization = 'Bearer ' + newToken;
                res = await fetch('/api' + path, { ...options, headers });
            }
        } catch(_) {}
    }
    return res.json();
}

// ── State ───────────────────────────────────────────────────────────────────
let lobbyInterval = null;
let waitingInterval = null;
let wagerWs = null;
let currentMatchId = null;
let currentMatchInfo = null; // { stakeAmount, stakeToken, killTarget, creatorTwitter, joinerTwitter, opponentTwitter }
let wagerReconnectAttempts = 0;
const WAGER_MAX_RECONNECTS = 5;
const WAGER_RECONNECT_DELAY = 2000;

// ── Styles ──────────────────────────────────────────────────────────────────
const STYLES = `
/* === WAGER LOBBY === */
#wagerLobby {
    position: fixed;
    top: 0; left: 0;
    width: 100%; height: 100%;
    background: #0a0a0f;
    z-index: 500;
    display: flex;
    flex-direction: column;
    align-items: center;
    font-family: 'Inter', system-ui, sans-serif;
    overflow-y: auto;
}
#wagerLobby.hidden { display: none !important; }

.wl-topbar {
    width: 100%;
    max-width: 640px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.6rem 1rem;
    border-bottom: 1px solid #1e1e2a;
    background: #12121a;
    flex-shrink: 0;
}
.wl-topbar .wl-user-group {
    display: flex;
    align-items: center;
    gap: 0.6rem;
}
.wl-topbar .wl-user {
    color: #00ff66;
    font-size: 0.75rem;
    font-weight: 600;
}
.wl-topbar .wl-balance {
    color: #888894;
    font-size: 0.65rem;
    font-weight: 500;
    background: #1a1a25;
    padding: 0.15rem 0.5rem;
    border: 1px solid #1e1e2a;
}
.wl-topbar .wl-btn {
    background: #1a1a25;
    border: 1px solid #2a2a3a;
    color: #888894;
    padding: 0.3rem 0.7rem;
    font-size: 0.65rem;
    font-family: 'Inter', system-ui, sans-serif;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    transition: all 0.15s;
}
.wl-topbar .wl-btn:hover { background: #2a2a3a; color: #e8e8ec; border-color: #00ff66; }
.wl-topbar .wl-btn:active { opacity: 0.8; }

/* My Duels management section */
.wl-my-duels {
    width: 100%;
    max-width: 640px;
    padding: 0.8rem 1rem;
    flex-shrink: 0;
}
.wl-my-duels.hidden { display: none; }
.wl-my-duels-header {
    font-family: 'Oswald', sans-serif;
    font-size: 0.75rem;
    color: #888894;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin-bottom: 0.5rem;
}
.wl-my-duel-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.6rem 0.8rem;
    background: #12121a;
    border: 1px solid #1e1e2a;
    margin-bottom: 0.4rem;
    gap: 0.5rem;
}
.wl-my-duel-info {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    font-size: 0.75rem;
    color: #e8e8ec;
    flex: 1;
    min-width: 0;
}
.wl-my-duel-stake {
    color: #00ff66;
    font-weight: 700;
    font-family: 'Oswald', sans-serif;
    font-size: 0.85rem;
    white-space: nowrap;
}
.wl-my-duel-target {
    color: #888894;
    font-size: 0.65rem;
    white-space: nowrap;
}
.wl-my-duel-status {
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 2px 8px;
    border-radius: 2px;
    white-space: nowrap;
}
.wl-my-duel-status.waiting { background: rgba(255,136,0,0.12); color: #ff8800; }
.wl-my-duel-status.open { background: rgba(0,255,102,0.1); color: #00ff66; }
.wl-my-duel-status.hot { background: rgba(255,136,0,0.15); color: #ff8800; animation: badgePulse 1.5s ease-in-out infinite; }
@keyframes badgePulse { 0%,100% { opacity: 1; } 50% { opacity: 0.6; } }
.wl-my-duel-cancel {
    padding: 4px 12px;
    background: none;
    border: 1px solid #2a2a3a;
    color: #ff3344;
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 0.6rem;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    transition: all 0.15s;
    white-space: nowrap;
}
.wl-my-duel-cancel:hover { border-color: #ff3344; background: rgba(255,51,68,0.08); }
.wl-my-duel-resume {
    padding: 4px 12px;
    background: none;
    border: 1px solid #00ff66;
    color: #00ff66;
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 0.6rem;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    transition: all 0.15s;
    white-space: nowrap;
}
.wl-my-duel-resume:hover { background: rgba(0,255,102,0.08); }

.wl-header {
    width: 100%;
    max-width: 640px;
    padding: 1.2rem 1rem 0.6rem;
    flex-shrink: 0;
}
.wl-title {
    color: #e8e8ec;
    font-family: 'Oswald', sans-serif;
    font-size: clamp(1.4rem, 5vw, 2rem);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
}
.wl-title .wl-pulse {
    width: 8px;
    height: 8px;
    background: #00ff66;
    border-radius: 50%;
    display: inline-block;
    animation: wlPulse 2s ease-in-out infinite;
    box-shadow: 0 0 6px rgba(0,255,102,0.5);
}
@keyframes wlPulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(0.8); }
}

.wl-subtitle {
    color: #55555f;
    font-size: 0.7rem;
    margin-top: 0.3rem;
    flex-shrink: 0;
}

/* Match table */
.wl-table-wrap {
    width: 100%;
    max-width: 640px;
    flex: 1;
    overflow-y: auto;
    padding: 0 0.5rem;
}
.wl-table {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0 2px;
}
.wl-table th {
    color: #55555f;
    font-size: 0.55rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 8px 10px;
    border-bottom: 1px solid #1e1e2a;
    text-align: left;
    position: sticky;
    top: 0;
    background: #0a0a0f;
    font-weight: 500;
}
.wl-table td {
    padding: 10px;
    font-size: 0.72rem;
    color: #e8e8ec;
    background: #12121a;
    border-bottom: 1px solid #1e1e2a;
    transition: background 0.15s;
}
.wl-table tr:hover td { background: #1a1a25; }
.wl-table .wl-creator { color: #00ff66; font-weight: 600; }
.wl-table .wl-record { color: #888894; }
.wl-table .wl-stake { color: #00ff66; font-weight: 600; }
.wl-table .wl-target { color: #e8e8ec; }
.wl-table .wl-lock { font-size: 0.8rem; }

.wl-status-badge {
    display: inline-block;
    padding: 0.15rem 0.4rem;
    font-size: 0.55rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    border-radius: 2px;
}
.wl-status-badge.open { background: rgba(0,255,102,0.1); color: #00ff66; border: 1px solid rgba(0,255,102,0.25); }
.wl-status-badge.live { background: rgba(255,51,68,0.1); color: #ff3344; border: 1px solid rgba(255,51,68,0.25); animation: wlPulse 1.5s ease-in-out infinite; }
.wl-status-badge.hot { background: rgba(255,136,0,0.1); color: #ff8800; border: 1px solid rgba(255,136,0,0.25); }
.wl-status-badge.new { background: rgba(68,136,255,0.1); color: #4488ff; border: 1px solid rgba(68,136,255,0.25); }

.wl-join-btn {
    background: #00ff66;
    border: 1px solid #00ff66;
    color: #0a0a0f;
    padding: 0.3rem 0.8rem;
    font-size: 0.65rem;
    font-weight: 700;
    font-family: 'Oswald', sans-serif;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    transition: all 0.15s;
}
.wl-join-btn:hover { background: #00cc52; border-color: #00cc52; }
.wl-join-btn:active { opacity: 0.8; }

.wl-empty {
    color: #55555f;
    text-align: center;
    padding: 3rem 1rem;
    font-size: 0.8rem;
}

.wl-bottom {
    width: 100%;
    max-width: 640px;
    padding: 0.8rem 1rem;
    border-top: 1px solid #1e1e2a;
    display: flex;
    justify-content: center;
    flex-shrink: 0;
}
.wl-create-btn {
    background: #00ff66;
    border: 1px solid #00ff66;
    color: #0a0a0f;
    padding: 0.7rem 2.5rem;
    font-size: 0.95rem;
    font-weight: 700;
    font-family: 'Oswald', sans-serif;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    transition: all 0.15s;
}
.wl-create-btn:hover { background: #00cc52; border-color: #00cc52; }
.wl-create-btn:active { opacity: 0.8; }

/* === CREATE MATCH MODAL === */
#createMatchModal {
    position: fixed;
    top: 0; left: 0;
    width: 100%; height: 100%;
    z-index: 510;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0,0,0,0.85);
}
#createMatchModal.hidden { display: none !important; }

.cm-panel {
    background: #12121a;
    border: 1px solid #2a2a3a;
    padding: 1.5rem;
    width: min(92%, 400px);
    font-family: 'Inter', system-ui, sans-serif;
    text-align: center;
}
.cm-panel h2 {
    color: #e8e8ec;
    font-family: 'Oswald', sans-serif;
    font-size: 1.3rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin-bottom: 1rem;
}
.cm-label {
    color: #888894;
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    text-align: left;
    margin-bottom: 0.3rem;
    margin-top: 0.6rem;
    font-weight: 500;
}
.cm-input {
    background: #0a0a0f;
    border: 1px solid #2a2a3a;
    color: #e8e8ec;
    padding: 0.5rem 0.6rem;
    font-size: 0.85rem;
    font-family: 'Inter', system-ui, sans-serif;
    width: 100%;
    -webkit-appearance: none;
    border-radius: 0;
    transition: border-color 0.15s;
    box-sizing: border-box;
}
.cm-input:focus { outline: none; border-color: #00ff66; }
.cm-input::placeholder { color: #55555f; font-style: italic; }

.cm-toggle-group {
    display: flex;
    gap: 0.4rem;
    margin-top: 0.3rem;
}
.cm-toggle {
    flex: 1;
    background: #1a1a25;
    border: 1px solid #2a2a3a;
    color: #888894;
    padding: 0.45rem;
    font-size: 0.75rem;
    font-family: 'Inter', system-ui, sans-serif;
    font-weight: 600;
    cursor: pointer;
    text-transform: uppercase;
    transition: all 0.15s;
}
.cm-toggle:hover { border-color: #55555f; color: #e8e8ec; }
.cm-toggle:active { opacity: 0.8; }
.cm-toggle.selected {
    background: rgba(0,255,102,0.08);
    border-color: #00ff66;
    color: #00ff66;
}

.cm-submit {
    margin-top: 1rem;
    background: #00ff66;
    border: 1px solid #00ff66;
    color: #0a0a0f;
    padding: 0.7rem;
    font-size: 0.9rem;
    font-weight: 700;
    font-family: 'Oswald', sans-serif;
    cursor: pointer;
    width: 100%;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    transition: all 0.15s;
}
.cm-submit:hover { background: #00cc52; border-color: #00cc52; }
.cm-submit:active { opacity: 0.8; }
.cm-submit:disabled {
    opacity: 0.4;
    cursor: default;
}

.cm-cancel {
    margin-top: 0.5rem;
    background: none;
    border: none;
    color: #55555f;
    padding: 0.4rem 1rem;
    font-size: 0.65rem;
    font-family: 'Inter', system-ui, sans-serif;
    cursor: pointer;
    text-transform: uppercase;
    transition: all 0.15s;
}
.cm-cancel:hover { color: #888894; }

/* === WAITING ROOM === */
@keyframes wrPulse {
    0%, 100% { border-color: #2a2a3a; }
    50% { border-color: #3a3a4a; }
}

#waitingRoom {
    position: fixed;
    top: 0; left: 0;
    width: 100%; height: 100%;
    background: #0a0a0f;
    background-image:
        linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px);
    background-size: 40px 40px;
    z-index: 520;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    font-family: 'Inter', system-ui, sans-serif;
    padding: 2rem 1rem;
}
#waitingRoom.hidden { display: none !important; }

.wr-title {
    color: #00ff66;
    font-family: 'Oswald', sans-serif;
    font-size: clamp(1.8rem, 6vw, 2.6rem);
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    margin-bottom: 0.4rem;
    text-shadow: 0 0 30px rgba(0,255,102,0.2);
}
.wr-info {
    color: #e8e8ec;
    font-family: 'Oswald', sans-serif;
    font-size: clamp(1.1rem, 4vw, 1.6rem);
    letter-spacing: 0.08em;
    margin-bottom: 0.3rem;
    text-transform: uppercase;
}
.wr-helper {
    color: #55555f;
    font-size: 0.7rem;
    margin-bottom: 1.8rem;
    font-style: italic;
}
.wr-challenge-text {
    color: #ff8800;
    font-family: 'Oswald', sans-serif;
    font-size: clamp(0.7rem, 2.5vw, 0.85rem);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin-bottom: 1.5rem;
    opacity: 0.9;
}
.wr-players {
    display: flex;
    gap: 2rem;
    align-items: stretch;
    margin-bottom: 1.8rem;
}
.wr-card {
    background: #12121a;
    border: 1px solid #2a2a3a;
    padding: 1.4rem 2rem;
    min-width: 200px;
    text-align: center;
    transition: border-color 0.3s, background 0.3s, box-shadow 0.3s;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.3rem;
}
.wr-card.funded {
    border-color: #00ff66;
    background: rgba(0,255,102,0.04);
    box-shadow: 0 0 20px rgba(0,255,102,0.08), inset 0 0 20px rgba(0,255,102,0.02);
}
.wr-card.awaiting { border-color: #ff8800; background: rgba(255,136,0,0.03); }
.wr-card.not-deposited { border-color: rgba(255,51,68,0.3); }
.wr-card.empty {
    border: 2px dashed #2a2a3a;
    animation: wrPulse 2.5s ease-in-out infinite;
    background: rgba(18,18,26,0.6);
}
.wr-avatar {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'Oswald', sans-serif;
    font-size: 1.3rem;
    font-weight: 700;
    color: #0a0a0f;
    margin-bottom: 0.3rem;
    flex-shrink: 0;
}
.wr-card .wr-name {
    color: #00ff66;
    font-family: 'Oswald', sans-serif;
    font-size: 1.05rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    margin-bottom: 0.15rem;
}
.wr-card .wr-record {
    color: #888894;
    font-size: 0.65rem;
    margin-bottom: 0.2rem;
    letter-spacing: 0.02em;
}
.wr-card .wr-status {
    margin-top: 0.25rem;
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 0.2rem 0.6rem;
}
.wr-card .wr-status.locked { color: #00ff66; border: 1px solid rgba(0,255,102,0.2); background: rgba(0,255,102,0.06); }
.wr-card .wr-status.waiting { color: #ff8800; border: 1px solid rgba(255,136,0,0.2); background: rgba(255,136,0,0.06); }
.wr-card .wr-status.not-locked { color: rgba(255,51,68,0.7); border: 1px solid rgba(255,51,68,0.15); background: rgba(255,51,68,0.04); }
/* legacy class compat */
.wr-card .wr-status.ok { color: #00ff66; }
.wr-card .wr-status.pending { color: #ff8800; }
.wr-card.empty .wr-name {
    color: #00ff66;
    font-family: 'Oswald', sans-serif;
    font-size: 1rem;
    opacity: 0.9;
}
.wr-card.empty .wr-record {
    color: #55555f;
    font-size: 0.65rem;
    font-style: italic;
}

.wr-vs {
    color: #00ff66;
    font-family: 'Oswald', sans-serif;
    font-size: clamp(2rem, 6vw, 3rem);
    font-weight: 900;
    letter-spacing: 0.12em;
    text-shadow: 0 0 30px rgba(0,255,102,0.35), 0 0 60px rgba(0,255,102,0.15);
    display: flex;
    align-items: center;
    align-self: center;
}

.wr-dots {
    color: #00ff66;
    font-size: 1rem;
    margin-bottom: 1rem;
    animation: blink2k 1s step-end infinite;
}

.wr-deposit-btn {
    margin: 0.5rem auto;
    padding: 0.8rem 2.5rem;
    background: #00ff66;
    border: 1px solid #00ff66;
    color: #0a0a0f;
    font-weight: 700;
    cursor: pointer;
    font-family: 'Oswald', sans-serif;
    font-size: 1rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    transition: all 0.15s;
    box-shadow: 0 0 20px rgba(0,255,102,0.2);
}
.wr-deposit-btn:hover { background: #00cc52; border-color: #00cc52; box-shadow: 0 0 30px rgba(0,255,102,0.3); }
.wr-deposit-btn:disabled { opacity: 0.4; cursor: default; box-shadow: none; }

.wr-share-btn {
    margin: 0.6rem auto;
    padding: 0.5rem 1.8rem;
    background: transparent;
    border: 1px solid #00ff66;
    color: #00ff66;
    font-weight: 600;
    cursor: pointer;
    font-family: 'Oswald', sans-serif;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    transition: all 0.15s;
    display: block;
}
.wr-share-btn:hover { background: rgba(0,255,102,0.08); box-shadow: 0 0 15px rgba(0,255,102,0.15); }

.wr-note {
    color: #55555f;
    font-size: 0.65rem;
    margin-top: 1.2rem;
    font-style: italic;
}

.wr-cancel {
    background: none;
    border: 1px solid rgba(255,51,68,0.15);
    color: rgba(255,51,68,0.5);
    padding: 0.35rem 1rem;
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 0.6rem;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    transition: all 0.2s;
    margin-top: 0.5rem;
}
.wr-cancel:hover { border-color: #ff3344; color: #ff3344; }

/* === WAGER HUD === */
#wagerHUD {
    position: fixed;
    top: 0; left: 0;
    width: 100%;
    z-index: 9990;
    pointer-events: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding-top: max(env(safe-area-inset-top, 6px), 6px);
    font-family: 'Inter', system-ui, sans-serif;
}
#wagerHUD.hidden { display: none !important; }

.wh-score {
    background: rgba(10,10,15,0.9);
    border: 1px solid #2a2a3a;
    padding: 4px 20px;
    display: flex;
    align-items: baseline;
    gap: 12px;
}
.wh-score .wh-you {
    color: #00ff66;
    font-size: clamp(1rem, 4vw, 1.6rem);
    font-weight: 900;
}
.wh-score .wh-sep {
    color: #55555f;
    font-size: clamp(0.8rem, 3vw, 1.2rem);
}
.wh-score .wh-opp {
    color: #ff3344;
    font-size: clamp(1rem, 4vw, 1.6rem);
    font-weight: 900;
}
.wh-meta {
    display: flex;
    gap: 12px;
    margin-top: 2px;
}
.wh-target {
    color: #888894;
    font-size: clamp(0.5rem, 1.8vw, 0.65rem);
}
.wh-stake {
    color: #00ff66;
    font-size: clamp(0.5rem, 1.8vw, 0.65rem);
}

/* === WAGER RESULT === */
#wagerResult {
    position: fixed;
    top: 0; left: 0;
    width: 100%; height: 100%;
    z-index: 960;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    pointer-events: all;
    font-family: 'Inter', system-ui, sans-serif;
    overflow-y: auto;
    padding: env(safe-area-inset-top, 0) env(safe-area-inset-right, 0) env(safe-area-inset-bottom, 0) env(safe-area-inset-left, 0);
}
#wagerResult.hidden { display: none !important; }

@keyframes resultSlam {
    0% { transform: scale(3) rotate(-5deg); opacity: 0; }
    50% { transform: scale(1.1) rotate(1deg); opacity: 1; }
    70% { transform: scale(0.95) rotate(0deg); }
    100% { transform: scale(1) rotate(0deg); opacity: 1; }
}
@keyframes resultPulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.05); }
}
@keyframes payoutCount {
    0% { transform: scale(0.5); opacity: 0; }
    60% { transform: scale(1.2); }
    100% { transform: scale(1); opacity: 1; }
}
@keyframes shimmer {
    0% { background-position: -200% center; }
    100% { background-position: 200% center; }
}
@keyframes floatUp {
    0% { transform: translateY(20px); opacity: 0; }
    100% { transform: translateY(0); opacity: 1; }
}
.wr-result-bg {
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
}
.wr-result-bg.victory-bg {
    background: radial-gradient(ellipse at center, rgba(0,255,102,0.15) 0%, rgba(10,10,15,0.98) 70%);
}
.wr-result-bg.defeat-bg {
    background: radial-gradient(ellipse at center, rgba(255,51,68,0.15) 0%, rgba(10,10,15,0.98) 70%);
}
.wr-result-bg.draw-bg {
    background: radial-gradient(ellipse at center, rgba(255,136,0,0.12) 0%, rgba(10,10,15,0.98) 70%);
}
.wr-result-content {
    position: relative;
    z-index: 1;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0;
}
.wr-result-title {
    font-family: 'Oswald', sans-serif;
    font-size: clamp(4rem, 18vw, 8rem);
    font-weight: 900;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    animation: resultSlam 0.6s cubic-bezier(0.2, 0.8, 0.3, 1.2) forwards;
    line-height: 1;
}
.wr-result-title.victory {
    color: #00ff66;
    text-shadow: 0 0 60px rgba(0,255,102,0.8), 0 0 120px rgba(0,255,102,0.4), 0 4px 0 #004d1f;
    animation: resultSlam 0.6s cubic-bezier(0.2, 0.8, 0.3, 1.2) forwards, resultPulse 2s 0.8s ease-in-out infinite;
}
.wr-result-title.defeat {
    color: #ff3344;
    text-shadow: 0 0 60px rgba(255,51,68,0.8), 0 0 120px rgba(255,51,68,0.4), 0 4px 0 #660014;
}
.wr-result-title.draw {
    color: #ff8800;
    text-shadow: 0 0 60px rgba(255,136,0,0.6), 0 0 120px rgba(255,136,0,0.3), 0 4px 0 #663600;
}
.wr-result-opponent {
    font-family: 'Oswald', sans-serif;
    font-size: clamp(1.2rem, 5vw, 2rem);
    color: #888894;
    margin-top: 0.5rem;
    animation: floatUp 0.5s 0.3s ease-out both;
}
.wr-result-score {
    font-family: 'Oswald', sans-serif;
    font-size: clamp(2.5rem, 10vw, 5rem);
    color: #e8e8ec;
    letter-spacing: 0.2em;
    margin-top: 0.3rem;
    animation: floatUp 0.5s 0.4s ease-out both;
}
.wr-result-payout {
    font-family: 'Oswald', sans-serif;
    font-size: clamp(1.5rem, 7vw, 3rem);
    font-weight: 900;
    margin-top: 0.8rem;
    animation: payoutCount 0.6s 0.6s ease-out both;
}
.wr-result-payout.win {
    color: #00ff66;
    text-shadow: 0 0 30px rgba(0,255,102,0.6), 0 0 60px rgba(0,255,102,0.3);
    background: linear-gradient(90deg, #00ff66, #44ffaa, #00ff66);
    background-size: 200%;
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    animation: payoutCount 0.6s 0.6s ease-out both, shimmer 3s 1.2s linear infinite;
}
.wr-result-payout.loss {
    color: #ff3344;
    text-shadow: 0 0 20px rgba(255,51,68,0.4);
}
.wr-result-payout.draw-payout {
    color: #ff8800;
    text-shadow: 0 0 20px rgba(255,136,0,0.4);
}
.wr-result-tx {
    margin-top: 0.8rem;
    animation: floatUp 0.5s 0.9s ease-out both;
}
.wr-result-tx a {
    color: #00ff66;
    font-size: 0.75rem;
    text-decoration: underline;
    opacity: 0.7;
}
.wr-result-tx a:hover { opacity: 1; }
.wr-result-back {
    margin-top: 1.5rem;
    background: #00ff66;
    border: 1px solid #00ff66;
    color: #0a0a0f;
    padding: 0.8rem 2.5rem;
    font-size: clamp(0.9rem, 3vw, 1.1rem);
    font-weight: 700;
    font-family: 'Oswald', sans-serif;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    animation: floatUp 0.5s 1s ease-out both;
    transition: all 0.15s;
}
.wr-result-back:hover { background: #00cc52; border-color: #00cc52; }
.wr-result-back:active { opacity: 0.8; }

/* === WAGER BUTTON on start screen === */
#wagerBtn {
    background: #00ff66;
    border: 1px solid #00ff66;
    color: #0a0a0f;
    padding: 0.5rem;
    font-size: 0.85rem;
    font-weight: 700;
    font-family: 'Oswald', sans-serif;
    cursor: pointer;
    width: 100%;
    border-radius: 0;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-top: 0.5rem;
    -webkit-tap-highlight-color: transparent;
    transition: all 0.15s;
}
#wagerBtn:hover { background: #00cc52; border-color: #00cc52; }
#wagerBtn:active { opacity: 0.8; }

/* === Mobile responsive === */
@media (max-width: 768px), (max-height: 500px) {
    .wl-topbar { padding: 0.4rem 0.6rem; }
    .wl-topbar .wl-user { font-size: 0.6rem; }
    .wl-topbar .wl-balance { font-size: 0.55rem; }
    .wl-topbar .wl-btn { font-size: 0.55rem; padding: 0.2rem 0.5rem; }
    .wl-header { padding: 0.8rem 0.6rem 0.4rem; }
    .wl-title { font-size: clamp(1rem, 4vw, 1.3rem); }
    .wl-table td { font-size: 0.6rem; padding: 6px; }
    .wl-table th { font-size: 0.5rem; }
    .wl-join-btn { font-size: 0.55rem; padding: 0.2rem 0.5rem; }
    .wl-create-btn { font-size: 0.75rem; padding: 0.5rem 1.5rem; }

    .cm-panel { padding: 0.8rem; }
    .cm-panel h2 { font-size: 1rem; }

    .wr-card { padding: 1rem 1.2rem; min-width: 130px; }
    .wr-card .wr-name { font-size: 0.85rem; }
    .wr-avatar { width: 38px; height: 38px; font-size: 1.1rem; }
    .wr-players { gap: 1rem; }
    .wr-vs { font-size: clamp(1.4rem, 5vw, 2rem); }
    .wr-title { font-size: clamp(1.4rem, 5vw, 2rem); }
    .wr-share-btn { font-size: 0.7rem; padding: 0.4rem 1.2rem; }

    /* Result screen mobile */
    .wr-result-title { font-size: clamp(2rem, 12vw, 4rem) !important; }
    .wr-result-score { font-size: clamp(1.5rem, 8vw, 3rem) !important; }
    .wr-result-payout { font-size: clamp(1rem, 5vw, 2rem) !important; }
    .wr-result-opponent { font-size: clamp(0.8rem, 3.5vw, 1.2rem) !important; }
    .wr-result-back { font-size: clamp(0.7rem, 2.5vw, 0.9rem) !important; padding: 0.5rem 1.5rem !important; margin-top: 0.8rem !important; }
    .wr-result-content { padding: 1rem; gap: 0.2rem; }
}
@media (max-height: 400px) {
    .wr-result-title { font-size: clamp(1.5rem, 8vw, 2.5rem) !important; line-height: 1 !important; }
    .wr-result-score { font-size: clamp(1.2rem, 6vw, 2rem) !important; margin-top: 0 !important; }
    .wr-result-payout { font-size: clamp(0.8rem, 4vw, 1.5rem) !important; margin-top: 0.3rem !important; }
    .wr-result-back { margin-top: 0.5rem !important; }
    .wr-result-content { padding: 0.5rem; }
}

/* === SELECTIVE MODE / CHALLENGE SYSTEM === */
.wl-selective-badge {
    display: inline-block;
    font-size: 0.5rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #aa66ff;
    border: 1px solid rgba(170,102,255,0.3);
    background: rgba(170,102,255,0.08);
    padding: 1px 5px;
    margin-left: 6px;
    vertical-align: middle;
}
.wl-challenge-btn {
    background: #aa66ff;
    border: 1px solid #aa66ff;
    color: #0a0a0f;
    padding: 0.3rem 0.8rem;
    font-size: 0.65rem;
    font-weight: 700;
    font-family: 'Oswald', sans-serif;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    transition: all 0.15s;
}
.wl-challenge-btn:hover { background: #9955ee; border-color: #9955ee; }
.wl-challenge-btn:active { opacity: 0.8; }

/* Match mode toggle in create modal */
.cm-mode-hint {
    color: #55555f;
    font-size: 0.55rem;
    font-style: italic;
    margin-top: 0.2rem;
    text-align: left;
    min-height: 1.2em;
}
.cm-tooltip-wrap {
    position: relative;
    display: inline-flex;
}
.cm-tooltip-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 15px;
    height: 15px;
    border-radius: 50%;
    border: 1px solid #2a2a3a;
    color: #55555f;
    font-size: 0.55rem;
    font-weight: 700;
    font-style: normal;
    cursor: help;
    transition: all 0.15s;
}
.cm-tooltip-trigger:hover {
    border-color: #00ff66;
    color: #00ff66;
}
.cm-tooltip-box {
    display: none;
    position: absolute;
    bottom: calc(100% + 8px);
    left: 50%;
    transform: translateX(-50%);
    width: 260px;
    background: #1a1a25;
    border: 1px solid #2a2a3a;
    padding: 0.7rem;
    font-size: 0.6rem;
    font-style: normal;
    font-weight: 400;
    color: #888894;
    line-height: 1.5;
    text-transform: none;
    letter-spacing: normal;
    z-index: 100;
    pointer-events: none;
}
.cm-tooltip-box strong {
    color: #e8e8ec;
    font-weight: 600;
}
.cm-tooltip-wrap:hover .cm-tooltip-box {
    display: block;
}
@media (max-width: 400px) {
    .cm-tooltip-box {
        width: 200px;
        left: 0;
        transform: none;
    }
}

/* Challengers section in waiting room */
.wr-challengers {
    width: 100%;
    max-width: 480px;
    margin: 1rem auto;
    padding: 0 1rem;
}
.wr-challengers-title {
    color: #888894;
    font-family: 'Oswald', sans-serif;
    font-size: 0.75rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin-bottom: 0.5rem;
    text-align: center;
}
.wr-challengers-empty {
    color: #55555f;
    font-size: 0.7rem;
    text-align: center;
    font-style: italic;
    padding: 1rem 0;
}
.wr-challenger-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.6rem 0.8rem;
    background: #12121a;
    border: 1px solid #1e1e2a;
    margin-bottom: 0.4rem;
    transition: border-color 0.15s;
}
.wr-challenger-row:hover { border-color: #2a2a3a; }
.wr-challenger-avatar {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'Oswald', sans-serif;
    font-size: 1rem;
    font-weight: 700;
    color: #0a0a0f;
    flex-shrink: 0;
}
.wr-challenger-info {
    flex: 1;
    min-width: 0;
}
.wr-challenger-handle {
    color: #00ff66;
    font-family: 'Oswald', sans-serif;
    font-size: 0.8rem;
    font-weight: 600;
}
.wr-challenger-handle a { color: inherit; text-decoration: none; }
.wr-challenger-handle a:hover { text-decoration: underline; }
.wr-challenger-stats {
    color: #888894;
    font-size: 0.6rem;
    margin-top: 0.1rem;
}
.wr-challenger-actions {
    display: flex;
    gap: 0.3rem;
    flex-shrink: 0;
}
.wr-challenger-accept {
    padding: 4px 12px;
    background: rgba(0,255,102,0.08);
    border: 1px solid #00ff66;
    color: #00ff66;
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 0.6rem;
    font-weight: 600;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    transition: all 0.15s;
}
.wr-challenger-accept:hover { background: rgba(0,255,102,0.15); }
.wr-challenger-decline {
    padding: 4px 12px;
    background: none;
    border: 1px solid rgba(255,51,68,0.3);
    color: rgba(255,51,68,0.6);
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 0.6rem;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    transition: all 0.15s;
}
.wr-challenger-decline:hover { border-color: #ff3344; color: #ff3344; }

/* Challenge submitted state */
.wr-challenge-submitted {
    text-align: center;
    padding: 1.5rem;
}
.wr-challenge-submitted-icon {
    font-size: 2rem;
    margin-bottom: 0.5rem;
}
.wr-challenge-submitted-text {
    color: #aa66ff;
    font-family: 'Oswald', sans-serif;
    font-size: 0.9rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-bottom: 0.3rem;
}
.wr-challenge-submitted-sub {
    color: #55555f;
    font-size: 0.7rem;
    font-style: italic;
}
.wr-challenge-declined-text {
    color: #ff3344;
    font-family: 'Oswald', sans-serif;
    font-size: 0.9rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-bottom: 0.5rem;
}
`;

// ── Inject styles ───────────────────────────────────────────────────────────
function injectStyles() {
    if (document.getElementById('wager-ui-styles')) return;
    const style = document.createElement('style');
    style.id = 'wager-ui-styles';
    style.textContent = STYLES;
    document.head.appendChild(style);
}

// ── DOM refs (created in init) ──────────────────────────────────────────────
let els = {};

// ── Build all DOM ───────────────────────────────────────────────────────────
function buildDOM() {
    // 1. Wager button on start screen
    const startBtn = document.getElementById('startBtn');
    if (startBtn && !document.getElementById('wagerBtn')) {
        const btn = document.createElement('button');
        btn.id = 'wagerBtn';
        btn.textContent = 'WAGER 1v1';
        startBtn.parentNode.insertBefore(btn, startBtn.nextSibling);
    }

    // 2. Wager lobby overlay
    const lobby = document.createElement('div');
    lobby.id = 'wagerLobby';
    lobby.className = 'hidden';
    lobby.innerHTML = `
        <div class="wl-topbar">
            <div class="wl-user-group">
                <span class="wl-user" id="wlUser">---</span>
                <span class="wl-balance" id="wlBalance">-- SOL | -- USDC</span>
            </div>
            <div style="display:flex;gap:0.3rem;">
                <button class="wl-btn" id="wlWithdrawBtn">WITHDRAW</button>
                <button class="wl-btn" id="wlBack">BACK</button>
                <button class="wl-btn" id="wlLogout">LOGOUT</button>
            </div>
        </div>
        <div id="wlWalletBox" style="display:none;margin:0.5rem auto;max-width:560px;background:#12121a;border:1px solid #1e1e2a;padding:0.6rem 0.8rem;text-align:center;">
            <div style="color:#55555f;font-size:0.6rem;margin-bottom:0.3rem;font-family:'Inter',system-ui,sans-serif;text-transform:uppercase;letter-spacing:0.06em;">Your Solana Wallet</div>
            <div id="wlWalletAddr" style="background:#0a0a0f;border:1px solid #2a2a3a;padding:0.5rem;font-family:'Inter',system-ui,sans-serif;font-size:clamp(0.55rem,2vw,0.75rem);color:#00ff66;word-break:break-all;cursor:pointer;user-select:all;-webkit-user-select:all;" title="Click to copy"></div>
            <div id="wlWalletCopied" style="color:#00ff66;font-size:0.55rem;margin-top:0.2rem;min-height:1em;"></div>
        </div>
        <div id="wlWithdrawModal" class="hidden" style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:10001;display:flex;align-items:center;justify-content:center;">
            <div style="background:#12121a;border:1px solid #2a2a3a;padding:1.5rem;width:min(90%,360px);font-family:'Inter',system-ui,sans-serif;">
                <div style="color:#e8e8ec;font-weight:700;font-size:1rem;text-align:center;margin-bottom:1rem;font-family:'Oswald',sans-serif;letter-spacing:0.06em;text-transform:uppercase;">WITHDRAW FUNDS</div>
                <div style="color:#888894;font-size:0.65rem;margin-bottom:0.5rem;">Destination Solana address</div>
                <input id="wdDest" type="text" placeholder="Paste Solana wallet address" style="width:100%;padding:8px;background:#0a0a0f;border:1px solid #2a2a3a;color:#e8e8ec;font-family:inherit;font-size:0.75rem;box-sizing:border-box;margin-bottom:0.5rem;" />
                <div style="display:flex;gap:0.5rem;margin-bottom:0.5rem;">
                    <div style="flex:1;">
                        <div style="color:#888894;font-size:0.65rem;margin-bottom:0.3rem;">Amount</div>
                        <input id="wdAmount" type="number" step="0.001" placeholder="0.00" style="width:100%;padding:8px;background:#0a0a0f;border:1px solid #2a2a3a;color:#e8e8ec;font-family:inherit;font-size:0.85rem;box-sizing:border-box;" />
                    </div>
                    <div style="width:80px;">
                        <div style="color:#888894;font-size:0.65rem;margin-bottom:0.3rem;">Token</div>
                        <select id="wdToken" style="width:100%;padding:8px;background:#0a0a0f;border:1px solid #2a2a3a;color:#e8e8ec;font-family:inherit;font-size:0.85rem;">
                            <option value="SOL">SOL</option>
                            <option value="USDC">USDC</option>
                        </select>
                    </div>
                </div>
                <div id="wdStatus" style="color:#888894;font-size:0.65rem;min-height:1.2em;margin-bottom:0.5rem;text-align:center;"></div>
                <button id="wdSubmit" style="width:100%;padding:10px;background:#00ff66;border:1px solid #00ff66;color:#0a0a0f;font-weight:700;cursor:pointer;font-family:'Oswald',sans-serif;font-size:0.85rem;margin-bottom:0.5rem;text-transform:uppercase;letter-spacing:0.06em;">WITHDRAW</button>
                <button id="wdCancel" style="width:100%;padding:6px;background:none;border:none;color:#55555f;font-family:inherit;font-size:0.7rem;cursor:pointer;">Cancel</button>
            </div>
        </div>
        <div id="wlMyDuels" class="wl-my-duels hidden">
            <div class="wl-my-duels-header">YOUR OPEN DUELS</div>
            <div id="wlMyDuelsList"></div>
        </div>
        <div class="wl-header">
            <div class="wl-title"><span class="wl-pulse"></span> OPEN DUELS</div>
            <div class="wl-subtitle">Accept a challenge or post your own</div>
        </div>
        <div class="wl-table-wrap">
            <table class="wl-table">
                <thead>
                    <tr>
                        <th>Player</th>
                        <th>Record</th>
                        <th>Stake</th>
                        <th>Status</th>
                        <th></th>
                        <th></th>
                    </tr>
                </thead>
                <tbody id="wlMatches"></tbody>
            </table>
            <div class="wl-empty hidden" id="wlEmpty">No open duels. Be the first to post a challenge.</div>
        </div>
        <div class="wl-bottom">
            <button class="wl-create-btn" id="wlCreateBtn">POST DUEL</button>
        </div>
    `;
    document.body.appendChild(lobby);

    // 3. Create match modal
    const createModal = document.createElement('div');
    createModal.id = 'createMatchModal';
    createModal.className = 'hidden';
    createModal.innerHTML = `
        <div class="cm-panel">
            <h2>POST A DUEL</h2>
            <div class="cm-label">Stake Amount</div>
            <input type="number" class="cm-input" id="cmStake" placeholder="e.g. 0.05" min="0.1" step="any">
            <div class="cm-label">Token</div>
            <div class="cm-toggle-group" id="cmTokenGroup">
                <button class="cm-toggle selected" data-token="SOL">SOL</button>
                <button class="cm-toggle" data-token="USDC">USDC</button>
            </div>
            <div class="cm-label">Kill Target (First To)</div>
            <div class="cm-toggle-group" id="cmTargetGroup">
                <button class="cm-toggle" data-target="1">1</button>
                <button class="cm-toggle" data-target="5">5</button>
                <button class="cm-toggle selected" data-target="7">7</button>
                <button class="cm-toggle" data-target="10">10</button>
            </div>
            <div class="cm-label">Password (optional)</div>
            <input type="text" class="cm-input" id="cmPassword" placeholder="Leave empty for public" maxlength="32">
            <div class="cm-label" style="display:flex;align-items:center;gap:6px;">Match Mode <span class="cm-tooltip-wrap"><span class="cm-tooltip-trigger">?</span><span class="cm-tooltip-box"><strong>OPEN</strong> — Anyone can join instantly. First come, first served. Best for low-stakes or quick matches.<br><br><strong>SELECTIVE</strong> — Challengers submit requests. You review their profile, win rate, and reputation before accepting. Best for high-stakes duels where you want to vet your opponent.</span></span></div>
            <div class="cm-toggle-group" id="cmModeGroup">
                <button class="cm-toggle selected" data-mode="open">OPEN</button>
                <button class="cm-toggle" data-mode="selective">SELECTIVE</button>
            </div>
            <div class="cm-mode-hint" id="cmModeHint">First come, first served</div>
            <button class="cm-submit" id="cmSubmit">POST DUEL</button>
            <button class="cm-cancel" id="cmCancel">Cancel</button>
        </div>
    `;
    document.body.appendChild(createModal);

    // 4. Waiting room
    const waiting = document.createElement('div');
    waiting.id = 'waitingRoom';
    waiting.className = 'hidden';
    waiting.innerHTML = `
        <div class="wr-title">MATCH LOBBY</div>
        <div class="wr-info" id="wrInfo">0.01 SOL &bull; FIRST TO 5</div>
        <div class="wr-helper">Winner takes the pot. Reputation is on the line.</div>
        <div id="wrStatus" class="wr-challenge-text">OPEN CHALLENGE &mdash; WAITING FOR OPPONENT</div>
        <div class="wr-players">
            <div class="wr-card not-deposited" id="wrCreator">
                <div class="wr-avatar" id="wrCreatorAvatar" style="background:#00ff66;">?</div>
                <div class="wr-name" id="wrCreatorName">---</div>
                <div class="wr-record" id="wrCreatorRecord">0W - 0L &bull; ELO 1000</div>
                <div class="wr-status not-locked" id="wrCreatorStatus">STAKE NOT LOCKED</div>
            </div>
            <div class="wr-vs">VS</div>
            <div class="wr-card empty" id="wrJoiner">
                <div class="wr-avatar" id="wrJoinerAvatar" style="background:#2a2a3a;color:#55555f;">?</div>
                <div class="wr-name" id="wrJoinerName">OPEN CHALLENGE</div>
                <div class="wr-record" id="wrJoinerRecord">No one has taken this yet</div>
                <div class="wr-status" id="wrJoinerStatus"></div>
            </div>
        </div>
        <div class="wr-challengers hidden" id="wrChallengers">
            <div class="wr-challengers-title">CHALLENGERS</div>
            <div id="wrChallengersList"></div>
        </div>
        <div class="wr-challenge-submitted hidden" id="wrChallengeSubmitted">
            <div class="wr-challenge-submitted-text">CHALLENGE SENT</div>
            <div class="wr-challenge-submitted-sub" id="wrChallengeWaitText">Waiting for the creator to review your challenge...</div>
        </div>
        <button class="wr-deposit-btn" id="wrDepositBtn" style="display:none;">LOCK IN 0.01 SOL</button>
        <button class="wr-share-btn" id="wrShareBtn">CHALLENGE ON X</button>
        <div class="wr-note">Match begins when both players lock in.</div>
        <button class="wr-cancel" id="wrCancel">Cancel Match</button>
    `;
    document.body.appendChild(waiting);

    // 5. Wager HUD (in-game)
    const hud = document.createElement('div');
    hud.id = 'wagerHUD';
    hud.className = 'hidden';
    hud.innerHTML = `
        <div class="wh-score">
            <span class="wh-you" id="whYouScore">0</span>
            <span class="wh-sep">&mdash;</span>
            <span class="wh-opp" id="whOppScore">0</span>
        </div>
        <div class="wh-meta">
            <span class="wh-target" id="whTarget">First to 7</span>
            <span class="wh-stake" id="whStake">5 USDC on the line</span>
        </div>
    `;
    document.body.appendChild(hud);

    // 6. Wager result
    const result = document.createElement('div');
    result.id = 'wagerResult';
    result.className = 'hidden';
    result.innerHTML = `
        <div class="wr-result-bg" id="wrResultBg"></div>
        <div class="wr-result-content">
            <div class="wr-result-title" id="wrResultTitle">VICTORY</div>
            <div class="wr-result-opponent" id="wrResultOpponent"></div>
            <div class="wr-result-score" id="wrResultScore">7 - 3</div>
            <div class="wr-result-payout" id="wrResultPayout">+9.5 USDC</div>
            <div class="wr-result-tx" id="wrResultTx"></div>
            <button class="wr-result-back" id="wrResultBack">BACK TO LOBBY</button>
        </div>
    `;
    document.body.appendChild(result);

    // Cache refs
    els = {
        lobby, createModal, waiting, hud, result,
        wlUser: document.getElementById('wlUser'),
        wlBalance: document.getElementById('wlBalance'),
        wlMatches: document.getElementById('wlMatches'),
        wlEmpty: document.getElementById('wlEmpty'),
        wrInfo: document.getElementById('wrInfo'),
        wrCreatorName: document.getElementById('wrCreatorName'),
        wrCreatorRecord: document.getElementById('wrCreatorRecord'),
        wrCreator: document.getElementById('wrCreator'),
        wrJoiner: document.getElementById('wrJoiner'),
        wrJoinerName: document.getElementById('wrJoinerName'),
        wrJoinerRecord: document.getElementById('wrJoinerRecord'),
        wrJoinerStatus: document.getElementById('wrJoinerStatus'),
        wrCreatorStatus: document.getElementById('wrCreatorStatus'),
    };
}

// ── Event listeners ─────────────────────────────────────────────────────────
function bindEvents() {
    // Wager button on start screen
    document.getElementById('wagerBtn')?.addEventListener('click', () => {
        showLobby();
    });

    // Lobby buttons
    document.getElementById('wlBack')?.addEventListener('click', () => {
        hideLobby();
    });
    document.getElementById('wlLogout')?.addEventListener('click', async () => {
        await logout();
        hideLobby();
    });
    document.getElementById('wlCreateBtn')?.addEventListener('click', () => {
        showCreateMatch();
    });

    // Create match modal
    setupCreateMatchEvents();

    // Waiting room cancel
    document.getElementById('wrCancel')?.addEventListener('click', async () => {
        if (currentMatchId && _waitingRoomRole !== 'challenger') {
            // Creator or joiner cancels the match
            try { await api(`/matches/${currentMatchId}/cancel`, { method: 'POST' }); } catch (_) {}
        }
        // Challenger just leaves — their pending request stays (creator can still accept/decline)
        hideWaitingRoom();
        showLobby();
    });

    // Waiting room deposit
    document.getElementById('wrDepositBtn')?.addEventListener('click', async () => {
        const btn = document.getElementById('wrDepositBtn');
        if (!currentMatchId || btn.disabled) return;
        btn.disabled = true;
        btn.textContent = 'DEPOSITING...';
        try {
            const result = await requestDeposit(currentMatchId);
            if (result.success) {
                btn.textContent = '\u2713 LOCKED IN';
                btn.style.background = '#00cc52';
                btn.style.display = 'none';
            } else {
                showErrorModal(result.error || 'Lock-in failed. Please try again.');
                btn.textContent = 'LOCK IN';
                btn.style.background = '';
                btn.disabled = false;
            }
        } catch (e) {
            showErrorModal(e.message || 'Lock-in failed. Please try again.');
            btn.textContent = 'LOCK IN';
            btn.style.background = '';
            btn.disabled = false;
        }
    });

    // Waiting room share on X
    document.getElementById('wrShareBtn')?.addEventListener('click', () => {
        const info = currentMatchInfo || {};
        const user = getUser();
        const handle = user?.twitter_handle || 'someone';
        const stake = info.stakeAmount || '?';
        const token = info.stakeToken || 'SOL';
        const target = info.killTarget || 5;
        const text = encodeURIComponent(
            `I just posted a ${stake} ${token} duel on sNiPeRz.\nFirst to ${target}. Winner takes all.\n\nWho's taking this?\n\nhttps://sniperz.fun`
        );
        window.open('https://twitter.com/intent/tweet?text=' + text, '_blank');
    });

    // Result back button
    document.getElementById('wrResultBack')?.addEventListener('click', () => {
        els.result.classList.add('hidden');
        showLobby();
    });

    // Withdraw modal
    document.getElementById('wlWithdrawBtn')?.addEventListener('click', () => {
        document.getElementById('wlWithdrawModal')?.classList.remove('hidden');
        document.getElementById('wdStatus').textContent = '';
    });
    document.getElementById('wdCancel')?.addEventListener('click', () => {
        document.getElementById('wlWithdrawModal')?.classList.add('hidden');
    });
    document.getElementById('wdSubmit')?.addEventListener('click', async () => {
        const dest = document.getElementById('wdDest')?.value?.trim();
        const amount = parseFloat(document.getElementById('wdAmount')?.value);
        const token = document.getElementById('wdToken')?.value || 'SOL';
        const statusEl = document.getElementById('wdStatus');
        const btn = document.getElementById('wdSubmit');

        if (!dest) { statusEl.textContent = 'Enter destination address'; statusEl.style.color = '#ff3344'; return; }
        if (!amount || amount <= 0) { statusEl.textContent = 'Enter valid amount'; statusEl.style.color = '#ff3344'; return; }

        btn.disabled = true;
        btn.textContent = 'PROCESSING...';
        statusEl.textContent = 'Creating transaction...';
        statusEl.style.color = '#ff8800';

        try {
            // Step 1: Get unsigned withdrawal tx
            const txRes = await api('/wallet/withdraw-tx', {
                method: 'POST',
                body: JSON.stringify({ destination: dest, amount, token }),
            });
            if (!txRes.success) throw new Error(txRes.error);

            statusEl.textContent = 'Signing with your wallet...';
            const provider = await (await import('../dist/privy-bundle.js')).getSolanaProvider();
            if (!provider) throw new Error('Wallet not available');

            // Step 2: Sign the message
            const signResult = await provider.request({
                method: 'signMessage',
                params: { message: txRes.data.message },
            });

            statusEl.textContent = 'Submitting to Solana...';

            // Step 3: Submit
            const submitRes = await api('/wallet/submit-withdraw', {
                method: 'POST',
                body: JSON.stringify({
                    transaction: txRes.data.transaction,
                    signature: signResult?.signature || signResult,
                }),
            });
            if (!submitRes.success) throw new Error(submitRes.error);

            statusEl.textContent = 'Withdrawn! TX: ' + (submitRes.data.txSignature || '').slice(0, 20) + '...';
            statusEl.style.color = '#00ff44';
            refreshBalance();
            setTimeout(() => {
                document.getElementById('wlWithdrawModal')?.classList.add('hidden');
            }, 3000);
        } catch (e) {
            statusEl.textContent = 'Failed: ' + e.message;
            statusEl.style.color = '#ff3344';
        } finally {
            btn.disabled = false;
            btn.textContent = 'WITHDRAW';
        }
    });
}

function setupCreateMatchEvents() {
    // Token toggle
    document.querySelectorAll('#cmTokenGroup .cm-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#cmTokenGroup .cm-toggle').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
        });
    });

    // Kill target toggle
    document.querySelectorAll('#cmTargetGroup .cm-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#cmTargetGroup .cm-toggle').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
        });
    });

    // Match mode toggle
    document.querySelectorAll('#cmModeGroup .cm-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#cmModeGroup .cm-toggle').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            const hint = document.getElementById('cmModeHint');
            if (hint) {
                hint.textContent = btn.dataset.mode === 'selective'
                    ? 'Review challengers before accepting'
                    : 'First come, first served';
            }
        });
    });

    // Cancel
    document.getElementById('cmCancel')?.addEventListener('click', () => {
        els.createModal.classList.add('hidden');
    });

    // Submit
    document.getElementById('cmSubmit')?.addEventListener('click', handleCreateMatch);
}

// ── Create match handler ────────────────────────────────────────────────────
async function handleCreateMatch() {
    const submitBtn = document.getElementById('cmSubmit');
    const stakeVal = parseFloat(document.getElementById('cmStake')?.value);
    if (!stakeVal || stakeVal <= 0) return showErrorModal('Enter a valid stake amount');

    const token = document.querySelector('#cmTokenGroup .cm-toggle.selected')?.dataset.token || 'SOL';
    const killTarget = parseInt(document.querySelector('#cmTargetGroup .cm-toggle.selected')?.dataset.target || '7');
    const password = document.getElementById('cmPassword')?.value?.trim() || undefined;
    const matchMode = document.querySelector('#cmModeGroup .cm-toggle.selected')?.dataset.mode || 'open';

    submitBtn.disabled = true;
    submitBtn.textContent = 'CREATING...';

    try {
        const res = await api('/matches', {
            method: 'POST',
            body: JSON.stringify({
                stakeAmount: token === 'SOL' ? Math.round(stakeVal * 1e9) : Math.round(stakeVal * 1e6),
                stakeToken: token,
                killTarget,
                password: password || undefined,
                matchMode,
            }),
        });

        if (!res.success) throw new Error(res.error || 'Failed to create match');

        const matchId = res.data?.id || res.data?.matchId;
        if (!matchId) throw new Error('No match ID returned');
        currentMatchId = matchId;

        els.createModal.classList.add('hidden');
        showWaitingRoom(matchId);
    } catch (err) {
        showErrorModal(err.message);
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'POST DUEL';
    }
}

// ── Show / Hide lobby ───────────────────────────────────────────────────────
export async function showLobby() {
    if (!isAuthenticated()) {
        try {
            await login();
        } catch (err) {
            console.warn('Login cancelled or failed:', err);
            return;
        }
        if (!isAuthenticated()) return;
    }

    // Populate user info
    const user = getUser();
    if (user) {
        els.wlUser.textContent = '@' + (user.twitter_handle || user.display_name || 'unknown');

        // Show wallet address
        const walletBox = document.getElementById('wlWalletBox');
        const walletAddr = document.getElementById('wlWalletAddr');
        const walletCopied = document.getElementById('wlWalletCopied');
        const addr = user.privy_wallet || getWalletAddress();
        if (addr && walletBox && walletAddr) {
            walletBox.style.display = 'block';
            walletAddr.textContent = addr;
            walletAddr.onclick = () => {
                navigator.clipboard.writeText(addr).then(() => {
                    if (walletCopied) { walletCopied.textContent = 'Copied!'; setTimeout(() => walletCopied.textContent = '', 2000); }
                }).catch(() => {
                    // Fallback: select all
                    const range = document.createRange();
                    range.selectNodeContents(walletAddr);
                    window.getSelection().removeAllRanges();
                    window.getSelection().addRange(range);
                    if (walletCopied) walletCopied.textContent = 'Select all + copy manually';
                });
            };
        }
    }

    // Fetch balance
    refreshBalance();

    els.lobby.classList.remove('hidden');
    // Hide start screen
    const startModal = document.getElementById('usernameModal');
    if (startModal) startModal.style.display = 'none';

    // Start polling matches
    fetchMatches();
    lobbyInterval = setInterval(fetchMatches, 5000);
}

function hideLobby() {
    els.lobby.classList.add('hidden');
    if (lobbyInterval) { clearInterval(lobbyInterval); lobbyInterval = null; }
    // Show start screen again
    const startModal = document.getElementById('usernameModal');
    if (startModal) startModal.style.display = '';
}

async function refreshBalance() {
    try {
        const bal = await checkBalance();
        if (bal) {
            const sol = typeof bal.sol === 'number' ? bal.sol.toFixed(3) : '--';
            const usdc = typeof bal.usdc === 'number' ? bal.usdc.toFixed(2) : '--';
            els.wlBalance.textContent = `${sol} SOL | ${usdc} USDC`;
        }
    } catch (_) {}
}

// ── Fetch & render match list ───────────────────────────────────────────────
async function fetchMatches() {
    try {
        const data = await api('/matches');
        const matches = data.data || data.matches || [];
        renderMatches(Array.isArray(matches) ? matches : []);
    } catch (err) {
        console.warn('Failed to fetch matches:', err);
    }
}

async function renderMatches(matches) {
    const tbody = els.wlMatches;
    const empty = els.wlEmpty;

    // Render "My Duels" management section
    const me = getUser();
    const myId = me?.id;
    const myDuels = myId ? matches.filter(m =>
        m.creator_id === myId && ['open', 'funded_creator', 'matched'].includes(m.status)
    ) : [];
    const myDuelsEl = document.getElementById('wlMyDuels');
    const myDuelsListEl = document.getElementById('wlMyDuelsList');
    if (myDuelsEl && myDuelsListEl) {
        if (myDuels.length > 0) {
            myDuelsEl.classList.remove('hidden');
            // Fetch challenge counts for selective matches
            const challengeCounts = {};
            await Promise.all(myDuels.filter(m => m.match_mode === 'selective' && !m.joiner_id).map(async m => {
                try {
                    const res = await api(`/matches/${m.id}/challenges`);
                    challengeCounts[m.id] = (res.data || []).length;
                } catch(_) { challengeCounts[m.id] = 0; }
            }));

            myDuelsListEl.innerHTML = myDuels.map(m => {
                const token = m.stake_token || 'SOL';
                const amt = token === 'SOL' ? (m.stake_amount / 1e9) : (m.stake_amount / 1e6);
                const target = m.kill_target || 7;
                const hasJoiner = !!m.joiner_id;
                const isSelective = m.match_mode === 'selective';
                const pendingCount = challengeCounts[m.id] || 0;

                let statusClass, statusText;
                if (hasJoiner) {
                    statusClass = 'waiting'; statusText = 'MATCHED';
                } else if (isSelective && pendingCount > 0) {
                    statusClass = 'hot'; statusText = `${pendingCount} CHALLENGER${pendingCount > 1 ? 'S' : ''}`;
                } else if (isSelective) {
                    statusClass = 'open'; statusText = 'SELECTIVE';
                } else {
                    statusClass = 'open'; statusText = 'OPEN';
                }

                const resumeText = isSelective && !hasJoiner && pendingCount > 0 ? 'REVIEW' : 'RESUME';

                return `<div class="wl-my-duel-row">
                    <div class="wl-my-duel-info">
                        <span class="wl-my-duel-stake">${amt} ${token}</span>
                        <span class="wl-my-duel-target">FT${target}</span>
                        <span class="wl-my-duel-status ${statusClass}">${statusText}</span>
                    </div>
                    <div style="display:flex;gap:0.4rem;">
                        <button class="wl-my-duel-resume" data-match-id="${m.id}">${resumeText}</button>
                        <button class="wl-my-duel-cancel" data-match-id="${m.id}">CANCEL</button>
                    </div>
                </div>`;
            }).join('');
            // Bind cancel buttons
            myDuelsListEl.querySelectorAll('.wl-my-duel-cancel').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const matchId = btn.dataset.matchId;
                    btn.textContent = '...';
                    btn.disabled = true;
                    try {
                        await api(`/matches/${matchId}/cancel`, { method: 'POST' });
                    } catch(_) {}
                    fetchMatches();
                });
            });
            // Bind resume buttons
            myDuelsListEl.querySelectorAll('.wl-my-duel-resume').forEach(btn => {
                btn.addEventListener('click', () => {
                    showWaitingRoom(btn.dataset.matchId);
                });
            });
        } else {
            myDuelsEl.classList.add('hidden');
            myDuelsListEl.innerHTML = '';
        }
    }

    const openMatches = matches.filter(m => m.status === 'open' || m.status === 'funded_creator');

    if (openMatches.length === 0) {
        tbody.innerHTML = '';
        empty.classList.remove('hidden');
        return;
    }

    empty.classList.add('hidden');
    tbody.innerHTML = openMatches.map((m, i) => {
        const handle = m.creator_twitter || 'Anon';
        const record = `${m.creator_wins || 0}W-${m.creator_losses || 0}L`;
        const token = m.stake_token || 'USDC';
        const amt = token === 'SOL' ? (m.stake_amount / 1e9) : (m.stake_amount / 1e6);
        const stake = `${amt} ${token}`;
        const lock = m.passwordProtected ? ' <span class="wl-lock">&#x1f512;</span>' : '';
        const selectiveBadge = m.match_mode === 'selective' ? '<span class="wl-selective-badge">SELECTIVE</span>' : '';
        const isSelective = m.match_mode === 'selective';
        const pfp = m.creator_pfp;
        const avatarHtml = pfp
            ? `<img src="${esc(pfp)}" style="width:24px;height:24px;border-radius:50%;object-fit:cover;flex-shrink:0;">`
            : `<div style="width:24px;height:24px;border-radius:50%;background:#2a2a3a;display:flex;align-items:center;justify-content:center;font-size:0.55rem;color:#888894;flex-shrink:0;">${esc(handle[0]?.toUpperCase() || '?')}</div>`;
        const handleHtml = handle !== 'Anon'
            ? `<a href="https://x.com/${esc(handle)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;" onclick="event.stopPropagation();">@${esc(handle)}</a>`
            : 'Anon';
        // Status badge logic
        let badgeClass = 'open';
        let badgeText = 'OPEN';
        if (m.status === 'in_progress') { badgeClass = 'live'; badgeText = 'LIVE'; }
        else if (amt >= 1) { badgeClass = 'hot'; badgeText = 'HOT'; }
        else if (i === 0) { badgeClass = 'new'; badgeText = 'NEW'; }
        const actionBtn = isSelective
            ? `<button class="wl-challenge-btn" data-match-id="${esc(m.id || m.matchId)}">CHALLENGE</button>`
            : `<button class="wl-join-btn" data-match-id="${esc(m.id || m.matchId)}">JOIN</button>`;
        return `<tr>
            <td class="wl-creator"><div style="display:flex;align-items:center;gap:8px;">${avatarHtml}<span>${handleHtml}</span>${lock}${selectiveBadge}</div></td>
            <td class="wl-record">${esc(record)}</td>
            <td class="wl-stake">${esc(stake)}</td>
            <td><span class="wl-status-badge ${badgeClass}">${badgeText}</span></td>
            <td></td>
            <td>${actionBtn}</td>
        </tr>`;
    }).join('');

    // Bind join buttons
    tbody.querySelectorAll('.wl-join-btn').forEach(btn => {
        btn.addEventListener('click', () => handleJoin(btn.dataset.matchId));
    });
    // Bind challenge buttons (selective matches)
    tbody.querySelectorAll('.wl-challenge-btn').forEach(btn => {
        btn.addEventListener('click', () => handleChallenge(btn.dataset.matchId));
    });
}

function showErrorModal(message) {
    const isBalance = message && message.toLowerCase().includes('insufficient');
    const isExpired = message && message.toLowerCase().includes('expired');
    const isTimeout = message && message.toLowerCase().includes('timed out');

    let title = 'ERROR';
    let icon = '';
    let hint = '';
    let borderColor = '#ff3344';

    if (isBalance) {
        title = 'INSUFFICIENT FUNDS';
        icon = '<div style="font-size:2rem;margin-bottom:0.5rem;">⚠️</div>';
        hint = '<div style="color:#55555f;font-size:0.6rem;margin-top:0.8rem;line-height:1.4;">Deposit SOL or USDC to your wallet from the duel lobby to fund wagers.</div>';
        borderColor = '#ff8800';
    } else if (isExpired) {
        title = 'TRANSACTION EXPIRED';
        icon = '<div style="font-size:2rem;margin-bottom:0.5rem;">⏱</div>';
        hint = '<div style="color:#55555f;font-size:0.6rem;margin-top:0.8rem;">Please try locking in again.</div>';
        borderColor = '#ff8800';
    } else if (isTimeout) {
        title = 'MATCH TIMED OUT';
        icon = '<div style="font-size:2rem;margin-bottom:0.5rem;">⏱</div>';
        borderColor = '#ff8800';
    }

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(5,5,10,0.9);z-index:10002;display:flex;align-items:center;justify-content:center;font-family:"Inter",system-ui,sans-serif;';
    overlay.innerHTML = `
        <div style="background:#12121a;border:1px solid ${borderColor};padding:2rem;width:min(90%,380px);text-align:center;">
            ${icon}
            <div style="font-family:'Oswald',sans-serif;font-size:1.1rem;font-weight:700;color:${borderColor};letter-spacing:0.1em;text-transform:uppercase;margin-bottom:0.5rem;">${title}</div>
            <div style="color:#e8e8ec;font-size:0.8rem;margin-bottom:0.8rem;line-height:1.5;">${message}</div>
            ${hint}
            <button style="margin-top:1rem;padding:10px 24px;background:#1a1a25;border:1px solid #2a2a3a;color:#e8e8ec;font-family:'Inter',system-ui,sans-serif;font-size:0.75rem;cursor:pointer;text-transform:uppercase;letter-spacing:0.06em;transition:all 0.15s;">DISMISS</button>
        </div>
    `;
    document.body.appendChild(overlay);
    const dismiss = () => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); };
    overlay.querySelector('button').addEventListener('click', dismiss);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });
}

function showPasswordModal(errorMsg) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(5,5,10,0.9);z-index:10002;display:flex;align-items:center;justify-content:center;font-family:"Inter",system-ui,sans-serif;';
        overlay.innerHTML = `
            <div style="background:#12121a;border:1px solid ${errorMsg ? '#ff3344' : '#2a2a3a'};padding:2rem;width:min(90%,360px);text-align:center;transition:border-color 0.3s;">
                <div style="font-family:'Oswald',sans-serif;font-size:1.2rem;font-weight:700;color:#e8e8ec;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:0.3rem;">PRIVATE DUEL</div>
                <div style="color:#888894;font-size:0.7rem;margin-bottom:1.2rem;">This match requires a password to join</div>
                <input id="pwModalInput" type="password" placeholder="Enter password"
                    style="width:100%;padding:12px;background:#0a0a0f;border:1px solid ${errorMsg ? '#ff3344' : '#2a2a3a'};color:#e8e8ec;font-family:'Inter',system-ui,sans-serif;font-size:0.85rem;text-align:center;box-sizing:border-box;margin-bottom:0.8rem;transition:border-color 0.15s;" />
                <div id="pwModalError" style="color:#ff3344;font-size:0.65rem;min-height:1em;margin-bottom:0.6rem;">${errorMsg || ''}</div>
                <button id="pwModalSubmit" style="width:100%;padding:12px;background:#00ff66;border:none;color:#0a0a0f;font-family:'Inter',system-ui,sans-serif;font-size:0.8rem;font-weight:700;cursor:pointer;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:0.5rem;transition:opacity 0.15s;">JOIN DUEL</button>
                <div id="pwModalCancel" style="color:#55555f;font-size:0.65rem;cursor:pointer;transition:color 0.15s;">Cancel</div>
            </div>
        `;
        document.body.appendChild(overlay);
        const cleanup = () => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); };
        const input = document.getElementById('pwModalInput');
        setTimeout(() => input?.focus(), 100);

        document.getElementById('pwModalSubmit').addEventListener('click', () => {
            const val = input?.value?.trim();
            if (!val) { document.getElementById('pwModalError').textContent = 'Enter a password'; return; }
            cleanup();
            resolve(val);
        });
        input?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const val = input.value.trim();
                if (!val) return;
                cleanup();
                resolve(val);
            }
        });
        document.getElementById('pwModalCancel').addEventListener('click', () => { cleanup(); resolve(null); });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) { cleanup(); resolve(null); } });
    });
}

async function handleJoin(matchId) {
    if (!matchId) return;

    try {
        // Try joining without password first
        let res = await api(`/matches/${matchId}/join`, {
            method: 'POST',
            body: JSON.stringify({}),
        });

        // If password required, show styled modal and retry (loop on wrong password)
        if (!res.success && res.error && res.error.toLowerCase().includes('password')) {
            let errorMsg = null;
            while (true) {
                const password = await showPasswordModal(errorMsg);
                if (!password) return; // cancelled
                res = await api(`/matches/${matchId}/join`, {
                    method: 'POST',
                    body: JSON.stringify({ password }),
                });
                if (res.success) break;
                if (res.error && res.error.toLowerCase().includes('password')) {
                    errorMsg = 'Incorrect password. Try again.';
                } else {
                    errorMsg = res.error || 'Failed to join';
                    break;
                }
            }
        }

        if (!res.success) throw new Error(res.error || 'Failed to join');

        currentMatchId = matchId;
        showWaitingRoom(matchId);
    } catch (err) {
        showErrorModal(err.message);
    }
}

// ── Challenge handler (selective matches) ──────────────────────────────────
async function handleChallenge(matchId) {
    if (!matchId) return;

    try {
        const res = await api(`/matches/${matchId}/challenge`, {
            method: 'POST',
            body: JSON.stringify({}),
        });

        if (!res.success) throw new Error(res.error || 'Failed to submit challenge');

        currentMatchId = matchId;
        showWaitingRoom(matchId, 'challenger');
        showToast('Challenge sent! Waiting for the creator to accept.');
    } catch (err) {
        showErrorModal(err.message);
    }
}

function showToast(message) {
    const toast = document.createElement('div');
    toast.style.cssText = 'position:fixed;bottom:2rem;left:50%;transform:translateX(-50%);background:#12121a;border:1px solid #aa66ff;color:#aa66ff;padding:0.6rem 1.4rem;font-family:"Inter",system-ui,sans-serif;font-size:0.75rem;z-index:10003;letter-spacing:0.02em;animation:floatUp 0.3s ease-out;';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 4000);
}

// ── Create match modal ──────────────────────────────────────────────────────
export function showCreateMatch() {
    // Reset fields
    const stakeInput = document.getElementById('cmStake');
    if (stakeInput) stakeInput.value = '';
    const pwInput = document.getElementById('cmPassword');
    if (pwInput) pwInput.value = '';

    // Reset mode toggle to OPEN
    document.querySelectorAll('#cmModeGroup .cm-toggle').forEach(b => {
        b.classList.toggle('selected', b.dataset.mode === 'open');
    });
    const hint = document.getElementById('cmModeHint');
    if (hint) hint.textContent = 'First come, first served';

    els.createModal.classList.remove('hidden');
}

// ── Waiting room ────────────────────────────────────────────────────────────
let _waitingRoomRole = null; // 'creator', 'challenger', or null (joiner in open mode)
let challengePollingInterval = null;

export function showWaitingRoom(matchId, role) {
    currentMatchId = matchId;
    _waitingRoomRole = role || null;
    // Hide lobby but don't restore start screen
    els.lobby.classList.add('hidden');
    if (lobbyInterval) { clearInterval(lobbyInterval); lobbyInterval = null; }
    els.waiting.classList.remove('hidden');

    // Reset challenge UI
    const challengersEl = document.getElementById('wrChallengers');
    const challengeSubmittedEl = document.getElementById('wrChallengeSubmitted');
    if (challengersEl) challengersEl.classList.add('hidden');
    if (challengeSubmittedEl) challengeSubmittedEl.classList.add('hidden');

    // Populate with current info from create form (best effort)
    pollWaitingRoom(matchId);
    waitingInterval = setInterval(() => pollWaitingRoom(matchId), 3000);
}

function hideWaitingRoom() {
    els.waiting.classList.add('hidden');
    if (waitingInterval) { clearInterval(waitingInterval); waitingInterval = null; }
    if (challengePollingInterval) { clearInterval(challengePollingInterval); challengePollingInterval = null; }
    _waitingRoomRole = null;
    currentMatchId = null;
}

async function pollWaitingRoom(matchId) {
    try {
        const data = await api(`/matches/${matchId}`);
        if (!data.success) return;

        const m = data.data || data;
        const me = getUser();
        const amCreator = me && m.creator_id === me.id;

        // Store match info for HUD and result screen
        const wrToken = m.stake_token || 'USDC';
        const wrAmt = wrToken === 'SOL' ? (m.stake_amount / 1e9) : (m.stake_amount / 1e6);
        currentMatchInfo = {
            stakeAmount: wrAmt,
            stakeToken: wrToken,
            killTarget: m.kill_target || 7,
            matchMode: m.match_mode || 'open',
            creatorTwitter: m.creator_twitter,
            creatorPfp: m.creator_pfp,
            joinerTwitter: m.joiner_twitter,
            joinerPfp: m.joiner_pfp,
            opponentTwitter: amCreator ? m.joiner_twitter : m.creator_twitter,
        };
        els.wrInfo.innerHTML = `${wrAmt} ${wrToken} &bull; FIRST TO ${m.kill_target || 7}`;

        // Determine who has deposited
        const creatorFunded = ['funded_creator', 'funded_both'].includes(m.status);
        const joinerFunded = ['funded_joiner', 'funded_both'].includes(m.status);
        const myDeposited = amCreator ? creatorFunded : joinerFunded;

        // Status message
        let statusMsg = m.status;
        if (m.status === 'open' && m.match_mode === 'selective' && amCreator) statusMsg = 'SELECTIVE DUEL \u2014 REVIEWING CHALLENGERS';
        else if (m.status === 'open') statusMsg = 'OPEN CHALLENGE \u2014 WAITING FOR OPPONENT';
        else if (m.status === 'matched') statusMsg = 'OPPONENT JOINED \u2014 LOCK IN TO START';
        else if (m.status === 'funded_creator') statusMsg = amCreator ? 'YOU\'RE LOCKED IN \u2014 WAITING ON OPPONENT' : 'OPPONENT LOCKED IN \u2014 YOUR MOVE';
        else if (m.status === 'funded_joiner') statusMsg = amCreator ? 'OPPONENT LOCKED IN \u2014 YOUR MOVE' : 'YOU\'RE LOCKED IN \u2014 WAITING ON OPPONENT';
        else if (m.status === 'funded_both') statusMsg = 'BOTH LOCKED \u2014 STARTING MATCH...';
        else if (m.status === 'in_progress') statusMsg = 'MATCH IN PROGRESS';
        const statusEl = document.getElementById('wrStatus');
        if (statusEl) statusEl.textContent = statusMsg;

        // Helper: generate avatar initial + color
        const avatarColor = (name) => {
            const colors = ['#00ff66','#ff8800','#00bbff','#ff3366','#aa66ff','#ffcc00','#00ffcc'];
            let hash = 0;
            for (let i = 0; i < (name||'').length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
            return colors[Math.abs(hash) % colors.length];
        };
        const avatarInitial = (name) => (name || '?')[0].toUpperCase();

        // Creator card
        const creatorHandle = m.creator_twitter || 'unknown';
        els.wrCreatorName.textContent = '@' + creatorHandle;
        els.wrCreatorRecord.textContent = `${m.creator_wins || 0}W - ${m.creator_losses || 0}L \u2022 ELO ${m.creator_elo || 1000}`;
        const creatorAvatarEl = document.getElementById('wrCreatorAvatar');
        if (creatorAvatarEl) {
            if (m.creator_pfp) {
                creatorAvatarEl.textContent = '';
                creatorAvatarEl.style.background = `url(${m.creator_pfp}) center/cover`;
            } else {
                creatorAvatarEl.style.background = avatarColor(creatorHandle);
                creatorAvatarEl.textContent = avatarInitial(creatorHandle);
            }
        }
        els.wrCreator.classList.remove('funded', 'awaiting', 'not-deposited');
        if (creatorFunded) {
            els.wrCreator.classList.add('funded');
        } else if (m.joiner_id) {
            els.wrCreator.classList.add('awaiting');
        } else {
            els.wrCreator.classList.add('not-deposited');
        }
        if (els.wrCreatorStatus) {
            els.wrCreatorStatus.textContent = creatorFunded ? 'LOCKED IN \u2713' : (m.joiner_id ? 'AWAITING LOCK-IN' : 'STAKE NOT LOCKED');
            els.wrCreatorStatus.className = 'wr-status ' + (creatorFunded ? 'locked' : (m.joiner_id ? 'waiting' : 'not-locked'));
        }

        // Joiner card
        const joinerAvatarEl = document.getElementById('wrJoinerAvatar');
        if (m.joiner_id) {
            const joinerHandle = m.joiner_twitter || 'unknown';
            els.wrJoiner.classList.remove('empty', 'funded', 'awaiting', 'not-deposited');
            els.wrJoinerName.textContent = '@' + joinerHandle;
            els.wrJoinerRecord.textContent = `${m.joiner_wins || 0}W - ${m.joiner_losses || 0}L \u2022 ELO ${m.joiner_elo || 1000}`;
            if (joinerAvatarEl) {
                if (m.joiner_pfp) {
                    joinerAvatarEl.textContent = '';
                    joinerAvatarEl.style.color = 'transparent';
                    joinerAvatarEl.style.background = `url(${m.joiner_pfp}) center/cover`;
                } else {
                    joinerAvatarEl.style.background = avatarColor(joinerHandle);
                    joinerAvatarEl.style.color = '#0a0a0f';
                    joinerAvatarEl.textContent = avatarInitial(joinerHandle);
                }
            }
            if (joinerFunded) {
                els.wrJoiner.classList.add('funded');
            } else {
                els.wrJoiner.classList.add('awaiting');
            }
            if (els.wrJoinerStatus) {
                els.wrJoinerStatus.textContent = joinerFunded ? 'LOCKED IN \u2713' : 'AWAITING LOCK-IN';
                els.wrJoinerStatus.className = 'wr-status ' + (joinerFunded ? 'locked' : 'waiting');
            }
        } else {
            els.wrJoiner.classList.remove('funded', 'awaiting', 'not-deposited');
            els.wrJoiner.classList.add('empty');
            els.wrJoinerName.textContent = 'OPEN CHALLENGE';
            els.wrJoinerRecord.textContent = 'No one has taken this yet';
            if (joinerAvatarEl) {
                joinerAvatarEl.style.background = '#2a2a3a';
                joinerAvatarEl.style.color = '#55555f';
                joinerAvatarEl.textContent = '?';
            }
            if (els.wrJoinerStatus) {
                els.wrJoinerStatus.textContent = '';
                els.wrJoinerStatus.className = 'wr-status';
            }
        }

        // Show/hide deposit button
        const depositBtn = document.getElementById('wrDepositBtn');
        if (depositBtn) {
            const hasOpponent = !!m.joiner_id;
            const showDeposit = hasOpponent && !myDeposited && m.status !== 'funded_both';
            depositBtn.style.display = showDeposit ? 'block' : 'none';
            depositBtn.textContent = `LOCK IN ${wrAmt} ${wrToken}`;
            depositBtn.disabled = false;
            depositBtn.style.background = '#00ff66';
        }

        // === Selective mode UI ===
        const challengersEl = document.getElementById('wrChallengers');
        const challengeSubmittedEl = document.getElementById('wrChallengeSubmitted');
        const isSelective = m.match_mode === 'selective';

        if (isSelective && !m.joiner_id) {
            if (amCreator) {
                // Creator: show challengers list, poll for challenges
                if (challengeSubmittedEl) challengeSubmittedEl.classList.add('hidden');
                if (challengersEl) challengersEl.classList.remove('hidden');
                pollChallengersList(matchId);
                if (!challengePollingInterval) {
                    challengePollingInterval = setInterval(() => pollChallengersList(matchId), 3000);
                }
            } else if (_waitingRoomRole === 'challenger') {
                // Challenger: show "challenge submitted" state
                if (challengersEl) challengersEl.classList.add('hidden');
                if (challengeSubmittedEl) {
                    challengeSubmittedEl.classList.remove('hidden');
                    const waitText = document.getElementById('wrChallengeWaitText');
                    if (waitText) waitText.textContent = `Waiting for @${m.creator_twitter || 'creator'} to review your challenge...`;
                }
            }
        } else {
            // Not selective or already matched — hide challenge UI
            if (challengersEl) challengersEl.classList.add('hidden');
            if (challengeSubmittedEl) challengeSubmittedEl.classList.add('hidden');
            if (challengePollingInterval) { clearInterval(challengePollingInterval); challengePollingInterval = null; }
        }

        // Challenger got declined or expired — poll challenge request status
        if (isSelective && _waitingRoomRole === 'challenger' && !m.joiner_id) {
            try {
                const challengeRes = await api(`/matches/${matchId}/my-challenge`);
                if (challengeRes.success) {
                    const challengeStatus = (challengeRes.data || {}).status;
                    if (challengeStatus === 'declined') {
                        const waitText = document.getElementById('wrChallengeWaitText');
                        if (waitText) waitText.textContent = 'Your challenge was declined.';
                        setTimeout(() => { hideWaitingRoom(); showLobby(); }, 2000);
                        return;
                    }
                    if (challengeStatus === 'expired') {
                        const waitText = document.getElementById('wrChallengeWaitText');
                        if (waitText) waitText.textContent = 'Challenge expired.';
                        setTimeout(() => { hideWaitingRoom(); showLobby(); }, 2000);
                        return;
                    }
                }
            } catch(_) {}
        }

        // Challenger got accepted — they become joiner
        if (isSelective && _waitingRoomRole === 'challenger' && m.joiner_id && me && m.joiner_id === me.id) {
            // We got accepted! Hide challenge submitted, show normal matched state
            if (challengeSubmittedEl) challengeSubmittedEl.classList.add('hidden');
            _waitingRoomRole = null; // Now we're a normal joiner
        }

        // Both funded — start the match
        if (m.status === 'funded_both') {
            hideWaitingRoom();
            connectWagerMatch(matchId);
        }

        // Cancelled or expired
        if (m.status === 'cancelled' || m.status === 'expired') {
            hideWaitingRoom();
            showLobby();
        }
    } catch (err) {
        console.warn('Waiting room poll error:', err);
    }
}

// ── Challenge list polling (for selective match creators) ───────────────────
async function pollChallengersList(matchId) {
    try {
        const data = await api(`/matches/${matchId}/challenges`);
        if (!data.success) return;

        const challenges = data.data || [];
        const listEl = document.getElementById('wrChallengersList');
        if (!listEl) return;

        if (challenges.length === 0) {
            listEl.innerHTML = '<div class="wr-challengers-empty">No challengers yet. Share your duel to attract opponents.</div>';
            return;
        }

        const avatarColor = (name) => {
            const colors = ['#00ff66','#ff8800','#00bbff','#ff3366','#aa66ff','#ffcc00','#00ffcc'];
            let hash = 0;
            for (let i = 0; i < (name||'').length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
            return colors[Math.abs(hash) % colors.length];
        };

        listEl.innerHTML = challenges.map(c => {
            const handle = c.twitter_handle || 'unknown';
            const avatarHtml = c.profile_picture
                ? `<div class="wr-challenger-avatar" style="background:url(${esc(c.profile_picture)}) center/cover;"></div>`
                : `<div class="wr-challenger-avatar" style="background:${avatarColor(handle)};">${esc(handle[0]?.toUpperCase() || '?')}</div>`;
            const handleLink = handle !== 'unknown'
                ? `<a href="https://x.com/${esc(handle)}" target="_blank" rel="noopener">@${esc(handle)}</a>`
                : '@unknown';
            return `<div class="wr-challenger-row">
                ${avatarHtml}
                <div class="wr-challenger-info">
                    <div class="wr-challenger-handle">${handleLink}</div>
                    <div class="wr-challenger-stats">${c.wins || 0}W - ${c.losses || 0}L &bull; ELO ${c.elo || 1000}</div>
                </div>
                <div class="wr-challenger-actions">
                    <button class="wr-challenger-accept" data-request-id="${esc(c.id)}">ACCEPT</button>
                    <button class="wr-challenger-decline" data-request-id="${esc(c.id)}">DECLINE</button>
                </div>
            </div>`;
        }).join('');

        // Bind accept/decline buttons
        listEl.querySelectorAll('.wr-challenger-accept').forEach(btn => {
            btn.addEventListener('click', async () => {
                btn.textContent = '...';
                btn.disabled = true;
                try {
                    const res = await api(`/matches/${matchId}/challenges/${btn.dataset.requestId}/accept`, { method: 'POST' });
                    if (!res.success) throw new Error(res.error);
                    // Match is now matched, normal flow takes over via pollWaitingRoom
                } catch (e) {
                    showErrorModal('Failed to accept: ' + e.message);
                    btn.textContent = 'ACCEPT';
                    btn.disabled = false;
                }
            });
        });
        listEl.querySelectorAll('.wr-challenger-decline').forEach(btn => {
            btn.addEventListener('click', async () => {
                btn.textContent = '...';
                btn.disabled = true;
                try {
                    const res = await api(`/matches/${matchId}/challenges/${btn.dataset.requestId}/decline`, { method: 'POST' });
                    if (!res.success) throw new Error(res.error);
                    // Refresh list
                    pollChallengersList(matchId);
                } catch (e) {
                    showErrorModal('Failed to decline: ' + e.message);
                    btn.textContent = 'DECLINE';
                    btn.disabled = false;
                }
            });
        });
    } catch (err) {
        console.warn('Failed to poll challengers:', err);
    }
}

// ── Wager HUD ───────────────────────────────────────────────────────────────
export function showWagerHUD(matchData) {
    const whTarget = document.getElementById('whTarget');
    const whStake = document.getElementById('whStake');
    const info = currentMatchInfo || {};
    if (whTarget) whTarget.textContent = `First to ${info.killTarget || matchData.killTarget || 7}`;
    if (whStake) whStake.textContent = `${info.stakeAmount || '?'} ${info.stakeToken || 'USDC'} on the line`;
    document.getElementById('whYouScore').textContent = '0';
    document.getElementById('whOppScore').textContent = '0';
    els.hud.classList.remove('hidden');
}

export function updateWagerScore(myKills, opponentKills) {
    const youEl = document.getElementById('whYouScore');
    const oppEl = document.getElementById('whOppScore');
    if (youEl) youEl.textContent = myKills;
    if (oppEl) oppEl.textContent = opponentKills;
}
// Expose to game.js for kill event updates
window._updateWagerScoreFromKill = updateWagerScore;

function hideWagerHUD() {
    els.hud.classList.add('hidden');
}

// ── Wager result ────────────────────────────────────────────────────────────
export function showWagerResult(data) {
    hideWagerHUD();

    const titleEl = document.getElementById('wrResultTitle');
    const scoreEl = document.getElementById('wrResultScore');
    const payoutEl = document.getElementById('wrResultPayout');
    const txEl = document.getElementById('wrResultTx');

    const me = getUser();
    const info = currentMatchInfo || {};
    const won = data.winner === me?.id || data.result === 'win' || data.won;
    const isDraw = !data.winner && data.reason === 'draw';

    titleEl.textContent = isDraw ? 'DRAW' : (won ? 'VICTORY' : 'DEFEAT');
    titleEl.className = 'wr-result-title ' + (isDraw ? 'draw' : (won ? 'victory' : 'defeat'));

    // Background glow matches result
    const bgEl = document.getElementById('wrResultBg');
    if (bgEl) bgEl.className = 'wr-result-bg ' + (isDraw ? 'draw-bg' : (won ? 'victory-bg' : 'defeat-bg'));

    // Score from wager HUD
    const myScore = document.getElementById('whYouScore')?.textContent || '0';
    const oppScore = document.getElementById('whOppScore')?.textContent || '0';
    scoreEl.textContent = `${myScore} - ${oppScore}`;

    // Opponent info
    const oppEl = document.getElementById('wrResultOpponent');
    if (oppEl) oppEl.textContent = info.opponentTwitter ? 'vs @' + info.opponentTwitter : '';

    const stakeAmt = info.stakeAmount || '?';
    const stakeTok = info.stakeToken || 'USDC';
    const potTotal = (parseFloat(stakeAmt) || 0) * 2;
    const payoutRaw = potTotal * 0.95;
    // Smart formatting: show enough decimals to be meaningful
    const formatAmt = (v) => {
        if (v === 0) return '0';
        if (v >= 1) return v.toFixed(2);
        if (v >= 0.01) return v.toFixed(4);
        return v.toFixed(6);
    };

    if (isDraw) {
        payoutEl.textContent = `REFUNDED ${formatAmt(parseFloat(stakeAmt) || 0)} ${stakeTok}`;
        payoutEl.className = 'wr-result-payout draw-payout';
    } else if (won) {
        payoutEl.textContent = `+${formatAmt(payoutRaw)} ${stakeTok}`;
        payoutEl.className = 'wr-result-payout win';
    } else {
        payoutEl.textContent = `-${formatAmt(parseFloat(stakeAmt) || 0)} ${stakeTok}`;
        payoutEl.className = 'wr-result-payout loss';
    }

    if (data.txSignature) {
        txEl.innerHTML = `<a href="https://solscan.io/tx/${esc(data.txSignature)}" target="_blank" rel="noopener">View on Solscan</a>`;
    } else {
        txEl.innerHTML = '';
    }

    els.result.classList.remove('hidden');
}

// ── WebSocket connection ────────────────────────────────────────────────────
export function connectWagerMatch(matchId) {
    if (wagerWs) {
        try { wagerWs.close(); } catch (_) {}
    }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}`);
    wagerWs = ws;
    currentMatchId = matchId;

    ws.addEventListener('open', () => {
        wagerReconnectAttempts = 0;
        ws.send(JSON.stringify({
            t: 'wager_auth',
            token: getToken(),
            matchId,
        }));
    });

    ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }

        switch (msg.t) {
            case 'wager_authed':
                // Authenticated — send ready
                ws.send(JSON.stringify({ t: 'wager_ready' }));
                break;
            case 'wager_lobby':
                // Match info update while in lobby/waiting
                break;

            case 'wager_start': {
                // Stop all polling
                if (lobbyInterval) { clearInterval(lobbyInterval); lobbyInterval = null; }
                if (waitingInterval) { clearInterval(waitingInterval); waitingInterval = null; }

                // Hide all overlays
                els.lobby.classList.add('hidden');
                els.waiting.classList.add('hidden');
                els.createModal.classList.add('hidden');
                const startModal = document.getElementById('usernameModal');
                if (startModal) startModal.style.display = 'none';

                // Determine if we're creator or joiner
                const me = getUser();
                const isCreator = me && msg.creatorId === me.id;

                // Start the actual game via game.js integration
                window._wagerUser = me;
                if (window._startWagerGame) {
                    window._startWagerGame(ws, {
                        matchId: msg.matchId,
                        killTarget: msg.killTarget,
                        isCreator,
                    });
                }

                showWagerHUD(msg);
                break;
            }

            case 'wager_score':
                updateWagerScore(msg.ck ?? 0, msg.jk ?? 0);
                break;

            case 'wager_end':
                showWagerResult(msg);
                break;

            case 'wager_dc': {
                // Opponent disconnected — show overlay with countdown
                let overlay = document.getElementById('wagerDcOverlay');
                if (!overlay) {
                    overlay = document.createElement('div');
                    overlay.id = 'wagerDcOverlay';
                    overlay.style.cssText = 'position:fixed;top:20%;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.85);color:#ff4444;padding:1rem 2rem;border:1px solid #ff4444;font-family:Inter,system-ui,sans-serif;font-size:0.9rem;z-index:9999;text-align:center;border-radius:4px;';
                    document.body.appendChild(overlay);
                }
                overlay.textContent = 'Opponent disconnected \u2014 ' + msg.remaining + 's to rejoin';
                overlay.style.display = 'block';
                break;
            }

            case 'wager_rc': {
                // Player reconnected — hide the overlay
                const dcOverlay = document.getElementById('wagerDcOverlay');
                if (dcOverlay) dcOverlay.style.display = 'none';
                break;
            }

            case 'wager_timeout':
                hideWagerHUD();
                showErrorModal('Match timed out.');
                showLobby();
                break;

            case 'error':
                console.warn('[wager ws] Error:', msg.msg);
                break;
        }
    });

    ws.addEventListener('close', () => {
        wagerWs = null;
        // Auto-reconnect if we're in an active wager match
        if (currentMatchId && wagerReconnectAttempts < WAGER_MAX_RECONNECTS) {
            wagerReconnectAttempts++;
            console.log('[wager ws] Disconnected, reconnect attempt ' + wagerReconnectAttempts + '/' + WAGER_MAX_RECONNECTS);
            setTimeout(() => {
                if (currentMatchId) {
                    connectWagerMatch(currentMatchId);
                }
            }, WAGER_RECONNECT_DELAY);
        }
    });

    ws.addEventListener('error', (err) => {
        console.warn('Wager WebSocket error:', err);
    });

    return ws;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function esc(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
}

// ── Public init ─────────────────────────────────────────────────────────────
export function initWagerUI() {
    injectStyles();
    buildDOM();
    bindEvents();

    // Auto-show lobby if already authenticated (e.g., after OAuth redirect)
    if (isAuthenticated()) {
        setTimeout(() => showLobby(), 100);
    }
}

export default {
    initWagerUI,
    showLobby,
    showCreateMatch,
    showWaitingRoom,
    showWagerHUD,
    updateWagerScore,
    showWagerResult,
    connectWagerMatch,
};
