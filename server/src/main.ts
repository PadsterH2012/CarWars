import http from 'http';
import { createApp } from './app';
import { attachWss } from './ws/handler';
import { getDb, migrateGeneratedWorlds } from './db/client';

async function start() {
  // Reset any vehicles left in_arena from a previous crash
  const db = getDb();
  await db.query(`UPDATE vehicles SET in_arena = FALSE WHERE in_arena = TRUE`);

  // One-time migration: generate worlds for any gangs that pre-date Phase 5a
  await migrateGeneratedWorlds();

  const app = createApp();
  const server = http.createServer(app);
  attachWss(server);

  server.listen(3001, '0.0.0.0', () => console.log('Server running on 0.0.0.0:3001'));
}

start().catch(err => { console.error('Startup failed:', err); process.exit(1); });
