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

// Shared 4-wheel drawer + forward/rear markers, used by every car-like silhouette.
// Callers still draw their own hull + windows on top of this base pass.
function drawBaseCar(ctx: SKRSContext2D, w: number, h: number, wheelSize = 4) {
  ctx.fillStyle = '#000000';
  const wheelH = Math.max(4, Math.round(h * 0.18));
  const frontY = Math.round(h * 0.22);
  const rearY  = Math.round(h * 0.66);
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

function drawHeadlightsAndChevron(ctx: SKRSContext2D, w: number) {
  ctx.fillStyle = '#ffffcc';
  ctx.fillRect(3, 3, Math.max(2, Math.floor(w * 0.2)), 2);
  ctx.fillRect(w - 3 - Math.max(2, Math.floor(w * 0.2)), 3, Math.max(2, Math.floor(w * 0.2)), 2);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(w / 2, 3);
  ctx.lineTo(w / 2 + 3, 8);
  ctx.lineTo(w / 2 - 3, 8);
  ctx.closePath();
  ctx.fill();
}

function drawTailLights(ctx: SKRSContext2D, w: number, h: number) {
  ctx.fillStyle = '#aa2222';
  ctx.fillRect(3, h - 5, Math.max(2, Math.floor(w * 0.2)), 2);
  ctx.fillRect(w - 3 - Math.max(2, Math.floor(w * 0.2)), h - 5, Math.max(2, Math.floor(w * 0.2)), 2);
}

// Generic 3-box car (sedan / compact / mid-sized): hood, cabin with two
// windows, short trunk. Wheel size tweakable so subcompacts look narrower.
function carBody(ctx: SKRSContext2D, w: number, h: number, opts?: { windshieldRatio?: number; wheelSize?: number }) {
  const wsRatio = opts?.windshieldRatio ?? 0.35;
  const wheelSize = opts?.wheelSize ?? 4;
  // Hull
  ctx.fillStyle = '#c8c8c8';
  roundedRect(ctx, 2, 2, w - 4, h - 4, 3);
  ctx.fill();
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 1;
  roundedRect(ctx, 2, 2, w - 4, h - 4, 3);
  ctx.stroke();

  drawHeadlightsAndChevron(ctx, w);

  // Hood / cabin / trunk separation lines for more silhouette depth
  ctx.strokeStyle = '#5a5a5a';
  ctx.beginPath();
  ctx.moveTo(3, Math.round(h * 0.3));
  ctx.lineTo(w - 3, Math.round(h * 0.3));
  ctx.moveTo(3, Math.round(h * 0.72));
  ctx.lineTo(w - 3, Math.round(h * 0.72));
  ctx.stroke();

  // Windshield + rear window in subtle blue
  ctx.fillStyle = '#506080';
  const wsH = Math.round(h * wsRatio * 0.35);
  const wsY = Math.round(h * 0.3);
  roundedRect(ctx, 3, wsY, w - 6, wsH, 1);
  ctx.fill();
  ctx.fillStyle = '#3e4a60';
  roundedRect(ctx, 3, Math.round(h * 0.58), w - 6, Math.round(h * 0.12), 1);
  ctx.fill();

  drawTailLights(ctx, w, h);
  drawBaseCar(ctx, w, h, wheelSize);
}

// Luxury coupe: longer hood, smaller fastback cabin, tapered rear — gives
// the sleek Hotshot/Bombardier profile.
function luxuryBody(ctx: SKRSContext2D, w: number, h: number) {
  // Hull with a slight taper at the back
  ctx.fillStyle = '#c8c8c8';
  ctx.beginPath();
  ctx.moveTo(4, 3);
  ctx.lineTo(w - 4, 3);
  ctx.lineTo(w - 3, Math.round(h * 0.85));
  ctx.lineTo(w - 5, h - 3);
  ctx.lineTo(5, h - 3);
  ctx.lineTo(3, Math.round(h * 0.85));
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 1;
  ctx.stroke();

  drawHeadlightsAndChevron(ctx, w);

  // Long hood → small fastback cabin (roof panel + windshield + rear)
  ctx.fillStyle = '#506080';
  roundedRect(ctx, 4, Math.round(h * 0.38), w - 8, Math.round(h * 0.08), 1);
  ctx.fill();
  ctx.fillStyle = '#3a3a3a';
  roundedRect(ctx, 5, Math.round(h * 0.46), w - 10, Math.round(h * 0.18), 2);
  ctx.fill();
  ctx.fillStyle = '#3e4a60';
  roundedRect(ctx, 4, Math.round(h * 0.64), w - 8, Math.round(h * 0.07), 1);
  ctx.fill();

  drawTailLights(ctx, w, h);
  drawBaseCar(ctx, w, h);
}

// Station wagon: flatter roofline, wagon-style rear (no separate trunk),
// longer greenhouse extending all the way back.
function stationWagonBody(ctx: SKRSContext2D, w: number, h: number) {
  ctx.fillStyle = '#c8c8c8';
  roundedRect(ctx, 2, 2, w - 4, h - 4, 2);
  ctx.fill();
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 1;
  roundedRect(ctx, 2, 2, w - 4, h - 4, 2);
  ctx.stroke();

  drawHeadlightsAndChevron(ctx, w);

  // Hood / cabin break
  ctx.strokeStyle = '#5a5a5a';
  ctx.beginPath();
  ctx.moveTo(3, Math.round(h * 0.28));
  ctx.lineTo(w - 3, Math.round(h * 0.28));
  ctx.stroke();
  // Windshield
  ctx.fillStyle = '#506080';
  roundedRect(ctx, 3, Math.round(h * 0.28), w - 6, Math.round(h * 0.1), 1);
  ctx.fill();
  // Extended roof / wagon greenhouse — one long dark-grey panel right to the back
  ctx.fillStyle = '#4a4a4a';
  roundedRect(ctx, 4, Math.round(h * 0.38), w - 8, Math.round(h * 0.48), 1);
  ctx.fill();
  // Thin rear glass strip
  ctx.fillStyle = '#3e4a60';
  roundedRect(ctx, 3, Math.round(h * 0.86), w - 6, Math.round(h * 0.06), 1);
  ctx.fill();
  // Roof rails hint (thin dark lines on the sides)
  ctx.strokeStyle = '#2a2a2a';
  ctx.beginPath();
  ctx.moveTo(5, Math.round(h * 0.4)); ctx.lineTo(5, Math.round(h * 0.82));
  ctx.moveTo(w - 5, Math.round(h * 0.4)); ctx.lineTo(w - 5, Math.round(h * 0.82));
  ctx.stroke();

  drawTailLights(ctx, w, h);
  drawBaseCar(ctx, w, h);
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
  // Front + rear wheel bands
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(1, 1, w - 2, 2);
  ctx.fillRect(1, h - 3, w - 2, 2);
}

// Trike — sporty wedge (Imp / Sportster): pointed nose, flared rear, small
// cockpit dome with windshield, visible fender lines to the rear wheels.
function trikeBody(ctx: SKRSContext2D, w: number, h: number) {
  // Wedge body: narrow front, full width at the back
  ctx.fillStyle = '#c8c8c8';
  ctx.beginPath();
  ctx.moveTo(w / 2, 1);
  ctx.lineTo(w - 3, Math.round(h * 0.35));
  ctx.lineTo(w - 2, h - 3);
  ctx.lineTo(w - 2, h - 1);
  ctx.lineTo(2, h - 1);
  ctx.lineTo(2, h - 3);
  ctx.lineTo(3, Math.round(h * 0.35));
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Front headlight strip + chevron
  ctx.fillStyle = '#ffffcc';
  ctx.fillRect(w / 2 - 2, 3, 4, 1);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(w / 2, 2);
  ctx.lineTo(w / 2 + 2, 6);
  ctx.lineTo(w / 2 - 2, 6);
  ctx.closePath();
  ctx.fill();

  // Cockpit dome + windshield — cockpit is a dark ellipse in the middle
  ctx.fillStyle = '#506080';
  roundedRect(ctx, Math.round(w * 0.28), Math.round(h * 0.32), Math.round(w * 0.44), Math.round(h * 0.16), 2);
  ctx.fill();
  ctx.fillStyle = '#2a2a2a';
  roundedRect(ctx, Math.round(w * 0.28), Math.round(h * 0.48), Math.round(w * 0.44), Math.round(h * 0.22), 2);
  ctx.fill();

  // Rear fender shoulder lines — thin dark lines suggesting wheel housings
  ctx.strokeStyle = '#3a3a3a';
  ctx.beginPath();
  ctx.moveTo(3, Math.round(h * 0.70));
  ctx.lineTo(3, h - 3);
  ctx.moveTo(w - 3, Math.round(h * 0.70));
  ctx.lineTo(w - 3, h - 3);
  ctx.stroke();

  // Tail lights
  ctx.fillStyle = '#aa2222';
  ctx.fillRect(4, h - 4, 4, 2);
  ctx.fillRect(w - 8, h - 4, 4, 2);

  // Wheels — 1 front (centered) + 2 rear (protruding). Bigger than before.
  ctx.fillStyle = '#000000';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 0.5;
  const fw = 4, fh = 7;
  ctx.fillRect(Math.floor(w / 2) - fw / 2, 1, fw, fh);
  ctx.strokeRect(Math.floor(w / 2) - fw / 2, 1, fw, fh);
  const rw = 5, rh = 8;
  ctx.fillRect(-1, h - rh - 1, rw + 1, rh);
  ctx.strokeRect(-1, h - rh - 1, rw + 1, rh);
  ctx.fillRect(w - rw, h - rh - 1, rw + 1, rh);
  ctx.strokeRect(w - rw, h - rh - 1, rw + 1, rh);
}

// Bus — 40' passenger coach (Busnought reference): long boxy hull with
// window bands running down both sides, cab windshield at the front, and
// two roof cupolas matching the front/back turret mounts in the book art.
function busBody(ctx: SKRSContext2D, w: number, h: number) {
  // Hull
  ctx.fillStyle = '#c8c8c8';
  roundedRect(ctx, 2, 2, w - 4, h - 4, 3);
  ctx.fill();
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 1;
  roundedRect(ctx, 2, 2, w - 4, h - 4, 3);
  ctx.stroke();

  drawHeadlightsAndChevron(ctx, w);
  // Cab windshield (runs full width — single big pane)
  ctx.fillStyle = '#506080';
  ctx.fillRect(3, Math.round(h * 0.08), w - 6, Math.round(h * 0.08));

  // Passenger window bands on both sides — repeating rectangles so it reads
  // clearly as a bus from above.
  const winY0 = Math.round(h * 0.20);
  const winY1 = Math.round(h * 0.86);
  const winCount = 8;
  const winH = Math.floor((winY1 - winY0) / winCount) - 1;
  ctx.fillStyle = '#3e4a60';
  for (let i = 0; i < winCount; i++) {
    const y = winY0 + i * (winH + 1);
    ctx.fillRect(3, y, 3, winH);
    ctx.fillRect(w - 6, y, 3, winH);
  }

  // Roof spine + cupola turret rings (front + back)
  ctx.strokeStyle = '#6a6a6a';
  ctx.beginPath();
  ctx.moveTo(w / 2, Math.round(h * 0.18));
  ctx.lineTo(w / 2, Math.round(h * 0.82));
  ctx.stroke();
  const cupolaYs = [h * 0.3, h * 0.7];
  ctx.fillStyle = '#3a3a3a';
  ctx.strokeStyle = '#1a1a1a';
  for (const cy of cupolaYs) {
    ctx.beginPath();
    ctx.arc(w / 2, cy, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#6a6a6a';
    ctx.beginPath();
    ctx.arc(w / 2, cy, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#3a3a3a';
  }

  // Rear door outline (passenger exit)
  ctx.strokeStyle = '#3a3a3a';
  ctx.strokeRect(Math.round(w * 0.34), h - 8, Math.round(w * 0.32), 5);

  drawTailLights(ctx, w, h);
  // Five axles (10 wheels) spread down the length — Busnought has 10 tires
  drawAxles(ctx, w, h, [0.12, 0.32, 0.52, 0.72, 0.88], 5, 6);
}

// Small helper — draws the side wheels at a given set of row fractions, clean
// black fills with a thin white outline so they read on any body tint.
function drawAxles(ctx: SKRSContext2D, w: number, h: number, axleFractions: number[], wheelW = 5, wheelH = 6) {
  ctx.fillStyle = '#000000';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 0.5;
  for (const yFrac of axleFractions) {
    const y = Math.floor(h * yFrac);
    ctx.fillRect(-1, y, wheelW + 1, wheelH);
    ctx.strokeRect(-1, y, wheelW + 1, wheelH);
    ctx.fillRect(w - wheelW, y, wheelW + 1, wheelH);
    ctx.strokeRect(w - wheelW, y, wheelW + 1, wheelH);
  }
}

// Pickup — cab at front, open bed at back. The bed is clearly a different
// shade and has side-walls to make it read as a pickup, not a hatchback.
function pickupBody(ctx: SKRSContext2D, w: number, h: number) {
  // Hull outline
  ctx.fillStyle = '#c8c8c8';
  roundedRect(ctx, 2, 2, w - 4, h - 4, 2);
  ctx.fill();
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 1;
  roundedRect(ctx, 2, 2, w - 4, h - 4, 2);
  ctx.stroke();

  drawHeadlightsAndChevron(ctx, w);
  // Windshield
  ctx.fillStyle = '#506080';
  roundedRect(ctx, 3, Math.round(h * 0.16), w - 6, Math.round(h * 0.1), 1);
  ctx.fill();
  // Cab→bed dividing line
  ctx.strokeStyle = '#3a3a3a';
  ctx.beginPath();
  ctx.moveTo(3, Math.round(h * 0.42));
  ctx.lineTo(w - 3, Math.round(h * 0.42));
  ctx.stroke();
  // Bed (dark/empty, with inner wall outline)
  ctx.fillStyle = '#7a7a7a';
  ctx.fillRect(3, Math.round(h * 0.42), w - 6, Math.round(h * 0.54));
  ctx.strokeStyle = '#3a3a3a';
  ctx.strokeRect(5, Math.round(h * 0.44) + 2, w - 10, Math.round(h * 0.50) - 2);
  // Tailgate hinge line
  ctx.beginPath();
  ctx.moveTo(3, h - 5);
  ctx.lineTo(w - 3, h - 5);
  ctx.stroke();

  drawTailLights(ctx, w, h);
  drawAxles(ctx, w, h, [0.16, 0.76]);
}

// Van — single box silhouette, small cab window at front, cargo area fills
// the rest. Taller/boxier feel from the lack of hood/bed separation.
function vanBody(ctx: SKRSContext2D, w: number, h: number) {
  ctx.fillStyle = '#c8c8c8';
  ctx.fillRect(2, 2, w - 4, h - 4);
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 1;
  ctx.strokeRect(2, 2, w - 4, h - 4);

  drawHeadlightsAndChevron(ctx, w);
  // Cab windshield — single wide pane because there's no hood
  ctx.fillStyle = '#506080';
  ctx.fillRect(3, Math.round(h * 0.1), w - 6, Math.round(h * 0.11));
  // Side panel ridges (hint of cargo body)
  ctx.strokeStyle = '#888';
  for (let i = 1; i < 4; i++) {
    const y = Math.round(h * (0.28 + 0.16 * i));
    ctx.beginPath();
    ctx.moveTo(4, y);
    ctx.lineTo(w - 4, y);
    ctx.stroke();
  }
  // Rear roll-up door outline
  ctx.strokeStyle = '#3a3a3a';
  ctx.strokeRect(4, h - 9, w - 8, 6);

  drawTailLights(ctx, w, h);
  drawAxles(ctx, w, h, [0.15, 0.78]);
}

// Camper — truck cab at front, wider / taller-looking living module at back
// with the characteristic "over-cab" bulge.
function camperBody(ctx: SKRSContext2D, w: number, h: number) {
  // Cab section (front ~30%)
  ctx.fillStyle = '#c8c8c8';
  roundedRect(ctx, 2, 2, w - 4, Math.round(h * 0.28), 2);
  ctx.fill();
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 1;
  roundedRect(ctx, 2, 2, w - 4, Math.round(h * 0.28), 2);
  ctx.stroke();

  // Camper body — bigger box overhanging the cab slightly
  ctx.fillStyle = '#b0b0b0';
  ctx.fillRect(1, Math.round(h * 0.26), w - 2, Math.round(h * 0.7));
  ctx.strokeRect(1, Math.round(h * 0.26), w - 2, Math.round(h * 0.7));

  drawHeadlightsAndChevron(ctx, w);
  // Cab windshield
  ctx.fillStyle = '#506080';
  ctx.fillRect(3, Math.round(h * 0.12), w - 6, Math.round(h * 0.08));

  // Camper side window + roof vent
  ctx.fillStyle = '#3e4a60';
  ctx.fillRect(Math.round(w * 0.35), Math.round(h * 0.38), Math.round(w * 0.3), 3);
  ctx.fillStyle = '#4a4a4a';
  ctx.fillRect(w / 2 - 3, Math.round(h * 0.55), 6, 5);
  // Camper rear door
  ctx.strokeStyle = '#3a3a3a';
  ctx.strokeRect(Math.round(w * 0.38), h - 10, Math.round(w * 0.24), 7);

  drawTailLights(ctx, w, h);
  drawAxles(ctx, w, h, [0.14, 0.80]);
}

// Big-rig truck (tractor): short cab + very long flatbed. Used when
// axleCount=3 (6 wheels) — see call site.
function bigTruckBody(ctx: SKRSContext2D, w: number, h: number) {
  // Cab (front ~22%)
  ctx.fillStyle = '#c8c8c8';
  roundedRect(ctx, 2, 2, w - 4, Math.round(h * 0.22), 2);
  ctx.fill();
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 1;
  roundedRect(ctx, 2, 2, w - 4, Math.round(h * 0.22), 2);
  ctx.stroke();

  // Flatbed (dark — empty)
  ctx.fillStyle = '#6a6a6a';
  ctx.fillRect(2, Math.round(h * 0.24), w - 4, Math.round(h * 0.72));
  ctx.strokeRect(2, Math.round(h * 0.24), w - 4, Math.round(h * 0.72));
  // Fifth-wheel / kingpin plate just behind cab
  ctx.fillStyle = '#333';
  ctx.beginPath();
  ctx.arc(w / 2, Math.round(h * 0.3), 3, 0, Math.PI * 2);
  ctx.fill();
  // Bed slats (horizontal lines to suggest planking)
  ctx.strokeStyle = '#4a4a4a';
  for (let i = 1; i < 5; i++) {
    const y = Math.round(h * (0.34 + 0.12 * i));
    ctx.beginPath();
    ctx.moveTo(4, y);
    ctx.lineTo(w - 4, y);
    ctx.stroke();
  }

  drawHeadlightsAndChevron(ctx, w);
  // Cab windshield
  ctx.fillStyle = '#506080';
  ctx.fillRect(3, Math.round(h * 0.08), w - 6, Math.round(h * 0.08));

  drawTailLights(ctx, w, h);
  // Front axle + 2 rear axles spaced across the rear half
  drawAxles(ctx, w, h, [0.12, 0.62, 0.82]);
}


// Trailer — long cargo box with visible panel seams, roof-mounted cupola
// turrets (Econoforce reference), and a kingpin diamond at the front. Tandem
// rear axles (4 wheels) drawn via drawAxles.
function trailerBody(ctx: SKRSContext2D, w: number, h: number) {
  ctx.fillStyle = '#b8b8b8';
  ctx.fillRect(2, 1, w - 4, h - 2);
  ctx.strokeStyle = '#2b2b2b';
  ctx.lineWidth = 1;
  ctx.strokeRect(2, 1, w - 4, h - 2);

  // Panel seams — horizontal lines dividing the container into sections
  ctx.strokeStyle = '#888';
  for (let i = 1; i < 6; i++) {
    const y = (h * i) / 6;
    ctx.beginPath();
    ctx.moveTo(3, y);
    ctx.lineTo(w - 3, y);
    ctx.stroke();
  }
  // Central spine (single dark line down the middle — suggests a reinforced frame)
  ctx.strokeStyle = '#6a6a6a';
  ctx.beginPath();
  ctx.moveTo(w / 2, 3);
  ctx.lineTo(w / 2, h - 3);
  ctx.stroke();

  // Kingpin at the front — small diamond outline
  ctx.fillStyle = '#555';
  ctx.beginPath();
  ctx.moveTo(w / 2, 2);
  ctx.lineTo(w / 2 + 2, 5);
  ctx.lineTo(w / 2, 8);
  ctx.lineTo(w / 2 - 2, 5);
  ctx.closePath();
  ctx.fill();

  // Cupola turret rings along the roof — 2 symmetric pairs, evenly spaced.
  // Sit them on the centreline so they read as rotating positions.
  const cupolaYs = [h * 0.30, h * 0.58];
  ctx.fillStyle = '#3a3a3a';
  ctx.strokeStyle = '#1a1a1a';
  for (const cy of cupolaYs) {
    ctx.beginPath();
    ctx.arc(w / 2, cy, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#6a6a6a';
    ctx.beginPath();
    ctx.arc(w / 2, cy, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#3a3a3a';
  }

  // Rear door indication
  ctx.strokeStyle = '#3a3a3a';
  ctx.strokeRect(4, h - 10, w - 8, 7);
  ctx.beginPath();
  ctx.moveTo(w / 2, h - 10);
  ctx.lineTo(w / 2, h - 3);
  ctx.stroke();

  // Tandem rear axles
  drawAxles(ctx, w, h, [0.66, 0.82], 5, 8);
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
  { id: 'station_wagon',w: 22, h: 36, draw: stationWagonBody },
  { id: 'luxury',       w: 24, h: 38, draw: luxuryBody },
  { id: 'pickup',       w: 22, h: 40, draw: pickupBody },
  { id: 'van',          w: 24, h: 42, draw: vanBody },
  { id: 'camper',       w: 24, h: 44, draw: camperBody },
  { id: 'truck',        w: 26, h: 52, draw: bigTruckBody },
  { id: 'trailer',      w: 26, h: 54, draw: trailerBody },
  { id: 'bus',          w: 26, h: 60, draw: busBody },
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
