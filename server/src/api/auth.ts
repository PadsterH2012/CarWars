import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { getDb } from '../db/client';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-prod';
export const SALT_ROUNDS = 10;

export const authRouter = Router();

authRouter.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || username.length > 32 || password.length < 6) {
    return res.status(400).json({ error: 'Invalid username or password' });
  }
  try {
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const db = getDb();
    const result = await db.query(
      `INSERT INTO players (username, password_hash) VALUES ($1, $2) RETURNING id`,
      [username, hash]
    );
    const playerId = result.rows[0].id;
    const token = jwt.sign({ playerId }, JWT_SECRET, { expiresIn: '30d' });
    return res.status(201).json({ token, playerId });
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username taken' });
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

authRouter.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const db = getDb();
  const result = await db.query(
    `SELECT id, password_hash FROM players WHERE username = $1`,
    [username]
  );
  if (!result.rows.length) return res.status(401).json({ error: 'Invalid credentials' });

  const player = result.rows[0];
  const match = await bcrypt.compare(password, player.password_hash);
  if (!match) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ playerId: player.id }, JWT_SECRET, { expiresIn: '30d' });
  return res.json({ token, playerId: player.id });
});
