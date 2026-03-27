import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import type { ClientMessage, ServerMessage } from '@carwars/shared';
import { ZoneRunner } from '../world/zone-runner';

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

function handleMessage(ws: WebSocket, raw: string): void {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    send(ws, { type: 'error', message: 'Invalid JSON' });
    return;
  }

  if (msg.type === 'join_zone') {
    if (!zones.has(msg.zoneId)) {
      zones.set(msg.zoneId, new ZoneRunner(msg.zoneId));
    }
    clientZones.set(ws, msg.zoneId);
    clientVehicles.set(ws, msg.vehicleId);
    const runner = zones.get(msg.zoneId)!;
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
    const runner = zones.get(zoneId);
    if (runner) {
      runner.queueInput(vehicleId, {
        speed: msg.speed,
        steer: msg.steer,
        fireWeapon: msg.fireWeapon
      });
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
    ws.on('message', (data) => handleMessage(ws, data.toString()));
    ws.on('close', () => removeClientFromZone(ws));
  });

  httpServer.listen(port);
  return httpServer;
}

export function attachWss(server: http.Server): void {
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => handleMessage(ws, data.toString()));
    ws.on('close', () => removeClientFromZone(ws));
  });
}
