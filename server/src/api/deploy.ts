import { Router } from 'express';
import { getDb } from '../db/client';
import { requireAuth, AuthRequest } from './middleware';
import { getRegion } from '../rules/world';
import type { WorldNode, WorldRegion } from '@carwars/shared';
import { resolveSquadEngagement, type SquadEngagementResult } from '../rules/squadEngagement';
import { pickRivalForMatch, recordRivalOutcome } from '../rules/rivals';

export const deployRouter = Router();

// ─── Phase 4 — Squad deployment ─────────────────────────────────────────────
// The player sends a squad (drivers + their vehicles) to a world node. The
// engagement runs HEADLESS: a deployment row is created with a resolves_at
// timer (travel + engagement time, real-time). Resolution is LAZY — it happens
// on the next API call, never during an arena match (anti-rabbit-hole rule 3) —
// via resolveDueDeployments(), which rolls rules/squadEngagement.ts and writes
// an after-action report into engagement_reports.

const REGION_ID = 'midville';
const SQUAD_CAP = 4;
const WOUND_RECOVERY_MINUTES = 3;
// Travel pacing: a short real-time delay prevents instant teleport-fighting.
const TRAVEL_SECONDS_PER_MILE = 2;
const FALLBACK_TRAVEL_MILES = 30; // when there is no direct road to the target
const ENGAGEMENT_SECONDS = 60;

const ASSIGNMENTS = ['patrol', 'job', 'raid'] as const;
type Assignment = (typeof ASSIGNMENTS)[number];
const ASSIGNMENT_PAYOUT_MULT: Record<Assignment, number> = { patrol: 0.8, job: 1.0, raid: 1.3 };

// Difficulty 1-10 for a node: a base by kind plus the danger of its roads.
export function zoneDifficulty(node: WorldNode, region: WorldRegion): number {
  const BASE: Record<WorldNode['kind'], number> = {
    city: 2, town: 3, truck_stop: 3, market: 2, garage: 1, arena: 6,
  };
  const touchingRoads = region.roads.filter(r => r.from === node.id || r.to === node.id);
  const maxDanger = touchingRoads.reduce((m, r) => Math.max(m, r.danger), 0);
  return clampInt(1, 10, Math.round((BASE[node.kind] ?? 3) + maxDanger * 4));
}

function basePayout(difficulty: number, assignment: Assignment): number {
  return Math.round((600 + difficulty * 120) * ASSIGNMENT_PAYOUT_MULT[assignment]);
}

// Real-time duration of a deployment in seconds: travel to the node + the fight.
function deploymentSeconds(fromNodeId: string, toNodeId: string, region: WorldRegion): number {
  const road = region.roads.find(
    r => (r.from === fromNodeId && r.to === toNodeId) || (r.from === toNodeId && r.to === fromNodeId),
  );
  const miles = road ? road.distance : FALLBACK_TRAVEL_MILES;
  return Math.round(miles * TRAVEL_SECONDS_PER_MILE) + ENGAGEMENT_SECONDS;
}

// POST /api/deploy — send a squad to a zone. Body: { zoneId, vehicleIds, assignment }
deployRouter.post('/', requireAuth, async (req: AuthRequest, res) => {
  const { zoneId, vehicleIds, assignment } = req.body ?? {};
  const asg: Assignment = ASSIGNMENTS.includes(assignment) ? assignment : 'patrol';

  if (!zoneId || typeof zoneId !== 'string') {
    return res.status(400).json({ error: 'zoneId required' });
  }
  if (!Array.isArray(vehicleIds) || vehicleIds.length === 0) {
    return res.status(400).json({ error: 'vehicleIds required' });
  }
  if (vehicleIds.length > SQUAD_CAP) {
    return res.status(400).json({ error: `A squad is at most ${SQUAD_CAP} vehicles` });
  }

  const region = getRegion(REGION_ID);
  if (!region) return res.status(500).json({ error: 'World region not found' });
  const toNode = region.nodes.find(n => n.id === zoneId);
  if (!toNode) return res.status(404).json({ error: `Zone '${zoneId}' not found` });

  const db = getDb();
  await resolveDueDeployments(req.playerId!);

  const gangRes = await db.query(
    `SELECT id, current_world_node_id FROM gangs WHERE owner_player_id = $1`,
    [req.playerId],
  );
  if (!gangRes.rows.length) return res.status(404).json({ error: 'Gang not found' });
  const fromNodeId = gangRes.rows[0].current_world_node_id;

  // Vehicles must be owned, intact, and not already out on a deployment.
  const vRes = await db.query(
    `SELECT id FROM vehicles
       WHERE id = ANY($1::uuid[]) AND player_id = $2
         AND COALESCE((damage_state->>'destroyed')::boolean, false) = false
         AND in_arena = false`,
    [vehicleIds, req.playerId],
  );
  if (vRes.rows.length !== vehicleIds.length) {
    return res.status(403).json({ error: 'One or more vehicles are unavailable or not owned' });
  }

  const busyRes = await db.query(
    `SELECT 1 FROM squad_deployments
       WHERE player_id = $1 AND status = 'in_transit' AND vehicle_ids && $2::uuid[] LIMIT 1`,
    [req.playerId, vehicleIds],
  );
  if (busyRes.rows.length) {
    return res.status(409).json({ error: 'A selected vehicle is already deployed' });
  }

  // Drivers crewing those vehicles must be alive and available now.
  const dRes = await db.query(
    `SELECT id FROM drivers
       WHERE assigned_vehicle_id = ANY($1::uuid[]) AND player_id = $2
         AND alive = true AND COALESCE(available_at, NOW()) <= NOW()`,
    [vehicleIds, req.playerId],
  );
  if (dRes.rows.length === 0) {
    return res.status(409).json({ error: 'No available crew for the selected vehicles' });
  }
  const driverIds: string[] = dRes.rows.map(r => r.id);

  const seconds = deploymentSeconds(fromNodeId, zoneId, region);

  const ins = await db.query(
    `INSERT INTO squad_deployments (player_id, zone_id, assignment, driver_ids, vehicle_ids, resolves_at)
     VALUES ($1, $2, $3, $4::uuid[], $5::uuid[], NOW() + ($6 || ' seconds')::interval)
     RETURNING id, resolves_at`,
    [req.playerId, zoneId, asg, driverIds, vehicleIds, String(seconds)],
  );

  // Sideline the crew until the squad returns.
  await db.query(
    `UPDATE drivers SET available_at = $2 WHERE id = ANY($1::uuid[])`,
    [driverIds, ins.rows[0].resolves_at],
  );

  return res.status(201).json({
    deploymentId: ins.rows[0].id,
    zoneId,
    assignment: asg,
    etaSeconds: seconds,
    resolvesAt: ins.rows[0].resolves_at,
  });
});

// GET /api/deploy — active + recently-resolved deployments for this player.
deployRouter.get('/', requireAuth, async (req: AuthRequest, res) => {
  await resolveDueDeployments(req.playerId!);
  const db = getDb();
  const result = await db.query(
    `SELECT id, zone_id, assignment, status, resolves_at, report_id,
            GREATEST(0, CEIL(EXTRACT(EPOCH FROM (resolves_at - NOW()))))::int AS eta_seconds
       FROM squad_deployments
       WHERE player_id = $1
       ORDER BY created_at DESC LIMIT 20`,
    [req.playerId],
  );
  return res.json(result.rows);
});

// Resolve any of this player's deployments whose timer has expired. Idempotent
// and safe to call from multiple endpoints (mirrors resolveDueHeadlessJobs).
export async function resolveDueDeployments(playerId: string): Promise<void> {
  const db = getDb();
  const due = await db.query(
    `SELECT id, zone_id, assignment, driver_ids, vehicle_ids
       FROM squad_deployments
       WHERE player_id = $1 AND status = 'in_transit' AND resolves_at <= NOW()`,
    [playerId],
  );
  if (!due.rows.length) return;

  const region = getRegion(REGION_ID);
  if (!region) return;

  const gangRes = await db.query(
    `SELECT g.id AS gang_id, p.division
       FROM gangs g JOIN players p ON p.id = g.owner_player_id
       WHERE g.owner_player_id = $1`,
    [playerId],
  );
  const gangId: string | null = gangRes.rows[0]?.gang_id ?? null;
  const division: number = gangRes.rows[0]?.division ?? 5;

  for (const dep of due.rows) {
    const node = region.nodes.find(n => n.id === dep.zone_id);
    if (!node) continue;

    const driverRows = await db.query(
      `SELECT id, name, skill FROM drivers WHERE id = ANY($1::uuid[])`,
      [dep.driver_ids],
    );
    const vehicleRows = await db.query(
      `SELECT id, name, value FROM vehicles WHERE id = ANY($1::uuid[])`,
      [dep.vehicle_ids],
    );

    const difficulty = zoneDifficulty(node, region);
    const assignment: Assignment = ASSIGNMENTS.includes(dep.assignment) ? dep.assignment : 'patrol';

    // Engage a rival when the stakes are high: an arena node, a tough zone, or
    // a raid. Otherwise the squad clashes with anonymous NPC scavengers.
    let rival: { id: string; name: string } | undefined;
    const wantRival = node.kind === 'arena' || difficulty >= 6 || assignment === 'raid';
    if (wantRival && gangId) {
      const picked = await pickRivalForMatch(db, gangId, division);
      if (picked) rival = { id: picked.id, name: picked.name };
    }

    const result = resolveSquadEngagement({
      squad: driverRows.rows.map(r => ({ id: r.id, name: r.name, skill: r.skill })),
      vehicles: vehicleRows.rows.map(r => ({ id: r.id, name: r.name, value: r.value })),
      zoneDifficulty: difficulty,
      assignment,
      basePayout: basePayout(difficulty, assignment),
      rival,
    });

    const encounter = rival
      ? `${rival.name} ${node.kind === 'arena' ? 'in the arena' : 'patrol'}`
      : `${node.kind === 'arena' ? 'arena challengers' : 'roadside scavengers'} near ${node.name}`;

    const report = {
      zone: dep.zone_id,
      zoneName: node.name,
      assignment,
      encounter,
      summary: buildSummary(result, node, encounter),
      perDriver: result.perDriver,
      vehicles: result.vehicles,
      income: result.income,
      repairCost: result.repairCost,
      net: result.net,
      rivalRepChange: result.rivalRepChange ?? null,
      breakdown: result.breakdown,
    };

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Claim this deployment atomically. resolveDueDeployments runs from
      // several endpoints (and several can fire concurrently in one page load),
      // so without this a deployment could be resolved twice — double payout +
      // duplicate report. SKIP LOCKED lets a rival caller bow out cleanly.
      const claim = await client.query(
        `SELECT id FROM squad_deployments WHERE id = $1 AND status = 'in_transit' FOR UPDATE SKIP LOCKED`,
        [dep.id],
      );
      if (!claim.rows.length) { await client.query('ROLLBACK'); continue; }

      // Money: credit income, debit field repairs (net effect = report.net).
      if (result.income !== 0 || result.repairCost !== 0) {
        await client.query(`UPDATE players SET money = GREATEST(0, money + $1) WHERE id = $2`, [result.net, playerId]);
      }

      // Vehicles: a wreck is destroyed; lesser damage chips the front armour face
      // (feeding the existing repair economy), proportional to the repair bill.
      for (const v of result.vehicles) {
        if (v.damage === 'wrecked') {
          await client.query(
            `UPDATE vehicles SET damage_state = jsonb_set(COALESCE(damage_state, '{}'::jsonb), '{destroyed}', 'true') WHERE id = $1`,
            [v.vehicleId],
          );
        } else if (v.repairCost > 0) {
          const wear = Math.max(1, Math.round(v.repairCost / 150));
          await client.query(
            `UPDATE vehicles
               SET damage_state = jsonb_set(
                 damage_state, '{armor,front}',
                 to_jsonb(GREATEST(0, COALESCE((damage_state->'armor'->>'front')::int, 0) - $2)))
             WHERE id = $1 AND damage_state ? 'armor'`,
            [v.vehicleId, wear],
          );
        }
      }

      // Drivers: dead, wounded (sidelined to recover), or freed to act again.
      for (const d of result.perDriver) {
        if (d.status === 'dead') {
          await client.query(`UPDATE drivers SET alive = FALSE, available_at = NOW() WHERE id = $1`, [d.driverId]);
        } else if (d.status === 'wounded') {
          await client.query(
            `UPDATE drivers SET wounded = TRUE, wounded_until = NOW() + ($2 || ' minutes')::interval, available_at = NOW() WHERE id = $1`,
            [d.driverId, String(WOUND_RECOVERY_MINUTES)],
          );
        } else {
          await client.query(`UPDATE drivers SET available_at = NOW() WHERE id = $1`, [d.driverId]);
        }
      }

      // Rival standing.
      if (rival && gangId) {
        const playerPrevailed = result.outcome === 'success' || result.outcome === 'partial';
        await recordRivalOutcome(db, gangId, rival.id, playerPrevailed);
      }

      const repIns = await client.query(
        `INSERT INTO engagement_reports (player_id, zone_id, squad_driver_ids, squad_vehicle_ids, outcome, report)
         VALUES ($1, $2, $3::uuid[], $4::uuid[], $5, $6) RETURNING id`,
        [playerId, dep.zone_id, dep.driver_ids, dep.vehicle_ids, result.outcome, JSON.stringify(report)],
      );

      await client.query(
        `UPDATE squad_deployments SET status = 'resolved', report_id = $2 WHERE id = $1`,
        [dep.id, repIns.rows[0].id],
      );

      if (gangId) {
        await client.query(
          `INSERT INTO gang_ledger (gang_id, event_type, amount, description, result)
           VALUES ($1, 'squad_deployment', $2, $3, $4)`,
          [
            gangId, result.net,
            `Squad ${assignment} (${result.outcome}) at ${node.name}`,
            JSON.stringify({ deploymentId: dep.id, reportId: repIns.rows[0].id, zoneId: dep.zone_id }),
          ],
        );
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}

function buildSummary(result: SquadEngagementResult, node: WorldNode, encounter: string): string {
  const kills = result.perDriver.reduce((s, d) => s + d.kills, 0);
  switch (result.outcome) {
    case 'success':
      return `Your squad routed the ${encounter} near ${node.name}, scoring ${kills} kill(s) and returning with the haul intact.`;
    case 'partial':
      return `A messy win against the ${encounter} near ${node.name} — the squad held the field but took damage and salvaged only part of the prize.`;
    case 'failure':
      return `The squad was beaten back by the ${encounter} near ${node.name} and limped home with nothing but a repair bill.`;
    case 'routed':
      return `Disaster near ${node.name}: the ${encounter} overran your squad. A vehicle was wrecked and the crew scattered.`;
  }
}

function clampInt(lo: number, hi: number, x: number): number {
  return Math.max(lo, Math.min(hi, Math.round(x)));
}
