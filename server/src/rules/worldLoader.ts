import type { Pool } from 'pg';
import type { GeneratedWorld } from '@carwars/shared';
import { generateWorld } from './worldGen';

export async function getWorldForGang(
  db: Pool,
  playerId: string,
): Promise<{ world: GeneratedWorld; gangId: string; fromNodeId: string } | null> {
  const r = await db.query<{
    id: string;
    world_seed: number | null;
    generated_world: GeneratedWorld | null;
    current_world_node_id: string;
  }>(
    `SELECT id, world_seed, generated_world, current_world_node_id
       FROM gangs WHERE owner_player_id = $1`,
    [playerId],
  );
  if (!r.rows.length) return null;

  const row = r.rows[0];
  let world = row.generated_world;

  if (!world) {
    const seed = row.world_seed ?? Math.floor(Math.random() * 2147483647);
    world = generateWorld(seed);
    await db.query(
      `UPDATE gangs SET world_seed = $1, generated_world = $2, current_world_node_id = $3
         WHERE owner_player_id = $4`,
      [seed, JSON.stringify(world), world.playerStartSettlementId, playerId],
    );
    return {
      world,
      gangId: row.id,
      fromNodeId: world.playerStartSettlementId,
    };
  }

  return { world, gangId: row.id, fromNodeId: row.current_world_node_id };
}
