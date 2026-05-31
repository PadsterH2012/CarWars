# Phase 5a — Procedural World Generator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the hardcoded 6-node Midville region with a seed-driven procedural world — a settlement graph with capitals, subordinate towns, and a road network — stored as JSONB on the gang row and rendered in WorldMapScene.

**Architecture:** Hard cutover (no midville backwards-compat path). New pure generator function in `worldGen.ts`; two JSONB columns on `gangs`; a one-time migration generates a world for any existing gang at schema-init time. API adds `GET /api/world/map`, refactors travel, removes `/api/world/regions`. Client fetches from the new endpoint; `WorldMapScene` is a shape-level update (nodes → settlements). `midville.ts` and `world/index.ts` are deleted.

**Tech Stack:** TypeScript, Express, Postgres (`pg`), Vitest + Supertest (server tests against real Postgres), Phaser 3 (client — no unit harness; Playwright + build verified).

**Design doc:** `docs/plans/2026-05-31-phase5a-design.md`

**Conventions:** Build: `npm -w @carwars/server run build`, `npm -w @carwars/client run build`. Tests: `npm -w @carwars/server run test`. Client fetch pattern: `const host = window.location.hostname; fetch(\`http://${host}:3001/api/…\`, { headers: { Authorization: \`Bearer ${token}\` } })`. Schema changes: idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS`; test DB is a real Postgres instance, schema.sql is applied before each test run.

---

## Task 1: Add GeneratedWorld types to shared

**Files:**
- Modify: `shared/src/types/worldMap.ts`

Types only — no tests needed, TypeScript compiler is the check.

**Step 1: Add types** to `shared/src/types/worldMap.ts` after the existing exports:

```typescript
export type SettlementKind = 'city' | 'town' | 'village' | 'outpost';

export interface GeneratedSettlement {
  id: string;
  name: string;
  kind: SettlementKind;
  x: number;
  y: number;
  population: number;
  services: string[];          // 'garage' | 'arena' | 'jobs' | 'market' | 'fuel' | 'repairs'
  controllingGangId?: string;
}

export interface GeneratedRoad {
  id: string;
  from: string;
  to: string;
  distance: number;
  roadType: RoadType;          // already exported: 'highway' | 'urban' | 'dirt' | 'mountain'
  danger: number;              // 0..1
  encounterTable: string;      // derived from roadType + danger at generation time
}

export interface GeneratedWorld {
  seed: number;
  settlements: GeneratedSettlement[];
  roads: GeneratedRoad[];
  capitals: string[];          // settlement IDs
  playerStartSettlementId: string;
}
```

**Step 2: Verify build.**

```bash
npm -w @carwars/shared run build 2>/dev/null || npm -w @carwars/server run build
```

Expected: clean (type-check passes, no new errors).

**Step 3: Commit.**

```bash
git add shared/src/types/worldMap.ts
git commit -m "feat(shared): add GeneratedWorld types for Phase 5a"
```

---

## Task 2: worldGen.ts — seeded RNG + scaffold

**Files:**
- Create: `server/src/rules/worldGen.ts`
- Create: `server/tests/worldGen.test.ts`

**Step 1: Write the failing test** for deterministic output:

```typescript
// server/tests/worldGen.test.ts
import { describe, it, expect } from 'vitest';
import { generateWorld } from '../src/rules/worldGen';

describe('generateWorld', () => {
  it('returns a GeneratedWorld with the correct seed', () => {
    const world = generateWorld(42);
    expect(world.seed).toBe(42);
  });

  it('is deterministic: same seed always produces the same output', () => {
    const a = generateWorld(12345);
    const b = generateWorld(12345);
    expect(a).toEqual(b);
  });

  it('different seeds produce structurally different maps', () => {
    const a = generateWorld(1);
    const b = generateWorld(2);
    expect(a.settlements.map(s => s.id)).not.toEqual(b.settlements.map(s => s.id));
  });
});
```

**Step 2: Run, expect FAIL.**

```bash
npm -w @carwars/server run test -- worldGen
```

Expected: `Cannot find module '../src/rules/worldGen'`

**Step 3: Create scaffold** `server/src/rules/worldGen.ts`:

```typescript
import type { GeneratedWorld, GeneratedSettlement, GeneratedRoad, SettlementKind, RoadType } from '@carwars/shared';

export type { GeneratedWorld, GeneratedSettlement, GeneratedRoad };

// ─── Seeded PRNG (mulberry32) ────────────────────────────────────────────────
function mkRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6D2B79F5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateWorld(seed: number): GeneratedWorld {
  const rng = mkRng(seed);
  // stub — full implementation in subsequent tasks
  return {
    seed,
    settlements: [],
    roads: [],
    capitals: [],
    playerStartSettlementId: '',
  };
}
```

**Step 4: Run, expect PASS.**

```bash
npm -w @carwars/server run test -- worldGen
```

**Step 5: Commit.**

```bash
git add server/src/rules/worldGen.ts server/tests/worldGen.test.ts
git commit -m "feat(worldGen): scaffold + seeded PRNG, determinism test"
```

---

## Task 3: worldGen.ts — capital placement

**Files:**
- Modify: `server/src/rules/worldGen.ts`
- Modify: `server/tests/worldGen.test.ts`

**Step 1: Add tests** for capital count and minimum spacing:

```typescript
// Add to the describe block in worldGen.test.ts:

it('produces 4–8 capitals', () => {
  for (const seed of [1, 2, 3, 99, 1000]) {
    const w = generateWorld(seed);
    expect(w.capitals.length).toBeGreaterThanOrEqual(4);
    expect(w.capitals.length).toBeLessThanOrEqual(8);
  }
});

it('capitals are at least 200px apart', () => {
  const w = generateWorld(42);
  const caps = w.settlements.filter(s => w.capitals.includes(s.id));
  for (let i = 0; i < caps.length; i++) {
    for (let j = i + 1; j < caps.length; j++) {
      const d = Math.hypot(caps[i].x - caps[j].x, caps[i].y - caps[j].y);
      expect(d).toBeGreaterThanOrEqual(200);
    }
  }
});

it('capitals have population ≥ 10000', () => {
  const w = generateWorld(7);
  const caps = w.settlements.filter(s => w.capitals.includes(s.id));
  caps.forEach(c => expect(c.population).toBeGreaterThanOrEqual(10000));
});
```

**Step 2: Run, expect FAIL.**

```bash
npm -w @carwars/server run test -- worldGen
```

**Step 3: Implement capital placement.** Replace `generateWorld` with:

```typescript
// ─── Name bank ───────────────────────────────────────────────────────────────
const NAME_PREFIXES = [
  'Dust', 'Iron', 'Red', 'Ash', 'Black', 'New', 'Fort', 'Port', 'Salt',
  'Dead', 'Bone', 'Rust', 'Grim', 'Slag', 'Tar', 'Sand', 'Cold', 'High',
  'Low', 'Old', 'Gun', 'Blade', 'Crag', 'Fell', 'Gale', 'Hawk', 'Mire',
  'Pale', 'Pike', 'Spur', 'Thorn', 'Vale', 'Wold', 'Yew', 'Zinc',
];
const NAME_SUFFIXES = [
  'fall', 'gate', 'rock', 'creek', 'ridge', 'peak', 'town', 'burg',
  'vale', 'ford', 'moor', 'haven', 'port', 'watch', 'bridge', 'field',
  'cross', 'hollow', 'run', 'pass', 'way', 'bend', 'bluff', 'cove',
  'dale', 'end', 'grove', 'helm', 'keep', 'lade', 'marsh', 'neck',
];

function pickName(rng: () => number, used: Set<string>): string {
  for (let i = 0; i < 200; i++) {
    const p = NAME_PREFIXES[Math.floor(rng() * NAME_PREFIXES.length)];
    const s = NAME_SUFFIXES[Math.floor(rng() * NAME_SUFFIXES.length)];
    const n = p + s;
    if (!used.has(n)) { used.add(n); return n; }
  }
  const fallback = `Zone-${used.size}`;
  used.add(fallback);
  return fallback;
}

// ─── Poisson-disc sampling (rejection, fine for small counts) ────────────────
function poissonDisc(
  rng: () => number, count: number,
  width: number, height: number, minDist: number,
): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let tries = 0; tries < 20000 && pts.length < count; tries++) {
    const x = Math.round(rng() * width);
    const y = Math.round(rng() * height);
    if (pts.every(p => Math.hypot(p.x - x, p.y - y) >= minDist)) {
      pts.push({ x, y });
    }
  }
  return pts;
}

function capitalPopulation(rng: () => number): number {
  const roll = rng();
  if (roll < 0.4) return 250000 + Math.floor(rng() * 750000);   // 250k-1M
  if (roll < 0.7) return  50000 + Math.floor(rng() * 200000);   // 50k-250k
  return                   10000 + Math.floor(rng() * 40000);    // 10k-50k
}

function encounterTable(roadType: RoadType, danger: number): string {
  if (roadType === 'mountain') return 'gang-high';
  if (roadType === 'highway')  return danger > 0.4 ? 'highway-medium' : 'highway-low';
  if (roadType === 'urban')    return 'urban-medium';
  return 'dirt-medium';
}

export function generateWorld(seed: number): GeneratedWorld {
  const rng   = mkRng(seed);
  const used  = new Set<string>();

  // ── 1. Capitals ─────────────────────────────────────────────────────────────
  const capitalCount = 4 + Math.floor(rng() * 5);   // 4-8
  const capitalPts   = poissonDisc(rng, capitalCount, 1000, 1000, 200);
  const settlements: GeneratedSettlement[] = [];

  const capitalIds: string[] = capitalPts.map((pt, i) => {
    const id   = `cap-${i}`;
    const name = pickName(rng, used);
    const pop  = capitalPopulation(rng);
    const s: GeneratedSettlement = {
      id, name, kind: 'city', x: pt.x, y: pt.y, population: pop,
      services: ['garage', 'arena', 'jobs', 'market'],
    };
    settlements.push(s);
    return id;
  });

  return {
    seed,
    settlements,
    roads: [],
    capitals: capitalIds,
    playerStartSettlementId: '',
  };
}
```

**Step 4: Run, expect PASS.**

```bash
npm -w @carwars/server run test -- worldGen
```

**Step 5: Commit.**

```bash
git add server/src/rules/worldGen.ts server/tests/worldGen.test.ts
git commit -m "feat(worldGen): capital placement with Poisson-disc sampling"
```

---

## Task 4: worldGen.ts — subordinate settlements + road graph + player start

**Files:**
- Modify: `server/src/rules/worldGen.ts`
- Modify: `server/tests/worldGen.test.ts`

**Step 1: Add tests** for full world structure:

```typescript
// Add to worldGen.test.ts describe block:

it('settlement count is between 5 and 200', () => {
  for (const seed of [1, 42, 999, 8888]) {
    const w = generateWorld(seed);
    expect(w.settlements.length).toBeGreaterThanOrEqual(5);
    expect(w.settlements.length).toBeLessThanOrEqual(200);
  }
});

it('all settlement IDs are unique', () => {
  const w = generateWorld(55);
  const ids = w.settlements.map(s => s.id);
  expect(new Set(ids).size).toBe(ids.length);
});

it('all settlement names are unique', () => {
  const w = generateWorld(55);
  const names = w.settlements.map(s => s.name);
  expect(new Set(names).size).toBe(names.length);
});

it('all road endpoints reference valid settlement IDs', () => {
  const w = generateWorld(42);
  const ids = new Set(w.settlements.map(s => s.id));
  w.roads.forEach(r => {
    expect(ids.has(r.from), `road ${r.id} from=${r.from} not found`).toBe(true);
    expect(ids.has(r.to),   `road ${r.id} to=${r.to} not found`).toBe(true);
  });
});

it('every capital is connected to every other capital by a road', () => {
  const w = generateWorld(7);
  for (let i = 0; i < w.capitals.length; i++) {
    for (let j = i + 1; j < w.capitals.length; j++) {
      const a = w.capitals[i], b = w.capitals[j];
      const has = w.roads.some(
        r => (r.from === a && r.to === b) || (r.from === b && r.to === a)
      );
      expect(has, `no road between capitals ${a} and ${b}`).toBe(true);
    }
  }
});

it('player start settlement has population < 5000', () => {
  for (const seed of [1, 42, 999]) {
    const w = generateWorld(seed);
    const s = w.settlements.find(s => s.id === w.playerStartSettlementId);
    expect(s).toBeDefined();
    expect(s!.population).toBeLessThan(5000);
  }
});

it('every settlement is reachable from player start', () => {
  const w = generateWorld(42);
  // BFS from player start
  const adj = new Map<string, string[]>();
  w.settlements.forEach(s => adj.set(s.id, []));
  w.roads.forEach(r => {
    adj.get(r.from)!.push(r.to);
    adj.get(r.to)!.push(r.from);
  });
  const visited = new Set<string>();
  const q = [w.playerStartSettlementId];
  while (q.length) {
    const cur = q.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    adj.get(cur)?.forEach(n => q.push(n));
  }
  w.settlements.forEach(s =>
    expect(visited.has(s.id), `${s.id} not reachable from player start`).toBe(true)
  );
});
```

**Step 2: Run, expect FAIL** (settlements/roads are empty stubs).

```bash
npm -w @carwars/server run test -- worldGen
```

**Step 3: Implement subordinates + roads + player start.** Replace the `generateWorld` function body after the capitals section:

```typescript
export function generateWorld(seed: number): GeneratedWorld {
  const rng   = mkRng(seed);
  const used  = new Set<string>();

  // ── 1. Capitals ─────────────────────────────────────────────────────────────
  const capitalCount = 4 + Math.floor(rng() * 5);
  const capitalPts   = poissonDisc(rng, capitalCount, 1000, 1000, 200);
  const settlements: GeneratedSettlement[] = [];

  const capitalIds: string[] = capitalPts.map((pt, i) => {
    const id   = `cap-${seed}-${i}`;
    const name = pickName(rng, used);
    const pop  = capitalPopulation(rng);
    settlements.push({
      id, name, kind: 'city', x: pt.x, y: pt.y, population: pop,
      services: ['garage', 'arena', 'jobs', 'market'],
    });
    return id;
  });

  // ── 2. Subordinate settlements ───────────────────────────────────────────────
  // Each capital gets floor(sqrt(pop/10000)) subordinates, placed at random
  // offsets within 300px (prefer < 150 = close → town, else far → outpost/village).
  let subIdx = 0;
  for (let ci = 0; ci < capitalIds.length; ci++) {
    const cap  = settlements[ci];
    const count = Math.max(1, Math.floor(Math.sqrt(cap.population / 10000)));

    for (let k = 0; k < count; k++) {
      const angle = rng() * Math.PI * 2;
      const dist  = 80 + Math.floor(rng() * 220);   // 80-300 from capital
      const x     = Math.round(Math.max(10, Math.min(990, cap.x + Math.cos(angle) * dist)));
      const y     = Math.round(Math.max(10, Math.min(990, cap.y + Math.sin(angle) * dist)));

      const id   = `sub-${seed}-${subIdx++}`;
      const name = pickName(rng, used);

      let kind: SettlementKind;
      let population: number;
      let services: string[];

      if (dist < 130) {
        kind = 'town'; population = 1000 + Math.floor(rng() * 9000);
        services = ['garage', 'arena', 'jobs', 'market'];
      } else if (dist < 220) {
        kind = 'village'; population = 500 + Math.floor(rng() * 4500);
        services = ['garage', 'jobs'];
      } else {
        kind = 'outpost'; population = 100 + Math.floor(rng() * 900);
        services = ['fuel', 'repairs'];
      }

      settlements.push({ id, name, kind, x, y, population, services });
    }
  }

  // ── 3. Roads ────────────────────────────────────────────────────────────────
  const roads: GeneratedRoad[] = [];
  const connected = new Set<string>();  // "a:b" sorted pairs already wired

  function addRoad(from: string, to: string, roadType: RoadType): void {
    const key = [from, to].sort().join(':');
    if (connected.has(key)) return;
    connected.add(key);
    const fa = settlements.find(s => s.id === from)!;
    const ta = settlements.find(s => s.id === to)!;
    const distance = Math.round(Math.hypot(fa.x - ta.x, fa.y - ta.y));
    const danger   = Math.min(0.8, Math.max(0.05, 0.05 + distance / 1200));
    roads.push({
      id: `road-${from}-${to}`,
      from, to, distance, roadType, danger,
      encounterTable: encounterTable(roadType, danger),
    });
  }

  // Capital ↔ capital highways (complete graph)
  for (let i = 0; i < capitalIds.length; i++) {
    for (let j = i + 1; j < capitalIds.length; j++) {
      addRoad(capitalIds[i], capitalIds[j], 'highway');
    }
  }

  // Each subordinate → parent capital
  for (let ci = 0; ci < capitalIds.length; ci++) {
    const cap      = settlements[ci];
    const subCount = Math.max(1, Math.floor(Math.sqrt(cap.population / 10000)));
    // Sub indices are assigned sequentially; we need to find them by parent
    // capital using proximity (nearest capital = parent for each subordinate)
    const subs = settlements.filter(s => !capitalIds.includes(s.id)).filter(s => {
      let nearestCapIdx = 0;
      let nearestDist   = Infinity;
      for (let k = 0; k < capitalIds.length; k++) {
        const c = settlements[k];
        const d = Math.hypot(s.x - c.x, s.y - c.y);
        if (d < nearestDist) { nearestDist = d; nearestCapIdx = k; }
      }
      return nearestCapIdx === ci;
    });
    const type: RoadType = 'urban';
    subs.forEach(s => addRoad(capitalIds[ci], s.id, type));

    // Local roads: any two settlements in same region < 150 apart
    for (let a = 0; a < subs.length; a++) {
      for (let b = a + 1; b < subs.length; b++) {
        if (Math.hypot(subs[a].x - subs[b].x, subs[a].y - subs[b].y) < 150) {
          addRoad(subs[a].id, subs[b].id, 'dirt');
        }
      }
    }
  }

  // ── 4. Player start ──────────────────────────────────────────────────────────
  // Small settlement (pop < 5000), sorted by distance from map centre (500, 500),
  // pick bottom 25th percentile.
  const smallSettlements = settlements
    .filter(s => s.population < 5000)
    .sort((a, b) => Math.hypot(a.x - 500, a.y - 500) - Math.hypot(b.x - 500, b.y - 500));

  const cutoff     = Math.max(1, Math.floor(smallSettlements.length * 0.25));
  const candidates = smallSettlements.slice(0, cutoff);
  const startIdx   = Math.floor(rng() * candidates.length);
  const playerStart = candidates[startIdx] ?? settlements[settlements.length - 1];

  return {
    seed,
    settlements,
    roads,
    capitals: capitalIds,
    playerStartSettlementId: playerStart.id,
  };
}
```

**Step 4: Run, expect PASS.**

```bash
npm -w @carwars/server run test -- worldGen
```

**Step 5: Commit.**

```bash
git add server/src/rules/worldGen.ts server/tests/worldGen.test.ts
git commit -m "feat(worldGen): subordinate settlements, road graph, player start"
```

---

## Task 5: Schema migration — add world columns to gangs

**Files:**
- Modify: `server/src/db/schema.sql`

**Step 1: Add columns and migration block.** Find the section in `schema.sql` near `current_world_node_id` (around line 616) and add after the existing gang column migrations:

```sql
-- Phase 5a: generated world storage
ALTER TABLE gangs ADD COLUMN IF NOT EXISTS world_seed INTEGER;
ALTER TABLE gangs ADD COLUMN IF NOT EXISTS generated_world JSONB;

-- One-time migration: generate a world for any existing gang that doesn't have one.
-- generateWorld() can't run in SQL, so this is handled in the server startup migration
-- helper (see server/src/db/migrate.ts or equivalent). The schema.sql columns are
-- added here; the data migration runs in code at server startup.
```

**Step 2: Check if there's a startup migration hook** in the server:

```bash
grep -rn 'schema.sql\|runMigrations\|migrate' server/src/db/ server/src/app.ts server/src/main.ts 2>/dev/null | head -20
```

Look at how schema.sql is applied. If it's run via `psql` on startup, the columns are added automatically. The data migration (generating a world for existing gangs) needs a code-level step.

**Step 3: Apply schema to the dev DB:**

```bash
psql carwars -c "ALTER TABLE gangs ADD COLUMN IF NOT EXISTS world_seed INTEGER;"
psql carwars -c "ALTER TABLE gangs ADD COLUMN IF NOT EXISTS generated_world JSONB;"
```

**Step 4: Verify columns exist:**

```bash
psql carwars -c "\d gangs" | grep -E 'world_seed|generated_world'
```

Expected: both columns listed.

**Step 5: Commit.**

```bash
git add server/src/db/schema.sql
git commit -m "feat(db): add world_seed and generated_world columns to gangs"
```

---

## Task 6: getWorldForGang helper + GET /api/world/map

**Files:**
- Create: `server/src/rules/worldLoader.ts`
- Modify: `server/src/api/world.ts`
- Modify: `server/tests/world-api.test.ts`

**Step 1: Write the failing tests.** Replace `world-api.test.ts` entirely:

```typescript
import request from 'supertest';
import { describe, expect, it, afterAll } from 'vitest';
import { createApp } from '../src/app';
import { getDb } from '../src/db/client';

const app = createApp();

// Use the existing register helper pattern from other api tests.
async function register(suffix: string): Promise<{ token: string; playerId: string }> {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ username: `worldtest-${suffix}`, password: 'pw' });
  return { token: res.body.token, playerId: res.body.playerId };
}

const USERS: string[] = [];
afterAll(async () => {
  const db = getDb();
  for (const u of USERS) {
    await db.query(`DELETE FROM players WHERE username = $1`, [u]);
  }
});

describe('GET /api/world/map', () => {
  it('returns a GeneratedWorld for an authenticated player', async () => {
    const suffix = `map1-${Date.now()}`;
    USERS.push(`worldtest-${suffix}`);
    const { token } = await register(suffix);

    const res = await request(app)
      .get('/api/world/map')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.seed).toBe('number');
    expect(Array.isArray(res.body.settlements)).toBe(true);
    expect(res.body.settlements.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.roads)).toBe(true);
    expect(typeof res.body.playerStartSettlementId).toBe('string');
  });

  it('is idempotent: calling twice returns the same world', async () => {
    const suffix = `map2-${Date.now()}`;
    USERS.push(`worldtest-${suffix}`);
    const { token } = await register(suffix);

    const a = await request(app).get('/api/world/map').set('Authorization', `Bearer ${token}`);
    const b = await request(app).get('/api/world/map').set('Authorization', `Bearer ${token}`);

    expect(a.body.seed).toBe(b.body.seed);
    expect(a.body.settlements.map((s: { id: string }) => s.id))
      .toEqual(b.body.settlements.map((s: { id: string }) => s.id));
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/world/map');
    expect(res.status).toBe(401);
  });
});
```

**Step 2: Run, expect FAIL.**

```bash
npm -w @carwars/server run test -- world-api
```

**Step 3: Create worldLoader.ts:**

```typescript
// server/src/rules/worldLoader.ts
import type { Pool } from 'pg';
import type { GeneratedWorld } from '@carwars/shared';
import { generateWorld } from './worldGen';

export async function getWorldForGang(
  db: Pool,
  playerId: string,
): Promise<{ world: GeneratedWorld; gangId: string; fromNodeId: string } | null> {
  const r = await db.query<{
    id: string; world_seed: number | null;
    generated_world: GeneratedWorld | null;
    current_world_node_id: string;
  }>(
    `SELECT id, world_seed, generated_world, current_world_node_id
       FROM gangs WHERE owner_player_id = $1`,
    [playerId],
  );
  if (!r.rows.length) return null;

  const row = r.rows[0];
  let world = row.generated_world;

  if (!world) {
    const seed = row.world_seed ?? (Math.floor(Math.random() * 2147483647));
    world = generateWorld(seed);
    await db.query(
      `UPDATE gangs SET world_seed = $1, generated_world = $2, current_world_node_id = $3
         WHERE owner_player_id = $4`,
      [seed, JSON.stringify(world), world.playerStartSettlementId, playerId],
    );
    return {
      world,
      gangId: row.id,
      fromNodeId: world.playerStartSettlementId,
    };
  }

  return { world, gangId: row.id, fromNodeId: row.current_world_node_id };
}
```

**Step 4: Add GET /api/world/map to world.ts.** Add after the import block:

```typescript
import type { GeneratedWorld } from '@carwars/shared';
import { getWorldForGang } from '../rules/worldLoader';
```

Add the new route before `worldRouter.get('/regions', ...)`:

```typescript
worldRouter.get('/map', requireAuth, async (req: AuthRequest, res) => {
  const db  = getDb();
  const ctx = await getWorldForGang(db, req.playerId!);
  if (!ctx) return res.status(404).json({ error: 'Gang not found' });
  return res.json(ctx.world);
});
```

**Step 5: Run, expect PASS.**

```bash
npm -w @carwars/server run test -- world-api
```

**Step 6: Commit.**

```bash
git add server/src/rules/worldLoader.ts server/src/api/world.ts server/tests/world-api.test.ts
git commit -m "feat(api): GET /api/world/map — load or generate world for player"
```

---

## Task 7: Refactor POST /api/world/travel

**Files:**
- Modify: `server/src/api/world.ts`

No new tests — the travel endpoint already has indirect coverage via integration tests. Verify the existing test suite passes after the refactor.

**Step 1: Replace the travel handler** in `world.ts`. The entire `worldRouter.post('/travel', …)` block becomes:

```typescript
worldRouter.post('/travel', requireAuth, async (req: AuthRequest, res) => {
  try { fs.appendFileSync('/tmp/travel.log', `[TRAVEL] ${new Date().toISOString()} body=${JSON.stringify(req.body)}\n`); } catch(_e) {}

  const { toNodeId } = req.body ?? {};
  if (!toNodeId || typeof toNodeId !== 'string') {
    return res.status(400).json({ error: 'toNodeId required' });
  }

  const db  = getDb();
  const ctx = await getWorldForGang(db, req.playerId!);
  if (!ctx) return res.status(404).json({ error: 'Gang not found' });

  const { world } = ctx;
  const fromNodeId = ctx.fromNodeId;

  const fromNode = world.settlements.find(s => s.id === fromNodeId);
  const toNode   = world.settlements.find(s => s.id === toNodeId);

  if (!fromNode) return res.status(400).json({ error: `Current location '${fromNodeId}' not found` });
  if (!toNode)   return res.status(404).json({ error: `Destination '${toNodeId}' not found` });

  const road = world.roads.find(
    r => (r.from === fromNodeId && r.to === toNodeId) || (r.from === toNodeId && r.to === fromNodeId),
  );
  if (!road) return res.status(400).json({ error: `No road between '${fromNodeId}' and '${toNodeId}'` });

  const roll = Math.random();
  try { fs.appendFileSync('/tmp/travel.log', `outcome=${roll < road.danger ? 'ENCOUNTER' : 'ARRIVED'} danger=${road.danger} roll=${roll.toFixed(3)}\n`); } catch(_e) {}

  if (roll < road.danger) {
    return res.json({
      outcome: 'encounter',
      encounterId: `enc-${road.id}-${Date.now()}`,
      tacticalMapId: encounterMapId(road.encounterTable),
      description: `Ambush on the ${road.roadType} road to ${toNode.name}!`,
    });
  }

  await db.query(
    `UPDATE gangs SET current_world_node_id = $1 WHERE owner_player_id = $2`,
    [toNodeId, req.playerId],
  );

  return res.json({ outcome: 'arrived', currentNodeId: toNodeId });
});
```

Also remove the now-unused import: `import { getRegion, WORLD_REGIONS } from '../rules/world';` → replace with just the worldLoader import already added in Task 6.

Remove the two static region endpoints (`GET /regions` and `GET /regions/:id`) — they reference `WORLD_REGIONS` and `getRegion` which will be deleted in Task 9.

**Step 2: Build + test.**

```bash
npm -w @carwars/server run build && npm -w @carwars/server run test -- world-api
```

Expected: clean build, tests pass.

**Step 3: Commit.**

```bash
git add server/src/api/world.ts
git commit -m "feat(api): refactor travel to use generated world, remove midville regions"
```

---

## Task 8: Refactor deploy.ts

**Files:**
- Modify: `server/src/api/deploy.ts`

**Step 1: Update imports** at the top of `deploy.ts`. Remove:
```typescript
import { getRegion } from '../rules/world';
import type { WorldNode, WorldRegion } from '@carwars/shared';
```
Add:
```typescript
import type { GeneratedSettlement, GeneratedWorld } from '@carwars/shared';
import { getWorldForGang } from '../rules/worldLoader';
```

**Step 2: Remove `REGION_ID` constant** (line 19 `const REGION_ID = 'midville';`).

**Step 3: Update `zoneDifficulty`** signature and implementation:

```typescript
export function zoneDifficulty(node: GeneratedSettlement, world: GeneratedWorld): number {
  const BASE: Record<string, number> = {
    city: 2, town: 3, village: 4, outpost: 5,
  };
  const touchingRoads = world.roads.filter(r => r.from === node.id || r.to === node.id);
  const maxDanger     = touchingRoads.reduce((m, r) => Math.max(m, r.danger), 0);
  return clampInt(1, 10, Math.round((BASE[node.kind] ?? 3) + maxDanger * 4));
}
```

**Step 4: Update `deploymentSeconds`** to accept `GeneratedWorld`:

```typescript
function deploymentSeconds(fromNodeId: string, toNodeId: string, world: GeneratedWorld): number {
  const road = world.roads.find(
    r => (r.from === fromNodeId && r.to === toNodeId) || (r.from === toNodeId && r.to === fromNodeId),
  );
  const miles = road ? road.distance : FALLBACK_TRAVEL_MILES;
  return Math.round(miles * TRAVEL_SECONDS_PER_MILE) + ENGAGEMENT_SECONDS;
}
```

**Step 5: Update `POST /api/deploy` handler.** Replace:
```typescript
const region = getRegion(REGION_ID);
if (!region) return res.status(500).json({ error: 'World region not found' });
const toNode = region.nodes.find(n => n.id === zoneId);
```
With:
```typescript
const worldCtx = await getWorldForGang(db, req.playerId!);
if (!worldCtx) return res.status(404).json({ error: 'Gang not found' });
const { world } = worldCtx;
const fromNodeId = worldCtx.fromNodeId;
const toNode = world.settlements.find(s => s.id === zoneId);
```

Then update `gangRes` query (it's now redundant for `fromNodeId` — remove the `current_world_node_id` fetch from gangRes and use `worldCtx.fromNodeId` instead). Also update:
```typescript
const seconds = deploymentSeconds(fromNodeId, zoneId, world);
```

**Step 6: Update `resolveDueDeployments`.** Replace:
```typescript
const region = getRegion(REGION_ID);
if (!region) return;
```
With:
```typescript
const worldCtx = await getWorldForGang(db, playerId);
if (!worldCtx) return;
const { world } = worldCtx;
```

Then update every `region.nodes.find(…)` to `world.settlements.find(…)` and `zoneDifficulty(node, region)` to `zoneDifficulty(node, world)`.

**Step 7: Build + test.**

```bash
npm -w @carwars/server run build && npm -w @carwars/server run test
```

Expected: clean build, all existing tests pass. Fix any type errors before committing.

**Step 8: Commit.**

```bash
git add server/src/api/deploy.ts
git commit -m "feat(deploy): use generated world instead of hardcoded midville"
```

---

## Task 9: Delete midville + world/index.ts

**Files:**
- Delete: `server/src/rules/world/regions/midville.ts`
- Delete: `server/src/rules/world/index.ts`
- Delete: `server/src/rules/world/` (directory, if empty after deletions)
- Modify: `server/tests/worldmap.test.ts`

**Step 1: Check for remaining imports:**

```bash
grep -rn 'getRegion\|WORLD_REGIONS\|midvilleRegion\|validateWorldRegion\|rules/world' server/src/ server/tests/ 2>/dev/null
```

Expected: only `worldmap.test.ts` still references these. If anything else does, fix it first.

**Step 2: Replace `worldmap.test.ts`** entirely with tests for the generator:

```typescript
import { describe, expect, it } from 'vitest';
import { generateWorld } from '../src/rules/worldGen';

describe('generateWorld structural validity', () => {
  it('all road IDs are unique', () => {
    const w = generateWorld(100);
    const ids = w.roads.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('danger values are within 0..1', () => {
    const w = generateWorld(42);
    w.roads.forEach(r => {
      expect(r.danger).toBeGreaterThanOrEqual(0);
      expect(r.danger).toBeLessThanOrEqual(1);
    });
  });

  it('road distances are positive', () => {
    const w = generateWorld(42);
    w.roads.forEach(r => expect(r.distance).toBeGreaterThan(0));
  });

  it('capitals array IDs all exist in settlements', () => {
    const w = generateWorld(42);
    const ids = new Set(w.settlements.map(s => s.id));
    w.capitals.forEach(c => expect(ids.has(c)).toBe(true));
  });

  it('playerStartSettlementId exists in settlements', () => {
    const w = generateWorld(42);
    const ids = new Set(w.settlements.map(s => s.id));
    expect(ids.has(w.playerStartSettlementId)).toBe(true);
  });

  it('all settlements have at least one service', () => {
    const w = generateWorld(55);
    w.settlements.forEach(s =>
      expect(s.services.length, `${s.name} has no services`).toBeGreaterThan(0)
    );
  });
});
```

**Step 3: Delete the files:**

```bash
rm server/src/rules/world/regions/midville.ts
rm server/src/rules/world/index.ts
rmdir server/src/rules/world/regions server/src/rules/world 2>/dev/null || true
```

**Step 4: Build + test.**

```bash
npm -w @carwars/server run build && npm -w @carwars/server run test
```

Expected: clean. Fix any remaining import errors.

**Step 5: Commit.**

```bash
git add -A
git commit -m "feat(worldGen): delete hardcoded midville region and world registry"
```

---

## Task 10: Update WorldMapScene

**Files:**
- Modify: `client/src/scenes/WorldMapScene.ts`

**Step 1: Update imports** at the top of `WorldMapScene.ts`. Remove `WorldRegion, WorldNode, WorldRoad` and add `GeneratedWorld, GeneratedSettlement, GeneratedRoad`:

```typescript
import type { GeneratedWorld, GeneratedSettlement, GeneratedRoad } from "@carwars/shared";
```

**Step 2: Update the class field type** (line ~82):

```typescript
private region: GeneratedWorld | null = null;
```

Change the default `currentNodeId`:

```typescript
private currentNodeId = "";   // set from /api/world/state on create
```

**Step 3: Update `nodeColour`** to handle the new kinds:

```typescript
function nodeColour(kind: GeneratedSettlement["kind"]): number {
  switch (kind) {
    case "city":    return C_NODE_CITY;
    case "town":    return C_NODE_TOWN;
    case "village": return C_NODE_TRUCK_STOP;  // warm amber
    case "outpost": return 0x996633;            // brown
    default:        return 0xaaaaaa;
  }
}
```

**Step 4: Update `fetchRegion`:**

```typescript
private async fetchRegion(): Promise<void> {
  try {
    const host = window.location.hostname;
    const res  = await fetch(`http://${host}:3001/api/world/map`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    this.region = await res.json();
  } catch (e) {
    console.error("WorldMapScene fetchRegion failed:", e);
    this.region = null;
  }
}
```

**Step 5: Update `computeTransform`** — change `this.region.nodes` to `this.region.settlements`:

```typescript
private computeTransform(): void {
  if (!this.region || this.region.settlements.length === 0) return;
  const xs = this.region.settlements.map(s => s.x);
  const ys = this.region.settlements.map(s => s.y);
  // ... rest unchanged
}
```

**Step 6: Update `drawRoads`** — change `this.region.roads` references to use `GeneratedRoad` shape (fields are identical: `from`, `to`, `roadType`). Check for any `encounterTable` usage — there shouldn't be any in the client; if there is, remove it.

**Step 7: Update `drawNodes`** — change `this.region.nodes` to `this.region.settlements`. Update any `node.kind` usage, `node.services` usage.

**Step 8: Update `drawDeployments` + `travelPanel`** — search for `.nodes.find(` and `.nodes.map(` and replace with `.settlements.find(` and `.settlements.map(`.

**Step 9: Build.**

```bash
npm -w @carwars/client run build
```

Expected: clean. Fix any TypeScript errors — they'll all be shape-related (`.nodes` → `.settlements`).

**Step 10: Commit.**

```bash
git add client/src/scenes/WorldMapScene.ts
git commit -m "feat(client): WorldMapScene fetches generated world map"
```

---

## Task 11: Startup migration for existing gangs

**Files:**
- Find and modify the server startup / DB initialisation code

**Step 1: Find where the server initialises the DB:**

```bash
grep -rn 'schema.sql\|applySchema\|initDb\|runMigrations' server/src/ | head -20
```

**Step 2: Add a migration function.** Find the right place (likely `server/src/db/client.ts` or `server/src/main.ts`) and add:

```typescript
import { generateWorld } from '../rules/worldGen';

export async function migrateGeneratedWorlds(): Promise<void> {
  const db = getDb();
  const gangs = await db.query<{ owner_player_id: string; world_seed: number | null }>(
    `SELECT owner_player_id, world_seed FROM gangs WHERE generated_world IS NULL`,
  );
  for (const g of gangs.rows) {
    const seed  = g.world_seed ?? Math.floor(Math.random() * 2147483647);
    const world = generateWorld(seed);
    await db.query(
      `UPDATE gangs SET world_seed = $1, generated_world = $2, current_world_node_id = $3
         WHERE owner_player_id = $4`,
      [seed, JSON.stringify(world), world.playerStartSettlementId, g.owner_player_id],
    );
    console.log(`[migrate] Generated world (seed ${seed}) for gang owner ${g.owner_player_id}`);
  }
}
```

**Step 3: Call it at startup** (in `main.ts` or wherever `initDb()` is called):

```typescript
await migrateGeneratedWorlds();
```

**Step 4: Build + restart dev server** to verify the migration runs:

```bash
npm -w @carwars/server run build
# check server logs show "[migrate] Generated world …" for the existing gang
```

**Step 5: Commit.**

```bash
git add server/src/db/client.ts server/src/main.ts   # whichever files changed
git commit -m "feat(db): startup migration generates world for existing gangs"
```

---

## Task 12: Full verification

**Step 1: Run all tests.**

```bash
npm -w @carwars/server run test
```

Expected: all pass. Fix any failures before proceeding.

**Step 2: Full build.**

```bash
npm -w @carwars/server run build && npm -w @carwars/client run build
```

Expected: both clean.

**Step 3: Deploy to hl-carwars and smoke test.**

```bash
./scripts/deploy.sh
```

**Step 4: Manual smoke test** — open the game in a browser, navigate to World Map. Verify:
- A procedural map renders (not the old 6-node midville map)
- Player location dot appears on a settlement
- Clicking a connected settlement shows the travel panel
- DEPLOY button works — sends a squad, creates a deployment marker
- Reports screen shows results after deployment resolves

**Step 5: Tag the sub-phase.**

```bash
git tag phase-5a
git push origin main --tags
```

---

## Phase 5a complete

Deliverables:
- `server/src/rules/worldGen.ts` — pure procedural generator, deterministic by seed
- `server/src/rules/worldLoader.ts` — `getWorldForGang()` helper shared by world + deploy
- `shared/src/types/worldMap.ts` — `GeneratedWorld`, `GeneratedSettlement`, `GeneratedRoad` types
- `server/src/db/schema.sql` — `world_seed`, `generated_world` columns on gangs
- `GET /api/world/map` — replaces `/api/world/regions/midville`
- `POST /api/world/travel` — refactored to generated world
- `POST /api/deploy` + `resolveDueDeployments` — use generated world
- `WorldMapScene` — renders generated settlement graph
- `server/tests/worldGen.test.ts` — determinism, structure, connectivity
- Midville + world registry deleted

Next: Phase 5b — Gang ecology & territory influence
