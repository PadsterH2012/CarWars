import type { Pool } from 'pg';

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
