import type { GeneratedWorld } from '@carwars/shared';
import { mkRng } from './worldGen';

export interface GeneratedGang {
  id: string;
  name: string;
  primary_colour: number;
  secondary_colour: number;
  starting_influence: number;
  home_settlement_id: string;
  treasury: number;
}

const GANG_PREFIXES = [
  'Iron', 'Blood', 'Shadow', 'Dead', 'Red', 'Black', 'Ghost',
  'Rust', 'Fallen', 'Crimson', 'Ash', 'Thorn', 'Void', 'Grave', 'Storm',
];
const GANG_SUFFIXES = [
  'Wolves', 'Ravens', 'Reapers', 'Hounds', 'Fangs', 'Jackals',
  'Vipers', 'Hawks', 'Demons', 'Wraiths', 'Steel', 'Bones', 'Knights', 'Sinners',
];

function gangName(rng: () => number, used: Set<string>): string {
  for (let i = 0; i < 200; i++) {
    const p = GANG_PREFIXES[Math.floor(rng() * GANG_PREFIXES.length)];
    const s = GANG_SUFFIXES[Math.floor(rng() * GANG_SUFFIXES.length)];
    const n = `${p} ${s}`;
    if (!used.has(n)) { used.add(n); return n; }
  }
  const fallback = `Gang-${used.size}`;
  used.add(fallback);
  return fallback;
}

function gangId(seed: number, index: number): string {
  const h = (n: number) => Math.abs(n).toString(16).padStart(8, '0');
  return `${h(seed)}-${h(index)}-4${h(index * 7 & 0xfffffff).slice(1)}-${h(seed ^ index)}-${h(seed * 31 + index)}`.slice(0, 36);
}

export function generateGangs(world: GeneratedWorld, seed: number): GeneratedGang[] {
  const rng  = mkRng(seed + 0xdeadbeef);
  const used = new Set<string>();

  const totalPop  = world.settlements.reduce((s, n) => s + n.population, 0);
  const gangCount = Math.max(4, Math.min(20, Math.floor(Math.sqrt(totalPop / 15000))));

  const totalWeight = world.settlements.reduce((s, n) => s + n.population, 0);

  const gangs: GeneratedGang[] = [];
  for (let i = 0; i < gangCount; i++) {
    let pick   = rng() * totalWeight;
    let homeId = world.settlements[0].id;
    for (const s of world.settlements) {
      pick -= s.population;
      if (pick <= 0) { homeId = s.id; break; }
    }

    gangs.push({
      id:                gangId(seed, i),
      name:              gangName(rng, used),
      primary_colour:    Math.floor(rng() * 0xffffff),
      secondary_colour:  Math.floor(rng() * 0xffffff),
      starting_influence: 30 + Math.floor(rng() * 20),
      home_settlement_id: homeId,
      treasury:          5000 + Math.floor(rng() * 10000),
    });
  }

  return gangs;
}
