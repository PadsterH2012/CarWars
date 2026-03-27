import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDb, closeDb } from '../src/db/client';

describe('database', () => {
  beforeAll(async () => {
    const db = getDb();
    await db.query(`
      CREATE TABLE IF NOT EXISTS players (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        money INTEGER NOT NULL DEFAULT 25000,
        division INTEGER NOT NULL DEFAULT 5,
        reputation INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  });

  afterAll(closeDb);

  it('inserts and retrieves a player', async () => {
    const db = getDb();
    const res = await db.query(
      `INSERT INTO players (username, password_hash) VALUES ($1, $2) RETURNING id, username, money`,
      ['testdriver', 'hash']
    );
    expect(res.rows[0].username).toBe('testdriver');
    expect(res.rows[0].money).toBe(25000);
    await db.query('DELETE FROM players WHERE username = $1', ['testdriver']);
  });
});
