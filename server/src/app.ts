import express from 'express';
import cors from 'cors';
import { zonesRouter } from './api/zones';

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/zones', zonesRouter);
  return app;
}
