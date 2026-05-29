import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';

let app: ReturnType<typeof createApp>;
let token: string;

beforeAll(async () => {
  app = createApp();
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username = ANY(ARRAY['headlesstest','jobdeploy','jobactive','jobdup'])`);
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ username: 'headlesstest', password: 'password123' });
  token = reg.body.token;
});

afterAll(async () => {
  const db = getDb();
  await db.query(`DELETE FROM players WHERE username = ANY(ARRAY['headlesstest','jobdeploy','jobactive','jobdup'])`);
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

  it('POST /api/jobs/assign is gone (single-driver path retired)', async () => {
    const res = await request(app)
      .post('/api/jobs/assign')
      .set('Authorization', `Bearer ${token}`)
      .send({ jobId: 'x', driverId: 'y' });
    expect(res.status).toBe(404);
  });

  it('GET /api/jobs/active lists in-progress job deployments with ETA + vehicle count', async () => {
    // Fresh player with a starter vehicle + auto-assigned driver, deploy onto a job.
    const reg = await request(app).post('/api/auth/register').send({ username: 'jobactive', password: 'password123' });
    const t = reg.body.token;
    const starter = await request(app).post('/api/me/claim-starter').set('Authorization', `Bearer ${t}`).send();
    const vehicleId = starter.body.vehicleId;
    const jobs = (await request(app).get('/api/jobs/headless?zoneId=town-1').set('Authorization', `Bearer ${t}`)).body;
    const jobId = jobs[0].id;
    const dep = await request(app).post(`/api/jobs/${jobId}/deploy`)
      .set('Authorization', `Bearer ${t}`).send({ vehicleIds: [vehicleId] });
    expect(dep.status).toBe(201);

    const res = await request(app).get('/api/jobs/active').set('Authorization', `Bearer ${t}`);
    expect(res.status).toBe(200);
    const mine = res.body.find((j: any) => j.id === dep.body.deploymentId);
    expect(mine).toBeTruthy();
    expect(mine.jobId).toBe(jobId);
    expect(typeof mine.jobType).toBe('string');
    expect(mine.vehicleCount).toBe(1);
    expect(typeof mine.remainingSeconds).toBe('number');
    expect(mine.remainingSeconds).toBeGreaterThan(0);
  });

  it('POST /api/jobs/:id/deploy sends a squad and marks the vehicle deployed', async () => {
    // Fresh player with a starter vehicle + auto-assigned driver
    const reg = await request(app).post('/api/auth/register').send({ username: 'jobdeploy', password: 'password123' });
    const t = reg.body.token;
    const starter = await request(app).post('/api/me/claim-starter').set('Authorization', `Bearer ${t}`).send();
    const vehicleId = starter.body.vehicleId;
    const jobs = (await request(app).get('/api/jobs/headless?zoneId=town-1').set('Authorization', `Bearer ${t}`)).body;
    const res = await request(app).post(`/api/jobs/${jobs[0].id}/deploy`)
      .set('Authorization', `Bearer ${t}`).send({ vehicleIds: [vehicleId] });
    expect(res.status).toBe(201);
    expect(res.body.deploymentId).toBeTruthy();
    expect(typeof res.body.etaSeconds).toBe('number');
    const vehicles = (await request(app).get('/api/vehicles').set('Authorization', `Bearer ${t}`)).body;
    expect(vehicles.find((v: any) => v.id === vehicleId).status).toBe('deployed');
  });

  it('POST /api/jobs/:id/deploy rejects more than 4 vehicles', async () => {
    const jobs = (await request(app).get('/api/jobs/headless?zoneId=town-1').set('Authorization', `Bearer ${token}`)).body;
    const res = await request(app).post(`/api/jobs/${jobs[0].id}/deploy`)
      .set('Authorization', `Bearer ${token}`).send({ vehicleIds: ['a','b','c','d','e'] });
    expect(res.status).toBe(400);
  });

  it('POST /api/jobs/:id/deploy rejects a second squad on a job already out', async () => {
    const reg = await request(app).post('/api/auth/register').send({ username: 'jobdup', password: 'password123' });
    const t = reg.body.token;
    const starter = await request(app).post('/api/me/claim-starter').set('Authorization', `Bearer ${t}`).send();
    const vehicleId = starter.body.vehicleId;
    const jobs = (await request(app).get('/api/jobs/headless?zoneId=town-1').set('Authorization', `Bearer ${t}`)).body;
    const first = await request(app).post(`/api/jobs/${jobs[0].id}/deploy`)
      .set('Authorization', `Bearer ${t}`).send({ vehicleIds: [vehicleId] });
    expect(first.status).toBe(201);
    const second = await request(app).post(`/api/jobs/${jobs[0].id}/deploy`)
      .set('Authorization', `Bearer ${t}`).send({ vehicleIds: [vehicleId] });
    expect(second.status).toBe(409);
  });
});
