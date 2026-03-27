import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { createWsServer, resetState } from '../src/ws/handler';
import type { ServerMessage } from '@carwars/shared';
import * as http from 'http';

describe('WebSocket handler', () => {
  let server: http.Server;
  let ws: WebSocket;

  beforeAll(async () => {
    server = createWsServer(3099);
    await new Promise<void>(r => server.once('listening', r));
    ws = new WebSocket('ws://localhost:3099');
    await new Promise<void>(r => ws.on('open', r));
  });

  afterAll(async () => {
    ws.close();
    await new Promise<void>(r => server.close(() => r()));
    resetState();
  });

  it('responds with error on unknown message type', async () => {
    const msg = await new Promise<ServerMessage>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
      ws.send(JSON.stringify({ type: 'unknown_type' }));
    });
    expect(msg.type).toBe('error');
  });

  it('responds with zone_state when joining a zone', async () => {
    const msg = await new Promise<ServerMessage>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
      ws.send(JSON.stringify({ type: 'join_zone', zoneId: 'test-zone', vehicleId: 'v1' }));
    });
    expect(msg.type).toBe('zone_state');
  });

  it('responds with error when sending input without joining a zone first', async () => {
    // Create a fresh connection that hasn't joined any zone
    const ws2 = new WebSocket('ws://localhost:3099');
    await new Promise<void>(r => ws2.on('open', r));

    const msg = await new Promise<ServerMessage>((resolve) => {
      ws2.once('message', (data) => resolve(JSON.parse(data.toString())));
      ws2.send(JSON.stringify({ type: 'input', tick: 0, speed: 10, steer: 0, fireWeapon: null }));
    });
    ws2.close();
    expect(msg.type).toBe('error');
  });
});
