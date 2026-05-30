import { Router } from 'express';
import { getDb } from '../db/client';
import { requireAuth, AuthRequest } from './middleware';
import { WEAPONS } from '../rules/data/weapons';
import { BODIES } from '../rules/data/bodies';
import { TIRES } from '../rules/data/tires';
import { POWER_PLANTS } from '../rules/data/power-plants';
import type { VehicleLoadout, DamageState, ArmorDistribution } from '@carwars/shared';
import { resolveDueDeployments } from './deploy';

export const economyRouter = Router();
economyRouter.use(requireAuth);

// Per Compendium 2E (Repair table):
//   Armor  → 50% of install per point   (patching, not replacing)
//   Engine → 50% of engine cost         (already modelled below)
//   Tires  → 100% of install per tire   (blown tires are REPLACED, not patched)
// Previously armor was charged at full install cost, which made a Div 5 win
// barely cover repair on its own car — the Compendium half-rate is what
// restores the break-even between winnings and repair bills.

// Base build multiplier per armor type (same as the install table)
const ARMOR_BUILD_MUL: Record<string, number> = {
  ablative: 1, metal: 1, fireproof: 2, laser_reflective: 2, lr_fireproof: 4, radarproof: 2,
};
// Compendium repair rate — patching armor is 50% of install cost
const ARMOR_REPAIR_FRACTION = 0.5;

// Floor for engine repair when no power-plant cost data is available
const ENGINE_REPAIR_FALLBACK = 500;
// Floor for tire repair when no tire-cost data is available
const TIRE_REPAIR_FALLBACK   = 50;

// Repair part ids supported by the partial-repair flow
type RepairPart = 'armor' | 'tires' | 'engine' | 'ammo';
const ALL_PARTS: RepairPart[] = ['armor', 'tires', 'engine', 'ammo'];

interface RepairQuote {
  armor: { pts: number; cost: number };
  tires: { count: number; cost: number; eachCost: number };
  engine: { damaged: boolean; cost: number };
  ammo: { rounds: number; cost: number; byMount: Array<{ mountId: string; weaponId: string | null; shortage: number; cost: number }> };
  total: number;
}

// Pure function — compute the breakdown without touching the DB.
function computeRepairQuote(loadout: VehicleLoadout, origLoadout: VehicleLoadout, damage: DamageState): RepairQuote {
  const armorMul = ARMOR_BUILD_MUL[origLoadout.armorType ?? 'ablative'] ?? 1;
  const body = BODIES.find(b => b.id === origLoadout.bodyType);
  const armorCostPerPt = body?.armorCostPerPt ?? 10;

  let armorPts = 0;
  const locations: (keyof ArmorDistribution)[] = ['front', 'back', 'left', 'right', 'top', 'underbody'];
  for (const loc of locations) {
    const deficit = (origLoadout.armor[loc] ?? 0) - (damage.armor[loc] ?? 0);
    if (deficit > 0) armorPts += deficit;
  }
  // Armor repair = 50% of install cost per point (Compendium Repair table)
  const armorCost = Math.round(armorPts * armorCostPerPt * armorMul * ARMOR_REPAIR_FRACTION);

  const tireCount = damage.tiresBlown?.length ?? 0;
  const tire = TIRES.find(t => t.id === origLoadout.tireType);
  const tireEach = tire?.costPerTire ?? TIRE_REPAIR_FALLBACK;
  const tireCost = tireCount * tireEach;

  const plant = POWER_PLANTS.find(p => p.id === origLoadout.powerPlantType);
  const engineCost = damage.engineDamaged ? Math.round((plant?.cost ?? ENGINE_REPAIR_FALLBACK) / 2) : 0;

  const byMount: Array<{ mountId: string; weaponId: string | null; shortage: number; cost: number }> = [];
  let ammoRounds = 0, ammoCost = 0;
  for (const origMount of origLoadout.mounts ?? []) {
    const curMount = loadout.mounts?.find(m => m.id === origMount.id);
    if (!curMount) continue; const shortage = origMount.ammo - curMount.ammo;
    if (shortage <= 0) continue;
    const weaponDef = WEAPONS.find(w => w.id === origMount.weaponId);
    if (!weaponDef) continue;
    const cost = shortage * weaponDef.ammoCost;
    byMount.push({ mountId: origMount.id, weaponId: origMount.weaponId, shortage, cost });
    ammoRounds += shortage;
    ammoCost   += cost;
  }

  return {
    armor:  { pts: armorPts, cost: armorCost },
    tires:  { count: tireCount, cost: tireCost, eachCost: tireEach },
    engine: { damaged: !!damage.engineDamaged, cost: engineCost },
    ammo:   { rounds: ammoRounds, cost: ammoCost, byMount },
    total:  armorCost + tireCost + engineCost + ammoCost,
  };
}

// GET /api/economy/repair/quote?vehicleId=X — itemised cost, no DB mutation
economyRouter.get('/repair/quote', async (req: AuthRequest, res) => {
  const vehicleId = req.query.vehicleId;
  if (!vehicleId || typeof vehicleId !== 'string') return res.status(400).json({ error: 'vehicleId required' });
  const db = getDb();
  const [vResult, gResult] = await Promise.all([
    db.query(
      `SELECT id, loadout, original_loadout, damage_state
       FROM vehicles WHERE id = $1 AND player_id = $2`,
      [vehicleId, req.playerId],
    ),
    db.query(`SELECT repair_discount FROM garages WHERE player_id = $1`, [req.playerId]),
  ]);
  if (!vResult.rows.length) return res.status(403).json({ error: 'Vehicle not found' });
  const loadout     = vResult.rows[0].loadout as VehicleLoadout;
  const origLoadout = (vResult.rows[0].original_loadout ?? loadout) as VehicleLoadout;
  const damage      = vResult.rows[0].damage_state as DamageState;
  const discount    = gResult.rows.length ? Number(gResult.rows[0].repair_discount) : 0;
  const quote = computeRepairQuote(loadout, origLoadout, damage);
  // Per-part costs stay at full rate; the garage discount applies to the bill.
  return res.json({ ...quote, repairDiscount: discount, discountedTotal: Math.round(quote.total * (1 - discount)) });
});

economyRouter.post('/repair', async (req: AuthRequest, res) => {
  const { vehicleId } = req.body;
  // Optional `parts` filter — repair only the named categories. Defaults to
  // everything. Invalid ids are ignored.
  const parts: RepairPart[] = Array.isArray(req.body.parts) && req.body.parts.length
    ? req.body.parts.filter((p: string): p is RepairPart => (ALL_PARTS as string[]).includes(p))
    : ALL_PARTS.slice();
  if (!vehicleId) return res.status(400).json({ error: 'vehicleId required' });

  const db = getDb();
  const [vResult, pResult, gResult] = await Promise.all([
    db.query(
      `SELECT id, loadout, original_loadout, damage_state, player_id
       FROM vehicles WHERE id = $1 AND player_id = $2`,
      [vehicleId, req.playerId]
    ),
    db.query(`SELECT money FROM players WHERE id = $1`, [req.playerId]),
    db.query(`SELECT repair_discount FROM garages WHERE player_id = $1`, [req.playerId])
  ]);

  if (!vResult.rows.length) return res.status(403).json({ error: 'Vehicle not found' });

  const vehicle      = vResult.rows[0];
  const loadout      = vehicle.loadout as VehicleLoadout;
  const origLoadout  = (vehicle.original_loadout ?? loadout) as VehicleLoadout;
  const damage       = vehicle.damage_state as DamageState;
  const playerMoney  = pResult.rows[0].money as number;
  // Garage owners get a repair discount applied to the final bill.
  const discount     = gResult.rows.length ? Number(gResult.rows[0].repair_discount) : 0;

  const quote = computeRepairQuote(loadout, origLoadout, damage);
  const doArmor  = parts.includes('armor');
  const doTires  = parts.includes('tires');
  const doEngine = parts.includes('engine');
  const doAmmo   = parts.includes('ammo');
  const grossCost = (doArmor ? quote.armor.cost : 0)
             + (doTires ? quote.tires.cost : 0)
             + (doEngine ? quote.engine.cost : 0)
             + (doAmmo  ? quote.ammo.cost   : 0);
  const cost = Math.round(grossCost * (1 - discount));

  // Allow zero-cost repairs (e.g. free-ammo weapons like lasers/grenades) to
  // proceed to the DB update. Only skip when there is genuinely nothing to do.
  const hasWork =
    (doArmor && quote.armor.pts > 0) ||
    (doTires && quote.tires.count > 0) ||
    (doEngine && quote.engine.damaged) ||
    (doAmmo && quote.ammo.rounds > 0);
  if (!hasWork) return res.json({ cost: 0, moneyRemaining: playerMoney, parts });
  if (playerMoney < cost) return res.status(402).json({ error: 'Insufficient funds', cost });

  // Build repaired states — each part only if it's in the filter
  const repairedDamage: DamageState = {
    ...damage,
    armor: doArmor ? { ...origLoadout.armor } : { ...damage.armor },
    engineDamaged: doEngine ? false : damage.engineDamaged,
    tiresBlown:    doTires  ? []    : damage.tiresBlown,
    destroyed: false,
  };
  const restoredMounts = (loadout.mounts ?? []).map(m => {
    if (!doAmmo) return m;
    const orig = (origLoadout.mounts ?? []).find(om => om.id === m.id);
    return orig ? { ...m, ammo: orig.ammo } : m;
  });
  const restoredLoadout: VehicleLoadout = { ...loadout, mounts: restoredMounts };

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE vehicles SET damage_state = $1, loadout = $2 WHERE id = $3`,
      [JSON.stringify(repairedDamage), JSON.stringify(restoredLoadout), vehicleId]
    );
    await client.query(
      `UPDATE players SET money = money - $1 WHERE id = $2`,
      [cost, req.playerId]
    );
    await client.query(
      `INSERT INTO event_history (player_id, event_type, result, money_delta)
       VALUES ($1, 'repair', $2, $3)`,
      [req.playerId, JSON.stringify({ vehicleId, cost, parts }), -cost]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  return res.json({ cost, moneyRemaining: playerMoney - cost, parts });
});

economyRouter.post('/prize', async (req: AuthRequest, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Not available' });
  }

  const { amount, eventType, zoneId } = req.body;
  const MAX_PRIZE = 50_000;
  if (!amount || typeof amount !== 'number' || amount <= 0 || amount > MAX_PRIZE) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const db = getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE players SET money = money + $1 WHERE id = $2`, [amount, req.playerId]);
    await client.query(
      `UPDATE players SET reputation = reputation + $1 WHERE id = $2`,
      [Math.floor(amount / 500), req.playerId]
    );
    await client.query(
      `INSERT INTO event_history (player_id, event_type, result, money_delta) VALUES ($1, $2, $3, $4)`,
      [req.playerId, eventType ?? 'prize', JSON.stringify({ zoneId }), amount]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  const pResult = await db.query(`SELECT money FROM players WHERE id = $1`, [req.playerId]);
  return res.json({ moneyNew: pResult.rows[0].money });
});

// ── Jobs ─────────────────────────────────────────────────────────────────────

export const jobsRouter = Router();
jobsRouter.use(requireAuth);

// ─── Phase 2 — Headless jobs ───────────────────────────────────────────────
// Headless jobs are the available-contract board for a zone. As of Phase 5 they
// are run by sending a squad (POST /:id/deploy) and resolve through the squad
// engine (resolveDueDeployments) into engagement_reports — the old single-driver
// contract path has been retired. Payouts stay smaller than arena fights
// (balance target $200-600) so arena stays the lucrative option.

const HEADLESS_JOBS: Record<string, { job_type: string; description: string; payout: number; difficulty: number; division_min: number }[]> = {
  'town-1': [
    { job_type: 'patrol',   description: 'Patrol the eastern checkpoints overnight', payout: 250, difficulty: 2, division_min: 5 },
    { job_type: 'scavenge', description: 'Strip a wreck on Route 9 for salvage',      payout: 400, difficulty: 4, division_min: 5 },
    { job_type: 'enforce',  description: 'Lean on a debtor who skipped a payment',    payout: 600, difficulty: 7, division_min: 5 },
  ],
};

// GET /api/jobs/headless?zoneId= — available headless jobs for a zone. Seeds the
// zone pool on first visit (like the arena job board) and resolves any due jobs.
jobsRouter.get('/headless', async (req: AuthRequest, res) => {
  await resolveDueDeployments(req.playerId!);
  const zoneId = (req.query.zoneId as string) || 'town-1';
  const db = getDb();
  const pResult = await db.query(`SELECT division FROM players WHERE id = $1`, [req.playerId]);
  const playerDiv = pResult.rows[0]?.division ?? 5;

  const existing = await db.query(
    `SELECT id FROM jobs WHERE zone_id = $1 AND headless = TRUE AND assigned_driver_id IS NULL AND completed = FALSE LIMIT 1`,
    [zoneId],
  );
  if (!existing.rows.length && HEADLESS_JOBS[zoneId]) {
    for (const j of HEADLESS_JOBS[zoneId]) {
      await db.query(
        `INSERT INTO jobs (zone_id, job_type, description, payout, division_min, headless, difficulty)
         VALUES ($1,$2,$3,$4,$5,TRUE,$6)`,
        [zoneId, j.job_type, j.description, j.payout, j.division_min, j.difficulty],
      );
    }
  }

  const rows = (await db.query(
    `SELECT id, job_type, description, payout, difficulty, division_min
     FROM jobs WHERE zone_id = $1 AND headless = TRUE AND assigned_driver_id IS NULL
       AND completed = FALSE AND division_min <= $2
     ORDER BY difficulty`,
    [zoneId, playerDiv],
  )).rows;
  return res.json(rows);
});

// GET /api/jobs/active — this player's in-progress job deployments (squad out,
// not yet resolved). Used by the Contracts "in progress" section. Job progress
// now lives in squad_deployments (Phase 5), so resolve due deployments first.
jobsRouter.get('/active', async (req: AuthRequest, res) => {
  await resolveDueDeployments(req.playerId!);
  const db = getDb();
  const rows = (await db.query(
    `SELECT sd.id AS deployment_id, j.id AS job_id, j.job_type, j.description, j.payout,
            sd.vehicle_ids,
            GREATEST(0, CEIL(EXTRACT(EPOCH FROM (sd.resolves_at - NOW()))))::int AS remaining_seconds
       FROM squad_deployments sd JOIN jobs j ON j.id = sd.job_id
      WHERE sd.player_id = $1 AND sd.status = 'in_transit'
      ORDER BY sd.resolves_at ASC`,
    [req.playerId])).rows;
  return res.json(rows.map(r => ({
    id: r.deployment_id, jobId: r.job_id, jobType: r.job_type, description: r.description,
    payout: r.payout, vehicleCount: (r.vehicle_ids ?? []).length, remainingSeconds: r.remaining_seconds,
  })));
});

// ─── Phase 5 — send a squad to a job ───────────────────────────────────────
// Commit 1–4 vehicles (with their assigned crew) to a job. Creates a job-linked
// squad_deployments row, sidelines the crew, and the vehicles then show as
// `deployed` on /api/vehicles. Task 2's resolveDueDeployments resolves the
// job-linked row and marks the job completed when the timer expires.
const JOB_SQUAD_CAP = 4;
function jobDeploymentSeconds(difficulty: number): number { return 120 + difficulty * 30; }

jobsRouter.post('/:id/deploy', async (req: AuthRequest, res) => {
  const { id } = req.params;
  const vehicleIds = req.body?.vehicleIds;
  if (!Array.isArray(vehicleIds) || !vehicleIds.length) return res.status(400).json({ error: 'vehicleIds required' });
  if (vehicleIds.length > JOB_SQUAD_CAP) return res.status(400).json({ error: `A squad is at most ${JOB_SQUAD_CAP} vehicles` });
  const db = getDb();
  await resolveDueDeployments(req.playerId!);

  const jr = (await db.query(`SELECT id, difficulty, completed FROM jobs WHERE id = $1`, [id])).rows[0];
  if (!jr) return res.status(404).json({ error: 'Job not found' });
  if (jr.completed) return res.status(409).json({ error: 'Job already completed' });
  const existing = await db.query(`SELECT 1 FROM squad_deployments WHERE job_id = $1 AND status = 'in_transit' LIMIT 1`, [id]);
  if (existing.rows.length) return res.status(409).json({ error: 'Job already has a squad out' });

  const vRes = await db.query(
    `SELECT id FROM vehicles WHERE id = ANY($1::uuid[]) AND player_id = $2
       AND COALESCE((damage_state->>'destroyed')::boolean,false)=false AND in_arena=false`,
    [vehicleIds, req.playerId]);
  if (vRes.rows.length !== vehicleIds.length) return res.status(403).json({ error: 'One or more vehicles are unavailable or not owned' });

  const busy = await db.query(`SELECT 1 FROM squad_deployments WHERE player_id=$1 AND status='in_transit' AND vehicle_ids && $2::uuid[] LIMIT 1`, [req.playerId, vehicleIds]);
  if (busy.rows.length) return res.status(409).json({ error: 'A selected vehicle is already deployed' });

  const dRes = await db.query(
    `SELECT id FROM drivers WHERE assigned_vehicle_id = ANY($1::uuid[]) AND player_id = $2
       AND alive = true AND COALESCE(available_at, NOW()) <= NOW()`,
    [vehicleIds, req.playerId]);
  if (!dRes.rows.length) return res.status(409).json({ error: 'No available crew for the selected vehicles' });
  const driverIds = dRes.rows.map(r => r.id);

  const seconds = jobDeploymentSeconds(jr.difficulty);
  const ins = await db.query(
    `INSERT INTO squad_deployments (player_id, job_id, assignment, driver_ids, vehicle_ids, resolves_at)
     VALUES ($1,$2,'job',$3::uuid[],$4::uuid[], NOW() + ($5 || ' seconds')::interval) RETURNING id, resolves_at`,
    [req.playerId, id, driverIds, vehicleIds, String(seconds)]);
  await db.query(`UPDATE drivers SET available_at = $2 WHERE id = ANY($1::uuid[])`, [driverIds, ins.rows[0].resolves_at]);
  await db.query(`UPDATE jobs SET assigned_driver_id = $2 WHERE id = $1`, [id, driverIds[0]]);

  return res.status(201).json({ deploymentId: ins.rows[0].id, etaSeconds: seconds, resolvesAt: ins.rows[0].resolves_at });
});
