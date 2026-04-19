import Phaser from 'phaser';
import type { VehicleState, WeaponMount } from '@carwars/shared';

export const BODY_SPRITE_KEYS = [
  'cycle_light', 'cycle_med', 'cycle_heavy', 'trike',
  'subcompact', 'compact', 'mid_sized', 'sedan', 'station_wagon', 'luxury',
  'pickup', 'van', 'camper', 'truck', 'trailer',
] as const;

export const WEAPON_SPRITE_KEYS = [
  'mg', 'cannon', 'laser', 'heavy_laser',
  'rocket_rack', 'missile', 'flamer', 'spikes', 'oil_jet', 'turret_ring',
] as const;

export const WRECKAGE_STATES = ['burning', 'smouldering', 'debris'] as const;

export function preloadVehicleSprites(scene: Phaser.Scene): void {
  for (const key of BODY_SPRITE_KEYS) {
    scene.load.image(`body_${key}`, `/sprites/bodies/${key}.png`);
    for (const state of WRECKAGE_STATES) {
      scene.load.image(`wreck_${key}_${state}`, `/sprites/wreckage/${key}_${state}.png`);
    }
  }
  for (const key of WEAPON_SPRITE_KEYS) {
    scene.load.image(`weapon_${key}`, `/sprites/weapons/${key}.png`);
  }
}

// BodyType (from loadout) → sprite key. Falls back to mid_sized.
export function bodySpriteKey(bodyType: string | undefined): string {
  if (bodyType && (BODY_SPRITE_KEYS as readonly string[]).includes(bodyType)) {
    return bodyType;
  }
  return 'mid_sized';
}

// Weapon id (from mount.weaponId) → sprite key for the barrel/launcher overlay.
export function weaponSpriteKey(weaponId: string | null): string | null {
  if (!weaponId) return null;
  switch (weaponId) {
    case 'mg': case 'vmg': case 'hmg': case 'rr':
      return 'mg';
    case 'ac': case 'gl': case 'atg': case 'bc':
      return 'cannon';
    case 'll': case 'ml': case 'laser':
      return 'laser';
    case 'l': case 'hl':
      return 'heavy_laser';
    case 'ltr': case 'mr': case 'mml':
      return 'missile';
    case 'hr': case 'rl':
      return 'rocket_rack';
    case 'lft': case 'ft':
      return 'flamer';
    case 'sd': case 'mine':
      return 'spikes';
    case 'oj': case 'oil':
      return 'oil_jet';
    default:
      return 'mg';
  }
}

interface BodyDims { w: number; h: number; }

function getBodyDims(scene: Phaser.Scene, key: string): BodyDims {
  const src = scene.textures.get(`body_${key}`).getSourceImage();
  return { w: src.width, h: src.height };
}

// Anchor (x, y) on the body for a given weapon arc. Coords are local to the
// vehicle container — body is centered at (0, 0), sprite points "up" at facing 0.
function weaponAnchor(arc: WeaponMount['arc'], body: BodyDims): { x: number; y: number; rotation: number } {
  const halfH = body.h / 2;
  const halfW = body.w / 2;
  switch (arc) {
    case 'front':  return { x: 0,       y: -halfH + 2, rotation: 0 };
    case 'back':   return { x: 0,       y:  halfH - 2, rotation: Math.PI };
    case 'left':   return { x: -halfW,  y: 0,          rotation: -Math.PI / 2 };
    case 'right':  return { x:  halfW,  y: 0,          rotation:  Math.PI / 2 };
    case 'turret': return { x: 0,       y: 0,          rotation: 0 };
  }
}

export interface VehicleSpriteOpts {
  isPlayer: boolean;
  teamColor: number;  // RGB tint applied to the body sprite (e.g. 0x00ff88 for player green)
  order?: import('@carwars/shared').SquadOrder;  // active commander order, if any
}

function orderDisplayText(order: import('@carwars/shared').SquadOrder, idShort: (id: string) => string): string {
  switch (order.type) {
    case 'attack':  return `▶ ATK ${idShort(order.targetId)}`;
    case 'move':    return `→ MOVE (${order.x.toFixed(0)},${order.y.toFixed(0)})`;
    case 'follow':  return '⎔ FOLLOW';
    case 'retreat': return '⤺ RETREAT';
    default:        return '';
  }
}

// Builds a layered container: body sprite → weapon overlays → armor bars → label.
// All children have `.name` set so updateVehicleSprite() can find them.
export function buildVehicleSprite(
  scene: Phaser.Scene,
  v: VehicleState,
  opts: VehicleSpriteOpts,
): Phaser.GameObjects.Container {
  const bodyKey = bodySpriteKey(v.stats.loadout?.bodyType);
  const dims = getBodyDims(scene, bodyKey);

  const bodySprite = scene.add.image(0, 0, `body_${bodyKey}`).setName('body').setTint(opts.teamColor);

  // Weapon overlays — one per mount, using loadout.mounts
  const weaponLayers: Phaser.GameObjects.Image[] = [];
  const mounts = v.stats.loadout?.mounts ?? [];
  mounts.forEach((m, i) => {
    const wKey = weaponSpriteKey(m.weaponId);
    if (!wKey) return;
    const anchor = weaponAnchor(m.arc, dims);
    const img = scene.add.image(anchor.x, anchor.y, `weapon_${wKey}`)
      .setRotation(anchor.rotation)
      .setName(`weapon_${i}`);
    weaponLayers.push(img);
  });

  // Armor bars sized to match body
  const barW = dims.w;
  const barH = dims.h;
  const barFront = scene.add.rectangle(0, -barH / 2 - 2, barW, 3, 0x00ff00).setName('bar-front');
  const barBack  = scene.add.rectangle(0,  barH / 2 + 2, barW, 3, 0x00ff00).setName('bar-back');
  const barLeft  = scene.add.rectangle(-barW / 2 - 2, 0, 3, barH, 0x00ff00).setName('bar-left');
  const barRight = scene.add.rectangle( barW / 2 + 2, 0, 3, barH, 0x00ff00).setName('bar-right');

  // State overlay (fire glow) — hidden by default, shown via updateVehicleSprite
  const fireGlow = scene.add.circle(0, 0, Math.max(barW, barH) / 2 + 4, 0xff6622, 0.35)
    .setVisible(false)
    .setName('fire-glow');

  const label = scene.add.text(0, barH / 2 + 10, v.id.slice(0, 8), {
    fontSize: '9px', color: '#ffffff', fontFamily: 'monospace',
  }).setOrigin(0.5).setName('label');

  // Order indicator — hidden unless the sprite is a squadmate with an active order.
  // Populated externally via updateVehicleSprite's `order` option.
  const orderLabel = scene.add.text(0, -barH / 2 - 14, '', {
    fontSize: '11px', color: '#aaffaa', fontFamily: 'monospace', fontStyle: 'bold',
    backgroundColor: '#001a11', padding: { x: 3, y: 1 },
  }).setOrigin(0.5).setVisible(false).setName('order');

  const children = [fireGlow, bodySprite, ...weaponLayers, barFront, barBack, barLeft, barRight, label, orderLabel];
  const container = scene.add.container(0, 0, children).setDepth(2);
  // Store dims for update-time calcs
  (container as Phaser.GameObjects.Container & { bodyDims?: BodyDims }).bodyDims = dims;
  return container;
}

function barColor(p: number): number {
  return p > 0.5 ? 0x00ff00 : p > 0.25 ? 0xffaa00 : 0xff2200;
}

export function updateVehicleSprite(
  container: Phaser.GameObjects.Container,
  v: VehicleState,
  opts: VehicleSpriteOpts,
): void {
  const loadout = v.stats.loadout;
  const damage = v.stats.damageState;
  if (!loadout) return;

  const dims = (container as Phaser.GameObjects.Container & { bodyDims?: BodyDims }).bodyDims;
  if (!dims) return;

  const armorPct = (loc: 'front' | 'back' | 'left' | 'right'): number => {
    const orig = loadout.armor[loc];
    if (!orig) return 1;
    return Math.max(0, (damage.armor[loc] ?? orig)) / orig;
  };

  const barFront = container.getByName('bar-front') as Phaser.GameObjects.Rectangle | null;
  const barBack  = container.getByName('bar-back')  as Phaser.GameObjects.Rectangle | null;
  const barLeft  = container.getByName('bar-left')  as Phaser.GameObjects.Rectangle | null;
  const barRight = container.getByName('bar-right') as Phaser.GameObjects.Rectangle | null;
  if (barFront) { const p = armorPct('front'); barFront.setSize(dims.w * p, 3).setFillStyle(barColor(p)); }
  if (barBack)  { const p = armorPct('back');  barBack.setSize(dims.w * p, 3).setFillStyle(barColor(p)); }
  if (barLeft)  { const p = armorPct('left');  barLeft.setSize(3, dims.h * p).setFillStyle(barColor(p)); }
  if (barRight) { const p = armorPct('right'); barRight.setSize(3, dims.h * p).setFillStyle(barColor(p)); }

  // Body tint interpolates team colour toward red as overall armor drops
  const totalOrig = (loadout.armor.front ?? 0) + (loadout.armor.back ?? 0)
                  + (loadout.armor.left  ?? 0) + (loadout.armor.right ?? 0);
  const totalRem  = (damage.armor.front ?? loadout.armor.front ?? 0)
                  + (damage.armor.back  ?? loadout.armor.back  ?? 0)
                  + (damage.armor.left  ?? loadout.armor.left  ?? 0)
                  + (damage.armor.right ?? loadout.armor.right ?? 0);
  const healthPct = totalOrig > 0 ? totalRem / totalOrig : 1;

  const body = container.getByName('body') as Phaser.GameObjects.Image | null;
  if (body) {
    const baseR = (opts.teamColor >> 16) & 0xff;
    const baseG = (opts.teamColor >> 8)  & 0xff;
    const baseB =  opts.teamColor        & 0xff;
    const r = Math.floor(255 + (baseR - 255) * healthPct);
    const g = Math.floor(baseG * healthPct);
    const b = Math.floor(baseB * healthPct);
    body.setTint((r << 16) | (g << 8) | b);
  }

  // Dry-mount opacity: weapons at 0 ammo render at 50%
  const mounts = loadout.mounts ?? [];
  mounts.forEach((m, i) => {
    const img = container.getByName(`weapon_${i}`) as Phaser.GameObjects.Image | null;
    if (img) img.setAlpha(m.ammo > 0 ? 1 : 0.5);
  });

  // State overlays
  const fireGlow = container.getByName('fire-glow') as Phaser.GameObjects.Arc | null;
  if (fireGlow) fireGlow.setVisible(!!damage.onFire);

  // Commander order indicator — visible only if an order is set
  const orderLabel = container.getByName('order') as Phaser.GameObjects.Text | null;
  if (orderLabel) {
    if (opts.order) {
      orderLabel.setText(orderDisplayText(opts.order, id => id.slice(0, 6)));
      orderLabel.setVisible(true);
    } else {
      orderLabel.setVisible(false);
    }
  }
}

// Slightly lighten/darken a colour by a signed factor (-1..1). +0.3 → brighter, -0.3 → darker.
function shiftBrightness(rgb: number, factor: number): number {
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b =  rgb       & 0xff;
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  const adj = (n: number) => factor >= 0 ? n + (255 - n) * factor : n * (1 + factor);
  return (clamp(adj(r)) << 16) | (clamp(adj(g)) << 8) | clamp(adj(b));
}

export function teamColorForVehicle(
  v: VehicleState,
  myVehicleId: string,
  squadIds: string[] = [],
  gangPrimaryColour?: number,
): number {
  // Player's squad uses the gang primary colour when one is configured; primary is
  // the bright version, squadmates are a darker shade for distinction.
  if (v.id === myVehicleId) return gangPrimaryColour ?? 0x00ff88;
  if (squadIds.includes(v.id)) {
    return gangPrimaryColour !== undefined ? shiftBrightness(gangPrimaryColour, -0.3) : 0x66cc88;
  }
  if (v.playerId === 'ai-team') return 0xff4444;  // enemies
  return 0xffaa00;                                 // other (NPC traffic etc)
}
