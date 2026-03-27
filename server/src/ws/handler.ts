import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import jwt from 'jsonwebtoken';
import type { ClientMessage, ServerMessage, VehicleState, VehicleLoadout, DamageState } from '@carwars/shared';
import { ZoneRunner } from '../world/zone-runner';
import { getDb } from '../db/client';
import { deriveStats } from '../rules/vehicle';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-prod';

async function loadVehicleFromDb(vehicleId: string, token: string): Promise<VehicleState | null> {
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
    id: row.id,
    playerId,
    driverId: null,
    position: { x: 0, y: 0 },
    facing: 0,
    speed: 0,
    stats
  };
}

function makeTestVehicle(id: string, playerId: string, x: number, y: number, facing = 0): VehicleState {
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
      maxSpeed: 15, handlingClass: 3, weight: 3000
    }
  };
}

const zones = new Map<string, ZoneRunner>();
const clientZones = new Map<WebSocket, string>();
const clientVehicles = new Map<WebSocket, string>();

export function resetState(): void {
  zones.forEach(runner => runner.shutdown());
  zones.clear();
  clientZones.clear();
  clientVehicles.clear();
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function removeClientFromZone(ws: WebSocket): void {
  const zoneId = clientZones.get(ws);
  clientZones.delete(ws);
  clientVehicles.delete(ws);

  if (!zoneId) return;

  const runner = zones.get(zoneId);
  if (runner) {
    runner.removeClient(ws);
    if (runner.isEmpty()) {
      zones.delete(zoneId);
    }
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
    if (!zones.has(msg.zoneId)) {
      const runner = new ZoneRunner(msg.zoneId);
      // Spawn two AI opponents in the arena
      runner.getEngine().addVehicle(makeTestVehicle('ai-red', 'ai-team', -8, -6, 90));
      runner.getEngine().addVehicle(makeTestVehicle('ai-blue', 'ai-team', 8, 6, 270));
      zones.set(msg.zoneId, runner);
    }
    clientZones.set(ws, msg.zoneId);
    clientVehicles.set(ws, msg.vehicleId);
    const runner = zones.get(msg.zoneId)!;
    // Spawn the player's vehicle if not already in the zone
    const existing = runner.getEngine().getState().vehicles.find(v => v.id === msg.vehicleId);
    if (!existing) {
      // Try DB hydration first; fall back to test fixture for dev convenience
      let vehicle: VehicleState | null = null;
      if (msg.token) {
        vehicle = await loadVehicleFromDb(msg.vehicleId, msg.token);
      }
      if (!vehicle) {
        vehicle = makeTestVehicle(msg.vehicleId, 'player', 0, 0, 0);
      }
      runner.getEngine().addVehicle(vehicle);
    }
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

  if (msg.type === 'leave_zone') {
    removeClientFromZone(ws);
    return;
  }

  send(ws, { type: 'error', message: `Unknown message type: ${(msg as any).type}` });
}

export function createWsServer(port: number): http.Server {
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    ws.on('message', (data) => { handleMessage(ws, data.toString()).catch(console.error); });
    ws.on('close', () => removeClientFromZone(ws));
  });

  httpServer.listen(port);
  return httpServer;
}

export function attachWss(server: http.Server): void {
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => { handleMessage(ws, data.toString()).catch(console.error); });
    ws.on('close', () => removeClientFromZone(ws));
  });
}
