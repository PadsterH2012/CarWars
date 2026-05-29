import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import request from 'supertest';
import { createWsServer, resetState } from '../src/ws/handler';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';
import type { ServerMessage } from '@carwars/shared';
import * as http from 'http';

const WS_USER = 'ws_arena_join';

describe('WebSocket handler', () => {
  let server: http.Server;
  let ws: WebSocket;

  beforeAll(async () => {
    server = createWsServer(3099);
    await new Promise<void>(r => server.once('listening', r));
    ws = new WebSocket('ws://localhost:3099');
    await new Promise<void>(r => ws.on('open', r));
    await getDb().query(`DELETE FROM players WHERE username = $1`, [WS_USER]);
  });

  afterAll(async () => {
    ws.close();
    await new Promise<void>(r => server.close(() => r()));
    resetState();
    await getDb().query(`DELETE FROM players WHERE username = $1`, [WS_USER]);
    await closeDb();
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

  // Regression (issue #7 follow-up): the arena-entry deployment/job guard added
  // in 9e54866 queried jobs.player_id, a column that doesn't exist, so every
  // join with a REAL (UUID) vehicle threw and the zone never started — the
  // arena rendered no map. The 'v1' test above misses it because a non-UUID
  // vehicle skips the guard entirely. This exercises the real path.
  it('joins the arena with a real, idle vehicle and receives zone_state', async () => {
    const app = createApp();
    const reg = await request(app).post('/api/auth/register').send({ username: WS_USER, password: 'password123' });
    const token = reg.body.token as string;
    const starter = await request(app).post('/api/me/claim-starter').set('Authorization', `Bearer ${token}`).send();
    const vehicleId = starter.body.vehicleId as string;

    const ws3 = new WebSocket('ws://localhost:3099');
    await new Promise<void>(r => ws3.on('open', r));
    const msg = await new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no response — zone join aborted (query threw?)')), 4000);
      ws3.on('message', (data) => { clearTimeout(timer); resolve(JSON.parse(data.toString())); });
      ws3.send(JSON.stringify({ type: 'join_zone', zoneId: 'arena-truck-stop', vehicleId, token }));
    });
    ws3.close();
    expect(msg.type).toBe('zone_state');
  });

  it('calcPrize formula returns division × 500', async () => {
    const { calcPrize } = await import('../src/ws/handler');
    expect(calcPrize(5)).toBe(2500);
    expect(calcPrize(10)).toBe(5000);
    expect(calcPrize(25)).toBe(12500);
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
