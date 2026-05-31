import { Pool } from 'pg';
import { generateWorld } from '../rules/worldGen';
import { generateGangs } from '../rules/gangGen';
import { seedGangInfluence } from '../rules/worldLoader';

let pool: Pool | null = null;

export function getDb(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL ?? 'postgresql://localhost/carwars'
    });
    pool.on('error', (err) => console.error('Idle client error', err));
  }
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function migrateGeneratedWorlds(): Promise<void> {
  const db = getDb();
  const result = await db.query<{ owner_player_id: string; world_seed: number | null }>(
    `SELECT owner_player_id, world_seed FROM gangs WHERE generated_world IS NULL`,
  );
  for (const row of result.rows) {
    const seed  = row.world_seed ?? Math.floor(Math.random() * 2147483647);
    const world = generateWorld(seed);
    const gangs = generateGangs(world, seed);
    await db.query(
      `UPDATE gangs SET world_seed = $1, generated_world = $2, generated_gangs = $3,
                        current_world_node_id = $4
         WHERE owner_player_id = $5`,
      [seed, JSON.stringify(world), JSON.stringify(gangs),
       world.playerStartSettlementId, row.owner_player_id],
    );
    await seedGangInfluence(db, world, gangs);
    console.log(`[migrate] Generated world (seed ${seed}) for gang owner ${row.owner_player_id}`);
  }
  if (!result.rows.length) {
    console.log('[migrate] All gangs already have generated worlds');
  }
}
