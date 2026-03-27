import { readFileSync } from 'fs';
import { join } from 'path';
import { getDb, closeDb } from './client';

async function migrate() {
  const db = getDb();
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  await db.query(sql);
  console.log('Migration complete');
  await closeDb();
}

migrate().catch(console.error);
