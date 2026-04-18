# Economy & Repair Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete the economy loop — ammo depletes and persists between fights, repair costs reflect armor type and ammo, prizes scale by division, jobs can be taken and auto-complete on arena win, the post-arena screen shows the full financial result, and the garage is functional enough to drive the fight→repair→fight cycle.

**Architecture:** The backend is largely in place (auth, vehicles, drivers, economy, jobs, division all exist). The gaps are: ammo persistence (loadout not saved on disconnect), repair missing ammo/tires, zone_end message not including prize amount, no job→arena integration, and a thin post-arena UX. This plan closes those gaps without restructuring anything.

**Tech Stack:** TypeScript throughout. PostgreSQL via `pg`. Phaser 3 DOM-free scenes. Vitest + supertest for backend tests. No new dependencies needed.

---

### Task 1: Ammo persistence + repair completeness

**Problem:** Ammo is in `loadout.mounts[].ammo` but only `damage_state` is saved on disconnect — so ammo resets to full on every fight. Repair also doesn't fix blown tires or restore ammo, and doesn't apply armor-type cost multipliers.

**Files:**
- Modify: `server/src/db/schema.sql`
- Modify: `server/src/api/vehicles.ts`
- Modify: `server/src/ws/handler.ts`
- Modify: `server/src/api/economy.ts`
- Modify: `server/tests/economy.test.ts`

**Step 1: Write failing tests**

Add to `server/tests/economy.test.ts` (at the end of the `describe('economy')` block):

```typescript
it('repair restores blown tires and deducts tire cost', async () => {
  const db = getDb();
  await db.query(
    `UPDATE vehicles SET damage_state = $1 WHERE id = $2`,
    [JSON.stringify({
      armor: { front: 6, back: 4, left: 4, right: 4, top: 2, underbody: 2 },
      engineDamaged: false, driverWounded: false, tiresBlown: [0, 1], destroyed: false
    }), vehicleId]
  );
  await db.query(`UPDATE players SET money = 25000 WHERE id = $1`, [playerId]);

  const res = await request(app)
    .post('/api/economy/repair')
    .set('Authorization', `Bearer ${token}`)
    .send({ vehicleId });

  expect(res.status).toBe(200);
  expect(res.body.cost).toBe(300); // 2 tires × $150
  const vRes = await db.query(`SELECT damage_state FROM vehicles WHERE id = $1`, [vehicleId]);
  expect(vRes.rows[0].damage_state.tiresBlown).toEqual([]);
});

it('repair restores ammo and charges ammoCost per round', async () => {
  const db = getDb();
  // Deplete ammo on mount m0 (mg, ammoCost: $25/round, original: 50 rounds)
  await db.query(
    `UPDATE vehicles SET
       damage_state = $1,
       loadout = jsonb_set(loadout, '{mounts,0,ammo}', '10')
     WHERE id = $2`,
    [JSON.stringify({
      armor: { front: 6, back: 4, left: 4, right: 4, top: 2, underbody: 2 },
      engineDamaged: false, driverWounded: false, tiresBlown: [], destroyed: false
    }), vehicleId]
  );
  await db.query(`UPDATE players SET money = 25000 WHERE id = $1`, [playerId]);

  const res = await request(app)
    .post('/api/economy/repair')
    .set('Authorization', `Bearer ${token}`)
    .send({ vehicleId });

  expect(res.status).toBe(200);
  expect(res.body.cost).toBe(1000); // 40 rounds × $25
  const vRes = await db.query(`SELECT loadout FROM vehicles WHERE id = $1`, [vehicleId]);
  expect(vRes.rows[0].loadout.mounts[0].ammo).toBe(50);
});
```

**Step 2: Run tests to confirm they fail**

```bash
cd server && npx vitest run tests/economy.test.ts
```
Expected: both new tests FAIL (tires and ammo cases not handled yet).

**Step 3: Add `original_loadout` column to schema**

In `server/src/db/schema.sql`, add after the `value` line in the vehicles table:

```sql
CREATE TABLE IF NOT EXISTS vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID REFERENCES players(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  loadout JSONB NOT NULL,
  original_loadout JSONB,
  damage_state JSONB NOT NULL DEFAULT '{}',
  value INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Step 4: Save `original_loadout` on vehicle creation**

In `server/src/api/vehicles.ts`, replace the INSERT:

```typescript
// Before:
const result = await db.query(
  `INSERT INTO vehicles (player_id, name, loadout, damage_state, value)
   VALUES ($1, $2, $3, $4, $5) RETURNING id`,
  [req.playerId, name, JSON.stringify(loadout), JSON.stringify(defaultDamageState), loadout.totalCost]
);

// After:
const result = await db.query(
  `INSERT INTO vehicles (player_id, name, loadout, original_loadout, damage_state, value)
   VALUES ($1, $2, $3, $3, $4, $5) RETURNING id`,
  [req.playerId, name, JSON.stringify(loadout), JSON.stringify(defaultDamageState), loadout.totalCost]
);
```

Note: `$3` appears twice — both `loadout` and `original_loadout` get the same value at creation.

**Step 5: Save loadout (with depleted ammo) on disconnect**

In `server/src/ws/handler.ts`, in `removeClientFromZone`, replace the UPDATE query:

```typescript
// Before:
await db.query(
  'UPDATE vehicles SET damage_state = $1 WHERE id = $2 AND player_id = $3',
  [JSON.stringify(vehicle.stats.damageState), vehicleId, playerId]
);

// After:
await db.query(
  'UPDATE vehicles SET damage_state = $1, loadout = $2 WHERE id = $3 AND player_id = $4',
  [
    JSON.stringify(vehicle.stats.damageState),
    JSON.stringify(vehicle.stats.loadout),
    vehicleId,
    playerId
  ]
);
```

**Step 6: Update repair endpoint**

Replace the entire `server/src/api/economy.ts` file with:

```typescript
import { Router } from 'express';
import { getDb } from '../db/client';
import { requireAuth, AuthRequest } from './middleware';
import { WEAPONS } from '../rules/data/weapons';
import type { VehicleLoadout, DamageState, ArmorDistribution } from '@carwars/shared';

export const economyRouter = Router();
economyRouter.use(requireAuth);

const ARMOR_REPAIR_COST  = 100;  // per point (ablative base)
const ENGINE_REPAIR_COST = 500;
const TIRE_REPAIR_COST   = 150;  // per blown tire

// Repair cost multiplier matches build cost multiplier for each armor type
const ARMOR_REPAIR_MUL: Record<string, number> = {
  ablative: 1, metal: 1, fireproof: 2, laser_reflective: 2, lr_fireproof: 4, radarproof: 2,
};

economyRouter.post('/repair', async (req: AuthRequest, res) => {
  const { vehicleId } = req.body;
  if (!vehicleId) return res.status(400).json({ error: 'vehicleId required' });

  const db = getDb();
  const [vResult, pResult] = await Promise.all([
    db.query(
      `SELECT id, loadout, original_loadout, damage_state, player_id
       FROM vehicles WHERE id = $1 AND player_id = $2`,
      [vehicleId, req.playerId]
    ),
    db.query(`SELECT money FROM players WHERE id = $1`, [req.playerId])
  ]);

  if (!vResult.rows.length) return res.status(403).json({ error: 'Vehicle not found' });

  const vehicle      = vResult.rows[0];
  const loadout      = vehicle.loadout as VehicleLoadout;
  const origLoadout  = (vehicle.original_loadout ?? loadout) as VehicleLoadout;
  const damage       = vehicle.damage_state as DamageState;
  const playerMoney  = pResult.rows[0].money as number;

  let cost = 0;
  const armorMul = ARMOR_REPAIR_MUL[loadout.armorType ?? 'ablative'] ?? 1;

  // Armor repair
  const locations: (keyof ArmorDistribution)[] = ['front', 'back', 'left', 'right', 'top', 'underbody'];
  for (const loc of locations) {
    const deficit = (origLoadout.armor[loc] ?? 0) - (damage.armor[loc] ?? 0);
    if (deficit > 0) cost += deficit * ARMOR_REPAIR_COST * armorMul;
  }

  // Engine repair
  if (damage.engineDamaged) cost += ENGINE_REPAIR_COST;

  // Tire repair
  cost += (damage.tiresBlown?.length ?? 0) * TIRE_REPAIR_COST;

  // Ammo resupply
  for (const origMount of origLoadout.mounts ?? []) {
    const currentMount = loadout.mounts?.find(m => m.id === origMount.id);
    const shortage = origMount.ammo - (currentMount?.ammo ?? 0);
    if (shortage > 0) {
      const weaponDef = WEAPONS.find(w => w.id === origMount.weaponId);
      if (weaponDef) cost += shortage * weaponDef.ammoCost;
    }
  }

  if (cost === 0) return res.json({ cost: 0, moneyRemaining: playerMoney });
  if (playerMoney < cost) return res.status(402).json({ error: 'Insufficient funds', cost });

  // Build repaired states
  const repairedDamage: DamageState = {
    ...damage,
    armor: { ...origLoadout.armor },
    engineDamaged: false,
    tiresBlown: [],
    destroyed: false,
  };

  // Restore ammo in loadout
  const restoredMounts = (loadout.mounts ?? []).map(m => {
    const orig = (origLoadout.mounts ?? []).find(om => om.id === m.id);
    return orig ? { ...m, ammo: orig.ammo } : m;
  });
  const restoredLoadout: VehicleLoadout = { ...loadout, mounts: restoredMounts };

  await db.query('BEGIN');
  try {
    await db.query(
      `UPDATE vehicles SET damage_state = $1, loadout = $2 WHERE id = $3`,
      [JSON.stringify(repairedDamage), JSON.stringify(restoredLoadout), vehicleId]
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
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }

  return res.json({ cost, moneyRemaining: playerMoney - cost });
});

economyRouter.post('/prize', async (req: AuthRequest, res) => {
  const { amount, eventType, zoneId } = req.body;
  const MAX_PRIZE = 50_000;
  if (!amount || typeof amount !== 'number' || amount <= 0 || amount > MAX_PRIZE) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const db = getDb();
  await db.query('BEGIN');
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
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }

  const pResult = await db.query(`SELECT money FROM players WHERE id = $1`, [req.playerId]);
  return res.json({ moneyNew: pResult.rows[0].money });
});

// ── Jobs ─────────────────────────────────────────────────────────────────────

export const jobsRouter = Router();
jobsRouter.use(requireAuth);

const STATIC_JOBS: Record<string, { job_type: string; description: string; payout: number; division_min: number }[]> = {
  'town-1': [
    { job_type: 'escort',   description: 'Escort a cargo truck to the next town', payout: 3000, division_min: 5 },
    { job_type: 'delivery', description: 'Deliver a sealed crate — no questions asked', payout: 2500, division_min: 5 },
    { job_type: 'ambush',   description: 'Intercept a rival courier on Route 66', payout: 4000, division_min: 10 },
  ],
};

jobsRouter.get('/', async (req: AuthRequest, res) => {
  const zoneId = req.query.zoneId as string;
  if (!zoneId) return res.status(400).json({ error: 'zoneId required' });

  const db = getDb();
  const pResult = await db.query(`SELECT division FROM players WHERE id = $1`, [req.playerId]);
  const playerDiv = pResult.rows[0]?.division ?? 5;

  const existing = await db.query(
    `SELECT id FROM jobs WHERE zone_id = $1 AND taken_by IS NULL AND completed = FALSE AND division_min <= $2 LIMIT 1`,
    [zoneId, playerDiv]
  );
  if (!existing.rows.length && STATIC_JOBS[zoneId]) {
    for (const job of STATIC_JOBS[zoneId]) {
      await db.query(
        `INSERT INTO jobs (zone_id, job_type, description, payout, division_min) VALUES ($1,$2,$3,$4,$5)`,
        [zoneId, job.job_type, job.description, job.payout, job.division_min]
      );
    }
  }

  const result = await db.query(
    `SELECT id, job_type, description, payout, division_min
     FROM jobs WHERE zone_id = $1 AND completed = FALSE AND taken_by IS NULL
     AND division_min <= $2`,
    [zoneId, playerDiv]
  );
  return res.json(result.rows);
});

jobsRouter.post('/:id/take', async (req: AuthRequest, res) => {
  const { id } = req.params;
  const db = getDb();

  const result = await db.query(`SELECT id, description, payout, division_min FROM jobs WHERE id = $1`, [id]);
  if (!result.rows.length) return res.status(404).json({ error: 'Job not found' });
  const job = result.rows[0];

  const pResult = await db.query(`SELECT division FROM players WHERE id = $1`, [req.playerId]);
  if (!pResult.rows.length) return res.status(401).json({ error: 'Player not found' });
  if (pResult.rows[0].division < job.division_min) return res.status(403).json({ error: 'Division too low' });

  const updateResult = await db.query(
    `UPDATE jobs SET taken_by = $1 WHERE id = $2 AND taken_by IS NULL AND completed = FALSE`,
    [req.playerId, id]
  );
  if (updateResult.rowCount === 0) return res.status(409).json({ error: 'Job already taken' });

  return res.json({ ok: true, job: { id: job.id, description: job.description, payout: job.payout } });
});

jobsRouter.post('/:id/complete', async (req: AuthRequest, res) => {
  const { id } = req.params;
  const db = getDb();

  const result = await db.query(
    `SELECT id, taken_by, completed, payout, job_type, zone_id FROM jobs WHERE id = $1`, [id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Job not found' });
  const job = result.rows[0];
  if (job.completed) return res.status(409).json({ error: 'Already completed' });
  if (job.taken_by !== req.playerId) return res.status(403).json({ error: 'Not your job' });

  await db.query('BEGIN');
  try {
    await db.query(`UPDATE jobs SET completed = TRUE WHERE id = $1`, [id]);
    await db.query(`UPDATE players SET money = money + $1 WHERE id = $2`, [job.payout, req.playerId]);
    await db.query(
      `INSERT INTO event_history (player_id, event_type, result, money_delta) VALUES ($1, $2, $3, $4)`,
      [req.playerId, job.job_type, JSON.stringify({ jobId: id, zoneId: job.zone_id }), job.payout]
    );
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }

  const pResult = await db.query(`SELECT money FROM players WHERE id = $1`, [req.playerId]);
  return res.json({ payout: job.payout, moneyNew: pResult.rows[0].money });
});
```

**Step 7: Run tests**

```bash
cd server && npx vitest run tests/economy.test.ts
```
Expected: all tests PASS including the two new ones.

**Step 8: Commit**

```bash
git add server/src/db/schema.sql server/src/api/vehicles.ts server/src/ws/handler.ts server/src/api/economy.ts server/tests/economy.test.ts
git commit -m "feat: persist ammo on disconnect, add tire/ammo repair with armor-type cost multipliers"
```

---

### Task 2: Division-scaled prizes + prize in zone_end message

**Problem:** Arena prize is hardcoded $5000. The `zone_end` WS message doesn't include the prize amount, so the client hardcodes the string "+$5000" even though the server may credit a different amount.

**Files:**
- Modify: `shared/src/types/messages.ts`
- Modify: `server/src/world/zone-runner.ts`
- Modify: `server/src/ws/handler.ts`
- Modify: `server/tests/ws.test.ts`

**Step 1: Write failing test**

In `server/tests/ws.test.ts`, find or add a test that verifies zone_end includes a prize field. Add to the existing test file (check the current structure first — add within the appropriate describe block):

```typescript
it('zone_end message includes prize amount', async () => {
  // This test verifies the zone_end message shape — prize must be a number
  // The actual value depends on player division; we just check it exists and is >= 0
  // We'll test the calcPrize function directly
  const { calcPrize } = await import('../src/ws/handler');
  expect(calcPrize(5)).toBe(2500);
  expect(calcPrize(10)).toBe(5000);
  expect(calcPrize(25)).toBe(12500);
});
```

**Step 2: Run test to confirm it fails**

```bash
cd server && npx vitest run tests/ws.test.ts
```
Expected: FAIL — `calcPrize` not exported.

**Step 3: Update shared message types**

In `shared/src/types/messages.ts`, update the `zone_end` variant:

```typescript
// Before:
| { type: 'zone_end'; winnerId: string | null; reason: string };

// After:
| { type: 'zone_end'; winnerId: string | null; reason: string; prize: number; jobPayout: number };
```

**Step 4: Update ZoneRunner to accept and return prize from onEnd**

In `server/src/world/zone-runner.ts`:

Change `ZoneRunnerOptions`:
```typescript
// Before:
export interface ZoneRunnerOptions {
  onEnd?: (winnerId: string | null) => void;
}

// After:
export interface ZoneRunnerOptions {
  onEnd?: (winnerId: string | null) => Promise<{ prize: number; jobPayout: number }>;
}
```

Change `checkEndCondition` to be async and include prize in zone_end:
```typescript
// Before:
private checkEndCondition(state: import('@carwars/shared').ZoneState): void {
  ...
  const endMsg: ServerMessage = {
    type: 'zone_end',
    winnerId: humanWinnerId,
    reason: ...,
  };
  const data = JSON.stringify(endMsg);
  this.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });
  this.onEnd?.(humanWinnerId);
  this.stop();
}

// After:
private async checkEndCondition(state: import('@carwars/shared').ZoneState): Promise<void> {
  ...
  this.ended = true;

  // Call onEnd first so it can credit the prize and return the amounts
  const { prize, jobPayout } = (await this.onEnd?.(humanWinnerId)) ?? { prize: 0, jobPayout: 0 };

  const endMsg: ServerMessage = {
    type: 'zone_end',
    winnerId: humanWinnerId,
    reason: winnerPlayerId === null
      ? 'all_destroyed'
      : winnerPlayerId === 'ai-team'
      ? 'ai_victory'
      : 'last_standing',
    prize,
    jobPayout,
  };
  const data = JSON.stringify(endMsg);
  this.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });
  this.stop();
}
```

Also update `tick()` to await `checkEndCondition`:
```typescript
// In tick(), find the checkEndCondition call and make it:
this.checkEndCondition(newState).catch(console.error);
```

**Step 5: Add `calcPrize` and update onEnd in handler.ts**

In `server/src/ws/handler.ts`, add and export `calcPrize`:

```typescript
// Add near top (after imports):
export function calcPrize(division: number): number {
  return division * 500;
}
```

In the `new ZoneRunner(...)` call inside the `join_zone` handler, update the onEnd callback:

```typescript
// Before:
onEnd: async (winnerId: string | null) => {
  if (!winnerId) return;
  const ARENA_PRIZE = 5000;
  const db = getDb();
  try {
    await db.query('BEGIN');
    await db.query('UPDATE players SET money = money + $1 WHERE id = $2', [ARENA_PRIZE, winnerId]);
    await db.query(
      'INSERT INTO event_history ...',
      [winnerId, 'arena_win', JSON.stringify({ zoneId: msg.zoneId }), ARENA_PRIZE]
    );
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    console.error('Failed to credit arena prize:', e);
  }
},

// After:
onEnd: async (winnerId: string | null) => {
  if (!winnerId) return { prize: 0, jobPayout: 0 };
  const db = getDb();
  try {
    const pRes = await db.query(`SELECT division FROM players WHERE id = $1`, [winnerId]);
    const division = pRes.rows[0]?.division ?? 5;
    const prize = calcPrize(division);

    await db.query('BEGIN');
    await db.query('UPDATE players SET money = money + $1, reputation = reputation + $2 WHERE id = $3',
      [prize, Math.floor(prize / 500), winnerId]);
    await db.query(
      'INSERT INTO event_history (player_id, event_type, result, money_delta) VALUES ($1,$2,$3,$4)',
      [winnerId, 'arena_win', JSON.stringify({ zoneId: msg.zoneId, prize }), prize]
    );
    await db.query('COMMIT');
    return { prize, jobPayout: 0 };
  } catch (e) {
    await db.query('ROLLBACK');
    console.error('Failed to credit arena prize:', e);
    return { prize: 0, jobPayout: 0 };
  }
},
```

**Step 6: Run tests**

```bash
cd server && npx vitest run tests/ws.test.ts
```
Expected: PASS.

**Step 7: Commit**

```bash
git add shared/src/types/messages.ts server/src/world/zone-runner.ts server/src/ws/handler.ts server/tests/ws.test.ts
git commit -m "feat: division-scaled arena prizes, prize amount in zone_end message"
```

---

### Task 3: Job take + arena completion flow

**Problem:** The JobBoardScene shows jobs but has no Take button. There's no way to pass a job context into the arena, and no link between winning a fight and completing an active job.

**Files:**
- Modify: `client/src/scenes/JobBoardScene.ts`
- Modify: `client/src/scenes/GarageScene.ts`
- Modify: `client/src/scenes/ArenaScene.ts`
- Modify: `shared/src/types/messages.ts`
- Modify: `server/src/ws/handler.ts`

**Step 1: Update shared join_zone message to include optional jobId**

In `shared/src/types/messages.ts`:

```typescript
// Before:
| { type: 'join_zone'; zoneId: string; vehicleId: string; token?: string }

// After:
| { type: 'join_zone'; zoneId: string; vehicleId: string; token?: string; jobId?: string }
```

**Step 2: Add Take button to JobBoardScene**

Replace `client/src/scenes/JobBoardScene.ts` with:

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

    const activeJobId = localStorage.getItem('cw_active_job');
    if (activeJobId) {
      this.add.text(640, 65, 'Active job in progress — complete it in the arena', {
        color: '#ffcc00', fontSize: '13px', fontFamily: 'monospace'
      }).setOrigin(0.5);
    }

    if (!jobs.length) {
      this.add.text(640, 360, 'No jobs available.', {
        color: '#888888', fontSize: '18px', fontFamily: 'monospace'
      }).setOrigin(0.5);
    } else {
      jobs.forEach((job, i) => {
        const y = 110 + i * 90;
        this.add.text(100, y, `[${job.job_type.toUpperCase()}] ${job.description}`, {
          color: '#cccccc', fontSize: '14px', fontFamily: 'monospace', wordWrap: { width: 700 }
        });
        this.add.text(100, y + 24, `Payout: $${job.payout.toLocaleString()}`, {
          color: '#ffcc00', fontSize: '14px', fontFamily: 'monospace'
        });

        const alreadyActive = activeJobId === job.id;
        const takeBtn = this.add.text(900, y + 10, alreadyActive ? '[ACTIVE]' : '[TAKE]', {
          color: alreadyActive ? '#ffcc00' : '#00ff88',
          fontSize: '14px', fontFamily: 'monospace',
          backgroundColor: alreadyActive ? '#332200' : '#003322',
          padding: { x: 6, y: 3 }
        }).setOrigin(1, 0);

        if (!alreadyActive) {
          takeBtn.setInteractive();
          takeBtn.on('pointerdown', () => this.takeJob(job));
        }
      });
    }

    const backBtn = this.add.text(100, 680, '[BACK TO GARAGE]', {
      color: '#888888', fontSize: '16px', fontFamily: 'monospace'
    }).setInteractive();
    backBtn.on('pointerdown', () => this.scene.start('GarageScene', { token: this.token }));
  }

  private async takeJob(job: Job): Promise<void> {
    const host = window.location.hostname;
    const res = await fetch(`http://${host}:3001/api/jobs/${job.id}/take`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` }
    });
    if (res.ok) {
      localStorage.setItem('cw_active_job', job.id);
      localStorage.setItem('cw_active_job_desc', job.description);
      localStorage.setItem('cw_active_job_payout', String(job.payout));
      this.scene.start('GarageScene', { token: this.token });
    } else {
      const body = await res.json();
      this.add.text(640, 650, body.error ?? 'Failed to take job', {
        color: '#ff4444', fontSize: '14px', fontFamily: 'monospace'
      }).setOrigin(0.5);
    }
  }
}
```

**Step 3: Show active job in GarageScene, pass jobId to arena**

In `client/src/scenes/GarageScene.ts`, update the [FIGHT] button handler:

```typescript
// In the vehicles.forEach loop, replace the arenaBtn.on('pointerdown') handler:
arenaBtn.on('pointerdown', () => {
  const activeJobId = localStorage.getItem('cw_active_job') ?? undefined;
  this.scene.start('ArenaScene', { token: this.token, vehicleId: v.id, jobId: activeJobId });
});
```

Also add an active job banner after the money line in `create()`:

```typescript
// After the money/division text line, add:
const activeJobId = localStorage.getItem('cw_active_job');
const activeJobDesc = localStorage.getItem('cw_active_job_desc');
const activeJobPayout = localStorage.getItem('cw_active_job_payout');
if (activeJobId && activeJobDesc) {
  this.add.text(100, 92, `Active job: ${activeJobDesc} — $${Number(activeJobPayout).toLocaleString()} on win`, {
    color: '#ffcc00', fontSize: '13px', fontFamily: 'monospace'
  });
}
```

**Step 4: Pass jobId in ArenaScene join_zone message**

In `client/src/scenes/ArenaScene.ts`:

Update the `init` method to accept `jobId`:
```typescript
// Before:
init(data: { token?: string; vehicleId?: string }): void {
  this.token = data.token ?? '';
  this.myVehicleId = data.vehicleId ?? 'v1';
}

// After (also add private jobId = '' near other private fields):
private jobId = '';
// ...
init(data: { token?: string; vehicleId?: string; jobId?: string }): void {
  this.token = data.token ?? '';
  this.myVehicleId = data.vehicleId ?? 'v1';
  this.jobId = data.jobId ?? '';
}
```

In `create()`, find where `join_zone` is sent (via `Connection`) and add jobId:

```typescript
// Find: this.connection.send({ type: 'join_zone', zoneId: ..., vehicleId: ..., token: ... })
// Update to include jobId:
this.connection.send({
  type: 'join_zone',
  zoneId: zoneId,
  vehicleId: this.myVehicleId,
  token: this.token,
  jobId: this.jobId || undefined,
});
```

**Step 5: Handle jobId in WS handler — auto-complete job on arena win**

In `server/src/ws/handler.ts`:

Add a map to track active jobs:
```typescript
// Near other Maps at the top of the handler scope:
const clientJobs = new Map<WebSocket, string>(); // ws → jobId
```

In `removeClientFromZone`, add cleanup:
```typescript
clientJobs.delete(ws);
```

In the `join_zone` handler, store jobId:
```typescript
// After clientPlayers.set(ws, result.playerId):
if (msg.jobId) clientJobs.set(ws, msg.jobId);
```

Update the `onEnd` callback to complete the active job:

```typescript
onEnd: async (winnerId: string | null) => {
  if (!winnerId) return { prize: 0, jobPayout: 0 };
  const db = getDb();
  try {
    const pRes = await db.query(`SELECT division FROM players WHERE id = $1`, [winnerId]);
    const division = pRes.rows[0]?.division ?? 5;
    const prize = calcPrize(division);

    // Find winner's WebSocket to check for active job
    let jobPayout = 0;
    for (const [ws, pid] of clientPlayers) {
      if (pid !== winnerId) continue;
      const jobId = clientJobs.get(ws);
      if (!jobId) continue;

      // Complete the job
      const jobRes = await db.query(
        `UPDATE jobs SET completed = TRUE
         WHERE id = $1 AND taken_by = $2 AND completed = FALSE
         RETURNING payout, job_type, zone_id`,
        [jobId, winnerId]
      );
      if (jobRes.rows.length) {
        jobPayout = jobRes.rows[0].payout;
        await db.query(
          `INSERT INTO event_history (player_id, event_type, result, money_delta) VALUES ($1,$2,$3,$4)`,
          [winnerId, jobRes.rows[0].job_type,
           JSON.stringify({ jobId, zoneId: jobRes.rows[0].zone_id }), jobPayout]
        );
      }
      clientJobs.delete(ws);
      break;
    }

    const total = prize + jobPayout;
    await db.query('BEGIN');
    await db.query(
      'UPDATE players SET money = money + $1, reputation = reputation + $2 WHERE id = $3',
      [total, Math.floor(prize / 500), winnerId]
    );
    await db.query(
      'INSERT INTO event_history (player_id, event_type, result, money_delta) VALUES ($1,$2,$3,$4)',
      [winnerId, 'arena_win', JSON.stringify({ zoneId: msg.zoneId, prize }), prize]
    );
    await db.query('COMMIT');
    return { prize, jobPayout };
  } catch (e) {
    await db.query('ROLLBACK');
    console.error('Failed to credit arena prize:', e);
    return { prize: 0, jobPayout: 0 };
  }
},
```

**Step 6: Build check**

```bash
cd server && npm run build 2>&1 | grep -E "error|Error"
cd client && npm run build 2>&1 | grep -E "error|Error"
```
Expected: no errors.

**Step 7: Commit**

```bash
git add shared/src/types/messages.ts client/src/scenes/JobBoardScene.ts client/src/scenes/GarageScene.ts client/src/scenes/ArenaScene.ts server/src/ws/handler.ts
git commit -m "feat: job take + auto-complete on arena win, pass jobId through arena flow"
```

---

### Task 4: Post-arena result screen + return to garage

**Problem:** The arena end overlay is minimal (no prize amount, no job payout, no damage report, no way to navigate back to garage — you have to reload the page).

**Files:**
- Modify: `client/src/scenes/ArenaScene.ts`
- Modify: `client/src/scenes/GarageScene.ts`

**Step 1: Replace showZoneEnd with a full result screen**

In `client/src/scenes/ArenaScene.ts`, find and replace the entire `showZoneEnd` method:

```typescript
private showZoneEnd(winnerId: string | null, reason: string, prize: number, jobPayout: number): void {
  if (this.zoneEnded) return;
  this.zoneEnded = true;

  const myVehicle = this.zoneState?.vehicles.find(v => v.id === this.myVehicleId);
  const isWinner = !!myVehicle && !!winnerId && myVehicle.playerId === winnerId;

  // Clear active job from localStorage if we won (job was auto-completed server-side)
  if (isWinner && jobPayout > 0) {
    localStorage.removeItem('cw_active_job');
    localStorage.removeItem('cw_active_job_desc');
    localStorage.removeItem('cw_active_job_payout');
  }

  // Dim overlay
  this.add.rectangle(640, 360, 700, 380, 0x000000, 0.85).setScrollFactor(0).setDepth(10);

  // Title
  const titleText = isWinner ? 'VICTORY' : reason === 'ai_victory' ? 'DEFEATED' : 'BATTLE OVER';
  const titleColor = isWinner ? '#00ff88' : '#ff4444';
  this.add.text(640, 215, titleText, {
    fontSize: '42px', color: titleColor, fontFamily: 'monospace', fontStyle: 'bold'
  }).setOrigin(0.5).setScrollFactor(0).setDepth(11);

  // Financial summary (only meaningful for winner)
  let y = 275;
  if (isWinner) {
    if (prize > 0) {
      this.add.text(640, y, `Arena prize:  $${prize.toLocaleString()}`, {
        fontSize: '18px', color: '#ffcc00', fontFamily: 'monospace'
      }).setOrigin(0.5).setScrollFactor(0).setDepth(11);
      y += 30;
    }
    if (jobPayout > 0) {
      this.add.text(640, y, `Job payout:   $${jobPayout.toLocaleString()}`, {
        fontSize: '18px', color: '#ffcc00', fontFamily: 'monospace'
      }).setOrigin(0.5).setScrollFactor(0).setDepth(11);
      y += 30;
    }
    const total = prize + jobPayout;
    if (total > 0) {
      this.add.text(640, y, `Total earned: $${total.toLocaleString()}`, {
        fontSize: '20px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold'
      }).setOrigin(0.5).setScrollFactor(0).setDepth(11);
      y += 36;
    }
  }

  // Damage summary
  if (myVehicle) {
    const ds = myVehicle.stats.damageState;
    const armorLost = Object.entries(ds.armor)
      .reduce((sum, [k, v]) => {
        const orig = (myVehicle.stats.loadout.armor as Record<string, number>)[k] ?? 0;
        return sum + Math.max(0, orig - (v ?? 0));
      }, 0);
    const flags = [
      ds.engineDamaged ? 'ENGINE' : '',
      ds.onFire ? 'FIRE' : '',
      (ds.tiresBlown?.length ?? 0) > 0 ? `${ds.tiresBlown!.length} TIRE(S)` : '',
    ].filter(Boolean).join('  ');

    const dmgColor = armorLost > 0 ? '#ff8888' : '#88ff88';
    this.add.text(640, y, `Damage: ${armorLost} armor pts lost${flags ? `  [${flags}]` : ''}`, {
      fontSize: '14px', color: dmgColor, fontFamily: 'monospace'
    }).setOrigin(0.5).setScrollFactor(0).setDepth(11);
    y += 24;
  }

  // Return to garage button
  y = Math.max(y + 10, 460);
  const garageBtn = this.add.text(640, y, '[RETURN TO GARAGE]', {
    fontSize: '20px', color: '#aaaaff', fontFamily: 'monospace',
    backgroundColor: '#111133', padding: { x: 12, y: 6 }
  }).setOrigin(0.5).setScrollFactor(0).setDepth(11).setInteractive();

  garageBtn.on('pointerdown', () => {
    this.connection.send({ type: 'leave_zone' });
    this.scene.start('GarageScene', {
      token: this.token,
      lastResult: isWinner ? { prize, jobPayout } : null,
    });
  });
}
```

**Step 2: Update the zone_end message handler in ArenaScene.create()**

Find the line calling `showZoneEnd`:
```typescript
// Before:
this.showZoneEnd(msg.winnerId, msg.reason);

// After:
this.showZoneEnd(msg.winnerId, msg.reason, msg.prize ?? 0, msg.jobPayout ?? 0);
```

**Step 3: Show result banner in GarageScene**

In `client/src/scenes/GarageScene.ts`, update the `init` method and add banner:

```typescript
// Add to class fields:
private lastResult: { prize: number; jobPayout: number } | null = null;

// Update init:
init(data: { token: string; lastResult?: { prize: number; jobPayout: number } | null }): void {
  this.token = data.token;
  this.lastResult = data.lastResult ?? null;
}

// In create(), after the money/division text line, add:
if (this.lastResult) {
  const total = this.lastResult.prize + this.lastResult.jobPayout;
  this.add.text(640, 55, `Last fight: +$${total.toLocaleString()} earned`, {
    color: '#00ff88', fontSize: '14px', fontFamily: 'monospace'
  }).setOrigin(0.5);
}
```

**Step 4: Block [FIGHT] button on destroyed vehicles**

In `client/src/scenes/GarageScene.ts`, in the `vehicles.forEach` loop, update the fight button:

```typescript
// Before:
const arenaBtn = this.add.text(620, y, '[FIGHT]', {
  color: '#00ff88', fontSize: '14px', fontFamily: 'monospace',
  backgroundColor: '#003322', padding: { x: 6, y: 3 }
}).setInteractive();
arenaBtn.on('pointerdown', () => {
  this.scene.start('ArenaScene', { token: this.token, vehicleId: v.id });
});

// After:
const isDestroyed = v.damage_state?.destroyed;
const arenaBtn = this.add.text(620, y, isDestroyed ? '[DESTROYED]' : '[FIGHT]', {
  color: isDestroyed ? '#555555' : '#00ff88',
  fontSize: '14px', fontFamily: 'monospace',
  backgroundColor: isDestroyed ? '#221111' : '#003322',
  padding: { x: 6, y: 3 }
});
if (!isDestroyed) {
  arenaBtn.setInteractive();
  arenaBtn.on('pointerdown', () => {
    const activeJobId = localStorage.getItem('cw_active_job') ?? undefined;
    this.scene.start('ArenaScene', { token: this.token, vehicleId: v.id, jobId: activeJobId });
  });
}
```

**Step 5: Build check**

```bash
cd client && npm run build 2>&1 | grep -E "error|Error"
```
Expected: no errors.

**Step 6: Commit**

```bash
git add client/src/scenes/ArenaScene.ts client/src/scenes/GarageScene.ts
git commit -m "feat: post-arena result screen with prize/job payout, return to garage button, block destroyed vehicles"
```

---

### Task 5: Driver skill wiring + XP gain

**Problem:** Driver skill is hardcoded at 3 in zone-runner even though drivers have a `skill` field (1-6) in the DB. Drivers gain no XP from combat, so their skill never improves.

**Files:**
- Modify: `server/src/world/zone-runner.ts`
- Modify: `server/src/ws/handler.ts`
- Modify: `server/src/api/drivers.ts`
- Modify: `server/tests/drivers.test.ts`

**Step 1: Write failing test**

In `server/tests/drivers.test.ts`, add:

```typescript
it('POST /api/drivers/award-xp grants XP and auto-promotes skill at threshold', async () => {
  // Create a driver at skill 3, give them 299 XP (just below threshold of 300 for skill 4)
  const createRes = await request(app)
    .post('/api/drivers')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'XP Test Driver' });
  const driverId = createRes.body.id;

  const db = getDb();
  await db.query(`UPDATE drivers SET xp = 299, skill = 3 WHERE id = $1`, [driverId]);

  // Award 10 XP — should cross the 300 threshold (skill 3 → 4 at 100 * skill XP)
  const res = await request(app)
    .post('/api/drivers/award-xp')
    .set('Authorization', `Bearer ${token}`)
    .send({ driverId, xp: 10 });

  expect(res.status).toBe(200);
  expect(res.body.newXp).toBe(309);
  expect(res.body.newSkill).toBe(4); // auto-promoted
});
```

**Step 2: Run to confirm it fails**

```bash
cd server && npx vitest run tests/drivers.test.ts
```
Expected: FAIL — `/api/drivers/award-xp` doesn't exist yet.

**Step 3: Add XP award endpoint to drivers.ts**

Add to `server/src/api/drivers.ts`:

```typescript
// XP threshold for each skill level: skill N → N+1 requires N * 100 XP
function xpThreshold(skill: number): number {
  return skill * 100;
}

driversRouter.post('/award-xp', async (req: AuthRequest, res) => {
  const { driverId, xp } = req.body;
  if (!driverId || typeof xp !== 'number' || xp < 0) {
    return res.status(400).json({ error: 'driverId and non-negative xp required' });
  }

  const db = getDb();
  const result = await db.query(
    `SELECT id, skill, xp, alive FROM drivers WHERE id = $1 AND player_id = $2`,
    [driverId, req.playerId]
  );
  if (!result.rows.length) return res.status(403).json({ error: 'Driver not found' });

  const driver = result.rows[0];
  if (!driver.alive) return res.status(409).json({ error: 'Driver is dead' });

  const newXp = driver.xp + xp;
  let newSkill = driver.skill;
  // Auto-promote if XP crosses threshold and skill is below 6
  while (newSkill < 6 && newXp >= xpThreshold(newSkill)) {
    newSkill++;
  }

  await db.query(
    `UPDATE drivers SET xp = $1, skill = $2 WHERE id = $3`,
    [newXp, newSkill, driverId]
  );

  return res.json({ newXp, newSkill, promoted: newSkill > driver.skill });
});
```

**Step 4: Run tests**

```bash
cd server && npx vitest run tests/drivers.test.ts
```
Expected: PASS.

**Step 5: Award XP in arena onEnd callback**

In `server/src/ws/handler.ts`, add XP awarding to the `onEnd` callback (inside the existing try block, after crediting prize money):

```typescript
// After the prize is credited, award XP to the player's assigned driver
// Find the player's vehicle that was in this zone
const vRes = await db.query(
  `SELECT v.id FROM vehicles v
   JOIN drivers d ON d.assigned_vehicle_id = v.id
   WHERE v.player_id = $1
   ORDER BY v.created_at LIMIT 1`,
  [winnerId]
);
if (vRes.rows.length) {
  const vehicleId = vRes.rows[0].id;
  const dRes = await db.query(
    `SELECT id FROM drivers WHERE assigned_vehicle_id = $1 AND alive = TRUE LIMIT 1`,
    [vehicleId]
  );
  if (dRes.rows.length) {
    const WIN_XP = 50;
    await db.query(
      `UPDATE drivers SET xp = xp + $1 WHERE id = $2`, [WIN_XP, dRes.rows[0].id]
    );
    // Auto-promote: promote once per XP award (simple check)
    await db.query(
      `UPDATE drivers SET skill = LEAST(6, skill + 1)
       WHERE id = $1 AND skill < 6 AND xp >= skill * 100`,
      [dRes.rows[0].id]
    );
  }
}
```

**Step 6: Wire driver skill into zone-runner**

In `server/src/world/zone-runner.ts`, add a vehicle skill map:

```typescript
// Add to class fields:
private vehicleSkills = new Map<string, number>(); // vehicleId → driver skill

// Add public method:
setVehicleSkill(vehicleId: string, skill: number): void {
  this.vehicleSkills.set(vehicleId, skill);
}
```

In the `tick()` method, use per-vehicle skill:

```typescript
// Before:
const aiInput = computeAiInput(vehicle, enemies, 3);

// After:
const skill = this.vehicleSkills.get(vehicle.id) ?? 3;
const aiInput = computeAiInput(vehicle, enemies, skill);
```

**Step 7: Load driver skill in ws/handler.ts when player joins**

In `server/src/ws/handler.ts`, in the `join_zone` handler, after loading the vehicle from DB and before `runner.addClient(ws)`:

```typescript
// After vehicle is loaded and added to runner, load driver skill:
if (result?.playerId) {
  const driverRes = await db.query(
    `SELECT skill FROM drivers WHERE assigned_vehicle_id = $1 AND alive = TRUE LIMIT 1`,
    [msg.vehicleId]
  );
  if (driverRes.rows.length) {
    runner.setVehicleSkill(msg.vehicleId, driverRes.rows[0].skill);
  }
}
```

**Step 8: Commit**

```bash
git add server/src/api/drivers.ts server/src/world/zone-runner.ts server/src/ws/handler.ts server/tests/drivers.test.ts
git commit -m "feat: driver XP gain on arena win, auto skill promotion, driver skill wired to AI"
```

---

### Task 6: Garage UX — ammo display, sell vehicle

**Problem:** The GarageScene shows vehicles with no detail about their current ammo or tire state. There's no way to sell a vehicle. Combined with the repair flow, the garage needs to show enough information to make repair decisions meaningful.

**Files:**
- Modify: `client/src/scenes/GarageScene.ts`
- Modify: `server/src/api/vehicles.ts`
- Modify: `server/tests/vehicles.test.ts`

**Step 1: Add vehicle sell endpoint**

In `server/src/api/vehicles.ts`, add:

```typescript
vehiclesRouter.delete('/:id', async (req: AuthRequest, res) => {
  const db = getDb();
  const result = await db.query(
    `SELECT id, value FROM vehicles WHERE id = $1 AND player_id = $2`,
    [req.params.id, req.playerId]
  );
  if (!result.rows.length) return res.status(403).json({ error: 'Vehicle not found' });

  const vehicle = result.rows[0];
  const salePrice = Math.floor(vehicle.value / 2);

  await db.query('BEGIN');
  try {
    await db.query(`DELETE FROM vehicles WHERE id = $1`, [vehicle.id]);
    await db.query(`UPDATE players SET money = money + $1 WHERE id = $2`, [salePrice, req.playerId]);
    await db.query(
      `INSERT INTO event_history (player_id, event_type, result, money_delta) VALUES ($1,'sell',$2,$3)`,
      [req.playerId, JSON.stringify({ vehicleId: vehicle.id, salePrice }), salePrice]
    );
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }

  return res.json({ salePrice });
});
```

**Step 2: Write test for sell endpoint**

In `server/tests/vehicles.test.ts`, add:

```typescript
it('DELETE /api/vehicles/:id sells vehicle for 50% of value and credits money', async () => {
  // Create a vehicle to sell
  const createRes = await request(app)
    .post('/api/vehicles')
    .set('Authorization', `Bearer ${token}`)
    .send({
      name: 'For Sale',
      loadout: {
        chassisId: 'mid', engineId: 'medium', suspensionId: 'standard',
        tires: [{ id: 't0', blown: false }],
        mounts: [],
        armor: { front: 4, back: 4 },
        totalCost: 10000
      }
    });
  const sellId = createRes.body.id;

  const meBeforeRes = await request(app)
    .get('/api/me')
    .set('Authorization', `Bearer ${token}`);
  const moneyBefore = meBeforeRes.body.money;

  const res = await request(app)
    .delete(`/api/vehicles/${sellId}`)
    .set('Authorization', `Bearer ${token}`);

  expect(res.status).toBe(200);
  expect(res.body.salePrice).toBe(5000);

  const meAfterRes = await request(app)
    .get('/api/me')
    .set('Authorization', `Bearer ${token}`);
  expect(meAfterRes.body.money).toBe(moneyBefore + 5000);
});
```

**Step 3: Run test to confirm it fails, then passes**

```bash
cd server && npx vitest run tests/vehicles.test.ts
```
Expected: new test FAILs. After Step 1: PASS.

**Step 4: Enhance GarageScene vehicle rows with ammo + tire status and sell button**

In `client/src/scenes/GarageScene.ts`, replace the vehicles.forEach section:

The vehicle row currently shows name, value, [REPAIR], [FIGHT]. Expand it to two lines per vehicle: name/value on line 1, status info on line 2.

```typescript
this.vehicles.forEach((v, i) => {
  const y = 140 + i * 80;
  const ds = v.damage_state ?? {};
  const isDestroyed = ds.destroyed;
  const nameColor = isDestroyed ? '#ff4444' : '#00ff88';

  // Line 1: name + value
  this.add.text(100, y, `${v.name}`, { color: nameColor, fontSize: '16px', fontFamily: 'monospace' });
  this.add.text(370, y, `$${v.value.toLocaleString()}`, { color: '#888888', fontSize: '14px', fontFamily: 'monospace' });

  // Line 2: ammo + tire status
  const mounts: any[] = v.loadout?.mounts ?? [];
  const ammoStr = mounts.length
    ? mounts.map((m: any) => `${m.weaponId ?? '?'}:${m.ammo}`).join(' ')
    : 'no weapons';
  const tiresBlow = ds.tiresBlown?.length ?? 0;
  const tireStr = tiresBlow > 0 ? `  [${tiresBlow} TIRE${tiresBlow > 1 ? 'S' : ''} BLOWN]` : '';
  const engineStr = ds.engineDamaged ? '  [ENGINE]' : '';
  this.add.text(100, y + 20, `${ammoStr}${tireStr}${engineStr}`, {
    color: '#666666', fontSize: '11px', fontFamily: 'monospace'
  });

  // [REPAIR] button
  const repairBtn = this.add.text(600, y, '[REPAIR]', {
    color: '#ffcc00', fontSize: '13px', fontFamily: 'monospace',
    backgroundColor: '#332200', padding: { x: 5, y: 2 }
  }).setInteractive();
  repairBtn.on('pointerdown', () => this.repairVehicle(v.id));

  // [FIGHT] or [DESTROYED]
  const isDestr = isDestroyed;
  const fightBtn = this.add.text(690, y, isDestr ? '[DESTROYED]' : '[FIGHT]', {
    color: isDestr ? '#444444' : '#00ff88',
    fontSize: '13px', fontFamily: 'monospace',
    backgroundColor: isDestr ? '#221111' : '#003322',
    padding: { x: 5, y: 2 }
  });
  if (!isDestr) {
    fightBtn.setInteractive();
    fightBtn.on('pointerdown', () => {
      const activeJobId = localStorage.getItem('cw_active_job') ?? undefined;
      this.scene.start('ArenaScene', { token: this.token, vehicleId: v.id, jobId: activeJobId });
    });
  }

  // [SELL] button
  const sellBtn = this.add.text(800, y, '[SELL]', {
    color: '#ff8844', fontSize: '13px', fontFamily: 'monospace',
    backgroundColor: '#221100', padding: { x: 5, y: 2 }
  }).setInteractive();
  sellBtn.on('pointerdown', () => this.sellVehicle(v.id, v.name));
});
```

Also add the `sellVehicle` method to GarageScene:

```typescript
private async sellVehicle(vehicleId: string, name: string): Promise<void> {
  if (!confirm(`Sell ${name} for 50% value?`)) return;
  const host = window.location.hostname;
  const res = await fetch(`http://${host}:3001/api/vehicles/${vehicleId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${this.token}` }
  });
  const body = await res.json();
  if (res.ok) {
    this.scene.restart({ token: this.token });
  } else {
    this.add.text(640, 650, body.error ?? 'Sell failed', {
      color: '#ff4444', fontSize: '14px', fontFamily: 'monospace'
    }).setOrigin(0.5);
  }
}
```

**Step 5: Run all server tests**

```bash
cd server && npx vitest run
```
Expected: all tests PASS.

**Step 6: Commit**

```bash
git add server/src/api/vehicles.ts client/src/scenes/GarageScene.ts server/tests/vehicles.test.ts
git commit -m "feat: vehicle sell endpoint, ammo/tire status in garage, expand vehicle rows"
```

---

### Final: Deploy and smoke-test

**Step 1: Run full test suite**

```bash
cd server && npx vitest run
```
Expected: all tests PASS.

**Step 2: Deploy**

```bash
cd /opt/carwars/src  # or from repo root:
bash scripts/deploy.sh
```

**Step 3: Smoke test the full loop**

1. Open `http://10.202.28.192:3001` → register a new account
2. Build a car in the designer → Save
3. Go to Garage → verify the car shows ammo, no tire damage
4. Go to Job Board → take a job → confirm "Active job" banner in Garage
5. Click [FIGHT] → enter arena → fight → win
6. Verify result screen shows: arena prize (division × $500) + job payout + total
7. Click [Return to Garage] → money should be updated, active job banner gone
8. Repair the vehicle → verify ammo restored and correct cost charged
9. Sell one vehicle → verify money credited

---

## Parallel execution note

All 6 tasks are sequential — each builds on the previous (ammo persistence is needed before repair is correct; zone_end prize is needed before result screen can display it; job flow needs shared type change from Task 2, etc.).
