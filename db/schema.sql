-- Users: one row per Privy-authenticated user
CREATE TABLE IF NOT EXISTS users (
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
CREATE TABLE IF NOT EXISTS matches (
    id              TEXT PRIMARY KEY,        -- UUID v4
    creator_id      TEXT NOT NULL REFERENCES users(id),
    joiner_id       TEXT REFERENCES users(id),
    status          TEXT NOT NULL DEFAULT 'open',
        -- State machine: open -> funded_creator -> funded_both -> in_progress -> completed -> settled
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
CREATE TABLE IF NOT EXISTS transactions (
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
CREATE TABLE IF NOT EXISTS match_history (
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

CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
CREATE INDEX IF NOT EXISTS idx_matches_creator ON matches(creator_id);
CREATE INDEX IF NOT EXISTS idx_transactions_match ON transactions(match_id);
CREATE INDEX IF NOT EXISTS idx_match_history_user ON match_history(user_id);
