// Driver candidate generator — picks a name, rolls a skill level, computes
// hire cost, occasionally bundles a stock vehicle. All generation is stateless;
// the API layer persists the results into the hire_candidates table.

const FIRST_NAMES = [
  'Rick', 'Jax', 'Mad', 'Duke', 'Scar', 'Nyx', 'Cinder', 'Vex', 'Draco',
  'Reaper', 'Spike', 'Razor', 'Blaze', 'Iron', 'Steel', 'Flint', 'Hawk',
  'Wolf', 'Viper', 'Ghost', 'Ash', 'Knox', 'Raven', 'Gauge', 'Talon',
  'Jett', 'Slade', 'Ember', 'Crow', 'Ryder', 'Lexa', 'Nova', 'Maddox',
  'Wraith', 'Torch', 'Scythe', 'Kira', 'Sasha', 'Zara', 'Kai', 'Rio',
  'Axel', 'Brix', 'Dex', 'Eve', 'Fenn', 'Grimm', 'Hunter', 'Ivan',
  'Jade', 'Kord', 'Lyra', 'Milo', 'Nox', 'Onyx', 'Pike', 'Quinn',
  'Rex', 'Sable', 'Tank', 'Ulyss', 'Vance', 'Wyatt', 'Xyla', 'Yori', 'Zane',
];

const LAST_NAMES = [
  'Steele', 'Kade', 'Grave', 'Slate', 'Thorn', 'Cross', 'Drake', 'Hunter',
  'Stryker', 'Blackwood', 'Ashby', 'Redline', 'Krug', 'Valance', 'Rourke',
  'Falco', 'Vash', 'Ross', 'Wolfe', 'Kane', 'Dusk', 'Vaughn', 'Kestrel',
  'Roark', 'Nighthawk', 'Stone', 'Creed', 'Thorne', 'Valko', 'Marsh',
  'Voss', 'Rhyne', 'Calder', 'Darro', 'Elan', 'Frost', 'Grell', 'Hale',
  'Idris', 'Jorik', 'Kline', 'Locke', 'Morran', 'Nyle', 'Orin', 'Pyke',
];

// Nickname bank — used ~15% of the time, shown in quotes between first and last
const NICKNAMES = [
  'Dead Eye', 'Red Eye', 'One-Punch', 'Snake Eye', 'Hellfire', 'Mad Dog',
  'Iron Heart', 'Dusk', 'Ghost', 'Gunner', 'Slingshot', 'Torch', 'Boom',
  'Widowmaker', 'Crash', 'Flatline', 'Blackout', 'Fangs', 'Stinger',
  'Hollow', 'Razor', 'Scrap', 'Six-Gun', 'Bulldog', 'Lockjaw', 'Smoke',
];

// Flavour blurbs shown on the candidate card — adds personality without
// requiring the player to read a generated backstory.
const BLURBS = [
  'Fresh out of the arena circuit. Looking to prove themselves.',
  'Ex-military. Doesn\u2019t talk much about the war.',
  'Former courier — fast, reliable, expensive.',
  'Gang rat. Cheap, loyal, holds a grudge.',
  'Burnt out from the league. Just wants steady pay.',
  'Untested rookie but got the reflexes.',
  'Veteran duellist. Seen things you wouldn\u2019t believe.',
  'Ex-cop. Plays it safe but gets the job done.',
  'Spent five years in the wastes. Now wants a garage gig.',
  'Rumour says they jumped a rival gang and walked away.',
  'Looks calm in the pits. Fights like a demon in the arena.',
  'Family of mechanics. Talks to the engine like it\u2019s people.',
  'Ran with the Wolves once. Won\u2019t say why they left.',
  'New to the division but hungry.',
  'No home, no ties, just the road.',
];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ─── Attributes ────────────────────────────────────────────────────────────

export interface Attributes {
  st: number;
  dx: number;
  iq: number;
  ht: number;
}

function roll3d6Clamped(min: number, max: number): number {
  const raw = (Math.floor(Math.random() * 6) + 1) +
              (Math.floor(Math.random() * 6) + 1) +
              (Math.floor(Math.random() * 6) + 1);
  return Math.max(min, Math.min(max, raw));
}

export function generateAttributes(): Attributes {
  return {
    st: roll3d6Clamped(8, 12),
    dx: roll3d6Clamped(8, 12),
    iq: roll3d6Clamped(8, 12),
    ht: roll3d6Clamped(8, 12),
  };
}

// Starting skill distribution: ceil(skill/2) in driving_standard,
// floor(skill/2) in gunnery_guns. Mirrors the SQL backfill for consistency.
export function generateStartingSkills(skill: number): Record<string, number> {
  const out: Record<string, number> = {};
  const driving = Math.ceil(skill / 2);
  const gunnery = Math.floor(skill / 2);
  if (driving > 0) out['driving_standard'] = driving;
  if (gunnery > 0) out['gunnery_guns'] = gunnery;
  return out;
}

// Skill distribution — weighted so skill 3 is the mean; skill 6 is rare.
// Returns a skill integer 1..6.
function rollSkill(): number {
  const r = Math.random();
  if (r < 0.05) return 1;
  if (r < 0.35) return 2;
  if (r < 0.70) return 3;
  if (r < 0.90) return 4;
  if (r < 0.98) return 5;
  return 6;
}

// Hire cost scales super-linearly so a skill-5 veteran is a real investment.
// Anchored so skill 3 lines up with the old flat $500 baseline-ish.
function skillToHireCost(skill: number): number {
  const table: Record<number, number> = {
    1: 200, 2: 500, 3: 1200, 4: 2800, 5: 6000, 6: 10000,
  };
  return table[skill] ?? 1200;
}

// Hire tiers. Each tier draws skill from a different band and gates on
// different conditions (see generateTieredPool):
//   rookie   — skill 1-2, cheap, always available
//   standard — skill 1-6, the original pool
//   premium  — skill 4-6, only offered once the player has proven themselves
export type DriverTier = 'rookie' | 'standard' | 'premium';

export interface GeneratedCandidate {
  name: string;
  skill: number;
  aggression: number;
  loyalty: number;
  hireCost: number;
  blurb: string;
  tier: DriverTier;
  startingAttributes: Attributes;
  startingSkills: Record<string, number>;
  // Optional vehicle package — stock vehicle id + discount applied to the
  // stock vehicle's cost if the player accepts the package deal.
  vehicleStockId?: string;
  vehicleDiscountPct?: number;
}

// Roll a skill within an inclusive [min,max] band, biased toward the lower
// end so the top of each band stays a touch rarer than the floor.
function rollSkillInRange(min: number, max: number): number {
  const span = max - min;
  // Two-roll average skews toward the middle/low end without extra tables.
  const r = (Math.random() + Math.random()) / 2;
  return min + Math.round(r * span);
}

// Build `count` fresh candidates. If `stockIdsByDivision[player_division]` is
// present, a small fraction of candidates will bring a random vehicle from
// that division at a discount.
// Build one candidate with a fixed skill and tier. Shared by both the legacy
// flat pool and the tiered pool so naming/flavour/package logic lives in one
// place.
function buildCandidate(skill: number, tier: DriverTier, eligibleStockIds: string[]): GeneratedCandidate {
  const useNick = Math.random() < 0.15;
  const first = pick(FIRST_NAMES);
  const last = pick(LAST_NAMES);
  const name = useNick
    ? `${first} "${pick(NICKNAMES)}" ${last}`
    : `${first} ${last}`;
  const aggression = 1 + Math.floor(Math.random() * 6);
  const loyalty    = 3 + Math.floor(Math.random() * 4);  // 3..6
  const hireCost = skillToHireCost(skill);
  const blurb = pick(BLURBS);

  // 15% chance the candidate brings their own car. Skill >= 4 skews toward
  // bringing one (veterans have built rigs over time).
  const packageChance = skill >= 4 ? 0.3 : 0.1;
  let vehicleStockId: string | undefined;
  let vehicleDiscountPct: number | undefined;
  if (eligibleStockIds.length > 0 && Math.random() < packageChance) {
    vehicleStockId = pick(eligibleStockIds);
    vehicleDiscountPct = 15 + Math.floor(Math.random() * 16);  // 15..30%
  }

  const startingAttributes = generateAttributes();
  const startingSkills = generateStartingSkills(skill);

  return { name, skill, aggression, loyalty, hireCost, blurb, tier, startingAttributes, startingSkills, vehicleStockId, vehicleDiscountPct };
}

export function generateCandidatePool(
  count: number,
  playerDivision: number,
  eligibleStockIds: string[],
): GeneratedCandidate[] {
  const out: GeneratedCandidate[] = [];
  for (let i = 0; i < count; i++) {
    out.push(buildCandidate(rollSkill(), 'standard', eligibleStockIds));
    // Reference the player's division so lint doesn't complain when
    // future logic wants it; currently unused until we scale candidate
    // quality to player skill/rep.
    void playerDivision;
  }
  return out;
}

// How many candidates each tier contributes to a fresh pool.
const TIER_COUNTS = { rookie: 3, standard: 5, premium: 3 } as const;

// Build a mixed-tier pool. Rookies (skill 1-2) and the standard band (skill
// 1-6) are always offered; the premium band (skill 4-6) is only included when
// `premiumUnlocked` (the API gates this on arena wins).
export function generateTieredPool(
  playerDivision: number,
  eligibleStockIds: string[],
  opts: { premiumUnlocked: boolean },
): GeneratedCandidate[] {
  const out: GeneratedCandidate[] = [];
  for (let i = 0; i < TIER_COUNTS.rookie; i++) {
    out.push(buildCandidate(rollSkillInRange(1, 2), 'rookie', eligibleStockIds));
  }
  for (let i = 0; i < TIER_COUNTS.standard; i++) {
    out.push(buildCandidate(rollSkill(), 'standard', eligibleStockIds));
  }
  if (opts.premiumUnlocked) {
    for (let i = 0; i < TIER_COUNTS.premium; i++) {
      out.push(buildCandidate(rollSkillInRange(4, 6), 'premium', eligibleStockIds));
    }
  }
  void playerDivision;
  return out;
}
