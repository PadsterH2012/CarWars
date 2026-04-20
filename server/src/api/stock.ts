import { Router } from 'express';
import { getDb } from '../db/client';
import { requireAuth, AuthRequest } from './middleware';
import { deriveStats } from '../rules/vehicle';
import { computeCapacity, isInvalid } from '../rules/capacity';
import type { VehicleLoadout } from '@carwars/shared';

// Public stock-vehicle catalog from the AADA Vehicle Guides. Listing is
// open (no auth); purchasing an instance debits the authenticated player's
// treasury and creates a real row in `vehicles`.
export const stockRouter = Router();

stockRouter.get('/', async (req, res) => {
  const db = getDb();
  const division = req.query.division ? parseInt(req.query.division as string, 10) : null;
  const result = division !== null
    ? await db.query(
        `SELECT id, name, division, description, loadout, cost, weight, source
         FROM stock_vehicles WHERE division = $1 ORDER BY cost`,
        [division]
      )
    : await db.query(
        `SELECT id, name, division, description, loadout, cost, weight, source
         FROM stock_vehicles ORDER BY division, cost`
      );
  return res.json(result.rows);
});

stockRouter.get('/:id', async (req, res) => {
  const db = getDb();
  const result = await db.query(
    `SELECT id, name, division, description, loadout, cost, weight, source
     FROM stock_vehicles WHERE id = $1`,
    [req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
  return res.json(result.rows[0]);
});

// POST /api/stock/:id/purchase — atomic: fetches the blueprint, validates it
// still passes capacity, debits the gang/player treasury, and inserts a new
// vehicles row populated from the blueprint's loadout.
stockRouter.post('/:id/purchase', requireAuth, async (req: AuthRequest, res) => {
  const db = getDb();

  const stockRes = await db.query(
    `SELECT id, name, loadout, cost FROM stock_vehicles WHERE id = $1`,
    [req.params.id]
  );
  if (!stockRes.rows.length) return res.status(404).json({ error: 'Stock vehicle not found' });
  const stock = stockRes.rows[0];
  const loadout = stock.loadout as VehicleLoadout;

  // Re-validate the blueprint under current rules — a seeded design should
  // never fail this, but if the catalog changes we'd rather reject than
  // silently ship broken cars.
  try {
    deriveStats('stock-preview', stock.name, loadout);
  } catch (e: any) {
    return res.status(500).json({ error: `Stock design invalid: ${e.message}` });
  }
  const cap = computeCapacity(loadout);
  if (isInvalid(cap)) {
    return res.status(500).json({ error: `Stock design over capacity: ${cap.errors.join('; ')}` });
  }

  // Optional player-supplied name override (e.g. "My Sprocket #2")
  const customName = typeof req.body?.name === 'string' && req.body.name.trim()
    ? req.body.name.trim().slice(0, 64)
    : stock.name;

  const cost: number = stock.cost;
  const damageState = {
    armor: { ...loadout.armor },
    engineDamaged: false,
    driverWounded: false,
    tiresBlown: [],
    destroyed: false,
  };

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const debitRes = await client.query(
      `UPDATE players SET money = money - $1 WHERE id = $2 AND money >= $1 RETURNING money`,
      [cost, req.playerId]
    );
    if (!debitRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient funds' });
    }
    const insertRes = await client.query(
      `INSERT INTO vehicles (player_id, name, loadout, original_loadout, damage_state, value)
       VALUES ($1, $2, $3, $3, $4, $5) RETURNING id`,
      [req.playerId, customName, JSON.stringify(loadout), JSON.stringify(damageState), cost]
    );
    await client.query(
      `INSERT INTO event_history (player_id, event_type, result, money_delta) VALUES ($1,'stock_purchase',$2,$3)`,
      [req.playerId, JSON.stringify({ vehicleId: insertRes.rows[0].id, stockId: stock.id, name: customName, cost }), -cost]
    );
    await client.query(
      `INSERT INTO gang_ledger (gang_id, event_type, amount, description, result)
       VALUES ((SELECT id FROM gangs WHERE owner_player_id = $1), 'vehicle_build', $2, $3, $4)`,
      [req.playerId, -cost, `Purchased stock vehicle: ${stock.name}`, JSON.stringify({ vehicleId: insertRes.rows[0].id, stockId: stock.id })]
    );
    await client.query('COMMIT');
    return res.status(201).json({
      id: insertRes.rows[0].id,
      name: customName,
      cost,
      moneyRemaining: debitRes.rows[0].money,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});
