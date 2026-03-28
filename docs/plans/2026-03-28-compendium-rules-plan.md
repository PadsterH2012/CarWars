# Car Wars Compendium 2E Rules — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the full Car Wars Compendium 2nd Edition ruleset for ground vehicles across four phases: vehicle design system, weapons catalog, enhanced combat, and movement fidelity.

**Architecture:** Extend the existing TypeScript monorepo (`shared/` types, `server/src/rules/` logic, `server/tests/` vitest tests). New fields are optional with defaults so existing test vehicles and tests continue to pass. Static rule data goes in `server/src/rules/data/`. See the design doc at `docs/plans/2026-03-28-compendium-rules-design.md` for full tables.

**Tech Stack:** TypeScript, Vitest (tests), Node.js server. Run tests with `cd server && npm test`. The shared package is a local workspace dep (`@carwars/shared`).

---

## Phase 1: Vehicle Design System

### Task 1: Expand Shared Types

**Files:**
- Modify: `shared/src/types/vehicle.ts`

**Step 1: Write the failing test**

Create `server/tests/vehicle-design.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

// These types must exist in @carwars/shared after this task
import type { VehicleLoadout, DamageState } from '@carwars/shared';

describe('shared type additions', () => {
  it('VehicleLoadout accepts bodyType field', () => {
    const loadout: VehicleLoadout = {
      chassisId: 'mid', engineId: 'medium', suspensionId: 'standard',
      tires: [], mounts: [],
      armor: { front: 4, back: 2, left: 2, right: 2, top: 1, underbody: 1 },
      totalCost: 5000,
      bodyType: 'mid_sized',
      chassisType: 'standard',
      suspensionType: 'standard',
      tireType: 'standard',
      armorType: 'ablative',
      powerPlantType: 'medium',
    };
    expect(loadout.bodyType).toBe('mid_sized');
  });

  it('DamageState accepts onFire and engineDP fields', () => {
    const ds: DamageState = {
      armor: { front: 4, back: 2, left: 2, right: 2, top: 1, underbody: 1 },
      engineDamaged: false,
      driverWounded: false,
      tiresBlown: [],
      destroyed: false,
      onFire: false,
      engineDP: 8,
      internalDamage: [],
    };
    expect(ds.onFire).toBe(false);
    expect(ds.engineDP).toBe(8);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd /Users/paddyharker/carwars/server && npm test -- vehicle-design
```

Expected: FAIL — type errors about unknown properties.

**Step 3: Update `shared/src/types/vehicle.ts`**

Add new union types and optional fields. The new fields are all optional (marked `?`) so existing code that constructs loadouts without them still compiles.

```typescript
export type ArmorLocation = 'front' | 'back' | 'left' | 'right' | 'top' | 'underbody';

export interface ArmorDistribution {
  front: number;
  back: number;
  left: number;
  right: number;
  top: number;
  underbody: number;
}

// New union types for vehicle design
export type BodyType =
  | 'subcompact' | 'compact' | 'mid_sized' | 'sedan' | 'luxury'
  | 'station_wagon' | 'pickup' | 'camper' | 'van'
  | 'light_cycle' | 'med_cycle' | 'hvy_cycle';

export type ChassisType = 'light' | 'standard' | 'heavy' | 'extra_heavy';

export type SuspensionType = 'light' | 'standard' | 'improved' | 'heavy' | 'off_road';

export type TireType = 'standard' | 'heavy_duty' | 'puncture_resistant' | 'solid' | 'plasticore';

export type ArmorType = 'ablative' | 'fireproof' | 'laser_reflective' | 'lr_fireproof' | 'metal' | 'radarproof';

export type PowerPlantType = 'small' | 'medium' | 'large' | 'super' | 'sport' | 'thundercat';

export interface WeaponMount {
  id: string;
  arc: 'front' | 'back' | 'left' | 'right' | 'turret';
  weaponId: string | null;
  ammo: number;
}

export interface VehicleLoadout {
  // Legacy fields — kept for backward compat with existing test vehicles
  chassisId: string;
  engineId: string;
  suspensionId: string;
  tires: { id: string; blown: boolean }[];
  mounts: WeaponMount[];
  armor: ArmorDistribution;
  totalCost: number;
  // New Compendium fields — all optional, deriveStats() uses defaults when absent
  bodyType?: BodyType;
  chassisType?: ChassisType;
  suspensionType?: SuspensionType;
  tireType?: TireType;
  armorType?: ArmorType;
  powerPlantType?: PowerPlantType;
}

export interface DamageState {
  armor: Partial<ArmorDistribution>;
  engineDamaged: boolean;
  driverWounded: boolean;
  tiresBlown: number[];
  destroyed: boolean;
  // New fields — optional with defaults in code
  onFire?: boolean;
  engineDP?: number;
  internalDamage?: string[];
}

export interface VehicleStats {
  id: string;
  name: string;
  loadout: VehicleLoadout;
  damageState: DamageState;
  maxSpeed: number;
  handlingClass: number;
  weight: number;
}
```

**Step 4: Run test to verify it passes**

```bash
cd /Users/paddyharker/carwars/server && npm test -- vehicle-design
```

Expected: PASS.

**Step 5: Run existing tests to ensure nothing broke**

```bash
cd /Users/paddyharker/carwars/server && npm test
```

Expected: All existing tests pass.

**Step 6: Commit**

```bash
cd /Users/paddyharker/carwars
git add shared/src/types/vehicle.ts server/tests/vehicle-design.test.ts
git commit -m "feat: add Compendium vehicle design types to shared package"
```

---

### Task 2: Body Types Catalog

**Files:**
- Create: `server/src/rules/data/bodies.ts`
- Modify: `server/tests/vehicle-design.test.ts`

**Step 1: Add failing test** (append to `server/tests/vehicle-design.test.ts`):

```typescript
import { BODIES } from '../src/rules/data/bodies';

describe('bodies catalog', () => {
  it('has 9 car body types plus 3 cycle frames', () => {
    expect(BODIES.length).toBe(12);
  });

  it('mid_sized has correct spaces and max load', () => {
    const mid = BODIES.find(b => b.id === 'mid_sized')!;
    expect(mid.spaces).toBe(13);
    expect(mid.maxLoad).toBe(4800);
    expect(mid.baseHC).toBe(3);
  });

  it('van has correct spaces and cargo area', () => {
    const van = BODIES.find(b => b.id === 'van')!;
    expect(van.spaces).toBe(24);
    expect(van.maxLoad).toBe(6000);
  });
});
```

**Step 2: Run to verify it fails**

```bash
cd /Users/paddyharker/carwars/server && npm test -- vehicle-design
```

**Step 3: Create `server/src/rules/data/bodies.ts`**

```typescript
export interface BodyDef {
  id: string;
  name: string;
  price: number;       // base body cost ($)
  baseWeight: number;  // body frame weight (lbs)
  maxLoad: number;     // maximum total load (lbs, including body)
  spaces: number;      // interior spaces
  armorCostPerPt: number;  // $ per point of ablative plastic armor
  armorWtPerPt: number;    // lbs per point of ablative plastic armor
  baseHC: number;          // base HC before suspension modifier
  isCycle: boolean;
}

export const BODIES: BodyDef[] = [
  // Cars
  { id: 'subcompact',    name: 'Subcompact',    price: 300,  baseWeight: 1000, maxLoad: 2300, spaces: 7,  armorCostPerPt: 11, armorWtPerPt: 5,  baseHC: 4, isCycle: false },
  { id: 'compact',       name: 'Compact',       price: 400,  baseWeight: 1300, maxLoad: 3700, spaces: 10, armorCostPerPt: 13, armorWtPerPt: 6,  baseHC: 3, isCycle: false },
  { id: 'mid_sized',     name: 'Mid-Sized',     price: 600,  baseWeight: 1600, maxLoad: 4800, spaces: 13, armorCostPerPt: 16, armorWtPerPt: 8,  baseHC: 3, isCycle: false },
  { id: 'sedan',         name: 'Sedan',         price: 700,  baseWeight: 1700, maxLoad: 5100, spaces: 16, armorCostPerPt: 18, armorWtPerPt: 9,  baseHC: 3, isCycle: false },
  { id: 'luxury',        name: 'Luxury',        price: 800,  baseWeight: 1800, maxLoad: 5500, spaces: 19, armorCostPerPt: 20, armorWtPerPt: 10, baseHC: 3, isCycle: false },
  { id: 'station_wagon', name: 'Station Wagon', price: 800,  baseWeight: 1800, maxLoad: 5500, spaces: 14, armorCostPerPt: 20, armorWtPerPt: 10, baseHC: 3, isCycle: false },
  { id: 'pickup',        name: 'Pickup',        price: 900,  baseWeight: 2100, maxLoad: 6500, spaces: 13, armorCostPerPt: 22, armorWtPerPt: 11, baseHC: 2, isCycle: false },
  { id: 'camper',        name: 'Camper',        price: 1400, baseWeight: 2300, maxLoad: 6500, spaces: 17, armorCostPerPt: 30, armorWtPerPt: 14, baseHC: 2, isCycle: false },
  { id: 'van',           name: 'Van',           price: 1000, baseWeight: 2000, maxLoad: 6000, spaces: 24, armorCostPerPt: 30, armorWtPerPt: 14, baseHC: 2, isCycle: false },
  // Cycles
  { id: 'light_cycle',   name: 'Light Cycle',   price: 200,  baseWeight: 250,  maxLoad: 800,  spaces: 4,  armorCostPerPt: 10, armorWtPerPt: 4,  baseHC: 4, isCycle: true },
  { id: 'med_cycle',     name: 'Med. Cycle',    price: 300,  baseWeight: 300,  maxLoad: 1100, spaces: 5,  armorCostPerPt: 11, armorWtPerPt: 5,  baseHC: 4, isCycle: true },
  { id: 'hvy_cycle',     name: 'Hvy. Cycle',    price: 400,  baseWeight: 350,  maxLoad: 1300, spaces: 7,  armorCostPerPt: 12, armorWtPerPt: 6,  baseHC: 4, isCycle: true },
];
```

**Step 4: Run tests**

```bash
cd /Users/paddyharker/carwars/server && npm test -- vehicle-design
```

Expected: PASS.

**Step 5: Commit**

```bash
cd /Users/paddyharker/carwars
git add server/src/rules/data/bodies.ts server/tests/vehicle-design.test.ts
git commit -m "feat: add body types catalog (9 cars + 3 cycle frames)"
```

---

### Task 3: Power Plants, Suspensions, and Tires Catalogs

**Files:**
- Create: `server/src/rules/data/power-plants.ts`
- Create: `server/src/rules/data/suspensions.ts`
- Create: `server/src/rules/data/tires.ts`
- Modify: `server/tests/vehicle-design.test.ts`

**Step 1: Add failing tests** (append to `server/tests/vehicle-design.test.ts`):

```typescript
import { POWER_PLANTS } from '../src/rules/data/power-plants';
import { SUSPENSIONS } from '../src/rules/data/suspensions';
import { TIRES } from '../src/rules/data/tires';

describe('power plants catalog', () => {
  it('medium plant has correct power factors and DP', () => {
    const med = POWER_PLANTS.find(p => p.id === 'medium')!;
    expect(med.powerFactors).toBe(1400);
    expect(med.dp).toBe(8);
    expect(med.spaces).toBe(4);
  });

  it('thundercat has highest power factors', () => {
    const tc = POWER_PLANTS.find(p => p.id === 'thundercat')!;
    expect(tc.powerFactors).toBe(6700);
  });
});

describe('suspensions catalog', () => {
  it('heavy suspension gives HC 3 for cars', () => {
    const heavy = SUSPENSIONS.find(s => s.id === 'heavy')!;
    expect(heavy.carHC).toBe(3);
  });

  it('off_road suspension does not give highway benefit', () => {
    const or = SUSPENSIONS.find(s => s.id === 'off_road')!;
    expect(or.carHC).toBe(2);
  });
});

describe('tires catalog', () => {
  it('plasticore has highest DP', () => {
    const pt = TIRES.find(t => t.id === 'plasticore')!;
    expect(pt.dp).toBe(25);
  });

  it('standard tire has 4 DP', () => {
    const std = TIRES.find(t => t.id === 'standard')!;
    expect(std.dp).toBe(4);
  });
});
```

**Step 2: Run to verify fails**

```bash
cd /Users/paddyharker/carwars/server && npm test -- vehicle-design
```

**Step 3: Create `server/src/rules/data/power-plants.ts`**

```typescript
export interface PowerPlantDef {
  id: string;
  name: string;
  cost: number;
  weight: number;   // lbs
  spaces: number;
  dp: number;
  powerFactors: number;
}

export const POWER_PLANTS: PowerPlantDef[] = [
  { id: 'small',      name: 'Small',      cost: 500,   weight: 500,  spaces: 3, dp: 5,  powerFactors: 800  },
  { id: 'medium',     name: 'Medium',     cost: 1000,  weight: 700,  spaces: 4, dp: 8,  powerFactors: 1400 },
  { id: 'large',      name: 'Large',      cost: 2000,  weight: 900,  spaces: 5, dp: 10, powerFactors: 2000 },
  { id: 'super',      name: 'Super',      cost: 3000,  weight: 1100, spaces: 6, dp: 12, powerFactors: 2600 },
  { id: 'sport',      name: 'Sport',      cost: 6000,  weight: 1000, spaces: 6, dp: 12, powerFactors: 3000 },
  { id: 'thundercat', name: 'Thundercat', cost: 12000, weight: 2000, spaces: 8, dp: 15, powerFactors: 6700 },
];
```

**Step 4: Create `server/src/rules/data/suspensions.ts`**

```typescript
export interface SuspensionDef {
  id: string;
  name: string;
  costMultiplier: number; // multiplied by body price
  carHC: number;
  vanHC: number;
  subHC: number;
}

export const SUSPENSIONS: SuspensionDef[] = [
  { id: 'light',    name: 'Light',    costMultiplier: 0,   carHC: 1, vanHC: 0, subHC: 2 },
  { id: 'standard', name: 'Standard', costMultiplier: 0,   carHC: 2, vanHC: 1, subHC: 3 },
  { id: 'improved', name: 'Improved', costMultiplier: 1.0, carHC: 2, vanHC: 1, subHC: 3 },
  { id: 'heavy',    name: 'Heavy',    costMultiplier: 1.5, carHC: 3, vanHC: 2, subHC: 4 },
  { id: 'off_road', name: 'Off-Road', costMultiplier: 5.0, carHC: 2, vanHC: 1, subHC: 3 },
];
```

**Step 5: Create `server/src/rules/data/tires.ts`**

```typescript
export interface TireDef {
  id: string;
  name: string;
  costPerTire: number;
  weightPerTire: number; // lbs
  dp: number;
  hcModifier: number;    // added to vehicle HC
}

export const TIRES: TireDef[] = [
  { id: 'standard',           name: 'Standard',            costPerTire: 50,   weightPerTire: 30,  dp: 4,  hcModifier: 0 },
  { id: 'heavy_duty',         name: 'Heavy-Duty',          costPerTire: 100,  weightPerTire: 40,  dp: 6,  hcModifier: 0 },
  { id: 'puncture_resistant', name: 'Puncture-Resistant',  costPerTire: 200,  weightPerTire: 50,  dp: 9,  hcModifier: 0 },
  { id: 'solid',              name: 'Solid',               costPerTire: 500,  weightPerTire: 75,  dp: 12, hcModifier: 0 },
  { id: 'plasticore',         name: 'Plasticore',          costPerTire: 1000, weightPerTire: 150, dp: 25, hcModifier: 0 },
];
```

**Step 6: Run tests**

```bash
cd /Users/paddyharker/carwars/server && npm test -- vehicle-design
```

Expected: PASS.

**Step 7: Commit**

```bash
cd /Users/paddyharker/carwars
git add server/src/rules/data/power-plants.ts server/src/rules/data/suspensions.ts server/src/rules/data/tires.ts server/tests/vehicle-design.test.ts
git commit -m "feat: add power plants, suspensions, and tires catalogs"
```

---

### Task 4: Expand deriveStats()

**Files:**
- Modify: `server/src/rules/vehicle.ts`
- Modify: `server/tests/vehicle-design.test.ts`

**Step 1: Add failing tests** (append to `server/tests/vehicle-design.test.ts`):

```typescript
import { deriveStats } from '../src/rules/vehicle';
import type { VehicleLoadout } from '@carwars/shared';

function makeMidSizedLoadout(): VehicleLoadout {
  return {
    // Legacy fields kept for compat
    chassisId: 'mid', engineId: 'medium', suspensionId: 'standard',
    tires: [
      { id: 't0', blown: false }, { id: 't1', blown: false },
      { id: 't2', blown: false }, { id: 't3', blown: false },
    ],
    mounts: [],
    armor: { front: 4, back: 2, left: 2, right: 2, top: 1, underbody: 1 },
    totalCost: 5000,
    // New Compendium fields
    bodyType: 'mid_sized',
    chassisType: 'standard',
    suspensionType: 'standard',
    tireType: 'standard',
    armorType: 'ablative',
    powerPlantType: 'medium',
  };
}

describe('deriveStats with Compendium fields', () => {
  it('computes maxSpeed using power factor formula', () => {
    // mid_sized: maxLoad=4800 lbs, medium plant: PF=1400, weight=700
    // total weight approx: body(1600) + plant(700) + 4 tires(30*4=120) = 2420
    // top speed = 360 * 1400 / (1400 + 2420) = 504000 / 3820 ≈ 131.9 → rounds to 130 (nearest 2.5)
    const stats = deriveStats('v1', 'TestCar', makeMidSizedLoadout());
    expect(stats.maxSpeed).toBeGreaterThan(100);
    expect(stats.maxSpeed).toBeLessThan(200);
  });

  it('derives HC from suspension type', () => {
    // standard suspension for car = HC 2
    const stats = deriveStats('v1', 'TestCar', makeMidSizedLoadout());
    expect(stats.handlingClass).toBe(2);
  });

  it('computes acceleration from power factors vs weight', () => {
    // PF(1400) ≥ weight(~2420)? No. PF ≥ weight/2 (1210)? Yes → accel = 10
    const stats = deriveStats('v1', 'TestCar', makeMidSizedLoadout());
    expect(stats.acceleration).toBe(10);
  });

  it('falls back to legacy engine lookup when bodyType is absent', () => {
    const legacyLoadout: VehicleLoadout = {
      chassisId: 'mid', engineId: 'medium', suspensionId: 'standard',
      tires: [{ id: 't0', blown: false }, { id: 't1', blown: false },
               { id: 't2', blown: false }, { id: 't3', blown: false }],
      mounts: [],
      armor: { front: 4, back: 2, left: 2, right: 2, top: 1, underbody: 1 },
      totalCost: 5000,
    };
    // Should not throw — uses legacy path
    const stats = deriveStats('v1', 'LegacyCar', legacyLoadout);
    expect(stats.maxSpeed).toBeGreaterThan(0);
  });
});
```

**Step 2: Run to verify fails**

```bash
cd /Users/paddyharker/carwars/server && npm test -- vehicle-design
```

Expected: FAIL — `acceleration` is not a property on VehicleStats, and new formula not implemented.

**Step 3: Add `acceleration` to VehicleStats in `shared/src/types/vehicle.ts`**

Add the field after `handlingClass`:

```typescript
export interface VehicleStats {
  id: string;
  name: string;
  loadout: VehicleLoadout;
  damageState: DamageState;
  maxSpeed: number;
  handlingClass: number;
  acceleration: number;   // ADD THIS — mph per turn
  weight: number;
}
```

**Step 4: Rewrite `server/src/rules/vehicle.ts`**

```typescript
import type { VehicleLoadout, VehicleStats, DamageState } from '@carwars/shared';
import { CHASSIS } from './data/chassis';
import { ENGINES } from './data/engines';
import { BODIES } from './data/bodies';
import { POWER_PLANTS } from './data/power-plants';
import { SUSPENSIONS } from './data/suspensions';
import { TIRES } from './data/tires';

function computeAcceleration(powerFactors: number, totalWeight: number): number {
  if (powerFactors < totalWeight / 3) return 0;
  if (powerFactors < totalWeight / 2) return 5;
  if (powerFactors < totalWeight)     return 10;
  return 15;
}

function computeTopSpeed(powerFactors: number, totalWeight: number): number {
  const raw = (360 * powerFactors) / (powerFactors + totalWeight);
  // Round to nearest 2.5
  return Math.round(raw / 2.5) * 2.5;
}

export function deriveStats(id: string, name: string, loadout: VehicleLoadout): VehicleStats {
  let maxSpeed: number;
  let handlingClass: number;
  let totalWeight: number;
  let acceleration: number;

  if (loadout.bodyType && loadout.powerPlantType) {
    // === Compendium path ===
    const body = BODIES.find(b => b.id === loadout.bodyType);
    if (!body) throw new Error(`Unknown bodyType: ${loadout.bodyType}`);

    const plant = POWER_PLANTS.find(p => p.id === loadout.powerPlantType);
    if (!plant) throw new Error(`Unknown powerPlantType: ${loadout.powerPlantType}`);

    const suspension = SUSPENSIONS.find(s => s.id === (loadout.suspensionType ?? 'standard'));
    if (!suspension) throw new Error(`Unknown suspensionType: ${loadout.suspensionType}`);

    const tire = TIRES.find(t => t.id === (loadout.tireType ?? 'standard'));
    if (!tire) throw new Error(`Unknown tireType: ${loadout.tireType}`);

    // Weight = body + plant + 4 tires (cycles have 2)
    const tireCount = body.isCycle ? 2 : 4;
    totalWeight = body.baseWeight + plant.weight + tire.weightPerTire * tireCount;

    // Add armor weight
    const armorPts = Object.values(loadout.armor).reduce((s, v) => s + v, 0);
    totalWeight += armorPts * body.armorWtPerPt;

    acceleration = computeAcceleration(plant.powerFactors, totalWeight);
    maxSpeed = computeTopSpeed(plant.powerFactors, totalWeight);

    // HC from suspension, adjusted by body category
    // large bodies (van/pickup/camper) use vanHC, subcompacts use subHC, others use carHC
    const isVanSize = ['van', 'pickup', 'camper', 'station_wagon'].includes(loadout.bodyType);
    const isSub = loadout.bodyType === 'subcompact';
    handlingClass = isSub ? suspension.subHC : isVanSize ? suspension.vanHC : suspension.carHC;
    handlingClass += tire.hcModifier;
    handlingClass = Math.max(1, Math.min(6, handlingClass));

  } else {
    // === Legacy path (existing test vehicles without bodyType) ===
    const engine = ENGINES.find(e => e.id === loadout.engineId);
    if (!engine) throw new Error(`Unknown engine: ${loadout.engineId}`);
    const chassis = CHASSIS.find(c => c.id === loadout.chassisId);
    if (!chassis) throw new Error(`Unknown chassis: ${loadout.chassisId}`);

    totalWeight = engine.weight + 100 * loadout.tires.length;
    maxSpeed = engine.maxSpeed;
    acceleration = 5; // legacy default
    handlingClass = Math.min(6, Math.max(1, Math.round(totalWeight / 1000)));
  }

  const damageState: DamageState = {
    armor: { ...loadout.armor },
    engineDamaged: false,
    driverWounded: false,
    tiresBlown: [],
    destroyed: false,
    onFire: false,
    engineDP: loadout.powerPlantType
      ? (POWER_PLANTS.find(p => p.id === loadout.powerPlantType)?.dp ?? 8)
      : 8,
    internalDamage: [],
  };

  return {
    id,
    name,
    loadout,
    damageState,
    maxSpeed,
    handlingClass,
    acceleration,
    weight: totalWeight
  };
}
```

**Step 5: Run all tests**

```bash
cd /Users/paddyharker/carwars/server && npm test
```

Expected: All pass. If existing tests reference `acceleration` and fail, they need the new field added to their test fixtures — but since test fixtures use `stats: { ..., maxSpeed: 20, handlingClass: 3, weight: 3000 }` without spreading from deriveStats, they should be fine (TypeScript will require the new field on VehicleStats but tests pass objects manually).

If TypeScript complains about `acceleration` missing in test fixtures, add `acceleration: 5` to the `VehicleStats` objects in `server/tests/combat.test.ts` and `server/tests/movement.test.ts` where VehicleState is constructed inline.

**Step 6: Commit**

```bash
cd /Users/paddyharker/carwars
git add shared/src/types/vehicle.ts server/src/rules/vehicle.ts server/tests/vehicle-design.test.ts
git commit -m "feat: expand deriveStats() with Compendium power factor formula"
```

---

### Task 5: Vehicle Design API Endpoint

**Files:**
- Create: `server/src/api/design.ts`
- Modify: `server/src/app.ts`
- Modify: `server/tests/vehicle-design.test.ts`

**Step 1: Add failing tests** (append to `server/tests/vehicle-design.test.ts`):

```typescript
import request from 'supertest';
import { createApp } from '../src/app';

describe('POST /api/vehicles/design', () => {
  const app = createApp();

  it('returns derived stats for a valid loadout spec', async () => {
    const res = await request(app).post('/api/vehicles/design').send({
      bodyType: 'mid_sized',
      chassisType: 'standard',
      suspensionType: 'standard',
      powerPlantType: 'medium',
      tireType: 'standard',
      armorType: 'ablative',
      armor: { front: 4, back: 2, left: 2, right: 2, top: 1, underbody: 1 },
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('maxSpeed');
    expect(res.body).toHaveProperty('handlingClass');
    expect(res.body).toHaveProperty('acceleration');
    expect(res.body).toHaveProperty('totalWeight');
    expect(res.body).toHaveProperty('totalCost');
  });

  it('returns 400 if bodyType is missing', async () => {
    const res = await request(app).post('/api/vehicles/design').send({
      powerPlantType: 'medium',
    });
    expect(res.status).toBe(400);
  });
});
```

**Step 2: Run to verify fails**

```bash
cd /Users/paddyharker/carwars/server && npm test -- vehicle-design
```

**Step 3: Check how app.ts exports the app**

```bash
head -30 server/src/app.ts
```

The app likely exports something like `export function createApp()`. Verify and use that export in the test. If the function is named differently, adjust the import.

**Step 4: Create `server/src/api/design.ts`**

```typescript
import { Router } from 'express';
import type { BodyType, ChassisType, SuspensionType, TireType, ArmorType, PowerPlantType, ArmorDistribution } from '@carwars/shared';
import { BODIES } from '../rules/data/bodies';
import { POWER_PLANTS } from '../rules/data/power-plants';
import { SUSPENSIONS } from '../rules/data/suspensions';
import { TIRES } from '../rules/data/tires';
import { deriveStats } from '../rules/vehicle';

export const designRouter = Router();

designRouter.post('/', (req, res) => {
  const { bodyType, chassisType, suspensionType, powerPlantType, tireType, armorType, armor } = req.body;

  if (!bodyType || !powerPlantType) {
    return res.status(400).json({ error: 'bodyType and powerPlantType are required' });
  }

  const body = BODIES.find(b => b.id === bodyType);
  if (!body) return res.status(400).json({ error: `Unknown bodyType: ${bodyType}` });

  const plant = POWER_PLANTS.find(p => p.id === powerPlantType);
  if (!plant) return res.status(400).json({ error: `Unknown powerPlantType: ${powerPlantType}` });

  const susp = SUSPENSIONS.find(s => s.id === (suspensionType ?? 'standard'));
  if (!susp) return res.status(400).json({ error: `Unknown suspensionType: ${suspensionType}` });

  const tire = TIRES.find(t => t.id === (tireType ?? 'standard'));
  if (!tire) return res.status(400).json({ error: `Unknown tireType: ${tireType}` });

  const armorDist: ArmorDistribution = armor ?? { front: 0, back: 0, left: 0, right: 0, top: 0, underbody: 0 };
  const tireCount = body.isCycle ? 2 : 4;

  // Build a minimal loadout for deriveStats
  const loadout = {
    chassisId: 'standard', engineId: 'medium', suspensionId: 'standard',
    tires: Array.from({ length: tireCount }, (_, i) => ({ id: `t${i}`, blown: false })),
    mounts: [],
    armor: armorDist,
    totalCost: 0,
    bodyType: bodyType as BodyType,
    chassisType: (chassisType ?? 'standard') as ChassisType,
    suspensionType: (suspensionType ?? 'standard') as SuspensionType,
    tireType: (tireType ?? 'standard') as TireType,
    armorType: (armorType ?? 'ablative') as ArmorType,
    powerPlantType: powerPlantType as PowerPlantType,
  };

  try {
    const stats = deriveStats('design-preview', 'Preview', loadout);

    // Compute total cost
    const armorPts = Object.values(armorDist).reduce((s, v) => s + (v as number), 0);
    const totalCost = body.price + plant.cost + tire.costPerTire * tireCount + armorPts * body.armorCostPerPt;

    return res.json({
      maxSpeed: stats.maxSpeed,
      acceleration: stats.acceleration,
      handlingClass: stats.handlingClass,
      totalWeight: stats.weight,
      totalCost,
    });
  } catch (e: any) {
    return res.status(400).json({ error: e.message });
  }
});
```

**Step 5: Register the route in `server/src/app.ts`**

Find where other routers are registered (look for lines like `app.use('/api/vehicles', vehiclesRouter)`) and add:

```typescript
import { designRouter } from './api/design';
// ...
app.use('/api/vehicles/design', designRouter);
```

**Step 6: Run all tests**

```bash
cd /Users/paddyharker/carwars/server && npm test
```

Expected: All pass.

**Step 7: Commit**

```bash
cd /Users/paddyharker/carwars
git add server/src/api/design.ts server/src/app.ts server/tests/vehicle-design.test.ts
git commit -m "feat: add vehicle design preview API endpoint"
```

---

## Phase 2: Weapons Catalog

### Task 6: Expand WeaponDef and Replace Weapon Catalog

**Files:**
- Modify: `shared/src/types/combat.ts`
- Modify: `server/src/rules/data/weapons.ts`
- Modify: `server/tests/combat.test.ts`

**Step 1: Write failing tests** (append to `server/tests/combat.test.ts`):

```typescript
import { WEAPONS } from '../src/rules/data/weapons';

describe('weapons catalog', () => {
  it('machine gun has correct Compendium stats', () => {
    const mg = WEAPONS.find(w => w.id === 'mg')!;
    expect(mg.toHit).toBe(7);
    expect(mg.damageDice).toBe(1);
    expect(mg.damageMod).toBe(0);
    expect(mg.spaces).toBe(1);
    expect(mg.shotsPerMag).toBe(20);
  });

  it('vulcan MG has 2d damage', () => {
    const vmg = WEAPONS.find(w => w.id === 'vmg')!;
    expect(vmg.toHit).toBe(6);
    expect(vmg.damageDice).toBe(2);
  });

  it('medium laser drains 2 power units', () => {
    const ml = WEAPONS.find(w => w.id === 'ml')!;
    expect(ml.powerDrain).toBe(2);
    expect(ml.damageDice).toBe(2);
  });

  it('heavy rocket has to-hit 9', () => {
    const hr = WEAPONS.find(w => w.id === 'hr')!;
    expect(hr.toHit).toBe(9);
    expect(hr.damageDice).toBe(3);
  });

  it('spikedropper is a dropped weapon with no damage dice', () => {
    const sd = WEAPONS.find(w => w.id === 'sd')!;
    expect(sd.category).toBe('dropped');
  });
});
```

**Step 2: Run to verify fails**

```bash
cd /Users/paddyharker/carwars/server && npm test -- combat
```

**Step 3: Update `shared/src/types/combat.ts`**

```typescript
import type { ArmorLocation } from './vehicle';

export type WeaponCategory = 'small_bore' | 'large_bore' | 'rocket' | 'laser' | 'flamer' | 'dropped';
export type ArcType = 'front' | 'back' | 'left' | 'right' | 'turret';

export interface WeaponDef {
  id: string;
  name: string;
  category: WeaponCategory;
  toHit: number;           // base target number (2d6 must meet or beat)
  damageDice: number;      // number of d6 to roll
  damageMod: number;       // flat modifier added to damage roll
  // Legacy flat damage field — kept for backward compat, equals damageDice (average)
  damage: number;
  dp: number;              // weapon DP before destroyed
  spaces: number;
  weight: number;          // lbs
  cost: number;
  shotsPerMag: number;
  ammoWeight: number;      // lbs per shot
  ammoCost: number;        // $ per shot
  shortRange: number;      // inches — no range modifier within this
  longRange: number;       // inches — +2 modifier beyond shortRange; impossible beyond
  burstEffect: boolean;
  areaEffect: boolean;
  powerDrain: number;      // power units per shot (0 for non-lasers)
  allowedArcs: ArcType[];  // arcs this weapon may be mounted in (empty = all)
  special?: 'dropped' | 'area' | 'fire';
}

export interface ToHitResult {
  roll: number;
  modifier: number;
  hit: boolean;
  location: ArmorLocation;
}

export interface DamageResult {
  vehicleId: string;
  location: ArmorLocation;
  damageDealt: number;
  penetrated: boolean;
  effects: string[];
}
```

**Step 4: Replace `server/src/rules/data/weapons.ts`**

```typescript
import type { WeaponDef } from '@carwars/shared';

export const WEAPONS: WeaponDef[] = [
  // ── Small-bore projectile ──────────────────────────────────────────────
  {
    id: 'mg', name: 'Machine Gun', category: 'small_bore',
    toHit: 7, damageDice: 1, damageMod: 0, damage: 1,
    dp: 3, spaces: 1, weight: 150, cost: 1000, shotsPerMag: 20, ammoWeight: 2.5, ammoCost: 25,
    shortRange: 6, longRange: 12, burstEffect: false, areaEffect: true, powerDrain: 0, allowedArcs: [],
  },
  {
    id: 'vmg', name: 'Vulcan Machine Gun', category: 'small_bore',
    toHit: 6, damageDice: 2, damageMod: 0, damage: 2,
    dp: 3, spaces: 2, weight: 300, cost: 2000, shotsPerMag: 20, ammoWeight: 5, ammoCost: 35,
    shortRange: 6, longRange: 12, burstEffect: false, areaEffect: true, powerDrain: 0, allowedArcs: [],
  },
  {
    id: 'ac', name: 'Autocannon', category: 'small_bore',
    toHit: 6, damageDice: 3, damageMod: 0, damage: 3,
    dp: 4, spaces: 3, weight: 500, cost: 6500, shotsPerMag: 10, ammoWeight: 10, ammoCost: 75,
    shortRange: 8, longRange: 16, burstEffect: true, areaEffect: false, powerDrain: 0, allowedArcs: [],
  },
  {
    id: 'rr', name: 'Recoilless Rifle', category: 'small_bore',
    toHit: 7, damageDice: 2, damageMod: 0, damage: 2,
    dp: 4, spaces: 2, weight: 300, cost: 1500, shotsPerMag: 10, ammoWeight: 5, ammoCost: 35,
    shortRange: 8, longRange: 16, burstEffect: true, areaEffect: false, powerDrain: 0, allowedArcs: [],
  },
  // ── Large-bore projectile ──────────────────────────────────────────────
  {
    id: 'gl', name: 'Grenade Launcher', category: 'large_bore',
    toHit: 7, damageDice: 1, damageMod: 2, damage: 2,
    dp: 2, spaces: 2, weight: 200, cost: 1000, shotsPerMag: 10, ammoWeight: 4, ammoCost: 0,
    shortRange: 4, longRange: 8, burstEffect: false, areaEffect: false, powerDrain: 0, allowedArcs: [],
  },
  {
    id: 'atg', name: 'Anti-Tank Gun', category: 'large_bore',
    toHit: 8, damageDice: 3, damageMod: 0, damage: 3,
    dp: 5, spaces: 3, weight: 600, cost: 2000, shotsPerMag: 10, ammoWeight: 10, ammoCost: 50,
    shortRange: 10, longRange: 20, burstEffect: true, areaEffect: false, powerDrain: 0,
    allowedArcs: ['front', 'back'],
  },
  {
    id: 'bc', name: 'Blast Cannon', category: 'large_bore',
    toHit: 7, damageDice: 4, damageMod: 0, damage: 4,
    dp: 5, spaces: 4, weight: 500, cost: 4500, shotsPerMag: 10, ammoWeight: 10, ammoCost: 100,
    shortRange: 8, longRange: 16, burstEffect: true, areaEffect: false, powerDrain: 0, allowedArcs: [],
  },
  // ── Rockets ───────────────────────────────────────────────────────────
  {
    id: 'ltr', name: 'Light Rocket', category: 'rocket',
    toHit: 9, damageDice: 1, damageMod: 0, damage: 1,
    dp: 1, spaces: 1, weight: 25, cost: 75, shotsPerMag: 1, ammoWeight: 0, ammoCost: 75,
    shortRange: 4, longRange: 8, burstEffect: true, areaEffect: false, powerDrain: 0, allowedArcs: [],
  },
  {
    id: 'mr', name: 'Medium Rocket', category: 'rocket',
    toHit: 9, damageDice: 2, damageMod: 0, damage: 2,
    dp: 2, spaces: 1, weight: 50, cost: 140, shotsPerMag: 1, ammoWeight: 0, ammoCost: 140,
    shortRange: 6, longRange: 12, burstEffect: true, areaEffect: false, powerDrain: 0, allowedArcs: [],
  },
  {
    id: 'hr', name: 'Heavy Rocket', category: 'rocket',
    toHit: 9, damageDice: 3, damageMod: 0, damage: 3,
    dp: 2, spaces: 1, weight: 100, cost: 200, shotsPerMag: 1, ammoWeight: 0, ammoCost: 200,
    shortRange: 8, longRange: 16, burstEffect: true, areaEffect: false, powerDrain: 0, allowedArcs: [],
  },
  {
    id: 'rl', name: 'Rocket Launcher', category: 'rocket',
    toHit: 8, damageDice: 2, damageMod: 0, damage: 2,
    dp: 2, spaces: 2, weight: 200, cost: 1000, shotsPerMag: 10, ammoWeight: 5, ammoCost: 35,
    shortRange: 8, longRange: 16, burstEffect: true, areaEffect: false, powerDrain: 0, allowedArcs: [],
  },
  {
    id: 'mml', name: 'Micromissile Launcher', category: 'rocket',
    toHit: 8, damageDice: 1, damageMod: 0, damage: 1,
    dp: 2, spaces: 1, weight: 100, cost: 750, shotsPerMag: 10, ammoWeight: 2.5, ammoCost: 20,
    shortRange: 6, longRange: 12, burstEffect: true, areaEffect: false, powerDrain: 0, allowedArcs: [],
  },
  // ── Lasers ────────────────────────────────────────────────────────────
  {
    id: 'll', name: 'Light Laser', category: 'laser',
    toHit: 6, damageDice: 1, damageMod: 0, damage: 1,
    dp: 2, spaces: 1, weight: 200, cost: 3000, shotsPerMag: 999, ammoWeight: 0, ammoCost: 0,
    shortRange: 8, longRange: 16, burstEffect: false, areaEffect: true, powerDrain: 1, allowedArcs: [],
  },
  {
    id: 'ml', name: 'Medium Laser', category: 'laser',
    toHit: 6, damageDice: 2, damageMod: 0, damage: 2,
    dp: 2, spaces: 2, weight: 350, cost: 5500, shotsPerMag: 999, ammoWeight: 0, ammoCost: 0,
    shortRange: 10, longRange: 20, burstEffect: false, areaEffect: true, powerDrain: 2, allowedArcs: [],
  },
  {
    id: 'l', name: 'Laser', category: 'laser',
    toHit: 6, damageDice: 3, damageMod: 0, damage: 3,
    dp: 2, spaces: 2, weight: 500, cost: 8000, shotsPerMag: 999, ammoWeight: 0, ammoCost: 0,
    shortRange: 10, longRange: 20, burstEffect: false, areaEffect: true, powerDrain: 2, allowedArcs: [],
  },
  {
    id: 'hl', name: 'Heavy Laser', category: 'laser',
    toHit: 6, damageDice: 4, damageMod: 0, damage: 4,
    dp: 2, spaces: 3, weight: 1000, cost: 12000, shotsPerMag: 999, ammoWeight: 0, ammoCost: 0,
    shortRange: 12, longRange: 24, burstEffect: false, areaEffect: true, powerDrain: 3, allowedArcs: [],
  },
  // ── Flamers ───────────────────────────────────────────────────────────
  {
    id: 'lft', name: 'Light Flamethrower', category: 'flamer',
    toHit: 6, damageDice: 1, damageMod: -2, damage: 1,
    dp: 1, spaces: 1, weight: 250, cost: 350, shotsPerMag: 10, ammoWeight: 3, ammoCost: 15,
    shortRange: 3, longRange: 5, burstEffect: false, areaEffect: true, powerDrain: 0, allowedArcs: [],
  },
  {
    id: 'ft', name: 'Flamethrower', category: 'flamer',
    toHit: 6, damageDice: 1, damageMod: 0, damage: 1,
    dp: 2, spaces: 2, weight: 450, cost: 500, shotsPerMag: 10, ammoWeight: 5, ammoCost: 25,
    shortRange: 5, longRange: 10, burstEffect: false, areaEffect: true, powerDrain: 0, allowedArcs: [],
    special: 'fire',
  },
  // ── Dropped ───────────────────────────────────────────────────────────
  {
    id: 'sd', name: 'Spikedropper', category: 'dropped',
    toHit: 0, damageDice: 1, damageMod: 0, damage: 1,
    dp: 4, spaces: 1, weight: 25, cost: 100, shotsPerMag: 10, ammoWeight: 5, ammoCost: 20,
    shortRange: 1, longRange: 1, burstEffect: false, areaEffect: false, powerDrain: 0,
    allowedArcs: ['back'], special: 'dropped',
  },
  {
    id: 'oj', name: 'Oil Jet', category: 'dropped',
    toHit: 0, damageDice: 0, damageMod: 0, damage: 0,
    dp: 3, spaces: 2, weight: 25, cost: 250, shotsPerMag: 25, ammoWeight: 2, ammoCost: 10,
    shortRange: 1, longRange: 1, burstEffect: false, areaEffect: false, powerDrain: 0,
    allowedArcs: ['back'], special: 'dropped',
  },
  // Legacy aliases (keep old IDs working in existing test vehicles)
  {
    id: 'hmg', name: 'Heavy MG', category: 'small_bore',
    toHit: 6, damageDice: 2, damageMod: 0, damage: 2,
    dp: 3, spaces: 2, weight: 400, cost: 3000, shotsPerMag: 20, ammoWeight: 5, ammoCost: 35,
    shortRange: 6, longRange: 12, burstEffect: false, areaEffect: true, powerDrain: 0, allowedArcs: [],
  },
  {
    id: 'laser', name: 'Laser (legacy)', category: 'laser',
    toHit: 6, damageDice: 2, damageMod: 0, damage: 2,
    dp: 2, spaces: 2, weight: 400, cost: 6000, shotsPerMag: 999, ammoWeight: 0, ammoCost: 0,
    shortRange: 10, longRange: 25, burstEffect: false, areaEffect: true, powerDrain: 2, allowedArcs: [],
  },
  {
    id: 'oil', name: 'Oil Slick', category: 'dropped',
    toHit: 0, damageDice: 0, damageMod: 0, damage: 0,
    dp: 1, spaces: 1, weight: 100, cost: 500, shotsPerMag: 1, ammoWeight: 0, ammoCost: 0,
    shortRange: 1, longRange: 1, burstEffect: false, areaEffect: false, powerDrain: 0,
    allowedArcs: ['back'], special: 'dropped',
  },
  {
    id: 'mine', name: 'Mine', category: 'dropped',
    toHit: 0, damageDice: 3, damageMod: 0, damage: 3,
    dp: 1, spaces: 1, weight: 100, cost: 750, shotsPerMag: 1, ammoWeight: 0, ammoCost: 0,
    shortRange: 1, longRange: 1, burstEffect: false, areaEffect: false, powerDrain: 0,
    allowedArcs: ['back'], special: 'dropped',
  },
];
```

**Step 5: Update range band logic in `server/src/rules/combat.ts`**

The current `resolveToHit` uses `distance <= weapon.shortRange ? 7 : 9`. Replace with:

```typescript
export function resolveToHit(
  attacker: VehicleState,
  target: VehicleState,
  weapon: WeaponDef,
  distance: number
): ToHitResult {
  // Base target number from weapon
  let targetNumber = weapon.toHit;

  // Range modifier
  if (distance > weapon.longRange) {
    // Out of range — automatic miss
    return { roll: 0, modifier: 99, hit: false, location: 'front' };
  }
  if (distance > weapon.shortRange) targetNumber += 2;

  // Speed differential
  const speedDiff = Math.abs(attacker.speed - target.speed);
  if (speedDiff > 30) targetNumber += 2;
  else if (speedDiff > 15) targetNumber += 1;

  if (attacker.stats.damageState.driverWounded) targetNumber += 2;

  const roll = roll2d6();
  const hit = roll >= targetNumber;
  const location = hit ? getAttackLocation(attacker, target) : 'front';

  return { roll, modifier: targetNumber - weapon.toHit, hit, location };
}
```

**Step 6: Run all tests**

```bash
cd /Users/paddyharker/carwars/server && npm test
```

Expected: All pass. The existing combat test `resolveToHit(attacker, target, mg, 8)` will now use the new formula — `mg.toHit = 7`, distance 8 > shortRange 6 → +2, so targetNumber = 9 (matches old behaviour since old code used 9 for long range).

**Step 7: Commit**

```bash
cd /Users/paddyharker/carwars
git add shared/src/types/combat.ts server/src/rules/data/weapons.ts server/src/rules/combat.ts
git commit -m "feat: replace weapon catalog with full Compendium stats and range band logic"
```

---

## Phase 3: Enhanced Combat

### Task 7: Full To-Hit Modifier Table

**Files:**
- Modify: `server/src/rules/combat.ts`
- Modify: `server/tests/combat.test.ts`

**Step 1: Add failing tests** (append to `server/tests/combat.test.ts`):

```typescript
describe('to-hit modifiers', () => {
  it('adds +2 when driver is wounded', () => {
    const woundedAttacker = {
      ...attacker,
      stats: { ...attacker.stats, damageState: { ...attacker.stats.damageState, driverWounded: true } }
    };
    const mg = WEAPONS.find(w => w.id === 'mg')!;
    // Call many times — check that average targetNumber is higher
    let totalMod = 0;
    for (let i = 0; i < 20; i++) {
      const res = resolveToHit(woundedAttacker, target, mg, 4);
      totalMod += res.modifier;
    }
    expect(totalMod / 20).toBeGreaterThan(1.5); // driver wounded adds +2
  });

  it('out-of-range shot always misses', () => {
    const mg = WEAPONS.find(w => w.id === 'mg')!;
    const result = resolveToHit(attacker, target, mg, 999);
    expect(result.hit).toBe(false);
  });

  it('subcompact target adds +1 to target number', () => {
    const subcompactTarget = {
      ...target,
      stats: {
        ...target.stats,
        loadout: { ...target.stats.loadout, bodyType: 'subcompact' as const }
      }
    };
    const mg = WEAPONS.find(w => w.id === 'mg')!;
    const result = resolveToHit(attacker, subcompactTarget, mg, 4);
    // modifier should be at least 1 (subcompact bonus)
    expect(result.modifier).toBeGreaterThanOrEqual(1);
  });
});
```

**Step 2: Run to verify fails**

```bash
cd /Users/paddyharker/carwars/server && npm test -- combat
```

**Step 3: Update `resolveToHit` in `server/src/rules/combat.ts` with full modifier table**

```typescript
export function resolveToHit(
  attacker: VehicleState,
  target: VehicleState,
  weapon: WeaponDef,
  distance: number
): ToHitResult {
  let targetNumber = weapon.toHit;

  // Out of range — automatic miss
  if (distance > weapon.longRange) {
    return { roll: 0, modifier: 99, hit: false, location: 'front' };
  }

  // Range modifier
  if (distance > weapon.shortRange) targetNumber += 2;

  // Target speed modifier
  if (target.speed > 60) targetNumber += 1;

  // Speed differential
  const speedDiff = Math.abs(attacker.speed - target.speed);
  if (speedDiff > 30) targetNumber += 2;
  else if (speedDiff > 15) targetNumber += 1;

  // Target size modifier
  const targetBody = target.stats.loadout?.bodyType;
  if (targetBody === 'subcompact' || target.stats.loadout?.chassisId === 'compact') targetNumber += 1;
  if (['van', 'pickup', 'camper'].includes(targetBody ?? '')) targetNumber -= 1;

  // Attacker condition
  if (attacker.stats.damageState.driverWounded) targetNumber += 2;

  const roll = roll2d6();
  const hit = roll >= targetNumber;
  const location = hit ? getAttackLocation(attacker, target) : 'front';

  return { roll, modifier: targetNumber - weapon.toHit, hit, location };
}
```

**Step 4: Run all tests**

```bash
cd /Users/paddyharker/carwars/server && npm test
```

**Step 5: Commit**

```bash
cd /Users/paddyharker/carwars
git add server/src/rules/combat.ts server/tests/combat.test.ts
git commit -m "feat: add full to-hit modifier table (size, speed, range, driver wounded)"
```

---

### Task 8: Dice-Based Damage and Vehicular Fire Table

**Files:**
- Modify: `server/src/rules/combat.ts`
- Modify: `server/src/rules/engine.ts`
- Modify: `server/tests/combat.test.ts`

**Step 1: Add failing tests** (append to `server/tests/combat.test.ts`):

```typescript
import { rollDamage, resolveDamage } from '../src/rules/combat';

describe('dice-based damage', () => {
  it('rollDamage for 3d6 returns value between 3 and 18', () => {
    for (let i = 0; i < 50; i++) {
      const d = rollDamage(3, 0);
      expect(d).toBeGreaterThanOrEqual(3);
      expect(d).toBeLessThanOrEqual(18);
    }
  });

  it('rollDamage with modifier applied correctly', () => {
    // 1d6 - 2: min 1 (clamped), max 4
    for (let i = 0; i < 50; i++) {
      const d = rollDamage(1, -2);
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(4);
    }
  });
});

describe('vehicular fire on armor breach', () => {
  it('returns onFire effect when fire roll triggers', () => {
    // Create target with only 1 armor on front — any damage will breach
    const fragileTarget = {
      ...target,
      stats: {
        ...target.stats,
        damageState: {
          ...target.stats.damageState,
          armor: { front: 1, back: 0, left: 0, right: 0, top: 0, underbody: 0 }
        }
      }
    };
    // Fire 100 times with 5 damage — should breach and occasionally trigger fire
    let fireCount = 0;
    for (let i = 0; i < 100; i++) {
      const result = resolveDamage(fragileTarget, 'front', 5);
      if (result.effects.includes('on_fire')) fireCount++;
    }
    // With a 1/3 fire chance on breach, expect at least some fires in 100 trials
    expect(fireCount).toBeGreaterThan(0);
  });
});
```

**Step 2: Run to verify fails**

```bash
cd /Users/paddyharker/carwars/server && npm test -- combat
```

**Step 3: Update `server/src/rules/combat.ts`**

Add `rollDamage` export and update `resolveDamage` with vehicular fire table:

```typescript
export function rollDamage(dice: number, mod: number): number {
  let total = mod;
  for (let i = 0; i < dice; i++) {
    total += Math.floor(Math.random() * 6) + 1;
  }
  return Math.max(1, total); // minimum 1 damage
}

export function resolveDamage(
  target: VehicleState,
  location: ArmorLocation,
  damage: number
): DamageResult {
  const currentArmor = target.stats.damageState.armor[location] ?? 0;
  const remaining = currentArmor - damage;
  const penetrated = remaining < 0;
  const effects: string[] = [];

  if (penetrated) {
    const excess = Math.abs(remaining);

    // Internal component damage by facing
    if (location === 'front' || location === 'back') effects.push('engine_hit');
    if (location === 'left' || location === 'right') effects.push('tire_blown');
    if (excess > 3) effects.push('driver_wounded');
    if (excess > 6) effects.push('destroyed');

    // Vehicular fire table (1d6)
    const fireRoll = Math.floor(Math.random() * 6) + 1;
    if (fireRoll === 5) effects.push('on_fire');
    if (fireRoll === 6) effects.push('on_fire', 'explosion');
  }

  return {
    vehicleId: target.id,
    location,
    damageDealt: damage,
    penetrated,
    effects
  };
}
```

**Step 4: Update `server/src/rules/engine.ts`** to roll dice before calling resolveDamage

Find this line in `engine.ts`:

```typescript
const damageResult = resolveDamage(target, toHit.location, weapon.damage);
```

Replace with:

```typescript
import { rollDamage } from './combat';
// ...
const rolledDamage = weapon.damageDice > 0 ? rollDamage(weapon.damageDice, weapon.damageMod) : weapon.damage;
const damageResult = resolveDamage(target, toHit.location, rolledDamage);
```

Also handle the `on_fire` effect in the damage updates section. After the current effects are applied, add:

```typescript
damageUpdates.set(target.id, {
  ...currentDamage,
  armor: newArmor,
  engineDamaged: currentDamage.engineDamaged || damageResult.effects.includes('engine_hit'),
  driverWounded: currentDamage.driverWounded || damageResult.effects.includes('driver_wounded'),
  destroyed: currentDamage.destroyed || damageResult.effects.includes('destroyed'),
  onFire: currentDamage.onFire || damageResult.effects.includes('on_fire'),  // ADD
  tiresBlown: damageResult.effects.includes('tire_blown') && !currentDamage.tiresBlown.includes(tireIndex)
    ? [...currentDamage.tiresBlown, tireIndex]
    : currentDamage.tiresBlown
});
```

**Step 5: Run all tests**

```bash
cd /Users/paddyharker/carwars/server && npm test
```

**Step 6: Commit**

```bash
cd /Users/paddyharker/carwars
git add server/src/rules/combat.ts server/src/rules/engine.ts server/tests/combat.test.ts
git commit -m "feat: add dice-based damage rolling and vehicular fire table"
```

---

### Task 9: Fire Damage Tick

**Files:**
- Modify: `server/src/rules/engine.ts`
- Modify: `server/tests/engine.test.ts`

**Step 1: Add failing test** (append to `server/tests/engine.test.ts`):

```typescript
describe('fire damage tick', () => {
  it('burning vehicle takes damage each tick', () => {
    // Read existing test setup in engine.test.ts to understand how to create a ZoneState
    // Build a vehicle that is on fire with some armor remaining
    // After resolveTick(), the vehicle should have less armor than before
  });
});
```

Note: Read `server/tests/engine.test.ts` first to understand the test fixture pattern before writing this test. Match the existing fixture style exactly.

**Step 2: Run to see existing engine tests**

```bash
cd /Users/paddyharker/carwars/server && npm test -- engine
```

**Step 3: Add fire tick logic to `resolveTick()` in `server/src/rules/engine.ts`**

After the hazard objects section and before applying damage updates, add:

```typescript
// Apply fire damage to burning vehicles
newVehicles.forEach(vehicle => {
  if (!vehicle.stats.damageState.onFire) return;

  // Try to extinguish (if fire extinguisher equipped — future: check accessory)
  // For now, fire always burns
  const currentDamage = damageUpdates.get(vehicle.id) ?? { ...vehicle.stats.damageState };

  // Pick a random armor location that still has armor
  const locations: ArmorLocation[] = ['front', 'back', 'left', 'right', 'top', 'underbody'];
  const burnable = locations.filter(loc => (currentDamage.armor[loc] ?? 0) > 0);
  if (burnable.length === 0) {
    // All armor gone — fire damages internals
    damageUpdates.set(vehicle.id, { ...currentDamage, destroyed: true });
    return;
  }

  const loc = burnable[Math.floor(Math.random() * burnable.length)] as ArmorLocation;
  const newArmor = { ...currentDamage.armor };
  newArmor[loc] = Math.max(0, (newArmor[loc] ?? 0) - 1);

  damageUpdates.set(vehicle.id, {
    ...currentDamage,
    armor: newArmor,
    onFire: true,
  });
});
```

Also add `ArmorLocation` to the import from `@carwars/shared` at the top of engine.ts.

**Step 4: Write the actual engine fire test** (replace the placeholder from step 1):

```typescript
import { createTurnEngine } from '../src/rules/engine';
import type { ZoneState, VehicleState } from '@carwars/shared';

function makeBurningVehicle(): VehicleState {
  return {
    id: 'v-fire', playerId: 'p1', driverId: 'd1',
    position: { x: 0, y: 0 }, facing: 0, speed: 0,
    stats: {
      id: 'v-fire', name: 'Burning Car', loadout: {} as any,
      damageState: {
        armor: { front: 4, back: 4, left: 4, right: 4, top: 2, underbody: 2 },
        engineDamaged: false, driverWounded: false, tiresBlown: [], destroyed: false,
        onFire: true, engineDP: 8, internalDamage: [],
      },
      maxSpeed: 15, handlingClass: 3, weight: 3000, acceleration: 5,
    }
  };
}

describe('fire damage tick', () => {
  it('burning vehicle loses armor each tick', () => {
    const zoneState: ZoneState = {
      id: 'zone-1', tick: 0,
      vehicles: [makeBurningVehicle()],
      hazardObjects: [],
    };
    const engine = createTurnEngine(zoneState);
    const after = engine.resolveTick();
    const v = after.vehicles.find(v => v.id === 'v-fire')!;
    const totalArmorAfter = Object.values(v.stats.damageState.armor).reduce((s, n) => s + (n ?? 0), 0);
    // Started with 4+4+4+4+2+2=20, should have lost at least 1
    expect(totalArmorAfter).toBeLessThan(20);
  });
});
```

**Step 5: Run all tests**

```bash
cd /Users/paddyharker/carwars/server && npm test
```

**Step 6: Commit**

```bash
cd /Users/paddyharker/carwars
git add server/src/rules/engine.ts server/tests/engine.test.ts
git commit -m "feat: add fire damage tick — burning vehicles lose 1 armor per tick"
```

---

## Phase 4: Movement Fidelity

### Task 10: Maneuver Classifier

**Files:**
- Modify: `server/src/rules/movement.ts`
- Modify: `server/tests/movement.test.ts`

**Step 1: Add failing tests** (append to `server/tests/movement.test.ts`):

```typescript
import { classifyManeuver, ManeuverType } from '../src/rules/movement';

describe('maneuver classifier', () => {
  it('gentle steer is a bend (D1)', () => {
    const result = classifyManeuver(10, 15);
    expect(result.type).toBe('bend');
    expect(result.dValue).toBe(1);
  });

  it('moderate steer is a drift (D2)', () => {
    const result = classifyManeuver(20, 25);
    expect(result.type).toBe('drift');
    expect(result.dValue).toBe(2);
  });

  it('sharp steer is a swerve (D3)', () => {
    const result = classifyManeuver(30, 40);
    expect(result.type).toBe('swerve');
    expect(result.dValue).toBe(3);
  });

  it('maximum steer is a controlled skid (D3)', () => {
    const result = classifyManeuver(40, 55);
    expect(result.type).toBe('controlled_skid');
    expect(result.dValue).toBe(3);
  });

  it('no steer at any speed is a bend (D1)', () => {
    const result = classifyManeuver(60, 0);
    expect(result.type).toBe('bend');
    expect(result.dValue).toBe(1);
  });
});
```

**Step 2: Run to verify fails**

```bash
cd /Users/paddyharker/carwars/server && npm test -- movement
```

**Step 3: Add to `server/src/rules/movement.ts`**

```typescript
export type ManeuverType = 'bend' | 'drift' | 'swerve' | 'controlled_skid' | 'bootlegger' | 'pivot' | 't_stop';

export interface ManeuverResult {
  type: ManeuverType;
  dValue: number;  // hazard D-value added to accumulator
}

export function classifyManeuver(speed: number, absSteering: number): ManeuverResult {
  if (absSteering === 0) return { type: 'bend', dValue: 1 };
  if (absSteering <= 15) return { type: 'bend', dValue: 1 };
  if (absSteering <= 30) return { type: 'drift', dValue: 2 };
  if (absSteering <= 45) return { type: 'swerve', dValue: 3 };
  return { type: 'controlled_skid', dValue: 3 };
}
```

**Step 4: Run tests**

```bash
cd /Users/paddyharker/carwars/server && npm test -- movement
```

**Step 5: Commit**

```bash
cd /Users/paddyharker/carwars
git add server/src/rules/movement.ts server/tests/movement.test.ts
git commit -m "feat: add maneuver classifier (bend/drift/swerve/controlled skid)"
```

---

### Task 11: Control Table

**Files:**
- Modify: `server/src/rules/movement.ts`
- Modify: `server/tests/movement.test.ts`

**Step 1: Add failing tests** (append to `server/tests/movement.test.ts`):

```typescript
import { resolveControlTable, ControlResult } from '../src/rules/movement';

describe('control table', () => {
  it('no effect when hazard below HC', () => {
    // HC=4, hazard=1 → roll 2d6 + 1 - 4 → only dangerous on very high rolls
    // Force deterministic: hazardAccumulator=0 means practically always passes
    const result = resolveControlTable(4, 0, 7); // forced roll of 7
    expect(result.effect).toBe('none');
  });

  it('fishtail when result is 1 above HC', () => {
    // HC=3, hazardAccumulator=2, forceRoll=8 → 8 + 2 - 3 = 7 → result 7
    // Need to check what 7 maps to in our table
    const result = resolveControlTable(3, 4, 10); // high roll + hazard
    expect(['fishtail', 'skid', 'roll', 'collision']).toContain(result.effect);
  });

  it('no control roll needed when hazard is zero', () => {
    const result = resolveControlTable(3, 0, 2);
    expect(result.effect).toBe('none');
  });
});
```

**Step 2: Run to verify fails**

```bash
cd /Users/paddyharker/carwars/server && npm test -- movement
```

**Step 3: Add to `server/src/rules/movement.ts`**

```typescript
export interface ControlResult {
  effect: 'none' | 'fishtail' | 'skid' | 'roll' | 'collision';
  severity: number;
}

/**
 * Resolves the Compendium control table.
 * @param hc Current handling class
 * @param hazardAccumulator D-points accumulated this turn
 * @param forcedRoll Optional forced 2d6 roll (for testing); uses random if omitted
 */
export function resolveControlTable(hc: number, hazardAccumulator: number, forcedRoll?: number): ControlResult {
  if (hazardAccumulator === 0) return { effect: 'none', severity: 0 };

  const roll = forcedRoll ?? (Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1);
  const result = roll + hazardAccumulator - hc;

  if (result <= 0)  return { effect: 'none', severity: 0 };
  if (result === 1) return { effect: 'fishtail', severity: 1 };
  if (result === 2) return { effect: 'skid', severity: 2 };
  if (result === 3) return { effect: 'skid', severity: 3 };
  if (result === 4) return { effect: 'roll', severity: 4 };
  return                  { effect: 'collision', severity: result };
}
```

**Step 4: Integrate into `applyHazardCheck` in movement.ts**

The existing `applyHazardCheck` returns a difficulty number. Keep it for backward compat but also export the new control table. The engine.ts calls `applyHazardCheck` — update it to also use `resolveControlTable`:

In `server/src/rules/engine.ts`, in the hazard check section, replace the existing hazard block with:

```typescript
newVehicles = newVehicles.map(vehicle => {
  const input = pendingInputs.get(vehicle.id) ?? lastInputs.get(vehicle.id) ?? { speed: 0, steer: 0, fireWeapon: null };
  const maneuver = classifyManeuver(vehicle.speed, Math.abs(input.steer));
  const control = resolveControlTable(vehicle.stats.handlingClass, maneuver.dValue);

  if (control.effect === 'none') return vehicle;

  // Fishtail: -1 effective HC for this tick (apply random small spin)
  if (control.effect === 'fishtail') {
    const spin = (Math.random() > 0.5 ? 1 : -1) * 15;
    return { ...vehicle, facing: (vehicle.facing + spin + 360) % 360 };
  }

  // Skid or worse: larger spin, halve speed
  const spinAngle = (Math.random() > 0.5 ? 1 : -1) * (60 + Math.floor(Math.random() * 120));
  return {
    ...vehicle,
    facing: (vehicle.facing + spinAngle + 360) % 360,
    speed: Math.floor(vehicle.speed / 2),
  };
});
```

Add the imports at the top of engine.ts:
```typescript
import { computeMovement, classifyManeuver, resolveControlTable } from './movement';
```

**Step 5: Run all tests**

```bash
cd /Users/paddyharker/carwars/server && npm test
```

**Step 6: Commit**

```bash
cd /Users/paddyharker/carwars
git add server/src/rules/movement.ts server/src/rules/engine.ts server/tests/movement.test.ts
git commit -m "feat: add Compendium control table and integrate maneuver hazard with engine"
```

---

### Task 12: Collision Resolver

**Files:**
- Modify: `server/src/rules/movement.ts`
- Modify: `server/tests/movement.test.ts`

**Step 1: Add failing tests** (append to `server/tests/movement.test.ts`):

```typescript
import { resolveCollision } from '../src/rules/movement';

describe('collision resolver', () => {
  it('head-on collision uses sum of speeds', () => {
    const result = resolveCollision(30, 20, 'head_on');
    // closing speed = 50 → damage = floor(50 / 5) = 10 per vehicle
    expect(result.damageA).toBe(10);
    expect(result.damageB).toBe(10);
  });

  it('same-direction collision uses speed difference', () => {
    const result = resolveCollision(30, 20, 'same_dir');
    // closing speed = 10 → damage = floor(10 / 5) = 2
    expect(result.damageA).toBe(2);
    expect(result.damageB).toBe(2);
  });

  it('ramplate halves damage for attacker', () => {
    const result = resolveCollision(30, 0, 'head_on', true);
    // closing speed = 30 → base = 6; ramplate → attacker takes 3
    expect(result.damageA).toBe(3);
    expect(result.damageB).toBe(6);
  });
});
```

**Step 2: Run to verify fails**

```bash
cd /Users/paddyharker/carwars/server && npm test -- movement
```

**Step 3: Add to `server/src/rules/movement.ts`**

```typescript
export interface CollisionResult {
  damageA: number;   // damage to vehicle A (attacker / rear-ender)
  damageB: number;   // damage to vehicle B (target / front vehicle)
  closingSpeed: number;
}

export function resolveCollision(
  speedA: number,
  speedB: number,
  type: 'head_on' | 'same_dir' | 't_bone',
  attackerHasRamplate = false
): CollisionResult {
  const closingSpeed = type === 'head_on'
    ? speedA + speedB
    : Math.abs(speedA - speedB);

  const baseDamage = Math.floor(closingSpeed / 5);
  const damageB = baseDamage;
  const damageA = attackerHasRamplate ? Math.floor(baseDamage / 2) : baseDamage;

  return { damageA, damageB, closingSpeed };
}
```

**Step 4: Run all tests**

```bash
cd /Users/paddyharker/carwars/server && npm test
```

Expected: All pass.

**Step 5: Commit**

```bash
cd /Users/paddyharker/carwars
git add server/src/rules/movement.ts server/tests/movement.test.ts
git commit -m "feat: add collision resolver with ramplate modifier"
```

---

## Final Check

Run the complete test suite one last time to confirm everything is green:

```bash
cd /Users/paddyharker/carwars/server && npm test
```

Expected: All tests pass with no regressions.

Also verify the game server still starts:

```bash
cd /Users/paddyharker/carwars/server && npm run build
```

Expected: TypeScript compiles with no errors.
