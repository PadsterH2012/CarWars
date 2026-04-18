# Arena Map System Design

## Goal

Add a multi-map arena system starting with a Car Wars Truck Stop layout, with server-side collision detection and client rendering of obstacles. Designed to support many future map styles.

## Architecture

**Static TypeScript map definition modules** (Approach A). Each map is a file in `src/rules/maps/` exporting an `ArenaMap` object. A central registry maps `mapId → ArenaMap`. No database, no file I/O — maps are code.

`ZoneState` gets a `mapId` field so the client knows what to render. The zone type prefix (`arena-truck-stop`, `arena`, etc.) determines which map loads.

---

## Components

### 1. Shared Types (`packages/shared/src/index.ts`)

```typescript
export interface Rect {
  x: number;  // center x in world units
  y: number;  // center y in world units
  w: number;  // width
  h: number;  // height
  type?: 'wall' | 'building' | 'turret';  // for client rendering colour
}

export interface SpawnPoint {
  x: number;
  y: number;
  facing: number;
  team: 'player' | 'ai';
}

export interface ArenaMap {
  id: string;
  width: number;   // total world units (arena spans ±width/2)
  height: number;  // total world units (arena spans ±height/2)
  walls: Rect[];
  spawnPoints: SpawnPoint[];
}
```

`ZoneState` gains: `mapId?: string`

---

### 2. Map Registry (`src/rules/maps/index.ts`)

```typescript
import { truckStopMap } from './truck-stop';
import { openArenaMap } from './open';

export const MAPS: Record<string, ArenaMap> = {
  'open':        openArenaMap,
  'truck-stop':  truckStopMap,
};

export function getMap(mapId: string): ArenaMap {
  return MAPS[mapId] ?? openArenaMap;
}
```

---

### 3. Open Arena Map (`src/rules/maps/open.ts`)

The existing featureless arena, preserved as-is but expressed in the new format. Bounds: 40×23 world units. No walls except implicit boundary. Spawn points match current hardcoded positions.

---

### 4. Truck Stop Map (`src/rules/maps/truck-stop.ts`)

**Bounds:** 80 × 50 world units (x: −40→+40, y: −25→+25)

**Layout** (landscape orientation, inspired by Car Wars Truck Stop supplement p.32):

| Feature | Description | Approx world coords |
|---|---|---|
| North wall | Top perimeter with main gate gap | y=−25, full width, gap x=−3→+3 |
| South wall | Bottom perimeter with secondary gate | y=+25, full width, gap x=+25→+31 |
| West wall | Left perimeter | x=−40, full height |
| East wall | Right perimeter | x=+40, full height |
| NW turret | Corner turret | x=−38.5, y=−23.5, 3×3 |
| NE turret | Corner turret | x=+38.5, y=−23.5, 3×3 |
| SW turret | Corner turret | x=−38.5, y=+23.5, 3×3 |
| SE turret | Corner turret | x=+38.5, y=+23.5, 3×3 |
| Gatehouse | Near main gate | x=0, y=−19, 6×4 |
| Security bldg | Center-left, L-shape (two rects) | x=−18, y=−4, 10×12 + x=−13, y=−10, 5×5 |
| Power bldg | Center-right, U-shape (two rects) | x=+10, y=−6, 3×10 + x=+16, y=−6, 3×10 |
| Garage wing | Large left wing of main bldg | x=−20, y=+13, 14×10 |
| Main bldg | Right wing of main bldg | x=−6, y=+9, 24×14 |

**Spawn points:**
- Player: `(0, +4, facing=0°)` — center courtyard, facing north
- AI red: `(−14, −8, facing=135°)` — NW quadrant, facing SE
- AI blue: `(+14, −8, facing=225°)` — NE quadrant, facing SW

---

### 5. Collision Detection (`src/rules/engine.ts`)

After `computeMovement`, check each vehicle against every wall rect using AABB. Vehicle bounding box: 1 unit wide × 2 units long (axis-aligned for simplicity).

**On collision:**
1. Push vehicle position back to the wall edge (resolve penetration)
2. Apply `Math.floor(vehicle.speed / 5)` damage to the nearest facing armor panel
3. Zero the vehicle's speed

```typescript
function checkWallCollision(vehicle: VehicleState, walls: Rect[]): {
  collided: boolean;
  correctedPos: Position;
  damage: number;
} { ... }
```

The `TurnEngine` is constructed with an optional `ArenaMap`. If no map supplied, collision check is skipped (backwards compatible with existing tests).

---

### 6. Zone Routing (`src/ws/handler.ts`)

```typescript
// zoneId prefix → mapId
function mapIdForZone(zoneId: string): string {
  if (zoneId.startsWith('arena-truck-stop')) return 'truck-stop';
  return 'open';
}
```

`ZoneRunner` / `createTurnEngine` receive the resolved `ArenaMap`. Initial `zone_state` broadcast includes `mapId`.

---

### 7. Client Rendering (`client/src/scenes/ArenaScene.ts`)

On first `zone_state` message (or when `mapId` changes), `ArenaScene` calls `renderMap(mapId, walls)`:

- Creates a static Phaser `Graphics` object (drawn once, never redrawn)
- Perimeter walls: dark grey fill
- Buildings: medium grey fill with darker outline
- Turrets: dark red fill
- No per-frame cost

Camera bounds updated to match map `width × height` instead of hardcoded values.

---

## Data Flow

```
client join_zone "arena-truck-stop"
  → handler: mapId = 'truck-stop', load ArenaMap
  → createTurnEngine(initialState, truckStopMap)
  → zone_state { mapId: 'truck-stop', walls: [...], vehicles: [...] }
  → ArenaScene.renderMap('truck-stop', walls)

each tick:
  → resolveTick(): move vehicles → checkWallCollision() → apply damage
  → zone_state broadcast (vehicles only, walls don't change)
```

---

## Testing

- Unit tests for `checkWallCollision`: vehicle inside wall → corrected position + damage; vehicle outside → no change
- Unit test: truck stop map has no overlapping wall rects
- Existing movement tests unaffected (no map passed to engine)

---

## Out of Scope

- Diagonal wall geometry (all rects are axis-aligned)
- Vehicle-to-vehicle collision damage (separate future feature)
- Dynamic obstacles (destructible walls)
- Map editor tooling
- Loading maps from JSON/database
