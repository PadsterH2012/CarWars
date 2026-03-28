# Car Wars Compendium 2E Rules Implementation — Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the full Car Wars Compendium 2nd Edition ruleset for ground vehicles (cars and cycles) across four phased layers, each leaving the game in a playable state.

**Architecture:** Extend the existing server/shared/client TypeScript monorepo without breaking current gameplay. New fields carry sensible defaults so existing test vehicles continue to work throughout. Static rule catalogs live in `server/src/data/`; logic lives in `server/src/rules/`; shared types live in `packages/shared`.

**Tech Stack:** TypeScript, Node.js (server), Phaser (client), PostgreSQL (JSONB loadout column), `@carwars/shared` types package.

**Source material:** Car Wars Compendium 2nd Edition PDF at `/Volumes/Books/RPG Books/CarWars/pdfcoffee.com_car-wars-2e-compendium-sjg-7142-pdf-free.pdf`

---

## Scope

Ground vehicles only (cars and cycles). Four implementation phases:

1. **Vehicle Design System** — body types, chassis, suspension, power plant, tires, armor → derived stats
2. **Weapons Catalog** — ~17 priority weapons with correct stats, proper range bands, ammo tracking
3. **Enhanced Combat** — full to-hit modifier table, vehicular fire, per-component damage pipeline
4. **Movement Fidelity** — HC track, control table, full maneuver set, collision resolution

---

## Phase 1: Vehicle Design System

### Body Types

Nine car body types (static catalog in `server/src/data/bodies.ts`):

| Type | Price | Weight | Max Load | Spaces | Armor $/pt | Armor lbs/pt |
|------|-------|--------|----------|--------|-----------|--------------|
| subcompact | 300 | 1000 | 2300 | 7 | 11 | 5 |
| compact | 400 | 1300 | 3700 | 10 | 13 | 6 |
| mid_sized | 600 | 1600 | 4800 | 13 | 16 | 8 |
| sedan | 700 | 1700 | 5100 | 16 | 18 | 9 |
| luxury | 800 | 1800 | 5500 | 19 | 20 | 10 |
| station_wagon | 800 | 1800 | 5500 | 14 | 20 | 10 |
| pickup | 900 | 2100 | 6500 | 13 | 22 | 11 |
| camper | 1400 | 2300 | 6500 | 17 | 30 | 14 |
| van | 1000 | 2000 | 6000 | 24 | 30 | 14 |

Cycle frames (static catalog in `server/src/data/cycles.ts`):

| Frame | Price | Weight | Max Load | Spaces | Armor $/pt | Armor lbs/pt |
|-------|-------|--------|----------|--------|-----------|--------------|
| light_cycle | 200 | 250 | 800 | 4 | 10 | 4 |
| med_cycle | 300 | 300 | 1100 | 5 | 11 | 5 |
| hvy_cycle | 400 | 350 | 1300 | 7 | 12 | 6 |

### Chassis Types

| Type | Weight Modifier | Price Modifier |
|------|----------------|----------------|
| light | -10% | -20% body cost |
| standard | none | none |
| heavy | +10% | +50% body cost |
| extra_heavy | +20% | +100% body cost |

### Suspension Types

| Type | Cost | Car HC | Van HC | Sub HC |
|------|------|--------|--------|--------|
| light | 0 | 1 | 0 | 2 |
| standard | 0 | 2 | 1 | 3 (implied) |
| improved | 100% body cost | 2 | 1 | 3 |
| heavy | 150% body cost | 3 | 2 | 4 |
| off_road | 500% body cost | 2 | 1 | 3 |

### Power Plants (Electric)

| Size | Cost | Weight | Spaces | DP | Power Factors |
|------|------|--------|--------|----|--------------|
| small | 500 | 500 | 3 | 5 | 800 |
| medium | 1000 | 700 | 4 | 8 | 1400 |
| large | 2000 | 900 | 5 | 10 | 2000 |
| super | 3000 | 1100 | 6 | 12 | 2600 |
| sport | 6000 | 1000 | 6 | 12 | 3000 |
| thundercat | 12000 | 2000 | 8 | 15 | 6700 |

Cycle power plants use separate table (smaller units, higher PF per weight).

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
1. Start with body base weight + frame weight
2. Apply chassis weight modifier
3. Power factors (PF) from power plant
4. Acceleration:
     PF < weight/3   → 0 (underpowered, won't move)
     PF < weight/2   → 5 mph/turn
     PF < weight     → 10 mph/turn
     PF ≥ weight     → 15 mph/turn
5. Top speed: 360 × PF / (PF + weight), rounded to 2.5 mph
6. HC: suspension base HC (adjusted for body size category)
7. HC modifiers: radial tires +1, racing slicks +2 (if all four corners)
8. Armor DP per facing from loadout distribution
9. Space check: sum of all component spaces ≤ body spaces
10. Weight check: sum of all component weights ≤ max load
```

### Backward Compatibility

Existing test vehicles omitting new fields default to:
- `bodyType: 'mid_sized'`
- `chassisType: 'standard'`
- `suspensionType: 'standard'`
- `powerPlant: { type: 'medium' }`
- `tireType: 'standard'`
- `armorType: 'ablative'`

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

1. Phase 1: Shared types → static catalogs → `deriveStats()` expansion → design API endpoint → tests
2. Phase 2: Weapon catalog data → range band logic → ammo decrement → AI weapon selection
3. Phase 3: To-hit modifier table → damage pipeline → fire system → DamageState expansion
4. Phase 4: Movement state → maneuver classifier → control table → collision resolver
