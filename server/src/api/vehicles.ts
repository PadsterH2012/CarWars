import { Router } from 'express';
import { getDb } from '../db/client';
import { requireAuth, AuthRequest } from './middleware';
import { deriveStats } from '../rules/vehicle';
import { computeCapacity } from '../rules/capacity';
import { WEAPONS } from '../rules/data/weapons';
import type { VehicleLoadout, WeaponMount } from '@carwars/shared';

const WORKSHOP_TRADE_IN = 0.5;   // percentage refunded when a weapon/ammo is removed

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

  // Capacity guard — a cycle can't carry a heavy-laser-plus-rocket-launcher
  // just because the designer permits the dropdown. Enforced for new builds;
  // existing over-capacity vehicles (pre-rule) are grandfathered until edited.
  const cap = computeCapacity(loadout);
  if (cap.overSpaces || cap.overWeight) {
    return res.status(400).json({ error: `Loadout exceeds body capacity — ${cap.errors.join('; ')}` });
  }

  const cost = loadout.totalCost ?? 0;
  if (cost <= 0) return res.status(400).json({ error: 'loadout.totalCost must be positive' });

  const defaultDamageState = {
    armor: { ...loadout.armor },
    engineDamaged: false,
    driverWounded: false,
    tiresBlown: [],
    destroyed: false
  };

  const db = getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Atomic debit: only deducts if the player has enough money. Returns the new
    // balance when successful; no rows when the player can't afford it.
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
      [req.playerId, name, JSON.stringify(loadout), JSON.stringify(defaultDamageState), cost]
    );
    await client.query(
      `INSERT INTO event_history (player_id, event_type, result, money_delta) VALUES ($1,'vehicle_build',$2,$3)`,
      [req.playerId, JSON.stringify({ vehicleId: insertRes.rows[0].id, name, cost }), -cost]
    );
    await client.query('COMMIT');
    return res.status(201).json({ id: insertRes.rows[0].id, moneyRemaining: debitRes.rows[0].money });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
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

// ── Workshop: replace the whole loadout of an existing vehicle ──────────────
// PATCH /api/vehicles/:id/loadout   body: VehicleLoadout
//
// Lets the garage workshop reuse the full vehicle-designer UI to modify any
// subsystem (body, power plant, suspension, tires, armor, mounts). The server
// validates the loadout via deriveStats, then compares the client-supplied
// totalCost to the vehicle's current value:
//
//   delta = newLoadout.totalCost - vehicle.value
//   charge: if delta > 0 → pay full delta
//           if delta < 0 → refund 50% of |delta|  (trade-in rate, matches
//                          single-weapon swap endpoint)
//
// Atomic: money debit/credit + loadout + value update all in one transaction,
// with gang_ledger logging. Forbidden while vehicle is in_arena.
vehiclesRouter.patch('/:id/loadout', async (req: AuthRequest, res) => {
  const newLoadout = req.body as VehicleLoadout;
  if (!newLoadout || typeof newLoadout !== 'object') {
    return res.status(400).json({ error: 'loadout body required' });
  }

  // Sanity-check the loadout runs through deriveStats without throwing
  try {
    deriveStats('workshop-preview', 'preview', newLoadout);
  } catch (e: any) {
    return res.status(400).json({ error: e.message ?? 'invalid loadout' });
  }

  // Capacity guard — workshop saves must leave the vehicle within its body's
  // spaces + weight budget. Existing over-capacity vehicles are readable but
  // can't be re-saved until brought into spec.
  const cap = computeCapacity(newLoadout);
  if (cap.overSpaces || cap.overWeight) {
    return res.status(400).json({ error: `Loadout exceeds body capacity — ${cap.errors.join('; ')}` });
  }

  const db = getDb();
  const vRes = await db.query(
    `SELECT id, value, in_arena FROM vehicles WHERE id = $1 AND player_id = $2`,
    [req.params.id, req.playerId]
  );
  if (!vRes.rows.length) return res.status(403).json({ error: 'Vehicle not found' });
  const row = vRes.rows[0];
  if (row.in_arena) return res.status(409).json({ error: 'Cannot modify a vehicle in an arena' });

  const newCost = Math.max(0, newLoadout.totalCost ?? 0);
  const oldCost = row.value;
  const delta = newCost - oldCost;
  const charge = delta > 0 ? delta : -Math.floor(Math.abs(delta) * 0.5);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (charge > 0) {
      const debit = await client.query(
        `UPDATE players SET money = money - $1 WHERE id = $2 AND money >= $1 RETURNING money`,
        [charge, req.playerId]
      );
      if (!debit.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Insufficient funds' });
      }
    } else if (charge < 0) {
      await client.query(`UPDATE players SET money = money + $1 WHERE id = $2`,
        [Math.abs(charge), req.playerId]);
    }
    await client.query(
      `UPDATE vehicles SET loadout = $1, value = $2 WHERE id = $3`,
      [JSON.stringify(newLoadout), newCost, row.id]
    );
    await client.query(
      `INSERT INTO gang_ledger (gang_id, event_type, amount, description, result)
       VALUES ((SELECT id FROM gangs WHERE owner_player_id = $1), 'workshop', $2, $3, $4)`,
      [req.playerId, -charge, 'Workshop: loadout modified',
       JSON.stringify({ vehicleId: row.id, oldCost, newCost, delta })]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  const me = await db.query(`SELECT money FROM players WHERE id = $1`, [req.playerId]);
  return res.json({
    ok: true,
    delta,
    charge,
    newValue: newCost,
    moneyRemaining: me.rows[0]?.money ?? 0,
  });
});

// ── Workshop: swap a weapon mount on an existing vehicle ────────────────────
// PATCH /api/vehicles/:id/weapon   body: { mountId, weaponId|null, ammo? }
//
// Pricing: cost of the NEW weapon (if any) + ammo × weapon.ammoCost
//          minus 50% trade-in of the OLD weapon + its remaining ammo.
// Atomic: either the money debit succeeds and loadout updates, or both roll back.
// Forbidden while the vehicle is in an arena.
vehiclesRouter.patch('/:id/weapon', async (req: AuthRequest, res) => {
  const { mountId, weaponId, ammo } = req.body ?? {};
  if (typeof mountId !== 'string') return res.status(400).json({ error: 'mountId required' });
  if (weaponId !== null && typeof weaponId !== 'string') return res.status(400).json({ error: 'weaponId must be string or null' });
  if (ammo !== undefined && (typeof ammo !== 'number' || ammo < 0)) return res.status(400).json({ error: 'ammo must be non-negative' });

  const db = getDb();
  const vRes = await db.query(
    `SELECT id, loadout, value, in_arena FROM vehicles WHERE id = $1 AND player_id = $2`,
    [req.params.id, req.playerId]
  );
  if (!vRes.rows.length) return res.status(403).json({ error: 'Vehicle not found' });
  const row = vRes.rows[0];
  if (row.in_arena) return res.status(409).json({ error: 'Cannot modify a vehicle in an arena' });

  const loadout = row.loadout as VehicleLoadout;
  const mountIndex = loadout.mounts.findIndex(m => m.id === mountId);
  if (mountIndex < 0) return res.status(400).json({ error: 'mountId not found on vehicle' });

  const oldMount: WeaponMount = loadout.mounts[mountIndex];
  const oldWeapon = oldMount.weaponId ? WEAPONS.find(w => w.id === oldMount.weaponId) : undefined;
  const newWeapon = weaponId ? WEAPONS.find(w => w.id === weaponId) : undefined;
  if (weaponId && !newWeapon) return res.status(400).json({ error: `Unknown weapon: ${weaponId}` });

  // Arc compatibility check: if the weapon restricts arcs, the mount's arc must be in the list
  if (newWeapon && newWeapon.allowedArcs.length > 0 && !newWeapon.allowedArcs.includes(oldMount.arc as any)) {
    return res.status(400).json({
      error: `${newWeapon.name} can only mount in arcs: ${newWeapon.allowedArcs.join(', ')}`
    });
  }

  const newAmmo = typeof ammo === 'number' ? ammo : (newWeapon ? newWeapon.shotsPerMag : 0);
  if (newWeapon && newAmmo > newWeapon.shotsPerMag) {
    return res.status(400).json({ error: `ammo exceeds mag capacity ${newWeapon.shotsPerMag}` });
  }

  // Costs
  const newCost = newWeapon ? newWeapon.cost + newWeapon.ammoCost * newAmmo : 0;
  const oldRefund = oldWeapon
    ? Math.floor((oldWeapon.cost + oldWeapon.ammoCost * oldMount.ammo) * WORKSHOP_TRADE_IN)
    : 0;
  const delta = newCost - oldRefund;  // positive = charge, negative = refund

  // Build updated loadout + new vehicle value
  const updatedMount: WeaponMount = {
    ...oldMount,
    weaponId: weaponId ?? '',
    ammo: newAmmo,
  };
  const updatedLoadout: VehicleLoadout = {
    ...loadout,
    mounts: [
      ...loadout.mounts.slice(0, mountIndex),
      updatedMount,
      ...loadout.mounts.slice(mountIndex + 1),
    ],
    totalCost: (loadout.totalCost ?? 0) + delta,
  };

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (delta > 0) {
      const debit = await client.query(
        `UPDATE players SET money = money - $1 WHERE id = $2 AND money >= $1 RETURNING money`,
        [delta, req.playerId]
      );
      if (!debit.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Insufficient funds' });
      }
    } else if (delta < 0) {
      await client.query(`UPDATE players SET money = money + $1 WHERE id = $2`,
        [Math.abs(delta), req.playerId]);
    }
    const newValue = Math.max(0, row.value + delta);
    await client.query(
      `UPDATE vehicles SET loadout = $1, value = $2 WHERE id = $3`,
      [JSON.stringify(updatedLoadout), newValue, row.id]
    );
    // Log both sides to gang_ledger via the linked gang (if any)
    const label = newWeapon
      ? `Workshop: install ${newWeapon.name}${oldWeapon ? ` (replacing ${oldWeapon.name})` : ''}`
      : `Workshop: remove ${oldWeapon?.name ?? 'weapon'}`;
    await client.query(
      `INSERT INTO gang_ledger (gang_id, event_type, amount, description, result)
       VALUES ((SELECT id FROM gangs WHERE owner_player_id = $1), 'workshop', $2, $3, $4)`,
      [req.playerId, -delta, label, JSON.stringify({ vehicleId: row.id, mountId, weaponId, ammo: newAmmo })]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  const me = await db.query(`SELECT money FROM players WHERE id = $1`, [req.playerId]);
  return res.json({
    ok: true,
    cost: delta,
    loadout: updatedLoadout,
    moneyRemaining: me.rows[0]?.money ?? 0,
  });
});
