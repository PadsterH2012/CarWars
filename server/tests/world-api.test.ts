import request from 'supertest';
import { describe, expect, it, afterAll } from 'vitest';
import { createApp } from '../src/app';
import { getDb } from '../src/db/client';

const app = createApp();

async function register(suffix: string): Promise<{ token: string; playerId: string }> {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ username: `worldtest-${suffix}`, password: 'testpw123' });
  if (!res.body.token) throw new Error(`Register failed: ${JSON.stringify(res.body)}`);
  return { token: res.body.token, playerId: res.body.playerId ?? res.body.id };
}

const USERS: string[] = [];
afterAll(async () => {
  const db = getDb();
  for (const u of USERS) {
    await db.query(`DELETE FROM players WHERE username = $1`, [u]);
  }
});

describe('GET /api/world/map', () => {
  it('returns a GeneratedWorld for an authenticated player', async () => {
    const suffix = `map1-${Date.now()}`;
    USERS.push(`worldtest-${suffix}`);
    const { token } = await register(suffix);

    const res = await request(app)
      .get('/api/world/map')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.seed).toBe('number');
    expect(Array.isArray(res.body.settlements)).toBe(true);
    expect(res.body.settlements.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.roads)).toBe(true);
    expect(typeof res.body.playerStartSettlementId).toBe('string');
  });

  it('is idempotent: calling twice returns the same world', async () => {
    const suffix = `map2-${Date.now()}`;
    USERS.push(`worldtest-${suffix}`);
    const { token } = await register(suffix);

    const a = await request(app).get('/api/world/map').set('Authorization', `Bearer ${token}`);
    const b = await request(app).get('/api/world/map').set('Authorization', `Bearer ${token}`);

    expect(a.status).toBe(200);
    expect(a.body.seed).toBe(b.body.seed);
    expect(a.body.settlements.map((s: { id: string }) => s.id))
      .toEqual(b.body.settlements.map((s: { id: string }) => s.id));
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/world/map');
    expect(res.status).toBe(401);
  });
});
