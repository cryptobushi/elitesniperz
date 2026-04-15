
const MAP_SIZE = 200;
const VISION_RADIUS = 35;
const FARSIGHT_RADIUS = 55;
const SHOOT_RANGE = 25;
const SHOOT_COOLDOWN = 1.0;
const SPAWN_PROTECTION = 1.5;
const MAX_PLAYERS = 10;
const TICK_RATE = 64;
const SEND_RATE = 30;

const SHOP_ITEMS = {
    boots1:    { name: 'Swift Boots',      cost: 100, icon: 'boots', desc: '+20% speed',        stat: 'speed',     mult: 1.2, tier: 1, group: 'boots' },
    boots2:    { name: 'Windrider Boots',  cost: 300, icon: 'wind',  desc: '+50% speed',        stat: 'speed',     mult: 1.5, tier: 2, group: 'boots', requires: 'boots1' },
    cloak1:    { name: 'Shadow Cloak',     cost: 150, icon: 'moon',  desc: '+3s windwalk',      stat: 'wwDur',     val: 3,    tier: 1, group: 'cloak' },
    cloak2:    { name: 'Phantom Shroud',   cost: 400, icon: 'ghost', desc: '+6s windwalk',      stat: 'wwDur',     val: 6,    tier: 2, group: 'cloak', requires: 'cloak1' },
    scope1:    { name: 'Scout Scope',      cost: 150, icon: 'scope', desc: '+25% range',        stat: 'range',     mult: 1.25, tier: 1, group: 'scope' },
    scope2:    { name: 'Eagle Eye',        cost: 400, icon: 'eagle', desc: '+50% range',        stat: 'range',     mult: 1.5, tier: 2, group: 'scope', requires: 'scope1' },
    ward:      { name: 'Vision Ward',      cost: 75,  icon: 'eye',   desc: 'Place a ward',      stat: 'ward',      val: 1,    tier: 1, group: 'ward', stackable: true },
    shield:    { name: 'Iron Buckler',     cost: 200, icon: 'shield',desc: 'Survive 1 shot',    stat: 'shield',    val: 1,    tier: 1, group: 'shield' },
    rapidfire: { name: 'Hair Trigger',     cost: 250, icon: 'bolt',  desc: '-30% shot cooldown', stat: 'firerate',  mult: 0.7, tier: 1, group: 'firerate' },
    bounty:    { name: 'Bounty Hunter',    cost: 200, icon: 'gold',  desc: '+50% gold per kill', stat: 'goldMult',  mult: 1.5, tier: 1, group: 'bounty' },
};

const BOT_NAMES = ['Archon','Vex','Nyx','Zara','Kael','Drax','Luna','Hex','Rune','Ash'];

function terrainY(x, z) {
    return Math.sin(x * 0.1) * Math.cos(z * 0.1) * 2;
}

function spawnPos(team) {
    const s = team === 'red' ? -70 : 70;
    return { x: s + Math.random() * 10 - 5, z: s + Math.random() * 10 - 5 };
}

function isNearSpawn(x, z, team) {
    const s = team === 'red' ? -70 : 70;
    return Math.sqrt((x - s) * (x - s) + (z - s) * (z - s)) < 15;
}

function dist(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
}

function stakeToHuman(amount, token) {
    const cfg = TOKEN_CONFIG[token];
    return cfg ? amount / Math.pow(10, cfg.decimals) : amount / 1e9;
}

function stakeToBase(amount, token) {
    const cfg = TOKEN_CONFIG[token];
    return Math.round(cfg ? amount * Math.pow(10, cfg.decimals) : amount * 1e9);
}

// Bytes per player in binary state encoding
const BYTES_PER_PLAYER = 28;

// Wager match constants
const WAGER_KILL_TARGETS = [1, 5, 7, 10];
const WAGER_TIME_LIMIT = 600; // 10 minutes in seconds
const WAGER_AFK_TIMEOUT = 30; // Seconds before AFK forfeit
const WAGER_DISCONNECT_TIMEOUT = 30;
const RAKE_PERCENT = 0.05; // 5% rake
const MIN_STAKE_SOL = 10000000; // 0.01 SOL in lamports
const MIN_STAKE_USDC = 1000000; // 1 USDC in base units (1e6)

// Token configuration registry — add new tokens here
// TODO: Replace SNIPERZ mint with actual contract address after pump.fun launch
const TOKEN_CONFIG = {
    SOL:     { decimals: 9, minStake: 10000000,    maxStake: 100000000000, native: true },
    USDC:    { decimals: 6, minStake: 1000000,     maxStake: 10000000000,
               mint: { mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' } },
    SNIPERZ: { decimals: 6, minStake: 1000000,     maxStake: 100000000000000,
               mint: { mainnet: 'PASTE_CONTRACT_ADDRESS_HERE', devnet: 'PASTE_CONTRACT_ADDRESS_HERE' } },
};

/** @enum {string} Match status state machine — see shared/types.js for full docs */
const MATCH_STATUS = {
    OPEN: 'open',
    MATCHED: 'matched',
    FUNDED_CREATOR: 'funded_creator',
    FUNDED_JOINER: 'funded_joiner',
    FUNDED_BOTH: 'funded_both',
    IN_PROGRESS: 'in_progress',
    COMPLETED: 'completed',
    SETTLED: 'settled',
    CANCELLED: 'cancelled',
    DISPUTED: 'disputed',
    EXPIRED: 'expired',
    SUBMITTING: 'submitting',
};

const VALID_TOKENS = Object.keys(TOKEN_CONFIG);

const TX_TYPES = {
    DEPOSIT: 'deposit',
    PAYOUT: 'payout',
    RAKE: 'rake',
    REFUND: 'refund',
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        MAP_SIZE, VISION_RADIUS, FARSIGHT_RADIUS, SHOOT_RANGE, SHOOT_COOLDOWN,
        SPAWN_PROTECTION, MAX_PLAYERS, TICK_RATE, SEND_RATE,
        SHOP_ITEMS, BOT_NAMES, terrainY, spawnPos, isNearSpawn, dist,
        stakeToHuman, stakeToBase, BYTES_PER_PLAYER,
        WAGER_KILL_TARGETS, WAGER_TIME_LIMIT, WAGER_AFK_TIMEOUT,
        WAGER_DISCONNECT_TIMEOUT, RAKE_PERCENT, MIN_STAKE_SOL, MIN_STAKE_USDC,
        MATCH_STATUS, VALID_TOKENS, TX_TYPES, TOKEN_CONFIG
    };
}
