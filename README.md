# sNiPeRz.fun

WC3-inspired multiplayer sniper arena with real Solana crypto wagering.

**Live at [sniperz.fun](https://sniperz.fun)**

## Wallet Addresses

| Wallet | Address | Purpose |
|--------|---------|---------|
| **Escrow** | `F1ouG7yQh4iL8qcjAUwKkfJbzexjGHsRQ3coqzuTdMsT` | Holds wager deposits during matches, sends payouts to winners |
| **Treasury** | `FscyMwnYo72ZeWgoN85Ma6UdqMB8vakSRa53uGTQQqV9` | Receives 5% rake from settled matches |

## How It Works

1. **Pick a wager** — SOL, USDC, or SNIPERZ. You choose the stakes.
2. **Snipe or get sniped** — Top-down arena. First to 7 kills wins.
3. **Winner takes all** — Instant payout to your wallet. 5% rake.

## Gameplay

- **Click to move** — click or tap anywhere, your character walks there
- **Auto-shoot** — enemy in range + in your crosshair = they die. 1-shot kills
- **Fog of war** — you can only see what's near you. Find them before they find you
- **Earn gold, buy power** — Windwalk (invisibility), Farsight (reveal map), Boots (speed), Shield (block one shot)
- **Positioning is the only skill** — no aim-bot, no twitch reflexes

## Wager System

- Login with X/Twitter via Privy (embedded Solana wallet, no extensions needed)
- Supported tokens: SOL, USDC, SNIPERZ
- Both players deposit to escrow → match plays → winner gets payout minus 5% rake
- Deferred deposit system: transactions held until both players lock in
- Server crash recovery: stuck matches auto-refund from escrow on restart

## Architecture

```
sniperz/
├── server.js              — Express + WebSocket server (HTTPS/WSS)
├── game.js                — Three.js game client
├── index.html             — Landing page + game UI
├── server/
│   ├── api.js             — REST API (matches, challenges, wallet)
│   ├── wager-match.js     — Isolated 1v1 game loop
│   ├── escrow.js          — Solana deposit/payout/rake transactions
│   └── auth.js            — Privy OAuth + JWT verification
├── client/
│   ├── wager-ui.js        — Wager lobby UI
│   ├── privy-client.js    — Privy auth client (bundled via esbuild)
│   └── deposit-flow.js    — Deposit/lock-in flow
├── shared/
│   ├── constants.js       — Game constants + TOKEN_CONFIG registry
│   ├── collision.js       — AABB collision + line-of-sight
│   ├── game-logic.js      — Shared player/tick/movement logic
│   └── types.js           — JSDoc type definitions
├── db/
│   ├── index.js           — SQLite queries (better-sqlite3)
│   └── schema.sql         — Database schema
└── dist/
    └── privy-bundle.js    — Bundled Privy SDK for browser
```

## Tech Stack

- **Three.js** — 3D rendering
- **Node.js + Express** — Server
- **ws** — WebSocket (binary protocol, 28 bytes/player at 30hz)
- **Privy** — Auth + embedded Solana wallets
- **@solana/web3.js + @solana/spl-token** — On-chain transactions
- **SQLite** (better-sqlite3) — Database
- **esbuild** — Client bundle

## Running

```bash
cd /home/bushi/sniperz
npm install
node server.js
```

Requires `.env` with `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `ESCROW_PRIVATE_KEY`, `TREASURY_WALLET`, `SOLANA_RPC_URL`.

---

*Built with [Claude Code](https://claude.ai/code)*
