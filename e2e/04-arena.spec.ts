/**
 * ArenaScene — WebSocket connection, vehicle rendering, movement.
 * We inject a token and vehicleId via localStorage so we can boot
 * directly into the ArenaScene by manipulating Phaser's scene manager.
 */
import { test, expect, Page } from '@playwright/test';
import { uniqueUser, registerViaApi, createVehicle, injectToken } from './helpers';

const WS_URL = 'ws://localhost:3001';

/** Boot directly into ArenaScene by injecting token + vehicleId and
 *  triggering scene.start via the global Phaser game object. */
async function gotoArena(page: Page, token: string, vehicleId: string) {
  await injectToken(page, token);
  await page.goto('/');
  await page.waitForSelector('canvas', { timeout: 10_000 });

  // Wait for Phaser to initialise, then switch to ArenaScene directly
  await page.waitForFunction(() => (window as any).game !== undefined, { timeout: 10_000 });
  await page.evaluate(({ t, v }) => {
    const game = (window as any).game as Phaser.Game;
    game.scene.start('ArenaScene', { token: t, vehicleId: v });
  }, { t: token, v: vehicleId });

  // ArenaScene connects WebSocket — wait for connection
  await page.waitForTimeout(2000);
}

test('arena canvas renders', async ({ page }) => {
  const { token } = await registerViaApi(uniqueUser('arena1'));
  const vehicleId = await createVehicle(token, 'Arena Car');
  await gotoArena(page, token, vehicleId);

  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  expect(box!.width).toBe(1280);
  expect(box!.height).toBe(720);
});

test('arena WebSocket connects and receives zone_state', async ({ page }) => {
  const { token } = await registerViaApi(uniqueUser('arena2'));
  const vehicleId = await createVehicle(token, 'WS Tester');

  // Intercept WebSocket messages
  const messages: string[] = [];
  await page.exposeFunction('recordWsMsg', (msg: string) => messages.push(msg));
  await page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    (window as any).WebSocket = class extends OrigWS {
      constructor(url: string, proto?: string | string[]) {
        super(url, proto);
        this.addEventListener('message', (e: MessageEvent) => {
          (window as any).recordWsMsg(e.data);
        });
      }
    };
  });

  await gotoArena(page, token, vehicleId);
  await page.waitForTimeout(1500);

  // Should have received at least one zone_state message
  const zoneStateMsg = messages.find(m => m.includes('"zone_state"'));
  expect(zoneStateMsg).toBeTruthy();
  const parsed = JSON.parse(zoneStateMsg!);
  expect(parsed.state).toHaveProperty('vehicles');
  expect(parsed.state.vehicles.length).toBeGreaterThanOrEqual(1);
});

test('arena has player vehicle in zone state', async ({ page }) => {
  const { token } = await registerViaApi(uniqueUser('arena3'));
  const vehicleId = await createVehicle(token, 'My Vehicle');

  const messages: string[] = [];
  await page.exposeFunction('recordWsMsg', (msg: string) => messages.push(msg));
  await page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    (window as any).WebSocket = class extends OrigWS {
      constructor(url: string, proto?: string | string[]) {
        super(url, proto);
        this.addEventListener('message', (e: MessageEvent) => {
          (window as any).recordWsMsg(e.data);
        });
      }
    };
  });

  await gotoArena(page, token, vehicleId);
  await page.waitForTimeout(1500);

  // Find a zone_state that contains our vehicleId
  const found = messages
    .filter(m => m.includes('"zone_state"'))
    .some(m => m.includes(vehicleId));
  expect(found).toBe(true);
});

test('arena has AI opponents', async ({ page }) => {
  const { token } = await registerViaApi(uniqueUser('arena4'));
  const vehicleId = await createVehicle(token, 'AI Battle');

  const messages: string[] = [];
  await page.exposeFunction('recordWsMsg', (msg: string) => messages.push(msg));
  await page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    (window as any).WebSocket = class extends OrigWS {
      constructor(url: string, proto?: string | string[]) {
        super(url, proto);
        this.addEventListener('message', (e: MessageEvent) => {
          (window as any).recordWsMsg(e.data);
        });
      }
    };
  });

  await gotoArena(page, token, vehicleId);
  await page.waitForTimeout(1500);

  const zoneStateMsg = messages.find(m => m.includes('"zone_state"') && m.includes('ai-red'));
  expect(zoneStateMsg).toBeTruthy();
  const parsed = JSON.parse(zoneStateMsg!);
  expect(parsed.state.vehicles.some((v: any) => v.id === 'ai-red')).toBe(true);
  expect(parsed.state.vehicles.some((v: any) => v.id === 'ai-blue')).toBe(true);
});

test('vehicles move between ticks', async ({ page }) => {
  const { token } = await registerViaApi(uniqueUser('arena5'));
  const vehicleId = await createVehicle(token, 'Movement Test');

  const positions: { id: string; x: number; y: number }[][] = [];
  await page.exposeFunction('recordWsMsg', (msg: string) => {
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type === 'zone_state') {
        positions.push(parsed.state.vehicles.map((v: any) => ({
          id: v.id, x: v.position.x, y: v.position.y,
        })));
      }
    } catch {}
  });
  await page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    (window as any).WebSocket = class extends OrigWS {
      constructor(url: string, proto?: string | string[]) {
        super(url, proto);
        this.addEventListener('message', (e: MessageEvent) => {
          (window as any).recordWsMsg(e.data);
        });
      }
    };
  });

  await gotoArena(page, token, vehicleId);
  // Wait long enough for 5+ ticks (500ms)
  await page.waitForTimeout(600);

  expect(positions.length).toBeGreaterThanOrEqual(3);

  // AI vehicles should have moved (they auto-drive)
  const firstAi = positions[0].find(v => v.id === 'ai-red');
  const lastAi = positions[positions.length - 1].find(v => v.id === 'ai-red');
  if (firstAi && lastAi) {
    const moved = firstAi.x !== lastAi.x || firstAi.y !== lastAi.y;
    expect(moved).toBe(true);
  }
});
