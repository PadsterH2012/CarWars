import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';
import { resolveDueDeployments } from '../src/api/deploy';

let app: ReturnType<typeof createApp>;
const USERS = ['deployer1', 'deployer2', 'deployer3', 'deployer4', 'dep-jobcol', 'dep-jobres', 'dep-jobfield'];

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

  it('marks a deployed vehicle as "deployed" on GET /api/vehicles with an ETA', async () => {
    const { token } = await register('deployer3');
    const starter = await request(app).post('/api/me/claim-starter').set('Authorization', `Bearer ${token}`).send();
    const vehicleId = starter.body.vehicleId as string;

    // Before deploy: available.
    const before = await request(app).get('/api/vehicles').set('Authorization', `Bearer ${token}`);
    const vBefore = before.body.find((v: { id: string }) => v.id === vehicleId);
    expect(vBefore.status).toBe('available');
    expect(vBefore.remainingSeconds).toBe(0);

    const dep = await request(app)
      .post('/api/deploy')
      .set('Authorization', `Bearer ${token}`)
      .send({ zoneId: 'rustwater-truck-stop', vehicleIds: [vehicleId], assignment: 'patrol' });
    expect(dep.status).toBe(201);

    // After deploy: the same vehicle reads as deployed, with a positive ETA and zone.
    const after = await request(app).get('/api/vehicles').set('Authorization', `Bearer ${token}`);
    const vAfter = after.body.find((v: { id: string }) => v.id === vehicleId);
    expect(vAfter.status).toBe('deployed');
    expect(vAfter.remainingSeconds).toBeGreaterThan(0);
    expect(vAfter.deploymentZone).toBe('rustwater-truck-stop');
  });

  it('resolves a due deployment exactly once under concurrent requests', async () => {
    const db = getDb();
    const { token, playerId } = await register('deployer4');
    const starter = await request(app).post('/api/me/claim-starter').set('Authorization', `Bearer ${token}`).send();
    const vehicleId = starter.body.vehicleId as string;

    const dep = await request(app)
      .post('/api/deploy')
      .set('Authorization', `Bearer ${token}`)
      .send({ zoneId: 'rustwater-truck-stop', vehicleIds: [vehicleId], assignment: 'patrol' });
    expect(dep.status).toBe(201);
    const deploymentId = dep.body.deploymentId as string;

    await db.query(`UPDATE squad_deployments SET resolves_at = NOW() - interval '1 second' WHERE id = $1`, [deploymentId]);

    // Fire several resolution-triggering endpoints at once (each calls
    // resolveDueDeployments). The atomic claim must keep this to one report.
    const auth = { Authorization: `Bearer ${token}` };
    await Promise.all([
      request(app).get('/api/vehicles').set(auth),
      request(app).get('/api/deploy').set(auth),
      request(app).get('/api/reports/unread-count').set(auth),
      request(app).get('/api/vehicles').set(auth),
      request(app).get('/api/reports').set(auth),
    ]);

    const reports = await db.query(
      `SELECT COUNT(*)::int AS n FROM engagement_reports WHERE player_id = $1`, [playerId],
    );
    expect(reports.rows[0].n).toBe(1);

    const ledger = await db.query(
      `SELECT COUNT(*)::int AS n FROM gang_ledger
        WHERE event_type = 'squad_deployment' AND result->>'deploymentId' = $1`, [deploymentId],
    );
    expect(ledger.rows[0].n).toBe(1);
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

  it('squad_deployments accepts a job-linked row (zone_id null, job_id set)', async () => {
    const db = getDb();
    const { token, playerId } = await register('dep-jobcol');
    const job = (await db.query(
      `INSERT INTO jobs (zone_id, job_type, description, payout, division_min, headless, difficulty)
       VALUES ('town-1','patrol','Test job',300,5,TRUE,3) RETURNING id`)).rows[0];
    const ins = await db.query(
      `INSERT INTO squad_deployments (player_id, job_id, assignment, driver_ids, vehicle_ids, resolves_at)
       VALUES ($1,$2,'job','{}'::uuid[],'{}'::uuid[], NOW() + interval '1 minute') RETURNING id, zone_id, job_id`,
      [playerId, job.id]);
    expect(ins.rows[0].zone_id).toBeNull();
    expect(ins.rows[0].job_id).toBe(job.id);
    await db.query(`DELETE FROM jobs WHERE id = $1`, [job.id]);
  });

  it('resolves a job-linked deployment into a report and completes the job', async () => {
    const db = getDb();
    const { token, playerId } = await register('dep-jobres');
    const starter = await request(app).post('/api/me/claim-starter').set('Authorization', `Bearer ${token}`).send();
    const vehicleId = starter.body.vehicleId as string;
    const job = (await db.query(
      `INSERT INTO jobs (zone_id, job_type, description, payout, division_min, headless, difficulty)
       VALUES ('town-1','patrol','Resolve me',300,5,TRUE,3) RETURNING id`)).rows[0];
    const driver = (await db.query(`SELECT id FROM drivers WHERE assigned_vehicle_id = $1`, [vehicleId])).rows[0];
    const dep = (await db.query(
      `INSERT INTO squad_deployments (player_id, job_id, assignment, driver_ids, vehicle_ids, resolves_at)
       VALUES ($1,$2,'job',$3::uuid[],$4::uuid[], NOW() - interval '1 second') RETURNING id`,
      [playerId, job.id, [driver.id], [vehicleId]])).rows[0];

    await resolveDueDeployments(playerId);

    const depAfter = (await db.query(`SELECT status, report_id FROM squad_deployments WHERE id = $1`, [dep.id])).rows[0];
    expect(depAfter.status).toBe('resolved');
    expect(depAfter.report_id).toBeTruthy();
    const jobAfter = (await db.query(`SELECT completed FROM jobs WHERE id = $1`, [job.id])).rows[0];
    expect(jobAfter.completed).toBe(true);
    const rep = (await db.query(`SELECT outcome FROM engagement_reports WHERE id = $1`, [depAfter.report_id])).rows[0];
    expect(['success','partial','failure','routed']).toContain(rep.outcome);
  });

  it('GET /api/deploy exposes job_id so the client can filter job-deployments', async () => {
    const db = getDb();
    const { token, playerId } = await register('dep-jobfield');
    const job = (await db.query(
      `INSERT INTO jobs (zone_id, job_type, description, payout, division_min, headless, difficulty)
       VALUES ('town-1','patrol','Field test',300,5,TRUE,3) RETURNING id`)).rows[0];
    const dep = (await db.query(
      `INSERT INTO squad_deployments (player_id, job_id, assignment, driver_ids, vehicle_ids, resolves_at)
       VALUES ($1,$2,'job','{}'::uuid[],'{}'::uuid[], NOW() + interval '5 minutes') RETURNING id`,
      [playerId, job.id])).rows[0];
    const res = await request(app).get('/api/deploy').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const row = res.body.find((r: any) => r.id === dep.id);
    expect(row).toBeTruthy();
    expect(row.job_id).toBe(job.id);
    await db.query(`DELETE FROM jobs WHERE id = $1`, [job.id]);
  });
});
