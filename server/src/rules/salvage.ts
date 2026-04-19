import type { WreckageObject, WreckageState, WreckageCause } from '@carwars/shared';

// Salvage value multipliers (Compendium 2e, adapted):
// A kinetic kill on a mostly-intact smouldering wreck yields the most recoverable
// parts; fire and explosions destroy components, reducing salvage.
const STATE_MULT: Record<WreckageState, number> = {
  smouldering: 1.0,
  debris:      0.7,
  burning:     0.4,
};

const CAUSE_MULT: Record<WreckageCause, number> = {
  kinetic:   1.0,
  collision: 0.9,
  energy:    0.9,
  fire:      0.6,
  explosion: 0.5,
};

const BASE_FRACTION = 0.30;   // peak salvage = 30% of original build cost

export function salvageValueOf(wreck: WreckageObject): number {
  if (wreck.originalValue <= 0) return 0;
  const intactness = wreck.maxDP > 0 ? wreck.remainingDP / wreck.maxDP : 0;
  const raw = wreck.originalValue
    * BASE_FRACTION
    * intactness
    * STATE_MULT[wreck.state]
    * CAUSE_MULT[wreck.causedBy];
  return Math.floor(Math.max(0, raw));
}

// Sum of salvage the winner recovers from every wreck that wasn't theirs.
export function totalSalvageFor(wrecks: WreckageObject[], winnerPlayerId: string | null): number {
  if (!winnerPlayerId) return 0;
  return wrecks
    .filter(w => w.playerId !== winnerPlayerId)
    .reduce((sum, w) => sum + salvageValueOf(w), 0);
}
