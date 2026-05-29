import { Router } from 'express';
import { getDb } from '../db/client';
import { requireAuth, AuthRequest } from './middleware';

export const garagesRouter = Router();
garagesRouter.use(requireAuth);

export const GARAGE_COST = 50_000;
// Passive income: every elapsed real hour counts as one "day" of NPC bay usage.
export const INCOME_PER_DAY = 200;
const MAX_WITH_GARAGE = 3;
const MAX_WITHOUT_GARAGE = 1;

// Accepts either the pool (getDb()) or a transaction client — both expose query().
type Queryable = { query: (text: string, params?: any[]) => Promise<any> };

export async function playerOwnsGarage(db: Queryable, playerId: string): Promise<boolean> {
  const r = await db.query('SELECT 1 FROM garages WHERE player_id = $1', [playerId]);
  return r.rows.length > 0;
}

export async function maxVehiclesForPlayer(db: Queryable, playerId: string): Promise<number> {
  return (await playerOwnsGarage(db, playerId)) ? MAX_WITH_GARAGE : MAX_WITHOUT_GARAGE;
}

// True when the player is already at their storage cap — used to block new
// builds/purchases. A soft limit: nothing is sold, the player just can't acquire
// more until a slot frees up.
export async function vehicleLimitReached(db: Queryable, playerId: string): Promise<boolean> {
  const max = await maxVehiclesForPlayer(db, playerId);
  const r = await db.query('SELECT COUNT(*)::int AS n FROM vehicles WHERE player_id = $1', [playerId]);
  return r.rows[0].n >= max;
}

// Lazily credit garage passive income. Each whole hour since last_income_at is
// one "day" worth ($200). Advances last_income_at by exactly the consumed hours
// so fractional time isn't lost. Returns the income gained and the garage row
// (or { gained: 0, garage: null } when the player owns no garage). Must run
// inside a transaction — it mutates garages, players and gang_ledger.
export async function resolveGarageIncome(
  client: Queryable,
  playerId: string,
): Promise<{ gained: number; garage: any | null }> {
  const gRes = await client.query(
    `SELECT id, name, last_income_at, accumulated_income, storage_slots, repair_discount,
            FLOOR(EXTRACT(EPOCH FROM (NOW() - last_income_at)) / 3600)::int AS elapsed_hours
     FROM garages WHERE player_id = $1`,
    [playerId],
  );
  if (!gRes.rows.length) return { gained: 0, garage: null };
  const garage = gRes.rows[0];
  const hours = Math.max(0, garage.elapsed_hours);
  if (hours <= 0) return { gained: 0, garage };

  const gained = hours * INCOME_PER_DAY;
  await client.query(
    `UPDATE garages
        SET last_income_at = last_income_at + ($1 * INTERVAL '1 hour'),
            accumulated_income = accumulated_income + $2
      WHERE id = $3`,
    [hours, gained, garage.id],
  );
  await client.query(`UPDATE players SET money = money + $1 WHERE id = $2`, [gained, playerId]);
  await client.query(
    `INSERT INTO gang_ledger (gang_id, event_type, amount, description, result)
     VALUES ((SELECT id FROM gangs WHERE owner_player_id = $1), 'garage_income', $2, $3, $4)`,
    [playerId, gained, `Garage income: +$${gained}`, JSON.stringify({ hours, perDay: INCOME_PER_DAY })],
  );
  garage.accumulated_income += gained;
  return { gained, garage };
}

// POST /api/garages/purchase — buy a garage bay for $50,000. One per player.
garagesRouter.post('/purchase', async (req: AuthRequest, res) => {
  const db = getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT 1 FROM garages WHERE player_id = $1', [req.playerId]);
    if (existing.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'You already own a garage bay.' });
    }
    const debit = await client.query(
      `UPDATE players SET money = money - $1 WHERE id = $2 AND money >= $1 RETURNING money`,
      [GARAGE_COST, req.playerId],
    );
    if (!debit.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient funds' });
    }
    const ins = await client.query(
      `INSERT INTO garages (player_id) VALUES ($1)
       RETURNING id, name, storage_slots, repair_discount, purchased_at`,
      [req.playerId],
    );
    await client.query(
      `INSERT INTO event_history (player_id, event_type, result, money_delta)
       VALUES ($1, 'garage_purchase', $2, $3)`,
      [req.playerId, JSON.stringify({ garageId: ins.rows[0].id, cost: GARAGE_COST }), -GARAGE_COST],
    );
    await client.query(
      `INSERT INTO gang_ledger (gang_id, event_type, amount, description, result)
       VALUES ((SELECT id FROM gangs WHERE owner_player_id = $1), 'garage_purchase', $2, $3, $4)`,
      [req.playerId, -GARAGE_COST, 'Purchased a garage bay', JSON.stringify({ garageId: ins.rows[0].id })],
    );
    await client.query('COMMIT');
    return res.status(201).json({ garage: ins.rows[0], moneyRemaining: debit.rows[0].money });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

// GET /api/garages — garage status for the current player. Resolves any pending
// passive income on visit (lazy tick), then reports the current state. For
// non-owners returns { owned: false } plus the purchase cost.
garagesRouter.get('/', async (req: AuthRequest, res) => {
  const db = getDb();
  const client = await db.connect();
  let result;
  try {
    await client.query('BEGIN');
    result = await resolveGarageIncome(client, req.playerId!);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  const { gained, garage } = result;
  const countR = await db.query('SELECT COUNT(*)::int AS n FROM vehicles WHERE player_id = $1', [req.playerId]);
  const vehicleCount = countR.rows[0].n;

  if (!garage) {
    return res.json({ owned: false, cost: GARAGE_COST, vehicleCount, maxVehicles: MAX_WITHOUT_GARAGE });
  }
  return res.json({
    owned: true,
    name: garage.name,
    storageSlots: garage.storage_slots,
    maxVehicles: garage.storage_slots,
    vehicleCount,
    repairDiscount: garage.repair_discount,
    accumulatedIncome: garage.accumulated_income,
    incomeThisVisit: gained,
    incomePerDay: INCOME_PER_DAY,
  });
});
