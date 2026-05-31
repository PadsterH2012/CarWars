import request from 'supertest';
import { describe, it, expect, afterAll } from 'vitest';
import { createApp } from '../src/app';
import { getDb } from '../src/db/client';

const app = createApp();

async function register(suffix: string): Promise<{ token: string; playerId: string }> {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ username: `terrtest-${suffix}`, password: 'testpw123' });
  if (!res.body.token) throw new Error(`Register failed: ${JSON.stringify(res.body)}`);
  return { token: res.body.token, playerId: res.body.playerId };
}

const USERS: string[] = [];
afterAll(async () => {
  const db = getDb();
  for (const u of USERS) {
    await db.query(`DELETE FROM players WHERE username = $1`, [u]);
  }
});

describe('GET /api/territory/influence', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/territory/influence');
    expect(res.status).toBe(401);
  });

  it('returns bySettlement map for authenticated player', async () => {
    const suffix = `ti1-${Date.now()}`;
    USERS.push(`terrtest-${suffix}`);
    const { token } = await register(suffix);

    // Trigger world + gang generation
    await request(app).get('/api/world/map').set('Authorization', `Bearer ${token}`);

    const res = await request(app)
      .get('/api/territory/influence')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.bySettlement).toBe('object');
    const entries = Object.values(res.body.bySettlement as Record<string, unknown[]>);
    expect(entries.length).toBeGreaterThan(0);
  });
});

describe('GET /api/territory/player-influence', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/territory/player-influence');
    expect(res.status).toBe(401);
  });

  it('returns player influence overview', async () => {
    const suffix = `ti2-${Date.now()}`;
    USERS.push(`terrtest-${suffix}`);
    const { token } = await register(suffix);

    await request(app).get('/api/world/map').set('Authorization', `Bearer ${token}`);

    const res = await request(app)
      .get('/api/territory/player-influence')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.totalInfluence).toBe('number');
    expect(Array.isArray(res.body.settlements)).toBe(true);
  });
});
