# Arena Map System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a multi-map arena system with the Car Wars Truck Stop as the first map, including server-side wall collision detection and client rendering of obstacles.

**Architecture:** Static TypeScript map definition objects per map (`server/src/rules/maps/`). ZoneState gains `mapId` + optional `walls` (sent only on join). Engine checks AABB collisions post-move and applies speed-based damage. Client renders walls on first `zone_state` receipt.

**Tech Stack:** TypeScript, Vitest (server tests), Phaser 3 (client graphics)

---

### Task 1: Add map types to shared

**Files:**
- Modify: `shared/src/types/world.ts`

**Step 1: Add the new types**

Open `shared/src/types/world.ts` and add these interfaces + update `ZoneState`:

```typescript
import type { VehicleStats } from './vehicle';

export type ZoneType = 'highway' | 'town' | 'arena';

export interface ZoneMetadata {
  id: string;
  type: 'arena' | 'town' | 'highway';
  name: string;
  exits: { direction: 'north' | 'south' | 'east' | 'west'; destinationZoneId: string }[];
}

export interface Position {
  x: number;
  y: number;
}

// --- NEW ---
export type WallType = 'wall' | 'building' | 'turret';

export interface Rect {
  x: number;       // center x in world units
  y: number;       // center y in world units
  w: number;       // width
  h: number;       // height
  type?: WallType; // for client rendering colour
}

export interface SpawnPoint {
  x: number;
  y: number;
  facing: number;
  team: 'player' | 'ai';
}

export interface ArenaMap {
  id: string;
  width: number;        // total world units (arena spans ±width/2)
  height: number;       // total world units (arena spans ±height/2)
  walls: Rect[];
  spawnPoints: SpawnPoint[];
}
// --- END NEW ---

export interface VehicleState {
  id: string;
  playerId: string;
  driverId: string;
  position: Position;
  facing: number;
  speed: number;
  stats: VehicleStats;
}

export interface HazardObject {
  id: string;
  type: 'oil' | 'mine';
  position: Position;
  ownerId: string;
}

export interface ZoneState {
  id: string;
  type: ZoneType;
  tick: number;
  vehicles: VehicleState[];
  hazardObjects: HazardObject[];
  mapId?: string;   // NEW — which arena map is loaded
  walls?: Rect[];   // NEW — only present in the initial join state, not every tick
}
```

**Step 2: Verify TypeScript still compiles**

```bash
cd /Users/paddyharker/carwars
npm run build 2>&1 | head -30
```

Expected: no errors (or only pre-existing errors unrelated to your changes).

**Step 3: Commit**

```bash
cd /Users/paddyharker/carwars
git add shared/src/types/world.ts
git commit -m "feat: add Rect, ArenaMap, SpawnPoint types; extend ZoneState with mapId/walls"
```

---

### Task 2: Write collision helper + tests (TDD)

**Files:**
- Create: `server/src/rules/collision.ts`
- Create: `server/tests/collision.test.ts`

**Step 1: Write the failing tests first**

Create `server/tests/collision.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { resolveWallCollisions } from '../src/rules/collision';
import type { Rect } from '@carwars/shared';

const wall: Rect = { x: 0, y: 0, w: 10, h: 4 };  // 10×4 block centered at origin

describe('resolveWallCollisions', () => {
  it('returns no hit when vehicle is clear', () => {
    const result = resolveWallCollisions({ x: 0, y: 10 }, [wall]);
    expect(result.hit).toBe(false);
    expect(result.x).toBe(0);
    expect(result.y).toBe(10);
  });

  it('pushes vehicle south when overlapping top of wall', () => {
    // Vehicle at (0, -1): inside top half of wall (wall extends y=-2..+2, vehicle extends ±1)
    const result = resolveWallCollisions({ x: 0, y: -1 }, [wall]);
    expect(result.hit).toBe(true);
    // Vehicle (h=2, half=1) + wall half (h=4, half=2) = 3 min clearance.
    // Vehicle is above center (y<0) so pushed up: y = -(1 + 2) = -3
    expect(result.y).toBeCloseTo(-3);
    expect(result.facing).toBe('back');
  });

  it('pushes vehicle north when overlapping bottom of wall', () => {
    const result = resolveWallCollisions({ x: 0, y: 1 }, [wall]);
    expect(result.hit).toBe(true);
    expect(result.y).toBeCloseTo(3);
    expect(result.facing).toBe('front');
  });

  it('pushes vehicle right when overlapping left side of wall', () => {
    // Vehicle at (-4, 0): vehicle (w=1, half=0.5) + wall half (w=10, half=5) = 5.5 clearance
    // overlapX = 5.5 - 4 = 1.5; overlapY = 3 - 0 = 3; overlapX < overlapY → push horizontal
    const result = resolveWallCollisions({ x: -4, y: 0 }, [wall]);
    expect(result.hit).toBe(true);
    // x < wall.x so push left: x -= overlapX
    expect(result.x).toBeCloseTo(-5.5);
    expect(result.facing).toBe('right');
  });

  it('no hit when vehicle is outside all walls', () => {
    const walls: Rect[] = [
      { x: -20, y: 0, w: 5, h: 5 },
      { x:  20, y: 0, w: 5, h: 5 },
    ];
    const result = resolveWallCollisions({ x: 0, y: 0 }, walls);
    expect(result.hit).toBe(false);
  });
});
```

**Step 2: Run tests — expect FAIL**

```bash
cd /Users/paddyharker/carwars/server
npm test -- tests/collision.test.ts 2>&1 | tail -20
```

Expected: FAIL with "Cannot find module '../src/rules/collision'"

**Step 3: Implement collision.ts**

Create `server/src/rules/collision.ts`:

```typescript
import type { Position, Rect } from '@carwars/shared';
import type { StandardSurface } from '@carwars/shared';

// Vehicle axis-aligned bounding box half-extents (world units)
const VEH_HW = 0.5;  // half-width  (vehicle is 1 unit wide)
const VEH_HH = 1.0;  // half-height (vehicle is 2 units long)

export interface WallHit {
  x: number;
  y: number;
  hit: boolean;
  facing: StandardSurface;  // armor panel that made contact
}

/**
 * Checks a vehicle position against a list of wall rects.
 * On overlap, pushes the vehicle out along the axis of minimum penetration
 * and records which facing panel was hit.
 */
export function resolveWallCollisions(pos: Position, walls: Rect[]): WallHit {
  let { x, y } = pos;
  let hit = false;
  let facing: StandardSurface = 'front';

  for (const wall of walls) {
    const overlapX = (VEH_HW + wall.w / 2) - Math.abs(x - wall.x);
    const overlapY = (VEH_HH + wall.h / 2) - Math.abs(y - wall.y);

    if (overlapX <= 0 || overlapY <= 0) continue;  // no collision

    hit = true;

    if (overlapX < overlapY) {
      // Push horizontally (thinner penetration axis)
      if (x < wall.x) { x -= overlapX; facing = 'right'; }
      else             { x += overlapX; facing = 'left'; }
    } else {
      // Push vertically
      if (y < wall.y) { y -= overlapY; facing = 'back'; }
      else             { y += overlapY; facing = 'front'; }
    }
  }

  return { x, y, hit, facing };
}
```

**Step 4: Run tests — expect PASS**

```bash
cd /Users/paddyharker/carwars/server
npm test -- tests/collision.test.ts 2>&1 | tail -10
```

Expected: all 5 tests pass.

**Step 5: Commit**

```bash
cd /Users/paddyharker/carwars/server
git add src/rules/collision.ts tests/collision.test.ts
git commit -m "feat: add wall collision resolver with AABB push-out"
```

---

### Task 3: Wire collision into engine

**Files:**
- Modify: `server/src/rules/engine.ts`

**Step 1: Add map parameter to createTurnEngine**

At the top of `engine.ts`, add the import:

```typescript
import type { ArenaMap } from '@carwars/shared';
import { resolveWallCollisions } from './collision';
```

Change the function signature:

```typescript
export function createTurnEngine(initialState: ZoneState, map?: ArenaMap): TurnEngine {
```

**Step 2: Apply collision resolution after movement**

Inside `resolveTick()`, find this existing block (around line 45-50):

```typescript
      let newVehicles = activeVehicles.map(vehicle => {
        const input = pendingInputs.get(vehicle.id) ?? lastInputs.get(vehicle.id) ?? { speed: 0, steer: 0, fireWeapon: null };
        lastInputs.set(vehicle.id, { speed: input.speed, steer: 0, fireWeapon: null });
        return computeMovement(vehicle, input);
      });
```

Replace it with:

```typescript
      let newVehicles = activeVehicles.map(vehicle => {
        const input = pendingInputs.get(vehicle.id) ?? lastInputs.get(vehicle.id) ?? { speed: 0, steer: 0, fireWeapon: null };
        lastInputs.set(vehicle.id, { speed: input.speed, steer: 0, fireWeapon: null });
        let moved = computeMovement(vehicle, input);

        // Wall collision check — only when a map with walls is loaded
        if (map && map.walls.length > 0) {
          const hit = resolveWallCollisions(moved.position, map.walls);
          if (hit.hit) {
            const baseDamage = Math.floor(moved.speed / 5);
            if (baseDamage > 0) {
              const ds = moved.stats.damageState;
              const newArmor = { ...ds.armor };
              newArmor[hit.facing] = Math.max(0, (newArmor[hit.facing] ?? 0) - baseDamage);
              const destroyed = ds.destroyed || (newArmor[hit.facing] ?? 0) <= 0;
              console.log(`[t${state.tick}] WALL  ${moved.id} hit ${hit.facing} at spd=${moved.speed} -${baseDamage}pts`);
              moved = {
                ...moved,
                position: { x: hit.x, y: hit.y },
                speed: 0,
                stats: {
                  ...moved.stats,
                  damageState: { ...ds, armor: newArmor, destroyed }
                }
              };
            } else {
              moved = { ...moved, position: { x: hit.x, y: hit.y }, speed: 0 };
            }
          }
        }

        return moved;
      });
```

**Step 3: Run all server tests**

```bash
cd /Users/paddyharker/carwars/server
npm test 2>&1 | tail -20
```

Expected: all existing tests still pass (no map is passed in movement.test.ts, so collision code is never hit).

**Step 4: Commit**

```bash
cd /Users/paddyharker/carwars/server
git add src/rules/engine.ts
git commit -m "feat: apply wall collision damage and position correction in engine"
```

---

### Task 4: Create map data files

**Files:**
- Create: `server/src/rules/maps/open.ts`
- Create: `server/src/rules/maps/truck-stop.ts`
- Create: `server/src/rules/maps/index.ts`

**Step 1: Create the open arena map**

Create `server/src/rules/maps/open.ts`:

```typescript
import type { ArenaMap } from '@carwars/shared';

/** Original featureless arena — 40×23 world units, no obstacles */
export const openArenaMap: ArenaMap = {
  id: 'open',
  width: 40,
  height: 23,
  walls: [],
  spawnPoints: [
    { x: 0,   y:  8, facing:   0, team: 'player' },
    { x: -14, y: -8, facing: 135, team: 'ai' },
    { x:  14, y: -8, facing: 225, team: 'ai' },
  ],
};
```

**Step 2: Create the truck stop map**

Create `server/src/rules/maps/truck-stop.ts`:

```typescript
import type { ArenaMap } from '@carwars/shared';

/**
 * Fortified Truck Stop arena — 80×50 world units (±40x, ±25y).
 * Inspired by the Car Wars Truck Stop supplement map (Steve Jackson Games, 1983).
 *
 * Layout (landscape):
 *   - Perimeter wall with main gate (top, x=-3..+3) and secondary gate (bottom-right, x=+25..+31)
 *   - 4 corner turrets
 *   - Gatehouse top-center
 *   - Security/living quarters building center-left (L-shaped)
 *   - Power building center-right (U-shaped)
 *   - Main building bottom half (L-shaped: garage bays left + main building right)
 *   - Open courtyard = primary combat space
 */
export const truckStopMap: ArenaMap = {
  id: 'truck-stop',
  width: 80,
  height: 50,
  walls: [
    // ── Perimeter walls ──────────────────────────────────────────────────────
    // North wall — gap at x=-3..+3 (main gate, 6 units wide)
    { x: -21.5, y: -24.5, w: 37, h: 1, type: 'wall' },
    { x:  21.5, y: -24.5, w: 37, h: 1, type: 'wall' },
    // South wall — gap at x=+25..+31 (secondary gate, 6 units wide)
    { x:  -7.5, y:  24.5, w: 65, h: 1, type: 'wall' },
    { x:  35.5, y:  24.5, w:  9, h: 1, type: 'wall' },
    // West wall (full height between north/south walls)
    { x: -39.5, y: 0, w: 1, h: 49, type: 'wall' },
    // East wall
    { x:  39.5, y: 0, w: 1, h: 49, type: 'wall' },

    // ── Corner turrets ───────────────────────────────────────────────────────
    { x: -38, y: -23, w: 3, h: 3, type: 'turret' },  // NW
    { x:  38, y: -23, w: 3, h: 3, type: 'turret' },  // NE
    { x: -38, y:  23, w: 3, h: 3, type: 'turret' },  // SW
    { x:  38, y:  23, w: 3, h: 3, type: 'turret' },  // SE

    // ── Gatehouse (top-center, near main gate) ───────────────────────────────
    { x: 0, y: -19, w: 6, h: 4, type: 'building' },

    // ── Security / living quarters (center-left, L-shaped) ───────────────────
    { x: -20, y: -2, w:  8, h: 12, type: 'building' },  // main vertical block
    { x: -15, y:  3, w:  6, h:  6, type: 'building' },  // horizontal wing

    // ── Power building (center-right, U-shaped) ──────────────────────────────
    { x:  10, y: -5, w: 3, h:  8, type: 'building' },  // left arm
    { x:  16, y: -5, w: 3, h:  8, type: 'building' },  // right arm
    { x:  13, y: -8, w: 9, h:  2, type: 'building' },  // top crossbar

    // ── Main building (bottom half, L-shaped) ────────────────────────────────
    { x: -22, y: 14, w: 14, h: 10, type: 'building' },  // garage wing (9 bays)
    { x:  -4, y: 11, w: 24, h: 12, type: 'building' },  // main wing (bar, restaurant, offices)
  ],
  spawnPoints: [
    { x:   0, y:  2, facing:   0, team: 'player' },  // center courtyard, facing north
    { x: -14, y: -10, facing: 135, team: 'ai' },     // NW area, facing SE
    { x:  14, y: -10, facing: 225, team: 'ai' },     // NE area, facing SW
  ],
};
```

**Step 3: Create the map registry**

Create `server/src/rules/maps/index.ts`:

```typescript
import type { ArenaMap } from '@carwars/shared';
import { openArenaMap } from './open';
import { truckStopMap } from './truck-stop';

export const MAPS: Record<string, ArenaMap> = {
  'open':        openArenaMap,
  'truck-stop':  truckStopMap,
};

export function getMap(mapId: string): ArenaMap {
  return MAPS[mapId] ?? openArenaMap;
}
```

**Step 4: Run all tests (no new tests needed — data files)**

```bash
cd /Users/paddyharker/carwars/server
npm test 2>&1 | tail -10
```

Expected: all tests pass.

**Step 5: Commit**

```bash
cd /Users/paddyharker/carwars/server
git add src/rules/maps/
git commit -m "feat: add open arena and truck stop map definitions"
```

---

### Task 5: Wire map into zone routing

**Files:**
- Modify: `server/src/world/zone-runner.ts`
- Modify: `server/src/ws/handler.ts`

**Step 1: Update ZoneRunner to accept and use a map**

In `server/src/world/zone-runner.ts`, add the import at the top:

```typescript
import type { ArenaMap, ServerMessage } from '@carwars/shared';
import { getMap } from '../rules/maps';
```

Change the constructor to accept a `mapId` and store the resolved map:

```typescript
export class ZoneRunner {
  private engine: TurnEngine;
  private clients = new Set<WebSocket>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private humanInputThisTick = new Set<string>();
  private ended = false;
  private humanVehicles = new Set<string>();
  private autopilotVehicles = new Set<string>();
  private map: ArenaMap;  // NEW

  hasEnded(): boolean { return this.ended; }
  readonly zoneId: string;
  private onEnd?: (winnerId: string | null) => void;

  constructor(
    zoneId: string,
    zoneType: import('@carwars/shared').ZoneType = 'arena',
    options: ZoneRunnerOptions = {},
    mapId = 'open'   // NEW — defaults to featureless arena
  ) {
    this.zoneId = zoneId;
    this.onEnd = options.onEnd;
    this.map = getMap(mapId);   // NEW
    this.engine = createTurnEngine(
      { id: zoneId, type: zoneType, tick: 0, vehicles: [], hazardObjects: [] },
      this.map                  // NEW — pass map to engine
    );
  }
```

Update `addClient` to include walls in the initial state message:

```typescript
  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    if (!this.interval) this.start();
    const state = this.engine.getState();
    // Include map walls only in the initial join message — not broadcast every tick
    const initialState = { ...state, mapId: this.map.id, walls: this.map.walls };
    const msg: ServerMessage = { type: 'zone_state', state: initialState };
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
```

Also expose the map's spawn points via a new getter (used by handler.ts):

```typescript
  getMap(): ArenaMap { return this.map; }
```

**Step 2: Update handler.ts to resolve mapId and use spawn points**

In `server/src/ws/handler.ts`, add a helper function (before the `zones` map declaration):

```typescript
function mapIdForZone(zoneId: string): string {
  if (zoneId.startsWith('arena-truck-stop')) return 'truck-stop';
  return 'open';
}
```

In the `join_zone` handler, find the `new ZoneRunner(...)` call and add the mapId argument:

```typescript
      const runner = new ZoneRunner(msg.zoneId, zoneType, isArena ? {
        onEnd: async (winnerId: string | null) => {
          // ... existing onEnd code unchanged ...
        },
      } : {}, mapIdForZone(msg.zoneId));  // ← add mapId as 4th arg
```

Update the AI spawn positions to use the map's spawn points. Find where AI vehicles are added and replace the hardcoded positions:

```typescript
      if (isArena) {
        const aiSpawns = runner.getMap().spawnPoints.filter(s => s.team === 'ai');
        const names = ['ai-red', 'ai-blue'];
        aiSpawns.forEach((sp, i) => {
          const name = names[i] ?? `ai-${i}`;
          runner.getEngine().addVehicle(makeTestVehicle(name, 'ai-team', sp.x, sp.y, sp.facing, 70));
        });
      } else if (isHighway) {
        runner.getEngine().addVehicle(makeTestVehicle('npc-1', 'npc-traffic', -5, -60, 0));
        runner.getEngine().addVehicle(makeTestVehicle('npc-2', 'npc-traffic',  5, -20, 0));
        runner.getEngine().addVehicle(makeTestVehicle('npc-3', 'npc-traffic',  0,  40, 0));
      }
```

Update the player spawn to use the map's player spawn point:

```typescript
    if (!vehicle) {
      const playerSpawn = runner.getMap().spawnPoints.find(s => s.team === 'player');
      const px = playerSpawn?.x ?? 0;
      const py = playerSpawn?.y ?? 8;
      vehicle = makeTestVehicle(msg.vehicleId, 'player', px, py, 0, 60);
    }
    vehicle = {
      ...vehicle,
      position: { x: runner.getMap().spawnPoints.find(s => s.team === 'player')?.x ?? 0,
                  y: runner.getMap().spawnPoints.find(s => s.team === 'player')?.y ?? 8 },
      facing: 0,
      speed: 0,
      stats: { ...vehicle.stats, maxSpeed: Math.min(vehicle.stats.maxSpeed, 100) },
    };
```

**Step 3: Run all server tests**

```bash
cd /Users/paddyharker/carwars/server
npm test 2>&1 | tail -20
```

Expected: all tests pass.

**Step 4: Commit**

```bash
cd /Users/paddyharker/carwars/server
git add src/world/zone-runner.ts src/ws/handler.ts
git commit -m "feat: wire mapId into zone routing; spawn AI from map spawn points"
```

---

### Task 6: Client map rendering + zone switch

**Files:**
- Modify: `client/src/scenes/ArenaScene.ts`

**Step 1: Add wall storage and read mapId from URL**

At the top of the `ArenaScene` class, add two new private fields after the existing ones:

```typescript
  private mapWalls: import('@carwars/shared').Rect[] = [];
  private mapGraphics!: Phaser.GameObjects.Graphics;
```

In `create()`, find where the connection's `join_zone` is sent:

```typescript
      this.connection.send({ type: 'join_zone', zoneId: 'arena-1', vehicleId: this.myVehicleId, token: this.token });
```

Replace it with (reads zone from URL query param, defaults to `arena-truck-stop`):

```typescript
      const zoneId = new URLSearchParams(window.location.search).get('zone') ?? 'arena-truck-stop';
      this.connection.send({ type: 'join_zone', zoneId, vehicleId: this.myVehicleId, token: this.token });
```

After the tilemap/ground layer setup (around line 73), add graphics layer initialization:

```typescript
    this.mapGraphics = this.add.graphics().setDepth(1);  // above ground, below vehicles
```

**Step 2: Render walls on first zone_state receipt**

In the `onMessage` handler, update the `zone_state` branch:

```typescript
      if (msg.type === 'zone_state') {
        // Render map walls once on the first message (walls only present on join)
        if (msg.state.walls && msg.state.walls.length > 0 && this.mapWalls.length === 0) {
          this.mapWalls = msg.state.walls;
          this.renderMapWalls(msg.state.walls);
          // Update camera bounds to match map size
          if (msg.state.mapId) {
            const isLargeMap = msg.state.walls.some(w => Math.abs(w.x) > 25 || Math.abs(w.y) > 15);
            this.cameras.main.setZoom(isLargeMap ? 0.35 : 0.6);
          }
        }
        this.zoneState = msg.state;
        this.syncSprites(msg.state);
      }
```

**Step 3: Add the renderMapWalls method**

Add this method to the `ArenaScene` class (after `syncHazards`):

```typescript
  private renderMapWalls(walls: import('@carwars/shared').Rect[]): void {
    const gfx = this.mapGraphics;
    gfx.clear();

    walls.forEach(wall => {
      const px = WORLD_CENTER_X + wall.x * PIXELS_PER_INCH;
      const py = WORLD_CENTER_Y + wall.y * PIXELS_PER_INCH;
      const pw = wall.w * PIXELS_PER_INCH;
      const ph = wall.h * PIXELS_PER_INCH;

      if (wall.type === 'turret') {
        gfx.fillStyle(0x8b1a1a, 1);    // dark red
        gfx.lineStyle(1, 0xff3333, 1);
      } else if (wall.type === 'building') {
        gfx.fillStyle(0x3a3a4a, 1);    // medium grey-blue
        gfx.lineStyle(1, 0x555566, 1);
      } else {
        gfx.fillStyle(0x222233, 1);    // dark grey (outer wall)
        gfx.lineStyle(1, 0x333344, 1);
      }

      gfx.fillRect(px - pw / 2, py - ph / 2, pw, ph);
      gfx.strokeRect(px - pw / 2, py - ph / 2, pw, ph);
    });
  }
```

**Step 4: Build and manual smoke test**

Start the server and client:

```bash
# Terminal 1 — server
cd /Users/paddyharker/carwars/server
npm run dev

# Terminal 2 — client
cd /Users/paddyharker/carwars/client
npm run dev
```

Open browser at `http://localhost:5173` (or wherever Vite serves).

Expected:
- Arena loads with visible walls (dark grey perimeter, grey-blue buildings, dark red corner turrets)
- Player vehicle spawns in center courtyard
- AI vehicles spawn in NW/NE areas
- Driving into a wall stops the vehicle and reduces armor
- Console logs show `WALL  <vehicleId> hit front at spd=X -Y pts`

To test the old open arena: `http://localhost:5173?zone=arena-1`

**Step 5: Run server tests one final time**

```bash
cd /Users/paddyharker/carwars/server
npm test 2>&1 | tail -10
```

Expected: all tests pass.

**Step 6: Commit**

```bash
cd /Users/paddyharker/carwars
git add client/src/scenes/ArenaScene.ts
git commit -m "feat: render map walls in ArenaScene; auto-zoom for large maps; URL zone switch"
```

---

## Done

After Task 6, the truck stop arena is live. Verify:
- `http://localhost:5173` → truck stop (80×50, buildings visible, collisions working)
- `http://localhost:5173?zone=arena-1` → original open arena (unchanged)
- Server logs show `WALL` events when vehicles hit obstacles

To add a new map in future: create `server/src/rules/maps/<name>.ts`, register in `index.ts`, add a `zoneId` prefix check in `mapIdForZone()`.
