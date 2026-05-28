import { describe, expect, it } from 'vitest';
import { midvilleRegion, validateWorldRegion, getRegion, WORLD_REGIONS } from '../src/rules/world';

describe('world map regions', () => {
  it('registers the Midville region', () => {
    expect(getRegion('midville')).toBe(midvilleRegion);
    expect(WORLD_REGIONS.midville.name).toBe('Midville Region');
  });

  it('contains the first six open-world locations', () => {
    const ids = midvilleRegion.nodes.map(n => n.id);
    expect(ids).toEqual([
      'midville-city',
      'rustwater-truck-stop',
      'new-boston',
      'fort-grimm',
      'dust-pike-arena',
      'blacktop-market',
    ]);
  });

  it('validates road endpoints, unique ids, danger, and distance', () => {
    expect(validateWorldRegion(midvilleRegion)).toEqual([]);
  });

  it('reports invalid road endpoints and unsafe road metadata', () => {
    const broken = {
      ...midvilleRegion,
      nodes: [midvilleRegion.nodes[0], midvilleRegion.nodes[0]],
      roads: [{
        id: 'bad-road',
        from: 'midville-city',
        to: 'missing-place',
        distance: 0,
        roadType: 'highway' as const,
        danger: 1.5,
        encounterTable: 'bad',
      }],
    };

    expect(validateWorldRegion(broken)).toEqual([
      'duplicate node id: midville-city',
      'road bad-road has unknown endpoint: missing-place',
      'road bad-road distance must be positive',
      'road bad-road danger must be between 0 and 1',
    ]);
  });
});
