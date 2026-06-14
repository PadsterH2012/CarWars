import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import jwt from 'jsonwebtoken';
import type { ClientMessage, ServerMessage, VehicleState, VehicleLoadout, DamageState, RivalInfo } from '@carwars/shared';
import { ZoneRunner } from '../world/zone-runner';
import { getDb } from '../db/client';
import { deriveStats } from '../rules/vehicle';
import type { Pool } from 'pg';
import { pickRivalForMatch, pickGeneratedRivalForMatch, recordRivalOutcome, rivalEffectiveSkill, adaptGeneratedGang, rivalSignatureLineup, rivalLineupForDivision, fieldedStockIds, type RivalGang } from '../rules/rivals';
import { sidePower, calcMatchPrize, NOMINAL_RIVAL_VEHICLE_VALUE } from '../rules/power';
import type { GeneratedGang } from '../rules/gangGen';
import { playerOwnsGarage } from '../api/garages';
import type { TickSnapshot } from '../rules/engine';

// Best-effort replay persistence — returns the new row's id, or undefined on
// any failure (snapshots empty, player missing, DB error). Match payout path
// never blocks on this.
async function persistReplay(opts: {
  db: Pool;
  playerId: string | undefined;
  zoneId: string;
  opponent: string | null;
  result: 'win' | 'loss' | 'draw' | 'destroyed';
  prize: number;
  winnerId: string | null;
  snapshots: TickSnapshot[];
}): Promise<string | undefined> {
  if (!opts.playerId || opts.snapshots.length === 0) return undefined;
  try {
    const finalSnapshot = opts.snapshots[opts.snapshots.length - 1];
    finalSnapshot.winnerId = opts.winnerId;
    const res = await opts.db.query<{ id: string }>(
      `INSERT INTO match_replays (player_id, zone_id, opponent, duration_ticks, result, prize, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [opts.playerId, opts.zoneId, opts.opponent, opts.snapshots.length, opts.result, opts.prize, JSON.stringify(opts.snapshots)],
    );
    return res.rows[0]?.id;
  } catch (e) {
    console.error('Failed to save replay:', e);
    return undefined;
  }
}

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-prod';

function skillToMaxSteer(skill: number): number {
  if (skill <= 2) return 15;
  if (skill <= 4) return 21;
  return 30;
}

// Legacy division-based purse. Superseded for live matches by the power-gap
// model in rules/power.ts (calcMatchPrize) — retained for the unit tests and
// as a simple reference formula.
export function calcPrize(division: number, squadSize: number = 1): number {
  // Base purse scales by division; squad multiplier rewards bigger fights.
  // 1v1 → 1.0×, 2v2 → 1.5×, 3v3 → 2.0×, 4v4 → 2.5×
  const squadMul = 1 + (Math.max(1, Math.min(4, squadSize)) - 1) * 0.5;
  return Math.round(division * 500 * squadMul);
}

async function loadVehicleFromDb(vehicleId: string, token: string): Promise<{ vehicle: VehicleState; playerId: string } | null> {
  let playerId: string;
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { playerId: string };
    playerId = payload.playerId;
  } catch {
    return null;
  }

  const db = getDb();
  const result = await db.query(
    `SELECT id, name, loadout, damage_state FROM vehicles WHERE id = $1 AND player_id = $2`,
    [vehicleId, playerId]
  );
  if (!result.rows.length) return null;

  const row = result.rows[0];
  const loadout = row.loadout as VehicleLoadout;
  const damageState = row.damage_state as DamageState;
  const stats = deriveStats(row.id, row.name, loadout);
  // Sanitize onFire from previous match
      const sanitizedDmg = { ...damageState, onFire: false };
      stats.damageState = sanitizedDmg;

  return {
    vehicle: {
      id: row.id,
      playerId,
      driverId: '',
      position: { x: -40, y: 40 },
      facing: 45, // SW corner, facing NE toward arena center
      speed: 0,
      stats
    },
    playerId,
  };
}

function makeTestVehicle(id: string, playerId: string, x: number, y: number, facing = 0, maxSpeed = 15): VehicleState {
  return {
    id, playerId, driverId: `driver_${id}`,
    position: { x, y }, facing, speed: 0,
    stats: {
      id, name: id,
      loadout: {
        chassisId: 'mid', engineId: 'medium', suspensionId: 'standard',
        tires: [{ id: 't0', blown: false }, { id: 't1', blown: false },
                { id: 't2', blown: false }, { id: 't3', blown: false }],
        mounts: [{ id: 'm0', arc: 'front', weaponId: 'mg', ammo: 200 }],
        armor: { front: 6, back: 4, left: 4, right: 4, top: 2, underbody: 2 },
        totalCost: 12000
      },
      damageState: {
        armor: { front: 6, back: 4, left: 4, right: 4, top: 2, underbody: 2 },
        engineDamaged: false, driverWounded: false, tiresBlown: [], destroyed: false
      },
      maxSpeed, handlingClass: 3, weight: 3000
    }
  };
}

// Build an arena vehicle from a stock blueprint — pass through deriveStats so
// maxSpeed / HC / weight are properly derived from the loadout, and clone the
// armor into damageState so hits apply to a fresh copy. Used to spawn rival
// enemies that actually field their published designs.
function makeVehicleFromLoadout(
  id: string, playerId: string, x: number, y: number, facing: number,
  name: string, loadout: VehicleLoadout,
): VehicleState {
  const stats = deriveStats(id, name, loadout);
  return {
    id, playerId, driverId: `driver_${id}`,
    position: { x, y }, facing, speed: 0,
    stats,
  };
}

async function fetchStockLoadouts(db: Pool, stockIds: string[]): Promise<Map<string, { name: string; loadout: VehicleLoadout }>> {
  const out = new Map<string, { name: string; loadout: VehicleLoadout }>();
  if (!stockIds.length) return out;
  const res = await db.query<{ id: string; name: string; loadout: VehicleLoadout }>(
    `SELECT id, name, loadout FROM stock_vehicles WHERE id = ANY($1::text[])`,
    [stockIds],
  );
  for (const r of res.rows) out.set(r.id, { name: r.name, loadout: r.loadout });
  return out;
}

// Load a vehicle for a known playerId (used for squadmates after the primary is auth'd).
// Returns null if the vehicle doesn't belong to this player or doesn't exist.
async function loadVehicleForPlayer(vehicleId: string, playerId: string): Promise<VehicleState | null> {
  const db = getDb();
  const result = await db.query(
    `SELECT id, name, loadout, damage_state, in_arena FROM vehicles WHERE id = $1 AND player_id = $2`,
    [vehicleId, playerId]
  );
  if (!result.rows.length) return null;
  const row = result.rows[0];
  const loadout = row.loadout as VehicleLoadout;
  const damageState = row.damage_state as DamageState;
  const stats = deriveStats(row.id, row.name, loadout);
  // Sanitize onFire from previous match
      const sanitizedDmg = { ...damageState, onFire: false };
      stats.damageState = sanitizedDmg;
  return {
    id: row.id, playerId, driverId: '',
    position: { x: 0, y: 0 }, facing: 0, speed: 0,
    stats,
  };
}

// Given a base spawn point, produce N spawn positions clustered around it so that
// squads/enemies larger than the map's authored spawn count still fit. Arranged in
// a line perpendicular to the base's facing, centred on the base.
function clusterSpawnPositions(
  base: { x: number; y: number; facing: number },
  count: number,
): { x: number; y: number; facing: number }[] {
  if (count <= 1) return [{ x: base.x, y: base.y, facing: base.facing }];
  // Perpendicular direction to facing (facing is game-heading 0=north, 90=east)
  const rad = (base.facing) * Math.PI / 180;
  const perpX = Math.cos(rad), perpY = Math.sin(rad);
  const spacing = 3;
  const result: { x: number; y: number; facing: number }[] = [];
  for (let i = 0; i < count; i++) {
    const offset = (i - (count - 1) / 2) * spacing;
    result.push({
      x: base.x + perpX * offset,
      y: base.y + perpY * offset,
      facing: base.facing,
    });
  }
  return result;
}

function mapIdForZone(zoneId: string): string {
  if (zoneId.startsWith('arena-truck-stop')) return 'truck-stop';
  return 'open';
}

const zones = new Map<string, ZoneRunner>();
const clientZones = new Map<WebSocket, string>();
const clientVehicles = new Map<WebSocket, string>();
const clientPlayers = new Map<WebSocket, string>(); // ws → playerId (DB UUID)
const clientJobs = new Map<WebSocket, string>(); // ws → jobId
const clientSquads = new Map<WebSocket, string[]>(); // ws → list of all squad vehicle ids (primary + mates)

// playerId → most recent arena outcome. Written by the onEnd callback after a
// successful prize transaction; consumed once by GET /api/me/last-result so
// the garage can show a summary even after a page reload.
export interface LastArenaResult {
  prize: number;
  jobPayout: number;
  salvage: number;
  wages: number;
  maintenance: number;
  won: boolean;
  rivalQuote?: string;
}
export const lastResults = new Map<string, LastArenaResult>();

export function resetState(): void {
  zones.forEach(runner => runner.shutdown());
  zones.clear();
  clientZones.clear();
  clientVehicles.clear();
  clientPlayers.clear();
  clientJobs.clear();
  clientSquads.clear();
  lastResults.clear();
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

async function removeClientFromZone(ws: WebSocket): Promise<void> {
  // Guard against double-invocation (leave_zone message + close event both call this)
  if (!clientZones.has(ws) && !clientVehicles.has(ws)) return;
  const zoneId = clientZones.get(ws);
  const vehicleId = clientVehicles.get(ws);
  const playerId = clientPlayers.get(ws);
  const squadIds = clientSquads.get(ws) ?? (vehicleId ? [vehicleId] : []);
  clientZones.delete(ws);
  clientVehicles.delete(ws);
  clientPlayers.delete(ws);
  clientJobs.delete(ws);
  clientSquads.delete(ws);

  const runner = zoneId ? zones.get(zoneId) : undefined;

  // Save current damage_state back to DB for every squad vehicle (or just the
  // primary if no squad was registered). Destroyed vehicles get a fully-damaged
  // damage_state so the garage can show them as wrecks.
  if (runner && playerId && squadIds.length > 0) {
    const zoneState = runner.getEngine().getState();
    const db = getDb();
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let hadWreck = false;
    for (const id of squadIds) {
      const alive = zoneState.vehicles.find(v => v.id === id);
      const wreck = zoneState.wreckage?.find(w => w.sourceVehicleId === id);
      if (wreck) hadWreck = true;
      try {
        if (alive) {
          // Extinguish fire when leaving the zone — persistent onFire in the DB
          // causes players to start their next match already burning.
          const exitDmg = { ...alive.stats.damageState, onFire: false };
          await db.query(
            'UPDATE vehicles SET damage_state = $1, loadout = $2 WHERE id = $3 AND player_id = $4',
            [JSON.stringify(exitDmg), JSON.stringify(alive.stats.loadout), id, playerId]
          );
        } else if (wreck) {
          const destroyedState: DamageState = {
            armor: { front: 0, back: 0, left: 0, right: 0, top: 0, underbody: 0 },
            engineDamaged: true, driverWounded: false, tiresBlown: [],
            destroyed: true, onFire: wreck.state === 'burning',
          };
          await db.query(
            'UPDATE vehicles SET damage_state = $1 WHERE id = $2 AND player_id = $3',
            [JSON.stringify(destroyedState), id, playerId]
          );

          // ── Driver permadeath ──────────────────────────────────────────────
          // Fire and explosion always kill the driver; kinetic/collision/energy
          // kills roll a 40% death chance (driver bails in the other 60%).
          const diesOutright = wreck.causedBy === 'fire' || wreck.causedBy === 'explosion';
          const dies = diesOutright || Math.random() < 0.4;
          if (dies) {
            const dRes = await db.query(
              `UPDATE drivers SET alive = FALSE, assigned_vehicle_id = NULL
               WHERE assigned_vehicle_id = $1 AND alive = TRUE
               RETURNING id, name`,
              [id]
            );
            if (dRes.rows.length) {
              const dead = dRes.rows[0];
              console.log(`[driver-death] ${dead.name} (${dead.id}) killed — vehicle ${id} ${wreck.causedBy}`);
              await db.query(
                `INSERT INTO event_history (player_id, event_type, result, money_delta) VALUES ($1,'driver_killed',$2,0)`,
                [playerId, JSON.stringify({ driverId: dead.id, driverName: dead.name, vehicleId: id, cause: wreck.causedBy })]
              );
            }
          } else {
            // Driver survived — check if they took enough damage to be wounded.
            // driverWounded on the vehicle's damageState means the final hit
            // had excess > 3, which wounds the driver for a real-time recovery.
            const driverWounded = wreck.remainingDP <= 0 && alive?.stats.damageState.driverWounded;
            if (driverWounded) {
              const skillRes = await db.query(
                `SELECT skills FROM drivers WHERE assigned_vehicle_id = $1 AND alive = TRUE LIMIT 1`,
                [id]
              );
              const driverSkills: Record<string, number> = skillRes.rows[0]?.skills ?? {};
              const medLevel = driverSkills.medical ?? 0;
              const recoveryMinutes = Math.max(1, Math.round(10 / Math.max(1, medLevel)));
              await db.query(
                `UPDATE drivers SET wounded = TRUE, wounded_until = NOW() + INTERVAL '${recoveryMinutes} minutes'
                 WHERE assigned_vehicle_id = $1 AND alive = TRUE`,
                [id]
              );
              console.log(`[driver-wound] driver of vehicle ${id} wounded — ${recoveryMinutes}min recovery (medical lvl ${medLevel})`);
            }
          }
        }
        if (uuidRe.test(id)) {
          await db.query(`UPDATE vehicles SET in_arena = FALSE WHERE id = $1 AND player_id = $2`, [id, playerId]);
        }
      } catch (e) {
        console.error(`Failed to persist squad vehicle ${id}:`, e);
      }
    }

    // If any vehicle in the squad was wrecked, mark this match as a loss for
    // the player. arena_count tracks total matches (won OR lost) — winners
    // bump it inside the prize transaction (see onEnd), so this only runs on
    // the loser path.
    if (hadWreck) {
      try {
        await db.query(
          'UPDATE players SET losses = losses + 1, arena_count = arena_count + 1 WHERE id = $1',
          [playerId]
        );
      } catch (e) {
        console.error(`Failed to record loss for ${playerId}:`, e);
      }
    }
  }

  if (runner) {
    runner.removeClient(ws);
    if (runner.isEmpty() && zoneId) zones.delete(zoneId);
  }
}

async function handleMessage(ws: WebSocket, raw: string): Promise<void> {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    send(ws, { type: 'error', message: 'Invalid JSON' });
    return;
  }

  if (msg.type === 'join_zone') {
    if (typeof msg.zoneId !== 'string' || msg.zoneId.length > 64) {
      send(ws, { type: 'error', message: 'Invalid zoneId' });
      return;
    }
    // ── Per-player zone isolation ────────────────────────────────────────
    // For arena zones, scope the zoneId by the player's UUID so different
    // players don't share an instance (which would let their vehicles
    // interact and created the earlier "who's on my team?" confusion).
    // Non-arena zones (town, highway) stay shared — appropriate for
    // future multiplayer open world.
    if (msg.zoneId.startsWith('arena') && msg.token) {
      try {
        const payload = jwt.verify(msg.token, JWT_SECRET) as { playerId: string };
        msg.zoneId = `${msg.zoneId}:${payload.playerId}`;
      } catch { /* token invalid — fall through, will get rejected below */ }
    }
    // If the zone exists but has already ended, tear it down so a fresh one is created
    const staleRunner = zones.get(msg.zoneId);
    if (staleRunner?.hasEnded()) {
      staleRunner.shutdown();
      zones.delete(msg.zoneId);
    }

    if (!zones.has(msg.zoneId)) {
      const isArena = msg.zoneId.startsWith('arena');
      const isHighway = msg.zoneId.startsWith('highway');
      const zoneType = isArena ? 'arena' : isHighway ? 'highway' : 'town';

      const runner = new ZoneRunner(msg.zoneId, zoneType, isArena ? {
        travelContext: msg.travelContext,
        onEnd: async (winnerId: string | null, salvage: number, ctx) => {
          const db = getDb();

          // Always-resolve: who's the player in this zone? Needed for expenses
          // (paid regardless of outcome) and for rival rep updates.
          const myWs = [...clientPlayers.entries()].find(([w]) => clientZones.get(w) === msg.zoneId)?.[0];
          const myPid = myWs ? clientPlayers.get(myWs) : undefined;

          // Safe retreat (Phase 3): garage owners regroup at their garage; everyone
          // else is dumped back in Midville. Drives where the client navigates next.
          const spawnAt: 'garage' | 'town' = (myPid && await playerOwnsGarage(db, myPid)) ? 'garage' : 'town';

          // Travel encounter: update location if player won
          if (ctx.travelContext && winnerId && myPid === winnerId) {
            await db.query(
              `UPDATE gangs SET current_world_node_id = $1 WHERE owner_player_id = $2`,
              [ctx.travelContext.toNodeId, winnerId]
            );
          }

          const mySquad = myWs ? (clientSquads.get(myWs) ?? []) : [];

          // Compute per-match expenses: wages = $50 × driver skill per squad member
          //                             maintenance = $10 × squad size
          // Applied regardless of win/lose — drivers and mechanics get paid either way.
          let wages = 0, maintenance = 0, myGangId: string | null = null;
          if (myPid && mySquad.length > 0) {
            const gRes = await db.query<{ id: string }>(`SELECT id FROM gangs WHERE owner_player_id = $1`, [myPid]);
            myGangId = gRes.rows[0]?.id ?? null;
            maintenance = 10 * mySquad.length;
            for (const vid of mySquad) {
              const dRes = await db.query<{ skill: number }>(
                `SELECT skill FROM drivers WHERE assigned_vehicle_id = $1 AND alive = TRUE LIMIT 1`,
                [vid]
              );
              if (dRes.rows.length) wages += 50 * dRes.rows[0].skill;
            }
          }

          // Record rival rep + pick a quote (except for mutual kills)
          let rivalQuote: string | undefined;
          if (ctx.rival && ctx.reason !== 'all_destroyed' && myGangId) {
            try {
              const playerWon = !!winnerId;
              await recordRivalOutcome(db, myGangId, ctx.rival.id, playerWon);
              const pool = playerWon
                ? (await db.query<{ defeat_lines: string[] }>(`SELECT defeat_lines FROM rival_gangs WHERE id = $1`, [ctx.rival.id])).rows[0]?.defeat_lines ?? []
                : (await db.query<{ boast_lines: string[]  }>(`SELECT boast_lines  FROM rival_gangs WHERE id = $1`, [ctx.rival.id])).rows[0]?.boast_lines  ?? [];
              rivalQuote = pool.length ? pool[Math.floor(Math.random() * pool.length)] : undefined;
            } catch (e) {
              console.error('Rival rep update failed:', e);
            }
          }

          // Apply expenses to the gang's treasury (via players.money sync trigger)
          // regardless of outcome, and log each line in gang_ledger for auditability.
          if (myPid && myGangId && (wages > 0 || maintenance > 0)) {
            const totalExpense = wages + maintenance;
            try {
              await db.query(`UPDATE players SET money = GREATEST(0, money - $1) WHERE id = $2`,
                [totalExpense, myPid]);
              if (wages > 0) {
                await db.query(
                  `INSERT INTO gang_ledger (gang_id, event_type, amount, description, result)
                   VALUES ($1, 'wages', $2, $3, $4)`,
                  [myGangId, -wages, `Driver wages (squad of ${mySquad.length})`, JSON.stringify({ zoneId: msg.zoneId, squadSize: mySquad.length })]
                );
              }
              if (maintenance > 0) {
                await db.query(
                  `INSERT INTO gang_ledger (gang_id, event_type, amount, description, result)
                   VALUES ($1, 'maintenance', $2, $3, $4)`,
                  [myGangId, -maintenance, `Vehicle maintenance (squad of ${mySquad.length})`, JSON.stringify({ zoneId: msg.zoneId, squadSize: mySquad.length })]
                );
              }
            } catch (e) {
              console.error('Failed to apply match expenses:', e);
            }
          }

          // Defense zone: write influence outcome and mark log entry resolved
          if (msg.zoneId.startsWith('arena-defense-') && myPid) {
            try {
              const rawLogId = msg.zoneId.replace(/^arena-defense-/, '').split(':')[0];
              // Ownership check: only act if this entry belongs to the player in this zone
              const entryRes = await db.query<{ gang_id: string; settlement_id: string }>(
                `SELECT gang_id, settlement_id FROM gang_action_log
                   WHERE id = $1 AND player_id = $2 AND resolved = FALSE`,
                [rawLogId, myPid],
              );
              if (entryRes.rows.length) {
                const { gang_id, settlement_id } = entryRes.rows[0];
                const playerWon = !!winnerId && winnerId === myPid;
                if (playerWon) {
                  const delta = 15 + Math.floor(Math.random() * 11);
                  await db.query(
                    `UPDATE zone_influence SET influence = GREATEST(0, influence - $1)
                       WHERE settlement_id = $2 AND gang_id = $3`,
                    [delta, settlement_id, gang_id],
                  );
                } else if (winnerId && winnerId !== myPid && myGangId) {
                  const delta = 10 + Math.floor(Math.random() * 11);
                  await db.query(
                    `UPDATE zone_influence SET influence = GREATEST(0, influence - $1)
                       WHERE settlement_id = $2 AND gang_id = $3`,
                    [delta, settlement_id, myGangId],
                  );
                }
                await db.query(`UPDATE gang_action_log SET resolved = TRUE WHERE id = $1`, [rawLogId]);
              }
            } catch (e) {
              console.error('Defense outcome handling failed:', e);
            }
          }

          if (!winnerId) {
            const replayId = await persistReplay({
              db, playerId: myPid, zoneId: msg.zoneId,
              opponent: ctx.rival?.name ?? null,
              result: ctx.reason === 'all_destroyed' ? 'draw' : 'loss',
              prize: 0, winnerId: null,
              snapshots: runner.getEngine().getSnapshots(),
            });
            return { prize: 0, jobPayout: 0, salvage: 0, wages, maintenance, rivalQuote, replayId, spawnAt };
          }
          try {
            const pRes = await db.query(`SELECT division FROM players WHERE id = $1`, [winnerId]);
            const division = pRes.rows[0]?.division ?? 5;

            // Power-scaled prize: fold the winner's fleet value + crew skill
            // into a power score, compare against the rival fleet's power
            // (stashed at match setup), and let the gap drive the purse — so
            // punching up against a tougher gang pays more.
            const winnerWs2 = [...clientPlayers.entries()].find(([, pid]) => pid === winnerId)?.[0];
            const winnerSquad = (winnerWs2 ? clientSquads.get(winnerWs2) : null) ?? mySquad;
            const squadSize = Math.max(1, winnerSquad.length);
            let playerFleetValue = 0, skillSum = 0, skillCount = 0;
            for (const vid of winnerSquad) {
              const vr = await db.query<{ loadout: VehicleLoadout }>(`SELECT loadout FROM vehicles WHERE id = $1`, [vid]);
              playerFleetValue += vr.rows[0]?.loadout?.totalCost ?? 0;
              const dr = await db.query<{ skill: number }>(
                `SELECT skill FROM drivers WHERE assigned_vehicle_id = $1 AND alive = TRUE LIMIT 1`, [vid],
              );
              if (dr.rows.length) { skillSum += dr.rows[0].skill; skillCount++; }
            }
            const playerPower = sidePower(playerFleetValue || NOMINAL_RIVAL_VEHICLE_VALUE, skillCount ? skillSum / skillCount : 3);
            const rivalPower  = runner.getMatchRivalPower() || playerPower;
            const prize = calcMatchPrize(playerPower, rivalPower, squadSize);

            // Find winner's WebSocket to check for active job
            let jobPayout = 0;
            let completedJobWs: WebSocket | null = null;
            let completedJobType = '';
            let completedJobId = '';
            let completedZoneId = '';

            let winnerVehicleId: string | null = null;
            let pendingJobId: string | null = null;
            for (const [ws, pid] of clientPlayers) {
              if (pid !== winnerId) continue;
              winnerVehicleId = clientVehicles.get(ws) ?? null;
              const jobId = clientJobs.get(ws);
              if (jobId) {
                pendingJobId = jobId;
                completedJobWs = ws;
              }
              break;
            }

            const client = await db.connect();
            try {
              await client.query('BEGIN');

              // Mark the job complete inside the transaction so a ROLLBACK
              // also un-completes the job — previously the UPDATE ran outside
              // and a failed payout could leave the player owing themselves money.
              if (pendingJobId) {
                const jobRes = await client.query(
                  `UPDATE jobs SET completed = TRUE
                   WHERE id = $1 AND taken_by = $2 AND completed = FALSE
                   RETURNING payout, job_type, zone_id`,
                  [pendingJobId, winnerId]
                );
                if (jobRes.rows.length) {
                  jobPayout = jobRes.rows[0].payout;
                  completedJobType = jobRes.rows[0].job_type;
                  completedJobId = pendingJobId;
                  completedZoneId = jobRes.rows[0].zone_id;
                } else {
                  completedJobWs = null;
                }
              }

              const total = prize + jobPayout + salvage;
              await client.query(
                `UPDATE players SET money = money + $1, reputation = reputation + $2,
                                    wins = wins + 1, arena_count = arena_count + 1
                 WHERE id = $3`,
                [total, Math.floor(prize / 500), winnerId]
              );
              await client.query(
                'INSERT INTO event_history (player_id, event_type, result, money_delta) VALUES ($1,$2,$3,$4)',
                [winnerId, 'arena_win', JSON.stringify({ zoneId: msg.zoneId, prize }), prize]
              );
              if (jobPayout > 0) {
                await client.query(
                  `INSERT INTO event_history (player_id, event_type, result, money_delta) VALUES ($1,$2,$3,$4)`,
                  [winnerId, completedJobType,
                   JSON.stringify({ jobId: completedJobId, zoneId: completedZoneId }), jobPayout]
                );
              }
              if (salvage > 0) {
                await client.query(
                  `INSERT INTO event_history (player_id, event_type, result, money_delta) VALUES ($1,$2,$3,$4)`,
                  [winnerId, 'salvage',
                   JSON.stringify({ zoneId: msg.zoneId, salvage }), salvage]
                );
              }
              await client.query('COMMIT');
              // Only clear the job from memory AFTER the transaction commits
              if (completedJobWs) clientJobs.delete(completedJobWs);
            } catch (e) {
              await client.query('ROLLBACK');
              throw e;
            } finally {
              client.release();
            }
            // Award XP to winning squad: survive +5, enemy kills ×3, win +15, contract +10
            const finalState = runner.getEngine().getState();
            const enemyKills = (finalState.wreckage ?? []).filter(w => w.playerId !== winnerId).length;
            const winnerWs = [...clientPlayers.entries()].find(([, pid]) => pid === winnerId)?.[0];
            const winningSquad = (winnerWs ? clientSquads.get(winnerWs) : null) ?? (winnerVehicleId ? [winnerVehicleId] : []);
            const xpPerDriver = 5 + enemyKills * 3 + 15 + (jobPayout > 0 ? 10 : 0);
            if (winningSquad.length > 0) {
              for (const vid of winningSquad) {
                const dRes = await db.query(
                  `SELECT id FROM drivers WHERE assigned_vehicle_id = $1 AND alive = TRUE LIMIT 1`,
                  [vid]
                );
                if (!dRes.rows.length) continue;
                await db.query(
                  `UPDATE drivers SET xp = xp + $1, xp_pool = xp_pool + $1 WHERE id = $2`,
                  [xpPerDriver, dRes.rows[0].id]
                );
              }
            }

            // Log income lines to the gang ledger for auditability
            try {
              if (myGangId) {
                if (prize > 0) {
                  await db.query(
                    `INSERT INTO gang_ledger (gang_id, event_type, amount, description, result)
                     VALUES ($1, 'arena_prize', $2, $3, $4)`,
                    [myGangId, prize, `Arena prize (div ${division})`, JSON.stringify({ zoneId: msg.zoneId, division })]
                  );
                }
                if (jobPayout > 0) {
                  await db.query(
                    `INSERT INTO gang_ledger (gang_id, event_type, amount, description, result)
                     VALUES ($1, 'job_payout', $2, $3, $4)`,
                    [myGangId, jobPayout, `Job payout (${completedJobType})`, JSON.stringify({ jobId: completedJobId })]
                  );
                }
                if (salvage > 0) {
                  await db.query(
                    `INSERT INTO gang_ledger (gang_id, event_type, amount, description, result)
                     VALUES ($1, 'salvage', $2, $3, $4)`,
                    [myGangId, salvage, 'Salvage from destroyed rivals', JSON.stringify({ zoneId: msg.zoneId })]
                  );
                }
              }
            } catch (e) {
              console.error('Failed to log ledger entries:', e);
            }

            lastResults.set(winnerId, {
              prize, jobPayout, salvage, wages, maintenance,
              won: true, rivalQuote,
            });
            const replayId = await persistReplay({
              db, playerId: winnerId, zoneId: msg.zoneId,
              opponent: ctx.rival?.name ?? null,
              result: 'win', prize, winnerId,
              snapshots: runner.getEngine().getSnapshots(),
            });
            return { prize, jobPayout, salvage, wages, maintenance, rivalQuote, replayId, spawnAt };
          } catch (e) {
            console.error('Failed to credit arena prize:', e);
            return { prize: 0, jobPayout: 0, salvage: 0, wages, maintenance, rivalQuote, spawnAt };
          }
        },
      } : {}, msg.mapId ?? mapIdForZone(msg.zoneId));

      if (isArena) {
        // Enemy count matches the player's squad size (1v1, 2v2, up to 4v4).
        const squadSize = Math.max(1, Math.min(4, msg.squadVehicleIds?.length ?? 1));
        const aiSpawns = runner.getMap().spawnPoints.filter(s => s.team === 'ai');
        const names = ['ai-red', 'ai-blue', 'ai-green', 'ai-yellow'];
        const enemyPositions: { x: number; y: number; facing: number }[] = [];
        if (aiSpawns.length >= squadSize) {
          for (let i = 0; i < squadSize; i++) enemyPositions.push(aiSpawns[i]);
        } else if (aiSpawns.length > 0) {
          enemyPositions.push(...clusterSpawnPositions(aiSpawns[0], squadSize));
        }

        // ── Persistent rival selection ──────────────────────────────────────
        // Look up the player's gang, pick an eligible rival weighted by grudge,
        // stash it on the runner so it flows into zone_state (for sprite tinting)
        // and zone_end (for the post-match banner).
        let rival: RivalGang | null = null;
        let rivalGrudge = 0;
        // True when the player picked this rival from the free-pick slate — they
        // then face the rival's full signature fleet rather than a tier-matched
        // lineup, and accept the (reward-scaled) power gap.
        let chosenRival = false;

        // Defense zone: force the attacking gang as the rival instead of picking normally
        if (msg.zoneId.startsWith('arena-defense-')) {
          try {
            const db = getDb();
            const rawLogId = msg.zoneId.replace(/^arena-defense-/, '').split(':')[0];
            // Verify ownership: only the player whose log entry this is can launch a defense
            let defPlayerId: string | undefined;
            try {
              defPlayerId = (jwt.verify(msg.token ?? '', JWT_SECRET) as { playerId: string }).playerId;
            } catch { /* invalid token — entry query will return 0 rows */ }
            const entryRes = await db.query<{ gang_id: string; gang_name: string; player_id: string }>(
              `SELECT gang_id, gang_name, player_id FROM gang_action_log
                 WHERE id = $1 AND player_id = $2 AND resolved = FALSE`,
              [rawLogId, defPlayerId],
            );
            if (entryRes.rows.length) {
              const { gang_id, gang_name, player_id } = entryRes.rows[0];
              // Try to find the full GeneratedGang from the player's world for accurate colours
              const gangRow = await db.query<{ generated_gangs: GeneratedGang[] | null }>(
                `SELECT generated_gangs FROM gangs WHERE owner_player_id = $1`,
                [player_id],
              );
              const generated = (gangRow.rows[0]?.generated_gangs ?? []).find(g => g.id === gang_id);
              rival = generated
                ? adaptGeneratedGang(generated)
                : { id: gang_id, name: gang_name, description: 'An attacking gang', base_skill: 3,
                    primary_colour: 0xff2222, secondary_colour: 0x880000,
                    emblem_id: 'default', min_division: 5, boast_lines: [], defeat_lines: [], lineup: {} };
              runner.setRival({
                id: rival.id, name: rival.name, description: rival.description,
                primary_colour: rival.primary_colour, secondary_colour: rival.secondary_colour,
                emblem_id: rival.emblem_id,
              });
            }
          } catch (e) {
            console.error('Defense rival setup failed:', e);
          }
        }

        try {
          const db = getDb();
          if (!rival && msg.token) {
            // Resolve the owning player's division + gang from the primary vehicle id
            const res = await db.query<{ division: number; gang_id: string }>(
              `SELECT p.division, g.id AS gang_id
               FROM vehicles v
               JOIN players p ON p.id = v.player_id
               JOIN gangs g ON g.owner_player_id = p.id
               WHERE v.id = $1`,
              [msg.vehicleId]
            );
            if (res.rows.length) {
              const { division, gang_id } = res.rows[0];

              // Fetch generated gangs for Phase 5b rival selection
              const gangRowRes = await db.query<{
                generated_gangs: GeneratedGang[] | null;
                current_world_node_id: string;
              }>(
                `SELECT generated_gangs, current_world_node_id FROM gangs WHERE id = $1`,
                [gang_id],
              );
              const generatedGangs: GeneratedGang[] = gangRowRes.rows[0]?.generated_gangs ?? [];
              const currentSettlementId             = gangRowRes.rows[0]?.current_world_node_id ?? '';

              // Free-pick: the player chose this rival from the opponent slate.
              if (msg.rivalId) {
                const staticRes = await db.query<RivalGang>(
                  `SELECT id, name, description, base_skill, primary_colour, secondary_colour,
                          emblem_id, min_division, boast_lines, defeat_lines, lineup
                   FROM rival_gangs WHERE id = $1`,
                  [msg.rivalId],
                );
                if (staticRes.rows.length) {
                  rival = staticRes.rows[0];
                  chosenRival = true;
                } else {
                  const gen = generatedGangs.find(g => g.id === msg.rivalId);
                  if (gen) { rival = adaptGeneratedGang(gen); chosenRival = true; }
                }
              }
              // Auto-pick fallback — prefer generated gangs with local territory presence
              if (!rival && generatedGangs.length && currentSettlementId) {
                rival = await pickGeneratedRivalForMatch(db, currentSettlementId, generatedGangs);
              }
              if (!rival) {
                rival = await pickRivalForMatch(db, gang_id, division);
              }
              if (rival) {
                const gRes = await db.query<{ grudge: number }>(
                  `SELECT grudge FROM player_rival_rep WHERE player_gang_id = $1 AND rival_id = $2`,
                  [gang_id, rival.id]
                );
                rivalGrudge = gRes.rows[0]?.grudge ?? 0;
                runner.setRival({
                  id: rival.id, name: rival.name, description: rival.description,
                  primary_colour: rival.primary_colour, secondary_colour: rival.secondary_colour,
                  emblem_id: rival.emblem_id,
                });
              }
            }
          }
        } catch (e) {
          console.error('Rival selection failed:', e);
        }
        const rivalSkill = rival ? rivalEffectiveSkill(rival, rivalGrudge) : 3;
        const rivalGunnery = {
          gunnery_guns:     Math.max(1, rivalSkill - 1),
          gunnery_heavy:    Math.max(0, rivalSkill - 2),
          gunnery_rockets:  Math.max(0, rivalSkill - 3),
          gunnery_lasers:   Math.max(0, rivalSkill - 2),
          gunnery_flamers:  Math.max(0, rivalSkill - 3),
          gunnery_tactical: Math.max(0, rivalSkill - 4),
        };
        const rivalDriving = {
          driving_light:    Math.max(1, rivalSkill - 1),
          driving_standard: rivalSkill,
          driving_heavy:    Math.max(0, rivalSkill - 2),
        };
        const rivalSkills = { ...rivalGunnery, ...rivalDriving };

        // Decide which stock blueprints the rival fields. A free-pick rival
        // brings its full signature fleet (no tier lock — the spec is the
        // rival's own); an auto-picked rival is matched to the player's
        // division so the fallback path stays sensible. Empty → generic rig.
        let lineupLoadouts: Map<string, { name: string; loadout: VehicleLoadout }> = new Map();
        let lineupIds: string[] = [];
        if (rival && rival.lineup) {
          const playerDivision = await (async () => {
            const r = await getDb().query<{ division: number }>(
              `SELECT p.division FROM vehicles v JOIN players p ON p.id = v.player_id WHERE v.id = $1`,
              [msg.vehicleId],
            );
            return r.rows[0]?.division ?? 5;
          })();
          lineupIds = chosenRival ? rivalSignatureLineup(rival) : rivalLineupForDivision(rival, playerDivision);
          if (lineupIds.length) lineupLoadouts = await fetchStockLoadouts(getDb(), lineupIds);
        }

        // Power score of the rival's fielded fleet (value × skill factor), used
        // at zone-end to scale the prize by the power gap. Sum the cost of the
        // actually-fielded vehicles (round-robin to squad size); fall back to a
        // nominal per-vehicle value when fielding the generic rig.
        const fielded = fieldedStockIds(lineupIds, squadSize);
        const rivalFleetValue = fielded.length
          ? fielded.reduce((sum, id) => sum + (lineupLoadouts.get(id)?.loadout.totalCost ?? NOMINAL_RIVAL_VEHICLE_VALUE), 0)
          : NOMINAL_RIVAL_VEHICLE_VALUE * squadSize;
        runner.setMatchRivalPower(sidePower(rivalFleetValue, rivalSkill));

        enemyPositions.forEach((sp, i) => {
          const name = names[i] ?? `ai-${i}`;
          if (lineupIds.length) {
            // Round-robin across the lineup so a 4-vehicle squad fielding a
            // 2-design lineup gets mixed pairs instead of 4 identical rigs.
            const stockId = lineupIds[i % lineupIds.length];
            const entry = lineupLoadouts.get(stockId);
            if (entry) {
              runner.getEngine().addVehicle(
                makeVehicleFromLoadout(name, 'ai-team', sp.x, sp.y, sp.facing, `${rival!.name}: ${entry.name}`, entry.loadout),
              );
              runner.setVehicleSkill(name, rivalSkill, rivalSkills);
              return;
            }
          }
          // Fallback — generic AI rig
          runner.getEngine().addVehicle(makeTestVehicle(name, 'ai-team', sp.x, sp.y, sp.facing, 70));
          runner.setVehicleSkill(name, rivalSkill, rivalSkills);
        });
      } else if (isHighway) {
        runner.getEngine().addVehicle(makeTestVehicle('npc-1', 'npc-traffic', -5, -60, 0));
        runner.getEngine().addVehicle(makeTestVehicle('npc-2', 'npc-traffic',  5, -20, 0));
        runner.getEngine().addVehicle(makeTestVehicle('npc-3', 'npc-traffic',  0,  40, 0));
      }

      zones.set(msg.zoneId, runner);
    }
    clientZones.set(ws, msg.zoneId);
    clientVehicles.set(ws, msg.vehicleId);
    const runner = zones.get(msg.zoneId)!;
    // Always (re)spawn the player's vehicle — removes any stale position from a prior session
    runner.getEngine().removeVehicle(msg.vehicleId);
    let vehicle: VehicleState | null = null;
    if (msg.token) {
      const result = await loadVehicleFromDb(msg.vehicleId, msg.token);
      if (result) {
        vehicle = result.vehicle;
        clientPlayers.set(ws, result.playerId);
        // Before storing jobId, validate it belongs to this player and is not already completed
        if (msg.jobId) {
          const db = getDb();
          const jobCheck = await db.query(
            `SELECT id FROM jobs WHERE id = $1 AND taken_by = $2 AND completed = FALSE`,
            [msg.jobId, result.playerId]
          );
          if (jobCheck.rows.length) {
            clientJobs.set(ws, msg.jobId);
          }
        }
      }
    }
    const playerSpawns = runner.getMap().spawnPoints.filter(s => s.team === 'player');
    const primarySpawn = playerSpawns[0] ?? { x: 0, y: 8, facing: 0, team: 'player' as const };
    if (!vehicle) {
      vehicle = makeTestVehicle(msg.vehicleId, 'player', primarySpawn.x, primarySpawn.y, 0, 60);
    }
    vehicle = {
      ...vehicle,
      position: { x: primarySpawn.x, y: primarySpawn.y },
      facing: primarySpawn.facing,
      speed: 0,
      stats: vehicle.stats, // full derived top speed — AI enemies aren't capped, so the player isn't either
    };
    runner.getEngine().addVehicle(vehicle);
    runner.registerHumanVehicle(msg.vehicleId);

    // ── Squad spawn: additional player-team vehicles, AI-driven by their drivers ──
    const squadIds = (msg.squadVehicleIds ?? [])
      .filter(id => id !== msg.vehicleId)     // strip primary if included
      .slice(0, 3);                            // enforce max 3 squadmates (primary + 3 = 4)
    const allSquadIds: string[] = [msg.vehicleId, ...squadIds];
    const playerId = clientPlayers.get(ws);
    if (squadIds.length > 0 && playerId) {
      const matePositions = playerSpawns.length >= allSquadIds.length
        ? playerSpawns.slice(1, allSquadIds.length)
        : clusterSpawnPositions(primarySpawn, allSquadIds.length).slice(1);
      for (let i = 0; i < squadIds.length; i++) {
        const mateId = squadIds[i];
        const pos = matePositions[i] ?? primarySpawn;
        const mateVehicle = await loadVehicleForPlayer(mateId, playerId);
        if (!mateVehicle) continue;   // skip vehicles not owned by this player

        // Load driver skill and mark in_arena
        const db = getDb();
        const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRe.test(mateId)) {
          const dr = await db.query(
            `SELECT skill, aggression, loyalty, skills, attributes FROM drivers WHERE assigned_vehicle_id = $1 AND alive = TRUE LIMIT 1`,
            [mateId]
          );
          if (!dr.rows.length) continue; // squadmate without a driver — skip
          await db.query(`UPDATE vehicles SET in_arena = TRUE WHERE id = $1 AND player_id = $2`, [mateId, playerId]);
          const { skill, aggression, loyalty, skills, attributes } = dr.rows[0];
          const placed: VehicleState = {
            ...mateVehicle,
            position: { x: pos.x, y: pos.y },
            facing: pos.facing,
            stats: mateVehicle.stats, // full derived top speed (uncapped, like the primary + AI)
          };
          runner.getEngine().removeVehicle(mateId);
          runner.getEngine().addVehicle(placed);
          runner.setVehicleDriver(mateId, { skill, aggression, loyalty, skills, attributes });
        }
      }
    }
    clientSquads.set(ws, allSquadIds);

    // Check if this vehicle's driver is wounded — mark on join for client to display
    let driverWounded = false;
    {
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (uuidRe.test(msg.vehicleId)) {
        const wRes = await getDb().query(
          `SELECT wounded, wounded_until FROM drivers WHERE assigned_vehicle_id = $1 AND alive = TRUE LIMIT 1`,
          [msg.vehicleId]
        );
        if (wRes.rows.length && wRes.rows[0].wounded && wRes.rows[0].wounded_until) {
          const expired = new Date(wRes.rows[0].wounded_until).getTime() < Date.now();
          if (!expired) {
            driverWounded = true;
            console.log(`[arena] ${msg.vehicleId} joined with wounded driver`);
          } else {
            // Wound timer expired — auto-clear
            await getDb().query(
              `UPDATE drivers SET wounded = FALSE, wounded_until = NULL WHERE assigned_vehicle_id = $1`,
              [msg.vehicleId]
            );
          }
        }
      }
    }

    // ── Deployment check: reject if vehicle is out on a squad deployment or headless job ──
    {
      const db = getDb();
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const allVids = [msg.vehicleId, ...(squadIds ?? [])].filter((id: string) => uuidRe.test(id));
      if (allVids.length) {
        const depRes = await db.query(
          `SELECT sd.vehicle_ids, sd.resolves_at, sd.zone_id
             FROM squad_deployments sd
            WHERE sd.player_id = $1 AND sd.status = 'in_transit' AND sd.resolves_at > NOW()
              AND sd.vehicle_ids && $2::uuid[]`,
          [playerId, allVids]
        );
        if (depRes.rows.length) {
          const deployedIds = depRes.rows.flatMap((r: any) =>
            (r.vehicle_ids as string[]).filter((id: string) => allVids.includes(id))
          );
          send(ws, { type: 'zone_join_error', error: `Vehicle ${deployedIds[0].slice(0,8)}… is currently deployed — recall it first` });
          return;
        }
        const jobRes = await db.query(
          `SELECT j.id, j.resolves_at
             FROM jobs j
             JOIN drivers d ON d.id = j.assigned_driver_id
            WHERE d.player_id = $1 AND j.headless = TRUE AND j.outcome IS NULL
              AND j.resolves_at IS NOT NULL AND j.resolves_at > NOW()
              AND d.assigned_vehicle_id = ANY($2::uuid[])`,
          [playerId, allVids]
        );
        if (jobRes.rows.length) {
          send(ws, { type: 'zone_join_error', error: `This vehicle’s driver is on a headless job — wait for it to complete` });
          return;
        }
      }
    }

    // Load driver skill for this vehicle (only for real DB vehicles with valid UUID)
    let joinedSkill = 3;
    {
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (uuidRe.test(msg.vehicleId)) {
        const db = getDb();
        const driverRes = await db.query(
          `SELECT skill, aggression, loyalty, skills, attributes FROM drivers WHERE assigned_vehicle_id = $1 AND alive = TRUE LIMIT 1`,
          [msg.vehicleId]
        );
        if (driverRes.rows.length) {
          const { skill, aggression, loyalty, skills, attributes } = driverRes.rows[0];
          joinedSkill = skill;
          runner.setVehicleDriver(msg.vehicleId, { skill, aggression, loyalty, skills, attributes });
        }
      }
    }

    runner.addClient(ws); // sends initial zone_state automatically

    // Inform the joining client of their driver skill and max steer
    {
      const maxSteer = skillToMaxSteer(joinedSkill);
      const joinedDriverStats = runner.getDriverStats(msg.vehicleId);
      const infoMsg: ServerMessage = {
        type: 'driver_info',
        vehicleId: msg.vehicleId,
        skill: joinedSkill,
        gunnerySkills: joinedDriverStats.skills ?? {},
        drivingSkills: joinedDriverStats.skills ?? {},
        maxSteer,
      };
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(infoMsg));
    }

    // Mark vehicle as in-arena (only for real DB vehicles, not test UUIDs)
    if (msg.token) {
      const playerId = clientPlayers.get(ws);
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (playerId && uuidRe.test(msg.vehicleId)) {
        const db = getDb();
        await db.query(`UPDATE vehicles SET in_arena = TRUE WHERE id = $1 AND player_id = $2`, [msg.vehicleId, playerId]);
      }
    }
    return;
  }

  if (msg.type === 'input') {
    const zoneId = clientZones.get(ws);
    const vehicleId = clientVehicles.get(ws);
    if (!zoneId || !vehicleId) {
      send(ws, { type: 'error', message: 'Not in a zone — send join_zone first' });
      return;
    }

    // Validate inputs
    const runner = zones.get(zoneId);
    const vehicleState = runner?.getEngine().getState().vehicles.find(v => v.id === vehicleId);
    const maxSpeed = vehicleState?.stats.maxSpeed ?? 100;
    // Allow negative speed (reverse) up to -30 mph; forward cap is the vehicle's maxSpeed
    const REVERSE_MAX = -30;
    const speed = Math.max(REVERSE_MAX, Math.min(maxSpeed, Number(msg.speed) || 0));
    const fireWeapon = typeof msg.fireWeapon === 'string' && msg.fireWeapon.length <= 20
      ? msg.fireWeapon
      : null;

    if (runner) {
      const vehicleSkill = runner.getDriverSkill(vehicleId);
      const maxSteer = skillToMaxSteer(vehicleSkill);
      const clampedSteer = Math.max(-maxSteer, Math.min(maxSteer, Number(msg.steer) || 0));
      runner.queueInput(vehicleId, { speed, steer: clampedSteer, fireWeapon });
    }
    return;
  }

  if (msg.type === 'autopilot') {
    const zoneId = clientZones.get(ws);
    const vehicleId = clientVehicles.get(ws);
    const runner = zoneId ? zones.get(zoneId) : undefined;
    if (runner && vehicleId) {
      runner.setAutopilot(vehicleId, !!msg.enabled);
    }
    return;
  }

  if (msg.type === 'leave_zone') {
    removeClientFromZone(ws).catch(console.error);
    return;
  }

  if (msg.type === 'pause' || msg.type === 'unpause' || msg.type === 'squad_order') {
    const zid = clientZones.get(ws);
    const runner = zid ? zones.get(zid) : null;
    if (!runner) { send(ws, { type: 'error', message: 'Not in a zone' }); return; }
    if (msg.type === 'pause') runner.pause(ws);
    if (msg.type === 'unpause') runner.unpause(ws);
    if (msg.type === 'squad_order') {
      // Only allow orders on the client's own squad vehicles — prevents cross-player tampering
      const mySquad = clientSquads.get(ws) ?? [];
      if (!mySquad.includes(msg.vehicleId)) {
        send(ws, { type: 'error', message: 'Vehicle not in your squad' });
        return;
      }
      runner.setSquadOrder(msg.vehicleId, msg.order);
    }
    return;
  }

  send(ws, { type: 'error', message: `Unknown message type: ${(msg as any).type}` });
}

export function createWsServer(port: number): http.Server {
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    ws.on('message', (data) => { handleMessage(ws, data.toString()).catch(console.error); });
    ws.on('close', () => { removeClientFromZone(ws).catch(console.error); });
  });

  httpServer.listen(port);
  return httpServer;
}

export function attachWss(server: http.Server): void {
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => { handleMessage(ws, data.toString()).catch(console.error); });
    ws.on('close', () => { removeClientFromZone(ws).catch(console.error); });
  });
}