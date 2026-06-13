# Territory Economy (rival gang influence)

How NPC ("rival") gangs gain, hold, and lose territory, and how to tune it.

## Why this exists

Each player has their **own generated world** with NPC rival gangs. Territory
control is tracked as **influence** per settlement (`zone_influence` table), and
the **leaderboard ranks gangs by total influence** (holding #1 for 3 hours is the
win condition).

Originally rivals were handed 30–50 influence **for free** at world-gen and grew
it via **costless dice rolls**, while their `treasury` was never spent. That made
the leaderboard feel false ("how do they own so much with no funds?"). The
economy below ties rival territory to a real earn→spend loop, mirroring the
player.

> Not to be confused with **reputation** (`players.reputation`) — a personal
> fame score that drives *division* standings. Influence = territory; reputation
> = fighting fame. They are independent.

## The model

The sim runs as a **time-based catch-up**: when the player opens the territory
screen, `resolveRivalActions` runs one **turn ≈ one real hour** elapsed since the
last run (capped at 24). Each turn, **every gang**:

1. **Earns income** from held territory:
   `income = totalInfluence × incomePerInfluence` → added to treasury.
2. **Pays upkeep** to hold it (super-linear, so big empires cost disproportionately
   more):
   `upkeep = totalInfluence × maintenancePerInfluence × (1 + totalInfluence / maintenanceScaleK)`
   - If the treasury covers it → paid.
   - If not → treasury drops to 0 and the gang **loses `decayWhenBroke` influence**,
     shedding its **smallest (fringe) settlements first**.
3. **Takes one action**, but only if it can **afford the cost** (a broke gang sits
   idle and recovers):
   - **patrol** (`patrolCost`) — reinforce a held settlement (`+1 + floor(inf/20)`).
   - **expand** (`expandCost`) — move into an adjacent un-held settlement (`+5–10`).
   - **harass** (`harassCost`) — raid a rival sharing a settlement (`−3–8` to them).
   - **attack** — free; logged as a threat to the player, no influence change yet.

### Equilibrium / natural ceiling

Income is linear in influence; upkeep is super-linear. They cross when
`maintenancePerInfluence × (1 + I/maintenanceScaleK) > incomePerInfluence`.
With the defaults that's around **I ≈ 125**: beyond it a gang runs a deficit,
can't fund upkeep, and decays back down. So gangs settle at an economy-driven
size instead of snowballing forever. Lower `maintenanceScaleK` → harder/lower
ceiling; raise it → gangs can grow larger.

A gang's starting **treasury (5,000–15,000)** funds an early land-grab; after
that, expansion must be paid for out of territory income.

## Tunable constants

All in **`server/src/rules/rivalSim.ts`** → `TERRITORY_ECONOMY`:

| Constant | Default | Effect |
|---|---|---|
| `incomePerInfluence` | 12 | Credits earned per influence per turn. ↑ = faster growth, higher ceiling. |
| `maintenancePerInfluence` | 8 | Base cost to hold each influence per turn. ↑ = slower growth, lower ceiling. |
| `maintenanceScaleK` | 250 | Super-linearity knee. ↓ = harder/lower ceiling; ↑ = bigger empires possible. |
| `patrolCost` | 150 | Cost to reinforce a held settlement. |
| `expandCost` | 1200 | Cost to take a new settlement. ↑ = slower expansion. |
| `harassCost` | 500 | Cost to raid a rival. |
| `decayWhenBroke` | 3 | Influence lost per turn when upkeep can't be paid. ↑ = faster collapse when broke. |

Starting foothold is in **`server/src/rules/gangGen.ts`**:
`starting_influence: 3 + rng()*6` (3–8) — a small home presence only; the rest
must be earned. Keep it ≥ 1 so a gang always has somewhere to act from.

## Where the code lives

| Concern | File |
|---|---|
| Per-turn economy + actions | `server/src/rules/rivalSim.ts` (`applyEconomy`, `simulateTurn`) |
| Catch-up runner + persistence | `server/src/rules/rivalSim.ts` (`resolveRivalActions`) — persists treasuries back to `generated_gangs` JSONB |
| Starting foothold + treasury | `server/src/rules/gangGen.ts` |
| Initial influence seeding | `server/src/rules/worldLoader.ts` (`seedGangInfluence`) |
| Sim trigger | `server/src/api/territory.ts` |
| Leaderboard (ranks by Σ influence) | `server/src/api/leaderboard.ts` |

## Tuning recipes

- **Gangs grow too fast / board runs away** → lower `incomePerInfluence` or
  `maintenanceScaleK`, or raise `maintenancePerInfluence` / `expandCost`.
- **Board too static / nobody expands** → raise `incomePerInfluence` or lower
  `expandCost`.
- **Want a believable head start for "older" worlds** → raise `starting_influence`
  (but it then reads as less earned).
- **Want gangs to collapse faster under pressure** → raise `decayWhenBroke` and
  `harassCost` effects.

## Tests

`server/tests/rivalSim.test.ts` → `describe('simulateTurn — economy')` covers the
spend gate (broke gang can't expand), territory income, and the broke-decay
ceiling. Adjust the expected numbers there if you retune the constants.
