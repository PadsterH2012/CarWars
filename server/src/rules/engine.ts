import type { ZoneState, VehicleState, HazardObject, DamageState, ArmorLocation, ArenaMap, CombatEvent, WreckageObject, WreckageCause, WreckageState } from '@carwars/shared';
import { computeMovement, classifyManeuver, resolveControlTable, computeSpinAngle, resolveCollision } from './movement';
import { resolveToHit, resolveDamage, isWeaponInArc, hasLineOfSight, roll2d6, rollDamage, getAttackLocation } from './combat';
import { WEAPONS } from './data/weapons';
import { resolveWallCollisions } from './collision';

const LIGHT_BODIES = new Set(['light_cycle', 'med_cycle', 'hvy_cycle', 'subcompact', 'trike']);
const HEAVY_BODIES = new Set(['van', 'pickup', 'camper', 'truck', 'trailer']);
const BURN_TICKS = 30;
const SMOULDER_TICKS = 60;
const BLAST_RADIUS = 2;

function wreckMass(bodyType?: string): 'light' | 'medium' | 'heavy' {
  if (bodyType && LIGHT_BODIES.has(bodyType)) return 'light';
  if (bodyType && HEAVY_BODIES.has(bodyType)) return 'heavy';
  return 'medium';
}

function wreckDP(mass: 'light' | 'medium' | 'heavy'): number {
  return mass === 'light' ? 5 : mass === 'heavy' ? 20 : 10;
}

function determineCause(v: VehicleState): WreckageCause {
  const ds = v.stats.damageState;
  if (ds.onFire) return 'fire';
  if (ds.internalDamage?.includes('explosion_kill')) return 'explosion';
  if (ds.internalDamage?.includes('collision_kill')) return 'collision';
  if (ds.internalDamage?.includes('energy_kill')) return 'energy';
  return 'kinetic';
}

function carriedAmmoOf(v: VehicleState): number {
  return (v.stats.loadout?.mounts ?? []).reduce((s, m) => s + (m.ammo ?? 0), 0);
}

function initialWreckState(cause: WreckageCause, carriedAmmo: number): WreckageState {
  if (cause === 'fire') return 'burning';
  if (cause === 'explosion' && carriedAmmo > 0) return 'burning';
  return 'smouldering';
}

function shouldBlast(cause: WreckageCause, carriedAmmo: number): boolean {
  return cause === 'explosion' && carriedAmmo > 0;
}

function transitionWreck(w: WreckageObject, currentTick: number): WreckageObject {
  if (w.state === 'debris') return w;
  const elapsed = currentTick - w.stateStartedAt;
  if (w.state === 'burning' && elapsed >= BURN_TICKS) {
    return { ...w, state: 'smouldering', stateStartedAt: currentTick };
  }
  if (w.state === 'smouldering' && elapsed >= SMOULDER_TICKS) {
    return { ...w, state: 'debris', stateStartedAt: currentTick };
  }
  return w;
}

interface VehicleInput {
  speed: number;
  steer: number;
  fireWeapon: string | null;
}

export interface TurnEngine {
  queueInput(vehicleId: string, input: VehicleInput): void;
  resolveTick(): ZoneState;
  getState(): ZoneState;
  addVehicle(vehicle: VehicleState): void;
  removeVehicle(vehicleId: string): void;
}

const TICKS_PER_TURN = 10; // 100ms ticks × 10 = 1 second = 1 Compendium turn

export function createTurnEngine(initialState: ZoneState, map?: ArenaMap): TurnEngine {
  let state: ZoneState = {
    ...initialState,
    vehicles: [...initialState.vehicles],
    hazardObjects: [...(initialState.hazardObjects ?? [])],
  };
  const pendingInputs = new Map<string, VehicleInput>();
  const lastInputs = new Map<string, VehicleInput>();
  // Per-vehicle hazard D-value accumulator — resets every full turn
  const hazardAccum = new Map<string, number>();
  // Sign of the steer input that produced the peak D this turn (for spin direction)
  const hazardSteerSign = new Map<string, number>();
  // Gradual slide velocity (°/tick remaining) — applied each tick until depleted
  const slideVelocity = new Map<string, number>();
  let tickInTurn = 0;

  return {
    queueInput(vehicleId, input) {
      pendingInputs.set(vehicleId, input);
    },

    resolveTick() {
      const activeVehicles = state.vehicles.filter(v => !v.stats.damageState.destroyed);
      const destroyedVehicles = state.vehicles.filter(v => v.stats.damageState.destroyed);
      const preMoveVehicles = [...activeVehicles];

      // Mutable damage and ammo update maps — declared before the movement loop so wall
      // collision damage can be written to the same accumulator as combat/mine/fire damage
      const damageUpdates = new Map<string, DamageState>();
      const ammoUpdates = new Map<string, Map<string, number>>(); // vehicleId -> mountId -> newAmmo

      // Move all active vehicles
      let newVehicles = activeVehicles.map(vehicle => {
        const input = pendingInputs.get(vehicle.id) ?? lastInputs.get(vehicle.id) ?? { speed: 0, steer: 0, fireWeapon: null };
        // Persist speed but reset steer — steer is an impulse, not a held state
        lastInputs.set(vehicle.id, { speed: input.speed, steer: 0, fireWeapon: null });
        let moved = computeMovement(vehicle, input);

        // Apply gradual slide rotation (8°/tick max) — smooths out fishtail/skid over time
        const vel = slideVelocity.get(vehicle.id) ?? 0;
        if (Math.abs(vel) >= 0.5) {
          const step = Math.sign(vel) * Math.min(Math.abs(vel), 8);
          slideVelocity.set(vehicle.id, vel - step);
          moved = { ...moved, facing: (moved.facing + step + 360) % 360 };
        } else if (vel !== 0) {
          slideVelocity.delete(vehicle.id);
        }

        // Wall collision check — only when a map with walls is loaded
        if (map && map.walls.length > 0) {
          const hit = resolveWallCollisions(moved.position, map.walls);
          if (hit.hit) {
            const baseDamage = Math.floor(moved.speed / 5);
            if (baseDamage > 0) {
              const ds = damageUpdates.get(moved.id) ?? { ...moved.stats.damageState };
              const newArmor = { ...ds.armor };
              const validFacings = ['front', 'back', 'left', 'right', 'top', 'underbody'] as const;
              type ValidFacing = typeof validFacings[number];
              const facing = validFacings.includes(hit.facing as ValidFacing) ? hit.facing as ValidFacing : 'front';
              newArmor[facing] = Math.max(0, (newArmor[facing] ?? 0) - baseDamage);
              const destroyed = ds.destroyed || (newArmor[facing] ?? 0) === 0;
              console.log(`[t${state.tick}] WALL  ${moved.id} hit ${facing} at spd=${moved.speed} -${baseDamage}pts`);
              // Write to accumulator so wall + combat damage in same tick are both applied
              damageUpdates.set(moved.id, { ...ds, armor: newArmor, destroyed });
            }
            // Always correct position and zero speed
            moved = { ...moved, position: { x: hit.x, y: hit.y }, speed: 0 };
          }
        }

        return moved;
      });

      // ── Vehicle-to-vehicle collision detection ──────────────────────────────
      // Check all pairs once (i < j). Uses the same half-extents as wall collision.
      const VEH_HW = 0.5, VEH_HH = 1.0;
      for (let i = 0; i < newVehicles.length; i++) {
        for (let j = i + 1; j < newVehicles.length; j++) {
          let vA = newVehicles[i];
          let vB = newVehicles[j];

          const dx = vB.position.x - vA.position.x;
          const dy = vB.position.y - vA.position.y;
          const overlapX = (VEH_HW + VEH_HW) - Math.abs(dx);
          const overlapY = (VEH_HH + VEH_HH) - Math.abs(dy);
          if (overlapX <= 0 || overlapY <= 0) continue;

          // Classify collision from relative heading
          const relHeading = Math.abs(((vB.facing - vA.facing + 540) % 360) - 180);
          // relHeading: 0 = same direction, 180 = head-on, 90 = perpendicular
          const type: 'head_on' | 'same_dir' | 't_bone' =
            relHeading > 120 ? 'head_on' :
            relHeading < 45  ? 'same_dir' :
                               't_bone';

          const aHasRamplate = false; // ramplate not yet in loadout type
          const result = resolveCollision(vA.speed, vB.speed, type, aHasRamplate);

          // Apply damage to each vehicle on the face that took the impact
          const locA = getAttackLocation(vB, vA); // which face of A did B hit
          const locB = getAttackLocation(vA, vB); // which face of B did A hit

          for (const [veh, dmg, loc] of [
            [vA, result.damageA, locA],
            [vB, result.damageB, locB],
          ] as [VehicleState, number, ArmorLocation][]) {
            if (dmg <= 0) continue;
            const ds   = damageUpdates.get(veh.id) ?? { ...veh.stats.damageState };
            const armor = { ...ds.armor };
            const remaining = (armor[loc] ?? 0) - dmg;
            armor[loc] = Math.max(0, remaining);
            const destroyed = ds.destroyed || armor[loc] === 0;
            damageUpdates.set(veh.id, { ...ds, armor, destroyed });
          }

          // Push vehicles apart on minimum penetration axis, zero both speeds
          if (overlapX < overlapY) {
            const push = overlapX / 2;
            vA = { ...vA, position: { ...vA.position, x: vA.position.x + (dx > 0 ? -push : push) }, speed: 0 };
            vB = { ...vB, position: { ...vB.position, x: vB.position.x + (dx > 0 ?  push : -push) }, speed: 0 };
          } else {
            const push = overlapY / 2;
            vA = { ...vA, position: { ...vA.position, y: vA.position.y + (dy > 0 ? -push : push) }, speed: 0 };
            vB = { ...vB, position: { ...vB.position, y: vB.position.y + (dy > 0 ?  push : -push) }, speed: 0 };
          }
          newVehicles[i] = vA;
          newVehicles[j] = vB;

          console.log(
            `[t${state.tick}] CRASH ${vA.id} ↔ ${vB.id} ` +
            `type=${type} closingSpd=${result.closingSpeed} ` +
            `A-${locA}:${result.damageA}pts B-${locB}:${result.damageB}pts`,
          );
        }
      }

      // ── Vehicle-to-wreckage collision ────────────────────────────────────
      // For each vehicle, check overlap with each wreck. Wrecks are stationary
      // with the same half-extents as vehicles. Ramplate + pushable = push through;
      // otherwise the vehicle bounces off and the wreck absorbs the damage.
      const preCollisionWreckage: WreckageObject[] = (state.wreckage ?? []).map(w => ({ ...w }));
      const wreckUpdates = new Map<string, WreckageObject>();
      for (const w of preCollisionWreckage) wreckUpdates.set(w.id, w);

      for (let i = 0; i < newVehicles.length; i++) {
        let veh = newVehicles[i];
        for (const wreckId of wreckUpdates.keys()) {
          const wreck = wreckUpdates.get(wreckId)!;
          const dx = wreck.position.x - veh.position.x;
          const dy = wreck.position.y - veh.position.y;
          const overlapX = (VEH_HW + VEH_HW) - Math.abs(dx);
          const overlapY = (VEH_HH + VEH_HH) - Math.abs(dy);
          if (overlapX <= 0 || overlapY <= 0) continue;

          const hasRam = !!veh.stats.loadout?.hasRamplate;
          const crash = resolveCollision(veh.speed, 0, 't_bone', hasRam);

          // Apply damage to vehicle's impact face
          const loc = getAttackLocation({ position: wreck.position, facing: 0 } as VehicleState, veh);
          const ds = damageUpdates.get(veh.id) ?? { ...veh.stats.damageState };
          const armor = { ...ds.armor };
          armor[loc] = Math.max(0, (armor[loc] ?? 0) - crash.damageA);
          damageUpdates.set(veh.id, {
            ...ds,
            armor,
            destroyed: ds.destroyed || armor[loc] === 0,
          });

          // Wreck absorbs damage; breaks down to debris on depletion
          const newDP = Math.max(0, wreck.remainingDP - crash.damageB);
          const brokeDown = newDP <= 0 && wreck.state !== 'debris';
          const updatedWreck: WreckageObject = {
            ...wreck,
            remainingDP: newDP,
            state: brokeDown ? 'debris' : wreck.state,
            stateStartedAt: brokeDown ? state.tick + 1 : wreck.stateStartedAt,
          };

          if (hasRam && wreck.pushable) {
            // Push the wreck in the vehicle's velocity direction by overlap magnitude
            const push = Math.min(overlapX, overlapY);
            const facingRad = (veh.facing - 90) * (Math.PI / 180);
            updatedWreck.position = {
              x: wreck.position.x + Math.cos(facingRad) * push,
              y: wreck.position.y + Math.sin(facingRad) * push,
            };
            // Vehicle loses half its speed but keeps moving
            veh = { ...veh, speed: Math.floor(veh.speed / 2) };
          } else {
            // Vehicle bounces — pushed back by full overlap, speed zeroed
            if (overlapX < overlapY) {
              const px = overlapX;
              veh = {
                ...veh,
                position: { ...veh.position, x: veh.position.x + (dx > 0 ? -px : px) },
                speed: 0,
              };
            } else {
              const py = overlapY;
              veh = {
                ...veh,
                position: { ...veh.position, y: veh.position.y + (dy > 0 ? -py : py) },
                speed: 0,
              };
            }
          }

          wreckUpdates.set(wreckId, updatedWreck);
          console.log(
            `[t${state.tick}] RAM ${veh.id} → wreck ${wreck.id} ` +
            `ram=${hasRam} pushable=${wreck.pushable} dmg-${loc}:${crash.damageA} wreckDP:${newDP}`
          );
        }
        newVehicles[i] = veh;
      }

      // Track peak hazard D-value this turn (Compendium: one maneuver per turn, use highest D)
      newVehicles.forEach(vehicle => {
        const input = pendingInputs.get(vehicle.id) ?? lastInputs.get(vehicle.id) ?? { speed: 0, steer: 0, fireWeapon: null };
        const maneuver = classifyManeuver(vehicle.speed, Math.abs(input.steer));
        const prev = hazardAccum.get(vehicle.id) ?? 0;
        if (maneuver.dValue > prev) {
          hazardAccum.set(vehicle.id, maneuver.dValue);
          // Record steer direction for physics-based spin when control is lost
          hazardSteerSign.set(vehicle.id, Math.sign(input.steer));
        }
      });

      // Apply hazard control check once per full turn (every TICKS_PER_TURN ticks)
      tickInTurn = (tickInTurn + 1) % TICKS_PER_TURN;
      if (tickInTurn === 0) {
        newVehicles = newVehicles.map(vehicle => {
          const accumulated = hazardAccum.get(vehicle.id) ?? 0;
          const steerSign   = hazardSteerSign.get(vehicle.id) ?? 0;
          hazardAccum.set(vehicle.id, 0);
          hazardSteerSign.delete(vehicle.id);
          const control = resolveControlTable(vehicle.stats.handlingClass, accumulated);

          if (control.effect === 'none') return vehicle;

          const bodyType = vehicle.stats.loadout.bodyType;
          const weight   = vehicle.stats.weight;

          if (control.effect === 'fishtail') {
            const spin = computeSpinAngle('fishtail', vehicle.speed, weight, bodyType, steerSign);
            // Add to any existing slide (compounds if already sliding)
            slideVelocity.set(vehicle.id, (slideVelocity.get(vehicle.id) ?? 0) + spin);
            console.log(`[t${state.tick}] CTRL  ${vehicle.id} fishtail (D${accumulated}, HC${vehicle.stats.handlingClass}) slide=${spin > 0 ? '+' : ''}${spin.toFixed(0)}°`);
            return vehicle; // spin applied gradually each tick
          }

          // Skid or worse: physics-based spin + halve speed
          const spin = computeSpinAngle('skid', vehicle.speed, weight, bodyType, steerSign);
          slideVelocity.set(vehicle.id, (slideVelocity.get(vehicle.id) ?? 0) + spin);
          console.log(`[t${state.tick}] CTRL  ${vehicle.id} ${control.effect} (D${accumulated}, HC${vehicle.stats.handlingClass}) slide=${spin > 0 ? '+' : ''}${spin.toFixed(0)}°`);
          return { ...vehicle, speed: Math.floor(vehicle.speed / 2) };
        });
      }

      // Resolve combat using pre-move positions
      const combatEvents: CombatEvent[] = [];
      preMoveVehicles.forEach(attacker => {
        const input = pendingInputs.get(attacker.id) ?? { speed: 0, steer: 0, fireWeapon: null };
        if (!input.fireWeapon) return;

        const weapon = WEAPONS.find(w => w.id === input.fireWeapon);
        if (!weapon) return;

        // Find a mount on the attacker with this weapon and ammo remaining
        const mountIndex = attacker.stats.loadout?.mounts.findIndex(
          m => m.weaponId === input.fireWeapon && m.ammo > 0
        ) ?? -1;
        if (mountIndex === -1) return;
        const mount = attacker.stats.loadout!.mounts[mountIndex];

        // Handle dropped weapons (oil, mine) — place hazard at attacker's position
        if (weapon.category === 'dropped') {
          if (!ammoUpdates.has(attacker.id)) ammoUpdates.set(attacker.id, new Map());
          ammoUpdates.get(attacker.id)!.set(mount.id, mount.ammo - 1);
          const hazId = `${weapon.id}-${attacker.id}-${state.tick}`;
          state = {
            ...state,
            hazardObjects: [
              ...state.hazardObjects,
              { id: hazId, type: weapon.id as 'oil' | 'mine', position: { ...attacker.position }, ownerId: attacker.id }
            ]
          };
          return;
        }

        // Projectile weapon — fire at all enemies in arc within range
        preMoveVehicles.forEach(target => {
          if (attacker.id === target.id) return;
          if (!isWeaponInArc(attacker, target, mount)) return;
          if (map && map.walls.length > 0 && !hasLineOfSight(attacker.position, target.position, map.walls)) {
            console.log(`[t${state.tick}] BLOCK ${attacker.id} → ${target.id} (wall blocks LoS)`);
            return;
          }

          const dx = target.position.x - attacker.position.x;
          const dy = target.position.y - attacker.position.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance > weapon.longRange) return;

          const toHit = resolveToHit(attacker, target, weapon, distance);
          const distStr = distance.toFixed(1);
          if (!toHit.hit) {
            console.log(`[t${state.tick}] MISS  ${attacker.id} → ${target.id} (${weapon.id}, dist=${distStr})`);
            combatEvents.push({
              attackerId: attacker.id, targetId: target.id, hit: false,
              fromX: attacker.position.x, fromY: attacker.position.y,
              toX: target.position.x, toY: target.position.y,
              weapon: weapon.id,
            });
            return;
          }

          // damageDice === 0 means fixed-damage weapon (e.g. legacy entries); fall back to flat damage field
          const rolledDamage = weapon.damageDice > 0 ? rollDamage(weapon.damageDice, weapon.damageMod) : (weapon.damage ?? 1);
          const damageResult = resolveDamage(target, toHit.location, rolledDamage);
          const currentDamage = damageUpdates.get(target.id) ?? { ...target.stats.damageState };
          const newArmor = { ...currentDamage.armor };
          newArmor[toHit.location] = Math.max(0, (newArmor[toHit.location] ?? 0) - damageResult.damageDealt);
          const armorRemaining = newArmor[toHit.location] ?? 0;
          const willDestroy = currentDamage.destroyed || damageResult.effects.includes('destroyed');
          const effects = damageResult.effects.length ? ` [${damageResult.effects.join(', ')}]` : '';
          console.log(`[t${state.tick}] HIT   ${attacker.id} → ${target.id} (${weapon.id}, dist=${distStr}) ${toHit.location} -${damageResult.damageDealt}pts → ${armorRemaining} left${effects}${willDestroy ? ' 💀 DESTROYED' : ''}`);
          combatEvents.push({
            attackerId: attacker.id, targetId: target.id, hit: true,
            fromX: attacker.position.x, fromY: attacker.position.y,
            toX: target.position.x, toY: target.position.y,
            weapon: weapon.id,
          });

          const tireIndex = (toHit.location === 'front' || toHit.location === 'left') ? 0
            : (toHit.location === 'right') ? 1 : 2;

          damageUpdates.set(target.id, {
            ...currentDamage,
            armor: newArmor,
            engineDamaged: currentDamage.engineDamaged || damageResult.effects.includes('engine_hit'),
            driverWounded: currentDamage.driverWounded || damageResult.effects.includes('driver_wounded'),
            destroyed: willDestroy,
            onFire: (currentDamage.onFire ?? false) || damageResult.effects.includes('on_fire'),
            tiresBlown: damageResult.effects.includes('tire_blown') && !currentDamage.tiresBlown.includes(tireIndex)
              ? [...currentDamage.tiresBlown, tireIndex]
              : currentDamage.tiresBlown
          });
        });

        // Decrement ammo once per tick per firing vehicle
        if (!ammoUpdates.has(attacker.id)) ammoUpdates.set(attacker.id, new Map());
        ammoUpdates.get(attacker.id)!.set(mount.id, mount.ammo - 1);
      });

      // Resolve hazard object triggers (oil slicks, mines)
      const mineDef = WEAPONS.find(w => w.id === 'mine');
      const mineDamage = mineDef?.damage ?? 3;
      let remainingHazards = [...state.hazardObjects];
      const triggeredMines = new Set<string>();

      newVehicles.forEach(vehicle => {
        remainingHazards.forEach(hazard => {
          const dx = vehicle.position.x - hazard.position.x;
          const dy = vehicle.position.y - hazard.position.y;
          if (Math.sqrt(dx * dx + dy * dy) > 0.5) return;

          if (hazard.type === 'oil') {
            const roll = roll2d6();
            if (roll < 4) {
              const idx = newVehicles.findIndex(v => v.id === vehicle.id);
              if (idx !== -1) {
                const spinAngle = (Math.random() > 0.5 ? 1 : -1) * 90;
                newVehicles[idx] = {
                  ...newVehicles[idx],
                  facing: (newVehicles[idx].facing + spinAngle + 360) % 360,
                  speed: Math.floor(newVehicles[idx].speed / 2),
                };
              }
            }
            // Oil persists
          } else if (hazard.type === 'mine') {
            const currentDamage = damageUpdates.get(vehicle.id) ?? { ...vehicle.stats.damageState };
            const newArmor = { ...currentDamage.armor };
            newArmor.underbody = Math.max(0, (newArmor.underbody ?? 0) - mineDamage);
            damageUpdates.set(vehicle.id, {
              ...currentDamage,
              armor: newArmor,
              destroyed: currentDamage.destroyed || (newArmor.underbody ?? 0) <= 0,
            });
            triggeredMines.add(hazard.id);
          }
        });
      });

      remainingHazards = remainingHazards.filter(h => !triggeredMines.has(h.id));

      // Apply fire damage to burning vehicles (Car Wars: 1 armor point per tick from a random facing)
      newVehicles.forEach(vehicle => {
        const alreadyOnFire = damageUpdates.get(vehicle.id)?.onFire ?? vehicle.stats.damageState.onFire;
        if (!alreadyOnFire) return;

        // For now, fire always burns (future: check fire extinguisher accessory)
        const currentDamage = damageUpdates.get(vehicle.id) ?? { ...vehicle.stats.damageState };

        // Pick a random armor location that still has armor
        const locations: ArmorLocation[] = ['front', 'back', 'left', 'right', 'top', 'underbody'];
        const burnable = locations.filter(loc => (currentDamage.armor[loc] ?? 0) > 0);
        if (burnable.length === 0) {
          // All armor gone — fire destroys internals
          damageUpdates.set(vehicle.id, { ...currentDamage, destroyed: true });
          return;
        }

        const loc = burnable[Math.floor(Math.random() * burnable.length)] as ArmorLocation;
        const newArmor = { ...currentDamage.armor };
        newArmor[loc] = Math.max(0, (newArmor[loc] ?? 0) - 1);

        damageUpdates.set(vehicle.id, {
          ...currentDamage,
          armor: newArmor,
          onFire: true,
        });

        // Check if fire just burned off the last armor point
        const totalArmor = Object.values(newArmor).reduce((s, v) => s + (v ?? 0), 0);
        if (totalArmor === 0) {
          damageUpdates.set(vehicle.id, { ...currentDamage, armor: newArmor, onFire: true, destroyed: true });
        }
      });

      // Apply damage + ammo updates to vehicles
      const withUpdates = newVehicles.map(v => {
        const dmg = damageUpdates.get(v.id);
        const ammo = ammoUpdates.get(v.id);

        let updated = v;
        if (dmg) {
          updated = { ...updated, stats: { ...updated.stats, damageState: dmg } };
        }
        if (ammo && updated.stats.loadout) {
          const newMounts = updated.stats.loadout.mounts.map(m => {
            const newAmmo = ammo.get(m.id);
            return newAmmo !== undefined ? { ...m, ammo: Math.max(0, newAmmo) } : m;
          });
          updated = {
            ...updated,
            stats: {
              ...updated.stats,
              loadout: { ...updated.stats.loadout, mounts: newMounts }
            }
          };
        }
        return updated;
      });

      const newTick = state.tick + 1;

      // ── Wreckage promotion ──────────────────────────────────────────────
      // Any vehicle that is destroyed at end of this tick (including those already
      // destroyed coming in) is promoted to a WreckageObject; destroyed vehicles are
      // removed from state.vehicles.
      const remainsAlive = withUpdates.filter(v => !v.stats.damageState.destroyed);
      const justDestroyed = [
        ...withUpdates.filter(v => v.stats.damageState.destroyed),
        ...destroyedVehicles,
      ];

      // Existing wreckage picks up collision-driven position/DP/state updates from above
      const existingWreckage: WreckageObject[] = [...wreckUpdates.values()];

      // Blast accumulator — applied against survivors after promotion
      type BlastHit = { dmg: number; from: { x: number; y: number } };
      const blastAgainstVehicle = new Map<string, BlastHit>();
      const blastAgainstWreck = new Map<string, number>();

      const newWrecks: WreckageObject[] = justDestroyed.map(v => {
        const cause = determineCause(v);
        const carriedAmmo = carriedAmmoOf(v);
        const mass = wreckMass(v.stats.loadout?.bodyType);
        const wreck: WreckageObject = {
          id: `wreck-${v.id}-${newTick}`,
          sourceVehicleId: v.id,
          position: { ...v.position },
          facing: v.facing,
          bodyType: v.stats.loadout?.bodyType,
          state: initialWreckState(cause, carriedAmmo),
          stateStartedAt: newTick,
          remainingDP: wreckDP(mass),
          mass,
          pushable: mass === 'light',
          carriedAmmo,
          causedBy: cause,
        };

        // Ammo cook-off blast: mark nearby vehicles + wrecks for radial damage
        if (shouldBlast(cause, carriedAmmo)) {
          const blastDmg = rollDamage(2, 0);
          for (const other of remainsAlive) {
            const dx = other.position.x - wreck.position.x;
            const dy = other.position.y - wreck.position.y;
            if (Math.hypot(dx, dy) <= BLAST_RADIUS) {
              blastAgainstVehicle.set(other.id, { dmg: blastDmg, from: wreck.position });
            }
          }
          for (const w of existingWreckage) {
            const dx = w.position.x - wreck.position.x;
            const dy = w.position.y - wreck.position.y;
            if (Math.hypot(dx, dy) <= BLAST_RADIUS) {
              blastAgainstWreck.set(w.id, Math.ceil(w.remainingDP / 2));
            }
          }
        }
        return wreck;
      });

      // Apply blast damage to surviving vehicles (closest face takes hit)
      const finalAlive = remainsAlive.map(v => {
        const hit = blastAgainstVehicle.get(v.id);
        if (!hit) return v;
        const loc = getAttackLocation({ position: hit.from, facing: 0 } as VehicleState, v);
        const armor = { ...v.stats.damageState.armor };
        const before = armor[loc] ?? 0;
        armor[loc] = Math.max(0, before - hit.dmg);
        return {
          ...v,
          stats: { ...v.stats, damageState: { ...v.stats.damageState, armor } },
        };
      });

      // Update existing wreckage: apply state transitions + any blast DP loss
      const updatedExisting = existingWreckage.map(w => {
        const dpLoss = blastAgainstWreck.get(w.id) ?? 0;
        const afterDp: WreckageObject = dpLoss > 0
          ? {
              ...w,
              remainingDP: Math.max(0, w.remainingDP - dpLoss),
              state: (w.remainingDP - dpLoss <= 0 && w.state !== 'debris') ? 'debris' : w.state,
              stateStartedAt: (w.remainingDP - dpLoss <= 0 && w.state !== 'debris') ? newTick : w.stateStartedAt,
            }
          : w;
        return transitionWreck(afterDp, newTick);
      });

      pendingInputs.clear();
      state = {
        ...state,
        tick: newTick,
        vehicles: finalAlive,
        hazardObjects: remainingHazards,
        wreckage: [...updatedExisting, ...newWrecks],
        combatEvents: combatEvents.length > 0 ? combatEvents : undefined,
      };
      return state;
    },

    getState() {
      return state;
    },

    addVehicle(vehicle) {
      state = { ...state, vehicles: [...state.vehicles, vehicle] };
    },

    removeVehicle(vehicleId) {
      state = { ...state, vehicles: state.vehicles.filter(v => v.id !== vehicleId) };
    }
  };
}
