// Vehicle accessories — Compendium-inspired catalog of installable kit that
// modifies combat / movement / driver performance. Each entry has a cost,
// weight, space footprint, and a structured `effects` block that the combat /
// movement layers read at runtime.
//
// Effect kinds we model:
//   - toHitBonus.all     : applied to every weapon's to-hit roll
//   - toHitBonus.bound   : applied only when the accessory is bound to a mount
//   - driverSkillBonus   : added to the effective driver skill
//   - clearOnFire        : usable item that clears damageState.onFire
//   - hcBonus            : added to vehicle HC (post-suspension)
//   - dModBonus          : adds to braking D-modifier (anti-skid)
//   - topSpeedMul        : multiplied into top speed (e.g. 1.05 = +5%)
//   - autopilot          : grants AI takeover at the given skill tier

export interface AccessoryEffects {
  toHitBonusAll?: number;
  toHitBonusBound?: number;
  driverSkillBonus?: number;
  hcBonus?: number;
  dModBonus?: number;
  topSpeedMul?: number;
  autopilotSkill?: number;
  clearOnFire?: boolean;
}

export interface AccessoryDef {
  id: string;
  name: string;
  category: 'computer' | 'driver' | 'brakes' | 'aero' | 'safety' | 'sensor' | 'utility';
  cost: number;
  weight: number;
  spaces: number;
  description: string;
  bindable?: boolean;        // requires boundMountId on AccessoryConfig
  effects: AccessoryEffects;
}

export const ACCESSORIES: AccessoryDef[] = [
  // ── Targeting computers ───────────────────────────────────────────────
  {
    id: 'swc', name: 'Single-Weapon Computer', category: 'computer',
    cost: 500, weight: 5, spaces: 1, bindable: true,
    description: 'Targeting computer linked to one weapon. -1 to-hit on bound mount.',
    effects: { toHitBonusBound: -1 },
  },
  {
    id: 'hrc', name: 'Hi-Res Computer', category: 'computer',
    cost: 1500, weight: 10, spaces: 1,
    description: 'Whole-vehicle targeting computer. -1 to-hit on every weapon.',
    effects: { toHitBonusAll: -1 },
  },
  {
    id: 'hrswc', name: 'Hi-Res Single Weapon Computer', category: 'computer',
    cost: 1000, weight: 7, spaces: 1, bindable: true,
    description: 'Hi-res computer linked to one weapon. -1 to-hit on bound mount, sees through smoke.',
    effects: { toHitBonusBound: -1 },
  },
  {
    id: 'targeting_laser', name: 'Targeting Laser', category: 'computer',
    cost: 500, weight: 5, spaces: 1, bindable: true,
    description: 'Paints a target — bound weapon gets a small to-hit bonus. (-1 stacks with computers.)',
    effects: { toHitBonusBound: -1 },
  },

  // ── Driver augmentation ───────────────────────────────────────────────
  {
    id: 'cyberlink', name: 'Cyberlink', category: 'driver',
    cost: 5000, weight: 5, spaces: 1,
    description: 'Direct neural interface. +1 effective driver skill.',
    effects: { driverSkillBonus: 1 },
  },
  {
    id: 'autopilot_basic', name: 'Autopilot (Basic)', category: 'driver',
    cost: 2000, weight: 50, spaces: 2,
    description: 'AI driver — takes over when no human is at the wheel. Skill 1.',
    effects: { autopilotSkill: 1 },
  },
  {
    id: 'autopilot_improved', name: 'Autopilot (Improved)', category: 'driver',
    cost: 5000, weight: 50, spaces: 2,
    description: 'Better autopilot — skill 2.',
    effects: { autopilotSkill: 2 },
  },
  {
    id: 'autopilot_advanced', name: 'Autopilot (Advanced)', category: 'driver',
    cost: 10000, weight: 50, spaces: 2,
    description: 'Top-tier autopilot — skill 3.',
    effects: { autopilotSkill: 3 },
  },

  // ── Brakes / aero / handling ──────────────────────────────────────────
  {
    id: 'hd_brakes', name: 'Heavy-Duty Brakes', category: 'brakes',
    cost: 150, weight: 25, spaces: 0,
    description: '+1 D-modifier when braking — less likely to skid out.',
    effects: { dModBonus: 1 },
  },
  {
    id: 'abs', name: 'ABS', category: 'brakes',
    cost: 600, weight: 15, spaces: 0,
    description: 'Anti-lock braking — adds to D-modifier and never locks wheels.',
    effects: { dModBonus: 2 },
  },
  {
    id: 'spoiler', name: 'Spoiler', category: 'aero',
    cost: 150, weight: 10, spaces: 0,
    description: '+1 HC at high speed — keeps you planted in corners.',
    effects: { hcBonus: 1 },
  },
  {
    id: 'streamlining', name: 'Streamlining', category: 'aero',
    cost: 1000, weight: 0, spaces: 0,
    description: '+5% top speed — better aero shell.',
    effects: { topSpeedMul: 1.05 },
  },
  {
    id: 'active_suspension', name: 'Active Suspension', category: 'aero',
    cost: 2000, weight: 100, spaces: 1,
    description: '+1 HC and improved cornering.',
    effects: { hcBonus: 1 },
  },

  // ── Safety / utility ──────────────────────────────────────────────────
  {
    id: 'fire_ext', name: 'Fire Extinguisher', category: 'safety',
    cost: 50, weight: 5, spaces: 0,
    description: 'Clears the onFire damage state when activated.',
    effects: { clearOnFire: true },
  },
  {
    id: 'safety_seat', name: 'Safety Seat', category: 'safety',
    cost: 250, weight: 15, spaces: 0,
    description: 'Reduces driver-wound chance from collisions.',
    effects: {},
  },
  {
    id: 'roll_cage', name: 'Roll Cage', category: 'safety',
    cost: 300, weight: 75, spaces: 0,
    description: 'Internal frame protects driver in rollovers.',
    effects: {},
  },

  // ── Sensors ───────────────────────────────────────────────────────────
  {
    id: 'radar', name: 'Radar', category: 'sensor',
    cost: 1000, weight: 25, spaces: 1,
    description: 'Detect vehicles at extended range.',
    effects: {},
  },
  {
    id: 'infrared', name: 'Infrared', category: 'sensor',
    cost: 800, weight: 15, spaces: 1,
    description: 'See in darkness — no penalty for night fights.',
    effects: {},
  },
];

export const ACCESSORY_INDEX: Record<string, AccessoryDef> = Object.fromEntries(
  ACCESSORIES.map(a => [a.id, a]),
);
