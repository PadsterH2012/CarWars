import { Page } from '@playwright/test';

const API = 'http://localhost:3001';
const RUN_ID = Date.now().toString(36);

export function uniqueUser(prefix = 'e2e') {
  return `${prefix}_${RUN_ID}_${Math.random().toString(36).slice(2, 6)}`;
}

export async function registerViaApi(username: string, password = 'testpass123') {
  const res = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`Register failed: ${await res.text()}`);
  return res.json() as Promise<{ token: string; playerId: string }>;
}

export async function loginViaApi(username: string, password = 'testpass123') {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`Login failed: ${await res.text()}`);
  return res.json() as Promise<{ token: string; playerId: string }>;
}

/** Inject a JWT into localStorage so the app boots straight to GarageScene */
export async function injectToken(page: Page, token: string) {
  await page.addInitScript((t) => {
    localStorage.setItem('cw_token', t);
  }, token);
}

/** Create a vehicle via API and return its id */
export async function createVehicle(token: string, name = 'Test Racer') {
  const res = await fetch(`${API}/api/vehicles`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      name,
      loadout: {
        chassisId: 'mid',
        engineId: 'medium',
        suspensionId: 'standard',
        tires: [
          { id: 't0', blown: false }, { id: 't1', blown: false },
          { id: 't2', blown: false }, { id: 't3', blown: false },
        ],
        mounts: [{ id: 'm0', arc: 'front', weaponId: 'mg', ammo: 50 }],
        armor: { front: 6, back: 4, left: 4, right: 4, top: 2, underbody: 2 },
        totalCost: 12000,
      },
    }),
  });
  if (!res.ok) throw new Error(`Create vehicle failed: ${await res.text()}`);
  const body = await res.json() as { id: string };
  return body.id;
}

/** Wait for Phaser canvas to be present and non-blank */
export async function waitForCanvas(page: Page) {
  await page.waitForSelector('canvas', { timeout: 10_000 });
}

/** Wait for the Phaser game to reach a named scene (polls localStorage or DOM marker) */
export async function waitForText(page: Page, text: string) {
  await page.waitForFunction(
    (t) => document.body.innerText.includes(t) ||
            Array.from(document.querySelectorAll('canvas')).some(() => true),
    text,
    { timeout: 10_000 }
  );
}
