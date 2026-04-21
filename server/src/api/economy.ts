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
  const armorMul = ARMOR_REPAIR_MUL[origLoadout.armorType ?? 'ablative'] ?? 1;
  const body = BODIES.find(b => b.id === origLoadout.bodyType);
  const armorCostPerPt = body?.armorCostPerPt ?? 10;

  let armorPts = 0;
  const locations: (keyof ArmorDistribution)[] = ['front', 'back', 'left', 'right', 'top', 'underbody'];
  for (const loc of locations) {
    const deficit = (origLoadout.armor[loc] ?? 0) - (damage.armor[loc] ?? 0);
    if (deficit > 0) armorPts += deficit;
  }
  const armorCost = armorPts * armorCostPerPt * armorMul;

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
  const vResult = await db.query(
    `SELECT id, loadout, original_loadout, damage_state
     FROM vehicles WHERE id = $1 AND player_id = $2`,
    [vehicleId, req.playerId],
  );
  if (!vResult.rows.length) return res.status(403).json({ error: 'Vehicle not found' });
  const loadout     = vResult.rows[0].loadout as VehicleLoadout;
  const origLoadout = (vResult.rows[0].original_loadout ?? loadout) as VehicleLoadout;
  const damage      = vResult.rows[0].damage_state as DamageState;
  return res.json(computeRepairQuote(loadout, origLoadout, damage));
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

  const quote = computeRepairQuote(loadout, origLoadout, damage);
  const doArmor  = parts.includes('armor');
  const doTires  = parts.includes('tires');
  const doEngine = parts.includes('engine');
  const doAmmo   = parts.includes('ammo');
  const cost = (doArmor ? quote.armor.cost : 0)
             + (doTires ? quote.tires.cost : 0)
             + (doEngine ? quote.engine.cost : 0)
             + (doAmmo  ? quote.ammo.cost   : 0);

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
