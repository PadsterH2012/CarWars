import type { VehicleState, ArmorLocation, ToHitResult, DamageResult, WeaponDef, WeaponMount } from '@carwars/shared';

export function getAttackLocation(attacker: VehicleState, target: VehicleState): ArmorLocation {
  const dx = target.position.x - attacker.position.x;
  const dy = target.position.y - attacker.position.y;
  const attackAngle = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
  const targetMathFacing = (90 - target.facing + 360) % 360;
  const relativeAngle = (attackAngle - targetMathFacing + 360) % 360;

  if (relativeAngle >= 315 || relativeAngle < 45) return 'back';
  if (relativeAngle >= 45 && relativeAngle < 135) return 'left';
  if (relativeAngle >= 135 && relativeAngle < 225) return 'front';
  return 'right';
}

export function roll2d6(): number {
  return Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1;
}

/**
 * Roll dice damage: sum of `dice` d6 rolls plus `mod` flat modifier.
 * Returns at minimum 1 — damage is always at least 1 point.
 * Pass dice=0 for modifier-only weapons; result is Math.max(1, mod).
 */
export function rollDamage(dice: number, mod: number): number {
  let total = mod;
  for (let i = 0; i < dice; i++) {
    total += Math.floor(Math.random() * 6) + 1;
  }
  return Math.max(1, total); // Car Wars rule: minimum damage is always 1, regardless of modifiers
}

/**
 * Returns whether a target is within the weapon mount's firing arc.
 * Arc angles are relative to the attacker's facing direction.
 * front: ±45°, back: 135-225°, left: -135 to -45°, right: 45-135°, turret: all
 */
export function isWeaponInArc(attacker: VehicleState, target: VehicleState, mount: WeaponMount): boolean {
  if (mount.arc === 'turret') return true;

  const dx = target.position.x - attacker.position.x;
  const dy = target.position.y - attacker.position.y;
  const mathAngle = Math.atan2(dy, dx) * 180 / Math.PI;
  const gameAngleToTarget = (90 - mathAngle + 360) % 360;

  // Angle relative to attacker's facing, in range -180 to +180
  const relAngle = (gameAngleToTarget - attacker.facing + 540) % 360 - 180;

  switch (mount.arc) {
    case 'front': return relAngle >= -45 && relAngle <= 45;
    case 'back':  return relAngle <= -135 || relAngle >= 135;
    case 'left':  return relAngle >= -135 && relAngle <= -45;
    case 'right': return relAngle >= 45 && relAngle <= 135;
    default: return false;
  }
}

export function resolveToHit(
  attacker: VehicleState,
  target: VehicleState,
  weapon: WeaponDef,
  distance: number
): ToHitResult {
  // Dropped weapons are not aimed — they are never resolved through this function
  if (weapon.category === 'dropped') {
    return { roll: 0, modifier: 0, hit: false, location: 'front' };
  }

  // Base target number from weapon
  let targetNumber = weapon.toHit;

  // Out of range — automatic miss
  if (distance > weapon.longRange) {
    return { roll: 0, modifier: 99, hit: false, location: 'front' };
  }
  if (distance > weapon.shortRange) targetNumber += 2;

  // Target absolute speed and speed differential are independent and can both apply
  // Target speed modifier (Compendium: target moving > 60 mph = +1)
  if (target.speed > 60) targetNumber += 1;

  // Speed differential (Compendium to-hit modifier table: >30 mph diff = +2, >15 mph = +1)
  const speedDiff = Math.abs(attacker.speed - target.speed);
  if (speedDiff > 30) targetNumber += 2;
  else if (speedDiff > 15) targetNumber += 1;

  // Target size modifier (Compendium: subcompact/cycle = +1, van/pickup/camper = -1)
  const targetBody = target.stats.loadout?.bodyType;
  if (targetBody === 'subcompact' || targetBody === 'light_cycle' || targetBody === 'med_cycle' || targetBody === 'hvy_cycle') {
    targetNumber += 1;
  } else if (targetBody && ['van', 'pickup', 'camper'].includes(targetBody)) {
    targetNumber -= 1;
  }
  // standard-sized bodies (compact, mid_sized, sedan, luxury, station_wagon): no size modifier

  if (attacker.stats.damageState.driverWounded) targetNumber += 2;

  const roll = roll2d6();
  const hit = roll >= targetNumber;
  const location = hit ? getAttackLocation(attacker, target) : 'front';

  return { roll, modifier: targetNumber - weapon.toHit, hit, location };
}

export function resolveDamage(
  target: VehicleState,
  location: ArmorLocation,
  damage: number
): DamageResult {
  const currentArmor = target.stats.damageState.armor[location] ?? 0;
  const remaining = currentArmor - damage;
  const penetrated = remaining < 0;
  const effects: string[] = [];

  if (penetrated) {
    const excess = Math.abs(remaining);

    // Internal component damage by facing
    if (location === 'front' || location === 'back') effects.push('engine_hit');
    if (location === 'left' || location === 'right') effects.push('tire_blown');
    if (excess > 3) effects.push('driver_wounded');
    if (excess > 6) effects.push('destroyed');

    // Vehicular fire table (1d6): 5 = fire, 6 = fire + explosion
    const fireRoll = Math.floor(Math.random() * 6) + 1;
    if (fireRoll === 5) effects.push('on_fire');
    if (fireRoll === 6) effects.push('on_fire', 'explosion');
  }

  return {
    vehicleId: target.id,
    location,
    damageDealt: damage,
    penetrated,
    effects
  };
}
