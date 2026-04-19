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
- [x] Map selection in UI — garage squad modal has a map picker (Truck Stop / Town Square / Open Arena); selection persists via localStorage
- [ ] **Dynamic/living map rendering** — current walls render as flat blue rectangles. Target: atmospheric dusk/stormy feel with per-building detail and motion. Specifically:
  - Walls colour-coded by `wall.type` (building = warm brown, turret = dark grey + pulsing red light, wall = weathered concrete)
  - Per-building detail tiles (roof, windows, door gap) — per body of building
  - Shop signage per fixture type (flickering neon "DINER", gas station pumps + canopy lights, gatehouse guard tower)
  - Ambient motion: smoke from chimneys, neon flicker, rotating beacon on turrets
  - Damage states: buildings track accumulated nearby hit count and visibly crack/scorch as they take collateral damage
  - Needs: sprite assets per building type (extend the placeholder generator), animation system for ambient effects, wall/building damage state tracking
- [-] **Seed-based procedural map generation** — subsumed by "Procedural World" (section 9) which is the richer version of this idea

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
- [x] Live order indicators on squadmate sprites in-play — green label floats above each squadmate showing current order (ATK/MOVE/FOLLOW/RETREAT)
- [ ] **Tactical overlay updates in real-time** — currently a one-shot snapshot when opened

### Phase 3 — Gang Entity
- [x] `gangs` DB table with name, primary/secondary colour, treasury, reputation
- [x] Migration: default gang per player created on register; existing players back-filled on startup; `vehicles.gang_id` + `drivers.gang_id` FKs added + populated
- [x] Gang API: `GET/PATCH /api/gangs/mine` (rename, recolour)
- [x] Garage UI: gang name header with colour swatch + treasury/reputation line; click name to open settings modal with swatch-based colour picker
- [x] Squad vehicle sprite tinting uses gang primary colour (primary = bright; mates = darker shade for contrast)
- [x] DB trigger syncs `players.money ↔ gangs.treasury` so all existing money endpoints (build, repair, sell, arena, salvage, job) automatically credit the gang — no per-endpoint changes needed. Source-of-truth migration to `gangs.treasury` deferred to a later phase.

### Phase 4 — Persistent Rivals
- [x] `rival_gangs` seed table — 5 authored rivals: Iron Wolves, Neon Samurai, Rust Raiders, Executioners, Highway Apostles (each with distinct colours + emblems + boast/defeat lines)
- [x] `player_rival_rep` table tracking grudge + encounters + player_wins + rival_wins per player-gang × rival
- [x] Rival selection at match start — weighted by `(10 + grudge*2 + encounters)` so existing rivalries are preferred but new rivals still appear
- [x] Grudge update on outcome: player win → +10 (rival angrier, harder rematch); rival win → -5 (satisfied); effective AI skill = `base_skill + floor(grudge/20)` capped at 6
- [x] Enemy sprites tinted in rival's primary colour (replacing the fixed red)
- [x] Post-match UI shows "vs. {Rival Name}" in the rival's colour + a random quote from boast_lines (rival won) or defeat_lines (player won)
- [ ] Jobs targeted at specific rivals ("intercept The Wolves convoy") — deferred
- [ ] Vehicle templates per rival (signature loadouts that scale with grudge) — deferred; enemies currently use makeTestVehicle with rival skill scaling only
- [ ] Rival emblem shown in-arena (HUD tag + on enemy sprites) — deferred to Phase 4b

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

### Open World — procedural world of cities linked by roads

The world is a graph: **cities as nodes, roads as edges**, all generated
from a root seed. Each city is itself a procedurally-composed zone built
from the snippet library; each road stretch between cities is another
zone. The player / gang travels between cities via the road zones,
encountering traffic, ambushes, and hazards en route.

**World graph (new)**
- [ ] World-level seed → deterministic graph: N cities placed on a 2D
  world map with road edges connecting them (minimum-spanning-tree plus
  a few redundant loops for route choice)
- [ ] Each city has its own city-seed (derived from world-seed + city
  index) so a city is reproducible across sessions
- [ ] Each road edge has its own road-seed for encounter/decor variation

**City generation (builds on the snippet composer)**
- [ ] Greatly expanded snippet library (urban blocks, industrial yards,
  residential zones, commercial strips, fortified compounds, arena
  venues — each with multiple variants)
- [ ] City generator places districts from the library based on city
  theme (industrial / commercial / residential / mixed), hooks roads
  into the district graph, and designates an arena venue
- [ ] Town features remain composable: garage, job board, bar (future)

**Road stretches (new zone type)**
- [ ] Highway/rural-road snippets with dashed centre lines, shoulders,
  guard rails, occasional billboards / abandoned wrecks / crossroads
- [ ] Road generator strings snippets along the edge between two cities
  based on distance + theme (arid / forest / wasteland)
- [ ] NPC traffic populated with procedural loadouts scaling to road
  danger level

**Travel + encounters**
- [ ] World map UI: click a destination city → game chooses the route
  (if multiple options) or lets the player pick
- [ ] Road zone loads, player drives through; random encounters trigger
  along the stretch (ambushes, hitchhikers, police patrols)
- [ ] Seamless transition from road zone into the arriving city
- [ ] Gang territory: which rival gang controls which cities/roads;
  entering hostile territory escalates encounter chance

**Dependencies:** Gang Phase 3 (gangs), Phase 4 (rivals), the
dynamic/living map rendering (section 4), and a much larger snippet
library. This is the biggest body of work on the roadmap — probably 5+
sittings even after the precursors land.

### Multiplayer
- [ ] Online PvP
- [ ] Local multiplayer (split screen? turn-based?)
- [ ] Gang vs gang events
- [ ] Spectator mode

---

## 10. UI Redesign

No plan doc yet — needs a design + plan pair before execution. Current UI
is monospace-on-black with minimal styling, functional but utilitarian. A
coherent visual overhaul would elevate the whole feel.

**Visual direction: not yet decided** — needs a choice between gritty
post-apoc, neon cyberpunk, 80s VHS pulp, retro-terminal, or something
else before detailed planning can begin.

### Scope candidates (not yet scoped — pick before planning)

- [ ] **Visual theme** — post-apocalyptic / gritty cyberpunk styling across
  all scenes (garage, town, job board, designer, arena HUD). Colour palette,
  typography, iconography, panel/border treatments
- [ ] **Garage redesign** — card-based vehicle list with thumbnails (use the
  sprite factory to render a miniature of each car), stat bars (HP/armor/value),
  clearer action grouping (repair/fight/sell), action button icons
- [ ] **Job board redesign** — job cards with flavour art, difficulty/payout
  visualisation, rival-gang emblems (once Phase 4 lands)
- [ ] **Vehicle designer redesign** — live preview sprite that updates as you
  tweak the loadout; cost breakdown panel; armor allocation visualiser
- [ ] **HUD polish** — icon-based weapon selector, animated armor bars, damage
  particles, better minimap
- [ ] **Post-arena screen** — cinematic outcome reveal with squad portraits,
  per-driver XP bars, rival aftermath text (ties into Phase 4)
- [ ] **Menus and transitions** — scene fade/slide transitions instead of hard
  cuts; a main menu / pause menu overlay

Recommended phased approach if pursued:
  1. Define the visual language (colour, type, icons) as a style guide
  2. Apply it to one scene end-to-end (garage is highest impact) as a proof
  3. Roll out to remaining scenes one at a time
  4. Add motion + polish passes last

---

## 11. Outstanding polish / loose ends

Small independent items that don't belong to a larger plan.

- [x] Driver permadeath — when a squad vehicle is destroyed, the assigned driver rolls for death. Fire/explosion = always die; other causes = 40% death chance. Dead drivers cleared from `assigned_vehicle_id`, logged as `driver_killed` event.
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
