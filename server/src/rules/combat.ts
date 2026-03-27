import type { VehicleState, ArmorLocation, ToHitResult, DamageResult, WeaponDef } from '@carwars/shared';

export function getAttackLocation(attacker: VehicleState, target: VehicleState): ArmorLocation {
  const dx = target.position.x - attacker.position.x;
  const dy = target.position.y - attacker.position.y;
  // Angle FROM attacker TO target in standard math degrees (east=0, counter-clockwise)
  const attackAngle = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;

  // Convert target's game facing (north=0, clockwise) to math angle
  // Game facing 0 (north) = math angle 90, facing 90 (east) = math angle 0
  // In this coord system north = negative-y, so game-north maps to atan2 270° direction
  // We use (90 - facing) so that relativeAngle 0 = attack from same direction target faces = back
  const targetMathFacing = (90 - target.facing + 360) % 360;

  // Relative angle: where does the attack come FROM in target's reference frame
  // 0 = attack from behind target (hits back), 180 = attack from front (hits front)
  const relativeAngle = (attackAngle - targetMathFacing + 360) % 360;

  // Map relative angle to armor location
  // Attack comes from: 315-45 = behind target = back hit
  //                    45-135 = target's left side = left hit
  //                    135-225 = in front of target = front hit
  //                    225-315 = target's right side = right hit
  if (relativeAngle >= 315 || relativeAngle < 45) return 'back';
  if (relativeAngle >= 45 && relativeAngle < 135) return 'left';
  if (relativeAngle >= 135 && relativeAngle < 225) return 'front';
  return 'right';
}

function roll2d6(): number {
  return Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1;
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
