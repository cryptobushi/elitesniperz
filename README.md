# Elite Snipers - Web Edition

A web-based tribute to the legendary Warcraft III custom game "Elite Snipers". Real-time multiplayer sniper combat in a fully 3D environment with fog of war, team-based gameplay, and tactical positioning.

**Live at [sniperz.fun](https://sniperz.fun)**

## Play

- **Online**: Visit [sniperz.fun](https://sniperz.fun) — HTTPS + WSS multiplayer
- **Offline**: Open `index.html` locally — plays with AI bots, no server needed

## Game Rules

- **5v5** Red vs Blue — humans replace bots when they join
- **One-shot kills** — position and aim carefully
- **30-degree FOV cone** — must face enemies to shoot
- **Line of sight** — walls, trees, and rocks block shots
- **Fog of war** — can only see/shoot within 50 units of allies
- **First to 50 kills** wins, or team with most kills after 20 minutes
- **12-second break** between matches, then full reset

## Controls

### Desktop
| Key | Action |
|-----|--------|
| Left Click | Move to location |
| Mouse | Aim weapon (determines shooting direction) |
| Q | Windwalk — invisibility + speed boost (10s cooldown) |
| E | Far Sight — reveal distant area (15s cooldown) |
| B | Open shop (near spawn) |
| Tab | Scoreboard |
| Enter | Chat |
| G | Toggle god mode (debug) |
| WASD / Edge scroll | Pan camera |
| Space | Respawn (when dead) |

### Mobile
- **Tap** to move and aim (you shoot in the direction you walk)
- **Drag** to scroll camera
- **Ability buttons** on screen for Q/E/B/Tab

## Architecture

```
sniperz/
├── server.js           — Express + WebSocket server (HTTPS/WSS)
├── game.js             — Client game logic (Three.js, ~4000 lines)
├── index.html          — Game UI, CSS, entry point
├── shared/
│   ├── constants.js    — MAP_SIZE, SHOOT_RANGE, VISION_RADIUS, shop items
│   └── collision.js    — AABB collision detection + line-of-sight raycasting
├── map-data.json       — 26 walls, 56 trees, 30 rocks
├── sounds/             — Kill streak announcements (Quake/UT-style)
├── test-suite.js       — 67-test automated test suite
└── package.json
```

## Online vs Offline Mode

| Feature | Online (sniperz.fun) | Offline (local HTML) |
|---------|---------------------|---------------------|
| Players | Real humans + bots | 10 AI bots |
| Shooting | Server-authoritative | Client-side |
| Bot AI | Server-side (64hz tick) | Client-side |
| FOV/Aim | Mouse (desktop) or move direction (mobile) | Mouse + weapon quaternion |
| Match system | 50-kill limit, 20min timer, auto-restart | None (endless) |
| Team balance | Auto-balance on join, 5v5 enforced | Fixed 5v5 bots |
| State sync | Binary WebSocket (28 bytes/player at 30hz) | Local |
| Chat | WebSocket chat system | None |
| Rejoin | 5-min state recovery window | N/A |
| AFK detection | 2-min timeout → bot auto-pilot | None |

## Server

- **HTTPS** with Let's Encrypt certs (`/etc/letsencrypt/live/sniperz.fun/`)
- **WSS** on port 443, HTTP :80 redirects to HTTPS
- Falls back to plain HTTP if no certs found
- 64hz server tick, 30hz state broadcast
- Binary protocol: 28 bytes per player (id, position, rotation, health, kills, deaths, price, flags, streak, gold)

### Running the server

```bash
cd /home/bushi/sniperz
nohup node server.js > server.log 2>&1 &
```

Requires `setcap 'cap_net_bind_service=+ep' /usr/bin/node` for port 443 without root.

## Bot AI

Server-side bots (`updateBot` in server.js):

- **Movement**: Direct path → wall slide (X then Z) → perpendicular nudge → new target after 5 stuck frames
- **Wall escape**: If inside a wall AABB, push out gradually at 2x speed
- **Idle detection**: If no movement for 128 ticks (~2s), pick new target
- **Target selection**: 60% center patrol, 40% wider map. Avoids enemy spawn.
- **Chase**: Direct pursuit with LOS. If wall blocks, picks perpendicular waypoint to navigate around.
- **Aiming**: Turns toward enemy at 120 deg/sec. Must face within 30 deg FOV to fire.
- **Reaction delay**: 0.4-1.0s delay when first spotting a new enemy before shooting.
- **Auto-buy**: Purchases items when near spawn with enough gold.

## Combat System

- **Shoot range**: 50 units (matches vision radius)
- **FOV cone**: 30 degrees from aim direction
- **Line of sight**: Raycasts every 0.8 units, 0.05 collision radius, skips first/last 2 units near shooter/target
- **Shoot cooldown**: 1.0 seconds
- **Spawn protection**: 1.5 seconds of invulnerability
- **Visibility gate**: Can only shoot enemies visible to your team (within 50 units of any ally)
- **Vision hysteresis**: 50 units to spot, 53 units to lose sight (prevents edge-of-vision flicker)

## Shop Items

| Item | Cost | Effect |
|------|------|--------|
| Swift Boots | 100 | +20% speed |
| Windrider Boots | 300 | +50% speed (requires Swift Boots) |
| Shadow Cloak | 150 | +3s windwalk duration |
| Phantom Shroud | 400 | +6s windwalk duration (requires Shadow Cloak) |
| Scout Scope | 150 | +25% shoot range |
| Eagle Eye | 400 | +50% shoot range (requires Scout Scope) |
| Vision Ward | 75 | Place a ward (stackable) |
| Iron Buckler | 200 | Survive one shot |
| Hair Trigger | 250 | -30% shot cooldown |
| Bounty Hunter | 200 | +50% gold per kill |

## Test Suite

Run `node test-suite.js` with the server running. Tests:

- **Constants** (5): Range, vision, map size, player count
- **Collision** (8): Walls, spawns, boundaries, 200 random spawn validity
- **Line of Sight** (15): Wall blocking, open field, near-wall shots, game positions
- **FOV Cone** (10): All angles, all cardinal directions
- **Shoot Simulation** (9): Hit scenarios, blocks, edge cases, mobile aim
- **Terrain** (3): Height values, character offset
- **Live Server** (17): Team balance, bot movement, kill rate, disconnect handling, 30s combat sim

## Edge Cases Handled

- **AFK players**: 2-min idle → bot auto-pilot, chat announcement
- **Disconnects**: State saved for 5-min rejoin window, bot replaces immediately
- **Match reset**: All players respawned at team spawn, stats/items/gold reset
- **Team balance**: Auto-assign to smaller team, refuse join if both teams full
- **Mobile keyboard**: Resize ignored when virtual keyboard opens, scroll-to-top on chat focus
- **iOS WebSocket**: 3-second timeout fallback to offline mode
- **Fog flicker**: Vision hysteresis (50 enter / 53 exit) prevents rapid toggling

## Tech Stack

- **Three.js** (v0.160.0) — 3D rendering via CDN
- **Node.js** + **Express** v5 — Server
- **ws** — WebSocket server
- **Puppeteer** — Available for headless testing
- **Let's Encrypt** — TLS certificates (ECDSA)

## Credits

Inspired by the classic Warcraft III custom game "Elite Snipers".

---

*Built with [Claude Code](https://claude.ai/code)*
