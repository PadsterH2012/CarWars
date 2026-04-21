// Maps total prestige points (tracked in drivers.xp) to a Compendium-style
// rank title. Pure function — no DB side effects. Display-only; the mechanical
// skill value still drives to-hit modifiers and arena AI behaviour.

export type DriverTitle = 'Rookie' | 'Apprentice' | 'Journeyman' | 'Veteran' | 'Expert' | 'Master';

export function driverTitleFromXp(xp: number): DriverTitle {
  if (xp >= 3000) return 'Master';
  if (xp >= 1500) return 'Expert';
  if (xp >= 700)  return 'Veteran';
  if (xp >= 300)  return 'Journeyman';
  if (xp >= 100)  return 'Apprentice';
  return 'Rookie';
}

// XP needed for the next title promotion (0 if already Master).
export function xpToNextTitle(xp: number): number {
  const next = [100, 300, 700, 1500, 3000].find(t => t > xp);
  return next ? next - xp : 0;
}
