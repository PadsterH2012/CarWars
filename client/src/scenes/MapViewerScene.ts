import Phaser from 'phaser';
import type { ArenaMap, MapPalette } from '@carwars/shared';
import { bindFullscreenToggle, onLayout } from '../ui/responsive';
import { renderMapFloor, renderMapWalls, renderMapDecorations, renderMapFloorStretch, renderMapFloorTiled, type MapRenderOptions } from '../rendering/mapRenderer';

// Read-only map catalogue viewer. Fetches ArenaMap data by id and renders it
// using the shared mapRenderer pipeline, same as ArenaScene. No vehicles, no
// gameplay — just static display of the arena for reference and tooling.

const PIXELS_PER_INCH = 32;

function paletteBackground(palette?: MapPalette): number {
  switch (palette) {
    case 'industrial': return 0x0a0e14;
    case 'urban':      return 0x0b0810;
    case 'desert':     return 0x140d08;
    case 'wasteland':  return 0x080808;
    default:           return 0x0a0a14;
  }
}

export class MapViewerScene extends Phaser.Scene {
  private token = '';
  private mapId = 'double-drum';
  private map: ArenaMap | null = null;

  // Map-world layers (affected by camera zoom on the main camera)
  private bgGraphics!: Phaser.GameObjects.Graphics;
  private gridGraphics!: Phaser.GameObjects.Graphics;
  private floorGraphics!: Phaser.GameObjects.Graphics;
  private floorImages: Phaser.GameObjects.Image[] = [];
  private floorSprites: Phaser.GameObjects.TileSprite[] = [];
  private floorMode: 'graphics' | 'stretch' | 'tiled' = 'stretch';  // <--- SWITCH HERE
  private floorContainer!: Phaser.GameObjects.Container;
  private decorationGraphics!: Phaser.GameObjects.Graphics;
  private wallGraphics!: Phaser.GameObjects.Graphics;
  private overlayGraphics!: Phaser.GameObjects.Graphics;

  // UI — fixed to screen via a separate camera
  private uiCam!: Phaser.Cameras.Scene2D.Camera;
  private uiObjects: Phaser.GameObjects.GameObject[] = [];

  constructor() { super({ key: 'MapViewerScene' }); }

  preload(): void {
    this.load.image('tile_asphalt', '/assets/tiles/asphalt.jpg');
    this.load.image('tile_concrete', '/assets/tiles/concrete.jpg');
    this.load.image('tile_dirt', '/assets/tiles/dirt.jpg');
    this.load.image('tile_gravel', '/assets/tiles/gravel.jpg');
    this.load.image('tile_sand', '/assets/tiles/sand.jpg');
    this.load.image('tile_scrub_grass', '/assets/tiles/scrub_grass.jpg');
    this.load.image('tile_rust_plate', '/assets/tiles/rust_plate.jpg');
    this.load.image('tile_neon', '/assets/tiles/neon.jpg');
  }

  init(data: { token: string; mapId?: string }): void {
    this.token = data.token;
    this.mapId = data.mapId ?? 'double-drum';
    this.map = null;
    this.uiObjects = [];
  }

  async create(): Promise<void> {
    bindFullscreenToggle(this);

    // World-space layers in draw order (below-to-above).
    this.bgGraphics = this.add.graphics();
    this.gridGraphics = this.add.graphics();
    this.floorGraphics = this.add.graphics();
    this.floorContainer = this.add.container(0, 0);
    this.decorationGraphics = this.add.graphics();
    this.wallGraphics = this.add.graphics();
    this.overlayGraphics = this.add.graphics();

    // UI camera so the back button + side panel don't zoom with the map
    this.uiCam = this.cameras.add(0, 0, this.scale.width, this.scale.height, false, 'ui');
    this.cameras.main.ignore([]);

    await this.fetchMap();
    if (!this.map) return;
    this.paintMap();

    onLayout(this, () => this.paintMap());
  }

  private async fetchMap(): Promise<void> {
    const host = window.location.hostname;
    const res = await fetch(`http://${host}:3001/api/maps/${this.mapId}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      const msg = this.add.text(40, 40, `Failed to load map "${this.mapId}" (${res.status})`, {
        color: '#ff6666', fontSize: '16px', fontFamily: 'monospace',
      });
      this.uiObjects.push(msg);
      return;
    }
    this.map = await res.json();
  }

  private paintMap(): void {
    if (!this.map) return;

    // Clear any previous UI from a resize
    this.uiObjects.forEach(o => o.destroy());
    this.uiObjects = [];

    const viewW = this.scale.width;
    const viewH = this.scale.height;
    const sidePanelW = 280;
    const mapAreaW = Math.max(400, viewW - sidePanelW);
    const mapAreaH = viewH;

    // Map extents in pixels at 1:1 scale. Spawning around (0,0) in world coords.
    const mapPxW = this.map.width * PIXELS_PER_INCH;
    const mapPxH = this.map.height * PIXELS_PER_INCH;

    // Scale-to-fit with 10% padding
    const zoom = Math.min(mapAreaW * 0.9 / mapPxW, mapAreaH * 0.9 / mapPxH);

    // The main camera views the world; (0,0) world → (0,0) pixel. We shift it so
    // the map centre lands in the centre of the map area (left of the side panel).
    this.cameras.main.setZoom(zoom);
    this.cameras.main.centerOn(0, 0);
    this.cameras.main.setPosition(0, 0);
    this.cameras.main.setSize(mapAreaW, mapAreaH);

    // UI camera sits on top, full viewport — only renders the UI objects
    this.uiCam.setPosition(0, 0);
    this.uiCam.setSize(viewW, viewH);
    this.uiCam.setScroll(0, 0);
    this.uiCam.setZoom(1);

    // Background palette fills the whole map area (in world space, rendered at any zoom)
    // Extend well beyond the map itself so at any zoom level the bg still covers
    this.bgGraphics.clear();
    const bgSpan = Math.max(mapPxW, mapPxH) * 4;
    this.bgGraphics.fillStyle(paletteBackground(this.map.palette), 1);
    this.bgGraphics.fillRect(-bgSpan / 2, -bgSpan / 2, bgSpan, bgSpan);

    // Grid — 5-unit lines in faint colour, 10-unit lines slightly stronger
    this.paintGrid(this.map.width, this.map.height);

    // Shared renderer — opts centre at (0, 0) so world coords map 1:1 to pixel coords
    const opts: MapRenderOptions = { centerX: 0, centerY: 0, pixelsPerInch: PIXELS_PER_INCH };
    // Clear previous image-based tiles
    this.floorImages.forEach(img => img.destroy());
    this.floorImages = [];
    this.floorSprites.forEach(spr => spr.destroy());
    this.floorSprites = [];
    this.floorGraphics.clear();

    switch (this.floorMode) {
      case 'stretch':
        this.floorImages = renderMapFloorStretch(this, this.map.floor ?? [], opts, this.floorContainer);
        break;
      case 'tiled':
        this.floorSprites = renderMapFloorTiled(this, this.map.floor ?? [], opts, this.floorContainer);
        break;
      case 'graphics':
      default:
        renderMapFloor(this.floorGraphics, this.map.floor ?? [], opts);
        break;
    }
    renderMapDecorations(this.decorationGraphics, this.map.decorations ?? [], opts);
    renderMapWalls(this.wallGraphics, this.map.walls, opts);

    // Spawn markers (separate overlay so they stack above walls)
    this.paintSpawns();

    // UI — side panel + back button (ignored by main camera, rendered by UI camera)
    this.paintSidePanel(mapAreaW, sidePanelW);
    this.paintBackButton();

    // Route objects to correct cameras
    const worldObjects = [this.bgGraphics, this.gridGraphics, this.floorGraphics, this.floorContainer, this.decorationGraphics, this.wallGraphics, this.overlayGraphics];
    this.uiCam.ignore(worldObjects);
    this.cameras.main.ignore(this.uiObjects);
  }

  private paintGrid(w: number, h: number): void {
    const gfx = this.gridGraphics;
    gfx.clear();
    const halfW = w / 2;
    const halfH = h / 2;
    const toPx = PIXELS_PER_INCH;

    // Minor grid — every 5 units
    gfx.lineStyle(1, 0x222233, 0.5);
    for (let x = -halfW; x <= halfW; x += 5) {
      gfx.beginPath();
      gfx.moveTo(x * toPx, -halfH * toPx);
      gfx.lineTo(x * toPx,  halfH * toPx);
      gfx.strokePath();
    }
    for (let y = -halfH; y <= halfH; y += 5) {
      gfx.beginPath();
      gfx.moveTo(-halfW * toPx, y * toPx);
      gfx.lineTo( halfW * toPx, y * toPx);
      gfx.strokePath();
    }
    // Major grid — every 10 units, slightly brighter
    gfx.lineStyle(1, 0x444455, 0.7);
    for (let x = -halfW; x <= halfW; x += 10) {
      gfx.beginPath();
      gfx.moveTo(x * toPx, -halfH * toPx);
      gfx.lineTo(x * toPx,  halfH * toPx);
      gfx.strokePath();
    }
    for (let y = -halfH; y <= halfH; y += 10) {
      gfx.beginPath();
      gfx.moveTo(-halfW * toPx, y * toPx);
      gfx.lineTo( halfW * toPx, y * toPx);
      gfx.strokePath();
    }
    // Origin cross — thicker, yellow
    gfx.lineStyle(2, 0xffcc00, 0.8);
    gfx.beginPath();
    gfx.moveTo(-10 * toPx, 0);
    gfx.lineTo( 10 * toPx, 0);
    gfx.strokePath();
    gfx.beginPath();
    gfx.moveTo(0, -10 * toPx);
    gfx.lineTo(0,  10 * toPx);
    gfx.strokePath();
  }

  private paintSpawns(): void {
    if (!this.map) return;
    const gfx = this.overlayGraphics;
    gfx.clear();
    const toPx = PIXELS_PER_INCH;
    for (const s of this.map.spawnPoints) {
      const px = s.x * toPx;
      const py = s.y * toPx;
      // Team-coloured disc
      const colour = s.team === 'player' ? 0x44aaff : 0xff5544;
      gfx.fillStyle(colour, 0.85);
      gfx.fillCircle(px, py, 8);
      gfx.lineStyle(2, 0xffffff, 1);
      gfx.strokeCircle(px, py, 8);
      // Facing arrow — 0° = north (so we point along -y after flipping)
      const facingRad = (s.facing - 90) * (Math.PI / 180); // rotate so 0°=north in +y=south world
      const tipX = px + Math.cos(facingRad) * 18;
      const tipY = py + Math.sin(facingRad) * 18;
      gfx.lineStyle(3, 0xffffff, 1);
      gfx.beginPath();
      gfx.moveTo(px, py);
      gfx.lineTo(tipX, tipY);
      gfx.strokePath();
    }
  }

  private paintSidePanel(mapAreaW: number, panelW: number): void {
    if (!this.map) return;
    const panelX = mapAreaW;
    const panelH = this.scale.height;

    const bg = this.add.rectangle(panelX, 0, panelW, panelH, 0x0f0f18, 1).setOrigin(0, 0);
    this.uiObjects.push(bg);

    const pad = 16;
    let y = pad;

    const title = this.add.text(panelX + pad, y, this.mapId.toUpperCase(), {
      color: '#00ff88', fontSize: '22px', fontFamily: 'monospace', fontStyle: 'bold',
    });
    this.uiObjects.push(title);
    y += 36;

    const countByTeam = this.map.spawnPoints.reduce((acc, s) => {
      acc[s.team] = (acc[s.team] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const lines = [
      `Size:        ${this.map.width} × ${this.map.height} units`,
      `Palette:     ${this.map.palette ?? '(default)'}`,
      `Walls:       ${this.map.walls.length}`,
      `Floor tiles: ${this.map.floor?.length ?? 0}`,
      `Decorations: ${this.map.decorations?.length ?? 0}`,
      `Spawns:      ${this.map.spawnPoints.length}`,
      `  player:    ${countByTeam.player ?? 0}`,
      `  ai:        ${countByTeam.ai ?? 0}`,
    ];
    for (const line of lines) {
      const t = this.add.text(panelX + pad, y, line, {
        color: '#cccccc', fontSize: '13px', fontFamily: 'monospace',
      });
      this.uiObjects.push(t);
      y += 18;
    }

    y += 16;
    const legend = this.add.text(panelX + pad, y, 'LEGEND', {
      color: '#888', fontSize: '12px', fontFamily: 'monospace', fontStyle: 'bold',
    });
    this.uiObjects.push(legend);
    y += 22;

    this.paintLegendRow(panelX + pad, y, 0x44aaff, 'Player spawn'); y += 22;
    this.paintLegendRow(panelX + pad, y, 0xff5544, 'AI spawn');     y += 22;
    this.paintLegendRow(panelX + pad, y, 0x222233, 'Wall (default)');      y += 22;
    this.paintLegendRow(panelX + pad, y, 0x3a3a4a, 'Building');            y += 22;
    this.paintLegendRow(panelX + pad, y, 0x8b1a1a, 'Turret');              y += 22;
    this.paintLegendRow(panelX + pad, y, 0xffcc00, 'Origin (0, 0)');       y += 28;

    // Scale ruler: 10 units
    const rulerY = y + 8;
    const zoomedPxPer10 = 10 * PIXELS_PER_INCH * this.cameras.main.zoom;
    const displayWidth = Math.min(panelW - pad * 2, zoomedPxPer10);
    const ruler = this.add.rectangle(panelX + pad, rulerY, displayWidth, 4, 0xaaaaff, 1).setOrigin(0, 0);
    this.uiObjects.push(ruler);
    const rulerLabel = this.add.text(panelX + pad, rulerY + 10, `10 units @ current zoom (${this.cameras.main.zoom.toFixed(2)}×)`, {
      color: '#888', fontSize: '11px', fontFamily: 'monospace',
    });
    this.uiObjects.push(rulerLabel);
  }

  private paintLegendRow(x: number, y: number, colour: number, label: string): void {
    const swatch = this.add.rectangle(x, y + 6, 14, 14, colour, 1).setOrigin(0, 0);
    const text = this.add.text(x + 22, y, label, {
      color: '#cccccc', fontSize: '12px', fontFamily: 'monospace',
    });
    this.uiObjects.push(swatch, text);
  }

  private paintBackButton(): void {
    const btn = this.add.text(16, 16, '[< BACK]', {
      color: '#aaaaff', fontSize: '14px', fontFamily: 'monospace',
      backgroundColor: '#111133', padding: { x: 8, y: 4 },
    }).setInteractive();
    btn.on('pointerdown', () => this.scene.start('GarageScene', { token: this.token }));
    this.uiObjects.push(btn);
  }
}
