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
});
