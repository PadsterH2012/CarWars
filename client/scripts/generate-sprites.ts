import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_BODIES = resolve(__dirname, '..', 'public', 'sprites', 'bodies');
const OUT_WEAPONS = resolve(__dirname, '..', 'public', 'sprites', 'weapons');
const OUT_WRECKS = resolve(__dirname, '..', 'public', 'sprites', 'wreckage');

mkdirSync(OUT_BODIES, { recursive: true });
mkdirSync(OUT_WEAPONS, { recursive: true });
mkdirSync(OUT_WRECKS, { recursive: true });

function writePng(path: string, w: number, h: number, draw: (ctx: SKRSContext2D) => void) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  draw(ctx);
  writeFileSync(path, canvas.toBuffer('image/png'));
}

function roundedRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ── Bodies ────────────────────────────────────────────────────────────────────
// All bodies point "up" (facing 0°, game convention). Width × Height in px.
// Tintable — drawn in neutral grey so Phaser setTint(0xRRGGBB) recolours cleanly.
interface BodySpec {
  id: string;
  w: number;
  h: number;
  draw: (ctx: SKRSContext2D, w: number, h: number) => void;
}

function carBody(ctx: SKRSContext2D, w: number, h: number, opts?: { windshieldRatio?: number; wheelSize?: number }) {
  const wsRatio = opts?.windshieldRatio ?? 0.35;
  const wheelSize = opts?.wheelSize ?? 4;
  // Hull — rounded rect, tintable via neutral fill
  ctx.fillStyle = '#c8c8c8';
  roundedRect(ctx, 2, 2, w - 4, h - 4, 3);
  ctx.fill();
  // Outline for definition
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 1;
  roundedRect(ctx, 2, 2, w - 4, h - 4, 3);
  ctx.stroke();

  // Front marker: bright headlights strip + white chevron on the bonnet so
  // the forward direction reads immediately even on a tinted sprite.
  ctx.fillStyle = '#ffffcc';   // warm white — stays bright under any tint
  ctx.fillRect(3, 3, Math.max(2, Math.floor(w * 0.2)), 2);
  ctx.fillRect(w - 3 - Math.max(2, Math.floor(w * 0.2)), 3, Math.max(2, Math.floor(w * 0.2)), 2);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(w / 2, 3);
  ctx.lineTo(w / 2 + 3, 8);
  ctx.lineTo(w / 2 - 3, 8);
  ctx.closePath();
  ctx.fill();

  // Windshield (front) — subtle blue, doesn't need tint contrast
  ctx.fillStyle = '#506080';
  const wsH = Math.round(h * wsRatio * 0.35);
  const wsY = Math.round(h * 0.22);
  roundedRect(ctx, 3, wsY, w - 6, wsH, 1);
  ctx.fill();
  // Rear window
  const rwY = Math.round(h * 0.62);
  ctx.fillStyle = '#3e4a60';
  roundedRect(ctx, 3, rwY, w - 6, Math.round(h * 0.1), 1);
  ctx.fill();

  // Rear marker — dim red tail lights so back reads clearly too
  ctx.fillStyle = '#aa2222';
  ctx.fillRect(3, h - 5, Math.max(2, Math.floor(w * 0.2)), 2);
  ctx.fillRect(w - 3 - Math.max(2, Math.floor(w * 0.2)), h - 5, Math.max(2, Math.floor(w * 0.2)), 2);

  // Wheels — pure black, bigger than before so they read at any scale.
  // Positioned so they slightly protrude from the hull (classic top-down
  // car silhouette) which also gives the sprite a recognisable outline.
  ctx.fillStyle = '#000000';
  const wheelH = Math.max(4, Math.round(h * 0.18));
  const frontY = Math.round(h * 0.22);
  const rearY  = Math.round(h * 0.66);
  // Outline the wheels in white so they stand out against any body colour
  ctx.fillRect(-1, frontY, wheelSize + 1, wheelH);
  ctx.fillRect(w - wheelSize, frontY, wheelSize + 1, wheelH);
  ctx.fillRect(-1, rearY, wheelSize + 1, wheelH);
  ctx.fillRect(w - wheelSize, rearY, wheelSize + 1, wheelH);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(-1, frontY, wheelSize + 1, wheelH);
  ctx.strokeRect(w - wheelSize, frontY, wheelSize + 1, wheelH);
  ctx.strokeRect(-1, rearY, wheelSize + 1, wheelH);
  ctx.strokeRect(w - wheelSize, rearY, wheelSize + 1, wheelH);
}

function cycleBody(ctx: SKRSContext2D, w: number, h: number) {
  // Narrow pill
  ctx.fillStyle = '#c8c8c8';
  roundedRect(ctx, 1, 1, w - 2, h - 2, Math.min(w / 2 - 1, 5));
  ctx.fill();
  ctx.strokeStyle = '#2b2b2b';
  ctx.lineWidth = 1;
  roundedRect(ctx, 1, 1, w - 2, h - 2, Math.min(w / 2 - 1, 5));
  ctx.stroke();
  // Rider silhouette
  ctx.fillStyle = '#4a4a4a';
  ctx.fillRect(Math.floor(w / 2) - 2, Math.floor(h / 2) - 4, 4, 8);
  // Front wheel dark band
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(1, 1, w - 2, 2);
  ctx.fillRect(1, h - 3, w - 2, 2);
}

function trikeBody(ctx: SKRSContext2D, w: number, h: number) {
  // Wedge narrowing toward front
  ctx.fillStyle = '#c8c8c8';
  ctx.beginPath();
  ctx.moveTo(w / 2, 1);
  ctx.lineTo(w - 2, h - 3);
  ctx.lineTo(w - 2, h - 1);
  ctx.lineTo(2, h - 1);
  ctx.lineTo(2, h - 3);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#2b2b2b';
  ctx.lineWidth = 1;
  ctx.stroke();
  // Rider/seat silhouette so it reads as a trike not an arrow
  ctx.fillStyle = '#4a4a4a';
  ctx.fillRect(Math.floor(w / 2) - 2, Math.floor(h * 0.35), 4, 8);
  // Wheels — 3 total: 1 up front, 2 on rear axle. Larger than before so they
  // actually read at sprite scale. White outline to stand out against any tint.
  ctx.fillStyle = '#000000';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 0.5;
  const wheelW = 4, wheelH = 7;
  // Front (centered)
  ctx.fillRect(Math.floor(w / 2) - wheelW / 2, 1, wheelW, wheelH);
  ctx.strokeRect(Math.floor(w / 2) - wheelW / 2, 1, wheelW, wheelH);
  // Rear left / right (protrude from hull)
  ctx.fillRect(-1, h - wheelH - 1, wheelW + 1, wheelH);
  ctx.strokeRect(-1, h - wheelH - 1, wheelW + 1, wheelH);
  ctx.fillRect(w - wheelW, h - wheelH - 1, wheelW + 1, wheelH);
  ctx.strokeRect(w - wheelW, h - wheelH - 1, wheelW + 1, wheelH);
}

// Truck-style body with configurable rear-axle count.
//   axleCount = 2 → 4 wheels (pickups, vans, campers)
//   axleCount = 3 → 6 wheels (tractors / big trucks — 1 front axle + 2 rear)
function truckBody(ctx: SKRSContext2D, w: number, h: number, axleCount: 2 | 3 = 2) {
  // Cab
  ctx.fillStyle = '#c8c8c8';
  roundedRect(ctx, 1, 2, w - 2, Math.floor(h * 0.3), 2);
  ctx.fill();
  ctx.strokeStyle = '#2b2b2b';
  ctx.lineWidth = 1;
  roundedRect(ctx, 1, 2, w - 2, Math.floor(h * 0.3), 2);
  ctx.stroke();
  // Bed / flatbed
  ctx.fillStyle = '#a8a8a8';
  ctx.fillRect(2, Math.floor(h * 0.32), w - 4, Math.floor(h * 0.64));
  ctx.strokeRect(2, Math.floor(h * 0.32), w - 4, Math.floor(h * 0.64));
  // Windshield
  ctx.fillStyle = '#506080';
  ctx.fillRect(3, 4, w - 6, Math.floor(h * 0.16));
  // Headlight strip + chevron so forward direction reads clearly
  ctx.fillStyle = '#ffffcc';
  ctx.fillRect(3, 3, Math.max(2, Math.floor(w * 0.18)), 2);
  ctx.fillRect(w - 3 - Math.max(2, Math.floor(w * 0.18)), 3, Math.max(2, Math.floor(w * 0.18)), 2);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(w / 2, 3);
  ctx.lineTo(w / 2 + 3, 8);
  ctx.lineTo(w / 2 - 3, 8);
  ctx.closePath();
  ctx.fill();
  // Rear tail lights
  ctx.fillStyle = '#aa2222';
  ctx.fillRect(3, h - 5, Math.max(2, Math.floor(w * 0.18)), 2);
  ctx.fillRect(w - 3 - Math.max(2, Math.floor(w * 0.18)), h - 5, Math.max(2, Math.floor(w * 0.18)), 2);

  // Wheels — one front axle + `axleCount - 1` rear axles. Bigger + white-outlined
  // so 6-wheel tractors clearly look different from 4-wheel pickups/vans.
  ctx.fillStyle = '#000000';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 0.5;
  const wheelW = 5, wheelH = 6;
  // Front axle
  const frontY = Math.floor(h * 0.12);
  ctx.fillRect(-1, frontY, wheelW + 1, wheelH);
  ctx.strokeRect(-1, frontY, wheelW + 1, wheelH);
  ctx.fillRect(w - wheelW, frontY, wheelW + 1, wheelH);
  ctx.strokeRect(w - wheelW, frontY, wheelW + 1, wheelH);
  // Rear axle(s) — space them evenly across the rear two-thirds of the bed
  const rearStart = 0.60;
  const rearEnd   = 0.84;
  const rearAxles = axleCount - 1;
  for (let i = 0; i < rearAxles; i++) {
    const t = rearAxles === 1 ? 0.5 : i / (rearAxles - 1);
    const y = Math.floor(h * (rearStart + (rearEnd - rearStart) * t));
    ctx.fillRect(-1, y, wheelW + 1, wheelH);
    ctx.strokeRect(-1, y, wheelW + 1, wheelH);
    ctx.fillRect(w - wheelW, y, wheelW + 1, wheelH);
    ctx.strokeRect(w - wheelW, y, wheelW + 1, wheelH);
  }
}

function trailerBody(ctx: SKRSContext2D, w: number, h: number) {
  // Plain cargo box
  ctx.fillStyle = '#b8b8b8';
  ctx.fillRect(2, 1, w - 4, h - 2);
  ctx.strokeStyle = '#2b2b2b';
  ctx.lineWidth = 1;
  ctx.strokeRect(2, 1, w - 4, h - 2);
  // Ridges (segment lines)
  ctx.strokeStyle = '#888';
  for (let i = 1; i < 5; i++) {
    const y = (h * i) / 5;
    ctx.beginPath();
    ctx.moveTo(3, y);
    ctx.lineTo(w - 3, y);
    ctx.stroke();
  }
  // Coupling / kingpin marker at the front — tiny diamond so trailer direction reads
  ctx.fillStyle = '#555';
  ctx.beginPath();
  ctx.moveTo(w / 2, 2);
  ctx.lineTo(w / 2 + 2, 5);
  ctx.lineTo(w / 2, 8);
  ctx.lineTo(w / 2 - 2, 5);
  ctx.closePath();
  ctx.fill();
  // Rear tandem axles — 2 axles × 2 wheels = 4 wheels, both axles clustered
  // at the rear third (classic semi-trailer layout).
  ctx.fillStyle = '#000000';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 0.5;
  const wheelW = 5, wheelH = 8;
  const axleYs = [Math.floor(h * 0.66), Math.floor(h * 0.82)];
  for (const y of axleYs) {
    ctx.fillRect(-1, y, wheelW + 1, wheelH);
    ctx.strokeRect(-1, y, wheelW + 1, wheelH);
    ctx.fillRect(w - wheelW, y, wheelW + 1, wheelH);
    ctx.strokeRect(w - wheelW, y, wheelW + 1, wheelH);
  }
}

const BODIES: BodySpec[] = [
  { id: 'cycle_light',  w: 10, h: 22, draw: cycleBody },
  { id: 'cycle_med',    w: 12, h: 24, draw: cycleBody },
  { id: 'cycle_heavy',  w: 14, h: 26, draw: cycleBody },
  { id: 'trike',        w: 18, h: 26, draw: trikeBody },
  { id: 'subcompact',   w: 18, h: 28, draw: (c, w, h) => carBody(c, w, h, { wheelSize: 2 }) },
  { id: 'compact',      w: 20, h: 30, draw: (c, w, h) => carBody(c, w, h) },
  { id: 'mid_sized',    w: 20, h: 32, draw: (c, w, h) => carBody(c, w, h) },
  { id: 'sedan',        w: 22, h: 34, draw: (c, w, h) => carBody(c, w, h, { windshieldRatio: 0.4 }) },
  { id: 'station_wagon',w: 22, h: 36, draw: (c, w, h) => carBody(c, w, h, { windshieldRatio: 0.3 }) },
  { id: 'luxury',       w: 24, h: 38, draw: (c, w, h) => carBody(c, w, h, { windshieldRatio: 0.42 }) },
  { id: 'pickup',       w: 22, h: 40, draw: (c, w, h) => truckBody(c, w, h, 2) },
  { id: 'van',          w: 24, h: 42, draw: (c, w, h) => truckBody(c, w, h, 2) },
  { id: 'camper',       w: 24, h: 44, draw: (c, w, h) => truckBody(c, w, h, 2) },
  { id: 'truck',        w: 26, h: 52, draw: (c, w, h) => truckBody(c, w, h, 3) },
  { id: 'trailer',      w: 26, h: 54, draw: trailerBody },
];

// ── Weapon attachment sprites ────────────────────────────────────────────────
// All point "up" (fires outward in +y direction of the sprite).
interface WeaponSpec {
  id: string;
  w: number;
  h: number;
  draw: (ctx: SKRSContext2D, w: number, h: number) => void;
}

const WEAPONS: WeaponSpec[] = [
  { id: 'mg', w: 6, h: 10, draw: (c, w, h) => {
      c.fillStyle = '#2b2b2b'; c.fillRect(w / 2 - 1, 0, 2, h);
      c.fillStyle = '#4a4a4a'; c.fillRect(1, h - 4, w - 2, 3);
    }
  },
  { id: 'cannon', w: 8, h: 14, draw: (c, w, h) => {
      c.fillStyle = '#1a1a1a'; c.fillRect(w / 2 - 1.5, 0, 3, h);
      c.fillStyle = '#3e3e3e'; c.fillRect(1, h - 5, w - 2, 4);
    }
  },
  { id: 'laser', w: 6, h: 12, draw: (c, w, h) => {
      c.fillStyle = '#00ccff'; c.fillRect(w / 2 - 0.5, 0, 1, h);
      c.fillStyle = '#2a5a7a'; c.fillRect(1, h - 4, w - 2, 3);
    }
  },
  { id: 'heavy_laser', w: 8, h: 14, draw: (c, w, h) => {
      c.fillStyle = '#00ccff'; c.fillRect(w / 2 - 1, 0, 2, h);
      c.fillStyle = '#2a5a7a'; c.fillRect(1, h - 5, w - 2, 4);
    }
  },
  { id: 'rocket_rack', w: 8, h: 10, draw: (c, w) => {
      c.fillStyle = '#ff8833';
      c.beginPath(); c.moveTo(w / 2, 0); c.lineTo(w - 1, 5); c.lineTo(1, 5); c.closePath(); c.fill();
      c.fillStyle = '#663322'; c.fillRect(1, 5, w - 2, 5);
    }
  },
  { id: 'missile', w: 6, h: 12, draw: (c, w, h) => {
      c.fillStyle = '#ff6633';
      c.beginPath(); c.moveTo(w / 2, 0); c.lineTo(w - 1, 4); c.lineTo(1, 4); c.closePath(); c.fill();
      c.fillStyle = '#884422'; c.fillRect(w / 2 - 1, 4, 2, h - 4);
    }
  },
  { id: 'flamer', w: 8, h: 10, draw: (c, w, h) => {
      c.fillStyle = '#cc3300'; c.fillRect(w / 2 - 1.5, 0, 3, h - 4);
      c.fillStyle = '#996633'; c.fillRect(1, h - 4, w - 2, 3);
    }
  },
  { id: 'spikes', w: 10, h: 4, draw: (c, w, h) => {
      c.fillStyle = '#1a1a1a';
      for (let i = 0; i < 4; i++) {
        c.beginPath();
        c.moveTo(1 + i * 2.5, h);
        c.lineTo(2 + i * 2.5, 0);
        c.lineTo(3 + i * 2.5, h);
        c.closePath();
        c.fill();
      }
    }
  },
  { id: 'oil_jet', w: 8, h: 4, draw: (c, w, h) => {
      c.fillStyle = '#333';
      c.beginPath();
      c.ellipse(w / 2, h / 2, w / 2 - 1, h / 2 - 0.5, 0, 0, Math.PI * 2);
      c.fill();
    }
  },
  { id: 'turret_ring', w: 10, h: 10, draw: (c, w, h) => {
      c.strokeStyle = '#666'; c.lineWidth = 1.5;
      c.beginPath(); c.arc(w / 2, h / 2, w / 2 - 1, 0, Math.PI * 2); c.stroke();
      c.fillStyle = '#444';
      c.beginPath(); c.arc(w / 2, h / 2, 2, 0, Math.PI * 2); c.fill();
    }
  },
];

// ── Wreckage variants (per body type × state) ────────────────────────────────
// Scorched / broken-up versions layered over the body silhouette.
function drawWreckage(ctx: SKRSContext2D, w: number, h: number, state: 'burning' | 'smouldering' | 'debris') {
  // Base chassis (dark, tintable to match team colour faintly)
  ctx.fillStyle = state === 'debris' ? '#3a342a' : '#4a3a2a';
  roundedRect(ctx, 1, 2, w - 2, h - 4, 3);
  ctx.fill();
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 1;
  roundedRect(ctx, 1, 2, w - 2, h - 4, 3);
  ctx.stroke();

  // Cracks / jagged breakage
  ctx.strokeStyle = '#222';
  ctx.lineWidth = 0.8;
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    const x = 2 + Math.random() * (w - 4);
    const y = 3 + Math.random() * (h - 6);
    ctx.moveTo(x, y);
    ctx.lineTo(x + (Math.random() - 0.5) * 8, y + (Math.random() - 0.5) * 8);
    ctx.stroke();
  }

  if (state === 'burning') {
    // Bright hot spots
    ctx.fillStyle = '#ff8844';
    ctx.beginPath(); ctx.arc(w / 2, h * 0.4, 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffcc44';
    ctx.beginPath(); ctx.arc(w / 2 - 3, h * 0.6, 2, 0, Math.PI * 2); ctx.fill();
  } else if (state === 'smouldering') {
    ctx.fillStyle = '#ff6622';
    ctx.beginPath(); ctx.arc(w / 2, h * 0.5, 1.5, 0, Math.PI * 2); ctx.fill();
  }
}

const WRECK_STATES: ('burning' | 'smouldering' | 'debris')[] = ['burning', 'smouldering', 'debris'];

// ── Execute ───────────────────────────────────────────────────────────────────
for (const spec of BODIES) {
  writePng(resolve(OUT_BODIES, `${spec.id}.png`), spec.w, spec.h, (ctx) => spec.draw(ctx, spec.w, spec.h));
  for (const state of WRECK_STATES) {
    writePng(resolve(OUT_WRECKS, `${spec.id}_${state}.png`), spec.w, spec.h, (ctx) => drawWreckage(ctx, spec.w, spec.h, state));
  }
}
for (const spec of WEAPONS) {
  writePng(resolve(OUT_WEAPONS, `${spec.id}.png`), spec.w, spec.h, (ctx) => spec.draw(ctx, spec.w, spec.h));
}

console.log(`Generated ${BODIES.length} bodies, ${WEAPONS.length} weapons, ${BODIES.length * WRECK_STATES.length} wreckage sprites`);
