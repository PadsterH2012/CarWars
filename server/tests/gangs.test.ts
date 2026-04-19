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
  await db.query(`DELETE FROM players WHERE username = 'gangtest'`);
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ username: 'gangtest', password: 'password123' });
  token = reg.body.token;
  playerId = reg.body.playerId;
});

afterAll(async () => {
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username = 'gangtest'`);
  await closeDb();
});

describe('gangs API', () => {
  it('register creates a default gang for the player', async () => {
    const res = await request(app).get('/api/gangs/mine').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("gangtest's Gang");
    expect(res.body.treasury).toBe(25000);  // default starting money
    expect(res.body.reputation).toBe(0);
    expect(typeof res.body.primary_colour).toBe('number');
    expect(typeof res.body.secondary_colour).toBe('number');
  });

  it('PATCH updates the gang name', async () => {
    const res = await request(app)
      .patch('/api/gangs/mine')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Tire Biters' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Tire Biters');
  });

  it('PATCH updates colours', async () => {
    const res = await request(app)
      .patch('/api/gangs/mine')
      .set('Authorization', `Bearer ${token}`)
      .send({ primary_colour: 0xff4400, secondary_colour: 0x111111 });
    expect(res.status).toBe(200);
    expect(res.body.primary_colour).toBe(0xff4400);
    expect(res.body.secondary_colour).toBe(0x111111);
  });

  it('PATCH rejects invalid colour', async () => {
    const res = await request(app)
      .patch('/api/gangs/mine')
      .set('Authorization', `Bearer ${token}`)
      .send({ primary_colour: 0x1000000 });  // out of range
    expect(res.status).toBe(400);
  });

  it('PATCH rejects oversized name', async () => {
    const res = await request(app)
      .patch('/api/gangs/mine')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'x'.repeat(65) });
    expect(res.status).toBe(400);
  });

  it('gang treasury mirrors players.money via trigger', async () => {
    // Change the player's money directly and confirm the gang updates
    const db = getDb();
    await db.query(`UPDATE players SET money = $1 WHERE id = $2`, [12345, playerId]);
    const res = await request(app).get('/api/gangs/mine').set('Authorization', `Bearer ${token}`);
    expect(res.body.treasury).toBe(12345);
  });

  it('spending money via build/repair/sell keeps the gang treasury in sync', async () => {
    // Reset money to known value
    const db = getDb();
    await db.query(`UPDATE players SET money = $1 WHERE id = $2`, [20000, playerId]);
    // Build a cheap vehicle — costs $3000
    const buildRes = await request(app)
      .post('/api/vehicles')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Rattler',
        loadout: {
          chassisId: 'mid', engineId: 'medium', suspensionId: 'standard',
          tires: [{ id: 't0', blown: false }],
          mounts: [],
          armor: { front: 4 },
          totalCost: 3000
        }
      });
    expect(buildRes.status).toBe(201);
    const res = await request(app).get('/api/gangs/mine').set('Authorization', `Bearer ${token}`);
    expect(res.body.treasury).toBe(17000);  // 20000 - 3000
  });
});
