import type { GeneratedWorld, GeneratedSettlement, GeneratedRoad, SettlementKind, RoadType } from '@carwars/shared';

export type { GeneratedWorld, GeneratedSettlement, GeneratedRoad };

// ─── Seeded PRNG (mulberry32) ────────────────────────────────────────────────
function mkRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6D2B79F5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateWorld(seed: number): GeneratedWorld {
  const rng = mkRng(seed);
  // stub — full implementation in subsequent tasks
  return {
    seed,
    settlements: [],
    roads: [],
    capitals: [],
    playerStartSettlementId: '',
  };
}
