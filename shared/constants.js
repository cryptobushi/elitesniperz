// shared/constants.js — Shared constants for client + server
// CommonJS module. Client loads via fetch() or inline.

const MAP_SIZE = 200;
const VISION_RADIUS = 35;
const FARSIGHT_RADIUS = 55;
const SHOOT_RANGE = 25; // Shorter than vision — must close distance to shoot
const SHOOT_COOLDOWN = 1.0;
const FPS_SHOOT_FOV = 8; // Degrees — tight cone for manual FPS aiming
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

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        MAP_SIZE, VISION_RADIUS, FARSIGHT_RADIUS, SHOOT_RANGE, SHOOT_COOLDOWN, FPS_SHOOT_FOV,
        SPAWN_PROTECTION, MAX_PLAYERS, TICK_RATE, SEND_RATE,
        SHOP_ITEMS, BOT_NAMES, terrainY, spawnPos, isNearSpawn
    };
}
