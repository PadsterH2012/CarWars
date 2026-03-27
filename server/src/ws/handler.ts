import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import type { ClientMessage, ServerMessage } from '@carwars/shared';
import { createTurnEngine, TurnEngine } from '../rules/engine';

const zones = new Map<string, TurnEngine>();
const clientZones = new Map<WebSocket, string>();
const clientVehicles = new Map<WebSocket, string>();

export function resetState(): void {
  zones.clear();
  clientZones.clear();
  clientVehicles.clear();
}

function removeClientFromZone(ws: WebSocket): void {
  const zoneId = clientZones.get(ws);
  clientZones.delete(ws);
  clientVehicles.delete(ws);

  if (!zoneId) return;

  // Check if any other client is still in this zone
  const zoneStillOccupied = [...clientZones.values()].some(id => id === zoneId);
  if (!zoneStillOccupied) {
    zones.delete(zoneId);
  }
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
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
      zones.set(msg.zoneId, createTurnEngine({
        id: msg.zoneId, type: 'arena', tick: 0, vehicles: []
      }));
    }
    clientZones.set(ws, msg.zoneId);
    clientVehicles.set(ws, msg.vehicleId);
    const engine = zones.get(msg.zoneId)!;
    send(ws, { type: 'zone_state', state: engine.getState() });
    return;
  }

  if (msg.type === 'input') {
    const zoneId = clientZones.get(ws);
    const vehicleId = clientVehicles.get(ws);
    if (!zoneId || !vehicleId) {
      send(ws, { type: 'error', message: 'Not in a zone — send join_zone first' });
      return;
    }
    const engine = zones.get(zoneId);
    if (engine) {
      engine.queueInput(vehicleId, {
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
    ws.on('close', () => {
      removeClientFromZone(ws);
    });
  });

  httpServer.listen(port);
  return httpServer;
}

export function attachWss(server: http.Server): void {
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => handleMessage(ws, data.toString()));
    ws.on('close', () => {
      removeClientFromZone(ws);
    });
  });
}
