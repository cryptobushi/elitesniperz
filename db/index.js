const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'sniperz.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Run schema on init (all CREATE IF NOT EXISTS, safe to re-run)
const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
db.exec(schema);

// --- Prepared statements ---

// Users
const _getUser = db.prepare('SELECT * FROM users WHERE id = ?');
const _upsertUser = db.prepare(`
  INSERT INTO users (id, twitter_handle, twitter_id, privy_wallet, display_name, created_at, last_seen)
  VALUES (@id, @twitter_handle, @twitter_id, @privy_wallet, @display_name, @created_at, @last_seen)
  ON CONFLICT(id) DO UPDATE SET
    twitter_handle = excluded.twitter_handle,
    twitter_id = COALESCE(excluded.twitter_id, users.twitter_id),
    privy_wallet = COALESCE(excluded.privy_wallet, users.privy_wallet),
    display_name = COALESCE(excluded.display_name, users.display_name),
    last_seen = excluded.last_seen
`);
const _updateUserStats = db.prepare(`
  UPDATE users SET
    wins = @wins,
    losses = @losses,
    draws = @draws,
    total_earned = @total_earned,
    total_wagered = @total_wagered
  WHERE id = @id
`);

// Matches
const _createMatch = db.prepare(`
  INSERT INTO matches (id, creator_id, stake_amount, stake_token, kill_target, password_hash, created_at)
  VALUES (@id, @creator_id, @stake_amount, @stake_token, @kill_target, @password_hash, @created_at)
`);
const _getMatch = db.prepare('SELECT * FROM matches WHERE id = ?');
const _joinMatch = db.prepare(`
  UPDATE matches SET joiner_id = @joiner_id WHERE id = @id AND status = 'open' AND joiner_id IS NULL
`);

// Transactions
const _createTransaction = db.prepare(`
  INSERT INTO transactions (id, match_id, user_id, tx_type, amount, token, tx_signature, from_wallet, to_wallet, status, created_at)
  VALUES (@id, @match_id, @user_id, @tx_type, @amount, @token, @tx_signature, @from_wallet, @to_wallet, COALESCE(@status, 'pending'), @created_at)
`);
const _confirmTransaction = db.prepare(`
  UPDATE transactions SET status = 'confirmed', confirmed_at = @confirmed_at WHERE id = @id
`);

// Match history
const _createMatchHistory = db.prepare(`
  INSERT INTO match_history (match_id, user_id, opponent_id, result, kills, deaths, stake_amount, stake_token, payout, played_at)
  VALUES (@match_id, @user_id, @opponent_id, @result, @kills, @deaths, @stake_amount, @stake_token, @payout, @played_at)
`);
const _getMatchHistory = db.prepare(`
  SELECT * FROM match_history WHERE user_id = ? ORDER BY played_at DESC LIMIT ?
`);

// Leaderboard
const _getLeaderboard = db.prepare(`
  SELECT id, twitter_handle, display_name, wins, losses, draws, total_earned, total_wagered, elo
  FROM users ORDER BY wins DESC LIMIT ?
`);

// --- Exported helpers ---

function getUser(id) {
  return _getUser.get(id) || null;
}

function upsertUser({ id, twitter_handle, twitter_id, privy_wallet, display_name }) {
  const now = Date.now();
  _upsertUser.run({
    id,
    twitter_handle,
    twitter_id: twitter_id || null,
    privy_wallet: privy_wallet || null,
    display_name: display_name || twitter_handle,
    created_at: now,
    last_seen: now,
  });
  return _getUser.get(id);
}

function updateUserStats(id, { wins, losses, draws, total_earned, total_wagered }) {
  return _updateUserStats.run({ id, wins, losses, draws, total_earned, total_wagered });
}

function createMatch({ id, creator_id, stake_amount, stake_token, kill_target, password_hash }) {
  const now = Date.now();
  _createMatch.run({
    id,
    creator_id,
    stake_amount,
    stake_token,
    kill_target: kill_target || 7,
    password_hash: password_hash || null,
    created_at: now,
  });
  return _getMatch.get(id);
}

function getMatch(id) {
  return _getMatch.get(id) || null;
}

function listOpenMatches({ token, minStake, maxStake, limit = 50, offset = 0 } = {}) {
  let sql = "SELECT * FROM matches WHERE status = 'open'";
  const params = [];

  if (token) {
    sql += ' AND stake_token = ?';
    params.push(token);
  }
  if (minStake != null) {
    sql += ' AND stake_amount >= ?';
    params.push(minStake);
  }
  if (maxStake != null) {
    sql += ' AND stake_amount <= ?';
    params.push(maxStake);
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
}

function updateMatch(id, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return null;
  const sets = keys.map(k => `${k} = @${k}`).join(', ');
  const stmt = db.prepare(`UPDATE matches SET ${sets} WHERE id = @id`);
  stmt.run({ id, ...fields });
  return _getMatch.get(id);
}

function joinMatch(matchId, joinerId) {
  const result = _joinMatch.run({ id: matchId, joiner_id: joinerId });
  if (result.changes === 0) return null;
  return _getMatch.get(matchId);
}

function createTransaction({ id, match_id, user_id, tx_type, amount, token, tx_signature, from_wallet, to_wallet }) {
  const now = Date.now();
  _createTransaction.run({
    id,
    match_id: match_id || null,
    user_id: user_id || null,
    tx_type,
    amount,
    token,
    tx_signature: tx_signature || null,
    from_wallet: from_wallet || null,
    to_wallet: to_wallet || null,
    status: 'pending',
    created_at: now,
  });
  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
}

function confirmTransaction(id, confirmed_at) {
  _confirmTransaction.run({ id, confirmed_at: confirmed_at || Date.now() });
  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
}

function createMatchHistory({ match_id, user_id, opponent_id, result, kills, deaths, stake_amount, stake_token, payout, played_at }) {
  _createMatchHistory.run({
    match_id,
    user_id,
    opponent_id,
    result,
    kills,
    deaths,
    stake_amount,
    stake_token,
    payout: payout || 0,
    played_at: played_at || Date.now(),
  });
  return db.prepare('SELECT * FROM match_history WHERE match_id = ? AND user_id = ?').all(match_id, user_id);
}

function getMatchHistory(userId, limit = 20) {
  return _getMatchHistory.all(userId, limit);
}

function getLeaderboard(limit = 50) {
  return _getLeaderboard.all(limit);
}

module.exports = {
  db,
  getUser,
  upsertUser,
  updateUserStats,
  createMatch,
  getMatch,
  listOpenMatches,
  updateMatch,
  joinMatch,
  createTransaction,
  confirmTransaction,
  createMatchHistory,
  getMatchHistory,
  getLeaderboard,
};
