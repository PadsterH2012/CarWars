import { Router } from 'express';
import { getDb } from '../db/client';
import { requireAuth, AuthRequest } from './middleware';
import { WEAPONS } from '../rules/data/weapons';
import { BODIES } from '../rules/data/bodies';
import { TIRES } from '../rules/data/tires';
import { POWER_PLANTS } from '../rules/data/power-plants';
import type { VehicleLoadout, DamageState, ArmorDistribution } from '@carwars/shared';

export const economyRouter = Router();
economyRouter.use(requireAuth);

// Per Compendium: armor / tire / engine repair = the same per-point or
// per-component cost as the original build. Previously hardcoded flat rates
// ($100/armor pt, $150/tire, $500/engine) made repair vastly more expensive
// than the build itself for cheap vehicles — a Compact Sprocket would run
// up an $8,800 armor bill on a $5k car.

// Repair cost multiplier matches build cost multiplier for each armor type
const ARMOR_REPAIR_MUL: Record<string, number> = {
  ablative: 1, metal: 1, fireproof: 2, laser_reflective: 2, lr_fireproof: 4, radarproof: 2,
};

// Floor for engine repair when no power-plant cost data is available
const ENGINE_REPAIR_FALLBACK = 500;
// Floor for tire repair when no tire-cost data is available
const TIRE_REPAIR_FALLBACK   = 50;

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
  // original_loadout is set at creation time; NULL for vehicles created before this migration.
  // The fallback to loadout means pre-migration vehicles see zero ammo shortage (no resupply charge),
  // which is acceptable — they get a free first repair but subsequent repairs work correctly.
  const origLoadout  = (vehicle.original_loadout ?? loadout) as VehicleLoadout;
  const damage       = vehicle.damage_state as DamageState;
  const playerMoney  = pResult.rows[0].money as number;

  let cost = 0;
  const armorMul = ARMOR_REPAIR_MUL[origLoadout.armorType ?? 'ablative'] ?? 1;

  // Look up the body — repair-per-armour-point uses the body's own
  // armorCostPerPt (the same value the build pipeline uses to charge for
  // armour install). Falls back to a small flat rate for legacy loadouts
  // without a bodyType set.
  const body = BODIES.find(b => b.id === origLoadout.bodyType);
  const armorCostPerPt = body?.armorCostPerPt ?? 10;

  // Armor repair
  const locations: (keyof ArmorDistribution)[] = ['front', 'back', 'left', 'right', 'top', 'underbody'];
  for (const loc of locations) {
    const deficit = (origLoadout.armor[loc] ?? 0) - (damage.armor[loc] ?? 0);
    if (deficit > 0) cost += deficit * armorCostPerPt * armorMul;
  }

  // Engine repair — half the engine's install cost (Compendium guideline)
  if (damage.engineDamaged) {
    const plant = POWER_PLANTS.find(p => p.id === origLoadout.powerPlantType);
    cost += Math.round((plant?.cost ?? ENGINE_REPAIR_FALLBACK) / 2);
  }

  // Tire repair — full replacement cost per blown tire, matching the
  // installed tire type. Falls back to a small flat for legacy loadouts.
  if ((damage.tiresBlown?.length ?? 0) > 0) {
    const tire = TIRES.find(t => t.id === origLoadout.tireType);
    const perTire = tire?.costPerTire ?? TIRE_REPAIR_FALLBACK;
    cost += (damage.tiresBlown?.length ?? 0) * perTire;
  }

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
      [req.playerId, JSON.stringify({ vehicleId, cost }), -cost]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  return res.json({ cost, moneyRemaining: playerMoney - cost });
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
