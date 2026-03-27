/**
 * Phase 3 API tests — job take/complete, damage persistence, repair after damage.
 * Pure fetch, no browser needed.
 *
 * Job tests are serial: they share the seeded job pool in town-1 (3 jobs).
 * Running them serially prevents races where two tests compete for the same job.
 * If all seeded jobs are already taken from a prior run, job tests skip gracefully.
 */
import { test, expect } from '@playwright/test';
import { uniqueUser, registerViaApi, createVehicle } from './helpers';

// Run job tests serially to avoid competing for the shared seeded job pool
test.describe.configure({ mode: 'serial' });

const API = 'http://localhost:3001';

test('job take marks job as unavailable', async () => {
  const { token } = await registerViaApi(uniqueUser('take1'));

  // Get a job from town-1
  const listRes = await fetch(`${API}/api/jobs?zoneId=town-1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const jobs = await listRes.json();
  test.skip(jobs.length === 0, 'No available jobs in town-1 (seeded jobs from previous run are taken)');
  expect(jobs.length).toBeGreaterThan(0);
  const jobId = jobs[0].id;

  // Take it
  const takeRes = await fetch(`${API}/api/jobs/${jobId}/take`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(takeRes.status).toBe(200);

  // A second player cannot take the same job
  const { token: token2 } = await registerViaApi(uniqueUser('take2'));
  const take2Res = await fetch(`${API}/api/jobs/${jobId}/take`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token2}` },
  });
  expect(take2Res.status).toBe(409);
});

test('job complete awards payout', async () => {
  const { token } = await registerViaApi(uniqueUser('comp1'));

  const listRes = await fetch(`${API}/api/jobs?zoneId=town-1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const jobs = await listRes.json();
  test.skip(jobs.length === 0, 'No available jobs in town-1 (seeded jobs from previous run are taken)');
  const job = jobs[0];
  const jobId = job.id;
  const payout = job.payout;

  // Take then complete; new player starts with $25000
  await fetch(`${API}/api/jobs/${jobId}/take`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });

  const completeRes = await fetch(`${API}/api/jobs/${jobId}/complete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(completeRes.status).toBe(200);
  const body = await completeRes.json();
  expect(body.payout).toBe(payout);
  // Starting balance is 25000 (defined in DB migrations)
  expect(body.moneyNew).toBe(25000 + payout);
});

test('job complete cannot be called twice', async () => {
  const { token } = await registerViaApi(uniqueUser('comp2'));

  const listRes = await fetch(`${API}/api/jobs?zoneId=town-1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const jobs = await listRes.json();
  test.skip(jobs.length === 0, 'No available jobs in town-1 (seeded jobs from previous run are taken)');
  const jobId = jobs[0].id;

  await fetch(`${API}/api/jobs/${jobId}/take`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  await fetch(`${API}/api/jobs/${jobId}/complete`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  const res2 = await fetch(`${API}/api/jobs/${jobId}/complete`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  expect(res2.status).toBe(409);
});

test('cannot complete another player\'s job', async () => {
  const { token: t1 } = await registerViaApi(uniqueUser('cj1'));
  const { token: t2 } = await registerViaApi(uniqueUser('cj2'));

  const listRes = await fetch(`${API}/api/jobs?zoneId=town-1`, {
    headers: { Authorization: `Bearer ${t1}` },
  });
  const jobs = await listRes.json();
  test.skip(jobs.length === 0, 'No available jobs in town-1 (seeded jobs from previous run are taken)');
  const jobId = jobs[0].id;

  await fetch(`${API}/api/jobs/${jobId}/take`, {
    method: 'POST', headers: { Authorization: `Bearer ${t1}` },
  });
  const res = await fetch(`${API}/api/jobs/${jobId}/complete`, {
    method: 'POST', headers: { Authorization: `Bearer ${t2}` },
  });
  expect(res.status).toBe(403);
});

test('repair on a new vehicle costs $0', async () => {
  const { token } = await registerViaApi(uniqueUser('rep2'));
  const vehicleId = await createVehicle(token, 'Fresh Car');
  const res = await fetch(`${API}/api/economy/repair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ vehicleId }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).cost).toBe(0);
});

test('prize credits money and adds event history', async () => {
  const { token } = await registerViaApi(uniqueUser('prize2'));
  const res = await fetch(`${API}/api/economy/prize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ amount: 3000, eventType: 'arena_win', zoneId: 'arena-1' }),
  });
  expect(res.status).toBe(200);
  // New player starts with $25000 (defined in DB migrations); prize adds $3000
  expect((await res.json()).moneyNew).toBe(28000);
});
