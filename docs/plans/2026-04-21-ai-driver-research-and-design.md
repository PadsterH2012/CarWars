# AI Drivers — Research & Implementation Design

**Date:** 2026-04-21
**Status:** Research + design; no code changes yet. Companion plan doc with
phased tasks will follow if/when we agree the direction.
**Scope:** Replace the current reactive single-vehicle AI with a layered
system that (a) navigates terrain safely, (b) avoids obstacles correctly,
(c) coordinates inter-squad tactics, and (d) stays cheap enough to run 8
vehicles at 10 Hz without profiling trouble.

---

## 1. Where we are today

`server/src/ai/driver.ts` (≈700 lines) is a per-vehicle reactive AI with:

| Layer | What it does | What fails |
|---|---|---|
| Tactic picker | 5 tactics (aggressive / flanking / evasive / snipe / orbit), switched on health + skill + distance + weapon | Tactics are author-coded; no way to score "this tactic beats that one given squad state" |
| Stuck recovery | 4 phases from sidestep → reverse → compass sweep → PANIC (commit `f361571`) | Works, but is a bespoke FSM layered *inside* the tactic switch |
| Survival overlay | Blends strong-face-toward-enemy when armour low | Additive on top of tactic; no principled arbitration |
| Proximity avoidance | 5-unit squad-bubble + blast-hazard avoidance | Squad cohesion is implicit (don't-collide) only — no positive "support my ally" signal |
| Wall avoidance | Single forward probe stepping 0.5 units up to `lookDist`, turn 60–90° away | **Only catches head-on walls.** Concave corners, parallel-wall corridors, side-scrape cases all fail |
| Commander orders | attack/move/follow/retreat/clear per vehicle; short-circuits the tactic engine for pure movement orders | Orders are disconnected from squad state — "attack A" orders stack so all 4 focus-fire A |
| Shared squad state | **None.** Each AI computes independently; coordination is emergent from shared target selection and spacing | No flanking, no target triage, no crossfire, no formation |
| Pathfinding | **None.** Straight-line seek with local wall avoidance | Can't route around buildings, gets pinned in concave geometry |
| Wreckage awareness | `driver.ts` receives `allVehicles` but **not** `wreckage` | Wreckage is a collision obstacle the AI can't see — it ignites adjacent cars (section 7 of roadmap) |

The pieces that work — turn-rate clipping, hysteresis, personality jitter,
tick-locked decisions, phase-offset stuck recovery — are all worth
preserving. The architecture needs to be refactored around them, not
replaced.

---

## 2. Research findings — summary

Four research threads gathered sourced material; the full reports sit in
session context. The load-bearing conclusions:

### 2.1 Steering & local obstacle avoidance

**Adopt context steering** (Andrew Fray, popularised by a AAA racing title
and published as Game AI Pro 2 ch. 18,
[PDF](https://www.gameaipro.com/GameAIPro2/GameAIPro2_Chapter18_Context_Steering_Behavior-Driven_Steering_at_the_Macro_Scale.pdf),
[Fray blog](https://andrewfray.wordpress.com/2013/03/26/context-behaviours-know-how-to-share/)).
Every steering decision — "I want to chase," "there's a wall left," "an
ally is here," "wreckage is cooking off" — writes a scalar into one of
two per-agent N-slot rings around heading: an **interest** map and a
**danger** map. Selection picks the lowest-danger slot, tiebreak by
highest interest, tiebreak again by closest-to-current-heading
(hysteresis). Merging is `max`, not `sum`, so behaviours compose without
tuning weights.

Why this matters for carwars specifically:

- The three bugs in the current wall-avoidance (concave corners, parallel
  walls, sideways-scrape) are exactly the failure modes context steering
  was designed to fix ([Reynolds — Steering Behaviors](https://www.red3d.com/cwr/steer/),
  [Rory Driscoll — AI Steering](https://www.rorydriscoll.com/2016/10/14/ai-steering/)).
- Cost for 8 agents × 16 slots × ~6 behaviours ≈ 768 writes/tick.
  Trivial.
- Plays well with turn-rate caps: you clip the selected heading *after*
  selection, so the car can't pick a slot it physically can't reach this
  tick.
- Reject ORCA/RVO for inter-vehicle avoidance ([ORCA paper](https://gamma.cs.unc.edu/ORCA/publications/ORCA.pdf),
  [Game AI Pro 3 ch.19](http://www.gameaipro.com/GameAIPro3/GameAIPro3_Chapter19_RVO_and_ORCA_How_They_Really_Work.pdf))
  — it's a 2D LP solver for 8 agents, overkill. Symmetric danger writes
  in context steering give reciprocal avoidance for free.
- Reject pure Reynolds force-blending (what the current overlays are) —
  the local-minimum failure is exactly what we're seeing.

### 2.2 Pathfinding & terrain navigation

At 120×75 world units (9 000 cells) the arena is **tiny** by pathfinding
standards. Heap-backed A* resolves in under a millisecond per query
([javascript-astar](https://github.com/bgrins/javascript-astar),
[PathFinding.js](https://github.com/qiao/PathFinding.js/)). We don't need
navmesh, HPA\*, D\* Lite, or Theta\* yet.

Minimum viable path system for carwars:

1. **Heap A\* over a 1-unit grid** derived from `ArenaMap.walls` at
   zone-spawn time.
2. **LOS-smoothing** ([Simple Stupid Funnel — Mononen](http://digestingduck.blogspot.com/2010/03/simple-stupid-funnel-algorithm.html))
   on the A* output — walk the waypoint list deleting node *i* when
   `i-1 → i+1` is clear. Collapses the 45° staircase into long segments
   suitable for a turn-rate-capped vehicle.
3. **Soft cost multipliers for wreckage** — inflate cell cost under each
   wreck by ~5× rather than hard-blocking. Most stored paths stay valid
   when a wreck appears nearby.
4. **Replan-cooldown timer** — don't re-A* more than every ~15 ticks
   (1.5 s) unless the existing stuck detector fires.

For the **open-world phase** (roadmap section 9), the right answer is
per-snippet precomputed visibility graphs stitched together at arena
composition — because snippets are fixed-shape assets authored offline,
waypoints can ship with the asset. A* over that stitched graph is nearly
free. [Red Blob on visibility graphs](https://www.redblobgames.com/pathfinding/visibility-graphs/)
is the reference. NavMesh/Recast ([recast-navigation](https://www.npmjs.com/package/recast-navigation))
becomes worth considering if/when city zones grow to six-figure cell
counts.

### 2.3 Squad coordination

Keep the per-vehicle tactic engine. Add four cheap layers
([Building a Better Battle — Halo 3, Isla GDC'08](https://web.cs.wpi.edu/~rich/courses/imgd4000-d09/lectures/halo3.pdf),
[F.E.A.R. GOAP postmortem](https://www.gamedeveloper.com/design/building-the-ai-of-f-e-a-r-with-goal-oriented-action-planning),
[Modular Tactical Influence Maps — Dave Mark](https://www.gameaipro.com/GameAIPro2/GameAIPro2_Chapter30_Modular_Tactical_Influence_Maps.pdf)):

1. **Shared `SquadContext` blackboard** (per side, per arena) holding:
   target claims, rally point, orders, role assignments.
2. **Three low-frequency influence maps** (1 cell per world unit, 5 Hz
   rebuild):
   - `threatMap` — enemy weapons stamped across their arcs
   - `allyMap`   — own vehicles stamped with their support radius
   - `coverMap`  — static, stamped from walls/wreckage that blocks LoS
3. **Utility scoring** for tactic/role selection
   ([Dave Mark IAUS](https://www.gameai.com/iaus.php)), with considerations
   that *read squad state* — e.g. `flankCovered = allyMap.sample(pinCell) > 0`,
   `targetClaimed = committedDps[T] >= T.hp * 1.3 ? 0.2 : 1.0`. Per-agent
   decisions become squad-coherent without a squad-brain.
4. **Role auction every ~2 seconds** over 5 roles: **Anchor**
   (holds LoS, pins target), **Flanker-L / Flanker-R** (wants cell 90°
   off Anchor's fire-line per influence map), **Support** (sits near
   rally / low threat), **Scout** (goes to lowest-info cell). Greedy
   cost-minimising assignment. Role sets a waypoint/posture goal; the
   tactic engine still chooses *how* to reach it.

This gets us flanking, target-triage, mutual support, rally/retreat, and
commander-order responsiveness in ≈400 LOC with no HTN/GOAP rewrite.
Explicitly defer: full formation slots, bounding-overwatch sequencing,
HTN squad planner — disproportionate effort for a 4-vehicle squad.

### 2.4 Game case-study patterns worth stealing

High-value mechanical patterns, with provenance:

| Pattern | Source | Carwars fit |
|---|---|---|
| **(Personality) × (objective)** two-layer AI | [Car Wars 6E Companion](https://carwars.sjgames.com/products/expansions/car-wars-companion/) (actual tabletop rules), Carmageddon "moods", GTA FSM | Formalises the existing `personality` float — promote to archetype enum |
| **Visible economic cheats, not speed cheats** | Death Rally ([TVTropes](https://tvtropes.org/pmwiki/pmwiki.php/VideoGame/DeathRally)) | AI spawns fully repaired/ammo'd (already true). Don't ever rubber-band speed |
| **One driver AI, many goals** | GTA 1/2 cop = car + pursue flag ([GTAForums RE](https://gtaforums.com/topic/415671-gta-2-source-code/)) | We already do this via commander orders — extend to role-driven goals |
| **Panic override pre-emption** | GTA peds, F.E.A.R., Halo | Already have PANIC at stuck ≥ 100 ticks — make panic a first-class pre-emption layer, not a stuck-level |
| **Pre-authored node graph per arena** | Carmageddon OPATH ([wiki](https://carmageddon.fandom.com/wiki/Opponent)) | Per-snippet waypoints fit directly into Phase B of pathfinding |
| **Physics-honest AI** | I'76 ([Designer's Notebook](https://www.gamedeveloper.com/design/designer-s-notebook-i-interstate-76-i-and-the-principles-of-harmony)) | We're already honest — keep it that way |
| **AI-on-AI targeting (not 100% player)** | Rock 'n' Roll Racing; **anti**-lesson from Twisted Metal | Current `pickTarget` weights weakest-first regardless of playerId — good. But when multiple AI are on one team, they should occasionally peel off to fight the *other* AI team independent of the player |
| **Named rivals with persistent mood** | Road Rash Natasha | Already exists via `rival_gangs` and `grudge` (roadmap §8.4) — extend: per-match bot names + 2-3 remembered insults |
| **Mission state table separate from driver** | I'76 | Commander orders are this in embryo — formalise as an Objective enum |
| **Arena-scripted events as AI stimuli** | Vigilante 8 | New: "interesting event nearby" bus — explosions, turret fire, ammo cook-offs become AI triggers |
| **Rubber-banding capped by steering competence** | Micro Machines **bug** | If we ever add AI-catches-up mechanics, cap by handling class — don't gift speed an AI can't steer with |

---

## 3. Target architecture

Four concentric layers, outer layers compose over inner ones:

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 4 — SQUAD BRAIN (per side, per arena)                 │
│   SquadContext blackboard, 3 influence maps, role auction   │
│   Publishes: roleByAgent, targetClaims, rally, orders       │
└──────────────────────┬──────────────────────────────────────┘
                       │ writes into
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 3 — UTILITY SCORING (per vehicle, per tick)           │
│   Considerations × curves × squad-state → tactic + goal     │
│   Replaces current chooseTactic() switch                    │
└──────────────────────┬──────────────────────────────────────┘
                       │ picks tactic + goal point
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 2 — CONTEXT STEERING (per vehicle, per tick)          │
│   16-slot interest + danger rings                           │
│   Writers: tactic goal, wall probes (fan of 5),             │
│     vehicle proximity, wreckage AABBs, blast hazards,       │
│     flow-field vector (if active), stuck back-out           │
│   Picks: lowest-danger slot; highest-interest tiebreak;     │
│     closest-to-heading second tiebreak                      │
└──────────────────────┬──────────────────────────────────────┘
                       │ emits desired heading + speed
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 1 — KINEMATIC OUTPUT (per vehicle, per tick)          │
│   Clip heading delta to max turn rate                       │
│   Clip speed to max/min; apply skill multiplier             │
│   Resolve fire decision (cooldown, arc, range)              │
│   Returns AiInput { speed, steer, fireWeapon }              │
└─────────────────────────────────────────────────────────────┘
```

Path planning (when needed) sits as a **sibling service** to Layer 3: the
utility layer can request "give me a path to (x,y)" and write the first
waypoint's bearing into Layer 2 as a high-interest write. The pathfinder
doesn't own the steering decision — it just supplies a goal.

---

## 4. Core data structures

### 4.1 SquadContext (new; lives in zone-runner)

```ts
// server/src/ai/squad.ts (new)
export interface SquadContext {
  playerId: string;                        // which side
  members: string[];                       // vehicle ids (living)
  roleByAgent: Map<string, SquadRole>;     // Anchor | FlankerL | FlankerR | Support | Scout
  targetClaims: Map<string, ClaimInfo>;    // enemy id → { dps, lastTick, claimants[] }
  rally: { x: number; y: number };         // computed per rebuild: highest ally-influence, lowest threat
  lastAuctionTick: number;
  orders: Map<string, SquadOrder>;         // same shape as existing; moved here
}

export type SquadRole = 'anchor' | 'flanker_l' | 'flanker_r' | 'support' | 'scout';

export interface ClaimInfo {
  committedDps: number;                    // sum of claimants' DPS vs this target
  claimants: string[];                     // vehicle ids attacking this target
  lastTick: number;                        // for decay
}
```

### 4.2 InfluenceMaps (new)

```ts
// server/src/ai/influence.ts (new)
export class InfluenceMaps {
  readonly threat: Float32Array;  // width × height, updated 5 Hz
  readonly ally:   Float32Array;
  readonly cover:  Float32Array;  // static, computed once per arena

  constructor(private map: ArenaMap) { /* allocate grids */ }
  rebuildDynamic(vehicles: VehicleState[], wreckage: WreckageObject[]): void;
  sample(grid: 'threat' | 'ally' | 'cover', x: number, y: number): number;
}
```

Cell size = 1 world unit (`ArenaMap.width × height`). Truck-stop is
120×75 = 9 000 cells × 3 maps × 4 bytes = 108 KB per arena. Rebuild
cost: Gaussian stamp ~200 cells per source × 16 sources × 2 maps ≈ 6 400
writes per rebuild; &lt; 1 ms.

### 4.3 ContextRing (new; per vehicle)

```ts
// server/src/ai/context-ring.ts (new)
const SLOT_COUNT = 16;                     // 22.5° per slot
export class ContextRing {
  readonly interest = new Float32Array(SLOT_COUNT);
  readonly danger   = new Float32Array(SLOT_COUNT);

  reset(): void;
  writeInterest(bearing: number, strength: number, falloffSlots = 1): void;
  writeDanger(bearing: number, strength: number, falloffSlots = 1): void;
  pick(currentFacing: number): { bearing: number; danger: number };
}
```

Slot-to-bearing: `slot * 22.5°`. Falloff writes `strength` to the target
slot and `strength * 0.5` to the two neighbours (tunable).

### 4.4 Pathfinder (new)

```ts
// server/src/ai/pathfinder.ts (new)
export class Pathfinder {
  constructor(map: ArenaMap);
  // Rebuild obstacle grid when wreckage changes (debounced to 2 Hz)
  updateObstacles(wreckage: WreckageObject[]): void;
  // Heap A* with diagonal moves; returns unit-aligned waypoint list or null
  find(from: Position, to: Position): Position[] | null;
  // LOS-smoothing pass — delete waypoint i when i-1 to i+1 is clear of walls/wreckage
  smooth(path: Position[]): Position[];
  // Flow-field flood from a goal point — returns cached Float32Array of bearings per cell
  flood(goal: Position): Float32Array;
}
```

Path cache keyed by `(fromCell, toCell)` with a ~1 s TTL; shared across
all agents in the same squad so a `move` commander order floods once.

---

## 5. How the pieces integrate with existing code

### 5.1 `computeAiInput` signature change

```ts
// Before
export function computeAiInput(
  self: VehicleState, others: VehicleState[], skill: number,
  map?: ArenaMap, order?: SquadOrder, allVehicles?: VehicleState[],
): AiInput;

// After
export function computeAiInput(
  self: VehicleState,
  ctx: AiContext,                         // new — bundled per-tick inputs
): AiInput;

export interface AiContext {
  skill: number;
  map: ArenaMap;
  allVehicles: VehicleState[];            // was optional
  wreckage: WreckageObject[];             // NEW — closes the integration gap
  squadContext: SquadContext;             // NEW — shared brain state
  influenceMaps: InfluenceMaps;           // NEW — read-only per-tick snapshot
  pathfinder: Pathfinder;                 // NEW — pathfinding service
  tick: number;
}
```

Changes required in `server/src/world/zone-runner.ts`:

- Construct one `SquadContext` per distinct `playerId` at arena start.
- Construct one `InfluenceMaps` and one `Pathfinder` per arena.
- Rebuild influence-maps every 2 ticks (5 Hz).
- Run role auction every 20 ticks (0.5 Hz = 2 s).
- Pass `state.wreckage ?? []` alongside `state.vehicles`.

Existing tests (`server/tests/ai.test.ts`) will need a small helper to
construct an `AiContext` from the mock vehicles. None of the test
expectations change (accelerate-when-far, steer-clamped, fire-in-range,
no-friendly-fire, zero-when-no-enemies).

### 5.2 Tactic picker → utility scoring

The current `chooseTactic` is a hand-ordered switch. Rewrite as:

```ts
// Each tactic is scored with considerations, picked by highest score.
// Considerations are response curves over normalised inputs 0..1.
const tacticScores = {
  aggressive: product(
    curves.linear(armorFrac),                       // healthy → high
    curves.inv(distNorm),                           // close → higher
    curves.step(targetClaimedDps, 0.8, 1.0, 0.3),   // don't pile on
    curves.linear(skillNorm),
  ),
  flanking: product(
    curves.linear(armorFrac),
    curves.linear(skillNorm, 0.5, 1.0),             // needs skill
    curves.step(myRole === 'flanker_l' || 'flanker_r', 0, 1, 1.2), // role bonus
    curves.inv(flankCellThreat),                    // flank cell must be safe
  ),
  // ... etc
};
```

This is the squad-coherence mechanism — *every* tactic's score reads
from `SquadContext` and `InfluenceMaps`, so a lone wolf will score
differently than a squadmate whose flank is covered.

### 5.3 Stuck recovery survives

The existing 4-phase stuck-recovery (sidestep → reverse → compass →
PANIC) is correct and battle-tested — keep it, but express its output
as **writes into the context ring** rather than direct `desiredFacing =
...` assignments. That way the wall-avoidance overlay can still override
it at the final moment if a newly-revealed wall is in the escape path,
without the recovery logic needing to know about walls.

### 5.4 Personality → archetype

Today `personality: number` (0..1) shifts orbit angle and range. Promote
to an enum from the 6E Companion pattern:

```ts
type Archetype = 'aggro' | 'cautious' | 'sniper' | 'runner' | 'wild_card';
```

Each archetype is a **consideration-curve bias table**: aggro multiplies
`aggressive` and `flanking` scores, sniper multiplies `snipe`, cautious
multiplies `evasive` and `orbit`, etc. The continuous `personality`
float survives as a small per-vehicle jitter on top of the archetype
bias — keeps the "no two vehicles the same" feel.

---

## 6. Phased implementation plan

Small, testable phases, each independently shippable. **Do not merge the
whole thing in one go** — each phase needs playtesting because AI "feel"
is the hard-to-regression-test part.

### Phase 1 — Refactor for layering (no behavioural change)
- [ ] Introduce `AiContext` bundle; update `computeAiInput` signature
- [ ] Move `DriverState` map into a clearer per-vehicle struct inside the AI module
- [ ] Pass `wreckage` through zone-runner → driver (closes existing integration gap)
- [ ] Add wreckage AABBs to the existing wall-avoidance probe
- [ ] Existing tests pass unchanged

**Ship criterion:** AI plays identically to today, but the AiContext
scaffold is in place.

### Phase 2 — Context steering (replace wall avoidance + proximity bubble)
- [ ] `ContextRing` class + unit tests (bearing→slot maths is the bit that bites)
- [ ] Replace single forward probe with a 5-ray fan writing into `danger`
- [ ] Tactic's `desiredFacing` becomes an interest write, not a direct assignment
- [ ] Proximity-bubble becomes danger writes (friendlies near) + strong danger writes (low-hp anyone)
- [ ] Keep the final kinematic-output clip on heading delta — that's Layer 1, unchanged

**Ship criterion:** pile-up scenarios resolve faster; AI no longer gets
pinned in concave corners (author one failing scenario per current bug
class and make them pass).

### Phase 3 — Pathfinder + wreckage awareness
- [ ] Heap A* on 1-unit grid from `ArenaMap.walls`; bench sub-ms per query
- [ ] LOS-smoothing pass on A* output
- [ ] Wreckage contributes soft cost multiplier, not hard block
- [ ] Replan-cooldown timer (15 ticks) + force-replan when stuck detector fires
- [ ] `move` commander orders build a flow field, not a per-agent A*
- [ ] Wire path first-waypoint bearing into context ring as high-interest write

**Ship criterion:** AI can now reach enemies hiding behind buildings in
town-square; `move` orders for a 4-vehicle squad run the pathfinder
once, not 4×.

### Phase 4 — Squad brain (blackboard + influence maps + auction)
- [ ] `SquadContext` allocated in zone-runner per playerId at arena start
- [ ] Three `InfluenceMaps`, 5 Hz rebuild
- [ ] Target-claim tracking (decrement on LoS loss or target-switch)
- [ ] 5-role auction every 2 s; role assignment publishes waypoint goals
- [ ] Tactic scoring switches to utility + considerations reading squad state
- [ ] Commander orders (`squad_order`) become overrides on role assignment, not direct tactic pins

**Ship criterion:** squadmates visibly split targets, flank from opposite
sides, and retreat together rather than one-at-a-time. Test by running
2v2 and 4v4 in truck-stop.

### Phase 5 — Personality archetypes
- [ ] `Archetype` enum, curve bias tables per archetype
- [ ] Each AI vehicle picks an archetype at spawn (driver-level or rival-gang-level)
- [ ] Existing `personality` float becomes per-vehicle jitter on top
- [ ] Rival gangs express signature archetypes (Iron Wolves = aggro, Neon Samurai = sniper etc.)

**Ship criterion:** archetype-tagged rivals *feel* different in a
blinded playtest — you can tell Iron Wolves from Neon Samurai before
seeing the colour.

### Phase 6 — Objective/mission layer (prep for open world)
- [ ] Formal `SquadObjective` enum separate from per-vehicle tactics
- [ ] Objectives: engage, defend_zone, escort, flee_to_exit, patrol_route
- [ ] Each objective adjusts the role auction + utility biases
- [ ] Commander orders become objective-setters
- [ ] Groundwork for open-world job/mission variety

### Deferred — open world prep (not for v1)
- Per-snippet precomputed waypoint graph
- Stitched inter-snippet pathfinding
- Chunked flow fields for city-zone squad moves
- Recast/Detour via `recast-navigation` (only if grid cell counts hit 100k+)

---

## 7. Risk & testing

### What can go wrong

| Risk | Mitigation |
|---|---|
| AI "feels dumber" after refactor | Every phase ships on its own; rollback target is the previous phase, not the whole stack |
| Influence-map rebuild cost balloons with arena size | Cell size is tunable (drop to 2-unit cells → 4× speedup) and rebuild frequency (3 Hz instead of 5 Hz) |
| Auction churn makes squadmates "hot-swap" roles constantly | Role stickiness bonus: current role gets +15% bid advantage until replaced |
| Pathfinder cache invalidation on wreckage spawn | Cache keys include wreckage-count hash; auto-invalidates on mismatch |
| Context-ring slot aliasing (16 slots = 22.5°, weapon arcs are 90°) | Writes have ±1 slot falloff; for arc-critical decisions, also compute continuous bearing and use slot for *danger filtering* only |

### Tests worth writing

- **Concave-corner probe test** — author a test map with a 90° inner
  corner; assert AI doesn't pin. (Will fail today, pass after Phase 2.)
- **Parallel-wall corridor** — author a 3-unit-wide corridor; assert AI
  traverses without oscillation.
- **Target-saturation test** — 4 AI vs 1 low-hp player; assert ≤ 2 AI
  commit to the player (others disengage).
- **Flank coverage test** — 2 AI vs 1 enemy in open; assert the two AI
  bearings-to-enemy differ by >60°.
- **Wreckage avoidance** — put a wreck in front of a spawn point; assert
  AI routes around it.
- **Path-smoothing** — author a staircase-optimal A* path; assert the
  smoothed path has fewer waypoints and equal or shorter length.

Existing AI tests stay unchanged — the refactor preserves the public
`computeAiInput` behavioural contract.

---

## 8. Open questions (resolve before Phase 4)

1. **Squad-brain lifecycle.** One `SquadContext` per playerId per zone —
   but what about pause/resume, vehicle mid-match promotion, squadmates
   joining late? (Probably: rebuild-on-demand when member list
   changes.)
2. **How much authoring work is "pre-authored waypoints per snippet"?**
   We have 9 snippets today (`road_straight_20`, `road_bend_ws`,
   `road_t`, `road_cross`, `corner_turret`, `gatehouse`,
   `wall_straight_20`, `diner`, `gas_station`). ~4 waypoints per snippet
   = 36 nodes to author. That's an afternoon of work, much cheaper than
   A* for the open world.
3. **Do we want AI-vs-AI fights?** Arenas are always player-vs-AI today.
   If we ever introduce three-way arenas (rival gang vs. player AND vs.
   another AI faction), the squad brain needs multi-enemy target
   scoring, which is a decent complication. Deferrable.
4. **Archetype authoring — per driver or per gang?** Current data model
   has drivers with skill levels but no archetype field. Gang-level
   archetype is simpler but less varied. Needs a schema decision in
   Phase 5.

---

## 9. Related work in this repo

- [`docs/ROADMAP.md`](../ROADMAP.md) §1 "AI driver (basic)" checkbox —
  this design is the Phase 2 version.
- [`docs/plans/2026-04-19-gang-management-plan.md`](2026-04-19-gang-management-plan.md)
  — Phase 2 Commander Mode landed; this design formalises how squad
  orders interact with the new squad brain.
- [`docs/plans/2026-03-28-compendium-rules-plan.md`](2026-03-28-compendium-rules-plan.md)
  — the Compendium movement/collision rules the AI has to obey; this
  design doesn't change them.

---

## 10. Next step

This is research-and-design only. **No code changes yet.** If the
direction is agreed, the follow-up is a companion plan doc
(`2026-04-21-ai-driver-rewrite-plan.md`) with the Phase 1–5 tasks broken
down into checklists with file-level detail, shipped one phase at a time
with playtesting between each.

---

## Sources

Full citation list (deduped across all four research threads):

**Steering & local avoidance**
- [Reynolds — Steering Behaviors For Autonomous Characters](https://www.red3d.com/cwr/steer/)
- [Shiffman — Nature of Code ch. 5](https://natureofcode.com/autonomous-agents/)
- [Andrew Fray — Context Behaviours Know How To Share](https://andrewfray.wordpress.com/2013/03/26/context-behaviours-know-how-to-share/)
- [Fray, Game AI Pro 2 ch. 18 — Context Steering (PDF)](https://www.gameaipro.com/GameAIPro2/GameAIPro2_Chapter18_Context_Steering_Behavior-Driven_Steering_at_the_Macro_Scale.pdf)
- [Rory Driscoll — AI Steering](https://www.rorydriscoll.com/2016/10/14/ai-steering/)
- [van den Berg et al. — ORCA paper (PDF)](https://gamma.cs.unc.edu/ORCA/publications/ORCA.pdf)
- [Sunshine-Hill, Game AI Pro 3 ch.19 — RVO & ORCA (PDF)](http://www.gameaipro.com/GameAIPro3/GameAIPro3_Chapter19_RVO_and_ORCA_How_They_Really_Work.pdf)
- [Mononen — Improving Local Avoidance](http://digestingduck.blogspot.com/2009/12/improving-local-avoidance.html)
- [Dubins path — Wikipedia](https://en.wikipedia.org/wiki/Dubins_path)

**Pathfinding**
- [Heap-based A* — javascript-astar](https://github.com/bgrins/javascript-astar)
- [PathFinding.js](https://github.com/qiao/PathFinding.js/)
- [easystar.js](https://easystarjs.com/)
- [Jump Point Search — Wikipedia](https://en.wikipedia.org/wiki/Jump_point_search)
- [recast-navigation npm](https://www.npmjs.com/package/recast-navigation)
- [Red Blob — Tower Defense & Pathfinding (flow fields)](https://www.redblobgames.com/pathfinding/tower-defense/)
- [Red Blob — Visibility Graphs](https://www.redblobgames.com/pathfinding/visibility-graphs/)
- [Mononen — Simple Stupid Funnel Algorithm](http://digestingduck.blogspot.com/2010/03/simple-stupid-funnel-algorithm.html)
- [Nash & Koenig — Theta* (arXiv)](https://arxiv.org/pdf/1401.3843)
- [Koenig — D* Lite AAAI'02 (PDF)](http://idm-lab.org/bib/abstracts/papers/aaai02b.pdf)

**Squad coordination**
- [Isla — Building a Better Battle (Halo 3 AI Objectives, GDC'08 PDF)](https://web.cs.wpi.edu/~rich/courses/imgd4000-d09/lectures/halo3.pdf)
- [Orkin — Building the AI of F.E.A.R. with GOAP](https://www.gamedeveloper.com/design/building-the-ai-of-f-e-a-r-with-goal-oriented-action-planning)
- [Booth — The AI Systems of Left 4 Dead (PDF)](https://steamcdn-a.akamaihd.net/apps/valve/2009/ai_systems_of_l4d_mike_booth.pdf)
- [Dave Mark — Modular Tactical Influence Maps (Game AI Pro 2 ch.30 PDF)](https://www.gameaipro.com/GameAIPro2/GameAIPro2_Chapter30_Modular_Tactical_Influence_Maps.pdf)
- [Dave Mark — Infinite Axis Utility System](https://www.gameai.com/iaus.php)
- [Hierarchical AI for Multiplayer Bots in Killzone 3 (Game AI Pro ch.29 PDF)](http://www.gameaipro.com/GameAIPro/GameAIPro_Chapter29_Hierarchical_AI_for_Multiplayer_Bots_in_Killzone_3.pdf)
- [Bounding overwatch — Wikipedia](https://en.wikipedia.org/wiki/Bounding_overwatch)

**Case studies**
- [Car Wars Companion (6E, SJG) — bot personalities](https://carwars.sjgames.com/products/expansions/car-wars-companion/)
- [Designer's Notebook — Interstate '76 (Vesce)](https://www.gamedeveloper.com/design/designer-s-notebook-i-interstate-76-i-and-the-principles-of-harmony)
- [Death Rally — TV Tropes](https://tvtropes.org/pmwiki/pmwiki.php/VideoGame/DeathRally)
- [Carmageddon — Opponent paths (wiki)](https://carmageddon.fandom.com/wiki/Opponent)
- [GTA 2 source / reverse-engineering (GTAForums)](https://gtaforums.com/topic/415671-gta-2-source-code/)
- [Rubber-Band AI — TV Tropes](https://tvtropes.org/pmwiki/pmwiki.php/Main/RubberBandAI)
- [Efficient Ground Vehicle Path Following in Game AI (arXiv 2307.03379)](https://arxiv.org/pdf/2307.03379)
- [oseiskar/js-car (reference JS car + PID)](https://github.com/oseiskar/js-car)
- [craigdallimore/steering-behaviour (TS Reynolds port)](https://github.com/craigdallimore/steering-behaviour)
