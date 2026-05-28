import express from 'express';
import cors from 'cors';
import path from 'path';
import { authRouter } from './api/auth';
import { vehiclesRouter } from './api/vehicles';
import { driversRouter } from './api/drivers';
import { economyRouter, jobsRouter } from './api/economy';
import { divisionRouter } from './api/division';
import { zonesRouter } from './api/zones';
import { designRouter } from './api/design';
import { gangsRouter } from './api/gangs';
import { weaponsRouter } from './api/weapons';
import { catalogRouter } from './api/catalog';
import { stockRouter } from './api/stock';
import { mapsRouter } from './api/maps';
import { worldRouter } from './api/world';
import { requireAuth, AuthRequest } from './api/middleware';
import { getDb } from './db/client';

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use('/api/auth', authRouter);
  app.use('/api/vehicles/design', designRouter);
  app.use('/api/vehicles', vehiclesRouter);
  app.use('/api/drivers', driversRouter);
  app.use('/api/economy', economyRouter);
  app.use('/api/jobs', jobsRouter);
  app.use('/api/division', divisionRouter);
  app.use('/api/zones', zonesRouter);
  app.use('/api/gangs', gangsRouter);
  app.use('/api/weapons', weaponsRouter);
  app.use('/api/catalog', catalogRouter);
  app.use('/api/stock', stockRouter);
  app.use('/api/maps', mapsRouter);
  app.use('/api/world', worldRouter);

  app.get('/api/me', requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const result = await db.query(
      `SELECT id, username, money, division, reputation FROM players WHERE id = $1`,
      [req.playerId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    return res.json(result.rows[0]);
  });

  // Serve client static files — in production these are in /public next to dist/main.js
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));
  // SPA fallback — return index.html for any non-API route
  app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  return app;
}
