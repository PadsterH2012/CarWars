import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';

let app: ReturnType<typeof createApp>;
let token: string;
let playerId: string;
let vehicleId: string;

beforeAll(async () => {
  app = createApp();
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username = 'econtest'`);
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ username: 'econtest', password: 'password123' });
  token = reg.body.token;
  playerId = reg.body.playerId;
  const vRes = await request(app)
    .post('/api/vehicles')
    .set('Authorization', `Bearer ${token}`)
    .send({
      name: 'Dented Wreck',
      loadout: {
        chassisId: 'mid', engineId: 'medium', suspensionId: 'standard',
        tires: [{ id: 't0', blown: false }, { id: 't1', blown: false },
                { id: 't2', blown: false }, { id: 't3', blown: false }],
        mounts: [{ id: 'm0', arc: 'front', weaponId: 'mg', ammo: 50 }],
        armor: { front: 6, back: 4, left: 4, right: 4, top: 2, underbody: 2 },
        totalCost: 12000
      }
    });
  vehicleId = vRes.body.id;
});

afterAll(async () => {
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username = 'econtest'`);
  await closeDb();
});

describe('economy', () => {
  it('GET /api/jobs?zoneId=town-1 returns available jobs', async () => {
    const res = await request(app)
      .get('/api/jobs?zoneId=town-1')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Array);
  });

  it('POST /api/economy/repair deducts money and restores armor', async () => {
    const db = getDb();
    await db.query(
      `UPDATE vehicles SET damage_state = $1 WHERE id = $2`,
      [JSON.stringify({
        armor: { front: 2, back: 2, left: 2, right: 2, top: 1, underbody: 1 },
        engineDamaged: false, driverWounded: false, tiresBlown: [], destroyed: false
      }), vehicleId]
    );

    const res = await request(app)
      .post('/api/economy/repair')
      .set('Authorization', `Bearer ${token}`)
      .send({ vehicleId });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('cost');
    expect(res.body.cost).toBeGreaterThan(0);
    expect(res.body.moneyRemaining).toBeLessThan(25000);
  });

  it('POST /api/economy/repair fails if insufficient funds', async () => {
    const db = getDb();
    await db.query(`UPDATE players SET money = 0 WHERE id = $1`, [playerId]);
    await db.query(
      `UPDATE vehicles SET damage_state = $1 WHERE id = $2`,
      [JSON.stringify({
        armor: { front: 0, back: 0, left: 0, right: 0, top: 0, underbody: 0 },
        engineDamaged: true, driverWounded: false, tiresBlown: [], destroyed: false
      }), vehicleId]
    );

    const res = await request(app)
      .post('/api/economy/repair')
      .set('Authorization', `Bearer ${token}`)
      .send({ vehicleId });
    expect(res.status).toBe(402);
  });
});
