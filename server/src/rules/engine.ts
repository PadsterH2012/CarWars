import type { ZoneState, VehicleState, HazardObject, DamageState, ArmorLocation } from '@carwars/shared';
import { computeMovement, applyHazardCheck } from './movement';
import { resolveToHit, resolveDamage, isWeaponInArc, roll2d6, rollDamage } from './combat';
import { WEAPONS } from './data/weapons';

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
}

export function createTurnEngine(initialState: ZoneState): TurnEngine {
  let state: ZoneState = {
    ...initialState,
    vehicles: [...initialState.vehicles],
    hazardObjects: [...(initialState.hazardObjects ?? [])],
  };
  const pendingInputs = new Map<string, VehicleInput>();
  const lastInputs = new Map<string, VehicleInput>();

  return {
    queueInput(vehicleId, input) {
      pendingInputs.set(vehicleId, input);
    },

    resolveTick() {
      const activeVehicles = state.vehicles.filter(v => !v.stats.damageState.destroyed);
      const destroyedVehicles = state.vehicles.filter(v => v.stats.damageState.destroyed);
      const preMoveVehicles = [...activeVehicles];

      // Move all active vehicles
      let newVehicles = activeVehicles.map(vehicle => {
        const input = pendingInputs.get(vehicle.id) ?? lastInputs.get(vehicle.id) ?? { speed: 0, steer: 0, fireWeapon: null };
        lastInputs.set(vehicle.id, { speed: input.speed, steer: input.steer, fireWeapon: null });
        return computeMovement(vehicle, input);
      });

      // Apply hazard checks — high-speed tight turns may cause spinout
      newVehicles = newVehicles.map(vehicle => {
        const input = pendingInputs.get(vehicle.id) ?? lastInputs.get(vehicle.id) ?? { speed: 0, steer: 0, fireWeapon: null };
        const hazard = applyHazardCheck(vehicle, { speed: vehicle.speed, steer: input.steer });
        if (!hazard.required) return vehicle;
        const roll = roll2d6();
        if (roll >= hazard.difficulty) return vehicle; // passed
        // Failed — spinout: random rotation, halve speed
        const spinAngle = (Math.random() > 0.5 ? 1 : -1) * (60 + Math.floor(Math.random() * 120));
        return {
          ...vehicle,
          facing: (vehicle.facing + spinAngle + 360) % 360,
          speed: Math.floor(vehicle.speed / 2),
        };
      });

      // Mutable damage and ammo update maps
      const damageUpdates = new Map<string, DamageState>();
      const ammoUpdates = new Map<string, Map<string, number>>(); // vehicleId -> mountId -> newAmmo

      // Resolve combat using pre-move positions
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
        if (weapon.special === 'dropped') {
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

          const dx = target.position.x - attacker.position.x;
          const dy = target.position.y - attacker.position.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance > weapon.longRange) return;

          const toHit = resolveToHit(attacker, target, weapon, distance);
          if (!toHit.hit) return;

          // damageDice === 0 means fixed-damage weapon (e.g. legacy entries); fall back to flat damage field
          const rolledDamage = weapon.damageDice > 0 ? rollDamage(weapon.damageDice, weapon.damageMod) : (weapon.damage ?? 1);
          const damageResult = resolveDamage(target, toHit.location, rolledDamage);
          const currentDamage = damageUpdates.get(target.id) ?? { ...target.stats.damageState };
          const newArmor = { ...currentDamage.armor };
          newArmor[toHit.location] = Math.max(0, (newArmor[toHit.location] ?? 0) - damageResult.damageDealt);

          const tireIndex = (toHit.location === 'front' || toHit.location === 'left') ? 0
            : (toHit.location === 'right') ? 1 : 2;

          damageUpdates.set(target.id, {
            ...currentDamage,
            armor: newArmor,
            engineDamaged: currentDamage.engineDamaged || damageResult.effects.includes('engine_hit'),
            driverWounded: currentDamage.driverWounded || damageResult.effects.includes('driver_wounded'),
            destroyed: currentDamage.destroyed || damageResult.effects.includes('destroyed'),
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
      const finalVehicles = [
        ...newVehicles.map(v => {
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
        }),
        ...destroyedVehicles
      ];

      pendingInputs.clear();
      state = {
        ...state,
        tick: state.tick + 1,
        vehicles: finalVehicles,
        hazardObjects: remainingHazards,
      };
      return state;
    },

    getState() {
      return state;
    },

    addVehicle(vehicle) {
      state = { ...state, vehicles: [...state.vehicles, vehicle] };
    }
  };
}
