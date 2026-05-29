import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';

let app: ReturnType<typeof createApp>;
let token: string;
let driverId: string;

beforeAll(async () => {
  app = createApp();
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username = 'headlesstest'`);
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ username: 'headlesstest', password: 'password123' });
  token = reg.body.token;
  const drv = await request(app)
    .post('/api/drivers')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Solo Runner' });
  driverId = drv.body.id;
});

afterAll(async () => {
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username = 'headlesstest'`);
  await closeDb();
});

describe('headless jobs', () => {
  it('GET /api/jobs/headless seeds and returns headless jobs with a difficulty', async () => {
    const res = await request(app)
      .get('/api/jobs/headless?zoneId=town-1')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const j of res.body) {
      expect(typeof j.difficulty).toBe('number');
      expect(j.difficulty).toBeGreaterThanOrEqual(1);
    }
  });

  it('POST /api/jobs/assign marks the driver unavailable and sets resolves_at', async () => {
    const jobs = (await request(app)
      .get('/api/jobs/headless?zoneId=town-1')
      .set('Authorization', `Bearer ${token}`)).body;
    const jobId = jobs[0].id;

    const res = await request(app)
      .post('/api/jobs/assign')
      .set('Authorization', `Bearer ${token}`)
      .send({ jobId, driverId });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Driver now shows as on-job (available_at in the future)
    const drivers = (await request(app)
      .get('/api/drivers')
      .set('Authorization', `Bearer ${token}`)).body;
    const me = drivers.find((d: any) => d.id === driverId);
    expect(me.status).toBe('on_job');
    expect(new Date(me.available_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects assigning a driver who is already on a job', async () => {
    const jobs = (await request(app)
      .get('/api/jobs/headless?zoneId=town-1')
      .set('Authorization', `Bearer ${token}`)).body;
    const res = await request(app)
      .post('/api/jobs/assign')
      .set('Authorization', `Bearer ${token}`)
      .send({ jobId: jobs[0].id, driverId });
    expect(res.status).toBe(409);
  });

  it('lazily resolves a due job: writes outcome, frees the driver, exposes after-action report', async () => {
    const db = getDb();
    // Force the assigned job to be due now
    await db.query(
      `UPDATE jobs SET resolves_at = NOW() - INTERVAL '1 minute'
       WHERE assigned_driver_id = $1 AND outcome IS NULL`,
      [driverId]
    );

    // GET /api/drivers triggers lazy resolution
    const drivers = (await request(app)
      .get('/api/drivers')
      .set('Authorization', `Bearer ${token}`)).body;
    const me = drivers.find((d: any) => d.id === driverId);
    expect(me.status).not.toBe('on_job'); // freed (available or wounded)

    // After-action report is available and unacknowledged
    const outcomes = (await request(app)
      .get('/api/jobs/outcomes')
      .set('Authorization', `Bearer ${token}`)).body;
    expect(outcomes.length).toBeGreaterThan(0);
    const report = outcomes[0];
    expect(['success', 'partial', 'failure', 'catastrophe']).toContain(report.tier);
    expect(report.breakdown).toBeDefined();

    // Acknowledge clears it from the unseen list
    const ack = await request(app)
      .post(`/api/jobs/${report.id}/acknowledge`)
      .set('Authorization', `Bearer ${token}`);
    expect(ack.status).toBe(200);
    const after = (await request(app)
      .get('/api/jobs/outcomes')
      .set('Authorization', `Bearer ${token}`)).body;
    expect(after.find((o: any) => o.id === report.id)).toBeUndefined();
  });

  it('GET /api/jobs/active lists in-progress contracts with ETA + driver name', async () => {
    // Assign a fresh driver to a fresh contract so one is definitely in-flight.
    const drv = await request(app).post('/api/drivers')
      .set('Authorization', `Bearer ${token}`).send({ name: 'Active Runner' });
    const jobs = (await request(app).get('/api/jobs/headless?zoneId=town-1')
      .set('Authorization', `Bearer ${token}`)).body;
    await request(app).post('/api/jobs/assign')
      .set('Authorization', `Bearer ${token}`).send({ jobId: jobs[0].id, driverId: drv.body.id });

    const res = await request(app).get('/api/jobs/active')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const mine = res.body.find((j: any) => j.driverId === drv.body.id);
    expect(mine).toBeTruthy();
    expect(mine.driverName).toBe('Active Runner');
    expect(typeof mine.remainingSeconds).toBe('number');
    expect(mine.remainingSeconds).toBeGreaterThan(0);
  });
});
