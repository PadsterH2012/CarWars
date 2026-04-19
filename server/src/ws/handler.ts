import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import jwt from 'jsonwebtoken';
import type { ClientMessage, ServerMessage, VehicleState, VehicleLoadout, DamageState } from '@carwars/shared';
import { ZoneRunner } from '../world/zone-runner';
import { getDb } from '../db/client';
import { deriveStats } from '../rules/vehicle';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-prod';

function skillToMaxSteer(skill: number): number {
  if (skill <= 2) return 15;
  if (skill <= 4) return 21;
  return 30;
}

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
  stats.damageState = damageState;

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
  stats.damageState = damageState;
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

export function resetState(): void {
  zones.forEach(runner => runner.shutdown());
  zones.clear();
  clientZones.clear();
  clientVehicles.clear();
  clientPlayers.clear();
  clientJobs.clear();
  clientSquads.clear();
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
    for (const id of squadIds) {
      const alive = zoneState.vehicles.find(v => v.id === id);
      const wreck = zoneState.wreckage?.find(w => w.sourceVehicleId === id);
      try {
        if (alive) {
          await db.query(
            'UPDATE vehicles SET damage_state = $1, loadout = $2 WHERE id = $3 AND player_id = $4',
            [JSON.stringify(alive.stats.damageState), JSON.stringify(alive.stats.loadout), id, playerId]
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
        }
        if (uuidRe.test(id)) {
          await db.query(`UPDATE vehicles SET in_arena = FALSE WHERE id = $1 AND player_id = $2`, [id, playerId]);
        }
      } catch (e) {
        console.error(`Failed to persist squad vehicle ${id}:`, e);
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
        onEnd: async (winnerId: string | null, salvage: number) => {
          if (!winnerId) return { prize: 0, jobPayout: 0, salvage: 0 };
          const db = getDb();
          try {
            const pRes = await db.query(`SELECT division FROM players WHERE id = $1`, [winnerId]);
            const division = pRes.rows[0]?.division ?? 5;
            // Prize scales with squad size — reward bigger fights
            const winnerWs2 = [...clientPlayers.entries()].find(([, pid]) => pid === winnerId)?.[0];
            const squadSize = winnerWs2 ? (clientSquads.get(winnerWs2)?.length ?? 1) : 1;
            const prize = calcPrize(division, squadSize);

            // Find winner's WebSocket to check for active job
            let jobPayout = 0;
            let completedJobWs: WebSocket | null = null;
            let completedJobType = '';
            let completedJobId = '';
            let completedZoneId = '';

            let winnerVehicleId: string | null = null;
            for (const [ws, pid] of clientPlayers) {
              if (pid !== winnerId) continue;
              winnerVehicleId = clientVehicles.get(ws) ?? null;
              const jobId = clientJobs.get(ws);
              if (!jobId) {
                break;
              }

              // Verify job belongs to winner and is still open
              const jobRes = await db.query(
                `UPDATE jobs SET completed = TRUE
                 WHERE id = $1 AND taken_by = $2 AND completed = FALSE
                 RETURNING payout, job_type, zone_id`,
                [jobId, winnerId]
              );
              if (jobRes.rows.length) {
                jobPayout = jobRes.rows[0].payout;
                completedJobWs = ws;
                completedJobType = jobRes.rows[0].job_type;
                completedJobId = jobId;
                completedZoneId = jobRes.rows[0].zone_id;
              }
              break;
            }

            const total = prize + jobPayout + salvage;
            const client = await db.connect();
            try {
              await client.query('BEGIN');
              await client.query(
                'UPDATE players SET money = money + $1, reputation = reputation + $2 WHERE id = $3',
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
            // After prize transaction commits, fan XP out across every squad driver.
            // Each driver earns 10 × kills landed by their car + 20 if their car survived.
            // Solo 4-kill survival = 60 XP ≈ previous 50 XP baseline; squad splits naturally.
            const winnerWs = [...clientPlayers.entries()].find(([, pid]) => pid === winnerId)?.[0];
            const winningSquad = (winnerWs ? clientSquads.get(winnerWs) : null) ?? (winnerVehicleId ? [winnerVehicleId] : []);
            if (winningSquad.length > 0) {
              const zoneState = runner.getEngine().getState();
              for (const vid of winningSquad) {
                const survived = !!zoneState.vehicles.find(v => v.id === vid);
                const kills = (zoneState.wreckage ?? []).filter(w => w.killedByVehicleId === vid).length;
                const xp = 10 * kills + (survived ? 20 : 0);
                if (xp <= 0) continue;
                const dRes = await db.query(
                  `SELECT id FROM drivers WHERE assigned_vehicle_id = $1 AND alive = TRUE LIMIT 1`,
                  [vid]
                );
                if (!dRes.rows.length) continue;
                const xpRes = await db.query(
                  `UPDATE drivers SET xp = xp + $1 WHERE id = $2 RETURNING xp, skill`,
                  [xp, dRes.rows[0].id]
                );
                if (xpRes.rows.length) {
                  const { xp: newXp, skill: currentSkill } = xpRes.rows[0];
                  let newSkill = currentSkill;
                  while (newSkill < 6 && newXp >= newSkill * 100) newSkill++;
                  if (newSkill > currentSkill) {
                    await db.query(`UPDATE drivers SET skill = $1 WHERE id = $2`, [newSkill, dRes.rows[0].id]);
                  }
                }
              }
            }

            return { prize, jobPayout, salvage };
          } catch (e) {
            console.error('Failed to credit arena prize:', e);
            return { prize: 0, jobPayout: 0, salvage: 0 };
          }
        },
      } : {}, mapIdForZone(msg.zoneId));

      if (isArena) {
        // Enemy count matches the player's squad size (1v1, 2v2, up to 4v4).
        // Use the map's ai spawn points up to that count; if the map doesn't have
        // enough, cluster additional positions around the first ai spawn.
        const squadSize = Math.max(1, Math.min(4, msg.squadVehicleIds?.length ?? 1));
        const aiSpawns = runner.getMap().spawnPoints.filter(s => s.team === 'ai');
        const names = ['ai-red', 'ai-blue', 'ai-green', 'ai-yellow'];
        const enemyPositions: { x: number; y: number; facing: number }[] = [];
        if (aiSpawns.length >= squadSize) {
          for (let i = 0; i < squadSize; i++) enemyPositions.push(aiSpawns[i]);
        } else if (aiSpawns.length > 0) {
          enemyPositions.push(...clusterSpawnPositions(aiSpawns[0], squadSize));
        }
        enemyPositions.forEach((sp, i) => {
          const name = names[i] ?? `ai-${i}`;
          runner.getEngine().addVehicle(makeTestVehicle(name, 'ai-team', sp.x, sp.y, sp.facing, 70));
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
      stats: {
        ...vehicle.stats,
        maxSpeed: Math.min(vehicle.stats.maxSpeed, 100), // cap at 100 mph — sensible Car Wars ceiling
      },
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
            `SELECT skill FROM drivers WHERE assigned_vehicle_id = $1 AND alive = TRUE LIMIT 1`,
            [mateId]
          );
          if (!dr.rows.length) continue; // squadmate without a driver — skip
          await db.query(`UPDATE vehicles SET in_arena = TRUE WHERE id = $1 AND player_id = $2`, [mateId, playerId]);
          const mateSkill = dr.rows[0].skill;
          const placed: VehicleState = {
            ...mateVehicle,
            position: { x: pos.x, y: pos.y },
            facing: pos.facing,
            stats: { ...mateVehicle.stats, maxSpeed: Math.min(mateVehicle.stats.maxSpeed, 100) },
          };
          runner.getEngine().removeVehicle(mateId);
          runner.getEngine().addVehicle(placed);
          runner.setVehicleSkill(mateId, mateSkill);
        }
      }
    }
    clientSquads.set(ws, allSquadIds);

    // Load driver skill for this vehicle (only for real DB vehicles with valid UUID)
    let joinedSkill = 3;
    {
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (uuidRe.test(msg.vehicleId)) {
        const db = getDb();
        const driverRes = await db.query(
          `SELECT skill FROM drivers WHERE assigned_vehicle_id = $1 AND alive = TRUE LIMIT 1`,
          [msg.vehicleId]
        );
        if (driverRes.rows.length) {
          joinedSkill = driverRes.rows[0].skill;
          runner.setVehicleSkill(msg.vehicleId, joinedSkill);
        }
      }
    }

    runner.addClient(ws); // sends initial zone_state automatically

    // Inform the joining client of their driver skill and max steer
    {
      const maxSteer = skillToMaxSteer(joinedSkill);
      const infoMsg: ServerMessage = { type: 'driver_info', vehicleId: msg.vehicleId, skill: joinedSkill, maxSteer };
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
    const speed = Math.max(0, Math.min(maxSpeed, Number(msg.speed) || 0));
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
