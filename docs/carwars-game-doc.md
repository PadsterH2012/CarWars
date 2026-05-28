# Car Wars — Game Description Document

> **Purpose:** Complete reference of the Car Wars game as it exists today. Feed this to another agent (Jenny, Claude Code, etc.) to brainstorm game-time features or plan the next phase.

---

## 1. What It Is

**Car Wars** is a 2D top-down browser game faithful to Steve Jackson Games' Car Wars Compendium (2nd Edition). You design and buy combat vehicles, hire drivers, fight arena matches and road encounters, and manage a gang's economy. Built in TypeScript with a Phaser 3 client and Express/ws/pg server.

**Live at:** `hl-carwars.techpad.uk` (10.202.28.192) — port 3001
**Source:** `/opt/carwars/src/server` (server) and `/opt/carwars/src/client` (Phaser client)
**Deployed:** `/opt/carwars/app` — systemd `carwars.service`, runs `node dist/main.js`

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| Client | Phaser 3 (WebGL/Canvas), Vite build |
| Server | Express 4, ws (WebSocket), esbuild |
| Database | PostgreSQL 17, local on same VM |
| Shared types | Workspace package `@carwars/shared` |
| AI | Custom driver system with context ring + pathfinding |
| Auth | JWT with bcrypt passwords |

**Monorepo structure:** Workspaces — `client/`, `server/`, `shared/`

---

## 3. Current Gameplay Loop

```text
Player logs in
  → Garage scene (vehicle list, repair, sell)
    → Buy stock vehicles (52 stock designs across divisions 5-40)
    → Visit job board (take contracts for payout)
    → Visit vehicle designer (custom builds)
    → Enter arena match OR travel on world map
      → Arena scene (real-time 100ms tick combat)
        → Drive, steer, fire weapons
        → Damage, fire, wreckage
        → Match ends when one team is destroyed
      → Victory screen (prize money, salvage, XP)
    → Back to garage
```

### 3.1 Garage Scene
- View owned vehicles with armor/weapon stats
- Repair armor (costs money per point × armor type multiplier)
- Sell vehicles
- Buy stock vehicles from AADA Vehicle Guides catalog
- Design custom vehicles (body, chassis, suspension, engine, power plant, armor, weapons, tires, accessories)
- Hire/fire drivers, assign to vehicles
- Job board (take contracts for payout)

### 3.2 Arena Match
- Player vs AI team (1v1 up to 4v4 based on squad size)
- Real-time 100ms ticks, 10 ticks = 1 game turn
- WASD/arrow steering, mouse click or number key to fire weapon
- Optional autopilot (AI drives for you)
- Commander mode (spacebar to pause, issue squad orders: attack, move, follow, retreat)
- Match ends when one team fully destroyed → prize + salvage + XP

### 3.3 World Map / Travel
- Midville region (the only region currently deployed)
- 6 nodes connected by 5 roads
- `POST /api/world/travel` rolls for encounter based on road danger (0.15–0.65)
- Encounter → arena match on a tactical map (highway-ambush, crossroads-blockade, etc.)
- Win → arrive at destination. Lose → ?
- Currently the `WorldMapScene` exists in client code but isn't the primary flow — most players use direct arena entry

---

## 4. Combat System (Core Engine)

### 4.1 Engine Architecture
- `createTurnEngine(initialState, map, options)` → `TurnEngine`
- Tick loop: `resolveTick()` runs every 100ms (10 ticks per game turn)
- State machine: vehicles → movement → collision → hazards → control checks → combat → fire → wreckage

### 4.2 Movement
- Speed in mph, distance per tick = `speed / 360` units
- Steering is an impulse (reset after each tick), speed persists
- Slide rotation for fishtail/skid (gradual, 8°/tick max)

### 4.3 Collision
- **Wall collision:** `resolveWallCollisions()` — AABB overlap check, pushes out on minimum penetration axis. Damage = `floor(speed / 5)` to impact face. Speed zeroed on hit.
- **Vehicle-vehicle collision:** `resolveCollision()` — head-on, same-direction, or T-bone. Damage based on closing speed. Friendly vehicles don't damage each other.
- **Vehicle-wreckage collision:** Wrecks have DP; ramplate-equipped vehicles can push through; others bounce.

### 4.4 Hazard Checks
- Every tick, steering input is classified into a maneuver type (bend/drift/swerve/controlled_skid) with a D-value (1-6)
- D-values accumulate per turn (10 ticks)
- Every 10 ticks: `resolveControlTable(HC, D, roll)` — roll 2d6 + D - HC - 7
- Results: none / fishtail (gradual spin) / skid (spin + speed halved) / roll / collision
- Light bodies (cycles, subcompact) oversteer more; heavy bodies (van, truck) understeer

### 4.5 Combat (Weapons)
- **Firing:** Once per 10 ticks (one shot per game turn). Player picks weapon by mount arc.
- **To-hit:** 2d6 vs target number (weapon base + range modifier + target speed + speed differential + target size + driver wounded + driver skill + accessories)
- **Weapon arcs:** front (±45°), back (135-225°), left/right (±45° off sides), turret (360°)
- **Line of sight:** Liang-Barsky segment vs AABB test for wall occlusion
- **Damage:** `rollDamage(dice, mod)` = sum of Nd6 + mod, minimum 1
- **Armor penetration:** damage > armor on a facing = penetrated. Overflow damage = component damage:
  - Front/back hit → engine damage
  - Left/right hit → blown tire
  - Overflow > 3 → driver wounded
  - Overflow > 6 → destroyed
  - On penetration: 1d6 → 5 = fire, 6 = fire + explosion

### 4.6 Fire
- Burning vehicles take 1 armor damage per tick from a random facing
- Fire persists until all armor gone → destroyed
- Chain ignition: vehicles within 2 units of a burning wreck catch fire
- Fire extinguisher accessory (future: grants immunity via hasFireExtinguisher helper)

### 4.7 Wreckage
- Destroyed vehicles become wreckage objects with state: burning (30 ticks) → smouldering (60 ticks) → debris
- Wreckage has DP (5/10/20 based on body mass), can be pushed by ramplate
- Ammo cook-off: vehicles destroyed while carrying ammo may explode (2d6 blast damage, 2-unit radius)
- Blast affects nearby vehicles (closest face takes damage) and other wrecks

### 4.8 Zone End Conditions
- Match checks: at least 2 vehicles were present AND at least 1 wreck exists AND only one playerId's vehicles survive
- End reasons: last_standing, ai_victory, all_destroyed

---

## 5. AI Driver System

### 5.1 Architecture
- Per-vehicle persistent `DriverState` (orbit direction, tactic, position history, fire cooldown, context ring)
- `computeAiInput(self, ctx, order?)` returns `{ speed, steer, fireWeapon }`
- Same function used for AI enemies AND player autopilot

### 5.2 Context Ring (Phase 2)
- Per-tick weighted direction voting from multiple sources:
  - `writeWallDanger()` — wall proximity (steer away)
  - `writeVehicleDanger()` — nearby vehicles
  - `writeWreckageDanger()` — wreckage obstacles
  - `writeGoalInterest()` — tactical bearing from tactic
  - `writePathInterest()` — pathfinder waypoint (Phase 3)
- `ring.pick(facing)` returns the best bearing considering all inputs

### 5.3 Tactics
- **aggressive:** Close distance, orbit at preferred range
- **flanking:** Circle to enemy's rear quarter
- **snipe:** Stay at long range, fire only when well-aimed
- **orbit:** Circle at preferred range, present strongest armor
- **evasive:** Flee at max speed, present strongest face
- Tactic switches every 15+ ticks; forced change at <20% armor

### 5.4 Stuck Recovery
- Two-layer stuck detection (per-tick movement < 0.1 units, 15-tick position spread vs expected)
- Phased escape: sidestep → drive away → sweep compass → panic (alternate full forward/reverse)

### 5.5 Squad Orders
- Commander mode orders: attack (target specific enemy), move (drive to waypoint, pathfinding), follow (stay 4 units behind), retreat (maximise distance from enemies)
- Squad roles: flanker_l/flanker_r, support, anchor — bias tactic selection

### 5.6 Driver Stats
- **skill** (1-6): affects to-hit modifier (skillToHitModifier), max steer rate, XP accumulation
- **aggression** (1-6): shifts preferred range, snipe threshold, squad role bids
- **loyalty** (1-10): affects squad role assignment, retreat compliance, saturation-aversion in target selection
- **XP:** Earned per match (5 × damageDealt + 5 × hitsTaken + 10 if alive). Level-up at skill × 100 XP (up to skill 6)

---

## 6. World Map System

### 6.1 Data Model
```
WorldNode: id, name, kind (city/town/truck_stop/arena/garage/market), x, y, services[], controllingGangId?
WorldRoad: id, from, to, distance, roadType (highway/urban/dirt/mountain), danger (0-1), encounterTable
WorldRegion: id, name, nodes[], roads[]
```

### 6.2 Midville Region (the only region)
6 nodes connected by 5 roads:
| Road | Type | Danger | Distance |
|---|---|---|---|
| Midville ↔ Rustwater | highway | 0.15 (15%) | 22 |
| Rustwater ↔ New Boston | highway | 0.35 (35%) | 31 |
| Midville ↔ Fort Grimm | urban | 0.65 (65%) | 27 |
| Rustwater ↔ Dust Pike | dirt | 0.40 (40%) | 18 |
| New Boston ↔ Blacktop | urban | 0.30 (30%) | 16 |

### 6.3 Travel API
- `POST /api/world/travel { toNodeId }` — rolls encounter vs road.danger
- If encounter: returns `{ outcome: 'encounter', tacticalMapId, description }`
- If arrived: updates gang's current_world_node_id
- Encounter maps mapped by encounterTable: highway-low/medium → highway-ambush, gang-high → crossroads-blockade, dirt/urban-medium → truck-stop-forecourt, default → truck-stop

---

## 7. Economy

| Activity | Money Flow |
|---|---|
| Arena prize | `division × 500 × squadMultiplier` |
| Job payout | Configurable per job |
| Salvage | Fraction of destroyed enemy vehicle build cost |
| Vehicle purchase | Stock vehicle cost (from DB, $2,780–$39,960) |
| Repair | Armor points × body armorCostPerPt × armor type multiplier |
| Driver wages | $50 × driver skill per match (deducted from treasury) |
| Maintenance | $10 per vehicle per match |
| XP | Not monetary — improves driver skill |

### 7.1 Stock Vehicles
52 vehicles across divisions 5-40 in the `stock_vehicles` table. Examples:
- **Division 5:** Tri-Rock ($4,880), Fire Imp ($4,883), Sprocket ($4,994), Slingshot ($4,922)
- **Division 10:** MG3 ($9,850), Guardian ($9,960), Overkill ($9,995), Bubba ($9,692)
- **Division 15:** Gatling ($14,820), Cyclops ($14,902), Volcano ($14,980)
- **Division 20:** Desperado ($19,950), Slayer ($20,000), Jackhammer ($20,000)
- **Division 25:** Hades Mk. 3 ($24,544), Tankbuster ($24,605), Smokin' Joe ($24,972)
- **Division 30:** Stormy Weather ($29,940)
- **Division 40:** Kali ($39,237), Beamer ($39,960), Omega-40 ($39,770)

### 7.2 Repair
- `POST /api/vehicles/:id/repair` — repairs all armor deficit
- Cost = deficit × body.armorCostPerPt × armorTypeMultiplier
- Armor types: ablative (×1), metal (×1), fireproof (×2), laser_reflective (×2), lr_fireproof (×4), radarproof (×2)

### 7.3 Driver XP / Skill Up
- XP per match: `5 × damageDealt + 5 × hitsTaken + 10 (if alive)`
- Level-up threshold: `skill × 100` XP
- Skill caps at 6 (master)

---

## 8. Available Maps (7 total)

| Map ID | Type | Size | Description |
|---|---|---|---|
| `open` | Arena | 40×23 | Wasteland opening, boundary walls |
| `truck-stop` | Arena | 40×40 | Truck Stop with buildings |
| `town-square` | Arena | 40×40 | Urban town square |
| `double-drum` | Arena | 40×40 | Double Drum arena |
| `highway-ambush` | Road encounter | 60×20 | Highway with wrecks, turrets |
| `crossroads-blockade` | Road encounter | 40×40 | 4-way intersection with barricades |
| `truck-stop-forecourt` | Road encounter | 40×40 | Truck stop forecourt |

---

## 9. Weapons Catalog

| ID | Name | Category | To-Hit | Damage | Short Range | Long Range |
|---|---|---|---|---|---|---|
| mg | Machine Gun | small_bore | 7 | 1d6 | 6 | 12 |
| vmg | Vulcan MG | small_bore | 6 | 2d6 | 6 | 12 |
| ac | Autocannon | small_bore | 6 | 3d6 | 8 | 16 |
| rr | Recoilless Rifle | small_bore | 7 | 2d6 | 8 | 16 |
| gl | Grenade Launcher | large_bore | 7 | 1d6+2 | 4 | 8 |
| atg | Anti-Tank Gun | large_bore | 8 | 3d6 | 10 | 20 |
| bc | Blast Cannon | large_bore | 7 | 4d6 | 8 | 16 |
| ltr/mr/hr | Light/Med/Heavy Rocket | rocket | 9 | 1/2/3d6 | 4/6/8 | 8/12/16 |
| rl | Rocket Launcher | rocket | 8 | 2d6 | 8 | 16 |
| mml | Micromissile Launcher | rocket | 8 | 1d6 | 6 | 12 |
| ll/ml/l/hl | Light/Med/Heavy Laser | laser | 6 | 1/2/3/4d6 | 8/10/10/12 | 16/20/20/24 |
| lft | Light Flamethrower | flamer | 6 | 1d6-2 | 3 | 5 |
| ft | Flamethrower | flamer | 6 | 1d6 | 5 | 10 |
| sd | Spikedropper | dropped | - | 1d6 | 1 | 1 |
| oj | Oil Jet | dropped | - | 0 (hazard) | 1 | 1 |
| oil | Oil Slick | dropped | - | 0 (hazard) | 1 | 1 |
| mine | Mine | dropped | - | 3d6 | 1 | 1 |

---

## 10. Rival Gangs

Rival system is built but only used in arena matches:
- 5-8 named gangs seeded in `rival_gangs` table
- Each has: name, description, base_skill, colours, emblem, division range, lineup (stock vehicle IDs per division)
- Weighted random selection: prefer rivals with existing grudge
- Grudge grows when player wins (+10) and shrinks when player loses (-5)
- Effective skill: `base_skill + floor(grudge / 20)`, capped at 6
- Currently only triggers in direct arena matches — rival gangs are NOT simulated in the background

---

## 11. Database Tables

Key tables (PostgreSQL on localhost):
- `players` — auth, username, password hash, money, division, reputation
- `gangs` — owner_player_id, name, current_world_node_id (nullable), colours
- `vehicles` — player_id, name, loadout (JSON), original_loadout, damage_state (JSON), value, in_arena
- `drivers` — name, skill, aggression, loyalty, XP, alive, assigned_vehicle_id
- `stock_vehicles` — catalog of purchasable designs
- `jobs` — type, payout, from/to_node, taken_by, zone_id, completed
- `gang_ledger` — financial audit trail per gang
- `event_history` — player event log
- `rival_gangs` — seeded rival data
- `player_rival_rep` — per-player-gang rep against each rival

---

## 12. Known Issues / Bugs Fixed This Session

- ✅ **Spawn distances** — crossroads-blockade and highway-ambush maps had player/AI spawns 48+ units apart (MG range is 16). Tightened to ~20-28 units.
- ✅ **onFire persistence** — vehicles saved `onFire: true` to DB between matches, causing players to start next match already burning. Fixed at both load-time (sanitise on entry) and save-time (clear on exit).

---

## 13. What's Planned But Not Built

See the separate **Ideas Bucket** (saved in agent memory as a tagged project entry: `carwars`, `ideas`, `feature-backlog`). Key unbuilt items:

- **Simulated rival economy** — headless combat engine runs rival vs rival and rival vs NPC matches as a cron tick, updating their treasury/rep/roster
- **Player background ops** — player's hired drivers run jobs while offline (same headless engine)
- **World map jobs** — supply runs, convoys, bounties, scouts tied to the travel system
- **Base building** — buy buildings for passive income, repair discount, safe retreat
- **Full economy** — wages, insurance, garage fees
- **Procedural road encounter generation** — dynamic maps from snippets
- **E2E tests** — Playwright-based full game loop tests

---

*Generated 2026-05-28 from source code and Open Brain project memories. Contact Amber for updates.*