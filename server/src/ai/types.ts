import type { VehicleState, ArenaMap, WreckageObject } from '@carwars/shared';
import type { Pathfinder } from './pathfinder';

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
  map?: ArenaMap;
  allVehicles: VehicleState[];
  wreckage: WreckageObject[];
  tick: number;
  pathfinder?: Pathfinder;
}
