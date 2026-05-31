import type { Pool } from 'pg';
import type { GeneratedWorld } from '@carwars/shared';
import { generateWorld } from './worldGen';
import { generateGangs, type GeneratedGang } from './gangGen';

export async function seedGangInfluence(
  db: Pool,
  world: GeneratedWorld,
  gangs: GeneratedGang[],
): Promise<void> {
  for (const gang of gangs) {
    await db.query(
      `INSERT INTO zone_influence (settlement_id, gang_id, influence)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [gang.home_settlement_id, gang.id, gang.starting_influence],
    );
    const adjRoads = world.roads.filter(
      r => r.from === gang.home_settlement_id || r.to === gang.home_settlement_id,
    );
    for (const road of adjRoads) {
      const adjId  = road.from === gang.home_settlement_id ? road.to : road.from;
      const adjInf = 10 + Math.floor(Math.random() * 10);
      await db.query(
        `INSERT INTO zone_influence (settlement_id, gang_id, influence)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [adjId, gang.id, adjInf],
      );
    }
  }
}

export async function getWorldForGang(
  db: Pool,
  playerId: string,
): Promise<{ world: GeneratedWorld; gangs: GeneratedGang[]; gangId: string; fromNodeId: string } | null> {
  const r = await db.query<{
    id: string;
    world_seed: number | null;
    generated_world: GeneratedWorld | null;
    generated_gangs: GeneratedGang[] | null;
    current_world_node_id: string;
  }>(
    `SELECT id, world_seed, generated_world, generated_gangs, current_world_node_id
       FROM gangs WHERE owner_player_id = $1`,
    [playerId],
  );
  if (!r.rows.length) return null;

  const row = r.rows[0];
  let world = row.generated_world;

  if (!world) {
    const seed  = row.world_seed ?? Math.floor(Math.random() * 2147483647);
    world       = generateWorld(seed);
    const gangs = generateGangs(world, seed);

    await db.query(
      `UPDATE gangs
          SET world_seed = $1, generated_world = $2, generated_gangs = $3,
              current_world_node_id = $4
        WHERE owner_player_id = $5`,
      [seed, JSON.stringify(world), JSON.stringify(gangs),
       world.playerStartSettlementId, playerId],
    );

    await seedGangInfluence(db, world, gangs);

    return { world, gangs, gangId: row.id, fromNodeId: world.playerStartSettlementId };
  }

  const gangs: GeneratedGang[] = row.generated_gangs ?? [];
  return { world, gangs, gangId: row.id, fromNodeId: row.current_world_node_id };
}
