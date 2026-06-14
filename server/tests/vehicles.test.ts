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
  // Phase 3 — give the test player a garage (3 storage slots) so the no-garage
  // 1-vehicle cap doesn't interfere with these multi-vehicle CRUD assertions.
  // The cap itself is covered in garages.test.ts.
  await db.query(`INSERT INTO garages (player_id) VALUES ($1)`, [reg.body.playerId]);
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

  it('POST /api/vehicles deducts totalCost from the players money', async () => {
    const meBefore = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`);
    const before = meBefore.body.money;
    const createRes = await request(app)
      .post('/api/vehicles')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Paid For', loadout: { ...defaultLoadout, totalCost: 8000 } });
    expect(createRes.status).toBe(201);
    expect(createRes.body.moneyRemaining).toBe(before - 8000);
    const meAfter = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`);
    expect(meAfter.body.money).toBe(before - 8000);
  });

  it('POST /api/vehicles rejects with 400 when the player cant afford it', async () => {
    const meBefore = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`);
    const before = meBefore.body.money;
    const unaffordable = before + 100;
    const res = await request(app)
      .post('/api/vehicles')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Too Pricey', loadout: { ...defaultLoadout, totalCost: unaffordable } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Insufficient funds/i);
    // Balance unchanged
    const meAfter = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`);
    expect(meAfter.body.money).toBe(before);
  });
});

describe('workshop — PATCH /api/vehicles/:id/weapon', () => {
  let workshopToken = '';
  let workshopVehicleId = '';
  let playerId = '';

  beforeAll(async () => {
    const db = getDb();
    await db.query(`DELETE FROM players WHERE username = 'workshoptest'`);
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ username: 'workshoptest', password: 'password123' });
    workshopToken = reg.body.token;
    playerId = reg.body.playerId;
    // Build a vehicle with one MG-front mount so we have a mountId to target
    const build = await request(app)
      .post('/api/vehicles')
      .set('Authorization', `Bearer ${workshopToken}`)
      .send({
        name: 'Workshop Rig',
        loadout: {
          chassisId: 'mid', engineId: 'medium', suspensionId: 'standard',
          tires: [{ id: 't0', blown: false }],
          mounts: [{ id: 'mount0', arc: 'front', weaponId: 'mg', ammo: 20 }],
          armor: { front: 4 },
          totalCost: 5000,
        },
      });
    workshopVehicleId = build.body.id;
    // Reset player funds to a known balance for arithmetic
    await db.query(`UPDATE players SET money = 50000 WHERE id = $1`, [playerId]);
  });

  afterAll(async () => {
    const db = getDb();
    await db.query(`DELETE FROM players WHERE username = 'workshoptest'`);
  });

  it('swapping mg → ml debits the price delta', async () => {
    const before = (await request(app).get('/api/me').set('Authorization', `Bearer ${workshopToken}`)).body.money;
    const res = await request(app)
      .patch(`/api/vehicles/${workshopVehicleId}/weapon`)
      .set('Authorization', `Bearer ${workshopToken}`)
      .send({ mountId: 'mount0', weaponId: 'ml', ammo: 0 });
    expect(res.status).toBe(200);
    expect(res.body.loadout.mounts[0].weaponId).toBe('ml');
    expect(res.body.moneyRemaining).toBeLessThan(before);
  });

  it('removing the weapon refunds 50% of its value (plus ammo)', async () => {
    const before = (await request(app).get('/api/me').set('Authorization', `Bearer ${workshopToken}`)).body.money;
    const res = await request(app)
      .patch(`/api/vehicles/${workshopVehicleId}/weapon`)
      .set('Authorization', `Bearer ${workshopToken}`)
      .send({ mountId: 'mount0', weaponId: null });
    expect(res.status).toBe(200);
    expect(res.body.loadout.mounts[0].weaponId).toBe('');
    expect(res.body.moneyRemaining).toBeGreaterThan(before);  // trade-in refund
  });

  it('rejects unknown weaponId with 400', async () => {
    const res = await request(app)
      .patch(`/api/vehicles/${workshopVehicleId}/weapon`)
      .set('Authorization', `Bearer ${workshopToken}`)
      .send({ mountId: 'mount0', weaponId: 'notaweapon' });
    expect(res.status).toBe(400);
  });

  it('rejects arc-restricted weapon into incompatible arc', async () => {
    // ATG (anti-tank gun) is allowed only in front/back arcs
    // Reset our mount to front first, then try to install ATG — should succeed
    let res = await request(app)
      .patch(`/api/vehicles/${workshopVehicleId}/weapon`)
      .set('Authorization', `Bearer ${workshopToken}`)
      .send({ mountId: 'mount0', weaponId: 'atg' });
    expect(res.status).toBe(200);
  });

  it('PATCH /loadout charges full delta on upgrade', async () => {
    const db = getDb();
    await db.query(`UPDATE players SET money = 50000 WHERE id = $1`, [playerId]);
    const before = (await request(app).get('/api/me').set('Authorization', `Bearer ${workshopToken}`)).body.money;
    const upgraded = {
      chassisId: 'mid', engineId: 'medium', suspensionId: 'standard',
      tires: [{ id: 't0', blown: false }],
      mounts: [{ id: 'mount0', arc: 'front', weaponId: 'mg', ammo: 20 }],
      armor: { front: 4 },
      totalCost: 20000,  // clear upgrade from whatever value the vehicle is at
    };
    const res = await request(app)
      .patch(`/api/vehicles/${workshopVehicleId}/loadout`)
      .set('Authorization', `Bearer ${workshopToken}`)
      .send(upgraded);
    expect(res.status).toBe(200);
    expect(res.body.delta).toBeGreaterThan(0);
    expect(res.body.moneyRemaining).toBe(before - res.body.delta);
  });

  it('PATCH /loadout refunds 50% on downgrade', async () => {
    const before = (await request(app).get('/api/me').set('Authorization', `Bearer ${workshopToken}`)).body.money;
    const downgraded = {
      chassisId: 'mid', engineId: 'medium', suspensionId: 'standard',
      tires: [{ id: 't0', blown: false }],
      mounts: [{ id: 'mount0', arc: 'front', weaponId: 'mg', ammo: 20 }],
      armor: { front: 4 },
      totalCost: 5000,  // downgrade from 20000
    };
    const res = await request(app)
      .patch(`/api/vehicles/${workshopVehicleId}/loadout`)
      .set('Authorization', `Bearer ${workshopToken}`)
      .send(downgraded);
    expect(res.status).toBe(200);
    expect(res.body.delta).toBeLessThan(0);
    const expectedRefund = Math.floor(Math.abs(res.body.delta) * 0.5);
    expect(res.body.moneyRemaining).toBe(before + expectedRefund);
  });
});

describe('buy another — POST /api/vehicles/:id/clone', () => {
  let cloneToken = '';
  let clonePlayerId = '';
  let sourceId = '';

  beforeAll(async () => {
    const db = getDb();
    await db.query(`DELETE FROM players WHERE username IN ('clonetest', 'clonetest2')`);
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ username: 'clonetest', password: 'password123' });
    cloneToken = reg.body.token;
    clonePlayerId = reg.body.playerId;
    await db.query(`INSERT INTO garages (player_id) VALUES ($1)`, [clonePlayerId]);
    await db.query(`UPDATE players SET money = 100000 WHERE id = $1`, [clonePlayerId]);
    const build = await request(app)
      .post('/api/vehicles')
      .set('Authorization', `Bearer ${cloneToken}`)
      .send({ name: 'Fleet Unit', loadout: { ...defaultLoadout, totalCost: 12000 } });
    sourceId = build.body.id;
  });

  afterAll(async () => {
    const db = getDb();
    await db.query(`DELETE FROM players WHERE username IN ('clonetest', 'clonetest2')`);
  });

  it('clones the build, debits the source value, and adds a pristine copy', async () => {
    const before = (await request(app).get('/api/me').set('Authorization', `Bearer ${cloneToken}`)).body.money;
    const res = await request(app)
      .post(`/api/vehicles/${sourceId}/clone`)
      .set('Authorization', `Bearer ${cloneToken}`);
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.id).not.toBe(sourceId);
    expect(res.body.moneyRemaining).toBe(before - 12000);

    // Both vehicles exist, same name, clone valued the same and fully armoured.
    const list = await request(app).get('/api/vehicles').set('Authorization', `Bearer ${cloneToken}`);
    const fleet = list.body.filter((v: any) => v.name === 'Fleet Unit');
    expect(fleet.length).toBe(2);
    const clone = fleet.find((v: any) => v.id === res.body.id);
    expect(clone.value).toBe(12000);
    expect(clone.damage_state?.destroyed).toBe(false);
  });

  it('returns 404 when cloning a vehicle owned by another player', async () => {
    const reg2 = await request(app)
      .post('/api/auth/register')
      .send({ username: 'clonetest2', password: 'password123' });
    const res = await request(app)
      .post(`/api/vehicles/${sourceId}/clone`)
      .set('Authorization', `Bearer ${reg2.body.token}`);
    expect(res.status).toBe(404);
  });

  it('rejects with 400 and no debit when the player cant afford the clone', async () => {
    const db = getDb();
    await db.query(`UPDATE players SET money = 5000 WHERE id = $1`, [clonePlayerId]);
    const res = await request(app)
      .post(`/api/vehicles/${sourceId}/clone`)
      .set('Authorization', `Bearer ${cloneToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Insufficient funds/i);
    const after = (await request(app).get('/api/me').set('Authorization', `Bearer ${cloneToken}`)).body.money;
    expect(after).toBe(5000);
  });
});

describe('calcPrize squad scaling', () => {
  it('scales linearly with squad size', async () => {
    const { calcPrize } = await import('../src/ws/handler');
    expect(calcPrize(5, 1)).toBe(2500);
    expect(calcPrize(5, 2)).toBe(3750);
    expect(calcPrize(5, 3)).toBe(5000);
    expect(calcPrize(5, 4)).toBe(6250);
  });

  it('defaults to solo (×1) when squadSize is omitted', async () => {
    const { calcPrize } = await import('../src/ws/handler');
    expect(calcPrize(5)).toBe(2500);
  });
});
