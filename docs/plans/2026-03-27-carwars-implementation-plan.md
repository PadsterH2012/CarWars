# Car Wars Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a faithful browser-based Car Wars game with seamless open world, campaign progression, garage management, and online multiplayer.

**Architecture:** Authoritative Node.js server runs all game logic (rules engine, zone simulations, AI); Phaser.js client renders and sends inputs only. PostgreSQL stores campaign state. Shared TypeScript types live in a `/shared` package used by both client and server.

**Tech Stack:** Phaser.js, TypeScript, Vite (client), Node.js + ws (server), PostgreSQL + node-postgres, Vitest (unit tests), Playwright (e2e)

---

## Phase Overview

This plan is split into four phases. Complete Phase 1 before starting Phase 2.

| Phase | Focus | Tasks |
|-------|-------|-------|
| 1 | Foundation: scaffold, rules engine, basic arena | 1–10 |
| 2 | World & Campaign: garage, economy, zones | 11–17 |
| 3 | Open World: highways, NPCs, encounters | 18–22 |
| 4 | Multiplayer: online play, PvP, gang events | 23–27 |

---

# Phase 1: Foundation

---

### Task 1: Project Scaffold

**Files:**
- Create: `package.json` (root workspace)
- Create: `client/package.json`
- Create: `client/vite.config.ts`
- Create: `client/index.html`
- Create: `client/src/main.ts`
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/src/main.ts`
- Create: `shared/package.json`
- Create: `shared/src/index.ts`

**Step 1: Create root workspace**

```bash
cd /Users/paddyharker/carwars
cat > package.json << 'EOF'
{
  "name": "carwars",
  "private": true,
  "workspaces": ["client", "server", "shared"]
}
EOF
```

**Step 2: Create shared package**

```bash
mkdir -p shared/src
cat > shared/package.json << 'EOF'
{
  "name": "@carwars/shared",
  "version": "0.1.0",
  "main": "src/index.ts",
  "scripts": {}
}
EOF
```

```bash
cat > shared/src/index.ts << 'EOF'
// Shared types placeholder — expanded in Task 3
export type PlayerId = string;
export type VehicleId = string;
export type ZoneId = string;
EOF
```

**Step 3: Create client**

```bash
mkdir -p client/src/scenes client/src/ui client/src/game
cat > client/package.json << 'EOF'
{
  "name": "@carwars/client",
  "version": "0.1.0",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "test": "vitest"
  },
  "dependencies": {
    "@carwars/shared": "*",
    "phaser": "^3.80.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vite": "^5.2.0",
    "vitest": "^1.4.0"
  }
}
EOF
```

```typescript
// client/vite.config.ts
import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 3000 },
  build: { target: 'es2020' }
});
```

```html
<!-- client/index.html -->
<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"><title>Car Wars</title></head>
  <body>
    <div id="game"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

```typescript
// client/src/main.ts
import Phaser from 'phaser';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 1280,
  height: 720,
  parent: 'game',
  backgroundColor: '#1a1a2e',
  scene: []
};

new Phaser.Game(config);
```

**Step 4: Create server**

```bash
mkdir -p server/src/rules server/src/world server/src/campaign server/src/ai server/src/db server/src/ws server/tests
cat > server/package.json << 'EOF'
{
  "name": "@carwars/server",
  "version": "0.1.0",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@carwars/shared": "*",
    "ws": "^8.17.0",
    "pg": "^8.11.0",
    "express": "^4.19.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.0",
    "@types/pg": "^8.11.0",
    "@types/express": "^4.17.0",
    "tsx": "^4.7.0",
    "typescript": "^5.4.0",
    "vitest": "^1.4.0"
  }
}
EOF
```

```typescript
// server/src/main.ts
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.get('/health', (_req, res) => res.json({ ok: true }));

wss.on('connection', (ws) => {
  console.log('Client connected');
  ws.on('message', (data) => console.log('Message:', data.toString()));
});

server.listen(3001, () => console.log('Server running on :3001'));
```

**Step 5: Install dependencies**

```bash
cd /Users/paddyharker/carwars
npm install
```

Expected: Dependencies installed across all workspaces.

**Step 6: Verify server starts**

```bash
cd server && npx tsx src/main.ts &
curl http://localhost:3001/health
```

Expected: `{"ok":true}`

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: scaffold monorepo with client (Phaser/Vite), server (Node/ws), shared types"
```

---

### Task 2: PostgreSQL Schema

**Files:**
- Create: `server/src/db/schema.sql`
- Create: `server/src/db/client.ts`
- Create: `server/src/db/migrate.ts`
- Test: `server/tests/db.test.ts`

**Step 1: Write schema**

```sql
-- server/src/db/schema.sql
CREATE TABLE IF NOT EXISTS players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  money INTEGER NOT NULL DEFAULT 25000,
  division INTEGER NOT NULL DEFAULT 5,
  reputation INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID REFERENCES players(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  loadout JSONB NOT NULL,
  damage_state JSONB NOT NULL DEFAULT '{}',
  value INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS drivers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID REFERENCES players(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  skill INTEGER NOT NULL DEFAULT 3,
  aggression INTEGER NOT NULL DEFAULT 3,
  loyalty INTEGER NOT NULL DEFAULT 5,
  xp INTEGER NOT NULL DEFAULT 0,
  assigned_vehicle_id UUID REFERENCES vehicles(id) ON DELETE SET NULL,
  alive BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS event_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID REFERENCES players(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  result JSONB NOT NULL,
  money_delta INTEGER NOT NULL DEFAULT 0,
  occurred_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Step 2: Write failing test**

```typescript
// server/tests/db.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDb, closeDb } from '../src/db/client';

describe('database', () => {
  beforeAll(async () => {
    const db = getDb();
    await db.query(`
      CREATE TABLE IF NOT EXISTS players (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        money INTEGER NOT NULL DEFAULT 25000,
        division INTEGER NOT NULL DEFAULT 5,
        reputation INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  });

  afterAll(closeDb);

  it('inserts and retrieves a player', async () => {
    const db = getDb();
    const res = await db.query(
      `INSERT INTO players (username, password_hash) VALUES ($1, $2) RETURNING id, username, money`,
      ['testdriver', 'hash']
    );
    expect(res.rows[0].username).toBe('testdriver');
    expect(res.rows[0].money).toBe(25000);
    await db.query('DELETE FROM players WHERE username = $1', ['testdriver']);
  });
});
```

**Step 3: Run test to verify it fails**

```bash
cd server && npx vitest run tests/db.test.ts
```

Expected: FAIL — `getDb` not defined.

**Step 4: Implement db client**

```typescript
// server/src/db/client.ts
import { Pool } from 'pg';

let pool: Pool | null = null;

export function getDb(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL ?? 'postgresql://localhost/carwars'
    });
  }
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
```

**Step 5: Run test to verify it passes**

```bash
cd server && npx vitest run tests/db.test.ts
```

Expected: PASS (requires a local PostgreSQL `carwars` database to exist)

> Note: Create the database first: `createdb carwars`

**Step 6: Write migration runner**

```typescript
// server/src/db/migrate.ts
import { readFileSync } from 'fs';
import { join } from 'path';
import { getDb, closeDb } from './client';

async function migrate() {
  const db = getDb();
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  await db.query(sql);
  console.log('Migration complete');
  await closeDb();
}

migrate().catch(console.error);
```

**Step 7: Run migration**

```bash
cd server && npx tsx src/db/migrate.ts
```

Expected: `Migration complete`

**Step 8: Commit**

```bash
git add -A
git commit -m "feat: add PostgreSQL schema and db client"
```

---

### Task 3: Shared Type Definitions

**Files:**
- Modify: `shared/src/index.ts`
- Create: `shared/src/types/vehicle.ts`
- Create: `shared/src/types/combat.ts`
- Create: `shared/src/types/world.ts`
- Create: `shared/src/types/messages.ts`

**Step 1: Vehicle types**

```typescript
// shared/src/types/vehicle.ts

export type ArmorLocation = 'front' | 'back' | 'left' | 'right' | 'top' | 'underbody';

export interface ArmorDistribution {
  front: number;
  back: number;
  left: number;
  right: number;
  top: number;
  underbody: number;
}

export interface WeaponMount {
  id: string;
  arc: 'front' | 'back' | 'left' | 'right' | 'turret';
  weaponId: string | null;
  ammo: number;
}

export interface VehicleLoadout {
  chassisId: string;
  engineId: string;
  suspensionId: string;
  tires: { id: string; blown: boolean }[];
  mounts: WeaponMount[];
  armor: ArmorDistribution;
  totalCost: number;
}

export interface DamageState {
  armor: Partial<ArmorDistribution>;  // remaining armor per location
  engineDamaged: boolean;
  driverWounded: boolean;
  tiresBlown: number[];               // indices of blown tires
}

export interface VehicleStats {
  id: string;
  name: string;
  loadout: VehicleLoadout;
  damageState: DamageState;
  // Derived from loadout
  maxSpeed: number;       // inches per phase
  handlingClass: number;  // 1-6, higher = harder to control
  weight: number;
}
```

**Step 2: Combat types**

```typescript
// shared/src/types/combat.ts

export interface WeaponDef {
  id: string;
  name: string;
  damage: number;
  rof: number;           // rounds per phase
  shortRange: number;    // inches
  longRange: number;     // inches
  space: number;
  weight: number;
  cost: number;
  special?: 'dropped' | 'area' | 'fire';
}

export interface ToHitResult {
  roll: number;
  modifier: number;
  hit: boolean;
  location: import('./vehicle').ArmorLocation;
}

export interface DamageResult {
  vehicleId: string;
  location: import('./vehicle').ArmorLocation;
  damageDealt: number;
  penetrated: boolean;
  effects: string[];  // 'tire_blown', 'engine_hit', 'driver_wounded', 'destroyed'
}
```

**Step 3: World types**

```typescript
// shared/src/types/world.ts

export type ZoneType = 'highway' | 'town' | 'arena';

export interface Position {
  x: number;
  y: number;
}

export interface VehicleState {
  id: string;
  playerId: string;
  driverId: string;
  position: Position;
  facing: number;      // degrees, 0 = north, clockwise
  speed: number;       // current speed in inches/phase
  stats: import('./vehicle').VehicleStats;
}

export interface ZoneState {
  id: string;
  type: ZoneType;
  tick: number;
  vehicles: VehicleState[];
}
```

**Step 4: WebSocket message types**

```typescript
// shared/src/types/messages.ts

// Client → Server
export type ClientMessage =
  | { type: 'join_zone'; zoneId: string; vehicleId: string }
  | { type: 'input'; tick: number; speed: number; steer: number; fireWeapon: string | null }
  | { type: 'leave_zone' };

// Server → Client
export type ServerMessage =
  | { type: 'zone_state'; state: import('./world').ZoneState }
  | { type: 'damage'; result: import('./combat').DamageResult }
  | { type: 'error'; message: string };
```

**Step 5: Update shared index**

```typescript
// shared/src/index.ts
export * from './types/vehicle';
export * from './types/combat';
export * from './types/world';
export * from './types/messages';
```

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: add shared TypeScript types for vehicles, combat, world, and messages"
```

---

### Task 4: Rules Engine — Vehicle & Movement

**Files:**
- Create: `server/src/rules/vehicle.ts`
- Create: `server/src/rules/movement.ts`
- Create: `server/src/rules/data/chassis.ts`
- Create: `server/src/rules/data/engines.ts`
- Create: `server/src/rules/data/weapons.ts`
- Test: `server/tests/movement.test.ts`

**Step 1: Write failing tests**

```typescript
// server/tests/movement.test.ts
import { describe, it, expect } from 'vitest';
import { computeMovement, applyHazardCheck } from '../src/rules/movement';
import type { VehicleState } from '@carwars/shared';

const baseVehicle: VehicleState = {
  id: 'v1',
  playerId: 'p1',
  driverId: 'd1',
  position: { x: 0, y: 0 },
  facing: 0,
  speed: 10,
  stats: {
    id: 'v1',
    name: 'Test Car',
    loadout: {} as any,
    damageState: { armor: {}, engineDamaged: false, driverWounded: false, tiresBlown: [] },
    maxSpeed: 20,
    handlingClass: 3,
    weight: 3000
  }
};

describe('movement', () => {
  it('moves vehicle forward by speed/5 per phase', () => {
    // At speed 10, moves 2 inches per phase (speed / 5)
    const input = { speed: 10, steer: 0 };
    const result = computeMovement(baseVehicle, input);
    expect(result.position.y).toBeCloseTo(-2); // facing 0 = north = negative y
  });

  it('applies steering to facing', () => {
    const input = { speed: 10, steer: 15 }; // 15° turn
    const result = computeMovement(baseVehicle, input);
    expect(result.facing).toBe(15);
  });

  it('requires hazard check when turning at high speed', () => {
    const fastVehicle = { ...baseVehicle, speed: 20 };
    const input = { speed: 20, steer: 60 };
    const hazard = applyHazardCheck(fastVehicle, input);
    expect(hazard.required).toBe(true);
  });

  it('no hazard check for gentle turns at low speed', () => {
    const input = { speed: 5, steer: 15 };
    const hazard = applyHazardCheck(baseVehicle, input);
    expect(hazard.required).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd server && npx vitest run tests/movement.test.ts
```

Expected: FAIL — modules not found.

**Step 3: Implement game data (chassis, engines, weapons)**

```typescript
// server/src/rules/data/chassis.ts
export interface ChassisDef {
  id: string;
  name: string;
  spaces: number;
  maxWeight: number;
  cost: number;
}

export const CHASSIS: ChassisDef[] = [
  { id: 'compact',  name: 'Compact',  spaces: 6,  maxWeight: 3000, cost: 1000 },
  { id: 'mid',      name: 'Midsize',  spaces: 8,  maxWeight: 4000, cost: 1500 },
  { id: 'van',      name: 'Van',      spaces: 14, maxWeight: 6000, cost: 3000 },
  { id: 'pickup',   name: 'Pickup',   spaces: 10, maxWeight: 5000, cost: 2000 },
];
```

```typescript
// server/src/rules/data/engines.ts
export interface EngineDef {
  id: string;
  name: string;
  maxSpeed: number;   // inches/phase at top speed
  spaces: number;
  weight: number;
  cost: number;
}

export const ENGINES: EngineDef[] = [
  { id: 'small',    name: 'Small',    maxSpeed: 10, spaces: 1, weight: 200, cost: 1000 },
  { id: 'medium',   name: 'Medium',   maxSpeed: 15, spaces: 2, weight: 300, cost: 2000 },
  { id: 'large',    name: 'Large',    maxSpeed: 20, spaces: 3, weight: 400, cost: 4000 },
  { id: 'super',    name: 'Super',    maxSpeed: 25, spaces: 4, weight: 500, cost: 8000 },
];
```

```typescript
// server/src/rules/data/weapons.ts
import type { WeaponDef } from '@carwars/shared';

export const WEAPONS: WeaponDef[] = [
  { id: 'mg',     name: 'Machine Gun',   damage: 1,  rof: 5,  shortRange: 6,  longRange: 12, space: 1, weight: 200, cost: 1000 },
  { id: 'hmg',    name: 'Heavy MG',      damage: 2,  rof: 3,  shortRange: 6,  longRange: 12, space: 2, weight: 400, cost: 3000 },
  { id: 'rl',     name: 'Rocket Laser',  damage: 3,  rof: 1,  shortRange: 8,  longRange: 16, space: 2, weight: 300, cost: 4000 },
  { id: 'laser',  name: 'Laser',         damage: 2,  rof: 1,  shortRange: 10, longRange: 25, space: 2, weight: 400, cost: 6000 },
  { id: 'oil',    name: 'Oil Slick',     damage: 0,  rof: 1,  shortRange: 1,  longRange: 1,  space: 1, weight: 100, cost: 500,  special: 'dropped' },
  { id: 'mine',   name: 'Mine',          damage: 3,  rof: 1,  shortRange: 1,  longRange: 1,  space: 1, weight: 100, cost: 750,  special: 'dropped' },
];
```

**Step 4: Implement vehicle stats derivation**

```typescript
// server/src/rules/vehicle.ts
import type { VehicleLoadout, VehicleStats, DamageState } from '@carwars/shared';
import { CHASSIS } from './data/chassis';
import { ENGINES } from './data/engines';

export function deriveStats(id: string, name: string, loadout: VehicleLoadout): VehicleStats {
  const engine = ENGINES.find(e => e.id === loadout.engineId);
  if (!engine) throw new Error(`Unknown engine: ${loadout.engineId}`);

  const chassis = CHASSIS.find(c => c.id === loadout.chassisId);
  if (!chassis) throw new Error(`Unknown chassis: ${loadout.chassisId}`);

  const totalWeight = engine.weight + 100 * loadout.tires.length;
  // Handling Class: 1 (great) to 6 (terrible). Heavier = worse HC.
  const handlingClass = Math.min(6, Math.max(1, Math.round(totalWeight / 1000)));

  const defaultArmor = {
    front: loadout.armor.front,
    back: loadout.armor.back,
    left: loadout.armor.left,
    right: loadout.armor.right,
    top: loadout.armor.top,
    underbody: loadout.armor.underbody
  };

  const damageState: DamageState = {
    armor: { ...defaultArmor },
    engineDamaged: false,
    driverWounded: false,
    tiresBlown: []
  };

  return {
    id,
    name,
    loadout,
    damageState,
    maxSpeed: engine.maxSpeed,
    handlingClass,
    weight: totalWeight
  };
}
```

**Step 5: Implement movement**

```typescript
// server/src/rules/movement.ts
import type { VehicleState } from '@carwars/shared';

export interface MovementInput {
  speed: number;
  steer: number;  // degrees, positive = clockwise
}

export interface HazardCheck {
  required: boolean;
  difficulty: number;  // target number to roll under on 2d6
}

// Car Wars: distance per phase = speed / 5 (speed in mph-equivalent, distance in inches)
export function computeMovement(vehicle: VehicleState, input: MovementInput): VehicleState {
  const distancePerPhase = input.speed / 5;
  const newFacing = (vehicle.facing + input.steer + 360) % 360;

  const radians = (vehicle.facing - 90) * (Math.PI / 180);
  const dx = Math.cos(radians) * distancePerPhase;
  const dy = Math.sin(radians) * distancePerPhase;

  return {
    ...vehicle,
    position: {
      x: vehicle.position.x + dx,
      y: vehicle.position.y + dy
    },
    facing: newFacing,
    speed: input.speed
  };
}

// Hazard check required when: speed > 10 and turning > 30°, or any turn > 60°
export function applyHazardCheck(vehicle: VehicleState, input: MovementInput): HazardCheck {
  const absTurn = Math.abs(input.steer);
  const required = (input.speed > 10 && absTurn > 30) || absTurn > 60;
  const difficulty = required
    ? Math.max(2, 7 - vehicle.stats.handlingClass + Math.floor(input.speed / 10))
    : 0;
  return { required, difficulty };
}
```

**Step 6: Run tests to verify they pass**

```bash
cd server && npx vitest run tests/movement.test.ts
```

Expected: PASS (4 tests)

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: add rules engine — vehicle stats, movement, and hazard checks"
```

---

### Task 5: Rules Engine — Combat

**Files:**
- Create: `server/src/rules/combat.ts`
- Test: `server/tests/combat.test.ts`

**Step 1: Write failing tests**

```typescript
// server/tests/combat.test.ts
import { describe, it, expect } from 'vitest';
import { resolveToHit, resolveDamage, getAttackLocation } from '../src/rules/combat';
import type { VehicleState } from '@carwars/shared';
import { WEAPONS } from '../src/rules/data/weapons';

const attacker: VehicleState = {
  id: 'a1', playerId: 'p1', driverId: 'd1',
  position: { x: 0, y: 0 }, facing: 0, speed: 10,
  stats: { id: 'a1', name: 'Attacker', loadout: {} as any,
    damageState: { armor: {}, engineDamaged: false, driverWounded: false, tiresBlown: [] },
    maxSpeed: 20, handlingClass: 3, weight: 3000 }
};

const target: VehicleState = {
  id: 't1', playerId: 'p2', driverId: 'd2',
  position: { x: 0, y: -8 }, facing: 180, speed: 5,
  stats: { id: 't1', name: 'Target', loadout: {} as any,
    damageState: {
      armor: { front: 4, back: 2, left: 3, right: 3, top: 0, underbody: 0 },
      engineDamaged: false, driverWounded: false, tiresBlown: []
    },
    maxSpeed: 15, handlingClass: 2, weight: 2500 }
};

describe('combat', () => {
  it('determines attack hits target facing based on relative angle', () => {
    // Attacker facing north (0°), target is directly north → front attack
    const location = getAttackLocation(attacker, target);
    expect(location).toBe('front');
  });

  it('resolves to-hit with distance modifier', () => {
    const mg = WEAPONS.find(w => w.id === 'mg')!;
    // At short range (8 inches <= 12) → base to-hit 7 on 2d6
    const result = resolveToHit(attacker, target, mg, 8);
    expect(result).toHaveProperty('roll');
    expect(result).toHaveProperty('hit');
    expect(result).toHaveProperty('location');
  });

  it('penetrates when damage exceeds armor', () => {
    const mg = WEAPONS.find(w => w.id === 'mg')!;
    // Front armor = 4, MG damage = 1 — does not penetrate
    const result = resolveDamage(target, 'front', mg.damage);
    expect(result.penetrated).toBe(false);
    expect(result.damageDealt).toBe(1);
  });

  it('records destroyed effect when armor reaches zero', () => {
    const weakTarget = {
      ...target,
      stats: {
        ...target.stats,
        damageState: { ...target.stats.damageState, armor: { front: 1 } }
      }
    };
    const hmg = WEAPONS.find(w => w.id === 'hmg')!;
    // HMG damage = 2, front armor = 1 → penetrates
    const result = resolveDamage(weakTarget, 'front', hmg.damage);
    expect(result.penetrated).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd server && npx vitest run tests/combat.test.ts
```

Expected: FAIL — modules not found.

**Step 3: Implement combat**

```typescript
// server/src/rules/combat.ts
import type { VehicleState, ArmorLocation, ToHitResult, DamageResult } from '@carwars/shared';
import type { WeaponDef } from '@carwars/shared';

// Determine which armor facing of the target is hit based on attack angle
export function getAttackLocation(attacker: VehicleState, target: VehicleState): ArmorLocation {
  const dx = target.position.x - attacker.position.x;
  const dy = target.position.y - attacker.position.y;
  const attackAngle = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;

  // Angle relative to target's facing
  const relativeAngle = (attackAngle - target.facing + 360) % 360;

  if (relativeAngle >= 315 || relativeAngle < 45) return 'front';
  if (relativeAngle >= 45 && relativeAngle < 135) return 'right';
  if (relativeAngle >= 135 && relativeAngle < 225) return 'back';
  return 'left';
}

function roll2d6(): number {
  return Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1;
}

// Base to-hit is 7 on 2d6 at short range, 9 at long range
// Modifiers: speed differential, driver wound
export function resolveToHit(
  attacker: VehicleState,
  target: VehicleState,
  weapon: WeaponDef,
  distance: number
): ToHitResult {
  const dx = target.position.x - attacker.position.x;
  const dy = target.position.y - attacker.position.y;
  const actualDistance = distance ?? Math.sqrt(dx * dx + dy * dy);

  let targetNumber = actualDistance <= weapon.shortRange ? 7 : 9;

  // Speed differential modifier
  const speedDiff = Math.abs(attacker.speed - target.speed);
  if (speedDiff > 15) targetNumber += 2;
  else if (speedDiff > 5) targetNumber += 1;

  // Wounded driver penalty
  if (attacker.stats.damageState.driverWounded) targetNumber += 2;

  const roll = roll2d6();
  const hit = roll >= targetNumber;
  const location = hit ? getAttackLocation(attacker, target) : 'front';

  return { roll, modifier: targetNumber - 7, hit, location };
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
    // Excess damage causes component effects
    if (location === 'front' || location === 'back') effects.push('engine_hit');
    if (location === 'left' || location === 'right') effects.push('tire_blown');
    if (remaining < -3) effects.push('driver_wounded');
    if (remaining < -6) effects.push('destroyed');
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

**Step 4: Run tests to verify they pass**

```bash
cd server && npx vitest run tests/combat.test.ts
```

Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: add combat rules — to-hit resolution, armor penetration, damage effects"
```

---

### Task 6: Rules Engine — Turn Orchestration

**Files:**
- Create: `server/src/rules/engine.ts`
- Test: `server/tests/engine.test.ts`

**Step 1: Write failing tests**

```typescript
// server/tests/engine.test.ts
import { describe, it, expect } from 'vitest';
import { createTurnEngine, TurnEngine } from '../src/rules/engine';
import type { VehicleState, ZoneState } from '@carwars/shared';

function makeVehicle(id: string, x: number, y: number): VehicleState {
  return {
    id, playerId: 'p1', driverId: 'd1',
    position: { x, y }, facing: 0, speed: 10,
    stats: {
      id, name: 'Car', loadout: {} as any,
      damageState: {
        armor: { front: 4, back: 2, left: 3, right: 3, top: 0, underbody: 0 },
        engineDamaged: false, driverWounded: false, tiresBlown: []
      },
      maxSpeed: 20, handlingClass: 3, weight: 3000
    }
  };
}

describe('TurnEngine', () => {
  it('advances tick on each resolution', () => {
    const zone: ZoneState = { id: 'z1', type: 'arena', tick: 0, vehicles: [makeVehicle('v1', 0, 0)] };
    const engine = createTurnEngine(zone);
    engine.queueInput('v1', { speed: 10, steer: 0, fireWeapon: null });
    const result = engine.resolveTick();
    expect(result.tick).toBe(1);
  });

  it('moves all vehicles with queued inputs', () => {
    const zone: ZoneState = { id: 'z1', type: 'arena', tick: 0, vehicles: [makeVehicle('v1', 0, 0)] };
    const engine = createTurnEngine(zone);
    engine.queueInput('v1', { speed: 10, steer: 0, fireWeapon: null });
    const result = engine.resolveTick();
    // Should have moved
    expect(result.vehicles[0].position.y).not.toBe(0);
  });

  it('maintains last input if no new input queued', () => {
    const zone: ZoneState = { id: 'z1', type: 'arena', tick: 0, vehicles: [makeVehicle('v1', 0, 0)] };
    const engine = createTurnEngine(zone);
    engine.queueInput('v1', { speed: 10, steer: 0, fireWeapon: null });
    engine.resolveTick();
    const result2 = engine.resolveTick(); // no new input
    expect(result2.tick).toBe(2);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd server && npx vitest run tests/engine.test.ts
```

Expected: FAIL.

**Step 3: Implement turn engine**

```typescript
// server/src/rules/engine.ts
import type { ZoneState, VehicleState } from '@carwars/shared';
import { computeMovement } from './movement';
import { resolveToHit, resolveDamage, getAttackLocation } from './combat';
import { WEAPONS } from './data/weapons';

interface VehicleInput {
  speed: number;
  steer: number;
  fireWeapon: string | null;
}

export interface TurnEngine {
  queueInput(vehicleId: string, input: VehicleInput): void;
  resolveTick(): ZoneState;
  getState(): ZoneState;
}

export function createTurnEngine(initialState: ZoneState): TurnEngine {
  let state: ZoneState = { ...initialState, vehicles: [...initialState.vehicles] };
  const pendingInputs = new Map<string, VehicleInput>();
  const lastInputs = new Map<string, VehicleInput>();

  return {
    queueInput(vehicleId, input) {
      pendingInputs.set(vehicleId, input);
    },

    resolveTick() {
      const newVehicles = state.vehicles.map(vehicle => {
        const input = pendingInputs.get(vehicle.id) ?? lastInputs.get(vehicle.id) ?? { speed: 0, steer: 0, fireWeapon: null };
        lastInputs.set(vehicle.id, input);
        return computeMovement(vehicle, input);
      });

      // Resolve combat
      state.vehicles.forEach((attacker, i) => {
        const input = pendingInputs.get(attacker.id) ?? lastInputs.get(attacker.id);
        if (!input?.fireWeapon) return;

        const weapon = WEAPONS.find(w => w.id === input.fireWeapon);
        if (!weapon) return;

        state.vehicles.forEach((target, j) => {
          if (i === j) return;
          const toHit = resolveToHit(attacker, target, weapon, 0);
          if (toHit.hit) {
            resolveDamage(target, toHit.location, weapon.damage);
          }
        });
      });

      pendingInputs.clear();
      state = { ...state, tick: state.tick + 1, vehicles: newVehicles };
      return state;
    },

    getState() {
      return state;
    }
  };
}
```

**Step 4: Run tests to verify they pass**

```bash
cd server && npx vitest run tests/engine.test.ts
```

Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: add turn engine — tick resolution, input queuing, movement + combat integration"
```

---

### Task 7: WebSocket Protocol

**Files:**
- Modify: `server/src/main.ts`
- Create: `server/src/ws/handler.ts`
- Test: `server/tests/ws.test.ts`

**Step 1: Write failing test**

```typescript
// server/tests/ws.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { createServer } from '../src/ws/handler';
import type { ServerMessage } from '@carwars/shared';

describe('WebSocket handler', () => {
  let server: ReturnType<typeof createServer>;
  let ws: WebSocket;

  beforeAll(async () => {
    server = createServer(3099);
    await new Promise(r => setTimeout(r, 100));
    ws = new WebSocket('ws://localhost:3099');
    await new Promise<void>(r => ws.on('open', r));
  });

  afterAll(() => {
    ws.close();
    server.close();
  });

  it('responds with error on unknown message type', async () => {
    const msg = await new Promise<ServerMessage>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
      ws.send(JSON.stringify({ type: 'unknown_type' }));
    });
    expect(msg.type).toBe('error');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd server && npx vitest run tests/ws.test.ts
```

Expected: FAIL.

**Step 3: Implement WebSocket handler**

```typescript
// server/src/ws/handler.ts
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import type { ClientMessage, ServerMessage } from '@carwars/shared';
import { createTurnEngine, TurnEngine } from '../rules/engine';

const zones = new Map<string, TurnEngine>();
const clientZones = new Map<WebSocket, string>();

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function handleMessage(ws: WebSocket, raw: string) {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    send(ws, { type: 'error', message: 'Invalid JSON' });
    return;
  }

  if (msg.type === 'join_zone') {
    if (!zones.has(msg.zoneId)) {
      zones.set(msg.zoneId, createTurnEngine({
        id: msg.zoneId, type: 'arena', tick: 0, vehicles: []
      }));
    }
    clientZones.set(ws, msg.zoneId);
    const engine = zones.get(msg.zoneId)!;
    send(ws, { type: 'zone_state', state: engine.getState() });
    return;
  }

  if (msg.type === 'input') {
    const zoneId = clientZones.get(ws);
    if (!zoneId) { send(ws, { type: 'error', message: 'Not in a zone' }); return; }
    // Input handling will be expanded when vehicles are properly assigned
    return;
  }

  send(ws, { type: 'error', message: `Unknown message type: ${(msg as any).type}` });
}

export function createServer(port: number) {
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    ws.on('message', (data) => handleMessage(ws, data.toString()));
    ws.on('close', () => clientZones.delete(ws));
  });

  httpServer.listen(port);
  return httpServer;
}
```

**Step 4: Run test to verify it passes**

```bash
cd server && npx vitest run tests/ws.test.ts
```

Expected: PASS

**Step 5: Update server entry point**

```typescript
// server/src/main.ts
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.get('/health', (_req, res) => res.json({ ok: true }));

// Import and attach WS handler
import('./ws/handler').then(({ createServer: _ }) => {
  // handler already wires into createServer for tests; for production, wire wss directly
});

server.listen(3001, () => console.log('Server on :3001'));
```

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: add WebSocket handler with zone join and error handling"
```

---

### Task 8: Basic Arena Scene (Phaser)

**Files:**
- Create: `client/src/scenes/ArenaScene.ts`
- Create: `client/src/game/Connection.ts`
- Modify: `client/src/main.ts`

**Step 1: Implement connection manager**

```typescript
// client/src/game/Connection.ts
import type { ClientMessage, ServerMessage } from '@carwars/shared';

type MessageHandler = (msg: ServerMessage) => void;

export class Connection {
  private ws: WebSocket;
  private handlers: MessageHandler[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (evt) => {
      const msg: ServerMessage = JSON.parse(evt.data);
      this.handlers.forEach(h => h(msg));
    };
  }

  onMessage(handler: MessageHandler) {
    this.handlers.push(handler);
  }

  send(msg: ClientMessage) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  onOpen(cb: () => void) {
    this.ws.addEventListener('open', cb);
  }
}
```

**Step 2: Implement arena scene**

```typescript
// client/src/scenes/ArenaScene.ts
import Phaser from 'phaser';
import { Connection } from '../game/Connection';
import type { ZoneState, VehicleState } from '@carwars/shared';

export class ArenaScene extends Phaser.Scene {
  private connection!: Connection;
  private vehicleSprites = new Map<string, Phaser.GameObjects.Rectangle>();
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private zoneState: ZoneState | null = null;
  private myVehicleId = 'v1'; // placeholder until auth

  constructor() {
    super({ key: 'ArenaScene' });
  }

  create() {
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.connection = new Connection('ws://localhost:3001');

    this.connection.onOpen(() => {
      this.connection.send({ type: 'join_zone', zoneId: 'arena-1', vehicleId: this.myVehicleId });
    });

    this.connection.onMessage((msg) => {
      if (msg.type === 'zone_state') {
        this.zoneState = msg.state;
        this.syncSprites(msg.state);
      }
    });

    // Grid background
    const graphics = this.add.graphics();
    graphics.lineStyle(1, 0x333333);
    for (let x = 0; x < 1280; x += 32) graphics.lineBetween(x, 0, x, 720);
    for (let y = 0; y < 720; y += 32) graphics.lineBetween(0, y, 1280, y);

    this.add.text(16, 16, 'CAR WARS', { color: '#ff4444', fontSize: '24px', fontStyle: 'bold' });
  }

  private syncSprites(state: ZoneState) {
    state.vehicles.forEach(v => {
      let sprite = this.vehicleSprites.get(v.id);
      if (!sprite) {
        sprite = this.add.rectangle(v.position.x, v.position.y, 20, 32, 0x00ff88);
        this.vehicleSprites.set(v.id, sprite);
      }
      // Scale positions to screen (1 inch = 32px)
      sprite.setPosition(640 + v.position.x * 32, 360 + v.position.y * 32);
      sprite.setRotation(Phaser.Math.DegToRad(v.facing));
    });
  }

  update() {
    if (!this.zoneState) return;

    const speed = this.cursors.up.isDown ? 10 : this.cursors.down.isDown ? -5 : 5;
    const steer = this.cursors.left.isDown ? -15 : this.cursors.right.isDown ? 15 : 0;

    this.connection.send({
      type: 'input',
      tick: this.zoneState.tick,
      speed,
      steer,
      fireWeapon: this.input.keyboard!.checkDown(this.input.keyboard!.addKey('SPACE')) ? 'mg' : null
    });
  }
}
```

**Step 3: Register scene in main**

```typescript
// client/src/main.ts
import Phaser from 'phaser';
import { ArenaScene } from './scenes/ArenaScene';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 1280,
  height: 720,
  parent: 'game',
  backgroundColor: '#1a1a2e',
  scene: [ArenaScene]
};

new Phaser.Game(config);
```

**Step 4: Run client and verify it loads**

```bash
cd client && npx vite
```

Open `http://localhost:3000` — expect a dark grid with "CAR WARS" title. No errors in console.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: add arena scene with Phaser rendering and WebSocket connection"
```

---

### Task 9: Game Loop — Server Tick

**Files:**
- Modify: `server/src/ws/handler.ts`
- Create: `server/src/world/zone-runner.ts`

**Step 1: Implement zone runner with 100ms tick**

```typescript
// server/src/world/zone-runner.ts
import { WebSocket } from 'ws';
import type { ServerMessage } from '@carwars/shared';
import { createTurnEngine, TurnEngine } from '../rules/engine';

export class ZoneRunner {
  private engine: TurnEngine;
  private clients = new Set<WebSocket>();
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(zoneId: string) {
    this.engine = createTurnEngine({ id: zoneId, type: 'arena', tick: 0, vehicles: [] });
  }

  addClient(ws: WebSocket) {
    this.clients.add(ws);
    if (!this.interval) this.start();
  }

  removeClient(ws: WebSocket) {
    this.clients.delete(ws);
    if (this.clients.size === 0) this.stop();
  }

  queueInput(vehicleId: string, input: { speed: number; steer: number; fireWeapon: string | null }) {
    this.engine.queueInput(vehicleId, input);
  }

  getEngine() {
    return this.engine;
  }

  private start() {
    this.interval = setInterval(() => {
      const state = this.engine.resolveTick();
      const msg: ServerMessage = { type: 'zone_state', state };
      const data = JSON.stringify(msg);
      this.clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      });
    }, 100);
  }

  private stop() {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }
}
```

**Step 2: Wire zone runner into handler**

Update `server/src/ws/handler.ts` to use `ZoneRunner` instead of raw engine, so clients get ticked state broadcasts every 100ms.

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: add zone runner with 100ms server tick and broadcast to clients"
```

---

### Task 10: AI Driver (Basic)

**Files:**
- Create: `server/src/ai/driver.ts`
- Test: `server/tests/ai.test.ts`

**Step 1: Write failing test**

```typescript
// server/tests/ai.test.ts
import { describe, it, expect } from 'vitest';
import { computeAiInput } from '../src/ai/driver';
import type { VehicleState } from '@carwars/shared';

const self: VehicleState = {
  id: 'ai1', playerId: 'cpu', driverId: 'd_ai',
  position: { x: 0, y: 0 }, facing: 0, speed: 0,
  stats: { id: 'ai1', name: 'AI Car', loadout: {} as any,
    damageState: { armor: { front: 4, back: 2, left: 3, right: 3, top: 0, underbody: 0 },
      engineDamaged: false, driverWounded: false, tiresBlown: [] },
    maxSpeed: 20, handlingClass: 3, weight: 3000 }
};

const target: VehicleState = {
  id: 't1', playerId: 'p1', driverId: 'd1',
  position: { x: 0, y: -20 }, facing: 180, speed: 5,
  stats: { id: 't1', name: 'Player Car', loadout: {} as any,
    damageState: { armor: { front: 4, back: 2, left: 3, right: 3, top: 0, underbody: 0 },
      engineDamaged: false, driverWounded: false, tiresBlown: [] },
    maxSpeed: 20, handlingClass: 3, weight: 3000 }
};

describe('AI driver', () => {
  it('accelerates toward target when too far away', () => {
    const input = computeAiInput(self, [target], 3);
    // Target is 20 units away — should accelerate
    expect(input.speed).toBeGreaterThan(0);
  });

  it('steers toward target', () => {
    // Target is directly north (negative y), AI facing 0 (north) — minimal steering needed
    const input = computeAiInput(self, [target], 3);
    expect(Math.abs(input.steer)).toBeLessThanOrEqual(30);
  });

  it('fires weapon when target is within range', () => {
    const closeTarget = { ...target, position: { x: 0, y: -6 } };
    const input = computeAiInput(self, [closeTarget], 3);
    expect(input.fireWeapon).not.toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd server && npx vitest run tests/ai.test.ts
```

**Step 3: Implement AI**

```typescript
// server/src/ai/driver.ts
import type { VehicleState } from '@carwars/shared';

export interface AiInput {
  speed: number;
  steer: number;
  fireWeapon: string | null;
}

const OPTIMAL_RANGE = 8;   // inches — ideal firing range
const FIRE_RANGE = 12;     // inches — max fire distance

export function computeAiInput(
  self: VehicleState,
  others: VehicleState[],
  _skill: number         // 1-6, higher = better decisions (expansion point)
): AiInput {
  const enemies = others.filter(o => o.playerId !== self.playerId);
  if (enemies.length === 0) return { speed: 0, steer: 0, fireWeapon: null };

  // Pick closest enemy as target
  const target = enemies.reduce((closest, e) => {
    const d = dist(self.position, e.position);
    return d < dist(self.position, closest.position) ? e : closest;
  });

  const dx = target.position.x - self.position.x;
  const dy = target.position.y - self.position.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  // Desired facing toward target
  const targetAngle = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
  let steer = (targetAngle - self.facing + 540) % 360 - 180; // -180 to +180
  steer = Math.max(-30, Math.min(30, steer)); // clamp to max turn

  // Speed: close to optimal range
  const speed = distance > OPTIMAL_RANGE + 2
    ? Math.min(self.stats.maxSpeed, self.speed + 5)
    : distance < OPTIMAL_RANGE - 2
    ? Math.max(0, self.speed - 5)
    : self.speed;

  // Fire if target is within range and roughly in front arc
  const angleDiff = Math.abs(steer);
  const fireWeapon = distance <= FIRE_RANGE && angleDiff < 45 ? 'mg' : null;

  return { speed, steer, fireWeapon };
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}
```

**Step 4: Run tests to verify they pass**

```bash
cd server && npx vitest run tests/ai.test.ts
```

Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: add AI driver with behaviour tree — target selection, approach, and firing"
```

---

## Phase 1 Complete

At the end of Phase 1 you will have:
- Monorepo scaffold (client + server + shared)
- PostgreSQL schema with migrations
- Full Car Wars rules engine (movement, combat, turn orchestration)
- WebSocket protocol for client-server communication
- Phaser arena scene rendering vehicles
- 100ms server tick with state broadcast
- Basic AI driver

Run all tests to confirm: `cd server && npx vitest run`

---

# Phase 2: World & Campaign (plan to be written separately)

**Scope preview:**
- Task 11: Tiled tilemap loading (arena and town zones)
- Task 12: Zone transition system (driving between zones)
- Task 13: Town UI (garage screen, job board)
- Task 14: Vehicle designer (point-buy UI)
- Task 15: Driver hiring system
- Task 16: Campaign economy (prize money, repair costs, wages)
- Task 17: Division system (thresholds, standings, event qualification)

---

# Phase 3: Open World (plan to be written separately)

**Scope preview:**
- Task 18: Highway zones with NPC traffic
- Task 19: Rival gang system (persistent gangs with memory of player)
- Task 20: Random encounter generation
- Task 21: Job board missions (escort, ambush, delivery)
- Task 22: Reputation system

---

# Phase 4: Multiplayer (plan to be written separately)

**Scope preview:**
- Task 23: Player accounts and authentication
- Task 24: Persistent world zones (multiple players in same zone)
- Task 25: PvP flagging system
- Task 26: Arena matchmaking lobby
- Task 27: Gang events (team arena matches)
