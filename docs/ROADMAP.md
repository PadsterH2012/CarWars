# Car Wars — Master Roadmap

Single source of truth for what's done, what's in flight, and what's queued.
Update the checkboxes here as work progresses. Detailed plan docs live in
`docs/plans/` and are linked from each section below.

---

## How to read this

- `[x]` — shipped and deployed to hl-carwars
- `[~]` — partially done / in flight
- `[ ]` — planned, not started
- `[-]` — descoped / intentionally deferred

Every shipped item has one or more commits on `main`. "Deployed" means it's
live at http://10.202.28.192:3001.

---

## 1. Foundation (original blueprint)

**Plan:** [`2026-03-27-carwars-implementation-plan.md`](plans/2026-03-27-carwars-implementation-plan.md)

- [x] Project scaffold (Vite + Phaser client, Node + ws server, PostgreSQL)
- [x] Rules engine — vehicle, movement, combat
- [x] Turn orchestration (10 ticks/turn, 5 phases)
- [x] WebSocket protocol
- [x] Basic arena scene
- [x] Game loop — server tick
- [x] AI driver (basic)

---

## 2. World & Campaign

**Plan:** [`2026-03-27-carwars-phase2-plan.md`](plans/2026-03-27-carwars-phase2-plan.md)

- [x] Player auth (register/login, JWT)
- [x] Vehicle CRUD + DB hydration
- [x] Tilemap + zone transitions
- [x] Town scene
- [x] Garage scene
- [x] Vehicle designer UI
- [x] Driver hiring
- [x] Division / arena prizes

---

## 3. Combat Rules

**Plans:** [`2026-03-27-phase3-plan.md`](plans/2026-03-27-phase3-plan.md), [`2026-03-28-compendium-rules-plan.md`](plans/2026-03-28-compendium-rules-plan.md)

- [x] Weapon arcs enforced
- [x] Hazard checks + specials (oil, mines)
- [x] Arena end conditions + persistent damage
- [x] Job take / complete flow
- [x] Line-of-sight wall blocking for projectiles
- [x] Compendium — vehicle design system (bodies, chassis, suspension, power plants, tires, armor)
- [x] Compendium — weapons catalog (23 weapons with full stats + range bands)
- [x] Compendium — enhanced combat (to-hit modifier table, dice damage, vehicular fire)
- [x] Compendium — movement fidelity (maneuver classifier, control table, collision resolver)
- [x] Physics-based skid/fishtail with weight/body oversteer/understeer

---

## 4. Arena Map System

**Plan:** [`2026-03-29-arena-map-system-plan.md`](plans/2026-03-29-arena-map-system-plan.md)

- [x] Static `ArenaMap` type with walls + spawn points
- [x] Server-side AABB wall collisions with damage
- [x] Client renders map walls on join
- [x] `open` map — clean arena
- [x] `truck-stop` map — fortified 120×75 arena (scaled up from 80×50 for more combat space)
- [x] `town-square` map (composed with snippets)
- [x] Map snippet library + composer (`road_straight_20`, `road_bend_ws`, `road_t`, `road_cross`, `corner_turret`, `gatehouse`, `wall_straight_20`, `diner`, `gas_station`)
- [ ] **Map selection in UI** — `town-square` and `open` exist but can't be chosen; only truck-stop playable from garage

---

## 5. Economy & Repair

**Plan:** [`2026-03-29-economy-repair-plan.md`](plans/2026-03-29-economy-repair-plan.md)

- [x] Ammo persistence between fights
- [x] Repair fixes blown tires + restores ammo + armor-type cost multipliers
- [x] Division-scaled arena prizes
- [x] Prize + jobPayout in zone_end message
- [x] Job take + auto-complete on arena win
- [x] Post-arena result screen (victory/defeat/draw titles)
- [x] Driver XP on arena win + auto skill promotion
- [x] Garage UX — ammo display, sell vehicle
- [x] Vehicle build debits player money atomically (fixed 2026-04-19)
- [x] Salvage payout to arena victor (Compendium-style: state/cause multipliers)
- [x] Prize scales with squad size (1.0× / 1.5× / 2.0× / 2.5×)
- [ ] **XP → Compendium prestige points** (current: 10/kill + 20/survive placeholder; Compendium: 5 PP/damage + 5 PP/hit-taken + 10 PP/win with named tiers Rookie…Master)

---

## 6. Player Controls & HUD

**Plan:** [`2026-03-30-player-controls-hud.md`](plans/2026-03-30-player-controls-hud.md)

- [x] Continuous acceleration, WASD + arrows
- [x] Weapon selection keys 1–5
- [x] Autopilot key P (moved from Tab)
- [x] `driver_info` message: server tells client max steer per skill
- [x] Server enforces steer cap
- [x] HUD: speed, skill, armor per face, weapon + ammo
- [x] Clamp human input speed to vehicle maxSpeed

---

## 7. Visuals & Wreckage

**Plan:** [`2026-04-18-visuals-and-wreckage-plan.md`](plans/2026-04-18-visuals-and-wreckage-plan.md)

### Phase 1 — Vehicle icons (sprites)
- [x] Placeholder sprite generator (`npm run sprites:gen`) — 70 PNG assets (15 bodies, 10 weapons, 45 wreck states)
- [x] `VehicleSprite` factory: layered body + per-mount weapon overlays + armor bars + fire-glow state overlay
- [x] Team tint: player (bright green) / squadmate (muted green) / enemy (red) / NPC (amber)

### Phase 2 — Wreckage as obstacle
- [x] `WreckageObject` type + `ZoneState.wreckage` field
- [x] Destroyed vehicle → wreck promotion with cause + mass
- [x] Ammo cook-off blast (2-inch radial damage when explosion-killed with ammo onboard)
- [x] State transitions: burning 30t → smouldering 60t → debris forever
- [x] Collision with wreckage + ramplate push logic
- [x] Client wreckage rendering with state-specific sprites + flame overlay
- [x] Killed-by attribution (`killedByVehicleId` on wrecks)
- [ ] **Burning wreck ignites adjacent vehicles** — plan called for 1 tick of fire damage per tick of adjacency; state transitions land but adjacency-based ignition is not implemented

### Phase 3 — Map snippets
- [x] Snippet type + composer
- [x] Seed library (roads + fixtures)
- [x] `town-square` demo map
- [-] Rebuild truck-stop using snippets (deferred — composer verified by tests + town-square)

---

## 8. Gang Management

**Plan:** [`2026-04-19-gang-management-plan.md`](plans/2026-04-19-gang-management-plan.md)

### Phase 1 — Squad Mechanics
- [x] `join_zone` accepts `squadVehicleIds[]`
- [x] Server validates squad (ownership + driver + not in_arena) and spawns all on player team
- [x] Enemy count scales 1:1 with squad size (1v1 up to 4v4)
- [x] Truck-stop has 4 player + 4 AI spawn points for full squad support
- [x] Kill attribution via `WreckageObject.killedByVehicleId`
- [x] Per-driver XP: 10 × kills + 20 if survived
- [x] Garage squad-picker modal (clicked vehicle = primary, pick up to 4 eligibles)
- [x] Squadmates visually distinct (muted green) from primary
- [x] Post-arena per-vehicle kill tally when squad > 1
- [x] `in_arena` cleared for every squad vehicle on disconnect/match end

### Phase 2 — Commander Mode
- [x] Pause/unpause plumbing (server + client)
- [x] `squad_order` client message (attack/move/follow/retreat/clear)
- [x] AI driver honours orders (targeted attack, waypoint move, formation follow, flee from centroid)
- [x] `TacticalOverlay` scene: top-down map, click-to-select, click-enemy-to-attack, click-ground-to-move, F/R/C hotkeys
- [x] T key toggles tactical overlay from arena
- [ ] **Live order indicators on squadmate sprites in-play** — visual arrows/icons showing active order
- [ ] **Tactical overlay updates in real-time** — currently a one-shot snapshot when opened

### Phase 3 — Gang Entity
- [ ] New `gangs` DB table (id, owner_player_id, name, primary_colour, secondary_colour, treasury, reputation)
- [ ] Migration: default gang per player, move `vehicles.player_id` → `vehicles.gang_id`, ditto `drivers`
- [ ] Gang API: `GET/PATCH /api/gangs/mine`
- [ ] Garage UI: gang name header + colour picker
- [ ] Squad vehicle sprite tinting uses gang primary colour
- [ ] All match rewards credit gang treasury (retire personal `players.money` in UI)

### Phase 4 — Persistent Rivals
- [ ] `rival_gangs` seed table (5–8 authored rivals: names, style, base skill, colours)
- [ ] `rival_gang_rep` table (player_gang_id, rival_id, rep, encounters, wins, losses)
- [ ] Rival selection at match start (by division + current rep)
- [ ] Match outcome updates rep; low rep = harder rematches
- [ ] Post-match UI shows rival name + contextual taunt/boast
- [ ] Optional: jobs targeted at specific rivals ("intercept The Wolves convoy")

### Phase 5 — Full Economy
- [ ] `gang_ledger` audit table
- [ ] Game-month tick (likely computed-on-login: process overdue cycles at login time)
- [ ] Per-match deductions: wages ($50 × driver skill), maintenance ($10 × squad size)
- [ ] Monthly deductions: garage fees ($100 × vehicle), insurance premiums ($50 per insured vehicle)
- [ ] Insurance payouts: 75% of rebuild cost on total loss if insured
- [ ] Bankruptcy / repossession: can't go negative; overdue fees repossess most expensive vehicles
- [ ] Garage UI: insurance toggle per vehicle + monthly statement

---

## 9. Never-planned (from original design doc)

From [`2026-03-27-carwars-design.md`](plans/2026-03-27-carwars-design.md). No plan written yet — would need design + plan pair before execution.

### Open World
- [ ] Highways as live combat zones with seamless transitions
- [ ] NPC traffic (civilians, haulers)
- [ ] Random encounters (ambushes, hitchhikers, roadside hazards)
- [ ] Gang territory on the map with persistent control

### Multiplayer
- [ ] Online PvP
- [ ] Local multiplayer (split screen? turn-based?)
- [ ] Gang vs gang events
- [ ] Spectator mode

---

## 10. Outstanding polish / loose ends

Small independent items that don't belong to a larger plan.

- [ ] **Driver permadeath** — `drivers.alive` column exists; nothing flips it to false on fatal damage. Probably wire from `damageState.driverWounded` + kill attribution.
- [ ] **Cycle / trike gameplay** — sprites + body types exist, collision half-extents are hard-coded to car dimensions, no real play-testing of 2/3-wheel handling
- [ ] **Repair UI visibility** — [REPAIR] click just takes money and refreshes; no breakdown of what's fixed or partial repair options
- [ ] **Ghost cars audit** — any vehicles built before the 2026-04-19 money-deduction fix were free; may want to reconcile historical `players.money` (minor; only affects accounts that built cars pre-fix)
- [ ] **Post-arena navigation** — consider showing last-fight summary on garage re-entry (currently just the `lastResult` money line)

---

## How to use this file

1. When starting new work, find the relevant section, flip `[ ]` to `[~]`
2. On completion + deploy, flip to `[x]` with a note if helpful
3. If descoping, `[-]` with a one-line reason inline
4. New items added at the bottom of their section; new plans go in `docs/plans/` and get linked from their section header
5. This file is always committed — treat it as a living document
