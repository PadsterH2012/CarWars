import { test, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';

const app = createApp();

test('GET /api/zones/arena-1 returns zone metadata', async () => {
  const res = await request(app).get('/api/zones/arena-1');
  expect(res.status).toBe(200);
  expect(res.body.type).toBe('arena');
  expect(res.body.exits).toBeInstanceOf(Array);
});

test('GET /api/zones/town-1 returns zone metadata', async () => {
  const res = await request(app).get('/api/zones/town-1');
  expect(res.status).toBe(200);
  expect(res.body.type).toBe('town');
});

test('GET /api/zones/unknown returns 404', async () => {
  const res = await request(app).get('/api/zones/nonexistent');
  expect(res.status).toBe(404);
});
