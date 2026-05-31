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

  // ── 2. Subordinate settlements ───────────────────────────────────────────────
  let subIdx = 0;
  for (let ci = 0; ci < capitalIds.length; ci++) {
    const cap   = settlements[ci];
    const count = Math.max(1, Math.floor(Math.sqrt(cap.population / 10000)));

    for (let k = 0; k < count; k++) {
      const angle = rng() * Math.PI * 2;
      const dist  = 80 + Math.floor(rng() * 220);   // 80-300 from capital
      const x     = Math.round(Math.max(10, Math.min(990, cap.x + Math.cos(angle) * dist)));
      const y     = Math.round(Math.max(10, Math.min(990, cap.y + Math.sin(angle) * dist)));

      const id   = `sub-${seed}-${subIdx++}`;
      const name = pickName(rng, used);

      let kind: SettlementKind;
      let population: number;
      let services: string[];

      if (dist < 130) {
        kind = 'town'; population = 1000 + Math.floor(rng() * 9000);
        services = ['garage', 'arena', 'jobs', 'market'];
      } else if (dist < 220) {
        kind = 'village'; population = 500 + Math.floor(rng() * 4500);
        services = ['garage', 'jobs'];
      } else {
        kind = 'outpost'; population = 100 + Math.floor(rng() * 900);
        services = ['fuel', 'repairs'];
      }

      settlements.push({ id, name, kind, x, y, population, services });
    }
  }

  // ── 3. Roads ────────────────────────────────────────────────────────────────
  const roads: GeneratedRoad[] = [];
  const connected = new Set<string>();

  function addRoad(from: string, to: string, roadType: RoadType): void {
    const key = [from, to].sort().join(':');
    if (connected.has(key)) return;
    connected.add(key);
    const fa = settlements.find(s => s.id === from)!;
    const ta = settlements.find(s => s.id === to)!;
    const distance = Math.round(Math.hypot(fa.x - ta.x, fa.y - ta.y));
    const danger   = Math.min(0.8, Math.max(0.05, 0.05 + distance / 1200));
    roads.push({
      id: `road-${from}-${to}`,
      from, to, distance, roadType, danger,
      encounterTable: encounterTable(roadType, danger),
    });
  }

  // Capital ↔ capital highways (complete graph)
  for (let i = 0; i < capitalIds.length; i++) {
    for (let j = i + 1; j < capitalIds.length; j++) {
      addRoad(capitalIds[i], capitalIds[j], 'highway');
    }
  }

  // Each subordinate → nearest capital
  const subs = settlements.filter(s => !capitalIds.includes(s.id));
  for (const sub of subs) {
    let nearestCapId = capitalIds[0];
    let nearestDist  = Infinity;
    for (const capId of capitalIds) {
      const cap = settlements.find(s => s.id === capId)!;
      const d   = Math.hypot(sub.x - cap.x, sub.y - cap.y);
      if (d < nearestDist) { nearestDist = d; nearestCapId = capId; }
    }
    addRoad(nearestCapId, sub.id, 'urban');
  }

  // Local roads: subordinates within the same region that are < 150 apart
  for (let a = 0; a < subs.length; a++) {
    for (let b = a + 1; b < subs.length; b++) {
      if (Math.hypot(subs[a].x - subs[b].x, subs[a].y - subs[b].y) < 150) {
        addRoad(subs[a].id, subs[b].id, 'dirt');
      }
    }
  }

  // ── 4. Player start ──────────────────────────────────────────────────────────
  const small = settlements
    .filter(s => s.population < 5000)
    .sort((a, b) => Math.hypot(a.x - 500, a.y - 500) - Math.hypot(b.x - 500, b.y - 500));

  const cutoff     = Math.max(1, Math.floor(small.length * 0.25));
  const candidates = small.slice(0, cutoff);
  const startIdx   = Math.floor(rng() * candidates.length);
  const playerStart = candidates[startIdx] ?? settlements[settlements.length - 1];

  return {
    seed,
    settlements,
    roads,
    capitals: capitalIds,
    playerStartSettlementId: playerStart.id,
  };
}
