import { Router } from 'express';
import { getDb } from '../db/client';
import { requireAuth, AuthRequest } from './middleware';
import { WEAPONS } from '../rules/data/weapons';
import { BODIES } from '../rules/data/bodies';
import { TIRES } from '../rules/data/tires';
import { POWER_PLANTS } from '../rules/data/power-plants';
import type { VehicleLoadout, DamageState, ArmorDistribution } from '@carwars/shared';
import { resolveHeadlessJob } from '../rules/headlessJob';

export const economyRouter = Router();
economyRouter.use(requireAuth);

// Per Compendium 2E (Repair table):
//   Armor  → 50% of install per point   (patching, not replacing)
//   Engine → 50% of engine cost         (already modelled below)
//   Tires  → 100% of install per tire   (blown tires are REPLACED, not patched)
// Previously armor was charged at full install cost, which made a Div 5 win
// barely cover repair on its own car — the Compendium half-rate is what
// restores the break-even between winnings and repair bills.

// Base build multiplier per armor type (same as the install table)
const ARMOR_BUILD_MUL: Record<string, number> = {
  ablative: 1, metal: 1, fireproof: 2, laser_reflective: 2, lr_fireproof: 4, radarproof: 2,
};
// Compendium repair rate — patching armor is 50% of install cost
const ARMOR_REPAIR_FRACTION = 0.5;

// Floor for engine repair when no power-plant cost data is available
const ENGINE_REPAIR_FALLBACK = 500;
// Floor for tire repair when no tire-cost data is available
const TIRE_REPAIR_FALLBACK   = 50;

// Repair part ids supported by the partial-repair flow
type RepairPart = 'armor' | 'tires' | 'engine' | 'ammo';
const ALL_PARTS: RepairPart[] = ['armor', 'tires', 'engine', 'ammo'];

interface RepairQuote {
  armor: { pts: number; cost: number };
  tires: { count: number; cost: number; eachCost: number };
  engine: { damaged: boolean; cost: number };
  ammo: { rounds: number; cost: number; byMount: Array<{ mountId: string; weaponId: string | null; shortage: number; cost: number }> };
  total: number;
}

// Pure function — compute the breakdown without touching the DB.
function computeRepairQuote(loadout: VehicleLoadout, origLoadout: VehicleLoadout, damage: DamageState): RepairQuote {
  const armorMul = ARMOR_BUILD_MUL[origLoadout.armorType ?? 'ablative'] ?? 1;
  const body = BODIES.find(b => b.id === origLoadout.bodyType);
  const armorCostPerPt = body?.armorCostPerPt ?? 10;

  let armorPts = 0;
  const locations: (keyof ArmorDistribution)[] = ['front', 'back', 'left', 'right', 'top', 'underbody'];
  for (const loc of locations) {
    const deficit = (origLoadout.armor[loc] ?? 0) - (damage.armor[loc] ?? 0);
    if (deficit > 0) armorPts += deficit;
  }
  // Armor repair = 50% of install cost per point (Compendium Repair table)
  const armorCost = Math.round(armorPts * armorCostPerPt * armorMul * ARMOR_REPAIR_FRACTION);

  const tireCount = damage.tiresBlown?.length ?? 0;
  const tire = TIRES.find(t => t.id === origLoadout.tireType);
  const tireEach = tire?.costPerTire ?? TIRE_REPAIR_FALLBACK;
  const tireCost = tireCount * tireEach;

  const plant = POWER_PLANTS.find(p => p.id === origLoadout.powerPlantType);
  const engineCost = damage.engineDamaged ? Math.round((plant?.cost ?? ENGINE_REPAIR_FALLBACK) / 2) : 0;

  const byMount: Array<{ mountId: string; weaponId: string | null; shortage: number; cost: number }> = [];
  let ammoRounds = 0, ammoCost = 0;
  for (const origMount of origLoadout.mounts ?? []) {
    const curMount = loadout.mounts?.find(m => m.id === origMount.id);
    const shortage = origMount.ammo - (curMount?.ammo ?? 0);
    if (shortage <= 0) continue;
    const weaponDef = WEAPONS.find(w => w.id === origMount.weaponId);
    if (!weaponDef) continue;
    const cost = shortage * weaponDef.ammoCost;
    byMount.push({ mountId: origMount.id, weaponId: origMount.weaponId, shortage, cost });
    ammoRounds += shortage;
    ammoCost   += cost;
  }

  return {
    armor:  { pts: armorPts, cost: armorCost },
    tires:  { count: tireCount, cost: tireCost, eachCost: tireEach },
    engine: { damaged: !!damage.engineDamaged, cost: engineCost },
    ammo:   { rounds: ammoRounds, cost: ammoCost, byMount },
    total:  armorCost + tireCost + engineCost + ammoCost,
  };
}

// GET /api/economy/repair/quote?vehicleId=X — itemised cost, no DB mutation
economyRouter.get('/repair/quote', async (req: AuthRequest, res) => {
  const vehicleId = req.query.vehicleId;
  if (!vehicleId || typeof vehicleId !== 'string') return res.status(400).json({ error: 'vehicleId required' });
  const db = getDb();
  const [vResult, gResult] = await Promise.all([
    db.query(
      `SELECT id, loadout, original_loadout, damage_state
       FROM vehicles WHERE id = $1 AND player_id = $2`,
      [vehicleId, req.playerId],
    ),
    db.query(`SELECT repair_discount FROM garages WHERE player_id = $1`, [req.playerId]),
  ]);
  if (!vResult.rows.length) return res.status(403).json({ error: 'Vehicle not found' });
  const loadout     = vResult.rows[0].loadout as VehicleLoadout;
  const origLoadout = (vResult.rows[0].original_loadout ?? loadout) as VehicleLoadout;
  const damage      = vResult.rows[0].damage_state as DamageState;
  const discount    = gResult.rows.length ? Number(gResult.rows[0].repair_discount) : 0;
  const quote = computeRepairQuote(loadout, origLoadout, damage);
  // Per-part costs stay at full rate; the garage discount applies to the bill.
  return res.json({ ...quote, repairDiscount: discount, discountedTotal: Math.round(quote.total * (1 - discount)) });
});

economyRouter.post('/repair', async (req: AuthRequest, res) => {
  const { vehicleId } = req.body;
  // Optional `parts` filter — repair only the named categories. Defaults to
  // everything. Invalid ids are ignored.
  const parts: RepairPart[] = Array.isArray(req.body.parts) && req.body.parts.length
    ? req.body.parts.filter((p: string): p is RepairPart => (ALL_PARTS as string[]).includes(p))
    : ALL_PARTS.slice();
  if (!vehicleId) return res.status(400).json({ error: 'vehicleId required' });

  const db = getDb();
  const [vResult, pResult, gResult] = await Promise.all([
    db.query(
      `SELECT id, loadout, original_loadout, damage_state, player_id
       FROM vehicles WHERE id = $1 AND player_id = $2`,
      [vehicleId, req.playerId]
    ),
    db.query(`SELECT money FROM players WHERE id = $1`, [req.playerId]),
    db.query(`SELECT repair_discount FROM garages WHERE player_id = $1`, [req.playerId])
  ]);

  if (!vResult.rows.length) return res.status(403).json({ error: 'Vehicle not found' });

  const vehicle      = vResult.rows[0];
  const loadout      = vehicle.loadout as VehicleLoadout;
  const origLoadout  = (vehicle.original_loadout ?? loadout) as VehicleLoadout;
  const damage       = vehicle.damage_state as DamageState;
  const playerMoney  = pResult.rows[0].money as number;
  // Garage owners get a repair discount applied to the final bill.
  const discount     = gResult.rows.length ? Number(gResult.rows[0].repair_discount) : 0;

  const quote = computeRepairQuote(loadout, origLoadout, damage);
  const doArmor  = parts.includes('armor');
  const doTires  = parts.includes('tires');
  const doEngine = parts.includes('engine');
  const doAmmo   = parts.includes('ammo');
  const grossCost = (doArmor ? quote.armor.cost : 0)
             + (doTires ? quote.tires.cost : 0)
             + (doEngine ? quote.engine.cost : 0)
             + (doAmmo  ? quote.ammo.cost   : 0);
  const cost = Math.round(grossCost * (1 - discount));

  if (cost === 0) return res.json({ cost: 0, moneyRemaining: playerMoney, parts });
  if (playerMoney < cost) return res.status(402).json({ error: 'Insufficient funds', cost });

  // Build repaired states — each part only if it's in the filter
  const repairedDamage: DamageState = {
    ...damage,
    armor: doArmor ? { ...origLoadout.armor } : { ...damage.armor },
    engineDamaged: doEngine ? false : damage.engineDamaged,
    tiresBlown:    doTires  ? []    : damage.tiresBlown,
    destroyed: false,
  };
  const restoredMounts = (loadout.mounts ?? []).map(m => {
    if (!doAmmo) return m;
    const orig = (origLoadout.mounts ?? []).find(om => om.id === m.id);
    return orig ? { ...m, ammo: orig.ammo } : m;
  });
  const restoredLoadout: VehicleLoadout = { ...loadout, mounts: restoredMounts };

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE vehicles SET damage_state = $1, loadout = $2 WHERE id = $3`,
      [JSON.stringify(repairedDamage), JSON.stringify(restoredLoadout), vehicleId]
    );
    await client.query(
      `UPDATE players SET money = money - $1 WHERE id = $2`,
      [cost, req.playerId]
    );
    await client.query(
      `INSERT INTO event_history (player_id, event_type, result, money_delta)
       VALUES ($1, 'repair', $2, $3)`,
      [req.playerId, JSON.stringify({ vehicleId, cost, parts }), -cost]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  return res.json({ cost, moneyRemaining: playerMoney - cost, parts });
});

economyRouter.post('/prize', async (req: AuthRequest, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Not available' });
  }

  const { amount, eventType, zoneId } = req.body;
  const MAX_PRIZE = 50_000;
  if (!amount || typeof amount !== 'number' || amount <= 0 || amount > MAX_PRIZE) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const db = getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE players SET money = money + $1 WHERE id = $2`, [amount, req.playerId]);
    await client.query(
      `UPDATE players SET reputation = reputation + $1 WHERE id = $2`,
      [Math.floor(amount / 500), req.playerId]
    );
    await client.query(
      `INSERT INTO event_history (player_id, event_type, result, money_delta) VALUES ($1, $2, $3, $4)`,
      [req.playerId, eventType ?? 'prize', JSON.stringify({ zoneId }), amount]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
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

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE jobs SET completed = TRUE WHERE id = $1`, [id]);
    await client.query(`UPDATE players SET money = money + $1 WHERE id = $2`, [job.payout, req.playerId]);
    await client.query(
      `INSERT INTO event_history (player_id, event_type, result, money_delta) VALUES ($1, $2, $3, $4)`,
      [req.playerId, job.job_type, JSON.stringify({ jobId: id, zoneId: job.zone_id }), job.payout]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  const pResult = await db.query(`SELECT money FROM players WHERE id = $1`, [req.playerId]);
  return res.json({ payout: job.payout, moneyNew: pResult.rows[0].money });
});

// ─── Phase 2 — Headless jobs ───────────────────────────────────────────────
// Headless jobs auto-resolve: the player assigns an available driver and the
// outcome is rolled (simplified, see rules/headlessJob.ts) when the timer
// expires. Resolution is LAZY — it happens on the next API call, never during
// an arena match (anti-rabbit-hole rule 4). Payouts are smaller than arena
// fights (balance target $200-600) so arena stays the lucrative option.

const HEADLESS_JOBS: Record<string, { job_type: string; description: string; payout: number; difficulty: number; division_min: number }[]> = {
  'town-1': [
    { job_type: 'patrol',   description: 'Patrol the eastern checkpoints overnight', payout: 250, difficulty: 2, division_min: 5 },
    { job_type: 'scavenge', description: 'Strip a wreck on Route 9 for salvage',      payout: 400, difficulty: 4, division_min: 5 },
    { job_type: 'enforce',  description: 'Lean on a debtor who skipped a payment',    payout: 600, difficulty: 7, division_min: 5 },
  ],
};

// Job timer window in minutes (real-time — the game has no in-game day counter).
const HEADLESS_MIN_MINUTES = 2;
const HEADLESS_MAX_MINUTES = 5;
// How long a driver is sidelined after being wounded on a headless job.
const WOUND_RECOVERY_MINUTES = 3;

// Resolve any of this player's headless jobs whose timer has expired. Idempotent
// and safe to call from multiple endpoints (GET /drivers, /headless, /outcomes).
export async function resolveDueHeadlessJobs(playerId: string): Promise<void> {
  const db = getDb();
  const due = await db.query(
    `SELECT j.id AS job_id, j.payout, j.difficulty, j.description, j.job_type,
            d.id AS driver_id, d.skill, d.name AS driver_name, d.assigned_vehicle_id
     FROM jobs j JOIN drivers d ON d.id = j.assigned_driver_id
     WHERE d.player_id = $1 AND j.headless = TRUE AND j.outcome IS NULL
       AND j.resolves_at IS NOT NULL AND j.resolves_at <= NOW()`,
    [playerId],
  );

  for (const row of due.rows) {
    const outcome = resolveHeadlessJob(
      { skill: row.skill, hasVehicle: !!row.assigned_vehicle_id },
      { payout: row.payout, difficulty: row.difficulty },
    );

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      if (outcome.payout > 0) {
        await client.query(`UPDATE players SET money = money + $1 WHERE id = $2`, [outcome.payout, playerId]);
      }

      // Vehicle consequences — wear chips the front armour face (feeds the
      // existing repair economy); a wreck flags the vehicle destroyed.
      if (row.assigned_vehicle_id) {
        if (outcome.vehicleWrecked) {
          await client.query(
            `UPDATE vehicles SET damage_state = jsonb_set(COALESCE(damage_state, '{}'::jsonb), '{destroyed}', 'true')
             WHERE id = $1`,
            [row.assigned_vehicle_id],
          );
        } else if (outcome.wear > 0) {
          await client.query(
            `UPDATE vehicles
               SET damage_state = jsonb_set(
                 damage_state, '{armor,front}',
                 to_jsonb(GREATEST(0, COALESCE((damage_state->'armor'->>'front')::int, 0) - $2)))
             WHERE id = $1 AND damage_state ? 'armor'`,
            [row.assigned_vehicle_id, outcome.wear],
          );
        }
      }

      // Driver consequences — dead, wounded (sidelined to recover), or freed.
      if (outcome.driverDead) {
        await client.query(`UPDATE drivers SET alive = FALSE, available_at = NOW() WHERE id = $1`, [row.driver_id]);
      } else if (outcome.driverWounded) {
        await client.query(
          `UPDATE drivers SET wounded = TRUE, wounded_until = NOW() + ($2 || ' minutes')::interval, available_at = NOW()
           WHERE id = $1`,
          [row.driver_id, String(WOUND_RECOVERY_MINUTES)],
        );
      } else {
        await client.query(`UPDATE drivers SET available_at = NOW() WHERE id = $1`, [row.driver_id]);
      }

      // Persist the after-action report (acknowledged=false until the player sees it).
      const report = {
        ...outcome,
        jobDescription: row.description,
        jobType: row.job_type,
        driverName: row.driver_name,
        acknowledged: false,
      };
      await client.query(`UPDATE jobs SET outcome = $1, completed = TRUE WHERE id = $2`, [JSON.stringify(report), row.job_id]);

      await client.query(
        `INSERT INTO gang_ledger (gang_id, event_type, amount, description, result)
         VALUES ((SELECT id FROM gangs WHERE owner_player_id = $1), 'headless_job', $2, $3, $4)`,
        [
          playerId, outcome.payout,
          `Headless job (${outcome.tier}): ${row.description}`,
          JSON.stringify({ jobId: row.job_id, driverId: row.driver_id }),
        ],
      );

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}

// GET /api/jobs/headless?zoneId= — available headless jobs for a zone. Seeds the
// zone pool on first visit (like the arena job board) and resolves any due jobs.
jobsRouter.get('/headless', async (req: AuthRequest, res) => {
  await resolveDueHeadlessJobs(req.playerId!);
  const zoneId = (req.query.zoneId as string) || 'town-1';
  const db = getDb();
  const pResult = await db.query(`SELECT division FROM players WHERE id = $1`, [req.playerId]);
  const playerDiv = pResult.rows[0]?.division ?? 5;

  const existing = await db.query(
    `SELECT id FROM jobs WHERE zone_id = $1 AND headless = TRUE AND assigned_driver_id IS NULL AND completed = FALSE LIMIT 1`,
    [zoneId],
  );
  if (!existing.rows.length && HEADLESS_JOBS[zoneId]) {
    for (const j of HEADLESS_JOBS[zoneId]) {
      await db.query(
        `INSERT INTO jobs (zone_id, job_type, description, payout, division_min, headless, difficulty)
         VALUES ($1,$2,$3,$4,$5,TRUE,$6)`,
        [zoneId, j.job_type, j.description, j.payout, j.division_min, j.difficulty],
      );
    }
  }

  const rows = (await db.query(
    `SELECT id, job_type, description, payout, difficulty, division_min
     FROM jobs WHERE zone_id = $1 AND headless = TRUE AND assigned_driver_id IS NULL
       AND completed = FALSE AND division_min <= $2
     ORDER BY difficulty`,
    [zoneId, playerDiv],
  )).rows;
  return res.json(rows);
});

// GET /api/jobs/outcomes — unacknowledged after-action reports for this player.
jobsRouter.get('/outcomes', async (req: AuthRequest, res) => {
  await resolveDueHeadlessJobs(req.playerId!);
  const db = getDb();
  const rows = (await db.query(
    `SELECT j.id, j.outcome
     FROM jobs j JOIN drivers d ON d.id = j.assigned_driver_id
     WHERE d.player_id = $1 AND j.outcome IS NOT NULL
       AND COALESCE((j.outcome->>'acknowledged')::boolean, FALSE) = FALSE`,
    [req.playerId],
  )).rows;
  return res.json(rows.map(r => ({ id: r.id, ...r.outcome })));
});

// POST /api/jobs/assign — assign an available driver to a headless job.
jobsRouter.post('/assign', async (req: AuthRequest, res) => {
  const { jobId, driverId } = req.body;
  if (!jobId || !driverId) return res.status(400).json({ error: 'jobId and driverId required' });
  const db = getDb();

  const dRes = await db.query(
    `SELECT id, alive, available_at FROM drivers WHERE id = $1 AND player_id = $2`,
    [driverId, req.playerId],
  );
  if (!dRes.rows.length) return res.status(403).json({ error: 'Driver not found' });
  const drv = dRes.rows[0];
  if (!drv.alive) return res.status(409).json({ error: 'Driver is dead' });
  if (drv.available_at && new Date(drv.available_at).getTime() > Date.now()) {
    return res.status(409).json({ error: 'Driver is unavailable (on a job or wounded)' });
  }

  const jRes = await db.query(
    `SELECT id, headless, completed, assigned_driver_id FROM jobs WHERE id = $1`, [jobId],
  );
  if (!jRes.rows.length) return res.status(404).json({ error: 'Job not found' });
  const job = jRes.rows[0];
  if (!job.headless) return res.status(400).json({ error: 'Not a headless job' });
  if (job.completed || job.assigned_driver_id) return res.status(409).json({ error: 'Job already assigned' });

  const minutes = HEADLESS_MIN_MINUTES + Math.floor(Math.random() * (HEADLESS_MAX_MINUTES - HEADLESS_MIN_MINUTES + 1));
  const upd = await db.query(
    `UPDATE jobs SET assigned_driver_id = $1, resolves_at = NOW() + ($2 || ' minutes')::interval
     WHERE id = $3 AND assigned_driver_id IS NULL AND completed = FALSE
     RETURNING resolves_at`,
    [driverId, String(minutes), jobId],
  );
  if (!upd.rowCount) return res.status(409).json({ error: 'Job already assigned' });

  await db.query(`UPDATE drivers SET available_at = $1 WHERE id = $2`, [upd.rows[0].resolves_at, driverId]);
  return res.json({ ok: true, resolvesAt: upd.rows[0].resolves_at, etaMinutes: minutes });
});

// POST /api/jobs/:id/acknowledge — mark an after-action report as seen.
jobsRouter.post('/:id/acknowledge', async (req: AuthRequest, res) => {
  const db = getDb();
  await db.query(
    `UPDATE jobs j SET outcome = jsonb_set(j.outcome, '{acknowledged}', 'true')
     FROM drivers d
     WHERE d.id = j.assigned_driver_id AND d.player_id = $2 AND j.id = $1 AND j.outcome IS NOT NULL`,
    [req.params.id, req.playerId],
  );
  return res.json({ ok: true });
});
