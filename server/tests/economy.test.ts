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
  it('GET /api/jobs is gone (arena-job board retired)', async () => {
    const res = await request(app)
      .get('/api/jobs?zoneId=town-1')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
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

  it('repair restores blown tires and deducts tire cost', async () => {
    const db = getDb();
    await db.query(
      `UPDATE vehicles SET damage_state = $1 WHERE id = $2`,
      [JSON.stringify({
        armor: { front: 6, back: 4, left: 4, right: 4, top: 2, underbody: 2 },
        engineDamaged: false, driverWounded: false, tiresBlown: [0, 1], destroyed: false
      }), vehicleId]
    );
    await db.query(`UPDATE players SET money = 25000 WHERE id = $1`, [playerId]);

    const res = await request(app)
      .post('/api/economy/repair')
      .set('Authorization', `Bearer ${token}`)
      .send({ vehicleId });

    expect(res.status).toBe(200);
    // Legacy loadout (no tireType) — falls back to TIRE_REPAIR_FALLBACK = $50/tire
    expect(res.body.cost).toBe(100); // 2 tires × $50 fallback (real tireType uses tire.costPerTire, e.g. $50 standard / $1000 plasticore)
    const vRes = await db.query(`SELECT damage_state FROM vehicles WHERE id = $1`, [vehicleId]);
    expect(vRes.rows[0].damage_state.tiresBlown).toEqual([]);
  });

  it('repair restores ammo and charges ammoCost per round', async () => {
    const db = getDb();
    // Deplete ammo on mount m0 (mg, ammoCost: $25/round, original: 50 rounds)
    await db.query(
      `UPDATE vehicles SET
         damage_state = $1,
         loadout = jsonb_set(loadout, '{mounts,0,ammo}', '10')
       WHERE id = $2`,
      [JSON.stringify({
        armor: { front: 6, back: 4, left: 4, right: 4, top: 2, underbody: 2 },
        engineDamaged: false, driverWounded: false, tiresBlown: [], destroyed: false
      }), vehicleId]
    );
    await db.query(`UPDATE players SET money = 25000 WHERE id = $1`, [playerId]);

    const res = await request(app)
      .post('/api/economy/repair')
      .set('Authorization', `Bearer ${token}`)
      .send({ vehicleId });

    expect(res.status).toBe(200);
    expect(res.body.cost).toBe(1000); // 40 rounds × $25 ammoCost (mg weapon, see WEAPONS data)
    const vRes = await db.query(`SELECT loadout FROM vehicles WHERE id = $1`, [vehicleId]);
    expect(vRes.rows[0].loadout.mounts[0].ammo).toBe(50);
  });

  it('repair restores free-ammo weapons (ammoCost=0) at zero cost', async () => {
    const db = getDb();
    // Swap the existing vehicle's weapon to a grenade launcher (ammoCost: 0, shotsPerMag: 10)
    // and deplete its ammo to 2, simulating a post-match state.
    const glLoadout = {
      chassisId: 'mid', engineId: 'medium', suspensionId: 'standard',
      tires: [{ id: 't0', blown: false }, { id: 't1', blown: false },
              { id: 't2', blown: false }, { id: 't3', blown: false }],
      mounts: [{ id: 'm0', arc: 'front', weaponId: 'gl', ammo: 10 }],
      armor: { front: 6, back: 4, left: 4, right: 4, top: 2, underbody: 2 },
      totalCost: 5000,
    };
    // Set both loadout (depleted) and original_loadout (full) directly in the DB.
    const depleted = { ...glLoadout, mounts: [{ id: 'm0', arc: 'front', weaponId: 'gl', ammo: 2 }] };
    await db.query(
      `UPDATE vehicles SET loadout = $1, original_loadout = $2,
         damage_state = $3
       WHERE id = $4`,
      [JSON.stringify(depleted), JSON.stringify(glLoadout),
       JSON.stringify({ armor: { front: 6, back: 4, left: 4, right: 4, top: 2, underbody: 2 }, engineDamaged: false, driverWounded: false, tiresBlown: [], destroyed: false }),
       vehicleId],
    );
    await db.query(`UPDATE players SET money = 25000 WHERE id = $1`, [playerId]);

    const moneyBefore = (await db.query(`SELECT money FROM players WHERE id = $1`, [playerId])).rows[0].money;

    const res = await request(app)
      .post('/api/economy/repair')
      .set('Authorization', `Bearer ${token}`)
      .send({ vehicleId, parts: ['ammo'] });

    expect(res.status).toBe(200);
    expect(res.body.cost).toBe(0); // grenades are free to refill

    // Ammo must be restored to original 10 rounds.
    const vRes = await db.query(`SELECT loadout FROM vehicles WHERE id = $1`, [vehicleId]);
    expect(vRes.rows[0].loadout.mounts[0].ammo).toBe(10);

    // Money unchanged (free repair).
    const moneyAfter = (await db.query(`SELECT money FROM players WHERE id = $1`, [playerId])).rows[0].money;
    expect(moneyAfter).toBe(moneyBefore);
  });
});
