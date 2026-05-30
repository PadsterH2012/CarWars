import { Router } from 'express';
import { getDb } from '../db/client';
import { requireAuth, AuthRequest } from './middleware';
import { generateTieredPool } from '../rules/driverGenerator';
import { generateRequestForDriver } from '../rules/requestGenerator';
import { computeCapacity, isInvalid } from '../rules/capacity';
import { driverTitleFromXp, xpToNextTitle } from '../rules/driverTitle';
import { resolveDueDeployments } from './deploy';

export const driversRouter = Router();
driversRouter.use(requireAuth);

export const HIRE_COST = 500;
const POOL_REFRESH_COST   = 100;
// Arena wins required before the premium hire band (skill 4-6) is offered.
const PREMIUM_UNLOCK_WINS = 5;

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
  // Resolve any due squad deployments (jobs now run through the squad engine)
  // so the statuses below are fresh.
  await resolveDueDeployments(req.playerId!);
  const db = getDb();
  const result = await db.query(
    `SELECT id, name, skill, aggression, loyalty, xp, xp_pool, assigned_vehicle_id, alive, wounded, wounded_until, available_at,
            attributes, skills
     FROM drivers WHERE player_id = $1`,
    [req.playerId]
  );
  const now = Date.now();
  // Decorate each driver with a Compendium-style title + xp-to-next so the
  // client can show 'Rick Steele — Veteran (250 PP to Expert)' without the
  // UI having to duplicate the thresholds. Also compute an availability
  // status + remaining seconds for the garage crew panel (Phase 2).
  const rows = result.rows.map(d => {
    const woundedUntilMs = d.wounded_until ? new Date(d.wounded_until).getTime() : 0;
    const availableAtMs = d.available_at ? new Date(d.available_at).getTime() : 0;
    let status: 'available' | 'on_job' | 'wounded' = 'available';
    let remainingSeconds = 0;
    if (d.wounded && woundedUntilMs > now) {
      status = 'wounded';
      remainingSeconds = Math.ceil((woundedUntilMs - now) / 1000);
    } else if (availableAtMs > now) {
      status = 'on_job';
      remainingSeconds = Math.ceil((availableAtMs - now) / 1000);
    }
    return {
      ...d,
      title: driverTitleFromXp(d.xp),
      xpToNext: xpToNextTitle(d.xp),
      status,
      remainingSeconds,
    };
  });
  return res.json(rows);
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
  // Look up division + win count + eligible stock vehicles (at or below div)
  const meRes = await db.query<{ division: number; wins: number }>(
    `SELECT division, wins FROM players WHERE id = $1`, [playerId],
  );
  const division = meRes.rows[0]?.division ?? 5;
  const wins = meRes.rows[0]?.wins ?? 0;
  const premiumUnlocked = wins >= PREMIUM_UNLOCK_WINS;
  const stockRes = await db.query<{ id: string }>(
    `SELECT id FROM stock_vehicles WHERE division <= $1 ORDER BY random() LIMIT 30`,
    [division],
  );
  const eligibleIds = stockRes.rows.map(r => r.id);

  const fresh = generateTieredPool(division, eligibleIds, { premiumUnlocked });

  // Wipe the player's existing pool and insert new
  await db.query(`DELETE FROM hire_candidates WHERE player_id = $1`, [playerId]);
  for (const c of fresh) {
    await db.query(
      `INSERT INTO hire_candidates
         (player_id, name, skill, aggression, loyalty, hire_cost,
          vehicle_stock_id, vehicle_discount_pct, blurb, tier,
          starting_attributes, starting_skills)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        playerId, c.name, c.skill, c.aggression, c.loyalty, c.hireCost,
        c.vehicleStockId ?? null, c.vehicleDiscountPct ?? 0, c.blurb, c.tier,
        JSON.stringify(c.startingAttributes), JSON.stringify(c.startingSkills),
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
            hc.vehicle_stock_id, hc.vehicle_discount_pct, hc.blurb, hc.tier, hc.expires_at,
            sv.name AS vehicle_name, sv.division AS vehicle_division, sv.cost AS vehicle_cost
     FROM hire_candidates hc
     LEFT JOIN stock_vehicles sv ON sv.id = hc.vehicle_stock_id
     WHERE hc.player_id = $1
     ORDER BY CASE hc.tier WHEN 'rookie' THEN 0 WHEN 'standard' THEN 1 WHEN 'premium' THEN 2 ELSE 3 END,
              hc.skill, hc.hire_cost`,
    [req.playerId],
  )).rows;
  if (rows.length === 0) {
    await regeneratePool(req.playerId!);
    rows = (await db.query(
      `SELECT hc.id, hc.name, hc.skill, hc.aggression, hc.loyalty, hc.hire_cost,
              hc.vehicle_stock_id, hc.vehicle_discount_pct, hc.blurb, hc.tier, hc.expires_at,
              sv.name AS vehicle_name, sv.division AS vehicle_division, sv.cost AS vehicle_cost
       FROM hire_candidates hc
       LEFT JOIN stock_vehicles sv ON sv.id = hc.vehicle_stock_id
       WHERE hc.player_id = $1
       ORDER BY CASE hc.tier WHEN 'rookie' THEN 0 WHEN 'standard' THEN 1 WHEN 'premium' THEN 2 ELSE 3 END,
                hc.skill, hc.hire_cost`,
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
            vehicle_stock_id, vehicle_discount_pct,
            starting_attributes, starting_skills
     FROM hire_candidates
     WHERE id = $1 AND player_id = $2 AND expires_at > NOW()`,
    [req.params.id, req.playerId],
  );
  if (!cRes.rows.length) return res.status(404).json({ error: 'Candidate not found or expired' });
  const cand = cRes.rows[0];
  const DEFAULT_ATTRS = { st: 10, dx: 10, iq: 10, ht: 10 };
  const hireAttrs = (cand.starting_attributes && Object.keys(cand.starting_attributes).length > 0)
    ? cand.starting_attributes : DEFAULT_ATTRS;
  const hireSkills = cand.starting_skills ?? {};

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

    // Insert the driver with the candidate's generated stats + attributes/skills
    const drvRes = await client.query(
      `INSERT INTO drivers (player_id, name, skill, aggression, loyalty, attributes, skills, xp_pool)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, skill, aggression, loyalty, xp, assigned_vehicle_id, alive`,
      [req.playerId, cand.name, cand.skill, cand.aggression, cand.loyalty,
       JSON.stringify(hireAttrs), JSON.stringify(hireSkills), 0],
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

// ─── Driver requests (autonomous upgrade asks) ─────────────────────────────

// GET /api/drivers/requests — returns pending requests, generating new ones
// for any driver without one. Expired requests are cleared first.
driversRouter.get('/requests', async (req: AuthRequest, res) => {
  const db = getDb();
  // Mark overdue requests as expired (status flip, not delete — kept for history)
  await db.query(
    `UPDATE driver_requests SET status = 'expired', resolved_at = NOW()
     WHERE player_id = $1 AND status = 'pending' AND expires_at < NOW()`,
    [req.playerId],
  );
  // Load drivers + their assigned vehicles
  const drvs = await db.query(
    `SELECT d.id, d.name, d.skill, d.aggression, d.loyalty,
            d.assigned_vehicle_id,
            v.id  AS vid, v.name AS vname, v.loadout, v.original_loadout, v.damage_state
     FROM drivers d
     LEFT JOIN vehicles v ON v.id = d.assigned_vehicle_id
     WHERE d.player_id = $1 AND d.alive = TRUE`,
    [req.playerId],
  );
  // Existing pending request per driver — skip if already has one
  const existing = await db.query<{ driver_id: string }>(
    `SELECT driver_id FROM driver_requests WHERE player_id = $1 AND status = 'pending'`,
    [req.playerId],
  );
  const hasPending = new Set(existing.rows.map(r => r.driver_id));

  for (const row of drvs.rows) {
    if (hasPending.has(row.id)) continue;
    const driver = {
      id: row.id, name: row.name, skill: row.skill,
      aggression: row.aggression, loyalty: row.loyalty,
    };
    const vehicle = row.vid ? {
      id: row.vid, name: row.vname,
      loadout: row.loadout, original_loadout: row.original_loadout, damage_state: row.damage_state,
    } : null;
    const gen = generateRequestForDriver(driver, vehicle);
    if (!gen) continue;
    await db.query(
      `INSERT INTO driver_requests
         (player_id, driver_id, vehicle_id, kind, description, payload, cost)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [req.playerId, row.id, row.vid, gen.kind, gen.description, JSON.stringify(gen.payload), gen.cost],
    );
  }

  const pending = await db.query(
    `SELECT dr.id, dr.kind, dr.description, dr.payload, dr.cost, dr.created_at, dr.expires_at,
            dr.driver_id, d.name AS driver_name, d.skill AS driver_skill,
            dr.vehicle_id, v.name AS vehicle_name
     FROM driver_requests dr
     JOIN drivers d ON d.id = dr.driver_id
     LEFT JOIN vehicles v ON v.id = dr.vehicle_id
     WHERE dr.player_id = $1 AND dr.status = 'pending'
     ORDER BY dr.created_at DESC`,
    [req.playerId],
  );
  return res.json(pending.rows);
});

// POST /api/drivers/requests/:id/approve — execute the request action atomically
driversRouter.post('/requests/:id/approve', async (req: AuthRequest, res) => {
  const db = getDb();
  const reqRes = await db.query(
    `SELECT id, driver_id, vehicle_id, kind, payload, cost
     FROM driver_requests
     WHERE id = $1 AND player_id = $2 AND status = 'pending'`,
    [req.params.id, req.playerId],
  );
  if (!reqRes.rows.length) return res.status(404).json({ error: 'Request not found' });
  const r = reqRes.rows[0];
  const payload = r.payload as Record<string, any>;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const debit = await client.query(
      `UPDATE players SET money = money - $1 WHERE id = $2 AND money >= $1 RETURNING money`,
      [r.cost, req.playerId],
    );
    if (!debit.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient funds', cost: r.cost });
    }

    // Load current vehicle state (if request targets one)
    const vid: string | null = r.vehicle_id;
    if (vid) {
      const vRes = await client.query(
        `SELECT loadout, original_loadout, damage_state FROM vehicles WHERE id = $1 AND player_id = $2`,
        [vid, req.playerId],
      );
      if (!vRes.rows.length) throw new Error('Vehicle not found');
      const loadout = vRes.rows[0].loadout as any;
      const orig = (vRes.rows[0].original_loadout ?? loadout) as any;
      const ds = vRes.rows[0].damage_state as any;

      if (r.kind === 'repair') {
        // Restore all armor faces from original + clear damage flags + reset ammo
        const restored = {
          ...ds,
          armor: { ...orig.armor },
          engineDamaged: false,
          tiresBlown: [],
          destroyed: false,
        };
        const restoredMounts = (loadout.mounts ?? []).map((m: any) => {
          const om = (orig.mounts ?? []).find((o: any) => o.id === m.id);
          return om ? { ...m, ammo: om.ammo } : m;
        });
        await client.query(
          `UPDATE vehicles SET damage_state = $1, loadout = $2 WHERE id = $3`,
          [JSON.stringify(restored), JSON.stringify({ ...loadout, mounts: restoredMounts }), vid],
        );
      } else if (r.kind === 'ammo') {
        const mountId = payload.mountId as string;
        const mounts = (loadout.mounts ?? []).map((m: any) => {
          if (m.id !== mountId) return m;
          const om = (orig.mounts ?? []).find((o: any) => o.id === m.id);
          return om ? { ...m, ammo: om.ammo } : m;
        });
        await client.query(
          `UPDATE vehicles SET loadout = $1 WHERE id = $2`,
          [JSON.stringify({ ...loadout, mounts }), vid],
        );
      } else if (r.kind === 'armor_up') {
        const face = payload.face as string;
        const delta = payload.delta as number;
        const newOrigArmor = { ...orig.armor, [face]: (orig.armor[face] ?? 0) + delta };
        const newArmor    = { ...ds.armor,   [face]: (ds.armor[face]   ?? 0) + delta };
        const proposedOrig = { ...orig, armor: newOrigArmor };
        // Capacity guard — extra armour adds weight, may exceed load budget
        const cap = computeCapacity(proposedOrig);
        if (isInvalid(cap)) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: `Would exceed capacity (${cap.errors.join('; ')}). Dismiss the request and bump armour manually after freeing up space.`,
          });
        }
        await client.query(
          `UPDATE vehicles
             SET original_loadout = $1, damage_state = $2, value = value + $3
             WHERE id = $4`,
          [
            JSON.stringify(proposedOrig),
            JSON.stringify({ ...ds, armor: newArmor }),
            r.cost, vid,
          ],
        );
      } else if (r.kind === 'compound_swap') {
        // Remove step + add step in one go. Net cost already precomputed by
        // the generator; we still re-validate capacity after both edits.
        const remove = payload.remove as { type: string; mountId?: string };
        const add    = payload.add    as { type: string; accessoryId?: string; bindToFirstMount?: boolean; cost?: number };
        let newLoadout = { ...loadout };
        if (remove.type === 'weapon' && remove.mountId) {
          newLoadout = { ...newLoadout, mounts: (newLoadout.mounts ?? []).filter(m => m.id !== remove.mountId) };
        }
        if (add.type === 'accessory' && add.accessoryId) {
          const accessories = [...(newLoadout.accessories ?? [])];
          const boundMountId = add.bindToFirstMount ? newLoadout.mounts?.[0]?.id : undefined;
          accessories.push({ id: add.accessoryId, ...(boundMountId ? { boundMountId } : {}) });
          newLoadout = { ...newLoadout, accessories };
        }
        const cap = computeCapacity(newLoadout);
        if (isInvalid(cap)) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: `Compound swap would still exceed capacity (${cap.errors.join('; ')}).`,
          });
        }
        await client.query(
          `UPDATE vehicles SET loadout = $1, value = value + $2 WHERE id = $3`,
          [JSON.stringify(newLoadout), r.cost, vid],
        );
      } else if (r.kind === 'accessory_add') {
        const accessoryId = payload.accessoryId as string;
        const bindToFirstMount = !!payload.bindToFirstMount;
        const accessories = [...(loadout.accessories ?? [])];
        const boundMountId = bindToFirstMount ? (loadout.mounts?.[0]?.id ?? undefined) : undefined;
        accessories.push({ id: accessoryId, ...(boundMountId ? { boundMountId } : {}) });
        const proposed = { ...loadout, accessories };
        // Capacity guard — approving the request can't push the vehicle
        // over its spaces/weight budget. If it would, reject with a clear
        // error so the player can dismiss the request and reshuffle manually.
        const cap = computeCapacity(proposed);
        if (isInvalid(cap)) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: `Would exceed capacity (${cap.errors.join('; ')}). Dismiss the request and install the accessory manually after freeing up space.`,
          });
        }
        await client.query(
          `UPDATE vehicles SET loadout = $1, value = value + $2 WHERE id = $3`,
          [JSON.stringify(proposed), r.cost, vid],
        );
      }
    }

    // Mark the request resolved
    await client.query(
      `UPDATE driver_requests SET status = 'approved', resolved_at = NOW() WHERE id = $1`,
      [r.id],
    );
    // Loyalty +1 for approval (capped at 10)
    await client.query(
      `UPDATE drivers SET loyalty = LEAST(10, loyalty + 1) WHERE id = $1`,
      [r.driver_id],
    );
    // Ledger
    await client.query(
      `INSERT INTO gang_ledger (gang_id, event_type, amount, description, result)
       VALUES ((SELECT id FROM gangs WHERE owner_player_id = $1), 'driver_request', $2, $3, $4)`,
      [
        req.playerId, -r.cost,
        `Approved driver request: ${r.kind}`,
        JSON.stringify({ requestId: r.id, driverId: r.driver_id, vehicleId: vid }),
      ],
    );

    await client.query('COMMIT');
    return res.json({ ok: true, cost: r.cost, moneyRemaining: debit.rows[0].money });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

// POST /api/drivers/requests/:id/deny — close + small loyalty hit
driversRouter.post('/requests/:id/deny', async (req: AuthRequest, res) => {
  const db = getDb();
  const r = await db.query(
    `UPDATE driver_requests SET status = 'denied', resolved_at = NOW()
     WHERE id = $1 AND player_id = $2 AND status = 'pending'
     RETURNING driver_id`,
    [req.params.id, req.playerId],
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Request not found' });
  await db.query(
    `UPDATE drivers SET loyalty = GREATEST(0, loyalty - 1) WHERE id = $1`,
    [r.rows[0].driver_id],
  );
  return res.json({ ok: true });
});
