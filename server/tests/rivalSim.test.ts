import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import request from 'supertest';
import { simulateTurn } from '../src/rules/rivalSim';
import { createApp } from '../src/app';
import { getDb } from '../src/db/client';
import type { GeneratedGang } from '../src/rules/gangGen';
import type { GeneratedWorld } from '@carwars/shared';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WORLD: GeneratedWorld = {
  seed: 1,
  settlements: [
    { id: 's1', name: 'Alpha', kind: 'city',    x:   0, y: 0, population: 100_000, services: [] },
    { id: 's2', name: 'Beta',  kind: 'town',    x: 100, y: 0, population:   5_000, services: [] },
    { id: 's3', name: 'Gamma', kind: 'outpost', x: 200, y: 0, population:     500, services: [] },
  ],
  roads: [
    { id: 'r1', from: 's1', to: 's2', distance: 100, roadType: 'highway', danger: 0.1 },
    { id: 'r2', from: 's2', to: 's3', distance:  80, roadType: 'dirt',    danger: 0.3 },
  ],
  capitals: ['s1'],
  playerStartSettlementId: 's2',
};

const GANG_A: GeneratedGang = {
  id: 'ga', name: 'Red Wolves',  primary_colour: 0xff0000, secondary_colour: 0x880000,
  starting_influence: 30, home_settlement_id: 's1', treasury: 10_000,
};
const GANG_B: GeneratedGang = {
  id: 'gb', name: 'Blue Ravens', primary_colour: 0x0000ff, secondary_colour: 0x000088,
  starting_influence: 25, home_settlement_id: 's2', treasury: 8_000,
};

/** Key format expected by simulateTurn */
const key = (sid: string, gid: string) => `${sid}:${gid}`;

afterEach(() => vi.restoreAllMocks());

// ── simulateTurn — unit tests ─────────────────────────────────────────────────

describe('simulateTurn — patrol', () => {
  it('gains influence in a settlement the gang already controls', () => {
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.1)   // rollAction → patrol (< 0.40)
      .mockReturnValueOnce(0.0);  // pick settlement index 0

    const inf = new Map([[key('s1', 'ga'), 20]]);
    const log = simulateTurn(GANG_A, WORLD, inf, [GANG_A]);

    expect(log).not.toBeNull();
    expect(log!.actionType).toBe('patrol');
    expect(inf.get(key('s1', 'ga'))!).toBeGreaterThan(20);
  });

  it('returns null when the gang has no territory', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1); // always patrol
    const inf = new Map<string, number>();          // no influence anywhere
    const log = simulateTurn(GANG_A, WORLD, inf, [GANG_A]);
    expect(log).toBeNull();
  });

  it('influence never goes negative', () => {
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.1)   // patrol
      .mockReturnValueOnce(0.0);
    const inf = new Map([[key('s1', 'ga'), 1]]);
    simulateTurn(GANG_A, WORLD, inf, [GANG_A]);
    expect(inf.get(key('s1', 'ga'))!).toBeGreaterThanOrEqual(0);
  });
});

describe('simulateTurn — expand', () => {
  it('gains influence in an adjacent settlement with no prior presence', () => {
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.5)   // rollAction → expand (0.40–0.65)
      .mockReturnValueOnce(0.0)   // pick adjacent target index 0
      .mockReturnValueOnce(0.0);  // gain = 5 + floor(0 * 6) = 5

    // Gang A is in s1; s2 is adjacent via r1 and has no presence
    const inf = new Map([[key('s1', 'ga'), 30]]);
    const log = simulateTurn(GANG_A, WORLD, inf, [GANG_A]);

    expect(log).not.toBeNull();
    expect(log!.actionType).toBe('expand');
    // Influence should now exist in an adjacent settlement
    const expanded = ['s2', 's3'].some(sid => (inf.get(key(sid, 'ga')) ?? 0) > 0);
    expect(expanded).toBe(true);
  });

  it('returns null when no adjacent territory is available to expand into', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // always expand
    // Gang A already present in all settlements
    const inf = new Map([
      [key('s1', 'ga'), 30],
      [key('s2', 'ga'), 10],
      [key('s3', 'ga'), 5],
    ]);
    const log = simulateTurn(GANG_A, WORLD, inf, [GANG_A]);
    expect(log).toBeNull();
  });
});

describe('simulateTurn — harass', () => {
  it('reduces a rival gang\'s influence in a shared settlement', () => {
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.7)   // rollAction → harass (0.65–0.85)
      .mockReturnValueOnce(0.0)   // pick shared settlement index 0
      .mockReturnValueOnce(0.0)   // pick victim index 0
      .mockReturnValueOnce(0.0);  // loss = 3 + floor(0 * 6) = 3

    // Both gangs share s1
    const inf = new Map([
      [key('s1', 'ga'), 20],
      [key('s1', 'gb'), 15],
    ]);
    const before = inf.get(key('s1', 'gb'))!;
    const log = simulateTurn(GANG_A, WORLD, inf, [GANG_A, GANG_B]);

    expect(log).not.toBeNull();
    expect(log!.actionType).toBe('harass');
    expect(inf.get(key('s1', 'gb'))!).toBeLessThan(before);
  });

  it('returns null when the gang has no shared settlements with rivals', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.7);
    // Each gang in a separate settlement
    const inf = new Map([
      [key('s1', 'ga'), 20],
      [key('s2', 'gb'), 15],
    ]);
    const log = simulateTurn(GANG_A, WORLD, inf, [GANG_A, GANG_B]);
    expect(log).toBeNull();
  });

  it('victim influence never goes below 0', () => {
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.7)
      .mockReturnValueOnce(0.0)
      .mockReturnValueOnce(0.0)
      .mockReturnValueOnce(0.99); // loss = 3 + floor(0.99 * 6) = 8
    const inf = new Map([
      [key('s1', 'ga'), 20],
      [key('s1', 'gb'),  2],   // only 2 influence — can't go below 0
    ]);
    simulateTurn(GANG_A, WORLD, inf, [GANG_A, GANG_B]);
    expect(inf.get(key('s1', 'gb'))!).toBe(0);
  });
});

describe('simulateTurn — attack', () => {
  it('returns an attack log with the gang\'s home settlement', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9); // rollAction → attack (>= 0.85)
    const inf = new Map<string, number>();
    const log = simulateTurn(GANG_A, WORLD, inf, [GANG_A]);

    expect(log).not.toBeNull();
    expect(log!.actionType).toBe('attack');
    expect(log!.settlementId).toBe(GANG_A.home_settlement_id);
    expect(log!.description).toContain('⚠');
  });

  it('returns null if the gang\'s home settlement is not in the world', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const orphanGang: GeneratedGang = { ...GANG_A, home_settlement_id: 'no-such-id' };
    const log = simulateTurn(orphanGang, WORLD, new Map(), [orphanGang]);
    expect(log).toBeNull();
  });
});

// ── resolveRivalActions — integration tests ───────────────────────────────────

const app = createApp();
const USERS: string[] = [];

afterAll(async () => {
  const db = getDb();
  for (const u of USERS) await db.query(`DELETE FROM players WHERE username = $1`, [u]);
});

async function register(suffix: string) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ username: `rivsim-${suffix}`, password: 'testpw123' });
  if (!res.body.token) throw new Error(`Register failed: ${JSON.stringify(res.body)}`);
  USERS.push(`rivsim-${suffix}`);
  return res.body as { token: string; playerId: string };
}

describe('resolveRivalActions — hours cap', () => {
  it('runs at most 24 turns per call regardless of actual elapsed time', async () => {
    const { token, playerId } = await register(`hcap-${Date.now()}`);

    // Trigger world generation
    await request(app).get('/api/world/map').set('Authorization', `Bearer ${token}`);

    // Set last_rival_sim_at to 100 hours ago — should still cap at 24 turns
    const db = getDb();
    await db.query(
      `UPDATE gangs SET last_rival_sim_at = NOW() - INTERVAL '100 hours' WHERE owner_player_id = $1`,
      [playerId],
    );

    // Clear any pre-existing log entries
    await db.query(`DELETE FROM gang_action_log WHERE player_id = $1`, [playerId]);

    await request(app)
      .get('/api/territory/activity/unread-count')
      .set('Authorization', `Bearer ${token}`);

    const logRes = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM gang_action_log WHERE player_id = $1`,
      [playerId],
    );
    // Max 24 turns × up to 20 gangs = 480, but capped at 50 per call
    expect(logRes.rows[0].n).toBeLessThanOrEqual(50);
    // Should have produced SOME entries (24 turns × multiple gangs)
    expect(logRes.rows[0].n).toBeGreaterThan(0);
  });

  it('produces 0 new entries when called a second time within the same hour', async () => {
    const { token, playerId } = await register(`hzero-${Date.now()}`);
    await request(app).get('/api/world/map').set('Authorization', `Bearer ${token}`);

    // First call — produces entries and stamps NOW()
    await request(app)
      .get('/api/territory/activity/unread-count')
      .set('Authorization', `Bearer ${token}`);

    const db = getDb();
    await db.query(`DELETE FROM gang_action_log WHERE player_id = $1`, [playerId]);

    // Second call within the same second — hours=0, should return []
    await request(app)
      .get('/api/territory/activity/unread-count')
      .set('Authorization', `Bearer ${token}`);

    const logRes = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM gang_action_log WHERE player_id = $1`,
      [playerId],
    );
    expect(logRes.rows[0].n).toBe(0);
  });
});

describe('resolveRivalActions — log trimming', () => {
  it('trims gang_action_log to at most 100 entries per player', async () => {
    const { token, playerId } = await register(`ltrim-${Date.now()}`);
    await request(app).get('/api/world/map').set('Authorization', `Bearer ${token}`);

    const db = getDb();
    // Insert 105 fake log entries
    for (let i = 0; i < 105; i++) {
      await db.query(
        `INSERT INTO gang_action_log (player_id, action_type, gang_id, gang_name, settlement_id, settlement_name, description)
         VALUES ($1, 'patrol', 'fake-g', 'Fake Gang', 'fake-s', 'Fake Town', $2)`,
        [playerId, `Fake patrol ${i}`],
      );
    }

    // Trigger sim — the trim runs after writing new entries
    await db.query(
      `UPDATE gangs SET last_rival_sim_at = NOW() - INTERVAL '2 hours' WHERE owner_player_id = $1`,
      [playerId],
    );
    await request(app)
      .get('/api/territory/activity/unread-count')
      .set('Authorization', `Bearer ${token}`);

    const logRes = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM gang_action_log WHERE player_id = $1`,
      [playerId],
    );
    expect(logRes.rows[0].n).toBeLessThanOrEqual(100);
  });
});
