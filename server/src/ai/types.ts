import type { VehicleState, ArenaMap, WreckageObject } from '@carwars/shared';
import type { Pathfinder } from './pathfinder';
import type { SquadContext } from './squad';

/**
 * Per-tick inputs bundled for the AI. Phase 1 carries the minimum superset
 * the current driver already uses (skill, map, allVehicles, wreckage, tick).
 * Phase 3 adds `pathfinder` so the tactic layer can ask "how do I reach this
 * world position given the current wall + wreckage obstacles?" and feed the
 * first waypoint back into the ring as interest. Later phases extend with:
 *   - `squadContext` (Phase 4) — shared squad brain state
 *   - `influenceMaps` (Phase 4) — threat/ally/cover sampling
 *
 * Commander orders remain a per-vehicle 3rd argument to `computeAiInput`
 * rather than living on the context — orders are per-agent, not per-tick.
 * They will move into `squadContext` when Phase 4 lands.
 */
export interface AiContext {
  skill: number;
  // Driver personality stats — default to neutral (3, 5) when the caller
  // (typically a test) doesn't have a real driver record.
  //   aggression: 0..6+ — higher = prefers close combat, ramming, anchor role
  //   loyalty:    0..10 — higher = sticks with squad, defers saturated targets,
  //                       bids higher for support role; very low = ignores retreat
  aggression?: number;
  loyalty?: number;
  map?: ArenaMap;
  allVehicles: VehicleState[];
  wreckage: WreckageObject[];
  tick: number;
  pathfinder?: Pathfinder;
  squad?: SquadContext;
}
