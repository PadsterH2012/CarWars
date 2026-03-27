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
  }
}

export function resolveToHit(
  attacker: VehicleState,
  target: VehicleState,
  weapon: WeaponDef,
  distance: number
): ToHitResult {
  let targetNumber = distance <= weapon.shortRange ? 7 : 9;

  const speedDiff = Math.abs(attacker.speed - target.speed);
  if (speedDiff > 15) targetNumber += 2;
  else if (speedDiff > 5) targetNumber += 1;

  if (attacker.stats.damageState.driverWounded) targetNumber += 2;

  const roll = roll2d6();
  const hit = roll >= targetNumber;
  const location = hit ? getAttackLocation(attacker, target) : 'front';

  return { roll, modifier: targetNumber - 7, hit, location };
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
    if (location === 'front' || location === 'back') effects.push('engine_hit');
    if (location === 'left' || location === 'right') effects.push('tire_blown');
    if (remaining < -3) effects.push('driver_wounded');
    if (remaining < -6) effects.push('destroyed');
  }

  return {
    vehicleId: target.id,
    location,
    damageDealt: damage,
    penetrated,
    effects
  };
}
