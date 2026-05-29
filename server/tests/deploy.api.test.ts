import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';

let app: ReturnType<typeof createApp>;
const USERS = ['deployer1', 'deployer2'];

async function register(username: string) {
  const reg = await request(app).post('/api/auth/register').send({ username, password: 'password123' });
  return { token: reg.body.token as string, playerId: reg.body.playerId as string };
}

beforeAll(async () => {
  app = createApp();
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username = ANY($1)`, [USERS]);
});

afterAll(async () => {
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username = ANY($1)`, [USERS]);
  await closeDb();
});

describe('squad deployment API', () => {
  // Shared across the ordered tests — test 1 creates the deployment that test 3 resolves.
  let p1Token = '';
  let p1Id = '';

  it('deploys a squad to a zone and reports an ETA', async () => {
    const { token, playerId } = await register('deployer1');
    p1Token = token;
    p1Id = playerId;
    const starter = await request(app).post('/api/me/claim-starter').set('Authorization', `Bearer ${token}`).send();
    expect(starter.status).toBe(201);
    const vehicleId = starter.body.vehicleId as string;

    const res = await request(app)
      .post('/api/deploy')
      .set('Authorization', `Bearer ${token}`)
      .send({ zoneId: 'rustwater-truck-stop', vehicleIds: [vehicleId], assignment: 'patrol' });

    expect(res.status).toBe(201);
    expect(res.body.zoneId).toBe('rustwater-truck-stop');
    expect(res.body.etaSeconds).toBeGreaterThan(0);
    expect(res.body.deploymentId).toBeTruthy();
  });

  it('rejects a deployment to an unknown zone', async () => {
    const { token } = await register('deployer2');
    const starter = await request(app).post('/api/me/claim-starter').set('Authorization', `Bearer ${token}`).send();
    const vehicleId = starter.body.vehicleId as string;

    const res = await request(app)
      .post('/api/deploy')
      .set('Authorization', `Bearer ${token}`)
      .send({ zoneId: 'nowhere', vehicleIds: [vehicleId] });

    expect(res.status).toBe(404);
  });

  it('resolves a due deployment into an after-action report and frees the crew', async () => {
    const db = getDb();
    const token = p1Token;
    const playerId = p1Id;

    // Find the in-transit deployment created in the first test and force it due.
    const dep = await db.query(
      `SELECT id, driver_ids FROM squad_deployments WHERE player_id = $1 AND status = 'in_transit' ORDER BY created_at DESC LIMIT 1`,
      [playerId],
    );
    expect(dep.rows.length).toBe(1);
    const deploymentId = dep.rows[0].id as string;
    const driverId = dep.rows[0].driver_ids[0] as string;

    await db.query(`UPDATE squad_deployments SET resolves_at = NOW() - interval '1 second' WHERE id = $1`, [deploymentId]);

    // GET /api/deploy triggers lazy resolution.
    const list = await request(app).get('/api/deploy').set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    const resolved = list.body.find((d: { id: string }) => d.id === deploymentId);
    expect(resolved.status).toBe('resolved');
    expect(resolved.report_id).toBeTruthy();

    // A report row exists with a valid outcome and net = income - repairCost.
    const rep = await db.query(`SELECT outcome, report FROM engagement_reports WHERE id = $1`, [resolved.report_id]);
    expect(rep.rows.length).toBe(1);
    expect(['success', 'partial', 'failure', 'routed']).toContain(rep.rows[0].outcome);
    const report = rep.rows[0].report;
    expect(report.net).toBe(report.income - report.repairCost);

    // Crew freed unless killed: available_at is no longer in the future for a living driver.
    const drv = await db.query(`SELECT alive, available_at <= NOW() AS free FROM drivers WHERE id = $1`, [driverId]);
    if (drv.rows[0].alive) {
      expect(drv.rows[0].free).toBe(true);
    }
  });
});
