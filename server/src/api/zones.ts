import { Router } from 'express';
import type { ZoneMetadata } from '@carwars/shared';

export const zonesRouter = Router();

const ZONE_REGISTRY: Record<string, ZoneMetadata> = {
  'arena-1': {
    id: 'arena-1',
    type: 'arena',
    name: 'Autoduel Arena',
    exits: [{ direction: 'south', destinationZoneId: 'town-1' }]
  },
  'town-1': {
    id: 'town-1',
    type: 'town',
    name: 'Midville',
    exits: [{ direction: 'north', destinationZoneId: 'arena-1' }]
  }
};

zonesRouter.get('/:id', (req, res) => {
  const zone = ZONE_REGISTRY[req.params.id];
  if (!zone) return res.status(404).json({ error: 'Zone not found' });
  return res.json(zone);
});
