import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';

let app: ReturnType<typeof createApp>;
let token: string;
let vehicleId: string;

beforeAll(async () => {
  app = createApp();
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username IN ('vehicletest', 'vehicletest2')`);
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ username: 'vehicletest', password: 'password123' });
  token = reg.body.token;
});

afterAll(async () => {
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username = 'vehicletest'`);
  await closeDb();
});

const defaultLoadout = {
  chassisId: 'mid',
  engineId: 'medium',
  suspensionId: 'standard',
  tires: [{ id: 't0', blown: false }, { id: 't1', blown: false }, { id: 't2', blown: false }, { id: 't3', blown: false }],
  mounts: [{ id: 'm0', arc: 'front', weaponId: 'mg', ammo: 50 }],
  armor: { front: 6, back: 4, left: 4, right: 4, top: 2, underbody: 2 },
  totalCost: 12000
};

describe('vehicle CRUD', () => {
  it('POST /api/vehicles creates a vehicle', async () => {
    const res = await request(app)
      .post('/api/vehicles')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Road Killer', loadout: defaultLoadout });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    vehicleId = res.body.id;
  });

  it('GET /api/vehicles lists player vehicles', async () => {
    const res = await request(app)
      .get('/api/vehicles')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0].name).toBe('Road Killer');
  });

  it('GET /api/vehicles/:id returns vehicle', async () => {
    const res = await request(app)
      .get(`/api/vehicles/${vehicleId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(vehicleId);
  });

  it('GET /api/vehicles/:id owned by another player returns 403', async () => {
    const reg2 = await request(app)
      .post('/api/auth/register')
      .send({ username: 'vehicletest2', password: 'password123' });
    const token2 = reg2.body.token;
    const res = await request(app)
      .get(`/api/vehicles/${vehicleId}`)
      .set('Authorization', `Bearer ${token2}`);
    expect(res.status).toBe(403);
    const db = getDb();
    await db.query(`DELETE FROM players WHERE username = 'vehicletest2'`);
  });

  it('DELETE /api/vehicles/:id sells vehicle for 50% of value and credits money', async () => {
    const createRes = await request(app)
      .post('/api/vehicles')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'For Sale',
        loadout: {
          chassisId: 'mid', engineId: 'medium', suspensionId: 'standard',
          tires: [{ id: 't0', blown: false }],
          mounts: [],
          armor: { front: 4, back: 4 },
          totalCost: 10000
        }
      });
    const sellId = createRes.body.id;

    const meBeforeRes = await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${token}`);
    const moneyBefore = meBeforeRes.body.money;

    const res = await request(app)
      .delete(`/api/vehicles/${sellId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.salePrice).toBe(5000); // 50% of 10000

    const meAfterRes = await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${token}`);
    expect(meAfterRes.body.money).toBe(moneyBefore + 5000);
  });
});
