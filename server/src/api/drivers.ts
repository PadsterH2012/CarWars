import { Router } from 'express';
import { getDb } from '../db/client';
import { requireAuth, AuthRequest } from './middleware';

export const driversRouter = Router();
driversRouter.use(requireAuth);

export const HIRE_COST = 500;

driversRouter.post('/', async (req: AuthRequest, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || name.length > 64) {
    return res.status(400).json({ error: 'Invalid name' });
  }
  const db = getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Atomic debit: fail if the player can't afford it
    const debit = await client.query(
      `UPDATE players SET money = money - $1 WHERE id = $2 AND money >= $1 RETURNING money`,
      [HIRE_COST, req.playerId]
    );
    if (!debit.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient funds' });
    }
    const result = await client.query(
      `INSERT INTO drivers (player_id, name) VALUES ($1, $2)
       RETURNING id, name, skill, aggression, loyalty, xp, assigned_vehicle_id, alive`,
      [req.playerId, name]
    );
    // Also backfill gang_id so the driver shows up under the owning gang
    await client.query(
      `UPDATE drivers SET gang_id = g.id FROM gangs g
       WHERE g.owner_player_id = $1 AND drivers.id = $2`,
      [req.playerId, result.rows[0].id]
    );
    // Log the hire to gang_ledger
    await client.query(
      `INSERT INTO gang_ledger (gang_id, event_type, amount, description, result)
       VALUES ((SELECT id FROM gangs WHERE owner_player_id = $1), 'hire_driver', $2, $3, $4)`,
      [req.playerId, -HIRE_COST, `Hired ${name}`, JSON.stringify({ driverId: result.rows[0].id })]
    );
    await client.query('COMMIT');
    return res.status(201).json({ ...result.rows[0], moneyRemaining: debit.rows[0].money });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
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
  // Auto-promote while XP crosses threshold and skill is below 6
  while (newSkill < 6 && newXp >= xpThreshold(newSkill)) {
    newSkill++;
  }

  await db.query(
    `UPDATE drivers SET xp = $1, skill = $2 WHERE id = $3`,
    [newXp, newSkill, driverId]
  );

  return res.json({ newXp, newSkill, promoted: newSkill > driver.skill });
});

driversRouter.post('/assign', async (req: AuthRequest, res) => {
  const { driverId, vehicleId } = req.body;
  if (!driverId || !vehicleId) return res.status(400).json({ error: 'driverId and vehicleId required' });

  const db = getDb();
  const [driverCheck, vehicleCheck] = await Promise.all([
    db.query(`SELECT id FROM drivers WHERE id = $1 AND player_id = $2`, [driverId, req.playerId]),
    db.query(`SELECT id FROM vehicles WHERE id = $1 AND player_id = $2`, [vehicleId, req.playerId])
  ]);
  if (!driverCheck.rows.length) return res.status(403).json({ error: 'Driver not found' });
  if (!vehicleCheck.rows.length) return res.status(403).json({ error: 'Vehicle not found' });

  await db.query(`UPDATE drivers SET assigned_vehicle_id = $1 WHERE id = $2`, [vehicleId, driverId]);
  return res.json({ ok: true });
});
