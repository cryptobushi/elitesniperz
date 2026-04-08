# Gun System Design

## Overview

Every player builds a custom sniper rifle from modular block parts (Mega Blocks inspired). The gun's shape directly affects gameplay stats — bigger gun = more power but heavier. Perks slot onto individual parts for special abilities.

One-shot kill stays. Stats affect *how you get the shot*, not whether it kills.

---

## Core Stats (Derived from Parts)

Every part added affects the gun's stats. Gun building is a real strategic decision.

| Stat | What it does | Affected by |
|------|-------------|-------------|
| **Range** | Max shoot distance | Barrel length (more = longer range) |
| **Fire Rate** | Cooldown between shots | Receiver size (bigger = slower), trigger parts |
| **Weight** | Move speed penalty | Total part count + sizes |
| **Stability** | FPS recoil amount, top-down cone size | Stock parts, grip parts |
| **ADS Speed** | How fast you scope in | Scope size (bigger = slower), weight |
| **Stealth** | Muzzle flash visibility + sound range | Silencer parts, barrel length |

### Stat Formulas (Draft)

```
Range = BASE_RANGE + (barrel_length * 1.5)
Fire Rate = BASE_COOLDOWN + (receiver_volume * 0.1)
Weight = sum(part_volume) * WEIGHT_FACTOR
Move Speed = BASE_SPEED * (1 - weight * 0.02)  // capped at -40%
Stability = BASE_STABILITY + (stock_volume * 0.3) + (grip_count * 0.2)
ADS Speed = BASE_ADS / (1 + scope_volume * 0.15)
Stealth = BASE_STEALTH + (silencer_parts * 0.3) - (barrel_length * 0.05)
```

---

## The Tradeoff Triangle

Three distinct playstyles emerge from gun design:

- **Big Heavy Gun** — long range, stable, slow movement → sniper nest, hold angles
- **Small Light Gun** — short range, fast, mobile → aggressive flanker, repositioning
- **Balanced Build** — medium everything → versatile, adaptable

The gun IS your class. No class selection needed.

---

## Perks

Each part has **one perk slot**. Perks snap onto a specific part type — you can't put a barrel perk on a stock.

### Barrel Perks
| Perk | Effect | Rarity |
|------|--------|--------|
| **Piercing** | Shoots through thin walls (not thick) | Rare |
| **Tracer** | Visible bullet trail — intimidation + easier follow-up | Common |
| **Ghost Round** | No bullet trail visible to enemies | Uncommon |
| **Long Shot** | +25% range, +0.5s cooldown | Uncommon |

### Stock Perks
| Perk | Effect | Rarity |
|------|--------|--------|
| **Ironhold** | Zero recoil on 1st shot after standing still 2s | Rare |
| **Quick Draw** | Switch to FPS mode 2x faster | Common |
| **Steady** | Reduced sway while moving | Common |

### Scope Perks
| Perk | Effect | Rarity |
|------|--------|--------|
| **Tracker** | Scoped enemies stay highlighted 2s after unscoping | Rare |
| **Thermal** | See enemies through fog at reduced range | Legendary |
| **Glint Warning** | See a flash when someone scopes at you | Uncommon |

### Receiver Perks
| Perk | Effect | Rarity |
|------|--------|--------|
| **Hair Trigger** | -30% cooldown | Uncommon |
| **Double Tap** | Fire 2 rapid shots (2nd has worse accuracy) | Rare |
| **Overcharge** | Hold click to charge — breaks shield + kills | Legendary |

### Grip Perks
| Perk | Effect | Rarity |
|------|--------|--------|
| **Snap Aim** | Faster ADS speed | Common |
| **Nomad** | No move speed penalty from weight | Rare |
| **Last Stand** | On death, drop a mine that kills nearby enemies | Legendary |

### Silencer Perks
| Perk | Effect | Rarity |
|------|--------|--------|
| **Phantom** | Kill doesn't reveal position on minimap | Uncommon |
| **Whisper** | Sound range reduced 50% | Common |
| **Cold Barrel** | First shot after 5s idle has +50% range | Rare |

### Universal Perks (Any Part)
| Perk | Effect | Rarity |
|------|--------|--------|
| **Lucky** | 10% chance to not consume cooldown | Uncommon |
| **Vampire** | Kill restores shield | Rare |
| **Bounty** | +25% gold per kill | Common |

### Rarity Drop Rates
| Rarity | Drop Rate | Color |
|--------|-----------|-------|
| Common | 50% | White |
| Uncommon | 30% | Green |
| Rare | 15% | Blue |
| Legendary | 5% | Gold |

---

## How Perks Are Earned

- **Kill streak**: 1 random perk drop every 5 kills
- **Match win**: Pick 1 from 3 random perks
- **Shop**: Spend gold on random perk rolls (price scales with rarity)
- **Salvage**: Destroy a perk to get partial gold back

---

## NFT / Crypto Layer (Future)

The gun system is designed to be NFT-ready without requiring crypto to play.

### On-Chain Gun Assets
- Gun design = JSON blob → trivially mintable as Solana compressed NFT (near-zero cost)
- Gun JSON stored in NFT metadata — fully on-chain, client renders from data
- No image hosting needed — the game IS the renderer

### Scarce Materials
- Current palette: 16 solid colors (free to use)
- **Rare materials**: Chrome, Holographic, Lava, Galaxy, Void, Gold Plated
- Materials only exist as drops or mints — geometry is free, materials are scarce
- Visual flex + trading value

### Kill-Verified Guns
- NFT metadata embeds: kill counter, win count, tournament placements
- A gun that won a tournament is provably legendary
- Stats are written on-chain after each match (optional)

### Trading & Marketplace
- Players trade guns on Magic Eden / Tensor
- Gun builder = crafting system → build, play, earn stats, sell
- **Parts marketplace**: Individual rare parts as NFTs (e.g., "Void Barrel" — 100 exist)

### The Loop
```
Build Gun → Play Matches → Earn Perks/Materials → Upgrade Gun
    → Gun Gains History → Mint (optional) → Trade/Sell → Build Another
```

The game works perfectly without crypto. NFT layer is opt-in for players who want to own/trade their creations.

---

## Implementation Order

1. **Stat calculation** from parts (weight system, range from barrel length, etc.)
2. **Apply stats** to gameplay (move speed, shoot range, cooldown, recoil)
3. **Perk data structure** + storage format
4. **Perk UI** to attach/detach perks on parts
5. **Perk effects** in game logic (server-side validation)
6. **Perk drops** — earn system tied to kills/wins
7. **NFT integration** — mint function, metadata format, on-chain stats
