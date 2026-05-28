import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';

const app = createApp();

describe('world API', () => {
  it('lists available world regions', async () => {
    const res = await request(app).get('/api/world/regions');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: 'midville', name: 'Midville Region', nodeCount: 6, roadCount: 5 },
    ]);
  });

  it('returns full region data by id', async () => {
    const res = await request(app).get('/api/world/regions/midville');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('midville');
    expect(res.body.nodes.map((n: { id: string }) => n.id)).toContain('rustwater-truck-stop');
    expect(res.body.roads.map((r: { id: string }) => r.id)).toContain('midville-rustwater');
  });

  it('returns 404 for unknown region', async () => {
    const res = await request(app).get('/api/world/regions/nowhere');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Region not found' });
  });
});
