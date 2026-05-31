# Phase 5c — Rival AI Sim & "While You Were Away" Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a lazy rival AI that simulates gang actions between player visits and surfaces them as a "While you were away" log in the garage.

**Architecture:** `resolveRivalActions(playerId, db)` runs lazily when the player opens the garage — it reads `last_rival_sim_at` from the gang row, computes up to 24 turns of rival actions in memory using zone_influence state, batch-writes influence changes + logs to `gang_action_log`, then updates `last_rival_sim_at`. The garage fetches `/api/territory/activity/unread-count` on load; if > 0 it shows a badge and, when clicked, a collapsible log panel. "[ACKNOWLEDGE]" marks all read.

**Tech Stack:** TypeScript, Express, Postgres, Vitest + Supertest, Phaser 3 (client — build-verified only).

**Design doc:** `docs/plans/2026-05-31-phase5a-design.md` (Phase 5 overall)

**Conventions:** Build: `npm -w @carwars/server run build`, `npm -w @carwars/client run build`. Tests: `npm -w @carwars/server run test`. Register new routers in `server/src/app.ts`. `requireAuth` from `./middleware`. Territory router already exists at `server/src/api/territory.ts`.

---

## Task 1: Schema — gang_action_log table + last_rival_sim_at column

**Files:**
- Modify: `server/src/db/schema.sql`

**Step 1: Add to schema.sql** — after the `generated_gangs` line (around line 643), add:

```sql
ALTER TABLE gangs ADD COLUMN IF NOT EXISTS last_rival_sim_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS gang_action_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id    UUID REFERENCES players(id) ON DELETE CASCADE,
  action_type  TEXT NOT NULL,           -- 'patrol' | 'expand' | 'harass' | 'attack'
  gang_id      TEXT NOT NULL,
  gang_name    TEXT NOT NULL,
  settlement_id   TEXT NOT NULL,
  settlement_name TEXT NOT NULL,
  description  TEXT NOT NULL,
  read         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gang_action_log_player
  ON gang_action_log(player_id, created_at DESC);
```

**Step 2: Apply to dev DB**

```bash
psql carwars -c "ALTER TABLE gangs ADD COLUMN IF NOT EXISTS last_rival_sim_at TIMESTAMPTZ;"
psql carwars <<'SQL'
CREATE TABLE IF NOT EXISTS gang_action_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID REFERENCES players(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  gang_id TEXT NOT NULL,
  gang_name TEXT NOT NULL,
  settlement_id TEXT NOT NULL,
  settlement_name TEXT NOT NULL,
  description TEXT NOT NULL,
  read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gang_action_log_player
  ON gang_action_log(player_id, created_at DESC);
SQL
```

**Step 3: Verify**

```bash
psql carwars -c "\d gangs" | grep last_rival_sim_at
psql carwars -c "\d gang_action_log"
```

**Step 4: Run all tests**

```bash
npm -w @carwars/server run test
```

**Step 5: Commit**

```bash
git add server/src/db/schema.sql
git commit -m "feat(db): gang_action_log table + last_rival_sim_at column on gangs"
```

---

## Task 2: rivalSim.ts — lazy rival AI module

**Files:**
- Create: `server/src/rules/rivalSim.ts`
- Create: `server/tests/rivalSim.test.ts`

**Step 1: Write failing tests**

Create `server/tests/rivalSim.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { resolveRivalActions } from '../src/rules/rivalSim';

// resolveRivalActions requires a real DB — test the pure helpers instead.
// Integration coverage comes from the territory.api tests that hit the full stack.

describe('resolveRivalActions module', () => {
  it('exports resolveRivalActions as a function', () => {
    expect(typeof resolveRivalActions).toBe('function');
  });
});
```

Run: `npm -w @carwars/server run test -- rivalSim` — expect FAIL (module not found).

**Step 2: Create server/src/rules/rivalSim.ts**

```typescript
import type { Pool } from 'pg';
import type { GeneratedWorld, GeneratedSettlement } from '@carwars/shared';
import type { GeneratedGang } from './gangGen';
import { getWorldForGang } from './worldLoader';

export interface RivalActionLog {
  gangId:         string;
  gangName:       string;
  settlementId:   string;
  settlementName: string;
  actionType:     'patrol' | 'expand' | 'harass' | 'attack';
  description:    string;
}

// ─── In-memory influence map ─────────────────────────────────────────────────
// key: "settlementId:gangId"
type InfluenceMap = Map<string, number>;

function infKey(settlementId: string, gangId: string): string {
  return `${settlementId}:${gangId}`;
}

function getInf(map: InfluenceMap, sid: string, gid: string): number {
  return map.get(infKey(sid, gid)) ?? 0;
}

function setInf(map: InfluenceMap, sid: string, gid: string, val: number): void {
  map.set(infKey(sid, gid), Math.max(0, val));
}

// ─── Weighted action roll ────────────────────────────────────────────────────
function rollAction(): 'patrol' | 'expand' | 'harass' | 'attack' {
  const r = Math.random();
  if (r < 0.40) return 'patrol';
  if (r < 0.65) return 'expand';
  if (r < 0.85) return 'harass';
  return 'attack';
}

// ─── Adjacent settlement IDs ─────────────────────────────────────────────────
function adjacentTo(world: GeneratedWorld, sid: string): string[] {
  return world.roads
    .filter(r => r.from === sid || r.to === sid)
    .map(r => r.from === sid ? r.to : r.from);
}

// ─── Simulate one turn for one gang ─────────────────────────────────────────
function simulateTurn(
  gang: GeneratedGang,
  world: GeneratedWorld,
  influence: InfluenceMap,
  allGangs: GeneratedGang[],
): RivalActionLog | null {
  const settlements = world.settlements;
  const action = rollAction();

  if (action === 'patrol') {
    // Gain influence in a settlement where this gang already has presence
    const present = settlements.filter(s => getInf(influence, s.id, gang.id) > 0);
    if (!present.length) return null;
    const target = present[Math.floor(Math.random() * present.length)];
    const gain   = 1 + Math.floor(getInf(influence, target.id, gang.id) / 20);
    setInf(influence, target.id, gang.id, getInf(influence, target.id, gang.id) + gain);
    return {
      gangId: gang.id, gangName: gang.name,
      settlementId: target.id, settlementName: target.name,
      actionType: 'patrol',
      description: `${gang.name} patrolled ${target.name} → +${gain} influence`,
    };
  }

  if (action === 'expand') {
    // Gain influence in an adjacent settlement with no current presence
    const present = settlements.filter(s => getInf(influence, s.id, gang.id) > 0).map(s => s.id);
    const adjIds  = new Set(present.flatMap(sid => adjacentTo(world, sid)));
    const targets = settlements.filter(s => adjIds.has(s.id) && getInf(influence, s.id, gang.id) === 0);
    if (!targets.length) return null;
    const target = targets[Math.floor(Math.random() * targets.length)];
    const gain   = 5 + Math.floor(Math.random() * 6);  // 5-10
    setInf(influence, target.id, gang.id, gain);
    return {
      gangId: gang.id, gangName: gang.name,
      settlementId: target.id, settlementName: target.name,
      actionType: 'expand',
      description: `${gang.name} expanded into ${target.name} → +${gain} influence`,
    };
  }

  if (action === 'harass') {
    // Reduce another gang's influence in a shared settlement
    const shared = settlements.filter(s => {
      if (getInf(influence, s.id, gang.id) === 0) return false;
      return allGangs.some(g => g.id !== gang.id && getInf(influence, s.id, g.id) > 0);
    });
    if (!shared.length) return null;
    const target = shared[Math.floor(Math.random() * shared.length)];
    const rivals = allGangs.filter(g => g.id !== gang.id && getInf(influence, target.id, g.id) > 0);
    if (!rivals.length) return null;
    const victim = rivals[Math.floor(Math.random() * rivals.length)];
    const loss   = 3 + Math.floor(Math.random() * 6);  // 3-8
    setInf(influence, target.id, victim.id, getInf(influence, target.id, victim.id) - loss);
    return {
      gangId: gang.id, gangName: gang.name,
      settlementId: target.id, settlementName: target.name,
      actionType: 'harass',
      description: `${gang.name} harassed ${victim.name} in ${target.name} → -${loss} influence`,
    };
  }

  // attack — log the threat; no DEFEND/SIMULATE flow in Phase 5c (anti-rabbit-hole rule 4)
  const home = world.settlements.find(s => s.id === gang.home_settlement_id);
  if (!home) return null;
  return {
    gangId: gang.id, gangName: gang.name,
    settlementId: home.id, settlementName: home.name,
    actionType: 'attack',
    description: `⚠ ${gang.name} is threatening your territory in ${home.name}`,
  };
}

// ─── Main export ─────────────────────────────────────────────────────────────
export async function resolveRivalActions(
  playerId: string,
  db: Pool,
): Promise<RivalActionLog[]> {
  const ctx = await getWorldForGang(db, playerId);
  if (!ctx || !ctx.gangs.length) return [];

  const { world, gangs } = ctx;

  // How many hours (turns) since last sim? Cap at 24 for homelab.
  const timeRow = await db.query<{
    last_rival_sim_at: Date | null;
    id: string;
  }>(
    `SELECT last_rival_sim_at, id FROM gangs WHERE owner_player_id = $1`,
    [playerId],
  );
  if (!timeRow.rows.length) return [];

  const last = timeRow.rows[0].last_rival_sim_at;
  const hours = last
    ? Math.min(24, Math.floor((Date.now() - last.getTime()) / 3_600_000))
    : 1;  // first visit: simulate 1 hour

  if (hours === 0) return [];

  // Load current influence into memory map
  const settlementIds = world.settlements.map(s => s.id);
  const infRows = await db.query<{ settlement_id: string; gang_id: string; influence: number }>(
    `SELECT settlement_id, gang_id, influence FROM zone_influence
       WHERE settlement_id = ANY($1::text[])`,
    [settlementIds],
  );
  const influence: InfluenceMap = new Map();
  for (const r of infRows.rows) {
    influence.set(infKey(r.settlement_id, r.gang_id), r.influence);
  }

  // Simulate turns in memory
  const logs: RivalActionLog[] = [];
  for (let t = 0; t < hours; t++) {
    for (const gang of gangs) {
      const log = simulateTurn(gang, world, influence, gangs);
      if (log) logs.push(log);
    }
  }

  if (!logs.length) {
    await db.query(
      `UPDATE gangs SET last_rival_sim_at = NOW() WHERE owner_player_id = $1`,
      [playerId],
    );
    return [];
  }

  // Batch-write influence changes
  for (const [key, val] of influence.entries()) {
    const [sid, gid] = key.split(':');
    await db.query(
      `INSERT INTO zone_influence (settlement_id, gang_id, influence)
       VALUES ($1, $2, $3)
       ON CONFLICT (settlement_id, gang_id) DO UPDATE SET influence = $3, last_action_at = NOW()`,
      [sid, gid, val],
    );
  }

  // Write log entries (keep max 100 per player — trim oldest if over)
  for (const log of logs.slice(0, 50)) {
    await db.query(
      `INSERT INTO gang_action_log
         (player_id, action_type, gang_id, gang_name, settlement_id, settlement_name, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [playerId, log.actionType, log.gangId, log.gangName,
       log.settlementId, log.settlementName, log.description],
    );
  }

  // Trim oldest if over 100
  await db.query(
    `DELETE FROM gang_action_log
       WHERE player_id = $1
         AND id NOT IN (
           SELECT id FROM gang_action_log WHERE player_id = $1
           ORDER BY created_at DESC LIMIT 100
         )`,
    [playerId],
  );

  // Update sim timestamp
  await db.query(
    `UPDATE gangs SET last_rival_sim_at = NOW() WHERE owner_player_id = $1`,
    [playerId],
  );

  return logs;
}
```

**Step 3: Run tests — expect PASS**

```bash
npm -w @carwars/server run test -- rivalSim
```

**Step 4: Build**

```bash
npm -w @carwars/server run build
```

**Step 5: Commit**

```bash
git add server/src/rules/rivalSim.ts server/tests/rivalSim.test.ts
git commit -m "feat(rivalSim): lazy rival AI — simulates gang actions between player visits"
```

---

## Task 3: Activity API — three endpoints in territory.ts

**Files:**
- Modify: `server/src/api/territory.ts`
- Modify: `server/tests/territory.api.test.ts`

**Step 1: Add failing tests** to `server/tests/territory.api.test.ts` (append to existing describe blocks):

```typescript
describe('GET /api/territory/activity/unread-count', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/territory/activity/unread-count');
    expect(res.status).toBe(401);
  });

  it('returns unread count for authenticated player', async () => {
    const suffix = `ta1-${Date.now()}`;
    USERS.push(`terrtest-${suffix}`);
    const { token } = await register(suffix);

    await request(app).get('/api/world/map').set('Authorization', `Bearer ${token}`);

    const res = await request(app)
      .get('/api/territory/activity/unread-count')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.unread).toBe('number');
  });
});

describe('GET /api/territory/activity', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/territory/activity');
    expect(res.status).toBe(401);
  });

  it('returns activity log array', async () => {
    const suffix = `ta2-${Date.now()}`;
    USERS.push(`terrtest-${suffix}`);
    const { token } = await register(suffix);

    await request(app).get('/api/world/map').set('Authorization', `Bearer ${token}`);

    const res = await request(app)
      .get('/api/territory/activity')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
  });
});

describe('POST /api/territory/activity/read-all', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).post('/api/territory/activity/read-all');
    expect(res.status).toBe(401);
  });
});
```

Run: `npm -w @carwars/server run test -- territory` — expect FAIL (routes not found).

**Step 2: Add to territory.ts** — append three new routes before the end of the file:

```typescript
import { resolveRivalActions } from '../rules/rivalSim';

// GET /api/territory/activity/unread-count — badge count + triggers rival sim
territoryRouter.get('/activity/unread-count', requireAuth, async (req: AuthRequest, res) => {
  try {
    const db = getDb();
    // Run the lazy rival sim on every garage visit
    await resolveRivalActions(req.playerId!, db);

    const result = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM gang_action_log
         WHERE player_id = $1 AND read = FALSE`,
      [req.playerId],
    );
    return res.json({ unread: result.rows[0]?.n ?? 0 });
  } catch (err) {
    console.error('[territory/activity/unread-count]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/territory/activity — recent rival action log (newest first)
territoryRouter.get('/activity', requireAuth, async (req: AuthRequest, res) => {
  try {
    const db = getDb();
    const result = await db.query<{
      id: string; action_type: string; gang_name: string;
      settlement_name: string; description: string; read: boolean; created_at: Date;
    }>(
      `SELECT id, action_type, gang_name, settlement_name, description, read, created_at
         FROM gang_action_log
         WHERE player_id = $1
         ORDER BY created_at DESC LIMIT 50`,
      [req.playerId],
    );
    return res.json({ entries: result.rows });
  } catch (err) {
    console.error('[territory/activity]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/territory/activity/read-all — mark all activity log entries read
territoryRouter.post('/activity/read-all', requireAuth, async (req: AuthRequest, res) => {
  try {
    const db = getDb();
    await db.query(
      `UPDATE gang_action_log SET read = TRUE WHERE player_id = $1`,
      [req.playerId],
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('[territory/activity/read-all]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
```

**Important:** The import of `resolveRivalActions` must be added at the top of `territory.ts`. Also — `resolveRivalActions` calls `getWorldForGang` which is already imported.

**Step 3: Run tests**

```bash
npm -w @carwars/server run test -- territory
```

Expected: all 11 territory tests pass (4 existing + 7 new).

**Step 4: Build + full suite**

```bash
npm -w @carwars/server run build && npm -w @carwars/server run test
```

**Step 5: Commit**

```bash
git add server/src/api/territory.ts server/tests/territory.api.test.ts
git commit -m "feat(api): territory activity endpoints — rival action log + unread count + read-all"
```

---

## Task 4: GarageScene — "While you were away" badge + log panel

**Files:**
- Modify: `client/src/scenes/GarageScene.ts`

**Step 1: Read GarageScene.ts** — understand the current structure:
- `private unreadReports = 0` class field (line ~48)
- `Promise.all([...])` in `create()` (line ~70) — fetches 8 endpoints
- `renderGarage()` — nav bar around line 480, `[REPORTS]` button + badge around line 487-500

**Step 2: Add class field and fetch**

Add after `private unreadReports = 0`:
```typescript
private unreadActivity = 0;
private activityLog: { id: string; description: string; action_type: string; read: boolean }[] = [];
private showActivityLog = false;
```

In `init()`, reset them:
```typescript
this.unreadActivity = 0;
this.activityLog = [];
this.showActivityLog = false;
```

In `create()`, add to the `Promise.all` array (it currently has 8 entries — add a 9th):
```typescript
      fetch(`http://${host}:3001/api/territory/activity/unread-count`, { headers: { Authorization: `Bearer ${this.token}` } }),
```

Then in the destructured result, add `actRes` at the end:
```typescript
    const [meRes, vRes, dRes, gRes, reqRes, bayRes, repRes, depRes, actRes] = await Promise.all([...]);
```

After the existing `if (repRes.ok) this.unreadReports = (await repRes.json()).unread ?? 0;`, add:
```typescript
    if (actRes.ok) this.unreadActivity = (await actRes.json()).unread ?? 0;
```

Also fetch the log entries if there are unread ones (fetch separately, not in Promise.all — avoid slowing initial load for 0-activity case):
```typescript
    if (this.unreadActivity > 0) {
      try {
        const logRes = await fetch(`http://${host}:3001/api/territory/activity`, {
          headers: { Authorization: `Bearer ${this.token}` },
        });
        if (logRes.ok) this.activityLog = (await logRes.json()).entries ?? [];
      } catch (_e) {}
    }
```

**Step 3: Add "[ACTIVITY]" button + badge to nav bar in renderGarage()**

In `renderGarage()`, find the `[REPORTS]` button section (around line 487). After the reports badge block (after line ~500), add the Activity button:

```typescript
    // ── Rival activity button + badge ──────────────────────────────────────────
    const actX = reportsBtn.x + reportsBtn.width + 16;
    const actBtn = this.add.text(actX, navY, '[ACTIVITY]', {
      color: this.unreadActivity > 0 ? '#ff8888' : '#888888',
      fontSize: '16px', fontFamily: 'monospace',
      backgroundColor: this.unreadActivity > 0 ? '#330011' : '#111111',
      padding: { x: 8, y: 4 },
    }).setInteractive();
    actBtn.on('pointerdown', () => {
      this.showActivityLog = !this.showActivityLog;
      this.renderGarage();
    });
    add(actBtn);
    if (this.unreadActivity > 0) {
      const abx = actBtn.x + actBtn.width;
      add(this.add.circle(abx, navY - 2, 10, 0xff3333).setOrigin(0.5));
      add(this.add.text(abx, navY - 2, String(this.unreadActivity), {
        color: '#ffffff', fontSize: '12px', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5));
    }
```

**Step 4: Add the activity log panel**

At the end of `renderGarage()`, before closing brace, add:

```typescript
    // ── "While you were away" activity log panel ───────────────────────────────
    if (this.showActivityLog) {
      const panelX = leftX;
      const panelY = navY - 180;
      const panelW = width - leftX * 2;

      add(this.add.rectangle(panelX + panelW / 2, panelY + 75, panelW, 160, 0x110011, 0.95).setOrigin(0.5));
      add(this.add.text(panelX + 8, panelY + 4, '═══ WHILE YOU WERE AWAY ═══', {
        color: '#ff8888', fontSize: '13px', fontFamily: 'monospace', fontStyle: 'bold',
      }));

      const entries = this.activityLog.slice(0, 5);
      if (!entries.length) {
        add(this.add.text(panelX + 8, panelY + 24, '  No recent rival activity.', {
          color: '#666666', fontSize: '12px', fontFamily: 'monospace',
        }));
      } else {
        entries.forEach((e, i) => {
          const col = e.action_type === 'attack' ? '#ff4444'
            : e.action_type === 'harass' ? '#ffaa44'
            : '#aaaaff';
          add(this.add.text(panelX + 8, panelY + 24 + i * 18, `  ${e.description}`, {
            color: col, fontSize: '12px', fontFamily: 'monospace',
          }));
        });
      }

      if (this.unreadActivity > 0) {
        const ackBtn = this.add.text(panelX + 8, panelY + 120, '[ACKNOWLEDGE — mark all read]', {
          color: '#ffddaa', fontSize: '13px', fontFamily: 'monospace',
          backgroundColor: '#332200', padding: { x: 6, y: 3 },
        }).setInteractive();
        ackBtn.on('pointerdown', async () => {
          const host = window.location.hostname;
          await fetch(`http://${host}:3001/api/territory/activity/read-all`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.token}` },
          });
          this.unreadActivity = 0;
          this.showActivityLog = false;
          this.renderGarage();
        });
        add(ackBtn);
      }
    }
```

Note: `leftX` and `navY` are local variables computed earlier in `renderGarage()`. Confirm these names match by reading the method — they may differ.

**Step 5: Build**

```bash
npm -w @carwars/client run build
```

Fix TypeScript errors. The most common issues:
- Promise.all destructuring needs the 9th element
- `actX` reference to `reportsBtn.x` — confirm `reportsBtn` is still in scope when Activity button is added
- `leftX` / `navY` variable names — verify by reading renderGarage()

**Step 6: Commit**

```bash
git add client/src/scenes/GarageScene.ts
git commit -m "feat(client): 'While you were away' rival activity log in garage"
```

---

## Task 5: Full verification

**Step 1: Full test suite**

```bash
npm -w @carwars/server run test
```

Expected: all pass (rivalSim: 1, territory.api: 11, others unchanged).

**Step 2: Full build**

```bash
npm -w @carwars/server run build && npm -w @carwars/client run build
```

**Step 3: Deploy**

```bash
./scripts/deploy.sh
```

**Step 4: Manual smoke test**

1. Open the game → Garage. Confirm `[ACTIVITY]` button appears in nav bar.
2. If unread activity > 0 (wait an hour or manually insert a gang_action_log row to test), confirm badge appears and clicking shows log.
3. Click `[ACKNOWLEDGE]` — badge clears.
4. Insert a test log entry to verify display:
   ```bash
   ssh paddy@10.202.28.192 "psql -d carwars -c \"
     INSERT INTO gang_action_log (player_id, action_type, gang_id, gang_name, settlement_id, settlement_name, description)
     SELECT owner_player_id, 'patrol', 'test-gang', 'Test Wolves', 'test-s', 'Testfall', 'Test Wolves patrolled Testfall → +3 influence'
     FROM gangs LIMIT 1;
   \""
   ```
   Then refresh game and verify badge + log entry appears.

**Step 5: Tag + push**

```bash
git tag phase-5c
git remote set-url origin https://PadsterH2012:<TOKEN>@github.com/PadsterH2012/CarWars.git
git push origin main --tags
git remote set-url origin https://github.com/PadsterH2012/CarWars.git
```

---

## Phase 5c complete

Deliverables:
- `server/src/db/schema.sql` — `gang_action_log` table + `last_rival_sim_at` on gangs
- `server/src/rules/rivalSim.ts` — lazy rival AI (up to 24 turns, in-memory simulation, batch writes)
- `server/src/api/territory.ts` — 3 new endpoints: `/activity/unread-count`, `/activity`, `/activity/read-all`
- `client/src/scenes/GarageScene.ts` — `[ACTIVITY]` badge + "While you were away" log panel
- `server/tests/rivalSim.test.ts` + extended `territory.api.test.ts`

Next: Phase 5d — Leaderboard & Endgame
