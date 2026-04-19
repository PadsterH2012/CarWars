// Heraldic emblem templates — each function paints a two-colour design to a
// CanvasRenderingContext2D using the gang's primary and secondary colours. The
// same template ids are validated server-side (see api/gangs.ts VALID_EMBLEMS).
//
// To add a new template: add its id to EMBLEM_IDS, add a drawer to DRAWERS, and
// add it to the server's VALID_EMBLEMS set.

export type EmblemId =
  | 'stripes' | 'cross' | 'chevron' | 'quartered'
  | 'star' | 'skull' | 'circle' | 'tire';

export const EMBLEM_IDS: readonly EmblemId[] = [
  'stripes', 'cross', 'chevron', 'quartered', 'star', 'skull', 'circle', 'tire',
];

// Convert a packed RGB integer (0xRRGGBB) to a CSS colour string.
function rgb(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

type Drawer = (ctx: CanvasRenderingContext2D, w: number, h: number, p: string, s: string) => void;

const drawStripes: Drawer = (ctx, w, h, p, s) => {
  const band = h / 3;
  ctx.fillStyle = p; ctx.fillRect(0, 0, w, band);
  ctx.fillStyle = s; ctx.fillRect(0, band, w, band);
  ctx.fillStyle = p; ctx.fillRect(0, band * 2, w, band);
};

const drawCross: Drawer = (ctx, w, h, p, s) => {
  ctx.fillStyle = p; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = s;
  const bw = w * 0.22;
  ctx.fillRect(w / 2 - bw / 2, 0, bw, h);
  ctx.fillRect(0, h / 2 - bw / 2, w, bw);
};

const drawChevron: Drawer = (ctx, w, h, p, s) => {
  ctx.fillStyle = p; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = s;
  ctx.beginPath();
  ctx.moveTo(0, h);
  ctx.lineTo(w / 2, h * 0.35);
  ctx.lineTo(w, h);
  ctx.lineTo(w, h - h * 0.18);
  ctx.lineTo(w / 2, h * 0.55);
  ctx.lineTo(0, h - h * 0.18);
  ctx.closePath();
  ctx.fill();
};

const drawQuartered: Drawer = (ctx, w, h, p, s) => {
  ctx.fillStyle = p; ctx.fillRect(0, 0, w / 2, h / 2);
  ctx.fillStyle = s; ctx.fillRect(w / 2, 0, w / 2, h / 2);
  ctx.fillStyle = s; ctx.fillRect(0, h / 2, w / 2, h / 2);
  ctx.fillStyle = p; ctx.fillRect(w / 2, h / 2, w / 2, h / 2);
};

const drawStar: Drawer = (ctx, w, h, p, s) => {
  ctx.fillStyle = p; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = s;
  const cx = w / 2, cy = h / 2 + h * 0.02, R = Math.min(w, h) * 0.36, r = R * 0.45;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const ang = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? R : r;
    const x = cx + Math.cos(ang) * rad;
    const y = cy + Math.sin(ang) * rad;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
};

const drawSkull: Drawer = (ctx, w, h, p, s) => {
  ctx.fillStyle = p; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = s;
  const cx = w / 2, cy = h / 2;
  // Cranium
  ctx.beginPath();
  ctx.ellipse(cx, cy - h * 0.05, w * 0.24, h * 0.22, 0, 0, Math.PI * 2);
  ctx.fill();
  // Jaw
  ctx.fillRect(cx - w * 0.11, cy + h * 0.12, w * 0.22, h * 0.08);
  // Eye sockets — punch back to primary
  ctx.fillStyle = p;
  ctx.beginPath(); ctx.ellipse(cx - w * 0.09, cy - h * 0.05, w * 0.06, h * 0.07, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(cx + w * 0.09, cy - h * 0.05, w * 0.06, h * 0.07, 0, 0, Math.PI * 2); ctx.fill();
  // Nose
  ctx.beginPath();
  ctx.moveTo(cx, cy + h * 0.02);
  ctx.lineTo(cx - w * 0.03, cy + h * 0.09);
  ctx.lineTo(cx + w * 0.03, cy + h * 0.09);
  ctx.closePath();
  ctx.fill();
};

const drawCircle: Drawer = (ctx, w, h, p, s) => {
  ctx.fillStyle = p; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = s;
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, Math.min(w, h) * 0.33, 0, Math.PI * 2);
  ctx.fill();
  // Horizontal bar through the circle in primary
  ctx.fillStyle = p;
  ctx.fillRect(0, h / 2 - h * 0.05, w, h * 0.10);
};

const drawTire: Drawer = (ctx, w, h, p, s) => {
  ctx.fillStyle = p; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = s;
  // Tire outer ring
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, Math.min(w, h) * 0.4, 0, Math.PI * 2);
  ctx.fill();
  // Inner rim (back to primary)
  ctx.fillStyle = p;
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, Math.min(w, h) * 0.2, 0, Math.PI * 2);
  ctx.fill();
  // Tread blocks
  ctx.fillStyle = s;
  for (let i = 0; i < 8; i++) {
    const ang = (i * Math.PI * 2) / 8;
    const x = w / 2 + Math.cos(ang) * Math.min(w, h) * 0.3;
    const y = h / 2 + Math.sin(ang) * Math.min(w, h) * 0.3;
    ctx.beginPath();
    ctx.arc(x, y, Math.min(w, h) * 0.05, 0, Math.PI * 2);
    ctx.fill();
  }
};

const DRAWERS: Record<EmblemId, Drawer> = {
  stripes:   drawStripes,
  cross:     drawCross,
  chevron:   drawChevron,
  quartered: drawQuartered,
  star:      drawStar,
  skull:     drawSkull,
  circle:    drawCircle,
  tire:      drawTire,
};

// Paints an emblem to a canvas at (0,0,w,h). Returns the canvas for chaining.
export function paintEmblem(
  canvas: HTMLCanvasElement,
  emblem: EmblemId,
  primaryColour: number,
  secondaryColour: number,
): HTMLCanvasElement {
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const drawer = DRAWERS[emblem] ?? DRAWERS.stripes;
  drawer(ctx, canvas.width, canvas.height, rgb(primaryColour), rgb(secondaryColour));
  // Thin outline so the emblem reads against varied backgrounds
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
  return canvas;
}

// Phaser helper — register the emblem as a texture with the given key so Phaser
// can add it as an Image. Safe to call repeatedly — existing textures are removed first.
export function registerEmblemTexture(
  scene: Phaser.Scene,
  key: string,
  emblem: EmblemId,
  primaryColour: number,
  secondaryColour: number,
  size = 64,
): void {
  if (scene.textures.exists(key)) scene.textures.remove(key);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const drawer = DRAWERS[emblem] ?? DRAWERS.stripes;
  drawer(ctx, size, size, rgb(primaryColour), rgb(secondaryColour));
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, size - 1, size - 1);
  scene.textures.addCanvas(key, canvas);
}
