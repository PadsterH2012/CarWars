/**
 * LoginScene — browser UI tests.
 * Phaser renders to a canvas; we can't read canvas pixels, but we CAN check
 * that the DOM form elements render and that the app transitions correctly
 * after a successful auth action.
 */
import { test, expect } from '@playwright/test';
import { uniqueUser } from './helpers';

test.beforeEach(async ({ page }) => {
  // Clear stored token so we always land on LoginScene
  await page.addInitScript(() => localStorage.removeItem('cw_token'));
  await page.goto('/');
  await page.waitForSelector('canvas', { timeout: 10_000 });
  // Wait for Phaser DOM container to inject the login form
  await page.waitForSelector('#username', { timeout: 10_000 });
});

test('login form renders username and password inputs', async ({ page }) => {
  await expect(page.locator('#username')).toBeVisible();
  await expect(page.locator('#password')).toBeVisible();
  await expect(page.locator('#loginBtn')).toBeVisible();
  await expect(page.locator('#registerBtn')).toBeVisible();
});

test('register flow creates account and proceeds to garage', async ({ page }) => {
  const username = uniqueUser('ui_reg');
  await page.fill('#username', username);
  await page.fill('#password', 'testpass123');
  await page.click('#registerBtn');

  // After register, LoginScene transitions to GarageScene.
  // The login form disappears and the canvas continues rendering.
  await expect(page.locator('#username')).not.toBeVisible({ timeout: 8_000 });

  // Token stored in localStorage
  const token = await page.evaluate(() => localStorage.getItem('cw_token'));
  expect(token).toBeTruthy();
});

test('login flow authenticates and proceeds to garage', async ({ page }) => {
  const username = uniqueUser('ui_login');
  // Register first via form
  await page.fill('#username', username);
  await page.fill('#password', 'testpass123');
  await page.click('#registerBtn');
  await expect(page.locator('#username')).not.toBeVisible({ timeout: 8_000 });

  // Clear token and reload to test login path
  await page.evaluate(() => localStorage.removeItem('cw_token'));
  await page.reload();
  await page.waitForSelector('#username', { timeout: 10_000 });

  await page.fill('#username', username);
  await page.fill('#password', 'testpass123');
  await page.click('#loginBtn');

  await expect(page.locator('#username')).not.toBeVisible({ timeout: 8_000 });
  const token = await page.evaluate(() => localStorage.getItem('cw_token'));
  expect(token).toBeTruthy();
});

test('wrong password shows error message', async ({ page }) => {
  const username = uniqueUser('badpw');
  // Register first
  await page.fill('#username', username);
  await page.fill('#password', 'testpass123');
  await page.click('#registerBtn');
  await expect(page.locator('#username')).not.toBeVisible({ timeout: 8_000 });

  await page.evaluate(() => localStorage.removeItem('cw_token'));
  await page.reload();
  await page.waitForSelector('#username', { timeout: 10_000 });

  await page.fill('#username', username);
  await page.fill('#password', 'wrongpassword');
  await page.click('#loginBtn');

  // Error text should appear in #error div
  await expect(page.locator('#error')).not.toBeEmpty({ timeout: 5_000 });
  // Still on login screen
  await expect(page.locator('#username')).toBeVisible();
});

test('saved token skips login and goes straight to garage', async ({ page }) => {
  const username = uniqueUser('skip');
  // Register to get a token
  const res = await fetch('http://localhost:3001/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'testpass123' }),
  });
  const { token } = await res.json();

  // Inject token before page load
  await page.addInitScript((t) => localStorage.setItem('cw_token', t), token);
  await page.goto('/');
  await page.waitForSelector('canvas', { timeout: 10_000 });

  // Login form should never appear — scene skips straight to GarageScene
  const loginForm = page.locator('#username');
  await expect(loginForm).not.toBeVisible({ timeout: 5_000 });
});
