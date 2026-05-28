import type { WorldRegion } from '@carwars/shared';
import { midvilleRegion } from './regions/midville';

export { midvilleRegion };

export const WORLD_REGIONS: Record<string, WorldRegion> = {
  [midvilleRegion.id]: midvilleRegion,
};

export function getRegion(regionId: string): WorldRegion | undefined {
  return WORLD_REGIONS[regionId];
}

export function validateWorldRegion(region: WorldRegion): string[] {
  const errors: string[] = [];
  const nodeIds = new Set<string>();

  for (const node of region.nodes) {
    if (nodeIds.has(node.id)) errors.push(`duplicate node id: ${node.id}`);
    nodeIds.add(node.id);
  }

  const roadIds = new Set<string>();
  for (const road of region.roads) {
    if (roadIds.has(road.id)) errors.push(`duplicate road id: ${road.id}`);
    roadIds.add(road.id);

    for (const endpoint of [road.from, road.to]) {
      if (!nodeIds.has(endpoint)) errors.push(`road ${road.id} has unknown endpoint: ${endpoint}`);
    }

    if (road.distance <= 0) errors.push(`road ${road.id} distance must be positive`);
    if (road.danger < 0 || road.danger > 1) errors.push(`road ${road.id} danger must be between 0 and 1`);
  }

  return errors;
}
