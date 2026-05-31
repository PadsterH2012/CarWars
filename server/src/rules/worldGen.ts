import type { GeneratedWorld, GeneratedSettlement, GeneratedRoad, SettlementKind, RoadType } from '@carwars/shared';

export type { GeneratedWorld, GeneratedSettlement, GeneratedRoad };

// ─── Seeded PRNG (mulberry32) ────────────────────────────────────────────────
export function mkRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6D2B79F5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Name bank ───────────────────────────────────────────────────────────────
const NAME_PREFIXES = [
  'Dust', 'Iron', 'Red', 'Ash', 'Black', 'New', 'Fort', 'Port', 'Salt',
  'Dead', 'Bone', 'Rust', 'Grim', 'Slag', 'Tar', 'Sand', 'Cold', 'High',
  'Low', 'Old', 'Gun', 'Blade', 'Crag', 'Fell', 'Gale', 'Hawk', 'Mire',
  'Pale', 'Pike', 'Spur', 'Thorn', 'Vale', 'Wold', 'Yew', 'Zinc',
  'Smoke', 'Stone', 'Dark', 'Dry', 'Flash', 'Bare', 'Bent', 'Grave',
  'Hollow', 'Shatter', 'Waste', 'Soot', 'Mud', 'Flint',
];
const NAME_SUFFIXES = [
  'fall', 'gate', 'rock', 'creek', 'ridge', 'peak', 'town', 'burg',
  'vale', 'ford', 'moor', 'haven', 'port', 'watch', 'bridge', 'field',
  'cross', 'hollow', 'run', 'pass', 'way', 'bend', 'bluff', 'cove',
  'dale', 'end', 'grove', 'helm', 'keep', 'lade', 'marsh', 'neck',
  'side', 'point', 'mouth', 'wall', 'crest', 'draw', 'flat', 'gap',
  'knoll', 'ledge', 'shelf', 'spit', 'step', 'trace', 'yard', 'bight',
  'crest', 'gulch',
];

function pickName(rng: () => number, used: Set<string>): string {
  for (let i = 0; i < 200; i++) {
    const p = NAME_PREFIXES[Math.floor(rng() * NAME_PREFIXES.length)];
    const s = NAME_SUFFIXES[Math.floor(rng() * NAME_SUFFIXES.length)];
    const n = p + s;
    if (!used.has(n)) { used.add(n); return n; }
  }
  const fallback = `Zone-${used.size}`;
  used.add(fallback);
  return fallback;
}

// ─── Poisson-disc sampling (rejection, fine for small counts) ────────────────
function poissonDisc(
  rng: () => number, count: number,
  width: number, height: number, minDist: number,
): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let tries = 0; tries < 20000 && pts.length < count; tries++) {
    const x = Math.floor(rng() * width);
    const y = Math.floor(rng() * height);
    if (pts.every(p => Math.hypot(p.x - x, p.y - y) >= minDist)) {
      pts.push({ x, y });
    }
  }
  return pts;
}

function capitalPopulation(rng: () => number): number {
  const roll = rng();
  if (roll < 0.4) return 250000 + Math.floor(rng() * 750000);   // 250k-1M
  if (roll < 0.7) return  50000 + Math.floor(rng() * 200000);   // 50k-250k
  return                   10000 + Math.floor(rng() * 40000);    // 10k-50k
}

export function encounterTable(roadType: RoadType, danger: number): string {
  if (roadType === 'mountain') return 'gang-high';
  if (roadType === 'highway')  return danger > 0.4 ? 'highway-medium' : 'highway-low';
  if (roadType === 'urban')    return 'urban-medium';
  return 'dirt-medium';
}

export function generateWorld(seed: number): GeneratedWorld {
  const rng   = mkRng(seed);
  const used  = new Set<string>();

  // ── 1. Capitals ─────────────────────────────────────────────────────────────
  const capitalCount = 4 + Math.floor(rng() * 5);   // 4-8
  let capitalPts = poissonDisc(rng, capitalCount, 1000, 1000, 200);
  if (capitalPts.length < 4) {
    // Retry with relaxed minimum distance if the grid was too crowded
    capitalPts = poissonDisc(rng, capitalCount, 1000, 1000, 120);
  }
  const settlements: GeneratedSettlement[] = [];

  const capitalIds: string[] = capitalPts.map((pt, i) => {
    const id   = `cap-${seed}-${i}`;
    const name = pickName(rng, used);
    const pop  = capitalPopulation(rng);
    settlements.push({
      id, name, kind: 'city', x: pt.x, y: pt.y, population: pop,
      services: ['garage', 'arena', 'jobs', 'market'],
    });
    return id;
  });

  return {
    seed,
    settlements,
    roads: [],
    capitals: capitalIds,
    playerStartSettlementId: '',
  };
}
