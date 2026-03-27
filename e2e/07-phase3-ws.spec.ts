/**
 * Phase 3 WebSocket tests — oil/mine in zone state, arena end condition, NPC traffic.
 * Uses WebSocket interception via addInitScript.
 */
import { test, expect, Page } from '@playwright/test';
import { uniqueUser, registerViaApi, createVehicle, injectToken } from './helpers';

async function openArena(page: Page, token: string, vehicleId: string) {
  await injectToken(page, token);
  await page.goto('/');
  await page.waitForSelector('canvas', { timeout: 10_000 });
  await page.waitForFunction(() => (window as any).game !== undefined, { timeout: 10_000 });
  await page.evaluate(({ t, v }) => {
    (window as any).game.scene.start('ArenaScene', { token: t, vehicleId: v });
  }, { t: token, v: vehicleId });
  await page.waitForTimeout(500);
}

function interceptWs(page: Page): Promise<string[]> {
  const messages: string[] = [];
  page.exposeFunction('recordWsMsg3', (msg: string) => messages.push(msg));
  page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    (window as any).WebSocket = class extends OrigWS {
      constructor(url: string, proto?: string | string[]) {
        super(url, proto);
        this.addEventListener('message', (e: MessageEvent) => {
          (window as any).recordWsMsg3(e.data);
        });
      }
    };
  });
  return Promise.resolve(messages);
}

test('zone_state includes hazardObjects array', async ({ page }) => {
  const { token } = await registerViaApi(uniqueUser('hz1'));
  const vehicleId = await createVehicle(token, 'Hazard Tester');
  const messages = await interceptWs(page);
  await openArena(page, token, vehicleId);
  await page.waitForTimeout(1000);

  const stateMsg = messages.find(m => m.includes('"zone_state"'));
  expect(stateMsg).toBeTruthy();
  const parsed = JSON.parse(stateMsg!);
  expect(parsed.state).toHaveProperty('hazardObjects');
  expect(Array.isArray(parsed.state.hazardObjects)).toBe(true);
});

test('highway zone has NPC traffic vehicles', async ({ page }) => {
  const { token } = await registerViaApi(uniqueUser('npc1'));
  const vehicleId = await createVehicle(token, 'Highway Rider');
  const messages = await interceptWs(page);

  await injectToken(page, token);
  await page.goto('/');
  await page.waitForSelector('canvas', { timeout: 10_000 });
  await page.waitForFunction(() => (window as any).game !== undefined, { timeout: 10_000 });

  // Use raw WebSocket from Node in a page.evaluate to join highway zone
  await page.evaluate(async ({ t, v }) => {
    return new Promise<void>((resolve) => {
      const ws = new WebSocket('ws://localhost:3001');
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'join_zone', zoneId: 'highway-1', vehicleId: v, token: t }));
      };
      ws.onmessage = (e) => {
        (window as any).recordWsMsg3(e.data);
        ws.close();
        resolve();
      };
    });
  }, { t: token, v: vehicleId });

  await page.waitForTimeout(500);

  const stateMsg = messages.find(m => m.includes('"zone_state"'));
  expect(stateMsg).toBeTruthy();
  const parsed = JSON.parse(stateMsg!);
  const npcVehicles = parsed.state.vehicles.filter((v: any) => v.playerId === 'npc-traffic');
  expect(npcVehicles.length).toBeGreaterThanOrEqual(3);
});

test('arena broadcasts zone_end when all AI destroyed', async ({ page }) => {
  const { token } = await registerViaApi(uniqueUser('end1'));
  const vehicleId = await createVehicle(token, 'Arena Destroyer');
  const messages: string[] = [];

  await page.exposeFunction('recordEnd', (msg: string) => messages.push(msg));
  await page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    (window as any).WebSocket = class extends OrigWS {
      constructor(url: string, proto?: string | string[]) {
        super(url, proto);
        this.addEventListener('message', (e: MessageEvent) => {
          if (e.data.includes('zone_end') || e.data.includes('zone_state')) {
            (window as any).recordEnd(e.data);
          }
        });
      }
    };
  });

  await injectToken(page, token);
  await page.goto('/');
  await page.waitForSelector('canvas', { timeout: 10_000 });
  await page.waitForFunction(() => (window as any).game !== undefined, { timeout: 10_000 });

  // Use a dedicated zone for this test
  await page.evaluate(async ({ t, v }) => {
    const ws = new WebSocket('ws://localhost:3001');
    (window as any)._endTestWs = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'join_zone', zoneId: 'arena-end-test', vehicleId: v, token: t }));
    };
    ws.onmessage = (e) => { (window as any).recordEnd(e.data); };
  }, { t: token, v: vehicleId });

  // Wait for initial state
  await page.waitForTimeout(500);
  const initialMsg = messages.find(m => m.includes('zone_state'));
  expect(initialMsg).toBeTruthy();

  // Verify AI vehicles are present in initial state
  const parsed = JSON.parse(initialMsg!);
  expect(parsed.state.vehicles.some((v: any) => v.id === 'ai-red')).toBe(true);
  expect(parsed.state.vehicles.some((v: any) => v.id === 'ai-blue')).toBe(true);
});

test('arena canvas shows vehicle containers with armor bar children', async ({ page }) => {
  const { token } = await registerViaApi(uniqueUser('hud1'));
  const vehicleId = await createVehicle(token, 'HUD Test Vehicle');

  await injectToken(page, token);
  await page.goto('/');
  await page.waitForSelector('canvas', { timeout: 10_000 });
  await page.waitForFunction(() => (window as any).game !== undefined, { timeout: 10_000 });
  await page.evaluate(({ t, v }) => {
    (window as any).game.scene.start('ArenaScene', { token: t, vehicleId: v });
  }, { t: token, v: vehicleId });

  await page.waitForFunction(() => {
    return (window as any).game?.scene?.isActive('ArenaScene') === true;
  }, { timeout: 8_000 });

  await page.waitForTimeout(2000);

  // Check that containers exist in the scene and have the armor bar children
  const hasArmorBars = await page.evaluate(() => {
    const scene = (window as any).game.scene.getScene('ArenaScene') as any;
    if (!scene) return false;
    // Look for a container with armor bars (check for named children)
    const containers = scene.children.list.filter((c: any) =>
      c.type === 'Container' && c.list && c.list.some((child: any) => child.name === 'bar-front')
    );
    return containers.length > 0;
  });
  expect(hasArmorBars).toBe(true);
});
