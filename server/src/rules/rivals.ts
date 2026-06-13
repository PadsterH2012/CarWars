import type { Pool } from 'pg';
import type { GeneratedGang } from './gangGen';

// Rival data shape as stored in the rival_gangs table.
export interface RivalGang {
  id: string;
  name: string;
  description: string;
  base_skill: number;
  primary_colour: number;
  secondary_colour: number;
  emblem_id: string;
  min_division: number;
  boast_lines: string[];
  defeat_lines: string[];
  // Stock-vehicle ids this gang fields per division, e.g.
  //   { "5": ["sprocket"], "10": ["mg3","guardian"], ... }
  // Empty object means "no lineup — fall back to generic AI vehicle".
  lineup: Record<string, string[]>;
}

export interface RivalRep {
  rival_id: string;
  grudge: number;
  encounters: number;
  player_wins: number;
  rival_wins: number;
}

// Pick a rival for a player's next arena match.
// Strategy: among all rivals eligible for the player's division, prefer ones with
// an existing grudge (more personal stakes), with some randomness so a new player
// still sees variety. If no rep rows exist yet, pick any eligible rival uniformly.
export async function pickRivalForMatch(
  db: Pool,
  playerGangId: string,
  division: number,
): Promise<RivalGang | null> {
  // Car Wars division numbers go DOWN with skill — div 1 = championship, div 5 = rookies.
  // A rival with min_division=4 means "only appears against players at div ≤ 4" (i.e.,
  // only the more skilled players meet this rival). So eligibility is: player's
  // division number must be ≤ rival's min_division threshold.
  const eligibleRes = await db.query<RivalGang>(
    `SELECT id, name, description, base_skill, primary_colour, secondary_colour,
            emblem_id, min_division, boast_lines, defeat_lines, lineup
     FROM rival_gangs WHERE min_division >= $1`,
    [division],
  );
  const eligible = eligibleRes.rows;
  if (!eligible.length) return null;

  const repRes = await db.query<RivalRep>(
    `SELECT rival_id, grudge, encounters, player_wins, rival_wins
     FROM player_rival_rep WHERE player_gang_id = $1`,
    [playerGangId],
  );
  const repByRival = new Map(repRes.rows.map(r => [r.rival_id, r]));

  // Weight: base 10 + grudge*2 + encounters (a rival you've never fought still has a non-zero chance)
  const weighted = eligible.map(r => {
    const rep = repByRival.get(r.id);
    const weight = 10 + (rep?.grudge ?? 0) * 2 + (rep?.encounters ?? 0);
    return { rival: r, weight };
  });
  const total = weighted.reduce((s, w) => s + w.weight, 0);
  let pick = Math.random() * total;
  for (const entry of weighted) {
    pick -= entry.weight;
    if (pick <= 0) return entry.rival;
  }
  return weighted[weighted.length - 1].rival;
}

// Record the outcome of a match against a rival, updating grudge/counters.
// playerWon=true means the player's gang won; false means the rival won (AI victory
// or mutual kill with no human survivors).
export async function recordRivalOutcome(
  db: Pool,
  playerGangId: string,
  rivalId: string,
  playerWon: boolean,
): Promise<RivalRep> {
  // Grudge change rules:
  //   player wins → rival holds a grudge (+10)
  //   rival wins  → rival grows complacent / satisfied (-5, floored at 0)
  const grudgeDelta = playerWon ? 10 : -5;
  const result = await db.query<RivalRep>(
    `INSERT INTO player_rival_rep (player_gang_id, rival_id, grudge, encounters,
                                    player_wins, rival_wins, last_encounter)
     VALUES ($1, $2, GREATEST(0, $3), 1, $4, $5, NOW())
     ON CONFLICT (player_gang_id, rival_id) DO UPDATE SET
       grudge = GREATEST(0, player_rival_rep.grudge + $3),
       encounters = player_rival_rep.encounters + 1,
       player_wins = player_rival_rep.player_wins + $4,
       rival_wins = player_rival_rep.rival_wins + $5,
       last_encounter = NOW()
     RETURNING rival_id, grudge, encounters, player_wins, rival_wins`,
    [playerGangId, rivalId, grudgeDelta, playerWon ? 1 : 0, playerWon ? 0 : 1],
  );
  return result.rows[0];
}

// Effective AI skill for a rival's enemies in an upcoming match, factoring in grudge.
// base_skill + floor(grudge / 20), capped at 6.
export function rivalEffectiveSkill(rival: RivalGang, grudge: number): number {
  return Math.min(6, rival.base_skill + Math.floor(grudge / 20));
}

// All rivals eligible for a player's division (same rule as pickRivalForMatch:
// the player's division number must be ≤ the rival's min_division threshold).
// Used to build the free-pick opponent slate.
export async function eligibleRivals(db: Pool, division: number): Promise<RivalGang[]> {
  const res = await db.query<RivalGang>(
    `SELECT id, name, description, base_skill, primary_colour, secondary_colour,
            emblem_id, min_division, boast_lines, defeat_lines, lineup
     FROM rival_gangs WHERE min_division >= $1 ORDER BY min_division ASC, name ASC`,
    [division],
  );
  return res.rows;
}

// The lineup a rival fields when the PLAYER chose to fight them (free-pick
// duel): the gang's signature fleet — a stable, identity-defining tier rather
// than one pinned to the player's division. Division number tracks fleet value
// (div 5 ≈ rookie rigs, div 40 ≈ heavy hardware — see calcDivision), so picking
// a CHARACTERISTIC tier per gang (deterministic from its id) gives the
// opponent slate a genuine spread of threats: some gangs are a fair fight,
// others are a deadly gamble for a fat purse. Same gang → same fleet every time.
export function rivalSignatureLineup(rival: RivalGang): string[] {
  const nums = Object.keys(rival.lineup ?? {}).map(Number).filter(n => !Number.isNaN(n)).sort((a, b) => a - b);
  if (!nums.length) return [];
  const hash = [...rival.id].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
  const tier = nums[Math.abs(hash) % nums.length];
  return rival.lineup[String(tier)] ?? [];
}

// The lineup an AUTO-picked rival fields — matched to the player's tier so the
// fallback (non-free-pick, defense) path stays sensible.
export function rivalLineupForDivision(rival: RivalGang, division: number): string[] {
  return rival.lineup?.[String(division)] ?? [];
}

// Cycle a lineup out to the match's squad size — a 4-car squad against a
// 2-design lineup gets mixed pairs rather than 4 identical rigs. Mirrors the
// round-robin the handler uses when spawning enemy vehicles.
export function fieldedStockIds(lineupIds: string[], squadSize: number): string[] {
  if (!lineupIds.length) return [];
  const n = Math.max(1, squadSize);
  return Array.from({ length: n }, (_, i) => lineupIds[i % lineupIds.length]);
}

// Total cost of a set of stock vehicles (duplicates counted), from the
// stock_vehicles catalogue. Feeds the rival's fleet value in the power model.
export async function stockFleetValue(db: Pool, stockIds: string[]): Promise<number> {
  if (!stockIds.length) return 0;
  const uniq = [...new Set(stockIds)];
  const res = await db.query<{ id: string; cost: number }>(
    `SELECT id, cost FROM stock_vehicles WHERE id = ANY($1)`,
    [uniq],
  );
  const costById = new Map(res.rows.map(r => [r.id, r.cost ?? 0]));
  return stockIds.reduce((sum, id) => sum + (costById.get(id) ?? 0), 0);
}

// Adapt a GeneratedGang to the RivalGang shape the arena expects.
// Generated gangs have no lineup, so the arena falls back to generic AI vehicles.
export function adaptGeneratedGang(gang: GeneratedGang): RivalGang {
  return {
    id:               gang.id,
    name:             gang.name,
    description:      'A rival gang from the wasteland',
    base_skill:       3,
    primary_colour:   gang.primary_colour,
    secondary_colour: gang.secondary_colour,
    emblem_id:        'default',
    min_division:     5,
    boast_lines:      [],
    defeat_lines:     [],
    lineup:           {},
  };
}

// Pick a generated gang as arena rival, preferring those with zone_influence
// in the player's current settlement.
export async function pickGeneratedRivalForMatch(
  db: Pool,
  currentSettlementId: string,
  generatedGangs: GeneratedGang[],
): Promise<RivalGang | null> {
  if (!generatedGangs.length) return null;

  const res = await db.query<{ gang_id: string; influence: number }>(
    `SELECT gang_id, influence FROM zone_influence
       WHERE settlement_id = $1 ORDER BY influence DESC`,
    [currentSettlementId],
  );

  const gangMap    = new Map(generatedGangs.map(g => [g.id, g]));
  const localGangs = res.rows.map(r => gangMap.get(r.gang_id)).filter((g): g is GeneratedGang => !!g);
  const candidates = localGangs.length ? localGangs : generatedGangs;
  const picked     = candidates[Math.floor(Math.random() * candidates.length)];
  return adaptGeneratedGang(picked);
}
