/**
 * GarageScene — verify the scene loads and API data is correct.
 * Phaser renders text to canvas, not DOM — so we check scene state
 * via window.game and verify data via API calls.
 */
import { test, expect, Page } from '@playwright/test';
import { uniqueUser, registerViaApi, createVehicle, injectToken } from './helpers';

const API = 'http://localhost:3001';

async function gotoGarage(page: Page, token: string) {
  await injectToken(page, token);
  await page.goto('/');
  await page.waitForSelector('canvas', { timeout: 10_000 });
  // Wait for Phaser to init and GarageScene to become active
  await page.waitForFunction(() => {
    const game = (window as any).game as Phaser.Game | undefined;
    return game?.scene?.isActive('GarageScene') === true;
  }, { timeout: 15_000 });
}

test('garage scene becomes active after token login', async ({ page }) => {
  const { token } = await registerViaApi(uniqueUser('gar1'));
  await gotoGarage(page, token);
  const active = await page.evaluate(() => (window as any).game.scene.isActive('GarageScene'));
  expect(active).toBe(true);
});

test('garage API returns vehicles including newly created one', async ({ page }) => {
  const { token } = await registerViaApi(uniqueUser('gar2'));
  await createVehicle(token, 'Death Machine');

  // Verify via API (what GarageScene fetches)
  const res = await fetch(`${API}/api/vehicles`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const vehicles = await res.json();
  expect(vehicles.some((v: any) => v.name === 'Death Machine')).toBe(true);

  await gotoGarage(page, token);
  const active = await page.evaluate(() => (window as any).game.scene.isActive('GarageScene'));
  expect(active).toBe(true);
});

test('garage API returns empty list when no vehicles', async ({ page }) => {
  const { token } = await registerViaApi(uniqueUser('gar3'));
  const res = await fetch(`${API}/api/vehicles`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const vehicles = await res.json();
  expect(vehicles).toHaveLength(0);

  await gotoGarage(page, token);
  const active = await page.evaluate(() => (window as any).game.scene.isActive('GarageScene'));
  expect(active).toBe(true);
});

test('garage canvas is present and correct size', async ({ page }) => {
  const { token } = await registerViaApi(uniqueUser('gar4'));
  await gotoGarage(page, token);
  const box = await page.locator('canvas').first().boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBe(1280);
  expect(box!.height).toBe(720);
});

test('garage scene can navigate to VehicleDesignerScene', async ({ page }) => {
  const { token } = await registerViaApi(uniqueUser('gar5'));
  await gotoGarage(page, token);

  // Trigger scene switch programmatically (mirrors the BUILD button click)
  await page.evaluate((t) => {
    (window as any).game.scene.start('VehicleDesignerScene', { token: t });
  }, token);

  await page.waitForFunction(() => {
    return (window as any).game?.scene?.isActive('VehicleDesignerScene') === true;
  }, { timeout: 8_000 });

  const active = await page.evaluate(() => (window as any).game.scene.isActive('VehicleDesignerScene'));
  expect(active).toBe(true);
});
