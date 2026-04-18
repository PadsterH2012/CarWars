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
  const wheelSize = opts?.wheelSize ?? 3;
  // Hull — rounded rect, tintable via neutral fill
  ctx.fillStyle = '#c8c8c8';
  roundedRect(ctx, 1, 2, w - 2, h - 4, 3);
  ctx.fill();
  // Outline for definition
  ctx.strokeStyle = '#2b2b2b';
  ctx.lineWidth = 1;
  roundedRect(ctx, 1, 2, w - 2, h - 4, 3);
  ctx.stroke();
  // Windshield (front)
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
  // Wheels
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, Math.round(h * 0.25), wheelSize, Math.round(h * 0.18));
  ctx.fillRect(w - wheelSize, Math.round(h * 0.25), wheelSize, Math.round(h * 0.18));
  ctx.fillRect(0, Math.round(h * 0.65), wheelSize, Math.round(h * 0.18));
  ctx.fillRect(w - wheelSize, Math.round(h * 0.65), wheelSize, Math.round(h * 0.18));
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
  // Rear axle wheels
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, h - 8, 3, 6);
  ctx.fillRect(w - 3, h - 8, 3, 6);
  // Front wheel
  ctx.fillRect(Math.floor(w / 2) - 1, 1, 2, 4);
}

function truckBody(ctx: SKRSContext2D, w: number, h: number) {
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
  // Wheels (6: front 2, rear 4)
  ctx.fillStyle = '#1a1a1a';
  const wh = 4;
  ctx.fillRect(0, Math.floor(h * 0.12), wh, 5);
  ctx.fillRect(w - wh, Math.floor(h * 0.12), wh, 5);
  ctx.fillRect(0, Math.floor(h * 0.62), wh, 5);
  ctx.fillRect(w - wh, Math.floor(h * 0.62), wh, 5);
  ctx.fillRect(0, Math.floor(h * 0.80), wh, 5);
  ctx.fillRect(w - wh, Math.floor(h * 0.80), wh, 5);
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
  // Rear wheels
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, Math.floor(h * 0.55), 4, 5);
  ctx.fillRect(w - 4, Math.floor(h * 0.55), 4, 5);
  ctx.fillRect(0, Math.floor(h * 0.78), 4, 5);
  ctx.fillRect(w - 4, Math.floor(h * 0.78), 4, 5);
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
  { id: 'pickup',       w: 22, h: 40, draw: (c, w, h) => truckBody(c, w, h) },
  { id: 'van',          w: 24, h: 42, draw: (c, w, h) => truckBody(c, w, h) },
  { id: 'camper',       w: 24, h: 44, draw: (c, w, h) => truckBody(c, w, h) },
  { id: 'truck',        w: 26, h: 52, draw: truckBody },
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
