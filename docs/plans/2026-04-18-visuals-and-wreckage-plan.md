# Visual Upgrade, Wreckage, and Map Snippets — Plan

**Date:** 2026-04-18
**Status:** Design locked — ready to expand into TDD-style tasks and execute

**Goal:** Three connected upgrades to the combat sandbox:
1. **Sprite-based vehicle icons** composed from a body-type sprite plus weapon attachment overlays per mount
2. **Persistent wreckage** obstacles with state (burning, smouldering, debris) driven by damage cause and remaining ammo; permanent across the session (gameplay lifetime is unbounded — lore says heavy debris lasts decades)
3. **Map snippet library** using free-form placement with typed connectors, so road-like snippets auto-align while buildings/fixtures drop anywhere

**Architecture:** All three live inside the existing server (`rules/`, `world/`) and client (`scenes/ArenaScene.ts`) seams. Wreckage re-uses the existing `resolveCollision` code path; snippets are transformed at map-load into the same `ArenaMap { walls: Rect[], spawnPoints: [] }` shape the engine already consumes.

---

## Locked-in design decisions

| # | Decision | Notes |
|---|----------|-------|
| 1 | Sprites over programmatic shapes | See "Art pipeline" below — this adds a new concern we need to resolve |
| 2 | Wreckage is permanent during gameplay | No fade, no despawn. Burning/smouldering are time-limited states but the obstacle remains as debris forever after |
| 3 | Wreckage state depends on damage cause AND ammo remaining | Burning → destroyed by fire/flamer. Explosion (blast damage to adjacent) → destroyed while carrying unspent ammo, or destroyed by explosive overkill. Otherwise → smouldering |
| 4 | Pushable wreckage requires the right tool | Vehicles with a ramplate accessory push wreckage; others bounce (take impact damage). Debris blocks all non-ramplate vehicles |
| 5 | Collision damage with wreckage | Full `resolveCollision()` damage on the vehicle's impact face. Wreckage absorbs damage too (`remainingDP`) — heavy hits can disintegrate small debris |
| 6 | Snippet placement | Free-form `(x, y, rotation)` but with optional typed connectors (`road_n`, `road_s`, etc.) so a composer helper can auto-align road pieces into highways/bends while buildings place freely |
| 7 | Scope order | Icons → Wreckage → Snippets |

---

## Art pipeline — the new concern sprites introduce

Using sprite images means sourcing actual image files. Three paths, ranked by speed:

**Option X — Placeholder generator (recommended for Phase 1).** Write a small build-time script (`client/scripts/generate-sprites.ts`) that procedurally draws each sprite to a PNG (node-canvas or Phaser's headless canvas). Output goes to `client/public/sprites/`. This keeps the workflow "edit a TS file, regenerate PNGs" so we get the sprite *pipeline* without waiting on art. Sprites can later be hand-replaced file-for-file without touching code.

**Option Y — AI-generated art.** Use a local or hosted image model to produce top-down 2D sprites per body type + weapon. Higher quality, but slower iteration and licensing considerations.

**Option Z — Hand-drawn art.** Paddy or a contributor draws each sprite. Best quality, longest path.

**Recommendation: start with X, keep the door open to drop in Y/Z assets later because the filenames and pivot conventions stay the same.**

---

## Phase 1: Layered Vehicle Icons

Replace the single rectangle with a loadout-driven layered sprite.

### Task 1.0: Placeholder sprite generator

**Files:**
- Create: `client/scripts/generate-sprites.ts`
- Create: `client/public/sprites/bodies/*.png` (output)
- Create: `client/public/sprites/weapons/*.png` (output)
- Modify: `client/package.json` — add `"sprites:gen": "tsx scripts/generate-sprites.ts"`

Generator uses `node-canvas` to draw each sprite procedurally and write the PNG. Drawing code is organised by body type/weapon category so replacing the drawing logic with hand-drawn PNG imports later is a one-file swap. Checked-in PNGs so `npm run dev` doesn't require the script at startup.

### Task 1.1: Vehicle sprite factory module

**Files:**
- Create: `client/src/game/VehicleSprite.ts`
- Modify: `client/src/scenes/ArenaScene.ts`
- Modify: `client/src/scenes/ArenaScene.ts` `preload()` to load all body + weapon sprites

**What it does:** Extracts the current inline sprite-construction (`this.add.rectangle(...)`, the armor bars, the direction triangle) into a factory:

```ts
buildVehicleSprite(scene: Phaser.Scene, v: VehicleState, myId: string): Phaser.GameObjects.Container
updateVehicleSprite(container: Container, v: VehicleState, myId: string): void
```

Pure refactor first — same visuals — to get the code out of ArenaScene before adding the new sprite layers in Tasks 1.2/1.3.

### Task 1.2: Body-type sprite set

One PNG per body type in `client/public/sprites/bodies/`. Each sprite points "up" (game facing 0°) and has a known pivot at the centre so rotation works without offset.

| Body type | Sprite filename | Approx size (px) |
|-----------|-----------------|------------------|
| `light_cycle`, `med_cycle`, `hvy_cycle` | `cycle_light.png`, `cycle_med.png`, `cycle_heavy.png` | 10×24 |
| `trike` | `trike.png` | 18×26 |
| `subcompact` | `subcompact.png` | 18×28 |
| `compact`, `mid_sized`, `sedan`, `station_wagon` | `car_compact.png`, `car_mid.png`, `car_sedan.png`, `car_wagon.png` | 20×32 |
| `luxury` | `car_luxury.png` | 22×36 |
| `pickup`, `van`, `camper` | `pickup.png`, `van.png`, `camper.png` | 22×40 |
| `truck` | `truck.png` | 24×48 |
| `trailer` | `trailer.png` | 24×48 |

Unknown body types fall back to `car_mid.png`.

**Loader step** (Phaser `preload`) registers all body sprites so they're available by body-type key. Team colour is applied via Phaser tint (`container.setTint(0x00ff88)`) so the same sprite serves red/green/yellow teams.

### Task 1.3: Weapon attachment sprites

One small sprite per weapon category in `client/public/sprites/weapons/`:
- `mg.png`, `cannon.png` (small/large bore)
- `laser.png`, `heavy_laser.png`
- `rocket_rack.png`, `missile.png`
- `flamer.png`
- `spikes.png`, `oil_jet.png` (dropped)
- `turret_ring.png` (shared base for turret mounts)

For each mount in `loadout.mounts[]`, layer the matching sprite on the body at an anchor point derived from `mount.arc`:
- `front` → anchor at hull top-centre
- `back` → anchor at hull bottom-centre
- `left` → anchor at hull left-centre, rotated 90°
- `right` → anchor at hull right-centre, rotated -90°
- `turret` → anchor at hull centre, turret ring + gun sub-layer (future: rotate turret independently of hull facing)

Mount with `ammo === 0` renders at 50% opacity to signal "dry".

### Task 1.4: State overlays

- `damageState.onFire` → flame glyph on top of sprite (animated tween for flicker)
- `damageState.driverWounded` → faint red pulse
- `damageState.destroyed` → handled by Phase 2 (swap for wreckage sprite)

---

## Phase 2: Wreckage as Obstacle

Destroyed vehicles currently persist in `ZoneState.vehicles` but are filtered out of active tick processing. They're not rendered as obstacles and don't damage collisions. We promote them to first-class obstacles with state.

### Task 2.1: Shared `WreckageObject` type

**Files:**
- Modify: `shared/src/types/world.ts`

```ts
export interface WreckageObject {
  id: string;
  sourceVehicleId: string;
  position: { x: number; y: number };
  facing: number;
  bodyType?: BodyType;
  state: 'burning' | 'smouldering' | 'debris';
  stateStartedAt: number;       // tick when current state began
  remainingDP: number;           // damage this wreck can still absorb before it breaks up
  mass: 'light' | 'medium' | 'heavy';  // cycle/subcompact = light, standard car = medium, van/truck/trailer = heavy
  pushable: boolean;              // true for light/medium if disintegration risk allows; false for heavy
  carriedAmmo: number;            // remaining rounds across all mounts at moment of destruction
  causedBy: 'fire' | 'explosion' | 'kinetic' | 'energy' | 'collision';
}

export interface ZoneState {
  // ... existing fields
  wreckage: WreckageObject[];
}
```

### Task 2.2: Promote destroyed vehicles to wreckage

**Files:**
- Modify: `server/src/rules/engine.ts`

When `damageState.destroyed` transitions to `true` in a tick, remove the vehicle from `state.vehicles`, push a `WreckageObject` onto `state.wreckage`, and emit a `vehicle_destroyed` combat event.

**Initial `state` selection**, in priority order:
1. If `causedBy === 'fire'` → `burning`
2. Else if `carriedAmmo > 0` AND (`causedBy === 'explosion'` OR damage overflow ≥ 6) → `burning` + trigger blast (Task 2.3)
3. Else if `causedBy === 'explosion'` → `smouldering`
4. Else → `smouldering`

**Mass** from the vehicle's body type. **Pushable** starts as `true` for `light`, `false` for `heavy`; `medium` is pushable until the wreck takes enough secondary damage to be marked `false`.

### Task 2.3: Ammo-cookoff blast on destruction

When a vehicle is destroyed while carrying ammo AND the damage cause warrants it (Task 2.2 rule 2), apply a blast in a 2-inch radius at the moment of death:
- Every vehicle within radius takes `rollDamage(2, 0)` kinetic damage on its closest face
- Every `wreckage` within radius loses half its `remainingDP`
- The source vehicle's `carriedAmmo` is consumed — no further blast from the same wreck

### Task 2.4: Wreckage state transitions

Tick driver:
- `burning` for 30 ticks (~3 turns) → `smouldering`
- `smouldering` for 60 ticks → `debris`
- `debris` **persists forever** (no removal)

Each state has a visual + a hazard profile:
- `burning` — ignites vehicles within 1 inch for 1 tick of fire damage per tick of adjacency
- `smouldering` — no hazard, still a full obstacle
- `debris` — full obstacle (collision damage applies); heavy debris permanently blocks non-ramplate vehicles

### Task 2.5: Collision with wreckage (with pushable logic)

**Files:**
- Modify: `server/src/rules/engine.ts`
- Modify: `shared/src/types/vehicle.ts` — add optional `hasRamplate: boolean` to `VehicleLoadout` for the push check

Extend the existing vehicle-pair AABB loop to also check `wreckage[]`. For each overlap:

1. Reuse `resolveCollision(speedA, 0, type, attackerHasRamplate)` — the wreck is the stationary B.
2. Apply damage to the vehicle's impacted face.
3. `WreckageObject.remainingDP -= damageB`. When `remainingDP ≤ 0`, set `state = 'debris'` (skipping burning/smouldering timers) and halve `mass` tier (heavy → medium → light → marked pushable).
4. **Push logic:**
   - Vehicle has ramplate AND wreck is `pushable`: wreck is pushed by overlap along the vehicle's velocity vector; vehicle keeps moving (half speed loss).
   - Otherwise: vehicle is pushed back by full overlap, speed zeroed; wreck stays put.

### Task 2.6: Client wreckage rendering (sprites)

**Files:**
- Modify: `client/src/scenes/ArenaScene.ts`
- Modify: `client/src/game/VehicleSprite.ts`
- Create: `client/public/sprites/wreckage/*.png` (generated via Task 1.0's generator — one per body type × state = `{bodyType}_burning.png`, `{bodyType}_smouldering.png`, `{bodyType}_debris.png`)

Maintain a `Map<string, Container>` for wreckage. The sprite key = `${wreck.bodyType}_${wreck.state}.png`. Burning adds an animated flame overlay; smouldering adds a slow smoke particle tween.

### Task 2.7: Tests

- `server/tests/engine.test.ts`
  - Destroyed vehicle migrates from `vehicles[]` to `wreckage[]` in the next tick
  - Ammo-loaded vehicle destroyed by explosion triggers blast damage on neighbours
  - Wreckage collision damages vehicle on correct face
  - Ramplate vehicle pushes pushable wreckage; non-ramplate bounces
  - Burning wreck transitions to smouldering after 30 ticks
  - Debris is never removed from the zone state

---

## Phase 3: Map Snippet Library

Compositional map authoring: hand-author re-usable chunks once, snap them together to build new maps.

### Task 3.1: Snippet type + composer

**Files:**
- Modify: `shared/src/types/world.ts`
- Create: `server/src/rules/maps/snippets/index.ts`
- Create: `server/src/rules/maps/compose.ts`

```ts
export interface MapSnippet {
  id: string;
  size: { w: number; h: number };   // bounding box
  walls: Rect[];                    // coordinates relative to snippet center
  decor?: Decor[];                  // future: non-blocking objects
  spawnPoints?: SpawnPoint[];
  connectors?: Connector[];         // typed exits for the composer
}

export interface Connector {
  id: 'road_n' | 'road_s' | 'road_e' | 'road_w' | 'gate' | ...;
  x: number;      // relative to snippet center
  y: number;
  facing: number; // outward direction in degrees
}

// In compose.ts:
export function composeMap(
  mapId: string,
  width: number,
  height: number,
  placements: { snippet: MapSnippet; x: number; y: number; rotation: 0 | 90 | 180 | 270 }[]
): ArenaMap;
```

Composer responsibilities:
1. For each placement, rotate + translate the snippet's walls into world coordinates
2. Concatenate all walls, decor, spawn points into one `ArenaMap`
3. Deduplicate obviously overlapping walls (optional, performance)

### Task 3.2: Seed snippet library

`server/src/rules/maps/snippets/` gets an initial batch:

**Roads:**
- `road_straight_20` — 4-unit-wide road, 20 units long, connectors at both ends
- `road_bend_ne` — 90° bend, NE corner
- `road_bend_nw`, `road_bend_se`, `road_bend_sw` — mirrors
- `road_t_junction` — 3-way
- `road_crossroads` — 4-way

**Arena fixtures:**
- `arena_gatehouse` — 6×4 building, front gap, corner turrets as separate snippet
- `arena_corner_turret` — 3×3 turret with walls
- `arena_wall_straight_20`

**Town blocks:**
- `town_block_small` — 16×16 area with 4 building footprints, alleys
- `town_diner` — small rectangular building with entry gap
- `town_gas_station` — pumps as turrets, canopy as non-blocking decor

Each snippet is ~30 lines of TS exporting a `MapSnippet` const.

### Task 3.3: Rebuild `truck-stop` using snippets

Re-express the existing truck-stop map as a composition of snippets to prove the model works and catch the "the composed version plays identically" tests.

### Task 3.4: Compose a new demo map

`arena_circuit` — a small race-track-shaped arena built from road snippets + bends + a couple of gatehouse fixtures, to show off the composer with something the current `truck-stop` can't express.

### Task 3.5: Snippet tests

- Composer tests: placement at each rotation produces correct world coordinates
- Connector alignment: two road snippets placed along a matching connector pair have connector points within 0.5 units of each other
- Round-trip: composed truck-stop has the same wall count and spawn points as the hand-authored version

---

## Sequencing & effort estimate

| Phase | Effort | Parallelizable? |
|-------|--------|----------------|
| 1 Icons | S (1 sitting) | Yes — client only |
| 2 Wreckage | M (2-3 sittings) | Yes — server + client, two streams |
| 3 Snippets | L (3-4 sittings) | Yes — once composer is done, snippets can be authored in parallel |

Recommended order: **1 → 2 → 3**. Icons first so Phase 2 already has a styled `destroyed` sprite to swap in; wreckage before snippets because wreckage exercises the existing map loader, which informs the snippet interface.
