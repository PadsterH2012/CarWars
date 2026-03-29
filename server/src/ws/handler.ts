import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import jwt from 'jsonwebtoken';
import type { ClientMessage, ServerMessage, VehicleState, VehicleLoadout, DamageState } from '@carwars/shared';
import { ZoneRunner } from '../world/zone-runner';
import { getDb } from '../db/client';
import { deriveStats } from '../rules/vehicle';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-prod';

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
        mounts: [{ id: 'm0', arc: 'front', weaponId: 'mg', ammo: 50 }],
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

function mapIdForZone(zoneId: string): string {
  if (zoneId.startsWith('arena-truck-stop')) return 'truck-stop';
  return 'open';
}

const zones = new Map<string, ZoneRunner>();
const clientZones = new Map<WebSocket, string>();
const clientVehicles = new Map<WebSocket, string>();
const clientPlayers = new Map<WebSocket, string>(); // ws → playerId (DB UUID)

export function resetState(): void {
  zones.forEach(runner => runner.shutdown());
  zones.clear();
  clientZones.clear();
  clientVehicles.clear();
  clientPlayers.clear();
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
  clientZones.delete(ws);
  clientVehicles.delete(ws);
  clientPlayers.delete(ws);

  const runner = zoneId ? zones.get(zoneId) : undefined;

  // Save current damage_state back to DB if we have enough context
  if (runner && vehicleId && playerId) {
    const zoneState = runner.getEngine().getState();
    const vehicle = zoneState.vehicles.find(v => v.id === vehicleId);
    if (vehicle) {
      const db = getDb();
      try {
        await db.query(
          'UPDATE vehicles SET damage_state = $1 WHERE id = $2 AND player_id = $3',
          [JSON.stringify(vehicle.stats.damageState), vehicleId, playerId]
        );
      } catch (e) {
        console.error('Failed to save vehicle damage:', e);
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
        onEnd: async (winnerId: string | null) => {
          if (!winnerId) return;
          const ARENA_PRIZE = 5000;
          const db = getDb();
          try {
            await db.query('BEGIN');
            await db.query('UPDATE players SET money = money + $1 WHERE id = $2', [ARENA_PRIZE, winnerId]);
            await db.query(
              'INSERT INTO event_history (player_id, event_type, result, money_delta) VALUES ($1, $2, $3, $4)',
              [winnerId, 'arena_win', JSON.stringify({ zoneId: msg.zoneId }), ARENA_PRIZE]
            );
            await db.query('COMMIT');
          } catch (e) {
            await db.query('ROLLBACK');
            console.error('Failed to credit arena prize:', e);
          }
        },
      } : {}, mapIdForZone(msg.zoneId));

      if (isArena) {
        const aiSpawns = runner.getMap().spawnPoints.filter(s => s.team === 'ai');
        const names = ['ai-red', 'ai-blue'];
        aiSpawns.forEach((sp, i) => {
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
      }
    }
    const playerSpawn = runner.getMap().spawnPoints.find(s => s.team === 'player');
    const spawnX = playerSpawn?.x ?? 0;
    const spawnY = playerSpawn?.y ?? 8;
    if (!vehicle) {
      vehicle = makeTestVehicle(msg.vehicleId, 'player', spawnX, spawnY, 0, 60);
    }
    vehicle = {
      ...vehicle,
      position: { x: spawnX, y: spawnY },
      facing: 0,
      speed: 0,
      stats: {
        ...vehicle.stats,
        maxSpeed: Math.min(vehicle.stats.maxSpeed, 100), // cap at 100 mph — sensible Car Wars ceiling
      },
    };
    runner.getEngine().addVehicle(vehicle);
    runner.registerHumanVehicle(msg.vehicleId);
    runner.addClient(ws); // sends initial zone_state automatically
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
    const speed = Math.max(0, Math.min(25, Number(msg.speed) || 0));
    const steer = Math.max(-60, Math.min(60, Number(msg.steer) || 0));
    const fireWeapon = typeof msg.fireWeapon === 'string' && msg.fireWeapon.length <= 20
      ? msg.fireWeapon
      : null;

    const runner = zones.get(zoneId);
    if (runner) {
      runner.queueInput(vehicleId, { speed, steer, fireWeapon });
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
