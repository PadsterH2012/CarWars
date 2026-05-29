import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';

let app: ReturnType<typeof createApp>;
const USERS = ['reporter1', 'reporter-jobs'];

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

describe('after-action reports API', () => {
  let sharedToken = '';

  it('surfaces a resolved deployment as an unread report and marks it read', async () => {
    const db = getDb();
    const { token } = await register('reporter1');
    sharedToken = token;
    const starter = await request(app).post('/api/me/claim-starter').set('Authorization', `Bearer ${token}`).send();
    const vehicleId = starter.body.vehicleId as string;

    // Deploy, then force the deployment due so it resolves into a report.
    const dep = await request(app)
      .post('/api/deploy')
      .set('Authorization', `Bearer ${token}`)
      .send({ zoneId: 'fort-grimm', vehicleIds: [vehicleId], assignment: 'raid' });
    expect(dep.status).toBe(201);
    await db.query(`UPDATE squad_deployments SET resolves_at = NOW() - interval '1 second' WHERE id = $1`, [dep.body.deploymentId]);

    // Unread count reflects the freshly-resolved report.
    const count = await request(app).get('/api/reports/unread-count').set('Authorization', `Bearer ${token}`);
    expect(count.status).toBe(200);
    expect(count.body.unread).toBe(1);

    // The report list includes it, unread, with squad detail.
    const list = await request(app).get('/api/reports').set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.unread).toBe(1);
    expect(list.body.reports.length).toBe(1);
    const reportRow = list.body.reports[0];
    expect(reportRow.read).toBe(false);
    expect(reportRow.report.perDriver.length).toBeGreaterThan(0);

    // Marking it read drops the unread count to zero.
    const mark = await request(app).post(`/api/reports/${reportRow.id}/read`).set('Authorization', `Bearer ${token}`);
    expect(mark.status).toBe(200);
    const after = await request(app).get('/api/reports/unread-count').set('Authorization', `Bearer ${token}`);
    expect(after.body.unread).toBe(0);
  });

  it('404s when marking a report the player does not own', async () => {
    const res = await request(app)
      .post('/api/reports/00000000-0000-0000-0000-000000000000/read')
      .set('Authorization', `Bearer ${sharedToken}`);
    expect(res.status).toBe(404);
  });
});
