import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';

let app: ReturnType<typeof createApp>;
let token: string;
let playerId: string;

beforeAll(async () => {
  app = createApp();
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username = 'divtest'`);
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ username: 'divtest', password: 'password123' });
  token = reg.body.token;
  playerId = reg.body.playerId;
});

afterAll(async () => {
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username = 'divtest'`);
  await closeDb();
});

describe('division system', () => {
  it('GET /api/division returns player division and standings', async () => {
    const res = await request(app)
      .get('/api/division')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.division).toBe(5);
    expect(res.body).toHaveProperty('standings');
  });

  it('POST /api/division/recalculate updates division based on vehicle value', async () => {
    const db = getDb();
    await db.query(
      `INSERT INTO vehicles (player_id, name, loadout, damage_state, value)
       VALUES ($1, 'Expensive', '{"chassisId":"heavy","engineId":"v8","suspensionId":"performance","tires":[],"mounts":[],"armor":{"front":10,"back":8,"left":8,"right":8,"top":4,"underbody":4},"totalCost":30000}'::jsonb, '{}'::jsonb, 30000)`,
      [playerId]
    );

    const res = await request(app)
      .post('/api/division/recalculate')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.division).toBe(15);
  });

  it('POST /api/economy/prize awards money and triggers division recalc', async () => {
    const res = await request(app)
      .post('/api/economy/prize')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 5000, eventType: 'arena_win', zoneId: 'arena-1' });
    expect(res.status).toBe(200);
    expect(res.body.moneyNew).toBeGreaterThan(25000);
  });
});
