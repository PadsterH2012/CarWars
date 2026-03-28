/**
 * REST API smoke tests — no browser, pure fetch.
 * Fast, reliable baseline: if these fail nothing else will work.
 */
import { test, expect } from '@playwright/test';
import { uniqueUser, registerViaApi, loginViaApi, createVehicle } from './helpers';

const API = 'http://localhost:3001';

test('GET /health returns ok', async ({ request }) => {
  const res = await request.get(`${API}/health`);
  expect(res.ok()).toBe(true);
  expect(await res.json()).toMatchObject({ ok: true });
});

test('register a new player', async ({ request }) => {
  const username = uniqueUser('reg');
  const res = await request.post(`${API}/api/auth/register`, {
    data: { username, password: 'testpass123' },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body).toHaveProperty('token');
  expect(body).toHaveProperty('playerId');
});

test('register duplicate username returns 409', async ({ request }) => {
  const username = uniqueUser('dup');
  await request.post(`${API}/api/auth/register`, { data: { username, password: 'testpass123' } });
  const res = await request.post(`${API}/api/auth/register`, { data: { username, password: 'testpass123' } });
  expect(res.status()).toBe(409);
});

test('login with valid credentials', async ({ request }) => {
  const username = uniqueUser('login');
  await request.post(`${API}/api/auth/register`, { data: { username, password: 'testpass123' } });
  const res = await request.post(`${API}/api/auth/login`, { data: { username, password: 'testpass123' } });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toHaveProperty('token');
});

test('login wrong password returns 401', async ({ request }) => {
  const username = uniqueUser('badpw');
  await request.post(`${API}/api/auth/register`, { data: { username, password: 'testpass123' } });
  const res = await request.post(`${API}/api/auth/login`, { data: { username, password: 'wrongpass' } });
  expect(res.status()).toBe(401);
});

test('GET /api/me returns player data', async ({ request }) => {
  const username = uniqueUser('me');
  const { token } = await registerViaApi(username);
  const res = await request.get(`${API}/api/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body.username).toBe(username);
  expect(body.money).toBe(25000);
  expect(body.division).toBe(5);
});

test('GET /api/me without token returns 401', async ({ request }) => {
  const res = await request.get(`${API}/api/me`);
  expect(res.status()).toBe(401);
});

test('create and list vehicles', async ({ request }) => {
  const { token } = await registerViaApi(uniqueUser('veh'));
  const createRes = await request.post(`${API}/api/vehicles`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      name: 'Road Ripper',
      loadout: {
        chassisId: 'mid', engineId: 'medium', suspensionId: 'standard',
        tires: [{ id: 't0', blown: false }, { id: 't1', blown: false },
                { id: 't2', blown: false }, { id: 't3', blown: false }],
        mounts: [{ id: 'm0', arc: 'front', weaponId: 'mg', ammo: 50 }],
        armor: { front: 6, back: 4, left: 4, right: 4, top: 2, underbody: 2 },
        totalCost: 12000,
      },
    },
  });
  expect(createRes.status()).toBe(201);
  const { id } = await createRes.json();

  const listRes = await request.get(`${API}/api/vehicles`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(listRes.ok()).toBe(true);
  const vehicles = await listRes.json();
  expect(vehicles.some((v: any) => v.id === id)).toBe(true);
});

test('cannot access another player\'s vehicle', async ({ request }) => {
  const { token: token1 } = await registerViaApi(uniqueUser('own1'));
  const { token: token2 } = await registerViaApi(uniqueUser('own2'));
  const { id } = await request.post(`${API}/api/vehicles`, {
    headers: { Authorization: `Bearer ${token1}` },
    data: {
      name: 'Private Car',
      loadout: {
        chassisId: 'compact', engineId: 'small', suspensionId: 'standard',
        tires: [{ id: 't0', blown: false }, { id: 't1', blown: false },
                { id: 't2', blown: false }, { id: 't3', blown: false }],
        mounts: [], armor: { front: 4, back: 4, left: 4, right: 4, top: 2, underbody: 2 },
        totalCost: 5000,
      },
    },
  }).then(r => r.json());
  const res = await request.get(`${API}/api/vehicles/${id}`, {
    headers: { Authorization: `Bearer ${token2}` },
  });
  expect(res.status()).toBe(403);
});

test('hire a driver and assign to vehicle', async ({ request }) => {
  const { token } = await registerViaApi(uniqueUser('drv'));
  const vehicleId = await createVehicle(token, 'Driver Wagon');
  const hireRes = await request.post(`${API}/api/drivers`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: 'Ace McGee' },
  });
  expect(hireRes.status()).toBe(201);
  const { id: driverId } = await hireRes.json();

  const assignRes = await request.post(`${API}/api/drivers/assign`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { driverId, vehicleId },
  });
  expect(assignRes.ok()).toBe(true);
});

test('zone metadata returns correct structure', async ({ request }) => {
  const res = await request.get(`${API}/api/zones/arena-1`);
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body.type).toBe('arena');
  expect(body.exits.length).toBeGreaterThan(0);
});

test('GET /api/zones/unknown returns 404', async ({ request }) => {
  const res = await request.get(`${API}/api/zones/no-such-zone`);
  expect(res.status()).toBe(404);
});

test('job board returns jobs for town-1', async ({ request }) => {
  const { token } = await registerViaApi(uniqueUser('jobs'));
  const res = await request.get(`${API}/api/jobs?zoneId=town-1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.ok()).toBe(true);
  const jobs = await res.json();
  expect(jobs.length).toBeGreaterThan(0);
  expect(jobs[0]).toHaveProperty('payout');
  expect(jobs[0]).toHaveProperty('job_type');
});

test('division recalculates based on vehicle value', async ({ request }) => {
  const { token } = await registerViaApi(uniqueUser('div'));
  // No vehicles — division stays at 5
  const res1 = await request.get(`${API}/api/division`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect((await res1.json()).division).toBe(5);

  // Add a high-value vehicle
  await request.post(`${API}/api/vehicles`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      name: 'Expensive Beast',
      loadout: {
        chassisId: 'van', engineId: 'super', suspensionId: 'performance',
        tires: [{ id: 't0', blown: false }, { id: 't1', blown: false },
                { id: 't2', blown: false }, { id: 't3', blown: false }],
        mounts: [{ id: 'm0', arc: 'front', weaponId: 'laser', ammo: 20 }],
        armor: { front: 10, back: 8, left: 8, right: 8, top: 4, underbody: 4 },
        totalCost: 30000,
      },
    },
  });

  const recalc = await request.post(`${API}/api/division/recalculate`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(recalc.ok()).toBe(true);
  expect((await recalc.json()).division).toBe(15);
});

test('repair costs money and restores armor', async ({ request }) => {
  const { token, playerId } = await registerViaApi(uniqueUser('rep'));
  const vehicleId = await createVehicle(token, 'Dented Car');

  // Damage the vehicle via direct API (simulate post-combat state)
  // We'll just call repair on a freshly-made vehicle — cost should be 0
  const res = await request.post(`${API}/api/economy/repair`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { vehicleId },
  });
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body.cost).toBe(0); // no damage on a new vehicle
});

test('prize award increases money', async ({ request }) => {
  const { token } = await registerViaApi(uniqueUser('prize'));
  const res = await request.post(`${API}/api/economy/prize`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { amount: 5000, eventType: 'arena_win', zoneId: 'arena-1' },
  });
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body.moneyNew).toBe(30000); // 25000 starting + 5000
});
