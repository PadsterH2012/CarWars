import { describe, it, expect } from 'vitest';
import { salvageValueOf, totalSalvageFor } from '../src/rules/salvage';
import type { WreckageObject } from '@carwars/shared';

function makeWreck(overrides: Partial<WreckageObject> = {}): WreckageObject {
  return {
    id: 'w1', sourceVehicleId: 'v1', playerId: 'ai-team',
    position: { x: 0, y: 0 }, facing: 0,
    bodyType: 'mid_sized',
    state: 'smouldering', stateStartedAt: 0,
    remainingDP: 10, maxDP: 10, originalValue: 5000,
    mass: 'medium', pushable: false, carriedAmmo: 0, causedBy: 'kinetic',
    ...overrides,
  };
}

describe('salvageValueOf', () => {
  it('peak kinetic/smouldering kill with full intactness → 30% of value', () => {
    const w = makeWreck({ state: 'smouldering', causedBy: 'kinetic', remainingDP: 10, maxDP: 10, originalValue: 5000 });
    expect(salvageValueOf(w)).toBe(1500); // 5000 × 0.30 × 1.0 × 1.0 × 1.0
  });

  it('burning + explosion reduces salvage heavily', () => {
    const w = makeWreck({ state: 'burning', causedBy: 'explosion', remainingDP: 5, maxDP: 10, originalValue: 5000 });
    // 5000 × 0.30 × 0.5 (intactness) × 0.4 (burning) × 0.5 (explosion) = 150
    expect(salvageValueOf(w)).toBe(150);
  });

  it('debris + fire yields a modest salvage', () => {
    const w = makeWreck({ state: 'debris', causedBy: 'fire', remainingDP: 7, maxDP: 10, originalValue: 5000 });
    // 5000 × 0.30 × 0.7 × 0.7 × 0.6 = 441
    expect(salvageValueOf(w)).toBe(441);
  });

  it('zero original value yields zero salvage', () => {
    const w = makeWreck({ originalValue: 0 });
    expect(salvageValueOf(w)).toBe(0);
  });

  it('zero remainingDP still yields zero salvage (fully disintegrated)', () => {
    const w = makeWreck({ remainingDP: 0, maxDP: 10 });
    expect(salvageValueOf(w)).toBe(0);
  });
});

describe('totalSalvageFor', () => {
  it('sums salvage across all losing-team wrecks', () => {
    const wrecks: WreckageObject[] = [
      makeWreck({ id: 'a', playerId: 'ai-team', originalValue: 5000 }),
      makeWreck({ id: 'b', playerId: 'ai-team', originalValue: 3000 }),
    ];
    // 1500 + 900 = 2400
    expect(totalSalvageFor(wrecks, 'winner-id')).toBe(2400);
  });

  it('excludes the winners own wrecks', () => {
    const wrecks: WreckageObject[] = [
      makeWreck({ id: 'own',  playerId: 'winner-id', originalValue: 5000 }),
      makeWreck({ id: 'opp1', playerId: 'ai-team',   originalValue: 3000 }),
    ];
    expect(totalSalvageFor(wrecks, 'winner-id')).toBe(900); // only the ai wreck
  });

  it('returns 0 when there is no winner (all destroyed)', () => {
    const wrecks: WreckageObject[] = [
      makeWreck({ id: 'a', playerId: 'ai-team' }),
    ];
    expect(totalSalvageFor(wrecks, null)).toBe(0);
  });
});
