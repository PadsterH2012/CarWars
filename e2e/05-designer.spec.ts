/**
 * VehicleDesignerScene — scene loads correctly, API validation works.
 * Phaser renders to canvas; we verify scene state + API behaviour.
 */
import { test, expect, Page } from '@playwright/test';
import { uniqueUser, registerViaApi, injectToken } from './helpers';

const API = 'http://localhost:3001';

async function gotoDesigner(page: Page, token: string) {
  await injectToken(page, token);
  await page.goto('/');
  await page.waitForSelector('canvas', { timeout: 10_000 });
  await page.waitForFunction(() => (window as any).game !== undefined, { timeout: 10_000 });
  await page.evaluate((t) => {
    (window as any).game.scene.start('VehicleDesignerScene', { token: t });
  }, token);
  await page.waitForFunction(() => {
    return (window as any).game?.scene?.isActive('VehicleDesignerScene') === true;
  }, { timeout: 8_000 });
}

test('designer scene becomes active', async ({ page }) => {
  const { token } = await registerViaApi(uniqueUser('des1'));
  await gotoDesigner(page, token);
  const active = await page.evaluate(() => (window as any).game.scene.isActive('VehicleDesignerScene'));
  expect(active).toBe(true);
});

test('designer canvas is correct size', async ({ page }) => {
  const { token } = await registerViaApi(uniqueUser('des2'));
  await gotoDesigner(page, token);
  const box = await page.locator('canvas').first().boundingBox();
  expect(box!.width).toBe(1280);
  expect(box!.height).toBe(720);
});

test('designer can create a vehicle via API with valid loadout', async ({ page }) => {
  const { token } = await registerViaApi(uniqueUser('des3'));

  const res = await fetch(`${API}/api/vehicles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: 'Designer Special',
      loadout: {
        chassisId: 'compact', engineId: 'small', suspensionId: 'standard',
        tires: [{ id: 't0', blown: false }, { id: 't1', blown: false },
                { id: 't2', blown: false }, { id: 't3', blown: false }],
        mounts: [{ id: 'm0', arc: 'front', weaponId: 'rl', ammo: 10 }],
        armor: { front: 4, back: 3, left: 3, right: 3, top: 1, underbody: 1 },
        totalCost: 8000,
      },
    }),
  });
  expect(res.status).toBe(201);
  const { id } = await res.json();

  const listRes = await fetch(`${API}/api/vehicles`, { headers: { Authorization: `Bearer ${token}` } });
  const list = await listRes.json();
  expect(list.some((v: any) => v.id === id)).toBe(true);
});

test('invalid chassis id rejected by API', async ({ page }) => {
  const { token } = await registerViaApi(uniqueUser('des4'));
  const res = await fetch(`${API}/api/vehicles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: 'Bad Vehicle',
      loadout: {
        chassisId: 'light',  // invalid
        engineId: 'medium', suspensionId: 'standard',
        tires: [{ id: 't0', blown: false }, { id: 't1', blown: false },
                { id: 't2', blown: false }, { id: 't3', blown: false }],
        mounts: [], armor: { front: 4, back: 4, left: 4, right: 4, top: 2, underbody: 2 },
        totalCost: 5000,
      },
    }),
  });
  expect(res.status).toBe(400);
});

test('invalid engine id rejected by API', async ({ page }) => {
  const { token } = await registerViaApi(uniqueUser('des5'));
  const res = await fetch(`${API}/api/vehicles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: 'Bad Engine',
      loadout: {
        chassisId: 'mid',
        engineId: 'v8',  // invalid — should be super
        suspensionId: 'standard',
        tires: [{ id: 't0', blown: false }, { id: 't1', blown: false },
                { id: 't2', blown: false }, { id: 't3', blown: false }],
        mounts: [], armor: { front: 4, back: 4, left: 4, right: 4, top: 2, underbody: 2 },
        totalCost: 5000,
      },
    }),
  });
  expect(res.status).toBe(400);
});
