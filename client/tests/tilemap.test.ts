import arenaMap from '../src/tilemaps/arena-1.json';
import townMap from '../src/tilemaps/town-1.json';

test('arena-1 tilemap has correct dimensions', () => {
  expect(arenaMap.width).toBe(40);
  expect(arenaMap.height).toBe(23);
  expect(arenaMap.layers).toHaveLength(2);
  expect(arenaMap.layers[0].data).toHaveLength(40 * 23);
});

test('town-1 tilemap has required layers', () => {
  expect(townMap.layers.find(l => l.name === 'ground')).toBeDefined();
  expect(townMap.layers.find(l => l.name === 'buildings')).toBeDefined();
});
