import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';

let app: ReturnType<typeof createApp>;
let token: string;
let driverId: string;

beforeAll(async () => {
  app = createApp();
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username = 'drivertest'`);
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ username: 'drivertest', password: 'password123' });
  token = reg.body.token;
});

afterAll(async () => {
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username = 'drivertest'`);
  await closeDb();
});

describe('driver CRUD', () => {
  it('POST /api/drivers hires a driver', async () => {
    const res = await request(app)
      .post('/api/drivers')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Mad Max' });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    driverId = res.body.id;
  });

  it('GET /api/drivers lists player drivers', async () => {
    const res = await request(app)
      .get('/api/drivers')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.some((d: any) => d.id === driverId)).toBe(true);
  });

  it('POST /api/drivers/assign assigns driver to vehicle', async () => {
    const vRes = await request(app)
      .post('/api/vehicles')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Test Car',
        loadout: {
          chassisId: 'mid', engineId: 'medium', suspensionId: 'standard',
          tires: [{ id: 't0', blown: false }, { id: 't1', blown: false },
                  { id: 't2', blown: false }, { id: 't3', blown: false }],
          mounts: [], armor: { front: 4, back: 4, left: 4, right: 4, top: 2, underbody: 2 },
          totalCost: 10000
        }
      });
    const vehicleId = vRes.body.id;

    const res = await request(app)
      .post('/api/drivers/assign')
      .set('Authorization', `Bearer ${token}`)
      .send({ driverId, vehicleId });
    expect(res.status).toBe(200);
  });

  it('GET /api/drivers/candidates returns tiered candidates with a tier field', async () => {
    const res = await request(app)
      .get('/api/drivers/candidates')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const c of res.body) {
      expect(['rookie', 'standard', 'premium']).toContain(c.tier);
    }
    // Rookie tier present and within skill band
    const rookies = res.body.filter((c: any) => c.tier === 'rookie');
    expect(rookies.length).toBeGreaterThan(0);
    for (const r of rookies) expect(r.skill).toBeLessThanOrEqual(2);
  });

  it('premium candidates are gated behind 5 arena wins', async () => {
    const db = getDb();
    const p = await db.query(`SELECT id FROM players WHERE username = 'drivertest'`);
    const pid = p.rows[0].id;

    // Locked: fewer than 5 wins → no premium candidates after a fresh roll
    await db.query(`UPDATE players SET wins = 0 WHERE id = $1`, [pid]);
    await db.query(`DELETE FROM hire_candidates WHERE player_id = $1`, [pid]);
    let res = await request(app)
      .get('/api/drivers/candidates')
      .set('Authorization', `Bearer ${token}`);
    expect(res.body.some((c: any) => c.tier === 'premium')).toBe(false);

    // Unlocked: 5+ wins → premium candidates appear after a fresh roll
    await db.query(`UPDATE players SET wins = 5 WHERE id = $1`, [pid]);
    await db.query(`DELETE FROM hire_candidates WHERE player_id = $1`, [pid]);
    res = await request(app)
      .get('/api/drivers/candidates')
      .set('Authorization', `Bearer ${token}`);
    expect(res.body.some((c: any) => c.tier === 'premium')).toBe(true);
  });

  it('POST /api/drivers/award-xp adds XP to pool (no auto-promote)', async () => {
    const createRes = await request(app)
      .post('/api/drivers')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'XP Test Driver' });
    const driverId = createRes.body.id;

    const db = getDb();
    await db.query(`UPDATE drivers SET xp = 299, skill = 3 WHERE id = $1`, [driverId]);

    const res = await request(app)
      .post('/api/drivers/award-xp')
      .set('Authorization', `Bearer ${token}`)
      .send({ driverId, xp: 10 });

    expect(res.status).toBe(200);
    expect(res.body.newXp).toBe(309);
    expect(res.body.newSkill).toBe(3); // no auto-promote — XP pools separately
    expect(res.body.promoted).toBe(false);
  });
});
