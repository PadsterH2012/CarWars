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
  const [driverCheck, vehicleCheck] = await Promise.all([
    db.query(`SELECT id FROM drivers WHERE id = $1 AND player_id = $2`, [driverId, req.playerId]),
    db.query(`SELECT id FROM vehicles WHERE id = $1 AND player_id = $2`, [vehicleId, req.playerId])
  ]);
  if (!driverCheck.rows.length) return res.status(403).json({ error: 'Driver not found' });
  if (!vehicleCheck.rows.length) return res.status(403).json({ error: 'Vehicle not found' });

  await db.query(`UPDATE drivers SET assigned_vehicle_id = $1 WHERE id = $2`, [vehicleId, driverId]);
  return res.json({ ok: true });
});
