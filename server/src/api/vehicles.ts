import { Router } from 'express';
import { getDb } from '../db/client';
import { requireAuth, AuthRequest } from './middleware';
import { deriveStats } from '../rules/vehicle';
import type { VehicleLoadout } from '@carwars/shared';

export const vehiclesRouter = Router();
vehiclesRouter.use(requireAuth);

vehiclesRouter.post('/', async (req: AuthRequest, res) => {
  const { name, loadout } = req.body as { name: string; loadout: VehicleLoadout };
  if (!name || !loadout) return res.status(400).json({ error: 'name and loadout required' });
  if (name.length > 64) return res.status(400).json({ error: 'name too long' });

  let stats;
  try {
    stats = deriveStats('tmp', name, loadout);
  } catch (e: any) {
    return res.status(400).json({ error: e.message });
  }

  const defaultDamageState = {
    armor: { ...loadout.armor },
    engineDamaged: false,
    driverWounded: false,
    tiresBlown: [],
    destroyed: false
  };

  const db = getDb();
  const result = await db.query(
    `INSERT INTO vehicles (player_id, name, loadout, original_loadout, damage_state, value)
     VALUES ($1, $2, $3, $3, $4, $5) RETURNING id`,
    [req.playerId, name, JSON.stringify(loadout), JSON.stringify(defaultDamageState), loadout.totalCost]
  );
  return res.status(201).json({ id: result.rows[0].id });
});

vehiclesRouter.get('/', async (req: AuthRequest, res) => {
  const db = getDb();
  const result = await db.query(
    `SELECT id, name, loadout, damage_state, value FROM vehicles WHERE player_id = $1`,
    [req.playerId]
  );
  return res.json(result.rows);
});

vehiclesRouter.get('/:id', async (req: AuthRequest, res) => {
  const db = getDb();
  const result = await db.query(
    `SELECT id, player_id, name, loadout, damage_state, value FROM vehicles WHERE id = $1`,
    [req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
  const row = result.rows[0];
  if (row.player_id !== req.playerId) return res.status(403).json({ error: 'Forbidden' });
  return res.json(row);
});

vehiclesRouter.delete('/:id', async (req: AuthRequest, res) => {
  const db = getDb();
  const result = await db.query(
    `SELECT id, value, in_arena FROM vehicles WHERE id = $1 AND player_id = $2`,
    [req.params.id, req.playerId]
  );
  if (!result.rows.length) return res.status(403).json({ error: 'Vehicle not found' });

  const vehicle = result.rows[0];
  if (vehicle.in_arena) {
    return res.status(409).json({ error: 'Cannot sell a vehicle that is currently in an arena' });
  }
  const salePrice = Math.floor(vehicle.value / 2);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM vehicles WHERE id = $1`, [vehicle.id]);
    await client.query(`UPDATE players SET money = money + $1 WHERE id = $2`, [salePrice, req.playerId]);
    await client.query(
      `INSERT INTO event_history (player_id, event_type, result, money_delta) VALUES ($1,'sell',$2,$3)`,
      [req.playerId, JSON.stringify({ vehicleId: vehicle.id, salePrice }), salePrice]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  return res.json({ salePrice });
});
