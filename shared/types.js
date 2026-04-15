// shared/types.js — JSDoc type definitions for core data shapes
// CommonJS module. Not executable — import for JSDoc @typedef references only.
//
// These types document the data shapes flowing between server, client, and DB.
// Import in any file with: const types = require('./shared/types'); // eslint-disable-line

// ─── Match Status State Machine ────────────────────────────────────────────
// open -> matched -> funded_creator / funded_joiner -> funded_both -> in_progress -> completed -> settled
// Branches: cancelled, disputed, expired (terminal states)

/**
 * @typedef {'open' | 'matched' | 'funded_creator' | 'funded_joiner' | 'funded_both' | 'in_progress' | 'completed' | 'settled' | 'cancelled' | 'disputed' | 'expired' | 'submitting'} MatchStatus
 */

/**
 * @typedef {'SOL' | 'USDC'} StakeToken
 */

/**
 * @typedef {'deposit' | 'payout' | 'rake' | 'refund'} TransactionType
 */

/**
 * @typedef {'open' | 'selective'} MatchMode
 */

/**
 * @typedef {'kill_target' | 'forfeit_disconnect' | 'forfeit_afk' | 'time_limit' | 'draw' | 'afk_forfeit' | 'disconnect_forfeit'} WinReason
 */

/**
 * @typedef {'pending' | 'accepted' | 'declined' | 'expired'} ChallengeStatus
 */

// ─── DB Row Types ──────────────────────────────────────────────────────────

/**
 * User row from the users table.
 * @typedef {Object} UserRow
 * @property {string} id - Privy DID (did:privy:xxxx)
 * @property {string} twitter_handle
 * @property {string|null} twitter_id
 * @property {string|null} privy_wallet - Privy-managed Solana wallet pubkey
 * @property {string|null} funding_wallet - First external wallet that deposited
 * @property {string|null} display_name
 * @property {string|null} profile_picture
 * @property {number} created_at - Unix timestamp ms
 * @property {number} last_seen - Unix timestamp ms
 * @property {number} wins
 * @property {number} losses
 * @property {number} draws
 * @property {number} total_earned - Base units (lamports / USDC 1e-6)
 * @property {number} total_wagered - Base units
 * @property {number} elo
 */

/**
 * Match row from the matches table.
 * @typedef {Object} MatchRow
 * @property {string} id - UUID v4
 * @property {string} creator_id - References users.id
 * @property {string|null} joiner_id - References users.id
 * @property {MatchStatus} status
 * @property {number} stake_amount - Base units (lamports for SOL, 1e-6 for USDC)
 * @property {StakeToken} stake_token
 * @property {number} rake_amount - Base units
 * @property {number} kill_target
 * @property {string|null} password_hash - bcrypt hash if private
 * @property {MatchMode} match_mode
 * @property {number} created_at - Unix timestamp ms
 * @property {number|null} funded_at
 * @property {number|null} started_at
 * @property {number|null} ended_at
 * @property {string|null} winner_id - References users.id
 * @property {WinReason|null} win_reason
 * @property {number} creator_kills
 * @property {number} joiner_kills
 * @property {number} creator_deaths
 * @property {number} joiner_deaths
 */

/**
 * Match data enriched with creator/joiner info, as returned by GET /api/matches and GET /api/matches/:id.
 * password_hash is stripped and replaced with passwordProtected boolean.
 * @typedef {Object} MatchResponse
 * @property {string} id
 * @property {string} creator_id
 * @property {string|null} joiner_id
 * @property {MatchStatus} status
 * @property {number} stake_amount
 * @property {StakeToken} stake_token
 * @property {number} kill_target
 * @property {MatchMode} match_mode
 * @property {boolean} passwordProtected
 * @property {string|null} creator_twitter
 * @property {string|null} creator_pfp
 * @property {number} creator_wins
 * @property {number} creator_losses
 * @property {number} creator_elo
 * @property {string|null} [joiner_twitter] - Only in GET /matches/:id
 * @property {string|null} [joiner_pfp]
 * @property {number} [joiner_wins]
 * @property {number} [joiner_losses]
 * @property {number} [joiner_elo]
 * @property {number} created_at
 * @property {number|null} funded_at
 * @property {number|null} started_at
 * @property {number|null} ended_at
 * @property {string|null} winner_id
 * @property {WinReason|null} win_reason
 * @property {number} creator_kills
 * @property {number} joiner_kills
 * @property {number} creator_deaths
 * @property {number} joiner_deaths
 */

/**
 * Transaction row from the transactions table.
 * @typedef {Object} TransactionRow
 * @property {string} id - UUID v4
 * @property {string|null} match_id
 * @property {string|null} user_id
 * @property {TransactionType} tx_type
 * @property {number} amount - Base units
 * @property {StakeToken} token
 * @property {string|null} tx_signature - Solana tx signature
 * @property {string|null} from_wallet
 * @property {string|null} to_wallet
 * @property {'pending' | 'confirmed' | 'failed'} status
 * @property {number} created_at
 * @property {number|null} confirmed_at
 */

/**
 * Match history row from match_history table.
 * @typedef {Object} MatchHistoryRow
 * @property {number} id - Auto-increment
 * @property {string} match_id
 * @property {string} user_id
 * @property {string} opponent_id
 * @property {'win' | 'loss' | 'draw'} result
 * @property {number} kills
 * @property {number} deaths
 * @property {number} stake_amount
 * @property {StakeToken} stake_token
 * @property {number} payout
 * @property {number} played_at
 */

/**
 * Challenge request row from challenge_requests table.
 * @typedef {Object} ChallengeRequestRow
 * @property {string} id
 * @property {string} match_id
 * @property {string} challenger_id
 * @property {ChallengeStatus} status
 * @property {number} created_at
 */

// ─── Game Object Types ─────────────────────────────────────────────────────

/**
 * Player object as created by createPlayer() in server.js and wager-match.js.
 * This is the in-memory representation during gameplay — not stored in DB.
 *
 * @typedef {Object} Player
 * @property {number} id - Numeric player ID (1-based)
 * @property {string} username
 * @property {'red' | 'blue'} team
 * @property {boolean} isBot
 * @property {number} x - World position X
 * @property {number} z - World position Z
 * @property {number} y - World position Y (terrain height + 0.6)
 * @property {number} rot - Facing rotation (radians)
 * @property {number} health - 0 = dead, 100 = alive
 * @property {number} kills
 * @property {number} deaths
 * @property {number} price - Bounty value (market price mechanic)
 * @property {number} gold
 * @property {number} streak - Current kill streak
 * @property {number} spawnProt - Spawn protection timer (seconds remaining)
 * @property {boolean} windwalk - Currently windwalking (invisible)
 * @property {number} windwalkTimer - Windwalk seconds remaining
 * @property {boolean} farsight - Farsight active
 * @property {number} farsightX - Farsight center X
 * @property {number} farsightZ - Farsight center Z
 * @property {number} farsightTimer - Farsight seconds remaining
 * @property {number} shootCd - Shoot cooldown (seconds remaining)
 * @property {number} shootRange - Current shoot range (modified by items)
 * @property {number} shootCooldownTime - Base cooldown between shots (modified by items)
 * @property {number} aimRot - Aim direction (radians)
 * @property {number} speed - Current move speed
 * @property {number} normalSpeed - Base move speed (modified by items)
 * @property {number} windwalkSpeed - Speed while windwalking
 * @property {boolean} hasShield - Iron Buckler active
 * @property {number} goldMultiplier - Bounty Hunter multiplier
 * @property {Object<string, boolean>} inventory - Owned shop items (itemId -> true)
 * @property {{x: number, z: number}|null} moveTarget - Click-to-move target
 * @property {number} wwCooldown - Windwalk ability cooldown
 * @property {number} fsCooldown - Farsight ability cooldown
 * @property {number} lastInput - Timestamp of last input (for AFK detection)
 * @property {boolean} afk
 */

/**
 * Additional bot-only fields added by server.js createPlayer() when isBot=true.
 * @typedef {Player & BotFields} BotPlayer
 */

/**
 * @typedef {Object} BotFields
 * @property {'explore' | 'chase' | 'camp'} botState
 * @property {{x: number, z: number}|null} botTarget
 * @property {number} campTimer
 * @property {number} stuckFrames
 * @property {number} lastX
 * @property {number} lastZ
 */

// ─── Binary State Encoding ─────────────────────────────────────────────────
// Per-player binary format (28 bytes):
//   id(u16) + x(f32) + z(f32) + rot(f32) + alive(u8) + kills(i16) + deaths(i16)
//   + price(f32) + flags(u8) + streak(i16) + gold(i16)
//
// Flags byte: bit0=windwalk, bit1=spawnProt, bit2=isBot, bit3=blueTeam, bit4=inFog

/**
 * @typedef {Object} ShopItem
 * @property {string} name
 * @property {number} cost - Gold cost
 * @property {string} icon - Icon identifier (text key on server, emoji on client)
 * @property {string} desc - Short description
 * @property {string} stat - Stat affected: 'speed' | 'wwDur' | 'range' | 'ward' | 'shield' | 'firerate' | 'goldMult'
 * @property {number} [mult] - Multiplier to apply (for speed, range, firerate, goldMult)
 * @property {number} [val] - Flat value to apply (for wwDur, ward, shield)
 * @property {number} tier - 1 or 2
 * @property {string} group - Item group for upgrade chains
 * @property {string} [requires] - Item ID required before purchase (tier 2 items)
 * @property {boolean} [stackable] - Can buy multiple (ward only)
 */

// ─── API Response Wrapper ──────────────────────────────────────────────────

/**
 * Standard API response envelope.
 * @template T
 * @typedef {Object} ApiResponse
 * @property {boolean} success
 * @property {T} [data] - Present when success=true
 * @property {string} [error] - Present when success=false
 */

// Export nothing — this file exists solely for JSDoc type references.
// To use in another file:
//   /** @type {import('./shared/types').MatchRow} */
//   const match = db.getMatch(id);
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {};
}
