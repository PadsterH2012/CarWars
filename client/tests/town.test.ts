// Run with: npx vitest run tests/town.test.ts
// Requires server to be running on :3001

const BASE = 'http://localhost:3001';

const RUN_ID = Date.now();

async function register(username: string) {
  username = `${username}_${RUN_ID}`;
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'testpass123' })
  });
  const body = await res.json();
  return body.token as string;
}

test('can fetch vehicles with token', async () => {
  const token = await register('towntest1');
  const res = await fetch(`${BASE}/api/vehicles`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body)).toBe(true);
}, { timeout: 10000 });

test('can fetch jobs for town-1', async () => {
  const token = await register('towntest2');
  const res = await fetch(`${BASE}/api/jobs?zoneId=town-1`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.length).toBeGreaterThan(0);
}, { timeout: 10000 });
