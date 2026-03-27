import { Router } from 'express';
import { getDb } from '../db/client';
import { requireAuth, AuthRequest } from './middleware';
import type { VehicleLoadout, DamageState, ArmorDistribution } from '@carwars/shared';

export const economyRouter = Router();
economyRouter.use(requireAuth);

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

// Jobs listing
export const jobsRouter = Router();
jobsRouter.use(requireAuth);

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
  const existing = await db.query(`SELECT id FROM jobs WHERE zone_id = $1 LIMIT 1`, [zoneId]);
  if (!existing.rows.length && STATIC_JOBS[zoneId]) {
    for (const job of STATIC_JOBS[zoneId]) {
      await db.query(
        `INSERT INTO jobs (zone_id, job_type, description, payout, division_min) VALUES ($1,$2,$3,$4,$5)`,
        [zoneId, job.job_type, job.description, job.payout, job.division_min]
      );
    }
  }

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

jobsRouter.post('/:id/take', async (req: AuthRequest, res) => {
  const { id } = req.params;
  const db = getDb();

  const result = await db.query(
    `SELECT id, division_min FROM jobs WHERE id = $1`,
    [id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Job not found' });
  const job = result.rows[0];

  const pResult = await db.query(`SELECT division FROM players WHERE id = $1`, [req.playerId]);
  if (!pResult.rows.length) return res.status(401).json({ error: 'Player not found' });
  if (pResult.rows[0].division < job.division_min) {
    return res.status(403).json({ error: 'Division too low' });
  }

  const updateResult = await db.query(
    `UPDATE jobs SET taken_by = $1 WHERE id = $2 AND taken_by IS NULL AND completed = FALSE`,
    [req.playerId, id]
  );
  if (updateResult.rowCount === 0) {
    return res.status(409).json({ error: 'Job already taken' });
  }
  return res.json({ ok: true });
});

jobsRouter.post('/:id/complete', async (req: AuthRequest, res) => {
  const { id } = req.params;
  const db = getDb();

  const result = await db.query(
    `SELECT id, taken_by, completed, payout, job_type, zone_id FROM jobs WHERE id = $1`,
    [id]
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
