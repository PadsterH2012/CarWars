// Bottom-strip squad HUD: one transparent card per gang vehicle showing a
// speedometer dial, current task, armour silhouette, and armament — with
// damaged/destroyed components flagged and wrecked vehicles greyed out.
import Phaser from 'phaser';
import type { VehicleState } from '@carwars/shared';

const TASK_LABELS: Record<string, string> = {
  scout: 'SCOUTING', pursue: 'PURSUING', ambush: 'HOLDING',
  aggressive: 'ENGAGING', orbit: 'ENGAGING', engaging: 'ENGAGING',
  snipe: 'SNIPING', flanking: 'FLANKING', evasive: 'EVADING',
  recovering: 'RECOVERING', manual: 'MANUAL', moving: 'MOVING',
  retreating: 'RETREATING', following: 'FOLLOWING', defending: 'DEFENDING', idle: 'IDLE',
};
const TASK_COLORS: Record<string, string> = {
  scout: '#66bbff', pursue: '#66bbff', ambush: '#9aa3b2',
  aggressive: '#ff5555', orbit: '#ff7744', engaging: '#ff5555',
  snipe: '#ff5555', flanking: '#ffaa44', evasive: '#ffcc00',
  recovering: '#ff8800', manual: '#00ff88', moving: '#88ccff',
  retreating: '#ffcc00', following: '#88ccff', defending: '#88ccff', idle: '#888888',
};
const taskLabel = (t?: string) => TASK_LABELS[t ?? ''] ?? (t ? t.toUpperCase() : 'IDLE');
const taskColor = (t?: string) => TASK_COLORS[t ?? ''] ?? '#aabbcc';

// Per-face armour fraction 0..1.
function faceFrac(v: VehicleState, face: string): number {
  const orig = (v.stats.loadout?.armor ?? {}) as Record<string, number>;
  const cur = (v.stats.damageState?.armor ?? {}) as Record<string, number>;
  const o = orig[face] ?? 0;
  return o > 0 ? Math.max(0, Math.min(1, (cur[face] ?? 0) / o)) : 1;
}
// 1 = green, 0.5 = yellow, 0 = red.
function faceColour(f: number): number {
  const r = f > 0.5 ? Math.round(255 * (1 - f) * 2) : 255;
  const g = f > 0.5 ? 255 : Math.round(255 * f * 2);
  return (r << 16) | (g << 8) | 0x33;
}
function armourPct(v: VehicleState): number {
  const orig = (v.stats.loadout?.armor ?? {}) as Record<string, number>;
  const cur = (v.stats.damageState?.armor ?? {}) as Record<string, number>;
  let o = 0, c = 0;
  for (const f of ['front', 'back', 'left', 'right', 'top', 'underbody']) { o += orig[f] ?? 0; c += cur[f] ?? 0; }
  return o > 0 ? Math.round((c / o) * 100) : 100;
}
function pctColour(p: number): string {
  return p > 60 ? '#00ff88' : p > 25 ? '#ffcc00' : '#ff5555';
}
function weaponSummary(v: VehicleState): string {
  const mounts = (v.stats.loadout?.mounts ?? []).filter(m => m.weaponId);
  if (!mounts.length) return 'unarmed';
  return mounts.map(m => `${(m.weaponId ?? '').toUpperCase()}·${m.ammo}`).join('  ').slice(0, 28);
}
function damageSummary(v: VehicleState): string {
  const ds = v.stats.damageState;
  const parts: string[] = [];
  if (ds.engineDamaged) parts.push('ENGINE');
  if (ds.tiresBlown?.length) parts.push(`${ds.tiresBlown.length} TIRE`);
  if (ds.driverWounded) parts.push('DRIVER');
  if (ds.onFire) parts.push('FIRE');
  const dry = (v.stats.loadout?.mounts ?? []).filter(m => m.weaponId && m.ammo <= 0).length;
  if (dry) parts.push(`${dry} NO-AMMO`);
  return parts.join(' · ').slice(0, 30);
}

interface Card {
  name: Phaser.GameObjects.Text;
  speed: Phaser.GameObjects.Text;
  task: Phaser.GameObjects.Text;
  weapons: Phaser.GameObjects.Text;
  dmg: Phaser.GameObjects.Text;
  integ: Phaser.GameObjects.Text;
}

const CARD_W = 172, CARD_H = 92, GAP = 10, MAX = 4;

export class SquadHud {
  private gfx: Phaser.GameObjects.Graphics;
  private cards: Card[] = [];

  constructor(scene: Phaser.Scene) {
    this.gfx = scene.add.graphics().setScrollFactor(0).setDepth(18);
    const mk = (size: number, color: string, originX = 0) =>
      scene.add.text(0, 0, '', { fontFamily: 'monospace', fontSize: `${size}px`, color })
        .setScrollFactor(0).setDepth(19).setOrigin(originX, 0);
    for (let i = 0; i < MAX; i++) {
      this.cards.push({
        name: mk(11, '#cde'),
        speed: mk(20, '#ffffff', 0.5).setOrigin(0.5, 0.5),
        task: mk(10, '#8ff', 1).setOrigin(1, 0),
        weapons: mk(10, '#bbbbbb'),
        dmg: mk(10, '#ff6666'),
        integ: mk(9, '#9f9', 0.5).setOrigin(0.5, 0),
      });
    }
  }

  // Draw/refresh the strip for the player's gang vehicles.
  update(scene: Phaser.Scene, vehicles: VehicleState[], myId: string, squadIds: string[], gangColour?: number): void {
    const g = this.gfx;
    g.clear();
    const squad = vehicles
      .filter(v => v.id === myId || squadIds.includes(v.id))
      .sort((a, b) => (a.id === myId ? -1 : b.id === myId ? 1 : 0))
      .slice(0, MAX);
    const n = squad.length;
    const totalW = n * CARD_W + (n - 1) * GAP;
    const startX = Math.round((scene.scale.width - totalW) / 2);
    const y = scene.scale.height - CARD_H - 12;

    for (let i = 0; i < MAX; i++) {
      const c = this.cards[i];
      if (i >= n) { Object.values(c).forEach(t => t.setVisible(false)); continue; }
      Object.values(c).forEach(t => t.setVisible(true));

      const v = squad[i];
      const x = startX + i * (CARD_W + GAP);
      const wrecked = !!v.stats.damageState.destroyed;
      const accent = wrecked ? 0x556 : (gangColour ?? 0x00ff88);
      const hexAccent = '#' + (accent & 0xffffff).toString(16).padStart(6, '0');

      // Panel
      g.fillStyle(0x05080f, wrecked ? 0.5 : 0.6);
      g.fillRect(x, y, CARD_W, CARD_H);
      g.lineStyle(1, accent, wrecked ? 0.5 : 0.9);
      g.strokeRect(x, y, CARD_W, CARD_H);

      // Name (+ ▸ marker on your own vehicle)
      const nm = (v.stats.name || 'Vehicle').toUpperCase();
      c.name.setPosition(x + 8, y + 5).setColor(hexAccent)
        .setText((v.id === myId ? '▸ ' : '') + nm.slice(0, v.id === myId ? 14 : 17));

      // Task badge (top-right)
      c.task.setPosition(x + CARD_W - 8, y + 5)
        .setText(wrecked ? 'WRECKED' : taskLabel(v.task))
        .setColor(wrecked ? '#888' : taskColor(v.task));

      // Speedometer dial (lower-left)
      const cx = x + 36, cy = y + 54, r = 24;
      const maxS = Math.max(1, v.stats.maxSpeed);
      const spd = Math.max(0, Math.round(v.speed));
      drawDial(g, cx, cy, r, spd / maxS, wrecked);
      c.speed.setPosition(cx, cy + 1).setText(wrecked ? '—' : String(spd)).setColor(wrecked ? '#777' : '#ffffff');

      // Armour silhouette (right) + integrity %
      drawSilhouette(g, x + 78, y + 26, 58, 40, v, wrecked);
      const pct = armourPct(v);
      c.integ.setPosition(x + 78 + 29, y + 68).setText(pct + '%').setColor(wrecked ? '#777' : pctColour(pct));

      // Armament + damage line
      c.weapons.setPosition(x + 8, y + CARD_H - 26).setText(weaponSummary(v)).setColor(wrecked ? '#666' : '#bbbbbb');
      c.dmg.setPosition(x + 8, y + CARD_H - 14).setText(wrecked ? 'DESTROYED' : damageSummary(v))
        .setColor(wrecked ? '#888' : '#ff6666');
    }
  }
}

// ── Drawing helpers ──────────────────────────────────────────────────────────
function drawDial(g: Phaser.GameObjects.Graphics, cx: number, cy: number, r: number, frac: number, wrecked: boolean): void {
  const f = Math.max(0, Math.min(1, frac));
  const A0 = Phaser.Math.DegToRad(135), SWEEP = Phaser.Math.DegToRad(270);
  g.lineStyle(3, 0x223047, 1);                       // track
  g.beginPath(); g.arc(cx, cy, r, A0, A0 + SWEEP, false); g.strokePath();
  g.lineStyle(3, wrecked ? 0x555566 : 0x33ddff, 1);  // value
  g.beginPath(); g.arc(cx, cy, r, A0, A0 + SWEEP * f, false); g.strokePath();
  const a = A0 + SWEEP * f;                            // needle
  g.lineStyle(2, wrecked ? 0x777777 : 0xffffff, 1);
  g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * (r - 3), cy + Math.sin(a) * (r - 3)); g.strokePath();
  g.fillStyle(0xffffff, 1); g.fillCircle(cx, cy, 2);
}

function drawSilhouette(g: Phaser.GameObjects.Graphics, x: number, y: number, w: number, h: number, v: VehicleState, wrecked: boolean): void {
  const col = (face: string) => wrecked ? 0x444444 : faceColour(faceFrac(v, face));
  const t = 0.30;
  g.fillStyle(col('front'), 0.92); g.fillRect(x, y, w, h * t);                       // front
  g.fillStyle(col('back'), 0.92); g.fillRect(x, y + h * (1 - t), w, h * t);          // back
  g.fillStyle(col('left'), 0.92); g.fillRect(x, y + h * t, w * 0.28, h * (1 - 2 * t)); // left
  g.fillStyle(col('right'), 0.92); g.fillRect(x + w * 0.72, y + h * t, w * 0.28, h * (1 - 2 * t)); // right
  g.fillStyle(wrecked ? 0x2a2a2a : 0x1a2436, 0.92); g.fillRect(x + w * 0.28, y + h * t, w * 0.44, h * (1 - 2 * t)); // body
  g.lineStyle(1, 0x000000, 0.55); g.strokeRect(x, y, w, h);
}
