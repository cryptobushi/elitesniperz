# Sniperz Crypto Wagering System — Architecture Design

## 1. Overview

Players wager real USDC or SOL on 1v1 sniper matches. Sign in with Twitter via Privy, get an embedded Solana wallet, browse a matchmaking marketplace, deposit to escrow, play, winner takes 95% of the pot. 5% rake to game treasury. Free play (existing 5v5) stays unchanged.

```
Twitter Login (Privy) → Browse Matchmaking → Create/Join Wager Match
  → Both deposit to escrow → 1v1 match → Winner paid out (minus 5% rake)
```

---

## 2. Current Architecture

- `server.js` — Express + ws, 64hz tick / 30hz send, server-authoritative movement/shooting/kills
- `game.js` — Three.js ES module client
- `index.html` — UI, retro start screen
- `shared/constants.js` — shared config
- No database, no auth, single global 5v5 match
- Players join by name, bots fill empty slots
- Match loop: 50-kill limit or 20min timer, then auto-reset

Server is already authoritative for all critical actions: movement validated against wall collisions, shooting validated with FOV cone + range + LOS raycasting. Client sends only intents (`mv`, `rot`), never state mutations.

---

## 3. Database Schema (SQLite via better-sqlite3)

File: `db/schema.sql`

```sql
-- Users: one row per Privy-authenticated user
CREATE TABLE users (
    id              TEXT PRIMARY KEY,        -- Privy DID (did:privy:xxxx)
    twitter_handle  TEXT NOT NULL UNIQUE,
    twitter_id      TEXT,
    privy_wallet    TEXT,                    -- Privy-managed Solana wallet pubkey
    funding_wallet  TEXT,                    -- First external wallet that deposited to privy_wallet
    display_name    TEXT,
    created_at      INTEGER NOT NULL,        -- Unix timestamp ms
    last_seen       INTEGER NOT NULL,
    wins            INTEGER DEFAULT 0,
    losses          INTEGER DEFAULT 0,
    draws           INTEGER DEFAULT 0,
    total_earned    INTEGER DEFAULT 0,       -- Base units (lamports / USDC 1e-6)
    total_wagered   INTEGER DEFAULT 0,
    elo             INTEGER DEFAULT 1000
);

-- Wager matches
CREATE TABLE matches (
    id              TEXT PRIMARY KEY,        -- UUID v4
    creator_id      TEXT NOT NULL REFERENCES users(id),
    joiner_id       TEXT REFERENCES users(id),
    status          TEXT NOT NULL DEFAULT 'open',
        -- State machine: open → funded_creator → funded_both → in_progress → completed → settled
        -- Terminal branches: cancelled, disputed, expired
    stake_amount    INTEGER NOT NULL,        -- Base units
    stake_token     TEXT NOT NULL,           -- 'SOL' or 'USDC'
    rake_amount     INTEGER DEFAULT 0,
    kill_target     INTEGER NOT NULL DEFAULT 7,
    password_hash   TEXT,                    -- bcrypt hash if private, NULL if public
    created_at      INTEGER NOT NULL,
    funded_at       INTEGER,
    started_at      INTEGER,
    ended_at        INTEGER,
    winner_id       TEXT REFERENCES users(id),
    win_reason      TEXT,                   -- 'kill_target', 'forfeit_disconnect', 'forfeit_afk', 'time_limit'
    creator_kills   INTEGER DEFAULT 0,
    joiner_kills    INTEGER DEFAULT 0,
    creator_deaths  INTEGER DEFAULT 0,
    joiner_deaths   INTEGER DEFAULT 0
);

-- On-chain transaction log
CREATE TABLE transactions (
    id              TEXT PRIMARY KEY,        -- UUID v4
    match_id        TEXT REFERENCES matches(id),
    user_id         TEXT REFERENCES users(id),
    tx_type         TEXT NOT NULL,           -- 'deposit', 'payout', 'rake', 'refund'
    amount          INTEGER NOT NULL,
    token           TEXT NOT NULL,
    tx_signature    TEXT,                    -- Solana tx signature
    from_wallet     TEXT,
    to_wallet       TEXT,
    status          TEXT DEFAULT 'pending',  -- 'pending', 'confirmed', 'failed'
    created_at      INTEGER NOT NULL,
    confirmed_at    INTEGER
);

-- Match history (for profiles)
CREATE TABLE match_history (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id        TEXT NOT NULL REFERENCES matches(id),
    user_id         TEXT NOT NULL REFERENCES users(id),
    opponent_id     TEXT NOT NULL REFERENCES users(id),
    result          TEXT NOT NULL,           -- 'win', 'loss', 'draw'
    kills           INTEGER NOT NULL,
    deaths          INTEGER NOT NULL,
    stake_amount    INTEGER NOT NULL,
    stake_token     TEXT NOT NULL,
    payout          INTEGER DEFAULT 0,
    played_at       INTEGER NOT NULL
);

CREATE INDEX idx_matches_status ON matches(status);
CREATE INDEX idx_matches_creator ON matches(creator_id);
CREATE INDEX idx_transactions_match ON transactions(match_id);
CREATE INDEX idx_match_history_user ON match_history(user_id);
```

All monetary amounts stored as integers in base units. Never floats.

---

## 4. API Endpoints

### REST (Express, JSON)

All authenticated endpoints require `Authorization: Bearer <privy-access-token>`.

```
POST   /api/auth/verify              -- Verify Privy token, upsert user, return profile
GET    /api/profile/:userId          -- Public profile (W/L, earnings, history)
GET    /api/profile/me               -- Own profile + wallet balances

POST   /api/matches                  -- Create wager match
GET    /api/matches                  -- List open matches (?token=SOL&minStake=1&maxStake=100)
GET    /api/matches/:id              -- Match details
POST   /api/matches/:id/join         -- Join match (body: {password?})
POST   /api/matches/:id/cancel       -- Cancel (creator only, pre-funded)
GET    /api/matches/:id/deposit-tx   -- Get unsigned deposit transaction
POST   /api/matches/:id/confirm-deposit  -- Submit confirmed tx signature

GET    /api/wallet/balance           -- User's Privy wallet balance
GET    /api/treasury/stats           -- Public rake stats
GET    /api/leaderboard              -- Top players
```

### WebSocket Extensions

Client → Server:
```
{ t: 'wager_auth', token: string }     -- Authenticate for wager match
{ t: 'wager_join', matchId: string }   -- Join wager match room
{ t: 'wager_ready' }                    -- Confirm ready
{ t: 'wager_forfeit' }                  -- Surrender
```

Server → Client:
```
{ t: 'wager_lobby', matchId, creator, joiner, status, stake, killTarget }
{ t: 'wager_start', matchId, killTarget }
{ t: 'wager_score', ck, jk }
{ t: 'wager_end', winner, reason, creatorKills, joinerKills, payout, txSignature }
{ t: 'wager_timeout', secondsRemaining }
```

---

## 5. Privy Auth Flow

### Client
1. Initialize Privy with app ID on page load
2. Start screen shows "FREE PLAY" (existing) and "WAGER MATCHES" (triggers Privy Twitter login)
3. After login: receive access token + user object (twitter handle, embedded Solana wallet)
4. Token stored in memory (session only), sent on all API/WS calls

### Server
```js
const { PrivyClient } = require('@privy-io/server-auth');
const privy = new PrivyClient(PRIVY_APP_ID, PRIVY_APP_SECRET);

async function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    try {
        const claims = await privy.verifyAuthToken(token);
        req.privyUserId = claims.userId;
        req.privyUser = await privy.getUser(claims.userId);
        next();
    } catch (e) { res.status(401).json({ error: 'Invalid token' }); }
}
```

WebSocket: first message must be `wager_auth` with token. Server verifies, associates connection with user ID. 5s timeout or connection closed.

---

## 6. Escrow Flow

### Server-Side Escrow Wallet

Single server-controlled Solana keypair. Private key in env var. Treasury is a separate wallet.

### Deposit
1. Client calls `GET /api/matches/:id/deposit-tx` → server returns unsigned Solana transfer tx (SOL via SystemProgram, USDC via SPL Token)
2. Client signs with Privy embedded wallet (`privy.embeddedWallet.signTransaction`)
3. Client submits to Solana RPC, calls `POST /api/matches/:id/confirm-deposit` with tx signature
4. Server confirms on-chain: verifies destination, amount, source. Records `funding_wallet` on first deposit.
5. Updates match status: creator deposit → `funded_creator`, joiner deposit → `funded_both` → match starts

### Payout
1. Server determines winner from match state
2. Constructs + signs two txs from escrow: winner payout (95%) + rake (5%) to treasury
3. Waits for confirmation, records signatures, updates match to `settled`

### Refunds
- Creator cancels before joiner funds → refund from escrow
- Joiner doesn't fund within 10 min → match expires, refund creator
- Unrecoverable server crash → manual admin refund

### Solana Details
- `@solana/web3.js` v1.x, `@solana/spl-token`
- USDC mainnet: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- Devnet for testing, mainnet for production
- `'confirmed'` commitment level

---

## 7. 1v1 Match Format

### First to 7 Kills
- Kill targets: 5, 7, or 10 (configurable per match)
- Time limit: 10 minutes
- Same map as 5v5
- Spawns: creator = red side (-70,-70), joiner = blue side (+70,+70)
- **Items/Shop disabled** — equal footing, pure skill
- Abilities: Windwalk + Farsight, standard cooldowns
- Respawn: 5 seconds
- Spawn protection: 1.5 seconds

### AFK / Disconnect
- 30-second countdown on disconnect or no input
- Opponent sees countdown timer
- Expires = forfeit, opponent wins

### Time Limit Resolution
- More kills wins
- Tied = draw, both refunded (minus 1% anti-abuse fee)
- OR sudden death overtime (2 extra minutes, next kill wins)

### Match Lifecycle
1. Both connect to dedicated wager WebSocket room
2. `wager_lobby` sent with player info
3. Both send `wager_ready`
4. 3-second countdown → `wager_start`
5. Isolated game loop (64hz tick, 2 players only)
6. On kill → `wager_score` to both
7. Kill target reached or time expires → `wager_end` → settlement

---

## 8. Matchmaking Marketplace UI

### Screens

**Landing (modified start screen)**
- "FREE PLAY" (existing flow) + "WAGER MATCHES" (requires Twitter login)

**Wager Lobby**
- Top bar: Twitter handle, wallet balance, profile link
- Tabs: "OPEN MATCHES" / "MY MATCHES"
- "CREATE MATCH" button
- Match list table:
  - Creator Twitter handle (linked to profile)
  - W/L record
  - Stake: "5 USDC" / "0.5 SOL"
  - Kill target: "FT7"
  - Lock icon if password-protected
  - "JOIN" button
- Filters: token, stake range
- Auto-refresh every 5s

**Create Match Modal**
- Stake amount input
- Token selector (SOL / USDC)
- Kill target selector (5 / 7 / 10)
- Optional password
- "CREATE & DEPOSIT" button

**Waiting Room**
- Both player cards (Twitter avatar, handle, record)
- Deposit status checkmarks
- Cancel button (pre-opponent-fund only)
- Auto-transitions to game when both funded

**1v1 Game HUD**
- Score overlay: "YOU 3 - 2 OPPONENT"
- Kill target: "First to 7"
- Stake: "5 USDC on the line"
- On end: victory/defeat + payout amount + Solana explorer tx link

**Player Profile**
- Twitter handle + avatar
- W/L/D, total earnings, Elo
- Funding wallet (transparency)
- Recent 20 match history

---

## 9. Anti-Cheat

### Already Solid
- Server-authoritative: movement computed server-side, kills validated (FOV + range + LOS + cooldowns)
- Client sends intents only, never state

### Additional for Wager
- Input rate limiting (max 64 msg/s per client)
- Speed validation (position jump > maxSpeed * dt * 1.5 = snap back)
- Match isolation (separate game loop instance per wager match)
- Replay logging (all inputs + timestamps for wager matches)
- Ping monitoring (pause on sustained >500ms, not auto-forfeit)

### Disputes (v1: Manual)
- `POST /api/matches/:id/dispute` — flags match, funds held in escrow
- Admin reviews replay data
- `POST /api/admin/resolve-dispute` — assign winner or refund both
- Discord channel for submissions

---

## 10. Treasury / Rake Management

### Wallets
- **Escrow**: holds deposits during active matches, near-zero when idle
- **Treasury**: receives 5% rake, revenue wallet
- Both are Solana keypairs, private keys in env vars

### Environment Variables
```
PRIVY_APP_ID=
PRIVY_APP_SECRET=
ESCROW_PRIVATE_KEY=<base58 secret key>
TREASURY_WALLET=<base58 public key>
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
DATABASE_PATH=./db/sniperz.db
```

### Reconciliation
- Hourly job: compare escrow on-chain balance vs DB pending deposits minus payouts
- Discrepancy = alert
- Treasury balance publicly viewable via `/api/treasury/stats`

---

## 11. File Structure

```
sniperz/
  server.js                  -- Add wager WS handlers, import new modules
  game.js                    -- Add Privy client, wager UI, deposit signing
  index.html                 -- Add wager lobby HTML/CSS, Privy SDK
  shared/constants.js        -- Add WAGER_KILL_TARGETS, AFK_TIMEOUT, RAKE_PCT
  
  db/
    schema.sql               -- Table definitions
    index.js                 -- better-sqlite3 init, migrations, query helpers
  
  server/
    auth.js                  -- Privy verification, middleware
    api.js                   -- Express router for all /api/* endpoints
    escrow.js                -- Solana tx construction, signing, confirmation, payout
    wager-match.js           -- WagerMatch class: isolated 1v1 game loop
    matchmaking.js           -- Match CRUD, status management, expiry cleanup
  
  client/
    privy-client.js          -- Privy SDK init, login/logout, wallet access
    wager-ui.js              -- Marketplace UI, create/join, waiting room, HUD
    deposit-flow.js          -- Tx signing via Privy wallet, confirmation polling
```

---

## 12. Implementation Order

### Phase 1: Foundation
1. **Database** — `db/schema.sql`, `db/index.js`, init on server startup
2. **Privy server auth** — `server/auth.js`, `POST /api/auth/verify`
3. **Privy client login** — `client/privy-client.js`, Twitter login button in `index.html`

### Phase 2: Match Infrastructure
4. **REST API** — `server/api.js`, match CRUD endpoints
5. **WagerMatch class** — `server/wager-match.js`, isolated 1v1 game loop (extract game logic from server.js)
6. **Wager WebSocket handlers** — `wager_auth`, `wager_join`, `wager_ready`, `wager_forfeit`

### Phase 3: Escrow & Settlement
7. **Escrow module** — `server/escrow.js`, deposit tx creation, confirmation, payout
8. **Client deposit flow** — `client/deposit-flow.js`, sign with Privy wallet
9. **Settlement** — auto-payout on match end, rake to treasury

### Phase 4: Marketplace UI
10. **Wager lobby** — `client/wager-ui.js`, match list, create modal, filters
11. **Waiting room** — player cards, deposit status, auto-transition
12. **Wager HUD** — score overlay during 1v1, result screen with tx link

### Phase 5: Profiles & Polish
13. **Player profiles** — API + UI
14. **Leaderboard** — API + UI
15. **Edge cases** — refund cron, disputes, reconciliation, rate limiting

### Dependency Chain
```
Phase 1 (DB + Auth) → Phase 2 (API + WagerMatch + WS) → Phase 3 (Escrow)
                                                              ↓
                                                    Phase 4 (UI) → Phase 5 (Polish)
```

**Highest risk:** Phase 2 step 5 — extracting game logic from `server.js` into reusable functions for the WagerMatch class without breaking existing 5v5.

---

## 13. Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Server-side escrow (not Solana program) | Simpler for v1. Users already trust the server for game fairness. On-chain program in v2. |
| SQLite (not Postgres) | Zero ops. Single file. Handles hundreds of concurrent matches. Easy migration later. |
| Items/shop disabled in wager | Equal footing. Gold snowball introduces RNG. Pure skill when money is on the line. |
| First-to-7 default | Reduces variance vs first-to-3. Better player wins more consistently. ~5-8 min match keeps wagering loop tight. |
| Privy for auth + wallets | No seed phrases, no browser extensions. Twitter login is familiar. Embedded wallet is frictionless. |
| Password-protected matches | Enables pre-arranged fights via Twitter/Discord without public marketplace sniping. |
| 5% rake | Industry standard for skill-based wagering. Sustainable revenue without being punitive. |
