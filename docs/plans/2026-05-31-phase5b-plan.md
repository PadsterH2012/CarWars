# Phase 5b — Gang Ecology & Influence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add population-driven procedural gang generation, per-settlement influence tracking, and arena rival matching that prefers gangs already present in the player's location.

**Architecture:** A pure `gangGen.ts` function generates rival gangs deterministically from the world seed; they are stored as `generated_gangs JSONB` on the player's gang row alongside `generated_world`. A new `zone_influence` table tracks influence scores (settlement_id × gang_id). Squad deployments write influence based on outcome. A new `/api/territory/influence` endpoint serves the overlay; `WorldMapScene` tints nodes by dominant gang. Arena rival matching is extended to prefer generated gangs with local presence, falling back to authored `rival_gangs`.

**Tech Stack:** TypeScript, Express, Postgres, Vitest + Supertest, Phaser 3 (client — no unit harness, build + manual verified).

**Design doc:** `docs/plans/2026-05-31-phase5a-design.md` (Phase 5 overall design)

**Conventions:** Build: `npm -w @carwars/server run build`, `npm -w @carwars/client run build`. Tests: `npm -w @carwars/server run test`. Test helpers: `register(suffix)` → `{ token, playerId }` pattern — copy from `server/tests/gangs.test.ts`. DB: carwars / localhost / carwars_dev password. Schema is applied idempotently at startup via `IF NOT EXISTS` guards.

---

## Task 1: gangGen.ts — pure gang generator

**Files:**
- Create: `server/src/rules/gangGen.ts`
- Create: `server/tests/gangGen.test.ts`

**Step 1: Write failing tests**

Create `server/tests/gangGen.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { generateGangs } from '../src/rules/gangGen';
import { generateWorld } from '../src/rules/worldGen';

describe('generateGangs', () => {
  it('is deterministic: same world + seed → same gangs', () => {
    const world = generateWorld(42);
    const a = generateGangs(world, 42);
    const b = generateGangs(world, 42);
    expect(a).toEqual(b);
  });

  it('produces between 4 and 20 gangs', () => {
    for (const seed of [1, 42, 999]) {
      const world = generateWorld(seed);
      const gangs = generateGangs(world, seed);
      expect(gangs.length).toBeGreaterThanOrEqual(4);
      expect(gangs.length).toBeLessThanOrEqual(20);
    }
  });

  it('all gang IDs are unique', () => {
    const world = generateWorld(42);
    const gangs = generateGangs(world, 42);
    const ids = gangs.map(g => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all gang names are unique', () => {
    const world = generateWorld(42);
    const gangs = generateGangs(world, 42);
    const names = gangs.map(g => g.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('all home_settlement_id values reference valid settlements', () => {
    const world = generateWorld(42);
    const gangs = generateGangs(world, 42);
    const ids = new Set(world.settlements.map(s => s.id));
    gangs.forEach(g =>
      expect(ids.has(g.home_settlement_id), `${g.name} home ${g.home_settlement_id} not found`).toBe(true)
    );
  });

  it('starting_influence is positive', () => {
    const world = generateWorld(42);
    const gangs = generateGangs(world, 42);
    gangs.forEach(g => expect(g.starting_influence).toBeGreaterThan(0));
  });

  it('treasury is between 5000 and 15000', () => {
    const world = generateWorld(42);
    const gangs = generateGangs(world, 42);
    gangs.forEach(g => {
      expect(g.treasury).toBeGreaterThanOrEqual(5000);
      expect(g.treasury).toBeLessThanOrEqual(15000);
    });
  });
});
```

Run: `npm -w @carwars/server run test -- gangGen`
Expected: FAIL (module not found)

**Step 2: Create gangGen.ts**

```typescript
// server/src/rules/gangGen.ts
import type { GeneratedWorld } from '@carwars/shared';
import { mkRng } from './worldGen';

export interface GeneratedGang {
  id: string;
  name: string;
  primary_colour: number;
  secondary_colour: number;
  starting_influence: number;
  home_settlement_id: string;
  treasury: number;
}

const GANG_PREFIXES = [
  'Iron', 'Blood', 'Shadow', 'Dead', 'Red', 'Black', 'Ghost',
  'Rust', 'Fallen', 'Crimson', 'Ash', 'Thorn', 'Void', 'Grave', 'Storm',
];
const GANG_SUFFIXES = [
  'Wolves', 'Ravens', 'Reapers', 'Hounds', 'Fangs', 'Jackals',
  'Vipers', 'Hawks', 'Demons', 'Wraiths', 'Steel', 'Bones', 'Knights', 'Sinners',
];

function gangName(rng: () => number, used: Set<string>): string {
  for (let i = 0; i < 200; i++) {
    const p = GANG_PREFIXES[Math.floor(rng() * GANG_PREFIXES.length)];
    const s = GANG_SUFFIXES[Math.floor(rng() * GANG_SUFFIXES.length)];
    const n = `${p} ${s}`;
    if (!used.has(n)) { used.add(n); return n; }
  }
  const fallback = `Gang-${used.size}`;
  used.add(fallback);
  return fallback;
}

// Deterministic UUID-like ID from seed + index
function gangId(seed: number, index: number): string {
  const h = (n: number) => n.toString(16).padStart(8, '0');
  return `${h(seed)}-${h(index)}-4${h(index * 7 & 0xfffffff).slice(1)}-${h(seed ^ index)}-${h(seed * 31 + index)}`.slice(0, 36);
}

export function generateGangs(world: GeneratedWorld, seed: number): GeneratedGang[] {
  const rng  = mkRng(seed + 0xdeadbeef); // offset so gang seed ≠ world seed
  const used = new Set<string>();

  const totalPop    = world.settlements.reduce((s, n) => s + n.population, 0);
  const gangCount   = Math.max(4, Math.min(20, Math.floor(Math.sqrt(totalPop / 15000))));

  // Assign gangs to settlements proportional to population
  const weightedSettlements = world.settlements.map(s => ({
    id: s.id,
    weight: s.population,
  }));
  const totalWeight = weightedSettlements.reduce((s, w) => s + w.weight, 0);

  const gangs: GeneratedGang[] = [];
  for (let i = 0; i < gangCount; i++) {
    // Weighted random settlement selection
    let pick = rng() * totalWeight;
    let homeId = world.settlements[0].id;
    for (const ws of weightedSettlements) {
      pick -= ws.weight;
      if (pick <= 0) { homeId = ws.id; break; }
    }

    const primary_colour   = Math.floor(rng() * 0xffffff);
    const secondary_colour = Math.floor(rng() * 0xffffff);
    const starting_influence = 30 + Math.floor(rng() * 20);
    const treasury         = 5000 + Math.floor(rng() * 10000);

    gangs.push({
      id: gangId(seed, i),
      name: gangName(rng, used),
      primary_colour,
      secondary_colour,
      starting_influence,
      home_settlement_id: homeId,
      treasury,
    });
  }

  return gangs;
}
```

**Step 3: Run tests — expect PASS**

```bash
npm -w @carwars/server run test -- gangGen
```

Expected: all 7 pass.

**Step 4: Build**

```bash
npm -w @carwars/server run build
```

**Step 5: Commit**

```bash
git add server/src/rules/gangGen.ts server/tests/gangGen.test.ts
git commit -m "feat(gangGen): procedural gang generator, deterministic by seed"
```

---

## Task 2: Schema — generated_gangs column + zone_influence table + drop rival FK

**Files:**
- Modify: `server/src/db/schema.sql`

**Step 1: Add to schema.sql** — after the `generated_world` column line (around line 624), add:

```sql
ALTER TABLE gangs ADD COLUMN IF NOT EXISTS generated_gangs JSONB;

CREATE TABLE IF NOT EXISTS zone_influence (
  settlement_id TEXT NOT NULL,
  gang_id       TEXT NOT NULL,
  influence     INTEGER NOT NULL DEFAULT 0,
  last_action_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (settlement_id, gang_id)
);

CREATE INDEX IF NOT EXISTS idx_zone_influence_gang       ON zone_influence(gang_id);
CREATE INDEX IF NOT EXISTS idx_zone_influence_settlement ON zone_influence(settlement_id);
```

Also add — after the `player_rival_rep` CREATE TABLE block (after line ~167):

```sql
-- Phase 5b: drop rival_gangs FK so generated gang IDs can be stored
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'player_rival_rep'
      AND constraint_type = 'FOREIGN KEY'
      AND constraint_name LIKE '%rival_id%'
  ) THEN
    EXECUTE (
      SELECT 'ALTER TABLE player_rival_rep DROP CONSTRAINT ' || constraint_name
      FROM information_schema.table_constraints
      WHERE table_name = 'player_rival_rep'
        AND constraint_type = 'FOREIGN KEY'
        AND constraint_name LIKE '%rival_id%'
      LIMIT 1
    );
  END IF;
END $$;
```

**Step 2: Apply to dev DB**

```bash
psql carwars -f server/src/db/schema.sql 2>&1 | tail -5
```

Or apply the new statements directly:

```bash
psql carwars -c "ALTER TABLE gangs ADD COLUMN IF NOT EXISTS generated_gangs JSONB;"
psql carwars <<'SQL'
CREATE TABLE IF NOT EXISTS zone_influence (
  settlement_id TEXT NOT NULL,
  gang_id TEXT NOT NULL,
  influence INTEGER NOT NULL DEFAULT 0,
  last_action_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (settlement_id, gang_id)
);
CREATE INDEX IF NOT EXISTS idx_zone_influence_gang ON zone_influence(gang_id);
CREATE INDEX IF NOT EXISTS idx_zone_influence_settlement ON zone_influence(settlement_id);
SQL
```

**Step 3: Verify**

```bash
psql carwars -c "\d gangs" | grep generated_gangs
psql carwars -c "\d zone_influence"
```

**Step 4: Run all tests to make sure nothing broke**

```bash
npm -w @carwars/server run test
```

Expected: all pass.

**Step 5: Commit**

```bash
git add server/src/db/schema.sql
git commit -m "feat(db): generated_gangs column, zone_influence table, drop rival FK"
```

---

## Task 3: Wire gangGen into worldLoader + migrateGeneratedWorlds

**Files:**
- Modify: `server/src/rules/worldLoader.ts`
- Modify: `server/src/db/client.ts`

**Step 1: Read worldLoader.ts** to understand the current generate-and-persist flow (the `if (!world)` branch in `getWorldForGang`).

**Step 2: Update worldLoader.ts** — add gang generation and influence seeding to the world-creation path.

Add import:
```typescript
import { generateGangs, type GeneratedGang } from './gangGen';
```

Update the `getWorldForGang` null-world branch to also generate gangs and seed influence:

```typescript
  if (!world) {
    const seed  = row.world_seed ?? Math.floor(Math.random() * 2147483647);
    world       = generateWorld(seed);
    const gangs = generateGangs(world, seed);

    await db.query(
      `UPDATE gangs
          SET world_seed = $1, generated_world = $2, generated_gangs = $3,
              current_world_node_id = $4
        WHERE owner_player_id = $5`,
      [seed, JSON.stringify(world), JSON.stringify(gangs),
       world.playerStartSettlementId, playerId],
    );

    await seedGangInfluence(db, world, gangs);

    return { world, gangs, gangId: row.id, fromNodeId: world.playerStartSettlementId };
  }
```

Add the `seedGangInfluence` helper and update the return type:

```typescript
async function seedGangInfluence(
  db: Pool,
  world: GeneratedWorld,
  gangs: GeneratedGang[],
): Promise<void> {
  for (const gang of gangs) {
    // Home settlement: full starting influence
    await db.query(
      `INSERT INTO zone_influence (settlement_id, gang_id, influence)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [gang.home_settlement_id, gang.id, gang.starting_influence],
    );
    // Adjacent settlements: partial influence
    const adjRoads = world.roads.filter(
      r => r.from === gang.home_settlement_id || r.to === gang.home_settlement_id,
    );
    for (const road of adjRoads) {
      const adjId    = road.from === gang.home_settlement_id ? road.to : road.from;
      const adjInf   = 10 + Math.floor(Math.random() * 10);
      await db.query(
        `INSERT INTO zone_influence (settlement_id, gang_id, influence)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [adjId, gang.id, adjInf],
      );
    }
  }
}
```

Update the return type to include `gangs`:

```typescript
export async function getWorldForGang(
  db: Pool,
  playerId: string,
): Promise<{ world: GeneratedWorld; gangs: GeneratedGang[]; gangId: string; fromNodeId: string } | null>
```

For the non-null path (world already exists), load `generated_gangs` from the row:

```typescript
  // world already generated
  const gangs: GeneratedGang[] = row.generated_gangs ?? [];
  return { world, gangs, gangId: row.id, fromNodeId: row.current_world_node_id };
```

Update the SELECT query to also fetch `generated_gangs`:
```typescript
  `SELECT id, world_seed, generated_world, generated_gangs, current_world_node_id
     FROM gangs WHERE owner_player_id = $1`
```

And the row type:
```typescript
  const r = await db.query<{
    id: string;
    world_seed: number | null;
    generated_world: GeneratedWorld | null;
    generated_gangs: GeneratedGang[] | null;
    current_world_node_id: string;
  }>(...)
```

**Step 3: Update migrateGeneratedWorlds in db/client.ts** — also generate gangs for migrated gangs:

Add import: `import { generateGangs } from '../rules/gangGen';`

In the migration loop, after generating the world, also generate gangs:

```typescript
    const gangs = generateGangs(world, seed);
    await db.query(
      `UPDATE gangs SET world_seed = $1, generated_world = $2, generated_gangs = $3,
                        current_world_node_id = $4
         WHERE owner_player_id = $5`,
      [seed, JSON.stringify(world), JSON.stringify(gangs),
       world.playerStartSettlementId, row.owner_player_id],
    );
    // Seed influence (skip if already exists)
    // Import and call seedGangInfluence — but it's in worldLoader, not client.ts.
    // Duplicate the seeding logic inline here, or export seedGangInfluence.
```

**Simplest option:** Export `seedGangInfluence` from `worldLoader.ts` and import it in `client.ts`.

Add `export` to `seedGangInfluence` in worldLoader.ts, then in `migrateGeneratedWorlds`:

```typescript
import { seedGangInfluence } from '../rules/worldLoader';
// ...
await seedGangInfluence(db, world, gangs);
```

**Step 4: Fix any call sites** — `getWorldForGang` now returns `gangs` in the object. Check:
- `server/src/api/world.ts` — destructures `ctx` (only uses `ctx.world`, no change needed)
- `server/src/api/deploy.ts` — destructures `worldCtx` (only uses `world` + `fromNodeId`, no change needed)

**Step 5: Build + test**

```bash
npm -w @carwars/server run build && npm -w @carwars/server run test
```

Expected: all pass.

**Step 6: Commit**

```bash
git add server/src/rules/worldLoader.ts server/src/rules/gangGen.ts server/src/db/client.ts
git commit -m "feat(worldLoader): generate gang ecology + seed zone_influence on world creation"
```

---

## Task 4: Write influence on squad deployment resolution

**Files:**
- Modify: `server/src/api/deploy.ts`

**Step 1: Read resolveDueDeployments** in `server/src/api/deploy.ts` to find exactly where `resolveSquadEngagement()` is called and what happens after.

**Step 2: Add influence writing** — after the `resolveSquadEngagement` call (in the `resolveDueDeployments` loop, non-job path), write the influence change to `zone_influence`.

Locate the `result = resolveSquadEngagement({...})` call in the non-job branch. After it, add:

```typescript
    // Write zone influence for non-job deployments (territory operations)
    if (!ctx.isJob && dep.zone_id && gangId) {
      const INFLUENCE_BY_OUTCOME: Record<string, number> = {
        success: 5, partial: 2, failure: 0, routed: -3,
      };
      const influenceDelta = INFLUENCE_BY_OUTCOME[result.outcome] ?? 0;
      if (influenceDelta !== 0) {
        await client.query(
          `INSERT INTO zone_influence (settlement_id, gang_id, influence)
           VALUES ($1, $2, $3)
           ON CONFLICT (settlement_id, gang_id) DO UPDATE
             SET influence = GREATEST(0, zone_influence.influence + $3),
                 last_action_at = NOW()`,
          [dep.zone_id, gangId, influenceDelta],
        );
      }
    }
```

Note: `gangId` is already in scope from the earlier `gangRes` query. `dep.zone_id` is the settlement ID being deployed to. `client` is the DB pool client used inside the transaction — if `resolveDueDeployments` uses a pool directly rather than a transaction client, use `db.query(...)` instead.

**Step 3: Build + test**

```bash
npm -w @carwars/server run build && npm -w @carwars/server run test
```

**Step 4: Commit**

```bash
git add server/src/api/deploy.ts
git commit -m "feat(deploy): write zone influence on squad engagement outcome"
```

---

## Task 5: Territory API

**Files:**
- Create: `server/src/api/territory.ts`
- Modify: `server/src/app.ts` (register router)
- Create: `server/tests/territory.api.test.ts`

**Step 1: Write failing tests**

Create `server/tests/territory.api.test.ts`:

```typescript
import request from 'supertest';
import { describe, it, expect, afterAll } from 'vitest';
import { createApp } from '../src/app';
import { getDb } from '../src/db/client';

const app = createApp();

async function register(suffix: string): Promise<{ token: string; playerId: string }> {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ username: `terrtest-${suffix}`, password: 'testpw123' });
  if (!res.body.token) throw new Error(`Register failed: ${JSON.stringify(res.body)}`);
  return { token: res.body.token, playerId: res.body.playerId };
}

const USERS: string[] = [];
afterAll(async () => {
  const db = getDb();
  for (const u of USERS) {
    await db.query(`DELETE FROM players WHERE username = $1`, [u]);
  }
});

describe('GET /api/territory/influence', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/territory/influence');
    expect(res.status).toBe(401);
  });

  it('returns bySettlement map for authenticated player', async () => {
    const suffix = `ti1-${Date.now()}`;
    USERS.push(`terrtest-${suffix}`);
    const { token } = await register(suffix);

    // Trigger world + gang generation by fetching map
    await request(app).get('/api/world/map').set('Authorization', `Bearer ${token}`);

    const res = await request(app)
      .get('/api/territory/influence')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.bySettlement).toBe('object');
    // At least one settlement should have influence entries (from seeding)
    const entries = Object.values(res.body.bySettlement as Record<string, unknown[]>);
    expect(entries.length).toBeGreaterThan(0);
  });
});
```

Run: `npm -w @carwars/server run test -- territory`
Expected: FAIL (route not found)

**Step 2: Create territory.ts**

```typescript
// server/src/api/territory.ts
import { Router } from 'express';
import { getDb } from '../db/client';
import { requireAuth, AuthRequest } from './middleware';
import { getWorldForGang } from '../rules/worldLoader';

export const territoryRouter = Router();

// GET /api/territory/influence — influence state for all settlements in the player's world
territoryRouter.get('/influence', requireAuth, async (req: AuthRequest, res) => {
  try {
    const db  = getDb();
    const ctx = await getWorldForGang(db, req.playerId!);
    if (!ctx) return res.status(404).json({ error: 'Gang not found' });

    const settlementIds = ctx.world.settlements.map(s => s.id);
    const result = await db.query<{
      settlement_id: string; gang_id: string; influence: number;
    }>(
      `SELECT settlement_id, gang_id, influence
         FROM zone_influence
         WHERE settlement_id = ANY($1::text[])
         ORDER BY settlement_id, influence DESC`,
      [settlementIds],
    );

    const bySettlement: Record<string, { gangId: string; influence: number }[]> = {};
    for (const row of result.rows) {
      if (!bySettlement[row.settlement_id]) bySettlement[row.settlement_id] = [];
      bySettlement[row.settlement_id].push({ gangId: row.gang_id, influence: row.influence });
    }

    return res.json({ bySettlement });
  } catch (err) {
    console.error('[territory/influence]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/territory/player-influence — player's own influence overview
territoryRouter.get('/player-influence', requireAuth, async (req: AuthRequest, res) => {
  try {
    const db  = getDb();
    const ctx = await getWorldForGang(db, req.playerId!);
    if (!ctx) return res.status(404).json({ error: 'Gang not found' });

    const result = await db.query<{
      settlement_id: string; influence: number;
    }>(
      `SELECT settlement_id, influence FROM zone_influence WHERE gang_id = $1 ORDER BY influence DESC`,
      [ctx.gangId],
    );

    const totalInfluence = result.rows.reduce((s, r) => s + r.influence, 0);
    return res.json({
      settlements: result.rows.map(r => r.settlement_id),
      totalInfluence,
    });
  } catch (err) {
    console.error('[territory/player-influence]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
```

**Step 3: Register the router in app.ts**

Open `server/src/app.ts`. Find where other routers are registered (look for `app.use('/api/world', worldRouter)` or similar). Add:

```typescript
import { territoryRouter } from './api/territory';
// ...
app.use('/api/territory', territoryRouter);
```

**Step 4: Run tests**

```bash
npm -w @carwars/server run test -- territory
```

Expected: 2 pass.

**Step 5: Build**

```bash
npm -w @carwars/server run build
```

**Step 6: Commit**

```bash
git add server/src/api/territory.ts server/src/app.ts server/tests/territory.api.test.ts
git commit -m "feat(api): territory influence endpoints"
```

---

## Task 6: WorldMapScene — influence overlay

**Files:**
- Modify: `client/src/scenes/WorldMapScene.ts`

**Step 1: Read WorldMapScene.ts** to understand `drawNodes()` and the `create()` lifecycle. Find where `fetchRegion()` and `fetchCurrentLocation()` are called. Note where node circles are drawn (the `nodeContainer` rendering).

**Step 2: Add influence fetch**

Add a class field:
```typescript
private influenceBySettlement: Record<string, { gangId: string; influence: number }[]> = {};
```

Add a `fetchInfluence` method:
```typescript
private async fetchInfluence(): Promise<void> {
  try {
    const host = window.location.hostname;
    const res  = await fetch(`http://${host}:3001/api/territory/influence`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (res.ok) {
      const data = await res.json();
      this.influenceBySettlement = data.bySettlement ?? {};
    }
  } catch (e) {
    console.error('WorldMapScene fetchInfluence failed:', e);
  }
}
```

Call it in `create()` after `fetchRegion()` and before `drawNodes()`:
```typescript
await this.fetchInfluence();
```

Also reset it in `init()`:
```typescript
this.influenceBySettlement = {};
```

**Step 3: Tint nodes by dominant gang**

In `drawNodes()` (where each settlement node circle is drawn), after the base `nodeColour` is determined, check if this settlement has influence data. If so, find the dominant gang (highest influence) and use its colour as a tint:

Find where the circle for each settlement is drawn (something like `this.add.circle(x, y, r, colour)`). Add logic:

```typescript
// Determine node colour: base kind colour, overridden by dominant gang tint if present
let colour = nodeColour(settlement.kind);
const influence = this.influenceBySettlement[settlement.id];
if (influence && influence.length > 0) {
  // Find the dominant gang (first entry — results are ordered by influence DESC)
  const dominant = influence[0];
  // Find the gang in the generated gangs (gangs aren't stored in WorldMapScene yet —
  // just use a colour derived from gang ID hash for now)
  const hash = dominant.gangId.split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
  const gangColour = Math.abs(hash) % 0xffffff;
  // Blend 30% gang colour into base node colour for a subtle tint
  const r = Math.round(((colour >> 16 & 0xff) * 0.7) + ((gangColour >> 16 & 0xff) * 0.3));
  const g = Math.round(((colour >>  8 & 0xff) * 0.7) + ((gangColour >>  8 & 0xff) * 0.3));
  const b = Math.round(((colour       & 0xff) * 0.7) + ((gangColour       & 0xff) * 0.3));
  colour = (r << 16) | (g << 8) | b;
}
```

**Step 4: Build**

```bash
npm -w @carwars/client run build
```

Fix any TypeScript errors. If the exact location of the circle-drawing code is unclear, search for `nodeColour` calls in drawNodes.

**Step 5: Commit**

```bash
git add client/src/scenes/WorldMapScene.ts
git commit -m "feat(client): WorldMapScene influence overlay — tint nodes by dominant gang"
```

---

## Task 7: Arena rival matching with generated gangs

**Files:**
- Modify: `server/src/rules/rivals.ts`
- Modify: `server/src/ws/handler.ts`

**Step 1: Add generated-gang rival picker to rivals.ts**

Add import:
```typescript
import type { GeneratedGang } from './gangGen';
import type { GeneratedWorld } from '@carwars/shared';
```

Add a function that converts a `GeneratedGang` to a `RivalGang`-compatible shape for the arena:

```typescript
export function adaptGeneratedGang(gang: GeneratedGang): RivalGang {
  return {
    id: gang.id,
    name: gang.name,
    description: `A rival gang operating out of the wasteland`,
    base_skill: 3,
    primary_colour: gang.primary_colour,
    secondary_colour: gang.secondary_colour,
    emblem_id: 'default',
    min_division: 5,
    boast_lines: [],
    defeat_lines: [],
    lineup: {},  // empty → generic AI vehicles
  };
}

// Pick a generated gang as rival for the current settlement.
// Prefers gangs with zone_influence in the player's current location.
export async function pickGeneratedRivalForMatch(
  db: Pool,
  currentSettlementId: string,
  generatedGangs: GeneratedGang[],
  playerGangId: string,
): Promise<RivalGang | null> {
  if (!generatedGangs.length) return null;

  // Get gangs with influence in the current settlement
  const res = await db.query<{ gang_id: string; influence: number }>(
    `SELECT gang_id, influence FROM zone_influence
       WHERE settlement_id = $1 ORDER BY influence DESC`,
    [currentSettlementId],
  );

  const gangMap = new Map(generatedGangs.map(g => [g.id, g]));
  const localGangs = res.rows
    .map(r => gangMap.get(r.gang_id))
    .filter((g): g is GeneratedGang => !!g);

  // Prefer local gangs, fall back to any generated gang
  const candidates = localGangs.length ? localGangs : generatedGangs;
  const picked = candidates[Math.floor(Math.random() * candidates.length)];
  return adaptGeneratedGang(picked);
}
```

**Step 2: Update ws/handler.ts to use generated gangs**

In `ws/handler.ts`, find the rival selection block (around line 650–680) where `pickRivalForMatch` is called. Read that block carefully before editing.

Import the new function:
```typescript
import { pickRivalForMatch, pickGeneratedRivalForMatch, recordRivalOutcome, rivalEffectiveSkill, type RivalGang, adaptGeneratedGang } from '../rules/rivals';
```

In the rival-selection block, add a fallback path: if the player has generated gangs, try `pickGeneratedRivalForMatch` first, then fall back to the authored `pickRivalForMatch`:

```typescript
// Try generated gangs first (prefer local territory presence)
if (generatedGangs.length && currentSettlementId) {
  rival = await pickGeneratedRivalForMatch(db, currentSettlementId, generatedGangs, gang_id);
}
// Fall back to authored rival_gangs if no generated rival found
if (!rival) {
  rival = await pickRivalForMatch(db, gang_id, division);
}
```

To make this work, `generatedGangs` and `currentSettlementId` need to be in scope. Find where `gang_id` and `division` are fetched in the arena-start block, and add:

```typescript
// Fetch generated gangs and current settlement for Phase 5b rival selection
const gangRow = await db.query<{
  generated_gangs: GeneratedGang[] | null;
  current_world_node_id: string;
}>(
  `SELECT generated_gangs, current_world_node_id FROM gangs WHERE id = $1`,
  [gang_id],
);
const generatedGangs: GeneratedGang[] = gangRow.rows[0]?.generated_gangs ?? [];
const currentSettlementId: string     = gangRow.rows[0]?.current_world_node_id ?? '';
```

Add import for `GeneratedGang` at the top:
```typescript
import type { GeneratedGang } from '../rules/gangGen';
```

**Step 3: Build + test**

```bash
npm -w @carwars/server run build && npm -w @carwars/server run test
```

Fix any TypeScript errors. The `ws.test.ts` may need the generated_gangs column to exist (it does from Task 2).

**Step 4: Commit**

```bash
git add server/src/rules/rivals.ts server/src/ws/handler.ts
git commit -m "feat(rivals): generated gang arena matching with zone_influence preference"
```

---

## Task 8: Full verification

**Step 1: Full test suite**

```bash
npm -w @carwars/server run test
```

Expected: all pass (gangGen: 7, territory.api: 2, worldGen: 13, worldmap: 6, others unchanged).

**Step 2: Full build**

```bash
npm -w @carwars/server run build && npm -w @carwars/client run build
```

**Step 3: Deploy**

```bash
./scripts/deploy.sh
```

**Step 4: Manual smoke test**

1. Open the game → World Map → nodes should be colour-tinted by dominant gang
2. Deploy a squad to a zone → check zone_influence table updated:
   ```bash
   ssh paddy@10.202.28.192 "psql -d carwars -c 'SELECT settlement_id, gang_id, influence FROM zone_influence LIMIT 10;'"
   ```
3. Arena match → confirm a generated gang name appears (not just authored rival_gangs names)

**Step 5: Tag + push**

```bash
git tag phase-5b
git push origin main --tags
```

---

## Phase 5b complete

Deliverables:
- `server/src/rules/gangGen.ts` — deterministic gang generator
- `server/src/db/schema.sql` — zone_influence table, generated_gangs column, rival FK dropped
- `server/src/rules/worldLoader.ts` — generates gangs + seeds influence alongside world
- `server/src/api/deploy.ts` — writes influence change after squad engagement
- `server/src/api/territory.ts` — influence endpoints
- `client/src/scenes/WorldMapScene.ts` — influence overlay on nodes
- `server/src/rules/rivals.ts` — generated gang arena matching
- `server/tests/gangGen.test.ts`, `server/tests/territory.api.test.ts` — new tests

Next: Phase 5c — Rival AI sim & "while you were away" log
