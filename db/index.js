/** @typedef {import('../shared/types').UserRow} UserRow */
/** @typedef {import('../shared/types').MatchRow} MatchRow */
/** @typedef {import('../shared/types').TransactionRow} TransactionRow */
/** @typedef {import('../shared/types').MatchHistoryRow} MatchHistoryRow */
/** @typedef {import('../shared/types').ChallengeRequestRow} ChallengeRequestRow */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'sniperz.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
db.exec(schema);
try { db.exec('ALTER TABLE users ADD COLUMN profile_picture TEXT'); } catch(e) { /* already exists */ }
try { db.exec("ALTER TABLE matches ADD COLUMN match_mode TEXT DEFAULT 'open'"); } catch(e) { /* already exists */ }

// Prepared statements
const _getUser = db.prepare('SELECT * FROM users WHERE id = ?');
const _upsertUser = db.prepare(`
  INSERT INTO users (id, twitter_handle, twitter_id, privy_wallet, display_name, profile_picture, created_at, last_seen)
  VALUES (@id, @twitter_handle, @twitter_id, @privy_wallet, @display_name, @profile_picture, @created_at, @last_seen)
  ON CONFLICT(id) DO UPDATE SET
    twitter_handle = excluded.twitter_handle,
    twitter_id = COALESCE(excluded.twitter_id, users.twitter_id),
    privy_wallet = COALESCE(excluded.privy_wallet, users.privy_wallet),
    display_name = COALESCE(excluded.display_name, users.display_name),
    profile_picture = COALESCE(excluded.profile_picture, users.profile_picture),
    last_seen = excluded.last_seen
`);

const _createMatch = db.prepare(`
  INSERT INTO matches (id, creator_id, stake_amount, stake_token, kill_target, password_hash, match_mode, created_at)
  VALUES (@id, @creator_id, @stake_amount, @stake_token, @kill_target, @password_hash, @match_mode, @created_at)
`);
const _getMatch = db.prepare('SELECT * FROM matches WHERE id = ?');
const _joinMatch = db.prepare(`
  UPDATE matches SET joiner_id = @joiner_id WHERE id = @id AND status IN ('open', 'funded_creator', 'matched') AND joiner_id IS NULL
`);
const _createTransaction = db.prepare(`
  INSERT INTO transactions (id, match_id, user_id, tx_type, amount, token, tx_signature, from_wallet, to_wallet, status, created_at)
  VALUES (@id, @match_id, @user_id, @tx_type, @amount, @token, @tx_signature, @from_wallet, @to_wallet, COALESCE(@status, 'pending'), @created_at)
`);
const _confirmTransaction = db.prepare(`
  UPDATE transactions SET status = 'confirmed', confirmed_at = @confirmed_at WHERE id = @id
`);
const _createMatchHistory = db.prepare(`
  INSERT INTO match_history (match_id, user_id, opponent_id, result, kills, deaths, stake_amount, stake_token, payout, played_at)
  VALUES (@match_id, @user_id, @opponent_id, @result, @kills, @deaths, @stake_amount, @stake_token, @payout, @played_at)
`);
const _getMatchHistory = db.prepare(`
  SELECT * FROM match_history WHERE user_id = ? ORDER BY played_at DESC LIMIT ?
`);
const _getLeaderboard = db.prepare(`
  SELECT id, twitter_handle, display_name, profile_picture, wins, losses, draws, total_earned, total_wagered, elo,
  (COALESCE(wins,0) + COALESCE(losses,0) + COALESCE(draws,0)) as matches
  FROM users ORDER BY wins DESC LIMIT ?
`);

// Exports

/** @param {string} id @returns {UserRow|null} */
function getUser(id) {
  return _getUser.get(id) || null;
}

/** @returns {UserRow} */
function upsertUser({ id, twitter_handle, twitter_id, privy_wallet, display_name, profile_picture }) {
  const now = Date.now();
  _upsertUser.run({
    id,
    twitter_handle,
    twitter_id: twitter_id || null,
    privy_wallet: privy_wallet || null,
    display_name: display_name || twitter_handle,
    profile_picture: profile_picture || null,
    created_at: now,
    last_seen: now,
  });
  return _getUser.get(id);
}

function updateUserStats(id, updates) {
  const allowed = ['wins', 'losses', 'draws', 'total_earned', 'total_wagered'];
  const keys = Object.keys(updates).filter(k => allowed.includes(k));
  if (keys.length === 0) return;
  const sets = keys.map(k => `${k} = ${k} + @${k}`).join(', ');
  db.prepare(`UPDATE users SET ${sets} WHERE id = @id`).run({ id, ...Object.fromEntries(keys.map(k => [k, updates[k]])) });
}

/** @returns {MatchRow} */
function createMatch({ id, creator_id, stake_amount, stake_token, kill_target, password_hash, match_mode }) {
  const now = Date.now();
  _createMatch.run({
    id,
    creator_id,
    stake_amount,
    stake_token,
    kill_target: kill_target ?? 7,
    password_hash: password_hash || null,
    match_mode: match_mode || 'open',
    created_at: now,
  });
  return _getMatch.get(id);
}

/** @param {string} id @returns {MatchRow|null} */
function getMatch(id) {
  return _getMatch.get(id) || null;
}

/** @returns {MatchRow[]} */
function listOpenMatches({ token, minStake, maxStake, limit = 50, offset = 0 } = {}) {
  let sql = "SELECT * FROM matches WHERE status IN ('open', 'funded_creator')";
  const params = [];

  if (token) {
    sql += ' AND stake_token = ?';
    params.push(token);
  }
  if (minStake !== null && minStake !== undefined) {
    sql += ' AND stake_amount >= ?';
    params.push(minStake);
  }
  if (maxStake !== null && maxStake !== undefined) {
    sql += ' AND stake_amount <= ?';
    params.push(maxStake);
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
}

const MATCH_FIELDS = ['status', 'joiner_id', 'winner_id', 'win_reason', 'creator_kills', 'joiner_kills', 'creator_deaths', 'joiner_deaths', 'funded_at', 'started_at', 'ended_at', 'rake_amount', 'match_mode'];

/** @param {string} id @param {Partial<MatchRow>} fields @returns {MatchRow|null} */
function updateMatch(id, fields) {
  const keys = Object.keys(fields).filter(k => MATCH_FIELDS.includes(k));
  if (keys.length === 0) return null;
  const filteredFields = {};
  for (const k of keys) filteredFields[k] = fields[k];
  const sets = keys.map(k => `${k} = @${k}`).join(', ');
  const stmt = db.prepare(`UPDATE matches SET ${sets} WHERE id = @id`);
  stmt.run({ id, ...filteredFields });
  return _getMatch.get(id);
}

function joinMatch(matchId, joinerId) {
  const result = _joinMatch.run({ id: matchId, joiner_id: joinerId });
  if (result.changes === 0) return null;
  return _getMatch.get(matchId);
}

/** @returns {TransactionRow} */
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

/** @param {string} userId @param {number} [limit=20] @returns {MatchHistoryRow[]} */
function getMatchHistory(userId, limit = 20) {
  return _getMatchHistory.all(userId, limit);
}

/** @param {number} [limit=50] @returns {UserRow[]} */
function getLeaderboard(limit = 50) {
  return _getLeaderboard.all(limit);
}

const _createChallengeRequest = db.prepare(`
  INSERT INTO challenge_requests (id, match_id, challenger_id, status, created_at)
  VALUES (@id, @match_id, @challenger_id, 'pending', @created_at)
`);
const _getChallengeRequests = db.prepare(`
  SELECT cr.*, u.twitter_handle, u.wins, u.losses, u.elo, u.profile_picture
  FROM challenge_requests cr
  JOIN users u ON cr.challenger_id = u.id
  WHERE cr.match_id = ? AND cr.status = 'pending'
  ORDER BY cr.created_at ASC
`);
const _getChallengeRequest = db.prepare('SELECT * FROM challenge_requests WHERE id = ?');
const _updateChallengeRequest = db.prepare('UPDATE challenge_requests SET status = @status WHERE id = @id');
const _getMyPendingChallenge = db.prepare(
  "SELECT * FROM challenge_requests WHERE match_id = ? AND challenger_id = ? AND status = 'pending' LIMIT 1"
);
const _getMyChallenge = db.prepare(
  "SELECT * FROM challenge_requests WHERE match_id = ? AND challenger_id = ? ORDER BY created_at DESC LIMIT 1"
);
const _expireChallengeRequests = db.prepare(
  "UPDATE challenge_requests SET status = 'expired' WHERE match_id = ? AND status = 'pending'"
);

function createChallengeRequest({ id, match_id, challenger_id }) {
  const now = Date.now();
  _createChallengeRequest.run({ id, match_id, challenger_id, created_at: now });
  return _getChallengeRequest.get(id);
}

function getChallengeRequests(matchId) {
  return _getChallengeRequests.all(matchId);
}

function getChallengeRequest(id) {
  return _getChallengeRequest.get(id) || null;
}

function updateChallengeRequest(id, status) {
  _updateChallengeRequest.run({ id, status });
  return _getChallengeRequest.get(id);
}

function getMyPendingChallenge(matchId, challengerId) {
  return _getMyPendingChallenge.get(matchId, challengerId) || null;
}

function getMyChallenge(matchId, challengerId) {
  return _getMyChallenge.get(matchId, challengerId) || null;
}

function expireChallengeRequests(matchId) {
  return _expireChallengeRequests.run(matchId);
}

function getRecentDeclineCount(creatorId, challengerId, windowMs) {

  const cutoff = Date.now() - windowMs;
  return db.prepare(`
    SELECT COUNT(*) as cnt FROM challenge_requests cr
    JOIN matches m ON cr.match_id = m.id
    WHERE m.creator_id = ? AND cr.challenger_id = ? AND cr.status = 'declined'
    AND cr.created_at > ?
  `).get(creatorId, challengerId, cutoff)?.cnt ?? 0;
}

function clearTestChallengeDeclines(creatorId, challengerId) {

  return db.prepare(`
    DELETE FROM challenge_requests WHERE challenger_id = ? AND status = 'declined'
    AND match_id IN (SELECT id FROM matches WHERE creator_id = ?)
  `).run(challengerId, creatorId);
}

function getStuckMatches() {
  return db.prepare("SELECT * FROM matches WHERE status IN ('in_progress', 'funded_both', 'submitting', 'completed')").all();
}

function getStaleFundedMatches(cutoffMs) {
  return db.prepare("SELECT * FROM matches WHERE status IN ('funded_creator', 'funded_joiner') AND funded_at < ?").all(cutoffMs);
}

function expireStaleMatches(cutoffMs) {
  return db.prepare("UPDATE matches SET status = 'expired' WHERE status = 'open' AND created_at < ?").run(cutoffMs);
}

function getRefundTransactions(matchId) {
  return db.prepare("SELECT * FROM transactions WHERE match_id = ? AND tx_type = 'refund'").all(matchId);
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
  getStuckMatches,
  getStaleFundedMatches,
  expireStaleMatches,
  getRefundTransactions,
  createChallengeRequest,
  getChallengeRequests,
  getChallengeRequest,
  updateChallengeRequest,
  getMyPendingChallenge,
  getMyChallenge,
  expireChallengeRequests,
  getRecentDeclineCount,
  clearTestChallengeDeclines,
};
