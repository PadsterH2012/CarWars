import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';

let app: ReturnType<typeof createApp>;

const USERS = ['garagebuyer', 'garagecap', 'garageincome', 'garagerepair'];

// Minimal loadout that passes deriveStats + computeCapacity (mirrors the
// working minimal build used in vehicles.test.ts).
const loadout = {
  chassisId: 'mid',
  engineId: 'medium',
  suspensionId: 'standard',
  tires: [{ id: 't0', blown: false }],
  mounts: [],
  armor: { front: 6, back: 4 },
  totalCost: 5000,
};

async function register(username: string) {
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ username, password: 'password123' });
  return { token: reg.body.token as string, playerId: reg.body.playerId as string };
}

beforeAll(async () => {
  app = createApp();
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username = ANY($1)`, [USERS]);
});

afterAll(async () => {
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username = ANY($1)`, [USERS]);
  await closeDb();
});

describe('garage purchase', () => {
  let token: string, playerId: string;
  beforeAll(async () => { ({ token, playerId } = await register('garagebuyer')); });

  it('GET /api/garages reports not owned before purchase', async () => {
    const res = await request(app).get('/api/garages').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.owned).toBe(false);
    expect(res.body.cost).toBe(50000);
    expect(res.body.maxVehicles).toBe(1);
  });

  it('rejects purchase when funds are insufficient', async () => {
    const db = getDb();
    await db.query(`UPDATE players SET money = 1000 WHERE id = $1`, [playerId]);
    const res = await request(app).post('/api/garages/purchase').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Insufficient/i);
  });

  it('purchases a garage for $50,000 and debits money', async () => {
    const db = getDb();
    await db.query(`UPDATE players SET money = 60000 WHERE id = $1`, [playerId]);
    const res = await request(app).post('/api/garages/purchase').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(201);
    expect(res.body.moneyRemaining).toBe(10000);
    expect(res.body.garage.repair_discount).toBeCloseTo(0.25);
    expect(res.body.garage.storage_slots).toBe(3);
  });

  it('rejects a second garage', async () => {
    const db = getDb();
    await db.query(`UPDATE players SET money = 60000 WHERE id = $1`, [playerId]);
    const res = await request(app).post('/api/garages/purchase').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already own/i);
  });

  it('GET /api/garages reports owned with 3 slots after purchase', async () => {
    const res = await request(app).get('/api/garages').set('Authorization', `Bearer ${token}`);
    expect(res.body.owned).toBe(true);
    expect(res.body.maxVehicles).toBe(3);
    expect(res.body.repairDiscount).toBeCloseTo(0.25);
  });
});

describe('vehicle storage cap', () => {
  let token: string, playerId: string;
  beforeAll(async () => {
    ({ token, playerId } = await register('garagecap'));
    const db = getDb();
    await db.query(`UPDATE players SET money = 100000 WHERE id = $1`, [playerId]);
  });

  it('allows the first vehicle without a garage', async () => {
    const res = await request(app).post('/api/vehicles').set('Authorization', `Bearer ${token}`).send({ name: 'First', loadout });
    expect(res.status).toBe(201);
  });

  it('blocks the second vehicle without a garage', async () => {
    const res = await request(app).post('/api/vehicles').set('Authorization', `Bearer ${token}`).send({ name: 'Second', loadout });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Vehicle limit reached/i);
  });

  it('allows more vehicles after buying a garage', async () => {
    const db = getDb();
    await db.query(`INSERT INTO garages (player_id) VALUES ($1)`, [playerId]);
    const second = await request(app).post('/api/vehicles').set('Authorization', `Bearer ${token}`).send({ name: 'Second', loadout });
    expect(second.status).toBe(201);
    const third = await request(app).post('/api/vehicles').set('Authorization', `Bearer ${token}`).send({ name: 'Third', loadout });
    expect(third.status).toBe(201);
  });

  it('blocks the fourth vehicle (cap is 3 with a garage)', async () => {
    const res = await request(app).post('/api/vehicles').set('Authorization', `Bearer ${token}`).send({ name: 'Fourth', loadout });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Vehicle limit reached/i);
  });
});

describe('garage passive income', () => {
  let token: string, playerId: string;
  beforeAll(async () => {
    ({ token, playerId } = await register('garageincome'));
    const db = getDb();
    await db.query(`INSERT INTO garages (player_id, last_income_at) VALUES ($1, NOW() - INTERVAL '5 hours')`, [playerId]);
    await db.query(`UPDATE players SET money = 0 WHERE id = $1`, [playerId]);
  });

  it('credits $200 per elapsed hour on visit', async () => {
    const res = await request(app).get('/api/garages').set('Authorization', `Bearer ${token}`);
    expect(res.body.incomeThisVisit).toBe(1000); // 5 hours * $200
    expect(res.body.accumulatedIncome).toBe(1000);
    const me = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`);
    expect(me.body.money).toBe(1000);
  });

  it('does not double-credit on an immediate second visit', async () => {
    const res = await request(app).get('/api/garages').set('Authorization', `Bearer ${token}`);
    expect(res.body.incomeThisVisit).toBe(0);
    const me = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`);
    expect(me.body.money).toBe(1000);
  });
});

describe('garage repair discount', () => {
  let token: string, playerId: string, vehId: string;
  beforeAll(async () => {
    ({ token, playerId } = await register('garagerepair'));
    const db = getDb();
    await db.query(`UPDATE players SET money = 100000 WHERE id = $1`, [playerId]);
    const build = await request(app)
      .post('/api/vehicles')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Dented', loadout: { ...loadout, totalCost: 8000 } });
    vehId = build.body.id;
    // Knock front armor to 0 (original is 6) so there's a non-zero repair bill.
    await db.query(
      `UPDATE vehicles SET damage_state = jsonb_set(damage_state, '{armor,front}', '0'::jsonb) WHERE id = $1`,
      [vehId],
    );
  });

  it('quote shows no discount without a garage', async () => {
    const res = await request(app).get(`/api/economy/repair/quote?vehicleId=${vehId}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body.repairDiscount).toBe(0);
    expect(res.body.discountedTotal).toBe(res.body.total);
  });

  it('quote applies a 25% discount with a garage', async () => {
    const db = getDb();
    await db.query(`INSERT INTO garages (player_id) VALUES ($1)`, [playerId]);
    const res = await request(app).get(`/api/economy/repair/quote?vehicleId=${vehId}`).set('Authorization', `Bearer ${token}`);
    expect(res.body.repairDiscount).toBeCloseTo(0.25);
    expect(res.body.discountedTotal).toBe(Math.round(res.body.total * 0.75));
  });

  it('charges the discounted amount on repair', async () => {
    const meBefore = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`);
    const before = meBefore.body.money;
    const quote = await request(app).get(`/api/economy/repair/quote?vehicleId=${vehId}`).set('Authorization', `Bearer ${token}`);
    const expectedCost = Math.round(quote.body.total * 0.75);
    const res = await request(app).post('/api/economy/repair').set('Authorization', `Bearer ${token}`).send({ vehicleId: vehId });
    expect(res.status).toBe(200);
    expect(res.body.cost).toBe(expectedCost);
    const meAfter = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`);
    expect(meAfter.body.money).toBe(before - expectedCost);
  });
});
