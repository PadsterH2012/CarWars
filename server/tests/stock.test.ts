import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';

let app: ReturnType<typeof createApp>;
let token: string;

beforeAll(async () => {
  app = createApp();
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username IN ('stocktest')`);
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ username: 'stocktest', password: 'password123' });
  token = reg.body.token;
});

afterAll(async () => {
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username = 'stocktest'`);
  await closeDb();
});

describe('stock vehicles', () => {
  it('GET /api/stock returns the seeded catalog', async () => {
    const res = await request(app).get('/api/stock');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(10);
    // Sorted by division then cost
    expect(res.body[0].division).toBeLessThanOrEqual(res.body[res.body.length - 1].division);
  });

  it('GET /api/stock?division=5 filters to that division', async () => {
    const res = await request(app).get('/api/stock?division=5');
    expect(res.status).toBe(200);
    expect(res.body.every((v: any) => v.division === 5)).toBe(true);
  });

  it('GET /api/stock/:id returns a single vehicle', async () => {
    const res = await request(app).get('/api/stock/sprocket');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Sprocket');
    expect(res.body.loadout.bodyType).toBe('compact');
  });

  it('POST /api/stock/:id/purchase creates a vehicle + debits treasury', async () => {
    const meBefore = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`);
    const before = meBefore.body.money;
    const res = await request(app)
      .post('/api/stock/sprocket/purchase')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.cost).toBe(4994);
    expect(res.body.moneyRemaining).toBe(before - 4994);
    // Vehicle shows up in the player's garage
    const list = await request(app).get('/api/vehicles').set('Authorization', `Bearer ${token}`);
    expect(list.body.some((v: any) => v.name === 'Sprocket')).toBe(true);
  });

  it('POST /api/stock/:id/purchase rejects when funds are insufficient', async () => {
    const db = getDb();
    await db.query(`UPDATE players SET money = 100 WHERE username = 'stocktest'`);
    const res = await request(app)
      .post('/api/stock/stormy_weather/purchase')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Insufficient/i);
  });

  it('POST /api/stock/:id/purchase 404s for unknown id', async () => {
    const res = await request(app)
      .post('/api/stock/nonexistent_rig/purchase')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(404);
  });
});
