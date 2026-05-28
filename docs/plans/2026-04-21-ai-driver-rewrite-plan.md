# AI Driver Rewrite — Phases 2–4 Implementation Plan

**Date:** 2026-04-21
**Status:** Plan (no code changes yet)
**Design doc:** [2026-04-21-ai-driver-research-and-design.md](2026-04-21-ai-driver-research-and-design.md)
**Scope:** Three phases converting the current reactive AI into a layered
system with context steering, pathfinding, and a squad brain. Each phase
is one mergeable PR, shipped to `hl-carwars` and playtested before the
next starts.

---

## Prerequisite — Phase 1 (recap, assumed landed)

Before Phase 2 can start, Phase 1 must be merged. Phase 1 is refactor-only
and ships no behavioural change. Its deliverables are recapped here so the
plan below compiles against known state:

- `AiContext` bundle type in `server/src/ai/types.ts` (new) — carries
  `skill`, `map`, `allVehicles`, `wreckage`, `tick`
- `computeAiInput(self, ctx: AiContext): AiInput` — new signature;
  `others` derived from `ctx.allVehicles`
- Zone-runner passes `state.wreckage ?? []` into the context
- Existing `driverState` map refactored into a single `DriverState`
  interface file-local to `driver.ts`
- All 5 existing tests in [server/tests/ai.test.ts](../../server/tests/ai.test.ts)
  pass unchanged

**If Phase 1 hasn't shipped, stop and do it first.** Phase 2 adds fields
to `AiContext`; Phase 3 adds `pathfinder`; Phase 4 adds `squadContext`
and `influenceMaps`.

---

## Global invariants (apply to every phase)

These must hold true at the end of **every merged PR**. Breaking any of
them is a ship-stopper.

1. All 5 existing tests in `server/tests/ai.test.ts` pass — accelerate-when-far,
   steer-within-max, fire-in-range, no-friendly-fire, zero-input-when-no-enemies.
2. The turn-rate clip in `driver.ts` (current line 661–668: `skillMul`,
   `maxTurnThisTick`, proportional damping) is the **final step** before
   the `AiInput` is emitted. No new layer is allowed to skip it.
3. Fire decision logic (cooldown, angle threshold, range check, arc
   selection) stays in the kinematic output layer and is unchanged by
   Phases 2–4.
4. Commander orders (`attack` / `move` / `follow` / `retreat` / `clear`)
   continue to work end-to-end through the TacticalOverlay UI and the
   `squad_order` websocket message. Behavioural changes are allowed (and
   expected — see Phase 4), but the public protocol in
   [shared/src/types/messages.ts](../../shared/src/types/messages.ts)
   doesn't change.
5. No perceptible regression in 1v1 aggressive/flanking behaviour — these
   are the most-played scenarios and the AI's current strength. Each
   phase has a 1v1 sanity playtest in its checklist.
6. TypeScript strict mode stays clean. vitest suite green.

---

# Phase 2 — Context Steering

**One-line goal:** Replace the hand-tuned additive overlays (wall
avoidance, proximity bubble, survival) with Andrew Fray's
interest/danger ring so the AI looks *intentional* rather than twitchy.

**Expected effect:** concave corners no longer pin AI; parallel-wall
corridors traversed without oscillation; squadmate pileups resolve
faster; sideways-scrape-during-turn cases detected (currently invisible
to the forward-only probe).

## Files touched

**New:**
- `server/src/ai/context-ring.ts` — the ring class, pure, zero
  carwars imports
- `server/src/ai/writers.ts` — behaviour functions that write into
  the ring (wall probes, vehicle proximity, wreckage, blast hazards,
  tactic goal, survival bias)
- `server/tests/context-ring.test.ts` — ring unit tests
- `server/tests/ai-steering.test.ts` — scenario tests (concave
  corner, parallel corridor, side-scrape)

**Modified:**
- [server/src/ai/driver.ts](../../server/src/ai/driver.ts) — remove
  direct `desiredFacing = ...` assignments from tactic switch, survival,
  proximity, and wall-avoidance blocks. Each becomes a writer call.
  Final `steer` computation sources bearing from `ring.pick()`.
- `server/src/ai/types.ts` — extend `AiContext` with a per-vehicle
  `ring: ContextRing` (or construct inline; see T2.2)

**Deliberately NOT touched:**
- Stuck recovery (lines 351–411 in current `driver.ts`) — its output
  becomes a writer call but the 4-phase FSM logic is preserved
  verbatim
- Tactic picker `chooseTactic()` — Phase 2 leaves the tactic *choice*
  unchanged; only the *expression* of tactic goal changes (from
  `desiredFacing =` to `ring.writeInterest(...)`)
- Fire decision, turn-rate clip, stuck detection

## Tasks (in implementation order — each task = one commit)

### T2.1 — Write failing scenario tests (TDD)

Create `server/tests/ai-steering.test.ts` with three failing scenarios.
Each builds a minimal `ArenaMap` using the existing `Rect` type from
[shared/src/types/world.ts](../../shared/src/types/world.ts) and asserts
the AI behaviour.

```ts
// Skeletons — fill in assertions
it('does not pin in a concave corner', () => {
  // Map: two walls forming a 90° inner corner at (10, 0)
  // Vehicle starts at (15, -5) with enemy past the corner
  // Run 60 ticks; assert vehicle position moved > 8 units
});

it('traverses a 3-unit-wide corridor without oscillation', () => {
  // Map: two parallel walls 3 units apart, 20 units long
  // Vehicle starts at corridor entrance, enemy at exit
  // Run 40 ticks; assert |steer| average < 10° (no zig-zag)
});

it('avoids a wreck placed directly ahead', () => {
  // Empty map, wreckage at (0, -10), vehicle at (0, 0) facing north,
  // enemy at (0, -20)
  // Run 30 ticks; assert vehicle position.x sidesteps (|x| > 2) and
  // does not collide with wreck
});
```

These should **fail against current `main`** — that's the point. This
is the regression-proof for the whole phase.

### T2.2 — Build `ContextRing`

`server/src/ai/context-ring.ts`:

```ts
export const SLOT_COUNT = 16;                    // 22.5° per slot
export const SLOT_DEG = 360 / SLOT_COUNT;

export class ContextRing {
  readonly interest = new Float32Array(SLOT_COUNT);
  readonly danger   = new Float32Array(SLOT_COUNT);

  reset(): void;
  writeInterest(bearing: number, strength: number, falloff?: number): void;
  writeDanger(bearing: number, strength: number, falloff?: number): void;
  pick(currentFacing: number): { bearing: number; danger: number };
}
```

**Selection rule** (inside `pick`):
1. Find minimum danger value across all 16 slots.
2. Candidate set = slots within `0.15` of that minimum (tolerance for
   roughly-equal-danger situations).
3. Among candidates, pick highest interest.
4. Tiebreak: slot closest to `currentFacing`.
5. Return slot's centre bearing + its danger score (useful for logging).

**Writing rule** (inside `writeInterest` / `writeDanger`):
- `max`, not `sum` — this is the critical Fray insight
- Default falloff 1 slot either side at `0.5×` strength
- Bearing is compass degrees (0 = north, matches existing code)

Unit tests in `server/tests/context-ring.test.ts`:
- Writes to slot N boost slots N-1 and N+1 with falloff
- Max-not-sum: writing `0.5` then `0.8` to same slot leaves `0.8`
- `pick()` returns lowest-danger slot when interests are equal
- `pick()` returns highest-interest slot among equal-danger candidates
- `pick()` applies hysteresis: when two slots are tied on both axes,
  the one closer to `currentFacing` wins

### T2.3 — Build `writers.ts` (empty shells + wall writer first)

`server/src/ai/writers.ts` — one exported function per writer.
Implement only the wall writer in this task.

```ts
export function writeWallDanger(
  ring: ContextRing,
  pos: Position,
  facing: number,
  walls: Rect[],
  speed: number,
): void;
```

**Replace** the single probe at line 90–111 of current `driver.ts`
(`lookAhead`) with a **5-ray fan**: rays at `facing + {-60, -30, 0, +30, +60}`.
Each ray probes out to `max(5, min(12, speed / 8))` (current heuristic
preserved). On a hit, write `danger = 1 - (hitDist - 1) / maxDist` to
the slot matching that ray's bearing, with falloff.

Stubs for the other writers (return immediately); implemented in T2.5–T2.8.

### T2.4 — Wire `ContextRing` + wall writer through `computeAiInput`

Modify `driver.ts`:
- Allocate or reuse a `ContextRing` per vehicle (store on `DriverState`
  to avoid per-tick allocation — ring is mutated in place).
- At the top of the main path (after enemies check, before tactic
  block), call `ring.reset()` then `writeWallDanger(...)`.
- **Temporarily**, at the end, still use the existing `desiredFacing`
  variable — do NOT wire `ring.pick()` into steer yet. The wall writer
  is runnable but unused. This lets us commit and keep tests green.

### T2.5 — Vehicle proximity + blast-hazard writer

Port the logic currently at lines 543–630 of `driver.ts` into
`writeVehicleDanger(ring, self, allVehicles, ...)`. Same hysteresis,
same 5-unit friendly bubble, same low-hp blast hazard. Same symmetric
id-hash side-selection to prevent oscillation between two adjacent
vehicles.

**Commit point:** all existing tests still pass; the two writers exist
but do not yet influence steering.

### T2.6 — Wreckage writer (closes the current blind spot)

```ts
export function writeWreckageDanger(
  ring: ContextRing,
  pos: Position,
  wreckage: WreckageObject[],
): void;
```

For each wreck within 6 units, write `danger` at the bearing to the
wreck, scaled by:
- Proximity: `1 - dist / 6`
- State modifier: `burning` → 1.3×, `smouldering` → 1.0×, `debris` → 0.7×
- Low remaining DP → lower danger (AI *can* ram light wrecks if it has
  a ramplate; ramplate-aware logic lives in tactics, not here)

### T2.7 — Tactic goal as interest write

Rewrite the tactic switch (lines 418–500 of current `driver.ts`) so each
case writes into **interest** at the desired-facing bearing with
strength proportional to its priority, rather than assigning
`desiredFacing` directly.

Priorities (starting values — will need tuning):
- `aggressive` bearing → interest 0.9
- `flanking` → 0.85
- `snipe` → 0.85
- `orbit` → 0.8
- `evasive` → 1.0 (highest — survival)

Speed (`desiredSpeed`) stays as a direct variable — the ring is for
heading only.

### T2.8 — Survival, stuck recovery, commander-order writes

- Survival overlay (current lines 508–541) becomes an **interest write**
  at the "present strongest face" bearing with strength = `survivalUrgency`.
  Existing blend logic goes away (the ring's max-not-sum handles it).
- Stuck recovery (lines 351–411) becomes a **high-strength interest
  write** at its escape heading (strength 1.0 when stuck ≥ 4 ticks, so
  it outscores most other writers). Speed assignment stays direct —
  reverse burst still forces `-25`.
- Commander-mode `attack` orders — no change (tactic block already
  respects the pinned target). `move`/`retreat`/`follow` short-circuit
  paths unchanged in Phase 2; they become ring writes in Phase 3 when
  the pathfinder can supply better waypoints.

### T2.9 — Switch steer source to `ring.pick()`

The single change that activates the whole phase:

```ts
// Before (current driver.ts:663):
let steer = shortestTurn(self.facing, desiredFacing);

// After:
const { bearing: chosenBearing, danger: chosenDanger } = ring.pick(self.facing);
let steer = shortestTurn(self.facing, chosenBearing);
```

Keep the proportional damping (line 667–668) exactly as-is.

Add one debug log per tick: `[RING] <id> chose bearing=X° danger=Y`
so playtests can see the selected slot.

### T2.10 — Verification + tuning pass

- Previously failing tests from T2.1 should now pass
- Run full `npm test` — all 5 original tests + new ones green
- Deploy to `hl-carwars-dev`; run 10+ arena matches covering:
  - 1v1 open arena (sanity)
  - 1v1 truck-stop (concave corners present)
  - 2v2 town-square (buildings + corridors)
  - 4v4 truck-stop (pileup stress)
- Tune writer strengths if needed — the numeric priorities above are
  starting points, not final values

## Ship criterion for Phase 2

- All 8 tests (5 existing + 3 new scenario) pass
- In live 4v4 on truck-stop: no vehicle pinned against a wall for >2
  seconds without stuck-recovery firing
- Subjective "AI looks like it's driving with purpose" verdict in
  playtest notes
- Performance: P50 AI tick <0.5 ms for 8 vehicles (current baseline
  ~0.2 ms; ring adds ~16×6 writes per vehicle = well within budget)

## Rollback plan for Phase 2

The one-commit enabling change is T2.9. If the phase goes sideways in
playtest, revert T2.9 alone — writers continue to run (harmless) but
`desiredFacing` is sourced from the old logic. Other commits stay in;
they're additive plumbing.

## Playtest checklist for Phase 2

- [ ] Head-to-head 1v1 open — AI still seeks, circles at preferred range
- [ ] 1v1 against concave corner — AI does not pin
- [ ] 2v2 town-square — AI paths around buildings, does not headbutt
- [ ] 4v4 truck-stop — squadmates don't pile up, low-hp vehicles give
      blast radius
- [ ] Commander orders — `attack` / `move` / `follow` / `retreat` still
      work; `T` key tactical overlay still functions
- [ ] Stuck recovery — force a pin against a wall; recovery still kicks
      in at ~40 ticks of stuck

---

# Phase 3 — Pathfinder + Wreckage Awareness

**One-line goal:** Give the AI a *destination* it's committed to, not
just a local heading. Wreckage becomes routeable, not just avoidable.

**Expected effect:** AI reaches enemies hidden behind buildings (currently
impossible); `move` commander orders feel deliberate; low-speed
manoeuvres near wreckage no longer snag.

**Prerequisite:** Phase 2 merged.

## Files touched

**New:**
- `server/src/ai/pathfinder.ts` — heap A*, grid derivation, LOS
  smoothing, flow-field flood, path cache
- `server/src/ai/heap.ts` — binary-heap priority queue (pure, unit-tested)
- `server/tests/pathfinder.test.ts` — routing + smoothing + flood tests
- `server/tests/heap.test.ts` — heap invariants

**Modified:**
- [server/src/world/zone-runner.ts](../../server/src/world/zone-runner.ts) —
  construct one `Pathfinder` per arena at match start; pass via `AiContext`
- `server/src/ai/types.ts` — add `pathfinder: Pathfinder` and
  `wreckageHash: string` to `AiContext` (hash invalidates cached paths
  when wreckage changes)
- `server/src/ai/driver.ts` — tactic/role goal becomes
  `pathfinder.find(self.pos, goalPos)`, first waypoint bearing written
  into ring as interest
- `server/src/ai/writers.ts` — add `writePathInterest(ring, self, path)`

## Tasks

### T3.1 — Failing tests

`server/tests/pathfinder.test.ts`:

```ts
it('routes around a building to reach a target behind it', () => {
  // Map: a 10×10 building at (0, -10); vehicle at (0, 0), enemy at (0, -20)
  // Run 200 ticks; assert vehicle.position.y < -15 (got past building)
});

it('shares a single flow field across a 4-vehicle move order', () => {
  // 4 AI vehicles with commander 'move' order to same point
  // Instrument pathfinder to count flood calls
  // Assert flood called exactly once per 30-tick window
});

it('invalidates cached path when wreckage appears on it', () => {
  // Vehicle is 10 ticks into a cached path; spawn a wreck on that path
  // Assert next tick's path differs from cached path
});
```

### T3.2 — Binary-heap priority queue

`server/src/ai/heap.ts` — standard binary heap with `push(item, priority)`
and `pop(): { item, priority }`. Independent file so it's trivially
unit-testable. ~60 lines.

### T3.3 — Heap A* on derived grid

In `pathfinder.ts`:

```ts
export class Pathfinder {
  constructor(private map: ArenaMap);
  find(from: Position, to: Position): Position[] | null;
}
```

Grid derivation: 1 world-unit cells. Pre-compute on construction:
walkable = `!anyWallOverlaps(cell, map.walls, VEH_PROBE_W, VEH_PROBE_H)`.
The probe size matches the existing [`VEH_PROBE_W = 0.9`, `VEH_PROBE_H = 1.4`](../../server/src/ai/driver.ts)
constants — so the pathfinder respects the same clearance the avoidance
code does.

A* with 8-neighbour connectivity, octile heuristic, diagonal cost √2.
Returns a list of grid-cell centres in world coordinates, or `null`.

Bench in test: path across the full 120×75 truck-stop map < 5 ms P99
(no caching). Target: < 1 ms warm, < 5 ms cold.

### T3.4 — LOS-smoothing pass

```ts
smooth(path: Position[]): Position[];
```

Walk the waypoint list. For each `i`, if the segment from `path[i-1]`
to `path[i+1]` doesn't cross any wall AABB, delete `path[i]`. Repeat
until stable. Classic string-pulling — removes the 45° staircase.

LOS check: same `lookAhead`-style AABB intersection the wall writer
uses. Factor into a shared helper in a new
`server/src/ai/geometry.ts` so both pathfinder and writers use the same
implementation (avoids drift).

### T3.5 — Wreckage as soft cost

```ts
updateObstacles(wreckage: WreckageObject[]): void;
```

Re-run whenever the wreckage list changes (detect via
`AiContext.wreckageHash`). For each wreck, inflate cost on cells within
radius 2 by a multiplier:
- `burning` → 5× (expensive, but path-through possible)
- `smouldering` → 3×
- `debris` → 1.5×

A* still finds the shortest path; wreckage just biases it away.

### T3.6 — Flow field for shared move orders

```ts
flood(goal: Position): Float32Array;
```

Dijkstra from `goal` across the obstacle grid. Each cell stores its
bearing toward the goal (encoded as `float` degrees, or a 2D
unit-vector pair if we want to avoid re-computing bearings). Cache
keyed by `(goalCellX, goalCellY, wreckageHash)`.

### T3.7 — Path cache

```ts
private cache: Map<string, { path: Position[]; tick: number }>;
```

Key: `"${fromCell}-${toCell}-${wreckageHash}"`. TTL: 15 ticks (1.5 s).
On miss → A* + smooth → cache. Ties into the replan-cooldown in T3.8.

### T3.8 — Replan-cooldown + stuck-triggered replan

In `driver.ts`:
- Store `DriverState.pathCacheKey` and `DriverState.pathNextWaypointIdx`
- If cache is valid and next waypoint is still reachable (LOS), continue
  on the cached path — don't re-A*
- If `stuckTicks >= 4`, invalidate path and force a replan this tick
- If the tactic chooses a **new** goal bearing (distinct from last), replan

### T3.9 — Tactic goal → pathfinder → ring

Wire it in. Each tactic that previously set `desiredFacing` from a
target bearing now:

```ts
const goalPos = computeTacticGoal(self, target, tactic, ...); // e.g. flank point
const path = ctx.pathfinder.find(self.position, goalPos);
writePathInterest(ring, self, path);                          // uses first waypoint
```

`writePathInterest` writes interest at the bearing to the first
non-trivially-close waypoint. Strength same as tactic priority in T2.7.

If pathfinder returns `null` (goal unreachable), fall back to the old
direct-bearing interest write — we don't want pathfinder failure to
freeze the AI.

### T3.10 — Commander `move`/`retreat` use flow field

Current short-circuits in `driver.ts` lines 236–268 (move/retreat/follow).
Modify:
- `move` — lookup flow field at current cell → write interest at its
  bearing. Still bypasses the tactic switch, but now it's arena-aware.
- `retreat` — same (flood from a safe point — averaged ally influence
  map once Phase 4 lands; in Phase 3, flood from centroid-away-from-enemies)
- `follow` — no pathfinder change needed; it's a formation position, not
  a map goal

### T3.11 — Verification + bench

- All previously-failing tests from T3.1 pass
- Benchmark script in `server/scripts/bench-ai.ts` (new):
  - 8 AI vehicles × 100 ticks on truck-stop with wreckage scattered
  - Report P50/P99 per-tick AI cost including pathfinding
  - Target: P99 < 2 ms total AI for 8 vehicles
- Deploy + playtest

## Ship criterion for Phase 3

- Routing-around-building test passes
- `move` orders with 4-vehicle squad resolve coherently (all 4 arrive
  within 3 seconds of each other on truck-stop)
- P99 AI tick cost < 2 ms on an 8-vehicle arena
- No visible "AI froze while thinking" stutters

## Rollback plan for Phase 3

Path writing in T3.9 is gated by an existence check (`if (path)`). To
roll back, make `pathfinder.find()` always return `null` — all tactics
fall through to direct-bearing writes from Phase 2. Ring layer
unaffected.

## Playtest checklist for Phase 3

- [ ] 1v1 on town-square — AI reaches an enemy behind a building
- [ ] 4-vehicle `move` order to a waypoint — all four arrive,
      coordinated
- [ ] Wreckage appears on an AI's path mid-pursuit — AI reroutes
      within 2 seconds
- [ ] Retreat order — squad moves away from enemy centroid along a
      sensible path, not into walls
- [ ] No perceptible lag compared to Phase 2 baseline

---

# Phase 4 — Squad Brain

**One-line goal:** Four AI squadmates become a coordinated gang, not
four independent fighters wearing the same colour.

**Expected effect:** target-saturation disappears (3 AI don't all focus
one low-hp enemy); flank-angle emerges (2 AI vs 1 enemy approach from
different sides); rally behaviour when damaged; commander orders feel
like macro-level strategy rather than per-vehicle micromanagement.

**Prerequisite:** Phase 3 merged.

## Files touched

**New:**
- `server/src/ai/squad.ts` — `SquadContext`, target-claim tracking,
  role auction
- `server/src/ai/influence.ts` — `InfluenceMaps` (threat/ally/cover),
  stamp functions, rebuild loop
- `server/src/ai/utility.ts` — consideration curves and utility scorer;
  replaces `chooseTactic()`
- `server/tests/squad.test.ts` — saturation, flank-angle, rally tests
- `server/tests/influence.test.ts` — stamp + sample correctness
- `server/tests/utility.test.ts` — curve math + selection

**Modified:**
- [server/src/world/zone-runner.ts](../../server/src/world/zone-runner.ts) —
  allocate `SquadContext` per `playerId` at match start, rebuild
  influence maps every 2 ticks, run role auction every 20 ticks
- `server/src/ai/types.ts` — add `squadContext: SquadContext` and
  `influenceMaps: InfluenceMaps` to `AiContext`
- `server/src/ai/driver.ts` — `chooseTactic()` replaced with
  `scoreTactics()` from utility module; commander orders adjust role
  priorities rather than pinning tactics

## Tasks

### T4.1 — Failing tests

`server/tests/squad.test.ts`:

```ts
it('prevents target saturation (4 AI vs 1 low-hp enemy → <=2 committed)', () => {
  // Spawn 4 AI + 1 low-hp enemy in open map
  // Run 30 ticks; count AI with tactic.target === enemy
  // Assert <= 2 attacking, others pick secondary goals
});

it('produces flank angle >= 60° between two AI attacking same target', () => {
  // 2 AI + 1 enemy in open map
  // Run 60 ticks; measure bearings from each AI to enemy
  // Assert |bearing1 - bearing2| >= 60° for > 70% of ticks
});

it('rallies squad to low-threat cell when average health < 40%', () => {
  // 3 AI, all with 30% hp, 1 enemy at centre
  // Run 40 ticks; assert all 3 AI positions cluster within 8 units
  //   and are at a cell with threatMap < median
});
```

### T4.2 — `SquadContext` + lifecycle

`server/src/ai/squad.ts`:

```ts
export interface SquadContext {
  playerId: string;
  members: string[];
  roleByAgent: Map<string, SquadRole>;
  targetClaims: Map<string, ClaimInfo>;   // enemyId → claim
  rally: Position;
  lastAuctionTick: number;
  currentObjective: SquadObjective;       // 'engage' by default; commander orders shift this
}
export type SquadRole = 'anchor' | 'flanker_l' | 'flanker_r' | 'support' | 'scout';
export type SquadObjective = 'engage' | 'move_to' | 'retreat' | 'hold' | 'escort';
```

In `zone-runner.ts`:
- At match start, group vehicles by `playerId`; build one
  `SquadContext` per side (human side gets one too — used only when
  human toggles autopilot)
- On vehicle destroyed: remove from `members`, trigger role auction
- On vehicle joining late (not currently possible, but future-proof):
  add + auction

### T4.3 — `InfluenceMaps`

`server/src/ai/influence.ts`:

```ts
export class InfluenceMaps {
  constructor(map: ArenaMap);
  rebuildDynamic(sideVehicles: VehicleState[], enemies: VehicleState[],
                 wreckage: WreckageObject[]): void;
  sample(layer: 'threat' | 'ally' | 'cover', pos: Position): number;
  sampleCell(layer, cx: number, cy: number): number;
  bestCell(layer, predicate?: (threat, ally, cover) => boolean): Position;
}
```

Cell size: 1 world unit. Grids sized to `map.width × map.height`.

**Threat stamp:** for each enemy, Gaussian stamp in their weapon's
`longRange` radius at `peak = 1.0`, decaying by distance. Weapons
supply range from [server/src/rules/data/weapons.ts](../../server/src/rules/data/weapons.ts).

**Ally stamp:** for each squadmate, Gaussian stamp at their effective
weapon range, peak scaled by their current hp fraction.

**Cover stamp (static, computed once at `rebuildStatic()`):** for each
cell, raycast to each wall; cells whose nearest wall is within 3 units
score proportional cover (low walls block at low heights — future
extension).

Rebuild dynamic maps every 2 ticks (5 Hz). Static cover map rebuilds
only if walls change (never, during a match).

### T4.4 — Target claims

In `squad.ts`:

```ts
interface ClaimInfo {
  claimants: string[];
  committedDps: number;
  lastTick: number;
}
updateClaims(squad: SquadContext, vehicles: VehicleState[], tick: number): void;
```

Rules:
- Each AI currently attacking target T registers as claimant with its
  weapon's DPS (from `WEAPONS` table × fire cooldown).
- Claim decays 20% per 10 ticks if the claimant hasn't fired at T
  recently.
- When `committedDps >= T.hp * 1.3` (kill-margin), further claims
  score low utility — new AIs pick other targets.

### T4.5 — Role auction (every 20 ticks)

`squad.ts`:

```ts
runAuction(squad: SquadContext, vehicles: VehicleState[],
           enemies: VehicleState[], maps: InfluenceMaps): void;
```

Roles available scale with squad size:
- 1 member → `anchor`
- 2 → `anchor` + `flanker_r` (or `flanker_l`, flipped per match)
- 3 → `anchor` + both flankers
- 4 → all above + `support`

Bid function per (agent, role):
- `anchor`: cost = distance to best-LoS cell near enemy + hp penalty
- `flanker_{l,r}`: cost = distance to flank cell (90° off anchor's
  fire-line, on the given side) + threat at that cell
- `support`: cost = distance to rally cell + (1 - hp) × 5 (favours
  damaged vehicles)
- `scout`: cost = distance to lowest-info cell (cells far from all
  squadmates) + (max_hp_bonus for healthy vehicles)

Greedy assignment: lowest bid wins each role, eliminated from further
rounds. **Role stickiness bonus:** current role gets −15% on its own
re-bid to prevent churn.

### T4.6 — Utility scoring replaces `chooseTactic`

`server/src/ai/utility.ts`:

```ts
export function scoreTactics(
  self: VehicleState, target: VehicleState, d: number, skill: number,
  w: WeaponChoice | null, squad: SquadContext, maps: InfluenceMaps,
): Tactic;
```

For each tactic, compute score = product of considerations:

```ts
aggressive: product(
  curveLinear(armorFrac(self)),
  curveInvLinear(d, 0, 20),
  curveStep(targetClaimedRatio, 0.8, 1.0, 0.3),   // don't pile on
  curveLinear(skillNorm(skill)),
  roleBonus(self, squad, { anchor: 1.2, flanker_l: 1.1, flanker_r: 1.1 }),
),
flanking: product(
  curveLinear(armorFrac(self), 0.5, 1.0),
  curveStep(squad.roleByAgent.get(self.id), 'flanker_l'|'flanker_r', 1.4, 1.0),
  curveInvLinear(maps.sample('threat', flankCellForSelf(self, target, squad))),
  curveLinear(skillNorm(skill), 0.4, 1.0),
),
// ... snipe, orbit, evasive similarly
```

Pick highest-scoring tactic. Reuse existing tactic hold-for-15-ticks
hysteresis from current `driver.ts:319`.

The considerations reading `squad` and `maps` are what make per-agent
decisions squad-coherent — no squad-brain directive needed.

### T4.7 — Commander orders integrate with roles

In `driver.ts`, the current order short-circuits (lines 235–270):

- `move` — unchanged from Phase 3 (flow field); squadObjective set to
  `move_to` so role auction favours tight formation
- `attack` — no longer pins tactic; instead sets `squad.targetClaims`
  to lock target and biases the auction (this agent gets priority for
  `anchor` role targeting the ordered enemy)
- `follow` — auction gives this agent the `support` role pinned to
  leader's position
- `retreat` — squadObjective becomes `retreat`, biases all utilities
  toward `evasive`, rally cell becomes the safe exit direction

### T4.8 — Integration + wiring through AiContext

`types.ts`:

```ts
export interface AiContext {
  skill: number;
  map: ArenaMap;
  allVehicles: VehicleState[];
  wreckage: WreckageObject[];
  pathfinder: Pathfinder;
  influenceMaps: InfluenceMaps;
  squadContext: SquadContext;
  tick: number;
}
```

`zone-runner.ts` tick loop:

```ts
// Every 2 ticks, rebuild dynamic influence maps per side
if (tick % 2 === 0) {
  for (const squad of this.squadsByPlayer.values()) {
    const side = state.vehicles.filter(v => v.playerId === squad.playerId);
    const enemies = state.vehicles.filter(v => v.playerId !== squad.playerId);
    this.influenceMapsByPlayer.get(squad.playerId)!
      .rebuildDynamic(side, enemies, state.wreckage ?? []);
  }
}
// Every 20 ticks, run role auction
if (tick % 20 === 0) {
  for (const squad of this.squadsByPlayer.values()) {
    runAuction(squad, state.vehicles, ..., this.influenceMapsByPlayer.get(squad.playerId)!);
  }
}
// Per-tick claim updates
for (const squad of this.squadsByPlayer.values()) {
  updateClaims(squad, state.vehicles, tick);
}
```

### T4.9 — Verification + playtest

- All previously-failing tests from T4.1 pass
- Full `npm test` green
- Deploy + playtest scenarios in checklist below

## Ship criterion for Phase 4

- Saturation test passes: 4v1 low-hp → ≤2 AI committed
- Flank-angle test passes: 2v1 → average angular split ≥ 60°
- Rally test passes: damaged squad clusters at a low-threat cell
- In 4v4 truck-stop playtest: subjective "they're working as a team"
  verdict
- P99 AI tick cost ≤ 3 ms (Phase 3 budget + 1 ms headroom for squad
  brain)

## Rollback plan for Phase 4

Two independent kill switches:
1. `squadBrainEnabled` flag on `AiContext`. If false, utility scoring
   bypasses squad considerations (role multipliers → 1.0, claim
   considerations → neutral). Falls back to Phase 3 behaviour.
2. Auction disable: if auction throws or produces no assignment,
   `roleByAgent` stays empty and role considerations no-op. Utility
   scoring degrades gracefully.

## Playtest checklist for Phase 4

- [ ] 1v1 unchanged — no regression against Phase 3 baseline
- [ ] 2v1: two AI visibly split-approach the lone enemy
- [ ] 4v1 low-hp enemy: two AI engage, two peel off to secondary targets
      or rally
- [ ] 4v4 truck-stop: roles visibly assigned (anchor commits, flankers
      go wide, support stays back); repeat 5+ matches
- [ ] Commander `attack X`: target-claim lock prevents squadmates from
      re-targeting off X
- [ ] Commander `retreat`: squad withdraws together, not one-by-one
- [ ] Commander `move to waypoint`: tight formation arrival

---

# Cross-phase concerns

## Performance budget

| Phase | AI tick budget (8 vehicles) | Running total |
|---|---|---|
| Current baseline | ~0.2 ms | 0.2 ms |
| Phase 2 (context ring) | +0.1 ms (writers) | 0.3 ms |
| Phase 3 (pathfinder) | +0.5 ms P99 (mostly cached) | 0.8 ms |
| Phase 4 (squad + influence) | +1.0 ms (map rebuild at 5 Hz) | 1.8 ms |

Target P99: < 3 ms for 8 vehicles at 10 Hz. We have headroom.

If we blow the budget:
- Drop influence map cell size to 2 units (4× speedup)
- Drop rebuild to 3 Hz
- Cap flow-field flood radius to arena width (current full-flood)

## Observability

Each phase adds one log line per vehicle per tick at INFO level (the
existing `[AI]` log format). Add:

- Phase 2: `[RING]` log showing chosen bearing + danger score when
  chosen bearing differs from naïve tactic bearing
- Phase 3: `[PATH]` log on replan with `from → to, cost, cache_hit`
- Phase 4: `[SQUAD]` log on role auction with assignment summary;
  `[CLAIM]` log on claim commit/decay

Grep-friendly tags so post-match log review can focus on one subsystem.

## Feature flags / gradual rollout

Add to `server/src/ai/types.ts`:

```ts
export interface AiFeatureFlags {
  contextSteering: boolean;
  pathfinder: boolean;
  squadBrain: boolean;
}
```

Default all `true` once merged. Flags let us playtest each phase in
isolation on hl-carwars without rebuilding. Environment variable
`CARWARS_AI_FLAGS=context_steering,pathfinder` at server start toggles
them.

## Test scenarios (named — reusable across phases)

Create `server/tests/fixtures/arenas.ts` with builders:
- `openArena()` — 40×40, no walls
- `concaveCornerArena()` — two walls forming inner 90°
- `corridorArena(width, length)` — parallel walls
- `buildingArena()` — one 10×10 building dead centre
- `fourSpawnArena()` — 2v2 or 4v4 with symmetric spawns

Each scenario test imports these, keeps individual tests focused on
assertions not setup.

---

# Sequencing summary

| Phase | Duration estimate | Ship gates |
|---|---|---|
| 1 (prereq) | 0.5 day | existing tests green, no behavioural change |
| 2 | 1–2 days | 3 scenario tests pass, 4v4 playtest positive |
| 3 | 1 day | routing-around-building test passes, bench < 2 ms |
| 4 | 2 days | saturation + flank + rally tests pass, 4v4 coord playtest |

**Total: ~5 days of focused work across 4 merges.** Each merge is
independently deployable and revertible. Playtest gates between each
phase are mandatory — the AI "feel" can only be validated in a live
match.

## Updating the ROADMAP

When each phase ships, update [docs/ROADMAP.md](../ROADMAP.md):
- Phase 2 ship → §1 "AI driver (basic)" flip to `[x]`, add line noting
  context steering + wreckage awareness
- Phase 4 ship → add a new §1b "AI driver (squad-coordinated)" as `[x]`

## When to revisit

Before starting Phase 2, re-read the design doc
[2026-04-21-ai-driver-research-and-design.md](2026-04-21-ai-driver-research-and-design.md)
— it contains the "why" context that this plan takes as given.

Open questions from the design doc that need answers **during Phase 4**:
- Archetype authoring: per-driver or per-gang? (Design doc §8 item 4)
- Squad-brain lifecycle when vehicles join mid-match: probably N/A
  today, but worth ~10 min of thought before we build the lifecycle
  code
