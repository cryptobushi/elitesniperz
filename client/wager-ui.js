// wager-ui.js — Wager lobby, create match, waiting room, and in-game HUD
import { isAuthenticated, getUser, getToken, login, logout } from './privy-client.js';
import { requestDeposit, checkBalance } from './deposit-flow.js';

// ── API helper ──────────────────────────────────────────────────────────────
async function api(path, options = {}) {
    const token = getToken();
    const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) };
    const res = await fetch('/api' + path, { ...options, headers });
    return res.json();
}

// ── State ───────────────────────────────────────────────────────────────────
let lobbyInterval = null;
let waitingInterval = null;
let wagerWs = null;
let currentMatchId = null;

// ── Styles ──────────────────────────────────────────────────────────────────
const STYLES = `
/* === WAGER LOBBY === */
#wagerLobby {
    position: fixed;
    top: 0; left: 0;
    width: 100%; height: 100%;
    background: linear-gradient(180deg, #0a0a1a 0%, #000 50%, #0a0a1a 100%);
    z-index: 500;
    display: flex;
    flex-direction: column;
    align-items: center;
    font-family: 'Courier New', monospace;
    overflow-y: auto;
}
#wagerLobby.hidden { display: none !important; }

.wl-topbar {
    width: 100%;
    max-width: 600px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.6rem 1rem;
    border-bottom: 2px solid #4444aa;
    background: rgba(26,26,58,0.6);
    flex-shrink: 0;
}
.wl-topbar .wl-user {
    color: #8888cc;
    font-size: 0.75rem;
    font-weight: bold;
}
.wl-topbar .wl-balance {
    color: #ffcc00;
    font-size: 0.75rem;
    font-weight: bold;
    text-shadow: 0 0 6px rgba(255,200,0,0.3);
}
.wl-topbar .wl-btn {
    background: linear-gradient(180deg, #333 0%, #1a1a1a 100%);
    border: 2px outset #666;
    color: #ccc;
    padding: 0.3rem 0.7rem;
    font-size: 0.65rem;
    font-family: 'Courier New', monospace;
    cursor: pointer;
    text-transform: uppercase;
}
.wl-topbar .wl-btn:active { border-style: inset; }

.wl-title {
    color: #ffcc00;
    font-family: 'Impact', 'Arial Black', sans-serif;
    font-size: clamp(1.2rem, 5vw, 1.8rem);
    text-shadow: 2px 2px 0 #000, -1px -1px 0 #885500, 0 0 20px rgba(255,200,0,0.4);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin: 0.6rem 0 0.3rem;
    flex-shrink: 0;
}

.wl-subtitle {
    color: #8888cc;
    font-size: 0.6rem;
    font-style: italic;
    margin-bottom: 0.6rem;
    flex-shrink: 0;
}

/* Match table */
.wl-table-wrap {
    width: 100%;
    max-width: 600px;
    flex: 1;
    overflow-y: auto;
    padding: 0 0.5rem;
}
.wl-table {
    width: 100%;
    border-collapse: collapse;
}
.wl-table th {
    color: #666;
    font-size: 0.55rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 6px 8px;
    border-bottom: 1px solid #333;
    text-align: left;
    position: sticky;
    top: 0;
    background: #0a0a1a;
}
.wl-table td {
    padding: 8px;
    font-size: 0.7rem;
    border-bottom: 1px solid #1a1a2a;
    color: #ccc;
}
.wl-table tr:hover { background: rgba(68,68,170,0.1); }
.wl-table .wl-creator { color: #8888cc; font-weight: bold; }
.wl-table .wl-record { color: #888; }
.wl-table .wl-stake { color: #ffcc00; font-weight: bold; }
.wl-table .wl-target { color: #00ff44; }
.wl-table .wl-lock { font-size: 0.8rem; }
.wl-join-btn {
    background: linear-gradient(180deg, #ffdd44 0%, #cc8800 50%, #ffdd44 100%);
    border: 2px outset #ffcc00;
    color: #000;
    padding: 0.3rem 0.8rem;
    font-size: 0.65rem;
    font-weight: bold;
    font-family: 'Impact', 'Arial Black', sans-serif;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.05em;
}
.wl-join-btn:active { border-style: inset; opacity: 0.9; }

.wl-empty {
    color: #555;
    text-align: center;
    padding: 2rem;
    font-size: 0.75rem;
    font-style: italic;
}

.wl-bottom {
    width: 100%;
    max-width: 600px;
    padding: 0.6rem 1rem;
    border-top: 2px solid #4444aa;
    display: flex;
    justify-content: center;
    flex-shrink: 0;
}
.wl-create-btn {
    background: linear-gradient(180deg, #ffdd44 0%, #cc8800 50%, #ffdd44 100%);
    border: 2px outset #ffcc00;
    color: #000;
    padding: 0.6rem 2rem;
    font-size: 0.9rem;
    font-weight: bold;
    font-family: 'Impact', 'Arial Black', sans-serif;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    text-shadow: 1px 1px 0 rgba(255,255,255,0.3);
}
.wl-create-btn:active { border-style: inset; opacity: 0.9; }

/* === CREATE MATCH MODAL === */
#createMatchModal {
    position: fixed;
    top: 0; left: 0;
    width: 100%; height: 100%;
    z-index: 510;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0,0,0,0.7);
}
#createMatchModal.hidden { display: none !important; }

.cm-panel {
    background: linear-gradient(180deg, #1a1a3a 0%, #0a0a1a 50%, #1a1a3a 100%);
    border: 3px outset #4444aa;
    box-shadow: 0 0 0 1px #000, 0 0 0 3px #222266, inset 0 0 30px rgba(0,0,80,0.3);
    padding: 1.2rem;
    width: min(92%, 380px);
    font-family: 'Courier New', monospace;
    text-align: center;
}
.cm-panel h2 {
    color: #ffcc00;
    font-family: 'Impact', 'Arial Black', sans-serif;
    font-size: 1.2rem;
    text-shadow: 2px 2px 0 #000, 0 0 10px rgba(255,200,0,0.3);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-bottom: 0.8rem;
}
.cm-label {
    color: #8888cc;
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    text-align: left;
    margin-bottom: 0.3rem;
    margin-top: 0.6rem;
}
.cm-input {
    background: #000;
    border: 2px inset #555;
    color: #fff;
    padding: 0.5rem 0.6rem;
    font-size: 0.85rem;
    font-family: 'Courier New', monospace;
    width: 100%;
    -webkit-appearance: none;
    border-radius: 0;
}
.cm-input::placeholder { color: #555; font-style: italic; }

.cm-toggle-group {
    display: flex;
    gap: 0.4rem;
    margin-top: 0.3rem;
}
.cm-toggle {
    flex: 1;
    background: linear-gradient(180deg, #333 0%, #1a1a1a 100%);
    border: 2px outset #666;
    color: #888;
    padding: 0.45rem;
    font-size: 0.75rem;
    font-family: 'Courier New', monospace;
    font-weight: bold;
    cursor: pointer;
    text-transform: uppercase;
}
.cm-toggle:active { border-style: inset; }
.cm-toggle.selected {
    background: linear-gradient(180deg, #2a2a1a 0%, #1a1a00 100%);
    border-color: #ffcc00;
    color: #ffcc00;
}

.cm-submit {
    margin-top: 1rem;
    background: linear-gradient(180deg, #ffdd44 0%, #cc8800 50%, #ffdd44 100%);
    border: 2px outset #ffcc00;
    color: #000;
    padding: 0.6rem;
    font-size: 0.85rem;
    font-weight: bold;
    font-family: 'Impact', 'Arial Black', sans-serif;
    cursor: pointer;
    width: 100%;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    text-shadow: 1px 1px 0 rgba(255,255,255,0.3);
}
.cm-submit:active { border-style: inset; opacity: 0.9; }
.cm-submit:disabled {
    opacity: 0.5;
    cursor: default;
}

.cm-cancel {
    margin-top: 0.5rem;
    background: none;
    border: 1px solid #444;
    color: #888;
    padding: 0.4rem 1rem;
    font-size: 0.65rem;
    font-family: 'Courier New', monospace;
    cursor: pointer;
    text-transform: uppercase;
}
.cm-cancel:hover { color: #ccc; border-color: #888; }

/* === WAITING ROOM === */
#waitingRoom {
    position: fixed;
    top: 0; left: 0;
    width: 100%; height: 100%;
    background: linear-gradient(180deg, #0a0a1a 0%, #000 50%, #0a0a1a 100%);
    z-index: 520;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    font-family: 'Courier New', monospace;
}
#waitingRoom.hidden { display: none !important; }

.wr-title {
    color: #ffcc00;
    font-family: 'Impact', 'Arial Black', sans-serif;
    font-size: clamp(1rem, 4vw, 1.5rem);
    text-shadow: 2px 2px 0 #000, 0 0 10px rgba(255,200,0,0.3);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-bottom: 0.4rem;
}
.wr-info {
    color: #8888cc;
    font-size: 0.7rem;
    margin-bottom: 1.2rem;
}
.wr-players {
    display: flex;
    gap: 1.5rem;
    align-items: center;
    margin-bottom: 1.5rem;
}
.wr-card {
    background: rgba(26,26,58,0.4);
    border: 2px solid #4444aa;
    padding: 1rem 1.5rem;
    min-width: 140px;
    text-align: center;
    border-radius: 2px;
}
.wr-card.funded { border-color: #00ff44; }
.wr-card.empty {
    border-style: dashed;
    border-color: #333;
}
.wr-card .wr-name {
    color: #ccc;
    font-size: 0.8rem;
    font-weight: bold;
    margin-bottom: 0.3rem;
}
.wr-card .wr-record {
    color: #888;
    font-size: 0.6rem;
}
.wr-card .wr-status {
    margin-top: 0.4rem;
    font-size: 0.65rem;
}
.wr-card .wr-status.ok { color: #00ff44; }
.wr-card .wr-status.pending { color: #ffcc00; }
.wr-card.empty .wr-name { color: #555; }

.wr-vs {
    color: #ffcc00;
    font-family: 'Impact', 'Arial Black', sans-serif;
    font-size: 1.5rem;
    text-shadow: 0 0 10px rgba(255,200,0,0.3);
}

.wr-dots {
    color: #ffcc00;
    font-size: 1rem;
    margin-bottom: 1rem;
    animation: blink2k 1s step-end infinite;
}

.wr-cancel {
    background: none;
    border: 1px solid #8b000066;
    color: #8b0000;
    padding: 0.5rem 1.5rem;
    font-family: 'Courier New', monospace;
    font-size: 0.7rem;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    transition: all 0.2s;
}
.wr-cancel:hover { border-color: #cc0000; color: #ff2222; }

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
    font-family: 'Courier New', monospace;
}
#wagerHUD.hidden { display: none !important; }

.wh-score {
    background: rgba(0,0,0,0.8);
    border: 1px solid #ffcc0066;
    border-radius: 6px;
    padding: 4px 20px;
    display: flex;
    align-items: baseline;
    gap: 12px;
}
.wh-score .wh-you {
    color: #00ff44;
    font-size: clamp(1rem, 4vw, 1.6rem);
    font-weight: 900;
}
.wh-score .wh-sep {
    color: #555;
    font-size: clamp(0.8rem, 3vw, 1.2rem);
}
.wh-score .wh-opp {
    color: #ff4444;
    font-size: clamp(1rem, 4vw, 1.6rem);
    font-weight: 900;
}
.wh-meta {
    display: flex;
    gap: 12px;
    margin-top: 2px;
}
.wh-target {
    color: #8888cc;
    font-size: clamp(0.5rem, 1.8vw, 0.65rem);
}
.wh-stake {
    color: #ffcc00;
    font-size: clamp(0.5rem, 1.8vw, 0.65rem);
    text-shadow: 0 0 4px rgba(255,200,0,0.3);
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
    font-family: 'Courier New', monospace;
}
#wagerResult.hidden { display: none !important; }

.wr-result-bg {
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
    background: radial-gradient(ellipse at center, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.95) 100%);
}
.wr-result-content {
    position: relative;
    z-index: 1;
    text-align: center;
}
.wr-result-title {
    font-family: 'Impact', 'Arial Black', sans-serif;
    font-size: clamp(2.5rem, 12vw, 5rem);
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
}
.wr-result-title.victory {
    color: #00ff55;
    text-shadow: 0 0 40px rgba(0,255,85,0.9), 0 0 80px rgba(0,255,85,0.5);
}
.wr-result-title.defeat {
    color: #ff2222;
    text-shadow: 0 0 40px rgba(255,0,0,0.9), 0 0 80px rgba(255,0,0,0.5);
}
.wr-result-score {
    font-size: clamp(1.2rem, 5vw, 2rem);
    color: #fff;
    letter-spacing: 0.15em;
    margin-top: 0.3rem;
}
.wr-result-payout {
    font-size: clamp(1rem, 4vw, 1.6rem);
    color: #00ff44;
    font-weight: bold;
    margin-top: 0.8rem;
    text-shadow: 0 0 10px rgba(0,255,68,0.4);
}
.wr-result-payout.loss { color: #ff4444; }
.wr-result-tx {
    margin-top: 0.5rem;
}
.wr-result-tx a {
    color: #6688ff;
    font-size: 0.65rem;
    text-decoration: underline;
}
.wr-result-back {
    margin-top: 1.2rem;
    background: linear-gradient(180deg, #ffdd44 0%, #cc8800 50%, #ffdd44 100%);
    border: 2px outset #ffcc00;
    color: #000;
    padding: 0.6rem 2rem;
    font-size: 0.85rem;
    font-weight: bold;
    font-family: 'Impact', 'Arial Black', sans-serif;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.08em;
}
.wr-result-back:active { border-style: inset; opacity: 0.9; }

/* === WAGER BUTTON on start screen === */
#wagerBtn {
    background: linear-gradient(180deg, #44ddff 0%, #0088cc 50%, #44ddff 100%);
    border: 2px outset #44ccff;
    color: #000;
    padding: 0.5rem;
    font-size: 0.85rem;
    font-weight: bold;
    font-family: 'Impact', 'Arial Black', sans-serif;
    cursor: pointer;
    width: 100%;
    border-radius: 0;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    text-shadow: 1px 1px 0 rgba(255,255,255,0.3);
    margin-top: 0.5rem;
    -webkit-tap-highlight-color: transparent;
}
#wagerBtn:active { border-style: inset; opacity: 0.9; }

/* === Mobile responsive === */
@media (max-width: 768px), (max-height: 500px) {
    .wl-topbar { padding: 0.4rem 0.6rem; }
    .wl-topbar .wl-user, .wl-topbar .wl-balance { font-size: 0.6rem; }
    .wl-topbar .wl-btn { font-size: 0.55rem; padding: 0.2rem 0.5rem; }
    .wl-title { font-size: clamp(1rem, 4vw, 1.3rem); }
    .wl-table td { font-size: 0.6rem; padding: 6px; }
    .wl-table th { font-size: 0.5rem; }
    .wl-join-btn { font-size: 0.55rem; padding: 0.2rem 0.5rem; }
    .wl-create-btn { font-size: 0.75rem; padding: 0.5rem 1.5rem; }

    .cm-panel { padding: 0.8rem; }
    .cm-panel h2 { font-size: 1rem; }

    .wr-card { padding: 0.6rem 0.8rem; min-width: 110px; }
    .wr-card .wr-name { font-size: 0.7rem; }
    .wr-players { gap: 0.8rem; }
    .wr-vs { font-size: 1.1rem; }
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
        btn.textContent = '>> WAGER 1v1 <<';
        startBtn.parentNode.insertBefore(btn, startBtn.nextSibling);
    }

    // 2. Wager lobby overlay
    const lobby = document.createElement('div');
    lobby.id = 'wagerLobby';
    lobby.className = 'hidden';
    lobby.innerHTML = `
        <div class="wl-topbar">
            <span class="wl-user" id="wlUser">---</span>
            <span class="wl-balance" id="wlBalance">-- SOL | -- USDC</span>
            <div style="display:flex;gap:0.3rem;">
                <button class="wl-btn" id="wlBack">BACK</button>
                <button class="wl-btn" id="wlLogout">LOGOUT</button>
            </div>
        </div>
        <div class="wl-title">WAGER 1v1</div>
        <div class="wl-subtitle">:: put your money where your crosshair is ::</div>
        <div class="wl-table-wrap">
            <table class="wl-table">
                <thead>
                    <tr>
                        <th>Player</th>
                        <th>Record</th>
                        <th>Stake</th>
                        <th>Target</th>
                        <th></th>
                        <th></th>
                    </tr>
                </thead>
                <tbody id="wlMatches"></tbody>
            </table>
            <div class="wl-empty hidden" id="wlEmpty">No open matches. Create one!</div>
        </div>
        <div class="wl-bottom">
            <button class="wl-create-btn" id="wlCreateBtn">>> CREATE MATCH <<</button>
        </div>
    `;
    document.body.appendChild(lobby);

    // 3. Create match modal
    const createModal = document.createElement('div');
    createModal.id = 'createMatchModal';
    createModal.className = 'hidden';
    createModal.innerHTML = `
        <div class="cm-panel">
            <h2>Create Match</h2>
            <div class="cm-label">Stake Amount</div>
            <input type="number" class="cm-input" id="cmStake" placeholder="e.g. 5" min="0.1" step="any">
            <div class="cm-label">Token</div>
            <div class="cm-toggle-group" id="cmTokenGroup">
                <button class="cm-toggle selected" data-token="SOL">SOL</button>
                <button class="cm-toggle" data-token="USDC">USDC</button>
            </div>
            <div class="cm-label">Kill Target (First To)</div>
            <div class="cm-toggle-group" id="cmTargetGroup">
                <button class="cm-toggle" data-target="5">5</button>
                <button class="cm-toggle selected" data-target="7">7</button>
                <button class="cm-toggle" data-target="10">10</button>
            </div>
            <div class="cm-label">Password (optional)</div>
            <input type="text" class="cm-input" id="cmPassword" placeholder="Leave empty for public" maxlength="32">
            <button class="cm-submit" id="cmSubmit">>> CREATE MATCH <<</button>
            <button class="cm-cancel" id="cmCancel">CANCEL</button>
        </div>
    `;
    document.body.appendChild(createModal);

    // 4. Waiting room
    const waiting = document.createElement('div');
    waiting.id = 'waitingRoom';
    waiting.className = 'hidden';
    waiting.innerHTML = `
        <div class="wr-title">MATCH LOBBY</div>
        <div class="wr-info" id="wrInfo">5 USDC | First to 7</div>
        <div id="wrStatus" style="color:#ffcc00;font-size:0.85rem;margin:0.5rem 0;text-align:center;">Waiting for opponent...</div>
        <div class="wr-players">
            <div class="wr-card" id="wrCreator">
                <div class="wr-name" id="wrCreatorName">---</div>
                <div class="wr-record" id="wrCreatorRecord">0W - 0L</div>
                <div class="wr-status pending" id="wrCreatorStatus">Not deposited</div>
            </div>
            <div class="wr-vs">VS</div>
            <div class="wr-card empty" id="wrJoiner">
                <div class="wr-name" id="wrJoinerName">Waiting for opponent...</div>
                <div class="wr-record" id="wrJoinerRecord"></div>
                <div class="wr-status pending" id="wrJoinerStatus"></div>
            </div>
        </div>
        <button id="wrDepositBtn" style="display:none;margin:1rem auto;padding:10px 24px;background:#cc8800;border:none;color:#000;font-weight:bold;border-radius:4px;cursor:pointer;font-family:inherit;font-size:0.9rem;">DEPOSIT</button>
        <div style="display:flex;gap:0.5rem;justify-content:center;margin-top:0.5rem;">
            <button class="wr-cancel" id="wrCancel">CANCEL MATCH</button>
        </div>
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
        <div class="wr-result-bg"></div>
        <div class="wr-result-content">
            <div class="wr-result-title" id="wrResultTitle">VICTORY</div>
            <div class="wr-result-score" id="wrResultScore">7 - 3</div>
            <div class="wr-result-payout" id="wrResultPayout">+9.5 USDC</div>
            <div class="wr-result-tx" id="wrResultTx"></div>
            <button class="wr-result-back" id="wrResultBack">>> BACK TO LOBBY <<</button>
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
        if (currentMatchId) {
            try { await api(`/matches/${currentMatchId}/cancel`, { method: 'POST' }); } catch (_) {}
        }
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
                btn.textContent = '\u2713 DEPOSITED';
                btn.style.background = '#00aa44';
                btn.style.display = 'none';
            } else {
                btn.textContent = 'DEPOSIT FAILED - RETRY';
                btn.style.background = '#cc2222';
                btn.disabled = false;
            }
        } catch (e) {
            btn.textContent = 'DEPOSIT FAILED - RETRY';
            btn.style.background = '#cc2222';
            btn.disabled = false;
        }
    });

    // Result back button
    document.getElementById('wrResultBack')?.addEventListener('click', () => {
        els.result.classList.add('hidden');
        showLobby();
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
    if (!stakeVal || stakeVal <= 0) return alert('Enter a valid stake amount');

    const token = document.querySelector('#cmTokenGroup .cm-toggle.selected')?.dataset.token || 'SOL';
    const killTarget = parseInt(document.querySelector('#cmTargetGroup .cm-toggle.selected')?.dataset.target || '7');
    const password = document.getElementById('cmPassword')?.value?.trim() || undefined;

    submitBtn.disabled = true;
    submitBtn.textContent = 'CREATING...';

    try {
        const res = await api('/matches', {
            method: 'POST',
            body: JSON.stringify({
                stakeAmount: token === 'SOL' ? Math.round(stakeVal * 1e9) : Math.round(stakeVal * 1e6),
                stakeToken: token,
                killTarget,
                password: password || undefined
            }),
        });

        if (!res.success) throw new Error(res.error || 'Failed to create match');

        const matchId = res.data?.id || res.data?.matchId;
        if (!matchId) throw new Error('No match ID returned');
        currentMatchId = matchId;

        els.createModal.classList.add('hidden');
        showWaitingRoom(matchId);
    } catch (err) {
        alert('Failed to create match: ' + err.message);
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '>> CREATE MATCH <<';
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
        els.wlUser.textContent = user.twitter?.username ? `@${user.twitter.username}` : (user.wallet?.address?.slice(0, 8) + '...' || '---');
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

function renderMatches(matches) {
    const tbody = els.wlMatches;
    const empty = els.wlEmpty;

    const openMatches = matches.filter(m => m.status === 'open' || m.status === 'funded_creator');

    if (openMatches.length === 0) {
        tbody.innerHTML = '';
        empty.classList.remove('hidden');
        return;
    }

    empty.classList.add('hidden');
    tbody.innerHTML = openMatches.map(m => {
        const creator = m.creator_twitter ? '@' + m.creator_twitter : 'Anon';
        const record = `${m.creator_wins || 0}W-${m.creator_losses || 0}L`;
        const token = m.stake_token || 'USDC';
        const amt = token === 'SOL' ? (m.stake_amount / 1e9) : (m.stake_amount / 1e6);
        const stake = `${amt} ${token}`;
        const target = `FT${m.kill_target || 7}`;
        const lock = m.passwordProtected ? '<span class="wl-lock">&#x1f512;</span>' : '';
        return `<tr>
            <td class="wl-creator">${esc(creator)}</td>
            <td class="wl-record">${esc(record)}</td>
            <td class="wl-stake">${esc(stake)}</td>
            <td class="wl-target">${esc(target)}</td>
            <td>${lock}</td>
            <td><button class="wl-join-btn" data-match-id="${esc(m.id || m.matchId)}">JOIN</button></td>
        </tr>`;
    }).join('');

    // Bind join buttons
    tbody.querySelectorAll('.wl-join-btn').forEach(btn => {
        btn.addEventListener('click', () => handleJoin(btn.dataset.matchId));
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

        // If password required, prompt and retry
        if (!res.success && res.error && res.error.toLowerCase().includes('password')) {
            const password = prompt('This match is password protected. Enter password:');
            if (!password) return;
            res = await api(`/matches/${matchId}/join`, {
                method: 'POST',
                body: JSON.stringify({ password }),
            });
        }

        if (!res.success) throw new Error(res.error || 'Failed to join');

        currentMatchId = matchId;
        showWaitingRoom(matchId);
    } catch (err) {
        alert('Failed to join: ' + err.message);
    }
}

// ── Create match modal ──────────────────────────────────────────────────────
export function showCreateMatch() {
    // Reset fields
    const stakeInput = document.getElementById('cmStake');
    if (stakeInput) stakeInput.value = '';
    const pwInput = document.getElementById('cmPassword');
    if (pwInput) pwInput.value = '';

    els.createModal.classList.remove('hidden');
}

// ── Waiting room ────────────────────────────────────────────────────────────
export function showWaitingRoom(matchId) {
    currentMatchId = matchId;
    // Hide lobby but don't restore start screen
    els.lobby.classList.add('hidden');
    if (lobbyInterval) { clearInterval(lobbyInterval); lobbyInterval = null; }
    els.waiting.classList.remove('hidden');

    // Populate with current info from create form (best effort)
    pollWaitingRoom(matchId);
    waitingInterval = setInterval(() => pollWaitingRoom(matchId), 3000);
}

function hideWaitingRoom() {
    els.waiting.classList.add('hidden');
    if (waitingInterval) { clearInterval(waitingInterval); waitingInterval = null; }
    currentMatchId = null;
}

async function pollWaitingRoom(matchId) {
    try {
        const data = await api(`/matches/${matchId}`);
        if (!data.success) return;

        const m = data.data || data;
        const me = getUser();
        const amCreator = me && m.creator_id === me.id;

        // Update info line
        const wrToken = m.stake_token || 'USDC';
        const wrAmt = wrToken === 'SOL' ? (m.stake_amount / 1e9) : (m.stake_amount / 1e6);
        els.wrInfo.textContent = `${wrAmt} ${wrToken} | First to ${m.kill_target || 7}`;

        // Determine who has deposited
        const creatorFunded = ['funded_creator', 'funded_both'].includes(m.status);
        const joinerFunded = ['funded_joiner', 'funded_both'].includes(m.status);
        const myDeposited = amCreator ? creatorFunded : joinerFunded;

        // Status message
        let statusMsg = m.status;
        if (m.status === 'open') statusMsg = 'Waiting for opponent...';
        else if (m.status === 'matched') statusMsg = 'Opponent joined! Both players deposit to start.';
        else if (m.status === 'funded_creator') statusMsg = amCreator ? 'You deposited. Waiting for opponent to deposit...' : 'Opponent deposited. Your turn to deposit!';
        else if (m.status === 'funded_joiner') statusMsg = amCreator ? 'Opponent deposited. Your turn to deposit!' : 'You deposited. Waiting for opponent to deposit...';
        else if (m.status === 'funded_both') statusMsg = 'Both deposited! Starting match...';
        else if (m.status === 'in_progress') statusMsg = 'Match in progress!';
        const statusEl = document.getElementById('wrStatus');
        if (statusEl) statusEl.textContent = statusMsg;

        // Creator card
        els.wrCreatorName.textContent = '@' + (m.creator_twitter || 'unknown');
        els.wrCreatorRecord.textContent = `${m.creator_wins || 0}W - ${m.creator_losses || 0}L | ELO ${m.creator_elo || 1000}`;
        els.wrCreator.classList.toggle('funded', creatorFunded);
        if (els.wrCreatorStatus) {
            els.wrCreatorStatus.textContent = creatorFunded ? '\u2713 DEPOSITED' : 'Awaiting deposit';
            els.wrCreatorStatus.className = 'wr-status ' + (creatorFunded ? 'ok' : 'pending');
        }

        // Joiner card
        if (m.joiner_id) {
            els.wrJoiner.classList.remove('empty');
            els.wrJoinerName.textContent = '@' + (m.joiner_twitter || 'unknown');
            els.wrJoinerRecord.textContent = `${m.joiner_wins || 0}W - ${m.joiner_losses || 0}L | ELO ${m.joiner_elo || 1000}`;
            els.wrJoiner.classList.toggle('funded', joinerFunded);
            if (els.wrJoinerStatus) {
                els.wrJoinerStatus.textContent = joinerFunded ? '\u2713 DEPOSITED' : 'Awaiting deposit';
                els.wrJoinerStatus.className = 'wr-status ' + (joinerFunded ? 'ok' : 'pending');
            }
        } else {
            els.wrJoiner.classList.add('empty');
            els.wrJoiner.classList.remove('funded');
            els.wrJoinerName.textContent = 'Waiting for opponent...';
            els.wrJoinerRecord.textContent = '';
            if (els.wrJoinerStatus) {
                els.wrJoinerStatus.textContent = '';
                els.wrJoinerStatus.className = 'wr-status pending';
            }
        }

        // Show/hide deposit button
        const depositBtn = document.getElementById('wrDepositBtn');
        if (depositBtn) {
            const hasOpponent = !!m.joiner_id;
            const showDeposit = hasOpponent && !myDeposited && m.status !== 'funded_both';
            depositBtn.style.display = showDeposit ? 'block' : 'none';
            depositBtn.textContent = `DEPOSIT ${wrAmt} ${wrToken}`;
            depositBtn.disabled = false;
            depositBtn.style.background = '#cc8800';
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

// ── Wager HUD ───────────────────────────────────────────────────────────────
export function showWagerHUD(matchData) {
    const whTarget = document.getElementById('whTarget');
    const whStake = document.getElementById('whStake');
    if (whTarget) whTarget.textContent = `First to ${matchData.killTarget || 7}`;
    if (whStake) whStake.textContent = `${matchData.stake || '?'} ${matchData.token || 'USDC'} on the line`;
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

    const won = data.result === 'win' || data.won;

    titleEl.textContent = won ? 'VICTORY' : 'DEFEAT';
    titleEl.className = 'wr-result-title ' + (won ? 'victory' : 'defeat');

    scoreEl.textContent = `${data.myScore || 0} - ${data.opponentScore || 0}`;

    if (won && data.payout) {
        payoutEl.textContent = `+${data.payout} ${data.token || 'USDC'}`;
        payoutEl.className = 'wr-result-payout';
    } else {
        payoutEl.textContent = `-${data.stake || '?'} ${data.token || 'USDC'}`;
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

            case 'wager_timeout':
                hideWagerHUD();
                alert('Match timed out.');
                showLobby();
                break;

            case 'error':
                console.warn('[wager ws] Error:', msg.msg);
                break;
        }
    });

    ws.addEventListener('close', () => {
        wagerWs = null;
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
