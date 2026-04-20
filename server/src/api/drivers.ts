import { Router } from 'express';
import { getDb } from '../db/client';
import { requireAuth, AuthRequest } from './middleware';
import { generateCandidatePool } from '../rules/driverGenerator';

export const driversRouter = Router();
driversRouter.use(requireAuth);

export const HIRE_COST = 500;
const CANDIDATE_POOL_SIZE = 5;
const POOL_REFRESH_COST   = 100;

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

// ─── Hire-list candidate pool ──────────────────────────────────────────────

// Drop any candidates for this player whose expiry has passed. Returns the
// number of deleted rows (useful for logging).
async function cleanupExpired(playerId: string): Promise<void> {
  const db = getDb();
  await db.query(
    `DELETE FROM hire_candidates WHERE player_id = $1 AND expires_at < NOW()`,
    [playerId],
  );
}

// Generate a fresh candidate pool for this player, writing rows into
// hire_candidates. Uses the player's current division (for future scaling)
// and a list of stock-vehicle ids eligible for package deals.
async function regeneratePool(playerId: string): Promise<void> {
  const db = getDb();
  // Look up division + eligible stock vehicles (at or below player's div)
  const meRes = await db.query<{ division: number }>(
    `SELECT division FROM players WHERE id = $1`, [playerId],
  );
  const division = meRes.rows[0]?.division ?? 5;
  const stockRes = await db.query<{ id: string }>(
    `SELECT id FROM stock_vehicles WHERE division <= $1 ORDER BY random() LIMIT 30`,
    [division],
  );
  const eligibleIds = stockRes.rows.map(r => r.id);

  const fresh = generateCandidatePool(CANDIDATE_POOL_SIZE, division, eligibleIds);

  // Wipe the player's existing pool and insert new
  await db.query(`DELETE FROM hire_candidates WHERE player_id = $1`, [playerId]);
  for (const c of fresh) {
    await db.query(
      `INSERT INTO hire_candidates
         (player_id, name, skill, aggression, loyalty, hire_cost,
          vehicle_stock_id, vehicle_discount_pct, blurb)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        playerId, c.name, c.skill, c.aggression, c.loyalty, c.hireCost,
        c.vehicleStockId ?? null, c.vehicleDiscountPct ?? 0, c.blurb,
      ],
    );
  }
}

// GET /api/drivers/candidates — returns the player's active pool. Generates
// on demand if the pool is empty (first visit) or has fully expired.
driversRouter.get('/candidates', async (req: AuthRequest, res) => {
  const db = getDb();
  await cleanupExpired(req.playerId!);
  let rows = (await db.query(
    `SELECT hc.id, hc.name, hc.skill, hc.aggression, hc.loyalty, hc.hire_cost,
            hc.vehicle_stock_id, hc.vehicle_discount_pct, hc.blurb, hc.expires_at,
            sv.name AS vehicle_name, sv.division AS vehicle_division, sv.cost AS vehicle_cost
     FROM hire_candidates hc
     LEFT JOIN stock_vehicles sv ON sv.id = hc.vehicle_stock_id
     WHERE hc.player_id = $1
     ORDER BY hc.skill, hc.hire_cost`,
    [req.playerId],
  )).rows;
  if (rows.length === 0) {
    await regeneratePool(req.playerId!);
    rows = (await db.query(
      `SELECT hc.id, hc.name, hc.skill, hc.aggression, hc.loyalty, hc.hire_cost,
              hc.vehicle_stock_id, hc.vehicle_discount_pct, hc.blurb, hc.expires_at,
              sv.name AS vehicle_name, sv.division AS vehicle_division, sv.cost AS vehicle_cost
       FROM hire_candidates hc
       LEFT JOIN stock_vehicles sv ON sv.id = hc.vehicle_stock_id
       WHERE hc.player_id = $1
       ORDER BY hc.skill, hc.hire_cost`,
      [req.playerId],
    )).rows;
  }
  return res.json(rows);
});

// POST /api/drivers/candidates/refresh — costs a small fee to re-roll the
// whole pool. Useful when no candidates catch the player's eye.
driversRouter.post('/candidates/refresh', async (req: AuthRequest, res) => {
  const db = getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const debit = await client.query(
      `UPDATE players SET money = money - $1 WHERE id = $2 AND money >= $1 RETURNING money`,
      [POOL_REFRESH_COST, req.playerId],
    );
    if (!debit.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient funds' });
    }
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  await regeneratePool(req.playerId!);
  return res.json({ refreshed: true, cost: POOL_REFRESH_COST });
});

// POST /api/drivers/candidates/:id/hire — atomic hire: debit treasury for
// driver + optional vehicle, insert the driver row, insert a vehicle row from
// the stock blueprint if it's a package deal, assign the driver to that
// vehicle, delete the candidate.
driversRouter.post('/candidates/:id/hire', async (req: AuthRequest, res) => {
  const db = getDb();
  const cRes = await db.query(
    `SELECT id, name, skill, aggression, loyalty, hire_cost,
            vehicle_stock_id, vehicle_discount_pct
     FROM hire_candidates
     WHERE id = $1 AND player_id = $2 AND expires_at > NOW()`,
    [req.params.id, req.playerId],
  );
  if (!cRes.rows.length) return res.status(404).json({ error: 'Candidate not found or expired' });
  const cand = cRes.rows[0];

  // Compute package totals — if the candidate brings a vehicle, look up stock
  // and apply the discount pct.
  let vehicleCost = 0;
  let stockRow: { id: string; name: string; loadout: any; cost: number; weight: number } | null = null;
  if (cand.vehicle_stock_id) {
    const sRes = await db.query(
      `SELECT id, name, loadout, cost, weight FROM stock_vehicles WHERE id = $1`,
      [cand.vehicle_stock_id],
    );
    if (sRes.rows.length) {
      stockRow = sRes.rows[0];
      vehicleCost = Math.round((stockRow!.cost) * (1 - cand.vehicle_discount_pct / 100));
    }
  }
  const totalCost = cand.hire_cost + vehicleCost;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const debit = await client.query(
      `UPDATE players SET money = money - $1 WHERE id = $2 AND money >= $1 RETURNING money`,
      [totalCost, req.playerId],
    );
    if (!debit.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient funds', totalCost });
    }

    // Insert the driver with the candidate's generated stats
    const drvRes = await client.query(
      `INSERT INTO drivers (player_id, name, skill, aggression, loyalty)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, skill, aggression, loyalty, xp, assigned_vehicle_id, alive`,
      [req.playerId, cand.name, cand.skill, cand.aggression, cand.loyalty],
    );
    const driver = drvRes.rows[0];
    // Backfill gang_id
    await client.query(
      `UPDATE drivers SET gang_id = g.id FROM gangs g
       WHERE g.owner_player_id = $1 AND drivers.id = $2`,
      [req.playerId, driver.id],
    );

    let vehicleId: string | null = null;
    if (stockRow) {
      const damageState = {
        armor: { ...(stockRow.loadout.armor ?? {}) },
        engineDamaged: false, driverWounded: false, tiresBlown: [], destroyed: false,
      };
      const vRes = await client.query(
        `INSERT INTO vehicles (player_id, name, loadout, original_loadout, damage_state, value)
         VALUES ($1, $2, $3, $3, $4, $5) RETURNING id`,
        [req.playerId, stockRow.name, JSON.stringify(stockRow.loadout), JSON.stringify(damageState), vehicleCost],
      );
      vehicleId = vRes.rows[0].id;
      await client.query(`UPDATE drivers SET assigned_vehicle_id = $1 WHERE id = $2`, [vehicleId, driver.id]);
    }

    // Ledger entry
    await client.query(
      `INSERT INTO gang_ledger (gang_id, event_type, amount, description, result)
       VALUES ((SELECT id FROM gangs WHERE owner_player_id = $1), 'hire_driver', $2, $3, $4)`,
      [
        req.playerId,
        -totalCost,
        stockRow ? `Hired ${cand.name} (package w/ ${stockRow.name})` : `Hired ${cand.name}`,
        JSON.stringify({ driverId: driver.id, vehicleId, hireCost: cand.hire_cost, vehicleCost }),
      ],
    );

    await client.query(`DELETE FROM hire_candidates WHERE id = $1`, [cand.id]);
    await client.query('COMMIT');

    return res.status(201).json({
      driver: { ...driver, assigned_vehicle_id: vehicleId },
      vehicleId,
      totalCost,
      moneyRemaining: debit.rows[0].money,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});
