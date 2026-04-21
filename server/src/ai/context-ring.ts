// Context steering ring — Andrew Fray's interest/danger selection.
// 16 slots × 22.5° each. Writers (tactic goal, walls, vehicles, wreckage,
// survival, stuck recovery) deposit strength into slots using `max` (not
// sum) so a later writer can never silently invalidate an earlier one's
// signal. `pick()` returns the best slot — lowest danger, highest interest,
// tiebroken by closeness to current facing.
//
// Compass convention matches the rest of the codebase: 0° = north (up),
// rotating clockwise (90° = east). `slotOf(bearing)` maps a bearing to a
// slot index in [0, 16).

export const SLOT_COUNT = 16;
export const SLOT_DEG = 360 / SLOT_COUNT;

// Slots are centred on multiples of SLOT_DEG — so slot 0's centre is 0° (north),
// slot 4's centre is 90° (east), etc. That way a tactic write at exactly 90°
// lands in the middle of slot 4 rather than on its edge — the edge case
// previously caused a persistent 11° drift off-target in narrow corridors.
function slotOf(bearing: number): number {
  const normalised = ((bearing % 360) + 360) % 360;
  // Half-slot offset before floor so slot boundaries fall at (k + 0.5) × SLOT_DEG
  return Math.floor((normalised + SLOT_DEG / 2) / SLOT_DEG) % SLOT_COUNT;
}

function bearingOfSlot(slot: number): number {
  return (slot * SLOT_DEG + 360) % 360; // slot centre = multiple of SLOT_DEG
}

export interface PickResult {
  bearing: number;  // centre bearing of the chosen slot (degrees)
  danger: number;   // danger value at that slot — useful for logging/tuning
  slot: number;     // slot index for callers that want to introspect
}

export class ContextRing {
  readonly interest = new Float32Array(SLOT_COUNT);
  readonly danger   = new Float32Array(SLOT_COUNT);

  reset(): void {
    this.interest.fill(0);
    this.danger.fill(0);
  }

  // Write `strength` into the slot matching `bearing`, with optional falloff
  // into the two neighbouring slots. `max` rules — we keep the higher of the
  // existing value and the new value, never sum. This is the critical Fray
  // insight: it prevents writers clobbering each other and means priority
  // is naturally encoded in strength.
  writeInterest(bearing: number, strength: number, falloff = 0.5): void {
    if (strength <= 0) return;
    const centre = slotOf(bearing);
    this.interest[centre] = Math.max(this.interest[centre], strength);
    if (falloff > 0) {
      const side = strength * falloff;
      const left  = (centre + SLOT_COUNT - 1) % SLOT_COUNT;
      const right = (centre + 1) % SLOT_COUNT;
      this.interest[left]  = Math.max(this.interest[left],  side);
      this.interest[right] = Math.max(this.interest[right], side);
    }
  }

  writeDanger(bearing: number, strength: number, falloff = 0.5): void {
    if (strength <= 0) return;
    const centre = slotOf(bearing);
    this.danger[centre] = Math.max(this.danger[centre], strength);
    if (falloff > 0) {
      const side = strength * falloff;
      const left  = (centre + SLOT_COUNT - 1) % SLOT_COUNT;
      const right = (centre + 1) % SLOT_COUNT;
      this.danger[left]  = Math.max(this.danger[left],  side);
      this.danger[right] = Math.max(this.danger[right], side);
    }
  }

  // Selection rule:
  //   1. Find the minimum danger value across all slots.
  //   2. Candidate set = slots within `danger <= minDanger + 0.15` (tolerance
  //      keeps roughly-equal-danger slots in play so interest can decide).
  //   3. Among candidates, pick the one with the highest interest.
  //   4. Ties broken by proximity to `currentFacing` so the AI prefers a
  //      slot close to where it's already pointing (hysteresis — prevents
  //      flip-flopping between two equally good directions).
  pick(currentFacing: number): PickResult {
    let minDanger = this.danger[0];
    for (let i = 1; i < SLOT_COUNT; i++) if (this.danger[i] < minDanger) minDanger = this.danger[i];
    const threshold = minDanger + 0.15;

    let bestSlot = -1;
    let bestInterest = -Infinity;
    let bestTurn = Infinity;

    for (let i = 0; i < SLOT_COUNT; i++) {
      if (this.danger[i] > threshold) continue;
      const interest = this.interest[i];
      // Turn magnitude from currentFacing to this slot centre — smaller is better for ties
      const raw = ((bearingOfSlot(i) - currentFacing + 540) % 360) - 180;
      const turn = Math.abs(raw);
      if (
        interest > bestInterest ||
        (interest === bestInterest && turn < bestTurn)
      ) {
        bestSlot = i;
        bestInterest = interest;
        bestTurn = turn;
      }
    }

    if (bestSlot < 0) {
      // Every slot was above the threshold (can't happen given max is within
      // 0.15 of itself, but guard anyway). Fall back to current facing.
      return { bearing: currentFacing, danger: 1, slot: slotOf(currentFacing) };
    }

    return {
      bearing: bearingOfSlot(bestSlot),
      danger: this.danger[bestSlot],
      slot: bestSlot,
    };
  }
}
