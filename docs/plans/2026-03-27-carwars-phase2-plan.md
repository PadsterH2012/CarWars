# Car Wars Phase 2 — World & Campaign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire campaign persistence into the game — player auth, vehicle hydration from DB, tilemaps, zone transitions, garage/job board UI, vehicle designer, driver hiring, and the division economy.

**Architecture:** Two parallel streams (backend API + frontend scenes) converge at the Town scene. The server gains Express REST routes under `/api/` protected by JWT middleware; the client gains a Lobby/Login scene before entering the arena. Vehicle hydration replaces `makeTestVehicle()` in the WS handler — `join_zone` now reads the vehicle from DB and validates token ownership.

**Tech Stack:** Express REST + `jsonwebtoken` + `bcrypt` (auth); `express-validator` (input); Phaser 3.80 scenes (Lobby, Garage, Town, Arena); Tiled JSON tilemaps via Phaser Tilemaps; existing `pg` Pool.

**Parallel streams:**
- **Stream A (Backend)** — Tasks P1, P2, 15b, 16, 17 — auth → vehicle hydration → drivers → economy → division
- **Stream B (Frontend)** — Tasks 11, 12, 14 — tilemap → zone transitions → vehicle designer UI
- **Task 13 (Town)** — depends on both streams; do last

---

### Task P1: Player auth endpoints + JWT middleware

**Files:**
- Create: `server/src/api/auth.ts`
- Create: `server/src/api/middleware.ts`
- Modify: `server/src/main.ts` (mount router)
- Modify: `server/package.json` (add deps)
- Test: `server/tests/auth.test.ts`

**Step 1: Install dependencies**

```bash
cd server && npm install jsonwebtoken bcrypt
npm install --save-dev @types/jsonwebtoken @types/bcrypt
```

**Step 2: Write the failing tests**

Create `server/tests/auth.test.ts`:
```typescript
import request from 'supertest';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';

let app: Express.Application;

beforeAll(async () => {
  app = createApp();
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username = 'testuser'`);
});

afterAll(async () => {
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username = 'testuser'`);
  await closeDb();
});

test('POST /api/auth/register returns 201 and token', async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ username: 'testuser', password: 'hunter2' });
  expect(res.status).toBe(201);
  expect(res.body).toHaveProperty('token');
  expect(res.body).toHaveProperty('playerId');
});

test('POST /api/auth/login returns 200 and token', async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'testuser', password: 'hunter2' });
  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('token');
});

test('POST /api/auth/login wrong password returns 401', async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'testuser', password: 'wrong' });
  expect(res.status).toBe(401);
});

test('GET /api/me returns player data with valid token', async () => {
  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ username: 'testuser', password: 'hunter2' });
  const { token } = loginRes.body;

  const res = await request(app)
    .get('/api/me')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.username).toBe('testuser');
  expect(res.body.money).toBe(25000);
});

test('GET /api/me without token returns 401', async () => {
  const res = await request(app).get('/api/me');
  expect(res.status).toBe(401);
});
```

**Step 3: Run tests — expect failure (no app factory yet)**

```bash
cd server && npx tsx --test tests/auth.test.ts
```
Expected: Error — cannot find module `../src/app`

**Step 4: Refactor main.ts to extract app factory**

Create `server/src/app.ts`:
```typescript
import express from 'express';
import cors from 'cors';
import { authRouter } from './api/auth';

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter);
  app.use('/api/me', meRouter);
  return app;
}
```

Update `server/src/main.ts`:
```typescript
import http from 'http';
import { createApp } from './app';
import { attachWss } from './ws/handler';

const app = createApp();
const server = http.createServer(app);
attachWss(server);
server.listen(3001, () => console.log('Server running on :3001'));
```

**Step 5: Create auth router**

Create `server/src/api/auth.ts`:
```typescript
import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { getDb } from '../db/client';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-prod';
export const SALT_ROUNDS = 10;

export const authRouter = Router();

authRouter.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || username.length > 32 || password.length < 6) {
    return res.status(400).json({ error: 'Invalid username or password' });
  }
  try {
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const db = getDb();
    const result = await db.query(
      `INSERT INTO players (username, password_hash) VALUES ($1, $2) RETURNING id`,
      [username, hash]
    );
    const playerId = result.rows[0].id;
    const token = jwt.sign({ playerId }, JWT_SECRET, { expiresIn: '30d' });
    return res.status(201).json({ token, playerId });
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username taken' });
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

authRouter.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const db = getDb();
  const result = await db.query(`SELECT id, password_hash FROM players WHERE username = $1`, [username]);
  if (!result.rows.length) return res.status(401).json({ error: 'Invalid credentials' });

  const player = result.rows[0];
  const match = await bcrypt.compare(password, player.password_hash);
  if (!match) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ playerId: player.id }, JWT_SECRET, { expiresIn: '30d' });
  return res.json({ token, playerId: player.id });
});
```

**Step 6: Create auth middleware + /api/me route**

Create `server/src/api/middleware.ts`:
```typescript
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-prod';

export interface AuthRequest extends Request {
  playerId?: string;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET) as { playerId: string };
    req.playerId = payload.playerId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}
```

Add `/api/me` to `app.ts`:
```typescript
import { requireAuth, AuthRequest } from './api/middleware';
// ...
app.get('/api/me', requireAuth, async (req: AuthRequest, res) => {
  const db = getDb();
  const result = await db.query(
    `SELECT id, username, money, division, reputation FROM players WHERE id = $1`,
    [req.playerId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
  return res.json(result.rows[0]);
});
```

**Step 7: Run tests — expect pass**

```bash
cd server && npx tsx --test tests/auth.test.ts
```
Expected: 5 tests pass

**Step 8: Commit**

```bash
cd server
git add src/app.ts src/api/auth.ts src/api/middleware.ts src/main.ts tests/auth.test.ts package.json package-lock.json
git commit -m "feat(auth): player register/login endpoints + JWT middleware"
```

---

### Task P2: Vehicle CRUD API + DB hydration in join_zone

**Files:**
- Create: `server/src/api/vehicles.ts`
- Modify: `server/src/app.ts` (mount router)
- Modify: `server/src/ws/handler.ts` (replace makeTestVehicle with DB lookup)
- Test: `server/tests/vehicles.test.ts`

**Step 1: Write failing tests**

Create `server/tests/vehicles.test.ts`:
```typescript
import request from 'supertest';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';

let app: ReturnType<typeof createApp>;
let token: string;
let vehicleId: string;

beforeAll(async () => {
  app = createApp();
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username = 'vehicletest'`);
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ username: 'vehicletest', password: 'password123' });
  token = reg.body.token;
});

afterAll(async () => {
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username = 'vehicletest'`);
  await closeDb();
});

const defaultLoadout = {
  chassisId: 'mid',
  engineId: 'medium',
  suspensionId: 'standard',
  tires: [{ id: 't0', blown: false }, { id: 't1', blown: false }, { id: 't2', blown: false }, { id: 't3', blown: false }],
  mounts: [{ id: 'm0', arc: 'front', weaponId: 'mg', ammo: 50 }],
  armor: { front: 6, back: 4, left: 4, right: 4, top: 2, underbody: 2 },
  totalCost: 12000
};

test('POST /api/vehicles creates a vehicle', async () => {
  const res = await request(app)
    .post('/api/vehicles')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Road Killer', loadout: defaultLoadout });
  expect(res.status).toBe(201);
  expect(res.body).toHaveProperty('id');
  vehicleId = res.body.id;
});

test('GET /api/vehicles lists player vehicles', async () => {
  const res = await request(app)
    .get('/api/vehicles')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.length).toBeGreaterThan(0);
  expect(res.body[0].name).toBe('Road Killer');
});

test('GET /api/vehicles/:id returns vehicle', async () => {
  const res = await request(app)
    .get(`/api/vehicles/${vehicleId}`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.id).toBe(vehicleId);
});

test('GET /api/vehicles/:id owned by another player returns 403', async () => {
  const reg2 = await request(app)
    .post('/api/auth/register')
    .send({ username: 'vehicletest2', password: 'password123' });
  const token2 = reg2.body.token;
  const res = await request(app)
    .get(`/api/vehicles/${vehicleId}`)
    .set('Authorization', `Bearer ${token2}`);
  expect(res.status).toBe(403);
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username = 'vehicletest2'`);
});
```

**Step 2: Run tests — expect failure**

```bash
cd server && npx tsx --test tests/vehicles.test.ts
```
Expected: FAIL — 404 on /api/vehicles

**Step 3: Create vehicles router**

Create `server/src/api/vehicles.ts`:
```typescript
import { Router } from 'express';
import { getDb } from '../db/client';
import { requireAuth, AuthRequest } from './middleware';
import { deriveStats } from '../rules/vehicle';
import type { VehicleLoadout } from '@carwars/shared';

export const vehiclesRouter = Router();
vehiclesRouter.use(requireAuth);

vehiclesRouter.post('/', async (req: AuthRequest, res) => {
  const { name, loadout } = req.body as { name: string; loadout: VehicleLoadout };
  if (!name || !loadout) return res.status(400).json({ error: 'name and loadout required' });
  if (name.length > 64) return res.status(400).json({ error: 'name too long' });

  // Validate loadout is parseable by deriveStats (will throw on bad chassis/engine)
  let stats;
  try {
    stats = deriveStats('tmp', name, loadout);
  } catch (e: any) {
    return res.status(400).json({ error: e.message });
  }

  const defaultDamageState = {
    armor: { ...loadout.armor },
    engineDamaged: false,
    driverWounded: false,
    tiresBlown: [],
    destroyed: false
  };

  const db = getDb();
  const result = await db.query(
    `INSERT INTO vehicles (player_id, name, loadout, damage_state, value)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [req.playerId, name, JSON.stringify(loadout), JSON.stringify(defaultDamageState), loadout.totalCost]
  );
  return res.status(201).json({ id: result.rows[0].id });
});

vehiclesRouter.get('/', async (req: AuthRequest, res) => {
  const db = getDb();
  const result = await db.query(
    `SELECT id, name, loadout, damage_state, value FROM vehicles WHERE player_id = $1`,
    [req.playerId]
  );
  return res.json(result.rows);
});

vehiclesRouter.get('/:id', async (req: AuthRequest, res) => {
  const db = getDb();
  const result = await db.query(
    `SELECT id, player_id, name, loadout, damage_state, value FROM vehicles WHERE id = $1`,
    [req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
  const row = result.rows[0];
  if (row.player_id !== req.playerId) return res.status(403).json({ error: 'Forbidden' });
  return res.json(row);
});
```

**Step 4: Mount in app.ts**

Add to `server/src/app.ts`:
```typescript
import { vehiclesRouter } from './api/vehicles';
// ...
app.use('/api/vehicles', vehiclesRouter);
```

**Step 5: Run tests — expect pass**

```bash
cd server && npx tsx --test tests/vehicles.test.ts
```

**Step 6: Add vehicle hydration to ws/handler.ts**

The `join_zone` message now must carry a `token` field. The handler verifies it, looks up the vehicle from DB, and builds a VehicleState from it instead of calling `makeTestVehicle`.

Extend the shared `ClientMessage` type in `shared/src/types/messages.ts`:
```typescript
export type ClientMessage =
  | { type: 'join_zone'; zoneId: string; vehicleId: string; token?: string }
  | { type: 'input'; tick: number; speed: number; steer: number; fireWeapon: string | null }
  | { type: 'leave_zone' };
```

Modify `server/src/ws/handler.ts` — replace `makeTestVehicle` call for the player vehicle with DB lookup:
```typescript
import jwt from 'jsonwebtoken';
import { getDb } from '../db/client';
import { deriveStats } from '../rules/vehicle';
import type { VehicleState, VehicleLoadout, DamageState } from '@carwars/shared';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-prod';

async function loadVehicleFromDb(vehicleId: string, token: string): Promise<VehicleState | null> {
  let playerId: string;
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { playerId: string };
    playerId = payload.playerId;
  } catch {
    return null;
  }

  const db = getDb();
  const result = await db.query(
    `SELECT id, name, loadout, damage_state FROM vehicles WHERE id = $1 AND player_id = $2`,
    [vehicleId, playerId]
  );
  if (!result.rows.length) return null;

  const row = result.rows[0];
  const loadout = row.loadout as VehicleLoadout;
  const damageState = row.damage_state as DamageState;
  const stats = deriveStats(row.id, row.name, loadout);
  stats.damageState = damageState;

  return {
    id: row.id,
    playerId,
    driverId: null,
    position: { x: 0, y: 0 },
    facing: 0,
    speed: 0,
    stats
  };
}
```

In `handleMessage`, update the `join_zone` branch:
```typescript
if (msg.type === 'join_zone') {
  // ... existing zoneId validation ...

  if (!zones.has(msg.zoneId)) {
    const runner = new ZoneRunner(msg.zoneId);
    runner.getEngine().addVehicle(makeTestVehicle('ai-red', 'ai-team', -8, -6, 90));
    runner.getEngine().addVehicle(makeTestVehicle('ai-blue', 'ai-team', 8, 6, 270));
    zones.set(msg.zoneId, runner);
  }
  clientZones.set(ws, msg.zoneId);
  clientVehicles.set(ws, msg.vehicleId);
  const runner = zones.get(msg.zoneId)!;

  const existing = runner.getEngine().getState().vehicles.find(v => v.id === msg.vehicleId);
  if (!existing) {
    // Try DB hydration first; fall back to test fixture for dev convenience
    let vehicle: VehicleState | null = null;
    if (msg.token) {
      vehicle = await loadVehicleFromDb(msg.vehicleId, msg.token);
    }
    if (!vehicle) {
      vehicle = makeTestVehicle(msg.vehicleId, 'player', 0, 0, 0);
    }
    runner.getEngine().addVehicle(vehicle);
  }
  runner.addClient(ws);
  return;
}
```

Note: `handleMessage` must become `async` and the `ws.on('message', ...)` callback must be updated:
```typescript
ws.on('message', (data) => { handleMessage(ws, data.toString()).catch(console.error); });
```

**Step 7: Commit**

```bash
cd server
git add src/api/vehicles.ts src/app.ts src/ws/handler.ts tests/vehicles.test.ts
git commit -m "feat(vehicles): CRUD API + DB hydration on join_zone"
```

---

### Task 11: Tilemap loading — arena and town zones

**Files:**
- Create: `client/src/tilemaps/arena-1.json` (Tiled JSON format, hand-authored)
- Create: `client/src/tilemaps/town-1.json`
- Create: `client/src/scenes/TilemapScene.ts` (base class)
- Modify: `client/src/scenes/ArenaScene.ts` (extend TilemapScene, load tilemap)
- Test: `client/tests/tilemap.test.ts`

**About Tiled JSON format:** Phaser 3 accepts Tiled JSON export format directly. A minimal tilemap JSON has: `tilewidth`, `tileheight`, `width`, `height` (in tiles), `layers` array (each layer has `type: 'tilelayer'` or `'objectgroup'`), and `tilesets` array. For now we use colored rectangle tiles without actual graphics — just a solid-color tileset.

**Step 1: Create minimal arena tilemap JSON**

Create `client/src/tilemaps/arena-1.json`:
```json
{
  "width": 40,
  "height": 23,
  "tilewidth": 32,
  "tileheight": 32,
  "orientation": "orthogonal",
  "renderorder": "right-down",
  "infinite": false,
  "layers": [
    {
      "id": 1,
      "name": "ground",
      "type": "tilelayer",
      "visible": true,
      "x": 0,
      "y": 0,
      "width": 40,
      "height": 23,
      "opacity": 1,
      "data": []
    },
    {
      "id": 2,
      "name": "walls",
      "type": "tilelayer",
      "visible": true,
      "x": 0,
      "y": 0,
      "width": 40,
      "height": 23,
      "opacity": 1,
      "data": []
    }
  ],
  "tilesets": [
    {
      "firstgid": 1,
      "name": "arena",
      "tilewidth": 32,
      "tileheight": 32,
      "spacing": 0,
      "margin": 0,
      "columns": 2,
      "tilecount": 4,
      "imagewidth": 64,
      "imageheight": 64,
      "image": "tileset-arena.png"
    }
  ]
}
```

Generate the ground layer data programmatically in a script `scripts/gen-tilemap.ts`:
```typescript
// Tile IDs: 1=floor, 2=wall, 3=arena-floor, 4=arena-wall
// Arena interior: tiles 2..37 x 1..21 = floor (ID 3)
// Border ring: wall (ID 4)
// Outer: floor (ID 1)
const W = 40, H = 23;
const ground: number[] = [];
const walls: number[] = [];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const inArena = x >= 2 && x < 38 && y >= 1 && y < 22;
    const isWall = x === 2 || x === 37 || y === 1 || y === 21;
    ground.push(inArena ? 3 : 1);
    walls.push(inArena && isWall ? 4 : 0);
  }
}
// Output as JSON patch for the tilemap
console.log(JSON.stringify({ ground, walls }));
```

Run: `cd client && npx tsx scripts/gen-tilemap.ts > tilemap-data.json`
Then manually paste the `ground` and `walls` arrays into `arena-1.json` layers[0].data and layers[1].data.

**Step 2: Write a test for tilemap JSON validity**

Create `client/tests/tilemap.test.ts`:
```typescript
import arenaMap from '../src/tilemaps/arena-1.json';
import townMap from '../src/tilemaps/town-1.json';

test('arena-1 tilemap has correct dimensions', () => {
  expect(arenaMap.width).toBe(40);
  expect(arenaMap.height).toBe(23);
  expect(arenaMap.layers).toHaveLength(2);
  expect(arenaMap.layers[0].data).toHaveLength(40 * 23);
});

test('town-1 tilemap has required layers', () => {
  expect(townMap.layers.find(l => l.name === 'ground')).toBeDefined();
  expect(townMap.layers.find(l => l.name === 'buildings')).toBeDefined();
});
```

**Step 3: Run — expect failure**

```bash
cd client && npx vitest run tests/tilemap.test.ts
```

**Step 4: Create town-1.json**

Create `client/src/tilemaps/town-1.json` similarly to arena-1 but with:
- `width: 40, height: 23`
- layer `ground` (paved roads + dirt) + layer `buildings` (building tiles for garage, job board)
- Same tileset reference; building tiles are IDs 5–8

Populate layer data: all ground (ID 1), buildings (ID 5) at specific coordinates:
- Garage: tiles 4-6 x 3-6 (3x4 block), tile ID 5
- Job Board: tiles 10-12 x 3-4 (3x2 block), tile ID 6

You can author this directly as a JSON file with hardcoded data arrays.

**Step 5: Run tests — expect pass**

```bash
cd client && npx vitest run tests/tilemap.test.ts
```

**Step 6: Load tilemap in ArenaScene**

Modify `client/src/scenes/ArenaScene.ts`:
- Remove the `drawGrid()` manual graphics approach
- Load the Tiled tilemap in `preload()`:
```typescript
preload(): void {
  // Load tileset spritesheet — a simple 64x64 colored tiles image
  this.load.image('tiles-arena', 'assets/tileset-arena.png');
  this.load.tilemapTiledJSON('arena-1', 'tilemaps/arena-1.json');
}

create(): void {
  const map = this.make.tilemap({ key: 'arena-1' });
  const tileset = map.addTilesetImage('arena', 'tiles-arena');
  map.createLayer('ground', tileset!);
  map.createLayer('walls', tileset!);
  // ... rest of create
}
```

Create a simple programmatic tileset PNG using the Phaser textures API instead of a real image file (avoids asset pipeline for now):
```typescript
// In preload, create a texture programmatically
preload(): void {
  this.load.tilemapTiledJSON('arena-1', 'tilemaps/arena-1.json');
}

create(): void {
  // Create tileset texture programmatically
  const gfx = this.make.graphics({ x: 0, y: 0, add: false });
  gfx.fillStyle(0x111122); gfx.fillRect(0, 0, 32, 32);    // tile 1: outer floor
  gfx.fillStyle(0x1a1a33); gfx.fillRect(32, 0, 32, 32);   // tile 2: unused
  gfx.fillStyle(0x222244); gfx.fillRect(0, 32, 32, 32);   // tile 3: arena floor
  gfx.fillStyle(0x4444aa); gfx.fillRect(32, 32, 32, 32);  // tile 4: arena wall
  gfx.generateTexture('tiles-arena', 64, 64);
  gfx.destroy();

  const map = this.make.tilemap({ key: 'arena-1' });
  const tileset = map.addTilesetImage('arena', 'tiles-arena')!;
  map.createLayer('ground', tileset);
  const wallLayer = map.createLayer('walls', tileset)!;
  wallLayer.setCollisionByExclusion([0]);
  // ... rest of create (connection, sprites, etc.)
}
```

**Step 7: Commit**

```bash
git add client/src/tilemaps/ client/src/scenes/ArenaScene.ts client/tests/tilemap.test.ts
git commit -m "feat(tilemaps): Tiled JSON maps for arena and town zones"
```

---

### Task 12: Zone transition system

**Files:**
- Create: `server/src/api/zones.ts` (REST: GET /api/zones/:id — returns zone metadata)
- Modify: `shared/src/types/world.ts` (add ZoneMetadata type)
- Modify: `shared/src/types/messages.ts` (add zone_change server message)
- Create: `client/src/scenes/TownScene.ts` (stub — fully built in Task 13)
- Modify: `client/src/scenes/ArenaScene.ts` (boundary detection → emit leave, transition to TownScene)
- Test: `server/tests/zones.test.ts`

**Step 1: Extend shared types**

In `shared/src/types/world.ts`, add:
```typescript
export interface ZoneMetadata {
  id: string;
  type: 'arena' | 'town' | 'highway';
  name: string;
  exits: { direction: 'north' | 'south' | 'east' | 'west'; destinationZoneId: string }[];
}
```

In `shared/src/types/messages.ts`, add to ServerMessage:
```typescript
| { type: 'zone_change'; destinationZoneId: string; reason: string }
```

**Step 2: Write zone API tests**

Create `server/tests/zones.test.ts`:
```typescript
import request from 'supertest';
import { createApp } from '../src/app';

const app = createApp();

test('GET /api/zones/arena-1 returns zone metadata', async () => {
  const res = await request(app).get('/api/zones/arena-1');
  expect(res.status).toBe(200);
  expect(res.body.type).toBe('arena');
  expect(res.body.exits).toBeInstanceOf(Array);
});

test('GET /api/zones/town-1 returns zone metadata', async () => {
  const res = await request(app).get('/api/zones/town-1');
  expect(res.status).toBe(200);
  expect(res.body.type).toBe('town');
});

test('GET /api/zones/unknown returns 404', async () => {
  const res = await request(app).get('/api/zones/nonexistent');
  expect(res.status).toBe(404);
});
```

**Step 3: Run — expect failure**

```bash
cd server && npx tsx --test tests/zones.test.ts
```

**Step 4: Create zones router (static registry for now)**

Create `server/src/api/zones.ts`:
```typescript
import { Router } from 'express';
import type { ZoneMetadata } from '@carwars/shared';

export const zonesRouter = Router();

const ZONE_REGISTRY: Record<string, ZoneMetadata> = {
  'arena-1': {
    id: 'arena-1',
    type: 'arena',
    name: 'Autoduel Arena',
    exits: [{ direction: 'south', destinationZoneId: 'town-1' }]
  },
  'town-1': {
    id: 'town-1',
    type: 'town',
    name: 'Midville',
    exits: [{ direction: 'north', destinationZoneId: 'arena-1' }]
  }
};

zonesRouter.get('/:id', (req, res) => {
  const zone = ZONE_REGISTRY[req.params.id];
  if (!zone) return res.status(404).json({ error: 'Zone not found' });
  return res.json(zone);
});
```

Mount in `app.ts`:
```typescript
import { zonesRouter } from './api/zones';
app.use('/api/zones', zonesRouter);
```

**Step 5: Boundary detection in ArenaScene**

Add to `ArenaScene.ts` in `syncSprites()` or a new `checkBoundary()` method:
```typescript
private checkBoundary(v: VehicleState): void {
  if (v.id !== this.myVehicleId) return;
  const MAP_HALF_W = 20; // 40 tiles / 2
  const MAP_HALF_H = 11.5; // 23 tiles / 2
  if (v.position.y < -MAP_HALF_H) {
    this.transitionToZone('town-1');
  }
}

private transitionToZone(zoneId: string): void {
  this.connection.send({ type: 'leave_zone' });
  this.scene.start('TownScene', { zoneId, token: this.token, vehicleId: this.myVehicleId });
}
```

ArenaScene must store `token` and pass it in — update constructor to accept scene data:
```typescript
init(data: { token?: string; vehicleId?: string }): void {
  this.token = data.token ?? '';
  this.myVehicleId = data.vehicleId ?? 'v1';
}
```

**Step 6: Create TownScene stub**

Create `client/src/scenes/TownScene.ts`:
```typescript
import Phaser from 'phaser';

export class TownScene extends Phaser.Scene {
  constructor() { super({ key: 'TownScene' }); }

  init(data: { zoneId: string; token: string; vehicleId: string }): void {
    // Will be filled in Task 13
    console.log('Entered town', data.zoneId);
  }

  create(): void {
    this.add.text(640, 360, 'TOWN — Coming in Task 13', {
      color: '#ffffff', fontSize: '24px', fontFamily: 'monospace'
    }).setOrigin(0.5);

    // Press E to return to arena
    this.input.keyboard!.once('keydown-E', () => {
      this.scene.start('ArenaScene', { token: (this as any).token, vehicleId: (this as any).vehicleId });
    });
  }
}
```

Register in `client/src/main.ts` (or wherever scenes are declared):
```typescript
import { TownScene } from './scenes/TownScene';
// Add to scene array in Phaser.Game config
```

**Step 7: Run zone tests — expect pass**

```bash
cd server && npx tsx --test tests/zones.test.ts
```

**Step 8: Commit**

```bash
git add server/src/api/zones.ts server/src/app.ts server/tests/zones.test.ts \
        shared/src/types/world.ts shared/src/types/messages.ts \
        client/src/scenes/ArenaScene.ts client/src/scenes/TownScene.ts
git commit -m "feat(zones): zone metadata API + ArenaScene boundary → TownScene transition"
```

---

### Task 15b: Driver CRUD API

**Files:**
- Create: `server/src/api/drivers.ts`
- Modify: `server/src/app.ts`
- Test: `server/tests/drivers.test.ts`

**Step 1: Write failing tests**

Create `server/tests/drivers.test.ts`:
```typescript
import request from 'supertest';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';

let app: ReturnType<typeof createApp>;
let token: string;
let driverId: string;

beforeAll(async () => {
  app = createApp();
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username = 'drivertest'`);
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ username: 'drivertest', password: 'password123' });
  token = reg.body.token;
});

afterAll(async () => {
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username = 'drivertest'`);
  await closeDb();
});

test('POST /api/drivers hires a driver', async () => {
  const res = await request(app)
    .post('/api/drivers')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Mad Max' });
  expect(res.status).toBe(201);
  expect(res.body).toHaveProperty('id');
  driverId = res.body.id;
});

test('GET /api/drivers lists player drivers', async () => {
  const res = await request(app)
    .get('/api/drivers')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.some((d: any) => d.id === driverId)).toBe(true);
});

test('POST /api/drivers/assign assigns driver to vehicle', async () => {
  // Create a vehicle first
  const vRes = await request(app)
    .post('/api/vehicles')
    .set('Authorization', `Bearer ${token}`)
    .send({
      name: 'Test Car',
      loadout: {
        chassisId: 'mid', engineId: 'medium', suspensionId: 'standard',
        tires: [{ id: 't0', blown: false }, { id: 't1', blown: false },
                { id: 't2', blown: false }, { id: 't3', blown: false }],
        mounts: [], armor: { front: 4, back: 4, left: 4, right: 4, top: 2, underbody: 2 },
        totalCost: 10000
      }
    });
  const vehicleId = vRes.body.id;

  const res = await request(app)
    .post('/api/drivers/assign')
    .set('Authorization', `Bearer ${token}`)
    .send({ driverId, vehicleId });
  expect(res.status).toBe(200);
});
```

**Step 2: Run — expect failure**

```bash
cd server && npx tsx --test tests/drivers.test.ts
```

**Step 3: Create drivers router**

Create `server/src/api/drivers.ts`:
```typescript
import { Router } from 'express';
import { getDb } from '../db/client';
import { requireAuth, AuthRequest } from './middleware';

export const driversRouter = Router();
driversRouter.use(requireAuth);

driversRouter.post('/', async (req: AuthRequest, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || name.length > 64) {
    return res.status(400).json({ error: 'Invalid name' });
  }
  const db = getDb();
  const result = await db.query(
    `INSERT INTO drivers (player_id, name) VALUES ($1, $2) RETURNING id, name, skill, aggression, loyalty, xp`,
    [req.playerId, name]
  );
  return res.status(201).json(result.rows[0]);
});

driversRouter.get('/', async (req: AuthRequest, res) => {
  const db = getDb();
  const result = await db.query(
    `SELECT id, name, skill, aggression, loyalty, xp, assigned_vehicle_id, alive
     FROM drivers WHERE player_id = $1`,
    [req.playerId]
  );
  return res.json(result.rows);
});

driversRouter.post('/assign', async (req: AuthRequest, res) => {
  const { driverId, vehicleId } = req.body;
  if (!driverId || !vehicleId) return res.status(400).json({ error: 'driverId and vehicleId required' });

  const db = getDb();
  // Verify both belong to this player
  const [driverCheck, vehicleCheck] = await Promise.all([
    db.query(`SELECT id FROM drivers WHERE id = $1 AND player_id = $2`, [driverId, req.playerId]),
    db.query(`SELECT id FROM vehicles WHERE id = $1 AND player_id = $2`, [vehicleId, req.playerId])
  ]);
  if (!driverCheck.rows.length) return res.status(403).json({ error: 'Driver not found' });
  if (!vehicleCheck.rows.length) return res.status(403).json({ error: 'Vehicle not found' });

  await db.query(`UPDATE drivers SET assigned_vehicle_id = $1 WHERE id = $2`, [vehicleId, driverId]);
  return res.json({ ok: true });
});
```

Mount in `app.ts`:
```typescript
import { driversRouter } from './api/drivers';
app.use('/api/drivers', driversRouter);
```

**Step 4: Run tests — expect pass**

```bash
cd server && npx tsx --test tests/drivers.test.ts
```

**Step 5: Commit**

```bash
git add server/src/api/drivers.ts server/src/app.ts server/tests/drivers.test.ts
git commit -m "feat(drivers): driver hire and vehicle assignment API"
```

---

### Task 16: Campaign economy — repairs, prizes, wages

**Files:**
- Create: `server/src/api/economy.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/db/schema.sql` (add jobs table)
- Test: `server/tests/economy.test.ts`

**Step 1: Add jobs table to schema**

Append to `server/src/db/schema.sql`:
```sql
CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id TEXT NOT NULL,
  job_type TEXT NOT NULL,  -- 'escort' | 'ambush' | 'delivery' | 'arena'
  description TEXT NOT NULL,
  payout INTEGER NOT NULL,
  division_min INTEGER NOT NULL DEFAULT 5,
  taken_by UUID REFERENCES players(id) ON DELETE SET NULL,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_jobs_zone_id ON jobs(zone_id);
```

Re-run migration:
```bash
cd server && DATABASE_URL=postgresql://localhost/carwars npx tsx src/db/migrate.ts
```

**Step 2: Write failing tests**

Create `server/tests/economy.test.ts`:
```typescript
import request from 'supertest';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';

let app: ReturnType<typeof createApp>;
let token: string;
let playerId: string;
let vehicleId: string;

beforeAll(async () => {
  app = createApp();
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username = 'econtest'`);
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ username: 'econtest', password: 'password123' });
  token = reg.body.token;
  playerId = reg.body.playerId;
  // Create a vehicle for repair tests
  const vRes = await request(app)
    .post('/api/vehicles')
    .set('Authorization', `Bearer ${token}`)
    .send({
      name: 'Dented Wreck',
      loadout: {
        chassisId: 'mid', engineId: 'medium', suspensionId: 'standard',
        tires: [{ id: 't0', blown: false }, { id: 't1', blown: false },
                { id: 't2', blown: false }, { id: 't3', blown: false }],
        mounts: [{ id: 'm0', arc: 'front', weaponId: 'mg', ammo: 50 }],
        armor: { front: 6, back: 4, left: 4, right: 4, top: 2, underbody: 2 },
        totalCost: 12000
      }
    });
  vehicleId = vRes.body.id;
});

afterAll(async () => {
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username = 'econtest'`);
  await closeDb();
});

test('GET /api/jobs?zoneId=town-1 returns available jobs', async () => {
  const res = await request(app)
    .get('/api/jobs?zoneId=town-1')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body).toBeInstanceOf(Array);
});

test('POST /api/economy/repair deducts money and restores armor', async () => {
  // Damage the vehicle first
  const db = getDb();
  await db.query(
    `UPDATE vehicles SET damage_state = $1 WHERE id = $2`,
    [JSON.stringify({
      armor: { front: 2, back: 2, left: 2, right: 2, top: 1, underbody: 1 },
      engineDamaged: false, driverWounded: false, tiresBlown: [], destroyed: false
    }), vehicleId]
  );

  const res = await request(app)
    .post('/api/economy/repair')
    .set('Authorization', `Bearer ${token}`)
    .send({ vehicleId });
  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('cost');
  expect(res.body.cost).toBeGreaterThan(0);
  expect(res.body.moneyRemaining).toBeLessThan(25000);
});

test('POST /api/economy/repair fails if insufficient funds', async () => {
  // Set money to 0
  const db = getDb();
  await db.query(`UPDATE players SET money = 0 WHERE id = $1`, [playerId]);
  await db.query(
    `UPDATE vehicles SET damage_state = $1 WHERE id = $2`,
    [JSON.stringify({
      armor: { front: 0, back: 0, left: 0, right: 0, top: 0, underbody: 0 },
      engineDamaged: true, driverWounded: false, tiresBlown: [], destroyed: false
    }), vehicleId]
  );

  const res = await request(app)
    .post('/api/economy/repair')
    .set('Authorization', `Bearer ${token}`)
    .send({ vehicleId });
  expect(res.status).toBe(402);
});
```

**Step 3: Run — expect failure**

```bash
cd server && npx tsx --test tests/economy.test.ts
```

**Step 4: Create economy router**

Create `server/src/api/economy.ts`:
```typescript
import { Router } from 'express';
import { getDb } from '../db/client';
import { requireAuth, AuthRequest } from './middleware';
import type { VehicleLoadout, DamageState, ArmorDistribution } from '@carwars/shared';

export const economyRouter = Router();
economyRouter.use(requireAuth);

// Cost per point of armor restored
const ARMOR_REPAIR_COST = 100;
const ENGINE_REPAIR_COST = 500;

economyRouter.post('/repair', async (req: AuthRequest, res) => {
  const { vehicleId } = req.body;
  if (!vehicleId) return res.status(400).json({ error: 'vehicleId required' });

  const db = getDb();
  const [vResult, pResult] = await Promise.all([
    db.query(
      `SELECT v.id, v.loadout, v.damage_state, v.player_id
       FROM vehicles v WHERE v.id = $1 AND v.player_id = $2`,
      [vehicleId, req.playerId]
    ),
    db.query(`SELECT money FROM players WHERE id = $1`, [req.playerId])
  ]);

  if (!vResult.rows.length) return res.status(403).json({ error: 'Vehicle not found' });
  const vehicle = vResult.rows[0];
  const loadout = vehicle.loadout as VehicleLoadout;
  const damage = vehicle.damage_state as DamageState;
  const playerMoney = pResult.rows[0].money as number;

  // Calculate repair cost
  let cost = 0;
  const locations: (keyof ArmorDistribution)[] = ['front', 'back', 'left', 'right', 'top', 'underbody'];
  const repairedArmor = { ...loadout.armor };
  for (const loc of locations) {
    const current = (damage.armor[loc] ?? 0);
    const original = loadout.armor[loc];
    const deficit = original - current;
    if (deficit > 0) cost += deficit * ARMOR_REPAIR_COST;
  }
  if (damage.engineDamaged) cost += ENGINE_REPAIR_COST;

  if (cost === 0) return res.json({ cost: 0, moneyRemaining: playerMoney });
  if (playerMoney < cost) return res.status(402).json({ error: 'Insufficient funds', cost });

  // Apply repair
  const repairedDamage: DamageState = {
    armor: repairedArmor,
    engineDamaged: false,
    driverWounded: damage.driverWounded,
    tiresBlown: [],
    destroyed: false
  };

  await db.query(`BEGIN`);
  try {
    await db.query(
      `UPDATE vehicles SET damage_state = $1 WHERE id = $2`,
      [JSON.stringify(repairedDamage), vehicleId]
    );
    await db.query(
      `UPDATE players SET money = money - $1 WHERE id = $2`,
      [cost, req.playerId]
    );
    await db.query(
      `INSERT INTO event_history (player_id, event_type, result, money_delta)
       VALUES ($1, 'repair', $2, $3)`,
      [req.playerId, JSON.stringify({ vehicleId, cost }), -cost]
    );
    await db.query(`COMMIT`);
  } catch (e) {
    await db.query(`ROLLBACK`);
    throw e;
  }

  return res.json({ cost, moneyRemaining: playerMoney - cost });
});

// Jobs listing
export const jobsRouter = Router();
jobsRouter.use(requireAuth);

// Seed some static jobs if table is empty for a zone
const STATIC_JOBS: Record<string, { job_type: string; description: string; payout: number; division_min: number }[]> = {
  'town-1': [
    { job_type: 'escort', description: 'Escort a cargo truck to the next town', payout: 3000, division_min: 5 },
    { job_type: 'delivery', description: 'Deliver a sealed crate — no questions asked', payout: 2500, division_min: 5 },
    { job_type: 'ambush', description: 'Intercept a rival courier on Route 66', payout: 4000, division_min: 10 }
  ]
};

jobsRouter.get('/', async (req: AuthRequest, res) => {
  const zoneId = req.query.zoneId as string;
  if (!zoneId) return res.status(400).json({ error: 'zoneId required' });

  const db = getDb();
  // Seed static jobs if none exist for this zone
  const existing = await db.query(`SELECT id FROM jobs WHERE zone_id = $1 LIMIT 1`, [zoneId]);
  if (!existing.rows.length && STATIC_JOBS[zoneId]) {
    for (const job of STATIC_JOBS[zoneId]) {
      await db.query(
        `INSERT INTO jobs (zone_id, job_type, description, payout, division_min) VALUES ($1,$2,$3,$4,$5)`,
        [zoneId, job.job_type, job.description, job.payout, job.division_min]
      );
    }
  }

  // Get player division for filtering
  const pResult = await db.query(`SELECT division FROM players WHERE id = $1`, [req.playerId]);
  const playerDiv = pResult.rows[0]?.division ?? 5;

  const result = await db.query(
    `SELECT id, job_type, description, payout, division_min
     FROM jobs WHERE zone_id = $1 AND completed = FALSE AND taken_by IS NULL
     AND division_min <= $2`,
    [zoneId, playerDiv]
  );
  return res.json(result.rows);
});
```

Mount in `app.ts`:
```typescript
import { economyRouter, jobsRouter } from './api/economy';
app.use('/api/economy', economyRouter);
app.use('/api/jobs', jobsRouter);
```

**Step 5: Run tests — expect pass**

```bash
cd server && npx tsx --test tests/economy.test.ts
```

**Step 6: Commit**

```bash
git add server/src/api/economy.ts server/src/app.ts server/src/db/schema.sql server/tests/economy.test.ts
git commit -m "feat(economy): repair costs, job board API, event history"
```

---

### Task 17: Division system

**Files:**
- Create: `server/src/api/division.ts`
- Modify: `server/src/app.ts`
- Test: `server/tests/division.test.ts`

**Step 1: Division thresholds**

Car Wars divisions are based on vehicle value (totalCost of current loadout):
- Div 5: $0–$9,999
- Div 10: $10,000–$24,999
- Div 15: $25,000–$49,999
- Div 20: $50,000–$99,999
- Div 25+: $100,000+

**Step 2: Write failing tests**

Create `server/tests/division.test.ts`:
```typescript
import request from 'supertest';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';

let app: ReturnType<typeof createApp>;
let token: string;
let playerId: string;

beforeAll(async () => {
  app = createApp();
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username = 'divtest'`);
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ username: 'divtest', password: 'password123' });
  token = reg.body.token;
  playerId = reg.body.playerId;
});

afterAll(async () => {
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username = 'divtest'`);
  await closeDb();
});

test('GET /api/division returns player division and standings', async () => {
  const res = await request(app)
    .get('/api/division')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.division).toBe(5);
  expect(res.body).toHaveProperty('standings');
});

test('POST /api/division/recalculate updates division based on vehicle value', async () => {
  // Give the player a high-value vehicle
  const db = getDb();
  await db.query(
    `INSERT INTO vehicles (player_id, name, loadout, damage_state, value)
     VALUES ($1, 'Expensive', '{"chassisId":"heavy","engineId":"v8","suspensionId":"performance","tires":[],"mounts":[],"armor":{"front":10,"back":8,"left":8,"right":8,"top":4,"underbody":4},"totalCost":30000}'::jsonb, '{}'::jsonb, 30000)`,
    [playerId]
  );

  const res = await request(app)
    .post('/api/division/recalculate')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.division).toBe(15); // $25k-$49k → Div 15
});

test('POST /api/economy/prize awards money and triggers division recalc', async () => {
  const res = await request(app)
    .post('/api/economy/prize')
    .set('Authorization', `Bearer ${token}`)
    .send({ amount: 5000, eventType: 'arena_win', zoneId: 'arena-1' });
  expect(res.status).toBe(200);
  expect(res.body.moneyNew).toBeGreaterThan(25000);
});
```

**Step 3: Run — expect failure**

```bash
cd server && npx tsx --test tests/division.test.ts
```

**Step 4: Create division router**

Create `server/src/api/division.ts`:
```typescript
import { Router } from 'express';
import { getDb } from '../db/client';
import { requireAuth, AuthRequest } from './middleware';

export const divisionRouter = Router();
divisionRouter.use(requireAuth);

const DIVISION_THRESHOLDS = [
  { division: 25, minValue: 100000 },
  { division: 20, minValue: 50000 },
  { division: 15, minValue: 25000 },
  { division: 10, minValue: 10000 },
  { division: 5, minValue: 0 }
];

export function calcDivision(topVehicleValue: number): number {
  for (const { division, minValue } of DIVISION_THRESHOLDS) {
    if (topVehicleValue >= minValue) return division;
  }
  return 5;
}

divisionRouter.get('/', async (req: AuthRequest, res) => {
  const db = getDb();
  const pResult = await db.query(
    `SELECT division, money, reputation FROM players WHERE id = $1`,
    [req.playerId]
  );
  if (!pResult.rows.length) return res.status(404).json({ error: 'Not found' });
  const player = pResult.rows[0];

  // Top 10 standings in this division
  const standings = await db.query(
    `SELECT p.username, p.money, p.reputation FROM players p WHERE p.division = $1
     ORDER BY p.reputation DESC LIMIT 10`,
    [player.division]
  );

  return res.json({
    division: player.division,
    money: player.money,
    reputation: player.reputation,
    standings: standings.rows
  });
});

divisionRouter.post('/recalculate', async (req: AuthRequest, res) => {
  const db = getDb();
  const vResult = await db.query(
    `SELECT MAX(value) as top_value FROM vehicles WHERE player_id = $1`,
    [req.playerId]
  );
  const topValue = vResult.rows[0]?.top_value ?? 0;
  const newDivision = calcDivision(topValue);

  await db.query(`UPDATE players SET division = $1 WHERE id = $2`, [newDivision, req.playerId]);
  return res.json({ division: newDivision, topVehicleValue: topValue });
});
```

Add prize endpoint to `economy.ts`:
```typescript
economyRouter.post('/prize', async (req: AuthRequest, res) => {
  const { amount, eventType, zoneId } = req.body;
  if (!amount || typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const db = getDb();
  await db.query(`BEGIN`);
  try {
    await db.query(`UPDATE players SET money = money + $1 WHERE id = $2`, [amount, req.playerId]);
    await db.query(
      `UPDATE players SET reputation = reputation + $1 WHERE id = $2`,
      [Math.floor(amount / 500), req.playerId]
    );
    await db.query(
      `INSERT INTO event_history (player_id, event_type, result, money_delta)
       VALUES ($1, $2, $3, $4)`,
      [req.playerId, eventType ?? 'prize', JSON.stringify({ zoneId }), amount]
    );
    await db.query(`COMMIT`);
  } catch (e) {
    await db.query(`ROLLBACK`);
    throw e;
  }

  const pResult = await db.query(`SELECT money FROM players WHERE id = $1`, [req.playerId]);
  return res.json({ moneyNew: pResult.rows[0].money });
});
```

Mount division router in `app.ts`:
```typescript
import { divisionRouter } from './api/division';
app.use('/api/division', divisionRouter);
```

**Step 5: Run tests — expect pass**

```bash
cd server && npx tsx --test tests/division.test.ts
```

**Step 6: Commit**

```bash
git add server/src/api/division.ts server/src/api/economy.ts server/src/app.ts server/tests/division.test.ts
git commit -m "feat(division): division thresholds, standings, prize award API"
```

---

### Task 14: Vehicle designer UI (point-buy)

**Files:**
- Create: `client/src/scenes/VehicleDesignerScene.ts`
- Create: `client/src/ui/DesignerUI.ts` (point-buy panel)
- Modify: `client/src/main.ts` (register scene)
- Test: `client/tests/designer.test.ts`

**Step 1: Write unit tests for cost calculation**

Create `client/tests/designer.test.ts`:
```typescript
import { calculateLoadoutCost, validateLoadout } from '../src/ui/DesignerUI';

test('calculateLoadoutCost sums chassis + engine + armor + weapons', () => {
  const loadout = {
    chassisId: 'mid',
    engineId: 'medium',
    suspensionId: 'standard',
    tires: [{ id: 't0', blown: false }, { id: 't1', blown: false },
            { id: 't2', blown: false }, { id: 't3', blown: false }],
    mounts: [{ id: 'm0', arc: 'front' as const, weaponId: 'mg', ammo: 50 }],
    armor: { front: 6, back: 4, left: 4, right: 4, top: 2, underbody: 2 },
    totalCost: 0
  };
  const cost = calculateLoadoutCost(loadout);
  expect(cost).toBeGreaterThan(0);
  expect(cost).toBeLessThan(50000); // reasonable for base setup
});

test('validateLoadout returns errors for invalid loadout', () => {
  const errors = validateLoadout({ chassisId: 'mid', engineId: 'medium', suspensionId: 'standard',
    tires: [], mounts: [], armor: { front: 0, back: 0, left: 0, right: 0, top: 0, underbody: 0 }, totalCost: 0 });
  expect(errors.length).toBeGreaterThan(0); // no tires
});

test('validateLoadout returns empty for valid loadout', () => {
  const errors = validateLoadout({
    chassisId: 'mid', engineId: 'medium', suspensionId: 'standard',
    tires: [{ id: 't0', blown: false }, { id: 't1', blown: false },
            { id: 't2', blown: false }, { id: 't3', blown: false }],
    mounts: [{ id: 'm0', arc: 'front', weaponId: 'mg', ammo: 50 }],
    armor: { front: 4, back: 4, left: 4, right: 4, top: 2, underbody: 2 },
    totalCost: 0
  });
  expect(errors).toHaveLength(0);
});
```

**Step 2: Run — expect failure**

```bash
cd client && npx vitest run tests/designer.test.ts
```

**Step 3: Create DesignerUI utility**

Create `client/src/ui/DesignerUI.ts`:
```typescript
import type { VehicleLoadout } from '@carwars/shared';

// Mirror data from server/src/rules/data — client needs costs too
const CHASSIS_COSTS: Record<string, number> = { light: 2000, mid: 3000, heavy: 5000, van: 4000 };
const ENGINE_COSTS: Record<string, number> = { small: 1000, medium: 2000, large: 4000, v8: 8000 };
const SUSPENSION_COSTS: Record<string, number> = { standard: 500, performance: 1500 };
const TIRE_COST = 100;
const ARMOR_COST_PER_POINT = 100;
const WEAPON_COSTS: Record<string, number> = { mg: 500, hmg: 1000, rl: 1500, laser: 3000, oil: 200, mine: 300 };
const AMMO_COST_PER_SHOT = 5;

export function calculateLoadoutCost(loadout: VehicleLoadout): number {
  let cost = 0;
  cost += CHASSIS_COSTS[loadout.chassisId] ?? 0;
  cost += ENGINE_COSTS[loadout.engineId] ?? 0;
  cost += SUSPENSION_COSTS[loadout.suspensionId] ?? 0;
  cost += loadout.tires.length * TIRE_COST;
  for (const mount of loadout.mounts) {
    cost += WEAPON_COSTS[mount.weaponId ?? ''] ?? 0;
    cost += mount.ammo * AMMO_COST_PER_SHOT;
  }
  const armor = loadout.armor;
  cost += (armor.front + armor.back + armor.left + armor.right + armor.top + armor.underbody) * ARMOR_COST_PER_POINT;
  return cost;
}

export function validateLoadout(loadout: VehicleLoadout): string[] {
  const errors: string[] = [];
  if (loadout.tires.length < 4) errors.push('Vehicle needs 4 tires');
  if (!CHASSIS_COSTS[loadout.chassisId]) errors.push(`Unknown chassis: ${loadout.chassisId}`);
  if (!ENGINE_COSTS[loadout.engineId]) errors.push(`Unknown engine: ${loadout.engineId}`);
  return errors;
}
```

**Step 4: Run tests — expect pass**

```bash
cd client && npx vitest run tests/designer.test.ts
```

**Step 5: Create VehicleDesignerScene**

Create `client/src/scenes/VehicleDesignerScene.ts`:
```typescript
import Phaser from 'phaser';
import type { VehicleLoadout } from '@carwars/shared';
import { calculateLoadoutCost, validateLoadout } from '../ui/DesignerUI';

const CHASSIS_OPTIONS = ['light', 'mid', 'heavy'];
const ENGINE_OPTIONS = ['small', 'medium', 'large', 'v8'];
const WEAPON_OPTIONS = ['mg', 'hmg', 'rl', 'laser', 'oil', 'mine'];

export class VehicleDesignerScene extends Phaser.Scene {
  private token = '';
  private loadout: VehicleLoadout = {
    chassisId: 'mid', engineId: 'medium', suspensionId: 'standard',
    tires: [{ id: 't0', blown: false }, { id: 't1', blown: false },
            { id: 't2', blown: false }, { id: 't3', blown: false }],
    mounts: [{ id: 'm0', arc: 'front', weaponId: 'mg', ammo: 50 }],
    armor: { front: 6, back: 4, left: 4, right: 4, top: 2, underbody: 2 },
    totalCost: 0
  };
  private nameInput = 'My Car';
  private costText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;

  constructor() { super({ key: 'VehicleDesignerScene' }); }

  init(data: { token: string }): void {
    this.token = data.token;
  }

  create(): void {
    this.add.text(640, 30, 'VEHICLE DESIGNER', {
      color: '#ff4444', fontSize: '28px', fontFamily: 'monospace', fontStyle: 'bold'
    }).setOrigin(0.5);

    // Chassis selector
    this.add.text(100, 100, 'Chassis:', { color: '#cccccc', fontSize: '16px', fontFamily: 'monospace' });
    CHASSIS_OPTIONS.forEach((id, i) => {
      const btn = this.add.text(100 + i * 120, 125, id, {
        color: this.loadout.chassisId === id ? '#00ff88' : '#888888',
        fontSize: '14px', fontFamily: 'monospace',
        backgroundColor: '#222233', padding: { x: 8, y: 4 }
      }).setInteractive();
      btn.on('pointerdown', () => {
        this.loadout.chassisId = id;
        this.scene.restart({ token: this.token });
      });
    });

    // Engine selector
    this.add.text(100, 170, 'Engine:', { color: '#cccccc', fontSize: '16px', fontFamily: 'monospace' });
    ENGINE_OPTIONS.forEach((id, i) => {
      const btn = this.add.text(100 + i * 130, 195, id, {
        color: this.loadout.engineId === id ? '#00ff88' : '#888888',
        fontSize: '14px', fontFamily: 'monospace',
        backgroundColor: '#222233', padding: { x: 8, y: 4 }
      }).setInteractive();
      btn.on('pointerdown', () => {
        this.loadout.engineId = id;
        this.scene.restart({ token: this.token });
      });
    });

    // Weapon selector
    this.add.text(100, 250, 'Weapon (front mount):', { color: '#cccccc', fontSize: '16px', fontFamily: 'monospace' });
    WEAPON_OPTIONS.forEach((id, i) => {
      const x = 100 + (i % 3) * 160;
      const y = 275 + Math.floor(i / 3) * 35;
      const currentWeapon = this.loadout.mounts[0]?.weaponId;
      const btn = this.add.text(x, y, id, {
        color: currentWeapon === id ? '#00ff88' : '#888888',
        fontSize: '14px', fontFamily: 'monospace',
        backgroundColor: '#222233', padding: { x: 8, y: 4 }
      }).setInteractive();
      btn.on('pointerdown', () => {
        this.loadout.mounts = [{ id: 'm0', arc: 'front', weaponId: id, ammo: 50 }];
        this.scene.restart({ token: this.token });
      });
    });

    // Cost display
    const cost = calculateLoadoutCost(this.loadout);
    this.loadout.totalCost = cost;
    this.costText = this.add.text(640, 500, `Cost: $${cost.toLocaleString()}`, {
      color: '#ffcc00', fontSize: '20px', fontFamily: 'monospace'
    }).setOrigin(0.5);

    this.statusText = this.add.text(640, 550, '', {
      color: '#ff4444', fontSize: '14px', fontFamily: 'monospace'
    }).setOrigin(0.5);

    // Save button
    const saveBtn = this.add.text(640, 610, '[ BUILD THIS CAR ]', {
      color: '#00ff88', fontSize: '20px', fontFamily: 'monospace',
      backgroundColor: '#003322', padding: { x: 16, y: 8 }
    }).setOrigin(0.5).setInteractive();

    saveBtn.on('pointerdown', () => this.saveVehicle());

    // Back button
    const backBtn = this.add.text(100, 680, '[ BACK ]', {
      color: '#888888', fontSize: '16px', fontFamily: 'monospace'
    }).setInteractive();
    backBtn.on('pointerdown', () => this.scene.start('GarageScene', { token: this.token }));
  }

  private async saveVehicle(): Promise<void> {
    const errors = validateLoadout(this.loadout);
    if (errors.length) {
      this.statusText.setText(errors[0]);
      return;
    }
    try {
      const host = window.location.hostname;
      const res = await fetch(`http://${host}:3001/api/vehicles`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({ name: this.nameInput, loadout: this.loadout })
      });
      if (res.ok) {
        this.statusText.setColor('#00ff88').setText('Vehicle created!');
        this.time.delayedCall(1500, () => this.scene.start('GarageScene', { token: this.token }));
      } else {
        const err = await res.json();
        this.statusText.setText(err.error ?? 'Save failed');
      }
    } catch {
      this.statusText.setText('Network error');
    }
  }
}
```

Register in `client/src/main.ts`:
```typescript
import { VehicleDesignerScene } from './scenes/VehicleDesignerScene';
// Add VehicleDesignerScene to game config scenes array
```

**Step 6: Commit**

```bash
git add client/src/scenes/VehicleDesignerScene.ts client/src/ui/DesignerUI.ts \
        client/src/main.ts client/tests/designer.test.ts
git commit -m "feat(designer): vehicle designer scene with point-buy UI"
```

---

### Task 13: Town scene — garage screen + job board

**Files:**
- Modify: `client/src/scenes/TownScene.ts` (replace stub with full town scene)
- Create: `client/src/scenes/GarageScene.ts`
- Create: `client/src/scenes/JobBoardScene.ts`
- Test: `client/tests/town.test.ts` (API integration)

**This task requires both Stream A (economy API) and Stream B (tilemap) to be complete.**

**Step 1: Write API integration tests**

Create `client/tests/town.test.ts` — these are fetch-based integration tests against the running server. They verify the sequence of garage interactions: load vehicles, select one, repair it, then load jobs.

```typescript
// Run with: npx vitest run tests/town.test.ts
// Requires server to be running on :3001

const BASE = 'http://localhost:3001';

async function register(username: string) {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'testpass123' })
  });
  const body = await res.json();
  return body.token as string;
}

test('can fetch vehicles with token', async () => {
  const token = await register('towntest1');
  const res = await fetch(`${BASE}/api/vehicles`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body)).toBe(true);
}, { timeout: 10000 });

test('can fetch jobs for town-1', async () => {
  const token = await register('towntest2');
  const res = await fetch(`${BASE}/api/jobs?zoneId=town-1`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.length).toBeGreaterThan(0);
}, { timeout: 10000 });
```

**Step 2: Create GarageScene**

Create `client/src/scenes/GarageScene.ts`:
```typescript
import Phaser from 'phaser';

interface Vehicle { id: string; name: string; value: number; damage_state: any; }

export class GarageScene extends Phaser.Scene {
  private token = '';
  private vehicles: Vehicle[] = [];
  private money = 0;

  constructor() { super({ key: 'GarageScene' }); }

  init(data: { token: string }): void { this.token = data.token; }

  async create(): Promise<void> {
    const host = window.location.hostname;

    // Load player data
    const [meRes, vRes] = await Promise.all([
      fetch(`http://${host}:3001/api/me`, { headers: { Authorization: `Bearer ${this.token}` } }),
      fetch(`http://${host}:3001/api/vehicles`, { headers: { Authorization: `Bearer ${this.token}` } })
    ]);
    const me = await meRes.json();
    this.money = me.money ?? 0;
    this.vehicles = await vRes.json();

    this.add.text(640, 30, 'GARAGE', {
      color: '#ff4444', fontSize: '28px', fontFamily: 'monospace', fontStyle: 'bold'
    }).setOrigin(0.5);

    this.add.text(100, 70, `Money: $${this.money.toLocaleString()} | Division: ${me.division}`, {
      color: '#ffcc00', fontSize: '16px', fontFamily: 'monospace'
    });

    if (this.vehicles.length === 0) {
      this.add.text(640, 300, 'No vehicles. Build one!', {
        color: '#888888', fontSize: '18px', fontFamily: 'monospace'
      }).setOrigin(0.5);
    } else {
      this.vehicles.forEach((v, i) => {
        const y = 140 + i * 60;
        const color = v.damage_state?.destroyed ? '#ff4444' : '#00ff88';
        this.add.text(100, y, `${v.name}  $${v.value.toLocaleString()}`, {
          color, fontSize: '16px', fontFamily: 'monospace'
        });
        // Repair button
        const repairBtn = this.add.text(500, y, '[REPAIR]', {
          color: '#ffcc00', fontSize: '14px', fontFamily: 'monospace',
          backgroundColor: '#332200', padding: { x: 6, y: 3 }
        }).setInteractive();
        repairBtn.on('pointerdown', () => this.repairVehicle(v.id));

        // Enter arena button
        const arenaBtn = this.add.text(620, y, '[FIGHT]', {
          color: '#00ff88', fontSize: '14px', fontFamily: 'monospace',
          backgroundColor: '#003322', padding: { x: 6, y: 3 }
        }).setInteractive();
        arenaBtn.on('pointerdown', () => {
          this.scene.start('ArenaScene', { token: this.token, vehicleId: v.id });
        });
      });
    }

    // Nav buttons
    const buildBtn = this.add.text(100, 600, '[BUILD NEW CAR]', {
      color: '#aaaaff', fontSize: '16px', fontFamily: 'monospace',
      backgroundColor: '#111133', padding: { x: 8, y: 4 }
    }).setInteractive();
    buildBtn.on('pointerdown', () => this.scene.start('VehicleDesignerScene', { token: this.token }));

    const jobsBtn = this.add.text(400, 600, '[JOB BOARD]', {
      color: '#ffaaaa', fontSize: '16px', fontFamily: 'monospace',
      backgroundColor: '#331111', padding: { x: 8, y: 4 }
    }).setInteractive();
    jobsBtn.on('pointerdown', () => this.scene.start('JobBoardScene', { token: this.token }));
  }

  private async repairVehicle(vehicleId: string): Promise<void> {
    const host = window.location.hostname;
    const res = await fetch(`http://${host}:3001/api/economy/repair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ vehicleId })
    });
    const body = await res.json();
    if (res.ok) {
      this.scene.restart({ token: this.token });
    } else {
      // Show error
      this.add.text(640, 650, body.error ?? 'Repair failed', {
        color: '#ff4444', fontSize: '14px', fontFamily: 'monospace'
      }).setOrigin(0.5);
    }
  }
}
```

**Step 3: Create JobBoardScene**

Create `client/src/scenes/JobBoardScene.ts`:
```typescript
import Phaser from 'phaser';

interface Job { id: string; job_type: string; description: string; payout: number; }

export class JobBoardScene extends Phaser.Scene {
  private token = '';
  constructor() { super({ key: 'JobBoardScene' }); }
  init(data: { token: string }): void { this.token = data.token; }

  async create(): Promise<void> {
    const host = window.location.hostname;
    const res = await fetch(`http://${host}:3001/api/jobs?zoneId=town-1`, {
      headers: { Authorization: `Bearer ${this.token}` }
    });
    const jobs: Job[] = await res.json();

    this.add.text(640, 30, 'JOB BOARD — Midville', {
      color: '#ff4444', fontSize: '24px', fontFamily: 'monospace', fontStyle: 'bold'
    }).setOrigin(0.5);

    if (!jobs.length) {
      this.add.text(640, 360, 'No jobs available.', { color: '#888888', fontSize: '18px', fontFamily: 'monospace' }).setOrigin(0.5);
    } else {
      jobs.forEach((job, i) => {
        const y = 100 + i * 80;
        this.add.text(100, y, `[${job.job_type.toUpperCase()}] ${job.description}`, {
          color: '#cccccc', fontSize: '14px', fontFamily: 'monospace', wordWrap: { width: 800 }
        });
        this.add.text(100, y + 24, `Payout: $${job.payout.toLocaleString()}`, {
          color: '#ffcc00', fontSize: '14px', fontFamily: 'monospace'
        });
      });
    }

    const backBtn = this.add.text(100, 680, '[BACK TO GARAGE]', {
      color: '#888888', fontSize: '16px', fontFamily: 'monospace'
    }).setInteractive();
    backBtn.on('pointerdown', () => this.scene.start('GarageScene', { token: this.token }));
  }
}
```

**Step 4: Update TownScene to be a navigation hub**

Replace `client/src/scenes/TownScene.ts` with:
```typescript
import Phaser from 'phaser';

export class TownScene extends Phaser.Scene {
  private token = '';
  private vehicleId = '';

  constructor() { super({ key: 'TownScene' }); }

  init(data: { zoneId: string; token: string; vehicleId: string }): void {
    this.token = data.token;
    this.vehicleId = data.vehicleId;
  }

  create(): void {
    this.add.text(640, 200, 'MIDVILLE', {
      color: '#ff4444', fontSize: '36px', fontFamily: 'monospace', fontStyle: 'bold'
    }).setOrigin(0.5);

    this.add.text(640, 260, 'A dusty town on the autoduel circuit', {
      color: '#888888', fontSize: '16px', fontFamily: 'monospace'
    }).setOrigin(0.5);

    const garageBtn = this.add.text(640, 360, '[ GARAGE ]', {
      color: '#00ff88', fontSize: '24px', fontFamily: 'monospace',
      backgroundColor: '#003322', padding: { x: 20, y: 10 }
    }).setOrigin(0.5).setInteractive();
    garageBtn.on('pointerdown', () => this.scene.start('GarageScene', { token: this.token }));

    const arenaBtn = this.add.text(640, 450, '[ DRIVE TO ARENA ]', {
      color: '#ff4444', fontSize: '20px', fontFamily: 'monospace',
      backgroundColor: '#220000', padding: { x: 16, y: 8 }
    }).setOrigin(0.5).setInteractive();
    arenaBtn.on('pointerdown', () => {
      this.scene.start('ArenaScene', { token: this.token, vehicleId: this.vehicleId });
    });
  }
}
```

**Step 5: Create LoginScene**

Create `client/src/scenes/LoginScene.ts`:
```typescript
import Phaser from 'phaser';

export class LoginScene extends Phaser.Scene {
  constructor() { super({ key: 'LoginScene' }); }

  create(): void {
    this.add.text(640, 100, 'CAR WARS', {
      color: '#ff4444', fontSize: '48px', fontFamily: 'monospace', fontStyle: 'bold'
    }).setOrigin(0.5);

    this.add.text(640, 160, 'Armed Vehicular Combat', {
      color: '#888888', fontSize: '18px', fontFamily: 'monospace'
    }).setOrigin(0.5);

    // Username + password using Phaser DOM elements
    const formElement = this.add.dom(640, 360).createFromHTML(`
      <div style="text-align:center;font-family:monospace">
        <input id="username" type="text" placeholder="Username"
               style="background:#111;color:#fff;border:1px solid #444;padding:8px;margin:8px;font-size:16px;width:200px"><br>
        <input id="password" type="password" placeholder="Password"
               style="background:#111;color:#fff;border:1px solid #444;padding:8px;margin:8px;font-size:16px;width:200px"><br>
        <div id="error" style="color:#ff4444;min-height:20px;margin:4px"></div>
        <button id="loginBtn" style="background:#222;color:#00ff88;border:1px solid #00ff88;padding:10px 24px;font-size:16px;font-family:monospace;cursor:pointer;margin:4px">LOGIN</button>
        <button id="registerBtn" style="background:#222;color:#aaaaff;border:1px solid #aaaaff;padding:10px 24px;font-size:16px;font-family:monospace;cursor:pointer;margin:4px">REGISTER</button>
      </div>
    `);

    formElement.addListener('click');
    formElement.on('click', (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.id === 'loginBtn') this.doAuth('login');
      if (target.id === 'registerBtn') this.doAuth('register');
    });
  }

  private async doAuth(action: 'login' | 'register'): Promise<void> {
    const username = (document.getElementById('username') as HTMLInputElement)?.value;
    const password = (document.getElementById('password') as HTMLInputElement)?.value;
    const errorEl = document.getElementById('error');

    if (!username || !password) {
      if (errorEl) errorEl.textContent = 'Username and password required';
      return;
    }

    const host = window.location.hostname;
    const res = await fetch(`http://${host}:3001/api/auth/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const body = await res.json();
    if (res.ok) {
      localStorage.setItem('cw_token', body.token);
      this.scene.start('GarageScene', { token: body.token });
    } else {
      if (errorEl) errorEl.textContent = body.error ?? 'Auth failed';
    }
  }
}
```

**Step 6: Update main.ts scene config + enable DOM**

In `client/src/main.ts`, add `dom: { createContainer: true }` to Phaser config and register all new scenes:
```typescript
import { LoginScene } from './scenes/LoginScene';
import { GarageScene } from './scenes/GarageScene';
import { TownScene } from './scenes/TownScene';
import { JobBoardScene } from './scenes/JobBoardScene';
import { VehicleDesignerScene } from './scenes/VehicleDesignerScene';
import { ArenaScene } from './scenes/ArenaScene';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 1280,
  height: 720,
  backgroundColor: '#0a0a1a',
  dom: { createContainer: true },
  scene: [LoginScene, GarageScene, TownScene, JobBoardScene, VehicleDesignerScene, ArenaScene]
};
```

If a token exists in localStorage, skip login and go straight to GarageScene:
In `LoginScene.create()`:
```typescript
const saved = localStorage.getItem('cw_token');
if (saved) {
  this.scene.start('GarageScene', { token: saved });
  return;
}
```

**Step 7: Run integration tests (requires server running)**

```bash
# Terminal 1
cd server && npx tsx src/main.ts
# Terminal 2
cd client && npx vitest run tests/town.test.ts
```

**Step 8: Commit**

```bash
git add client/src/scenes/ client/src/main.ts client/tests/town.test.ts
git commit -m "feat(town): login, garage, job board, and town hub scenes"
```

---

## Parallel Execution Guide (Claude Code Teams)

**Stream A — Backend** (Tasks P1 → P2 → 15b → 16 → 17)
All server-side work. Each task depends on the previous one.

**Stream B — Frontend Prep** (Tasks 11 → 12 → 14)
Tilemap loading, zone transitions, vehicle designer. Independent of Stream A until Task 13.

**Task 13** runs after both streams are complete.

**Worker A startup context:**
> You are implementing the backend for Car Wars, a browser-based top-down vehicular combat game.
> Working directory: `/Users/paddyharker/carwars`
> Start with Task P1 (auth endpoints) and work through P2, 15b, 16, 17 in order.
> Run all tests before committing. Use `npx tsx --test` for server tests.

**Worker B startup context:**
> You are implementing the frontend for Car Wars, a browser-based top-down vehicular combat game.
> Working directory: `/Users/paddyharker/carwars`
> Start with Task 11 (tilemaps) and work through 12, 14 in order.
> Run all tests before committing. Use `npx vitest run` for client tests.

**Final Worker (Task 13):**
> You are implementing the Town scene for Car Wars, which ties together the auth API (Stream A) and tilemaps (Stream B).
> Working directory: `/Users/paddyharker/carwars`
> Implement Task 13. Requires both Stream A and Stream B to be committed first.
> The server must be running on :3001 for integration tests.

---

## Running the Full Phase 2 Stack

After all tasks are complete:

```bash
# Apply DB migrations (adds jobs table)
cd server && DATABASE_URL=postgresql://localhost/carwars npx tsx src/db/migrate.ts

# Start server
cd server && npx tsx src/main.ts

# Start client
cd client && npx vite
```

Open `http://localhost:3000` — you'll see the Login screen. Register, build a car, drive to the arena or explore the town.
