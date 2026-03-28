import type { VehicleState } from '@carwars/shared';

export interface AiInput {
  speed: number;
  steer: number;
  fireWeapon: string | null;
}

const OPTIMAL_RANGE = 12;  // inches — ideal engagement distance
const FIRE_RANGE = 16;     // inches — max range to fire
const MAX_TURN = 30;       // degrees — max steer per tick

// Select first front-arc weapon with ammo
function selectWeapon(self: VehicleState): string | null {
  const mounts = self.stats.loadout?.mounts;
  if (!mounts || mounts.length === 0) return 'mg'; // fallback for vehicles without loadout
  const mount = mounts.find(m =>
    (m.arc === 'front' || m.arc === 'turret') &&
    m.weaponId !== null &&
    m.ammo > 0
  );
  return mount?.weaponId ?? null;
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

export function computeAiInput(
  self: VehicleState,
  others: VehicleState[],
  skill: number   // 1-6; reserved for future difficulty scaling
): AiInput {
  const enemies = others.filter(o => o.playerId !== self.playerId);

  if (enemies.length === 0) {
    return { speed: 0, steer: 0, fireWeapon: null };
  }

  // Pick the closest enemy
  const target = enemies.reduce((closest, e) =>
    distance(self.position, e.position) < distance(self.position, closest.position) ? e : closest
  );

  const dx = target.position.x - self.position.x;
  const dy = target.position.y - self.position.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Desired heading toward target in game degrees (north=0, clockwise)
  // Physics uses Y-down (positive Y = south). atan2 assumes Y-up, so negate dy to compensate.
  const mathAngle = Math.atan2(-dy, dx) * 180 / Math.PI;
  const desiredFacing = (90 - mathAngle + 360) % 360;

  // Compute shortest turn from current facing to desired facing
  let steer = (desiredFacing - self.facing + 540) % 360 - 180; // -180 to +180
  steer = Math.max(-MAX_TURN, Math.min(MAX_TURN, steer));

  // Speed: close to optimal range
  let speed: number;
  if (dist > OPTIMAL_RANGE + 2) {
    speed = self.stats.maxSpeed; // snap to full speed when chasing — gradual accel lets player escape
  } else if (dist < OPTIMAL_RANGE - 2) {
    speed = Math.max(0, self.speed - 5);
  } else {
    speed = self.speed || 5; // maintain current speed, but don't sit still
  }

  // Fire if target is in front arc and within range
  const angleDiff = Math.abs(steer);
  const weapon = selectWeapon(self);
  const fireWeapon = dist <= FIRE_RANGE && angleDiff < 45 && weapon ? weapon : null;

  return { speed, steer, fireWeapon };
}
