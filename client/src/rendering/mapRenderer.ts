import type { Rect, FloorTile, FloorType, Decoration } from "@carwars/shared";

// Shared map-rendering primitives. Used by ArenaScene (live gameplay) and
// MapViewerScene (read-only catalogue view) so they stay in visual lockstep.

export interface MapRenderOptions {
  centerX: number; // pixel x at world origin (0, 0)
  centerY: number; // pixel y at world origin (0, 0)
  pixelsPerInch: number; // world units → pixels multiplier
}

// Per-surface fill colour — chosen for high contrast against vehicles and walls.
export const FLOOR_COLORS: Record<FloorType, number> = {
  asphalt: 0x1a1a1e,
  concrete: 0x4a4a52,
  dirt: 0x3a2a1c,
  gravel: 0x2e2e34,
  sand: 0x8e7648,
  scrub_grass: 0x3a4a2a,
  rust_plate: 0x5a3020,
  neon_tile: 0x202838,
};

// Texture key mapping for the 8 tile images in public/assets/tiles/
export const TILE_KEYS: Record<FloorType, string> = {
  asphalt: "tile_asphalt",
  concrete: "tile_concrete",
  dirt: "tile_dirt",
  gravel: "tile_gravel",
  sand: "tile_sand",
  scrub_grass: "tile_scrub_grass",
  rust_plate: "tile_rust_plate",
  neon_tile: "tile_neon",
};

// ─── Option A: Image (stretch) ───────────────────────────────────────────────
// Uses Phaser.Image objects scaled to fit each FloorTile rectangle.
// Fastest to implement. Texture stretches if tile aspect ratio differs from
// the source image (128×128 square). Best for square-ish or small tiles.
//
// Call from scene.create() or where you have floor data:
//   renderMapFloorStretch(this, floor, RENDER_OPTS, this.floorContainer);

export function renderMapFloorStretch(
  scene: Phaser.Scene,
  floor: FloorTile[],
  opts: MapRenderOptions,
  container?: Phaser.GameObjects.Container
): Phaser.GameObjects.Image[] {
  const { centerX, centerY, pixelsPerInch: PI } = opts;
  const images: Phaser.GameObjects.Image[] = [];

  for (const tile of floor) {
    const px = centerX + tile.x * PI;
    const py = centerY + tile.y * PI;
    const pw = tile.w * PI;
    const ph = tile.h * PI;
    const key = TILE_KEYS[tile.type] ?? "tile_asphalt";

    if (!scene.textures.exists(key)) continue; // fallback handled by caller

    const img = scene.add.image(px, py, key);
    img.setDisplaySize(pw, ph);
    img.setDepth(0.3);
    img.setOrigin(0.5, 0.5);
    if (container) container.add(img);
    images.push(img);
  }
  return images;
}

// ─── Option B: TileSprite (repeat / tile) ────────────────────────────────────
// Uses Phaser.TileSprite which repeats the texture across the rectangle.
// Looks best when tiles are significantly larger than the texture, because the
// pattern repeats rather than stretching. For tiles smaller than the texture,
// the texture gets scaled down (tileScale < 1) and still repeats, which can
// look busy on very small tiles.
//
// Call from scene.create() or where you have floor data:
//   renderMapFloorTiled(this, floor, RENDER_OPTS, this.floorContainer);

export function renderMapFloorTiled(
  scene: Phaser.Scene,
  floor: FloorTile[],
  opts: MapRenderOptions,
  container?: Phaser.GameObjects.Container
): Phaser.GameObjects.TileSprite[] {
  const { centerX, centerY, pixelsPerInch: PI } = opts;
  const sprites: Phaser.GameObjects.TileSprite[] = [];

  for (const tile of floor) {
    const px = centerX + tile.x * PI;
    const py = centerY + tile.y * PI;
    const pw = tile.w * PI;
    const ph = tile.h * PI;
    const key = TILE_KEYS[tile.type] ?? "tile_asphalt";

    if (!scene.textures.exists(key)) continue;

    const ts = scene.add.tileSprite(px, py, pw, ph, key);
    ts.setDepth(0.3);
    ts.setOrigin(0.5, 0.5);
    // TileSprite tiles from centre by default — these are already centred coords
    if (container) container.add(ts);
    sprites.push(ts);
  }
  return sprites;
}

// ─── Legacy Graphics renderer (fallback / no images) ─────────────────────────
// Kept for backward compatibility and for scenes that don’t preload tile images.

type Gfx = Phaser.GameObjects.Graphics;

export function renderMapFloor(gfx: Gfx, floor: FloorTile[], opts: MapRenderOptions): void {
  gfx.clear();
  const { centerX, centerY, pixelsPerInch: PI } = opts;
  for (const tile of floor) {
    const px = centerX + tile.x * PI - (tile.w * PI) / 2;
    const py = centerY + tile.y * PI - (tile.h * PI) / 2;
    const pw = tile.w * PI;
    const ph = tile.h * PI;
    gfx.fillStyle(FLOOR_COLORS[tile.type] ?? 0x1a1a1e, 1);
    gfx.fillRect(px, py, pw, ph);
    if (tile.type === "neon_tile") {
      gfx.lineStyle(1, 0x44aaff, 0.35);
      gfx.strokeRect(px + 2, py + 2, pw - 4, ph - 4);
    }
  }
}

export function renderMapWalls(gfx: Gfx, walls: Rect[], opts: MapRenderOptions): void {
  gfx.clear();
  const { centerX, centerY, pixelsPerInch: PI } = opts;
  walls.forEach((wall) => {
    const px = centerX + wall.x * PI;
    const py = centerY + wall.y * PI;
    const pw = wall.w * PI;
    const ph = wall.h * PI;

    if (wall.type === "turret") {
      gfx.fillStyle(0x8b1a1a, 1);
      gfx.lineStyle(1, 0xff3333, 1);
    } else if (wall.type === "building") {
      gfx.fillStyle(0x3a3a4a, 1);
      gfx.lineStyle(1, 0x555566, 1);
    } else {
      gfx.fillStyle(0x222233, 1);
      gfx.lineStyle(1, 0x333344, 1);
    }

    gfx.fillRect(px - pw / 2, py - ph / 2, pw, ph);
    gfx.strokeRect(px - pw / 2, py - ph / 2, pw, ph);
  });
}

export function renderMapDecorations(gfx: Gfx, decorations: Decoration[], opts: MapRenderOptions): void {
  gfx.clear();
  const { centerX, centerY, pixelsPerInch: PI } = opts;
  for (const d of decorations) {
    const px = centerX + d.x * PI;
    const py = centerY + d.y * PI;
    const w = (d.w ?? 1) * PI;
    const h = (d.h ?? 1) * PI;
    const facing = d.facing ?? 0;
    const rad = (facing * Math.PI) / 180;
    switch (d.type) {
      case "lane_yellow": {
        gfx.fillStyle(0xffcc00, 0.95);
        drawDashedStrip(gfx, px, py, w, h, facing, 6, 4);
        break;
      }
      case "lane_white": {
        gfx.fillStyle(0xe8e8e8, 0.95);
        drawStrip(gfx, px, py, w, h, rad);
        break;
      }
      case "parking_stall": {
        gfx.lineStyle(2, 0xdddddd, 0.85);
        gfx.strokeRect(px - w / 2, py - h / 2, w, h);
        break;
      }
      case "oil_stain": {
        gfx.fillStyle(0x050505, 0.85);
        gfx.fillEllipse(px, py, w, h * 0.7);
        gfx.fillStyle(0x1a1410, 0.55);
        gfx.fillEllipse(px + w * 0.12, py - h * 0.08, w * 0.6, h * 0.35);
        break;
      }
      case "crack": {
        gfx.lineStyle(1.5, 0x888888, 0.55);
        const hw = w / 2;
        gfx.beginPath();
        gfx.moveTo(px - hw, py);
        gfx.lineTo(px - hw * 0.3, py - 2);
        gfx.lineTo(px + hw * 0.2, py + 3);
        gfx.lineTo(px + hw, py - 1);
        gfx.strokePath();
        break;
      }
      case "pothole": {
        gfx.fillStyle(0x050505, 1);
        gfx.fillCircle(px, py, w / 2);
        gfx.lineStyle(1, 0x2a2a2a, 0.7);
        gfx.strokeCircle(px, py, w / 2);
        break;
      }
      case "tire_marks": {
        gfx.fillStyle(0x050505, 0.7);
        const offset = h / 3;
        drawStrip(
          gfx,
          px + Math.cos(rad + Math.PI / 2) * offset,
          py + Math.sin(rad + Math.PI / 2) * offset,
          w,
          h / 4,
          rad
        );
        drawStrip(
          gfx,
          px - Math.cos(rad + Math.PI / 2) * offset,
          py - Math.sin(rad + Math.PI / 2) * offset,
          w,
          h / 4,
          rad
        );
        break;
      }
      case "cone": {
        const r = w / 2;
        gfx.fillStyle(0xff7722, 1);
        gfx.fillTriangle(px, py - r, px - r * 0.8, py + r * 0.6, px + r * 0.8, py + r * 0.6);
        gfx.fillStyle(0xffffff, 0.9);
        gfx.fillRect(px - r * 0.7, py + r * 0.1, r * 1.4, 2);
        break;
      }
      case "barrel": {
        const r = w / 2;
        gfx.fillStyle(0xbb2222, 1);
        gfx.fillCircle(px, py, r);
        gfx.lineStyle(1, 0x661111, 1);
        gfx.strokeCircle(px, py, r);
        gfx.lineStyle(1, 0xffaa66, 0.6);
        gfx.strokeCircle(px, py, r * 0.55);
        break;
      }
      case "crate": {
        gfx.fillStyle(0x8b5a2b, 1);
        gfx.fillRect(px - w / 2, py - h / 2, w, h);
        gfx.lineStyle(1, 0x5a3a1b, 1);
        gfx.strokeRect(px - w / 2, py - h / 2, w, h);
        gfx.lineStyle(1, 0x5a3a1b, 0.6);
        gfx.beginPath();
        gfx.moveTo(px - w / 2, py);
        gfx.lineTo(px + w / 2, py);
        gfx.strokePath();
        break;
      }
      case "dumpster": {
        gfx.fillStyle(0x3a5a3a, 1);
        gfx.fillRect(px - w / 2, py - h / 2, w, h);
        gfx.lineStyle(1.5, 0x1a2a1a, 1);
        gfx.strokeRect(px - w / 2, py - h / 2, w, h);
        gfx.lineStyle(1, 0x1a2a1a, 0.7);
        gfx.beginPath();
        gfx.moveTo(px - w / 2, py - h / 6);
        gfx.lineTo(px + w / 2, py - h / 6);
        gfx.strokePath();
        break;
      }
      case "rubble": {
        gfx.fillStyle(0x6a6a70, 1);
        const r = Math.min(w, h) / 2;
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2;
          gfx.fillCircle(px + Math.cos(a) * r * 0.45, py + Math.sin(a) * r * 0.45, r * 0.22);
        }
        break;
      }
      case "sign": {
        const r = w / 2;
        gfx.fillStyle(0xffcc00, 1);
        gfx.fillTriangle(px, py - r, px + r, py, px, py + r);
        gfx.fillTriangle(px, py - r, px - r, py, px, py + r);
        gfx.lineStyle(1.5, 0x4a3a00, 1);
        gfx.beginPath();
        gfx.moveTo(px, py - r);
        gfx.lineTo(px + r, py);
        gfx.lineTo(px, py + r);
        gfx.lineTo(px - r, py);
        gfx.closePath();
        gfx.strokePath();
        break;
      }
      case "arrow": {
        const len = Math.max(w, h);
        const ax = Math.cos(rad - Math.PI / 2);
        const ay = Math.sin(rad - Math.PI / 2);
        const sx = -ay,
          sy = ax;
        const tipX = px + ax * len / 2;
        const tipY = py + ay * len / 2;
        const backX = px - ax * len / 2;
        const backY = py - ay * len / 2;
        gfx.fillStyle(0xffffff, 0.9);
        gfx.fillTriangle(tipX, tipY, backX + sx * len / 3, backY + sy * len / 3, backX - sx * len / 3, backY - sy * len / 3);
        break;
      }
      case "fuel_pump": {
        gfx.fillStyle(0x555560, 1);
        gfx.fillRect(px - w / 2, py - h / 2, w, h);
        gfx.fillStyle(0xcc2222, 1);
        gfx.fillRect(px - w / 2, py - h / 2, w, h * 0.3);
        gfx.lineStyle(1, 0x111118, 1);
        gfx.strokeRect(px - w / 2, py - h / 2, w, h);
        break;
      }
      case "neon_strip": {
        gfx.fillStyle(0x22ccff, 0.9);
        drawStrip(gfx, px, py, w, Math.max(h, 2), rad);
        gfx.fillStyle(0x22ccff, 0.25);
        drawStrip(gfx, px, py, w, Math.max(h * 3, 4), rad);
        break;
      }
      case "blood_splat": {
        gfx.fillStyle(0x5a1a1a, 0.85);
        gfx.fillEllipse(px, py, w, h * 0.75);
        gfx.fillStyle(0x8a2020, 0.7);
        gfx.fillEllipse(px + w * 0.2, py + h * 0.1, w * 0.35, h * 0.25);
        break;
      }
    }
  }
}

// Thin filled strip oriented along rad radians. Phaser Graphics has no native
// rotation for rects so we compute the 4 corners manually.
function drawStrip(gfx: Gfx, cx: number, cy: number, w: number, h: number, rad: number): void {
  const dx = Math.cos(rad) * w / 2;
  const dy = Math.sin(rad) * w / 2;
  const nx = -Math.sin(rad) * h / 2;
  const ny = Math.cos(rad) * h / 2;
  gfx.fillPoints(
    [
      { x: cx - dx - nx, y: cy - dy - ny },
      { x: cx + dx - nx, y: cy + dy - ny },
      { x: cx + dx + nx, y: cy + dy + ny },
      { x: cx - dx + nx, y: cy - dy + ny },
    ],
    true
  );
}

function drawDashedStrip(
  gfx: Gfx,
  cx: number,
  cy: number,
  w: number,
  h: number,
  facing: number,
  dashLen: number,
  gapLen: number
): void {
  const rad = (facing * Math.PI) / 180;
  const total = dashLen + gapLen;
  const stride = Math.floor(w / total);
  const startOffset = -w / 2 + dashLen / 2;
  for (let i = 0; i <= stride; i++) {
    const off = startOffset + i * total;
    const dx = Math.cos(rad) * off;
    const dy = Math.sin(rad) * off;
    drawStrip(gfx, cx + dx, cy + dy, dashLen, h, rad);
  }
}
