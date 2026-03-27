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
    `INSERT INTO vehicles (player_id, name, loadout, damage_state, value)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
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
