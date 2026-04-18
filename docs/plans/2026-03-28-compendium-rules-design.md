# Car Wars Compendium 2E Rules Implementation — Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the full Car Wars Compendium 2nd Edition ruleset for ground vehicles (cars and cycles) across four phased layers, each leaving the game in a playable state.

**Architecture:** Extend the existing server/shared/client TypeScript monorepo without breaking current gameplay. New fields carry sensible defaults so existing test vehicles continue to work throughout. Static rule catalogs live in `server/src/data/`; logic lives in `server/src/rules/`; shared types live in `packages/shared`.

**Tech Stack:** TypeScript, Node.js (server), Phaser (client), PostgreSQL (JSONB loadout column), `@carwars/shared` types package.

**Source material:** Car Wars Compendium 2nd Edition PDF at `/Volumes/Books/RPG Books/CarWars/pdfcoffee.com_car-wars-2e-compendium-sjg-7142-pdf-free.pdf`

---

## Scope

Ground vehicles — cars, cycles, trikes, and oversized (trucks/trailers at basic level). Four implementation phases:

1. **Vehicle Design System** — body types, chassis, suspension, power plant, tires, armor → derived stats
2. **Weapons Catalog** — ~17 priority weapons with correct stats, proper range bands, ammo tracking
3. **Enhanced Combat** — full to-hit modifier table, vehicular fire, per-component damage pipeline
4. **Movement Fidelity** — HC track, control table, full maneuver set, collision resolution

---

## Phase 1: Vehicle Design System

### Body Types

All body types share the same `BodyDef` interface (unified catalog in `server/src/rules/data/bodies.ts`). The key addition over the original design is the `surfaces` field, which declares the valid armor locations for each body type — this drives both the designer UI and hit-location resolution.

```typescript
export interface BodyDef {
  id: string;
  name: string;
  price: number;
  baseWeight: number;
  maxLoad: number;
  spaces: number;
  armorCostPerPt: number;
  armorWtPerPt: number;
  baseHC: number;
  isCycle: boolean;
  tireCount?: number;        // overrides default (2 for cycles, 4 for others) when set
  surfaces: ArmorLocation[]; // valid armor locations for this body type
}
```

**`ArmorLocation` type** (in `shared/src/types/vehicle.ts`):
```typescript
// Standard 6-surface (cars, trucks, vans)
type StandardSurface = 'front' | 'back' | 'left' | 'right' | 'top' | 'underbody';

// Cycle/trike: 4 surfaces only — no top or underbody
type CycleSurface = 'front' | 'back' | 'left' | 'right';

// Trailer/bus: 10 positions — sides/top/underbody split front and back
type TrailerSurface =
  | 'front_front' | 'front_back'
  | 'right_front' | 'right_back'
  | 'left_front' | 'left_back'
  | 'top_front' | 'top_back'
  | 'underbody_front' | 'underbody_back';

export type ArmorLocation = StandardSurface | TrailerSurface;
```

**Note:** The trailer 10-position system requires the `TrailerSurface` union. Add it now so the type is available; the designer UI for trailers can be deferred but the type must be correct from the start or DB migrations will be needed later.

---

### Car Body Types

| Type | Price | Weight | Max Load | Spaces | Armor $/pt | Armor lbs/pt | Surfaces |
|------|-------|--------|----------|--------|-----------|--------------|---------|
| subcompact | 300 | 1000 | 2300 | 7 | 11 | 5 | 6 (standard) |
| compact | 400 | 1300 | 3700 | 10 | 13 | 6 | 6 (standard) |
| mid_sized | 600 | 1600 | 4800 | 13 | 16 | 8 | 6 (standard) |
| sedan | 700 | 1700 | 5100 | 16 | 18 | 9 | 6 (standard) |
| luxury | 800 | 1800 | 5500 | 19 | 20 | 10 | 6 (standard) |
| station_wagon | 800 | 1800 | 5500 | 14 | 20 | 10 | 6 (standard) |
| pickup | 900 | 2100 | 6500 | 13 | 22 | 11 | 6 (standard) |
| camper | 1400 | 2300 | 6500 | 17 | 30 | 14 | 6 (standard) |
| van | 1000 | 2000 | 6000 | 24 | 30 | 14 | 6 (standard) |

All car types use `surfaces: ['front','back','left','right','top','underbody']`.

---

### Cycle Frames

| Frame | Price | Weight | Max Load | Spaces | Armor $/pt | Armor lbs/pt | Tires | Surfaces |
|-------|-------|--------|----------|--------|-----------|--------------|-------|---------|
| light_cycle | 200 | 250 | 800 | 4 | 10 | 4 | 2 | 4 (cycle) |
| med_cycle | 300 | 300 | 1100 | 5 | 11 | 5 | 2 | 4 (cycle) |
| hvy_cycle | 400 | 350 | 1300 | 7 | 12 | 6 | 2 | 4 (cycle) |

All cycle types use `surfaces: ['front','back','left','right']` — **no top or underbody armor** (Compendium confirmed). Top/underbody hits on cycles go directly to internal components.

---

### Trike

| Type | Price | Weight | Max Load | Spaces | Armor $/pt | Armor lbs/pt | Tires | Surfaces |
|------|-------|--------|----------|--------|-----------|--------------|-------|---------|
| trike | 350 | 500 | 1600 | 6 | 11 | 5 | 3 | 4 (cycle) |

- Uses **Cyclist skill** (not Driver) — same as 2-wheelers
- `isCycle: true`, `tireCount: 3`
- 4 surfaces: same as cycles — no top or underbody
- Base HC: 3 (less maneuverable than 2-wheelers; HC 4–5)
- HC category: `subHC` (same as subcompacts and cycles)
- Loses a corner with one wheel → Crash Table 1 immediately (same rule as cycles)

---

### Oversized Body Types

| Type | Price | Weight | Max Load | Spaces | Armor $/pt | Armor lbs/pt | Tires | Surfaces |
|------|-------|--------|----------|--------|-----------|--------------|-------|---------|
| truck | 1500 | 3000 | 8000 | 10 | 35 | 16 | 4 | 6 (standard) |
| trailer | 500 | 1500 | 14000 | 30 | 25 | 12 | 4 | 10 (trailer) |

**Truck (tractor cab):**
- 6 surfaces same as cars (Truck Stop confirmed: tractors have same armor structure as cars)
- Uses `vanHC` suspension category
- **HC 0 alone** — technically driveable but handling is very poor; HC 1 when trailer attached
- Requires **Trucker skill**; without it: -2 HC
- Non-skilled backing a trailer: roll 1d every movement phase — 1 = swerve

**Trailer:**
- 10-position armor system: each of sides/top/underbody split into front-half and back-half
- `surfaces`: all 10 `TrailerSurface` values
- Does not move independently — follows tractor
- Attacker specifies front-half or back-half based on relative position
- Flatbed variant: only `underbody_front` and `underbody_back` (no side/top armor)

### Chassis Types

| Type | Weight Modifier | Price Modifier |
|------|----------------|----------------|
| light | -10% | -20% body cost |
| standard | none | none |
| heavy | +10% | +50% body cost |
| extra_heavy | +20% | +100% body cost |

### Suspension Types

HC is looked up by **body size category**, not directly by body type:

| Category | Body Types |
|----------|-----------|
| `subHC` | subcompact, all cycles, trikes |
| `vanHC` | van, pickup, camper, truck, trailer |
| `carHC` | all other cars (compact through station_wagon) |

| Type | Cost | carHC | vanHC | subHC |
|------|------|-------|-------|-------|
| light | 0 | 1 | 0 | 2 |
| standard | 0 | 2 | 1 | 3 |
| improved | 100% body cost | 2 | 1 | 3 |
| heavy | 150% body cost | 3 | 2 | 4 |
| off_road | 500% body cost | 2 | 1 | 3 |

**Truck/trailer suspension:** Trucks and trailers use `vanHC`. However, tractor HC is modified post-suspension: a tractor alone applies HC 0 regardless of suspension (it's so heavy without a load that standard HC is suppressed); HC 1 is restored when trailer is attached and weight is balanced.

### Power Plants

Two fuel types: **electric** and **gas**. Electric requires no fuel management (simplified for v1). Gas engines will require fuel tracking (deferred to Open World phase).

Both types share the same `PowerPlantDef` interface:
```typescript
interface PowerPlantDef {
  id: string;
  name: string;
  fuelType: 'electric' | 'gas';
  cost: number;
  weight: number;
  spaces: number;
  dp: number;
  powerFactors: number;
  cycleOnly?: boolean;  // true for cycle-specific units
}
```

**Electric — Car/Oversized:**

| ID | Name | Cost | Weight | Spaces | DP | PF |
|----|------|------|--------|--------|----|----|
| elec_small | Small Electric | 500 | 500 | 3 | 5 | 800 |
| elec_medium | Medium Electric | 1000 | 700 | 4 | 8 | 1400 |
| elec_large | Large Electric | 2000 | 900 | 5 | 10 | 2000 |
| elec_super | Super Electric | 3000 | 1100 | 6 | 12 | 2600 |
| elec_sport | Sport Electric | 6000 | 1000 | 6 | 12 | 3000 |
| elec_thundercat | Thundercat | 12000 | 2000 | 8 | 15 | 6700 |

**Gas — Car/Oversized:**

| ID | Name | Cost | Weight | Spaces | DP | PF |
|----|------|------|--------|--------|----|----|
| gas_150 | 150ci Gas | 400 | 400 | 3 | 6 | 700 |
| gas_200 | 200ci Gas | 700 | 550 | 4 | 8 | 1100 |
| gas_300 | 300ci Gas | 1200 | 750 | 5 | 10 | 1700 |
| gas_400 | 400ci Gas | 2000 | 950 | 6 | 12 | 2400 |

**Electric — Cycle only** (`cycleOnly: true`):

| ID | Name | Cost | Weight | Spaces | DP | PF |
|----|------|------|--------|--------|----|----|
| cyc_elec_small | Cycle Small Elec | 200 | 100 | 1 | 3 | 400 |
| cyc_elec_medium | Cycle Medium Elec | 400 | 150 | 2 | 5 | 700 |
| cyc_elec_large | Cycle Large Elec | 800 | 200 | 3 | 7 | 1100 |

**Gas — Cycle only** (`cycleOnly: true`):

| ID | Name | Cost | Weight | Spaces | DP | PF |
|----|------|------|--------|--------|----|----|
| cyc_gas_small | Cycle Small Gas | 150 | 80 | 1 | 3 | 350 |
| cyc_gas_medium | Cycle Medium Gas | 300 | 120 | 2 | 5 | 650 |
| cyc_gas_large | Cycle Large Gas | 600 | 160 | 3 | 7 | 1000 |

**Designer validation:** Cycle bodies may only use cycle power plants. Car/oversized bodies may only use car power plants.

### Tire Types

| Type | Cost | Weight | DP | Notes |
|------|------|--------|----|-------|
| standard | 50 | 30 | 4 | baseline |
| heavy_duty | 100 | 40 | 6 | |
| puncture_resistant | 200 | 50 | 9 | |
| solid | 500 | 75 | 12 | |
| plasticore | 1000 | 150 | 25 | HC drops by 1 permanently when bare |

Radial modification: +150% cost, +20% weight, HC+1, -1 DP.
Steelbelting: +50% cost, +25% DP.

### Armor Types

| Type | Cost Modifier | Weight Modifier | Notes |
|------|--------------|----------------|-------|
| ablative | 1× | 1× | standard; loses strength as damaged |
| fireproof | 2× | 1× | cannot be set on fire |
| laser_reflective | 1.1× | 1× | half damage from lasers |
| lr_fireproof | 2.5× | 1.1× | combines LR + FP |
| metal | 2.5× | 5× | ablative — excess passes through; 5/6 on d6 = -1 armor |
| radarproof | 2× | 1× | invisible to radar on 1-5 on 1d6 |

### Stat Derivation (`deriveStats()`)

```
1.  Start with body base weight
2.  Apply chassis weight modifier
3.  PF from power plant
4.  Acceleration:
      PF < weight/3   → 0 (underpowered, won't move)
      PF < weight/2   → 5 mph/turn
      PF < weight     → 10 mph/turn
      PF ≥ weight     → 15 mph/turn
5.  Top speed: 360 × PF / (PF + weight), rounded to 2.5 mph
6.  HC category: look up by body type → subHC / vanHC / carHC
7.  HC base: suspension[hcCategory]
8.  HC modifiers: radial tires +1 (if all corners have radials)
9.  Special HC override: truck body alone → clamp HC to max 0; truck + trailer → HC 1
10. Armor: validate that each location in loadout.armor is in body.surfaces; reject unknown locations
11. Armor DP per facing from loadout distribution (only surfaces valid for this body)
12. tireCount: body.tireCount ?? (body.isCycle ? 2 : 4)
13. Space check: sum of all component spaces ≤ body spaces
14. Weight check: sum of all component weights ≤ body maxLoad
```

**Surfaces validation** is a new check in step 10 — if a player submits `{ top: 5 }` for a cycle, return 400 with `"top is not a valid armor surface for body type med_cycle"`. This prevents invalid DB state and catches designer bugs early.

### Backward Compatibility

Existing test vehicles omitting new fields default to:
- `bodyType: 'mid_sized'`
- `chassisType: 'standard'`
- `suspensionType: 'standard'`
- `powerPlant: { type: 'elec_medium' }`
- `tireType: 'standard'`
- `armorType: 'ablative'`

Existing vehicles with armor stored across all 6 surfaces remain valid — `mid_sized` is a 6-surface body. No migration needed for existing test data. Only new cycle/trike/trailer bodies enforce the surface restriction.

### Vehicle Design API

New endpoint: `POST /api/vehicles/design`
- Accepts a full loadout spec
- Validates space and weight constraints
- Returns derived stats (acceleration, top speed, HC, total cost, total weight)
- 400 if constraints violated

---

## Phase 2: Weapons Catalog

### Shared Type Changes

```typescript
interface WeaponDef {
  id: string;
  name: string;
  category: 'small_bore' | 'large_bore' | 'rocket' | 'laser' | 'flamer' | 'dropped';
  toHit: number;           // base target number (2d6 must meet or beat)
  damageDice: number;      // number of d6
  damageMod: number;       // flat modifier to damage roll
  dp: number;              // weapon DP before destroyed
  spaces: number;
  weight: number;
  cost: number;
  shotsPerMag: number;
  ammoWeight: number;
  ammoCost: number;
  shortRange: number;      // inches — no range penalty within this
  longRange: number;       // inches — +2 to-hit beyond shortRange, impossible beyond longRange
  burstEffect: boolean;
  areaEffect: boolean;
  powerDrain: number;      // power units per shot (0 for non-laser)
  allowedArcs: ArcType[];  // arcs this weapon may be mounted in
}
```

### Priority Weapon Catalog

| ID | Name | Hit | Dmg | DP | Sp | Short | Long |
|----|------|-----|-----|----|----|-------|------|
| mg | Machine Gun | 7 | 1d | 3 | 1 | 6" | 12" |
| vmg | Vulcan MG | 6 | 2d | 3 | 2 | 6" | 12" |
| ac | Autocannon | 6 | 3d | 4 | 3 | 8" | 16" |
| rr | Recoilless Rifle | 7 | 2d | 4 | 2 | 8" | 16" |
| gl | Grenade Launcher | 7 | 1d+2 | 2 | 2 | 4" | 8" |
| ltr | Light Rocket | 9 | 1d | 1 | ½ | 4" | 8" |
| mr | Medium Rocket | 9 | 2d | 2 | 1 | 6" | 12" |
| hr | Heavy Rocket | 9 | 3d | 2 | 1 | 8" | 16" |
| rl | Rocket Launcher | 8 | 2d | 2 | 2 | 8" | 16" |
| mml | Micromissile | 8 | 1d | 2 | 1 | 6" | 12" |
| ll | Light Laser | 6 | 1d | 2 | 1 | 8" | 16" |
| ml | Medium Laser | 6 | 2d | 2 | 2 | 10" | 20" |
| l | Laser | 6 | 3d | 2 | 2 | 10" | 20" |
| hl | Heavy Laser | 6 | 4d | 2 | 3 | 12" | 24" |
| ft | Flamethrower | 6 | 1d | 2 | 2 | 4" | 8" |
| sd | Spikedropper | — | — | 4 | 1 | — | — |
| oj | Oil Jet | — | — | 3 | 2 | — | — |

### Range Band Logic (replacing current hardcode)

```typescript
function getRangeModifier(distance: number, weapon: WeaponDef): number | null {
  if (distance > weapon.longRange) return null;       // out of range — miss
  if (distance <= weapon.shortRange) return 0;         // no modifier
  return 2;                                            // long range +2
}
```

---

## Phase 3: Enhanced Combat

### To-Hit Modifier Table

Applied to the weapon's base `toHit` number (roll 2d6, must meet or beat result):

| Condition | Modifier |
|-----------|----------|
| Long range (beyond shortRange) | +2 |
| Target speed > 60 mph | +1 |
| Speed differential > 30 mph | +2 |
| Target is subcompact or cycle | +1 |
| Target is van, pickup, camper | -1 |
| Driver wounded | +2 |
| Gunner skill (per level above 0) | -1 |
| Targeting computer | -1 |
| Target has sloped armor | -1 |
| Firing on automatic | -1 |
| Firing laser-guided rocket | special |

### Damage Pipeline

On hit:

```
1. Roll damageDice × d6 + damageMod
2. Determine facing (getAttackLocation — already implemented)
3. currentArmor = damage.armor[facing]
4. remaining = currentArmor - damageRoll
5. If remaining ≥ 0: armor absorbs, update damage.armor[facing], done
6. If remaining < 0 (breached):
   a. Set damage.armor[facing] = 0
   b. Excess = abs(remaining)
   c. Roll on Vehicular Fire Table
   d. Apply internal component effects based on facing and excess
   e. If excess > 3: driverWounded = true
   f. If excess > 6: destroyed = true
```

### Vehicular Fire Table (1d6, on armor breach)

| Roll | Effect |
|------|--------|
| 1-2 | No fire |
| 3-4 | Component takes 1 point extra damage |
| 5 | Vehicle catches fire (onFire = true) |
| 6 | Explosion — 1d damage to all adjacent facings |

### Internal Component Damage by Facing

| Facing | Primary component | Secondary |
|--------|------------------|-----------|
| front | engine | driver |
| back | engine | gunner |
| left | left tire | driver |
| right | right tire | gunner |

Burst-effect weapons: roll internal component damage twice.

### Fire Damage (per tick)

If `onFire`:
- Apply 1 damage to a random unbreached armor location
- If fire extinguisher installed: roll 1d per tick — 1-3 = extinguished
- If all armor on a side is 0: internal components take fire damage directly

### DamageState Additions

```typescript
interface DamageState {
  armor: ArmorDistribution;
  engineDamaged: boolean;
  engineDP: number;           // NEW — engine takes hits independently
  driverWounded: boolean;
  tiresBlown: string[];
  destroyed: boolean;
  onFire: boolean;            // NEW
  internalDamage: string[];   // NEW — ordered list of component hits
}
```

---

## Phase 4: Movement Fidelity

### Handling Class Track

Each vehicle tracks `hazardAccumulator` (D-points) per turn. Reset to 0 at start of each turn.

```typescript
interface MovementState {
  handlingClass: number;      // current effective HC
  hazardAccumulator: number;  // D-points this turn
  skidding: boolean;
  controlLost: boolean;
}
```

### Hazard Sources

| Source | D-value |
|--------|---------|
| Normal bend (gentle steer) | D1 |
| Drift | D2 |
| Swerve | D3 |
| Controlled skid | D3 |
| T-Stop | D3 |
| Bootlegger reverse | D4 |
| Pivot | D6 |
| Decel > 5 mph/turn (per extra 5 mph) | +D1 |
| Accel > 15 mph/turn | +D1 |
| Blown tire (each) | +D1 |
| Driving through oil slick | +D2 |
| Driving through spikes | +D2 |

### Control Table (roll 2d6 + hazardAccumulator - HC)

| Result | Effect |
|--------|--------|
| ≤ 0 | No effect |
| 1 | Fishtail — -1 HC for rest of turn |
| 2 | Minor skid — vehicle slides 1" sideways |
| 3 | Skid — vehicle slides, must re-roll next turn |
| 4 | Roll — vehicle rolls, takes 1d collision damage per facing |
| 5+ | Collision with nearest obstacle |

### Maneuver Input Mapping

Client sends `steer` (-60 to +60). Server classifies:

```
|steer| ≤ 15 → bend (D1)
|steer| ≤ 30 → drift (D2)
|steer| ≤ 45 → swerve (D3)
|steer| > 45 → controlled skid (D3)
```

Special maneuvers (bootlegger, pivot, T-stop) will require explicit client input in a future update; for now they are server-side only (AI can execute them).

### Collision Resolution

```
1. closingSpeed = if head-on: speedA + speedB; if same-dir: |speedA - speedB|
2. damage = floor(closingSpeed / 5) per facing involved
3. Internal component roll: d6 — 1-2 engine, 3-4 tire, 5 driver, 6 component
4. Ramplate modifier: attacker takes half damage (round down)
5. Roll on control table for both vehicles
```

---

## Testing Strategy

- **Unit tests** for all pure rule functions: `deriveStats()`, `resolveToHit()`, `resolveDamage()`, `isWeaponInArc()`, maneuver D-value classification, control table resolution
- **Integration tests** for the vehicle design API endpoint (constraint validation)
- **Existing e2e tests** must continue to pass throughout all phases — backward-compatibility defaults ensure this

---

## Implementation Order

1. **Phase 1:** Extend `ArmorLocation` type (add `TrailerSurface`) → add `surfaces` + `tireCount` to `BodyDef` → populate all body catalogs (cars, cycles, trike, truck, trailer) → populate power plant catalogs (electric + gas, car + cycle) → update `deriveStats()` (surface validation, HC category, tireCount, truck HC clamp) → design API endpoint → tests
2. **Phase 2:** Weapon catalog data → range band logic → ammo decrement → AI weapon selection
3. **Phase 3:** To-hit modifier table → damage pipeline → fire system → DamageState expansion
4. **Phase 4:** Movement state → maneuver classifier → control table → collision resolver

**Phase 1 dependency note:** The designer UI (VehicleDesignerScene) must be updated in Phase 1 to render only the surfaces returned by `body.surfaces`. Trailer 10-position UI can be a simple 2×5 grid placeholder — the data model must be correct but the visual polish can follow.
