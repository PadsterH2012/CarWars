import { describe, it, expect } from 'vitest';
import { computeProminence, safeShare, titleFor, PROMINENCE_WEIGHTS, rivalWealth, rivalNotoriety } from '../src/api/leaderboard';

describe('prominence scoring', () => {
  it('weights sum to 1', () => {
    const { territory, wealth, notoriety } = PROMINENCE_WEIGHTS;
    expect(territory + wealth + notoriety).toBeCloseTo(1);
  });

  it('safeShare clamps to 0–1 and guards divide-by-zero', () => {
    expect(safeShare(50, 100)).toBe(0.5);
    expect(safeShare(200, 100)).toBe(1);   // clamp
    expect(safeShare(-5, 100)).toBe(0);    // clamp
    expect(safeShare(10, 0)).toBe(0);      // no field max → 0, not NaN
  });

  it('a gang that leads every axis scores 100', () => {
    const max = { influence: 120, wealth: 500_000, notoriety: 40 };
    const score = computeProminence({ totalInfluence: 120, wealth: 500_000, notoriety: 40 }, max);
    expect(score).toBe(100);
  });

  it('early game: a landless but rich+famous gang still scores from wealth+notoriety', () => {
    const max = { influence: 100, wealth: 100_000, notoriety: 50 };
    // No territory, but tops wealth and notoriety → 0.3 + 0.2 = 0.5 → 50
    const score = computeProminence({ totalInfluence: 0, wealth: 100_000, notoriety: 50 }, max);
    expect(score).toBe(50);
  });

  it('late game: territory dominates — a land leader outranks a richer landless rival', () => {
    const max = { influence: 100, wealth: 100_000, notoriety: 50 };
    const landLeader = computeProminence({ totalInfluence: 100, wealth: 0, notoriety: 0 }, max); // 0.5 → 50
    const richLandless = computeProminence({ totalInfluence: 0, wealth: 100_000, notoriety: 50 }, max); // 0.5 → 50
    // Equal here by design; with any territory edge the land leader pulls ahead:
    const landLeaderPlusFame = computeProminence({ totalInfluence: 100, wealth: 0, notoriety: 25 }, max); // 0.5 + 0.1
    expect(landLeader).toBe(50);
    expect(richLandless).toBe(50);
    expect(landLeaderPlusFame).toBeGreaterThan(richLandless);
  });

  it('all-zero field produces a 0 score, never NaN', () => {
    const score = computeProminence(
      { totalInfluence: 0, wealth: 0, notoriety: 0 },
      { influence: 0, wealth: 0, notoriety: 0 },
    );
    expect(score).toBe(0);
  });

  it('titles derive from holdings', () => {
    expect(titleFor(0, 0, false)).toBe('Duellist');
    expect(titleFor(0, 0, true)).toBe('Garage Boss');
    expect(titleFor(10, 1, false)).toBe('Gang Leader');
    expect(titleFor(80, 5, false)).toBe('Kingpin');
  });
});

describe('rival notional wealth & notoriety', () => {
  it('rivalWealth = treasury + territory-implied assets', () => {
    expect(rivalWealth(2000, 0)).toBe(2000);       // no territory → just treasury
    expect(rivalWealth(0, 100)).toBe(100_000);     // 100 influence → notional assets
    expect(rivalWealth(5000, 120)).toBe(125_000);
  });

  it('rivalNotoriety scales with influence', () => {
    expect(rivalNotoriety(0)).toBe(0);
    expect(rivalNotoriety(120)).toBe(120);
  });

  it('a landless-but-rich player no longer outranks a territorial rival', () => {
    // Player: lots of cash, real fame, but ZERO territory.
    const player = { totalInfluence: 0, wealth: 122_000, notoriety: 133 };
    // Rival: 124 influence, notional wealth/notoriety derived from it.
    const rival = {
      totalInfluence: 124,
      wealth: rivalWealth(0, 124),       // 124,000
      notoriety: rivalNotoriety(124),    // 124
    };
    const max = {
      influence: 124,
      wealth: Math.max(player.wealth, rival.wealth),
      notoriety: Math.max(player.notoriety, rival.notoriety),
    };
    const playerScore = computeProminence(player, max);
    const rivalScore = computeProminence(rival, max);
    // The territory holder must rank above the landless player (was the bug:
    // player auto-won wealth + fame because rivals had $0 / 0).
    expect(rivalScore).toBeGreaterThan(playerScore);
  });
});
