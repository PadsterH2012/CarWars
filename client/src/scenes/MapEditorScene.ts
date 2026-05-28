import Phaser from 'phaser';
import type {
  ArenaMap, Rect, FloorTile, FloorType, Decoration, DecorationType,
  SpawnPoint, MapPalette, WallType,
} from '@carwars/shared';
import { bindFullscreenToggle, onLayout } from '../ui/responsive';
import {
  renderMapFloor, renderMapWalls, renderMapDecorations, renderMapFloorStretch, renderMapFloorTiled, type MapRenderOptions,
} from '../rendering/mapRenderer';
import { downloadJson, copyTsSource, varNameFromId } from '../rendering/mapExport';

// Minimum-viable drag-place map editor. Holds a local ArenaMap, lets the user
// place walls / buildings / floor tiles / decorations / spawns via click-drag
// or click, select / move / delete existing objects, and export to JSON or a
// ready-to-paste TypeScript seed for server/src/rules/maps/<id>.ts.
//
// Not on the world's render path — the canvas is panned/zoomed by scaling a
// Phaser.Container that holds all world-space graphics, independent of the
// Phaser camera so the UI camera can remain at 1:1 without interaction.

const PIXELS_PER_INCH = 32;
const GRID_UNIT = 1;

type Tool = 'select' | 'wall' | 'building' | 'floor' | 'decoration' | 'spawn';

type SelectedRef =
  | { layer: 'walls';         index: number }
  | { layer: 'floor';          index: number }
  | { layer: 'decorations';    index: number }
  | { layer: 'spawnPoints';    index: number };

type DragKind = 'place-rect' | 'move-selected' | 'pan' | null;

const FLOOR_TYPES: FloorType[] = [
  'asphalt', 'concrete', 'dirt', 'gravel', 'sand', 'scrub_grass', 'rust_plate', 'neon_tile',
];
const DECORATION_TYPES: DecorationType[] = [
  'lane_yellow', 'lane_white', 'parking_stall', 'oil_stain', 'crack', 'pothole',
  'tire_marks', 'cone', 'barrel', 'crate', 'dumpster', 'rubble', 'sign', 'arrow',
  'fuel_pump', 'neon_strip', 'blood_splat',
];
const PALETTES: MapPalette[] = ['industrial', 'urban', 'desert', 'wasteland'];

function paletteBackground(palette?: MapPalette): number {
  switch (palette) {
    case 'industrial': return 0x0a0e14;
    case 'urban':      return 0x0b0810;
    case 'desert':     return 0x140d08;
    case 'wasteland':  return 0x080808;
    default:           return 0x0a0a14;
  }
}

function snap(v: number): number {
  return Math.round(v / GRID_UNIT) * GRID_UNIT;
}

export class MapEditorScene extends Phaser.Scene {
  private token = '';

  // ─── Editor state ─────────────────────────────────────────────────────
  private map: ArenaMap = this.blankMap();
  private tool: Tool = 'wall';
  private selected: SelectedRef | null = null;
  private snapGrid = true;

  // Placement tool defaults
  private floorType: FloorType = 'concrete';
  private decoType: DecorationType = 'barrel';
  private spawnTeam: 'player' | 'ai' = 'player';
  private spawnFacing = 90;
  private wallType: WallType = 'wall';

  // Camera transform (manual, applied to worldContainer)
  private zoom = 2;
  private panX = 0;
  private panY = 0;
  private showScaleRef = true;

  // Drag state
  private dragKind: DragKind = null;
  private dragStartWorld: { x: number; y: number } | null = null;
  private dragLastScreen: { x: number; y: number } | null = null;
  private spaceKey!: Phaser.Input.Keyboard.Key;

  // World container — everything map-space goes in here so pan/zoom is a
  // single transform
  private world!: Phaser.GameObjects.Container;
  private bgGfx!: Phaser.GameObjects.Graphics;
  private gridGfx!: Phaser.GameObjects.Graphics;
  private floorGfx!: Phaser.GameObjects.Graphics;
  private floorImages: Phaser.GameObjects.Image[] = [];
  private floorSprites: Phaser.GameObjects.TileSprite[] = [];
  private floorMode: 'graphics' | 'stretch' | 'tiled' = 'stretch';  // <--- SWITCH HERE
  private floorContainer!: Phaser.GameObjects.Container;
  private decorationGfx!: Phaser.GameObjects.Graphics;
  private wallGfx!: Phaser.GameObjects.Graphics;
  private spawnGfx!: Phaser.GameObjects.Graphics;
  private selectionGfx!: Phaser.GameObjects.Graphics;
  private previewGfx!: Phaser.GameObjects.Graphics;
  private scaleRefGfx!: Phaser.GameObjects.Graphics;
  private scaleRefLabels: Phaser.GameObjects.Text[] = [];

  // UI — painted at screen coordinates, tracked so we can wipe + repaint on
  // resize or state change
  private uiObjects: Phaser.GameObjects.GameObject[] = [];
  private statusText!: Phaser.GameObjects.Text;

  // Canvas viewport rectangle (excluded margins for toolbar + side panel)
  private canvasRect = { x: 0, y: 0, w: 0, h: 0 };

  constructor() { super({ key: 'MapEditorScene' }); }

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

  init(data: { token?: string; mapId?: string }): void {
    this.token = data.token ?? '';
    if (data.mapId) {
      this.map.id = data.mapId;
    }
    this.selected = null;
    this.tool = 'wall';
    this.zoom = 2;
    this.panX = 0;
    this.panY = 0;
    this.uiObjects = [];
  }

  private blankMap(): ArenaMap {
    return {
      id: 'my-map',
      width: 80,
      height: 50,
      palette: 'urban',
      walls: [],
      spawnPoints: [],
      floor: [],
      decorations: [],
    };
  }

  async create(): Promise<void> {
    bindFullscreenToggle(this);

    // World layers (pan/zoom targets)
    this.bgGfx         = this.add.graphics();
    this.gridGfx       = this.add.graphics();
    this.floorGfx      = this.add.graphics();
    this.floorContainer = this.add.container(0, 0);
    this.decorationGfx = this.add.graphics();
    this.wallGfx       = this.add.graphics();
    this.spawnGfx      = this.add.graphics();
    this.selectionGfx  = this.add.graphics();
    this.previewGfx    = this.add.graphics();
    this.scaleRefGfx   = this.add.graphics();
    this.world = this.add.container(0, 0, [
      this.bgGfx, this.gridGfx, this.floorGfx, this.floorContainer, this.decorationGfx,
      this.wallGfx, this.spawnGfx, this.selectionGfx, this.previewGfx,
      this.scaleRefGfx,
    ]);

    // Keyboard
    this.spaceKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE, false);
    this.bindKeyShortcuts();

    // Input
    this.input.on('pointerdown', this.handlePointerDown, this);
    this.input.on('pointermove', this.handlePointerMove, this);
    this.input.on('pointerup',   this.handlePointerUp,   this);
    this.input.on('wheel', (_p: Phaser.Input.Pointer, _g: unknown, _dx: number, dy: number) => {
      this.zoomAroundCursor(dy);
    });

    onLayout(this, () => this.repaint());
    this.repaint();
    this.fitMap();
  }

  // ─── Coordinate helpers ──────────────────────────────────────────────

  private worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return {
      x: wx * PIXELS_PER_INCH * this.zoom + this.panX,
      y: wy * PIXELS_PER_INCH * this.zoom + this.panY,
    };
  }

  private screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.panX) / (PIXELS_PER_INCH * this.zoom),
      y: (sy - this.panY) / (PIXELS_PER_INCH * this.zoom),
    };
  }

  private centreMap(): void {
    // Centre world origin (0,0) in the canvas viewport
    this.panX = this.canvasRect.x + this.canvasRect.w / 2;
    this.panY = this.canvasRect.y + this.canvasRect.h / 2;
    this.applyTransform();
    this.refreshStatus();
  }

  // Fit the current map to the canvas viewport with ~10% padding, then
  // centre. Called on scene open and whenever the map size changes via a
  // preset or the +/- buttons, so the full map (and the scale reference at
  // its bottom-left corner) is always in view.
  private fitMap(): void {
    const mapPxW = this.map.width  * PIXELS_PER_INCH;
    const mapPxH = this.map.height * PIXELS_PER_INCH;
    const z = Math.min(
      this.canvasRect.w * 0.9 / mapPxW,
      this.canvasRect.h * 0.9 / mapPxH,
    );
    this.zoom = Math.max(0.3, Math.min(8, z));
    this.centreMap();
  }

  private applyTransform(): void {
    this.world.setScale(this.zoom);
    this.world.setPosition(this.panX, this.panY);
  }

  private zoomAroundCursor(deltaY: number): void {
    const p = this.input.activePointer;
    const pre = this.screenToWorld(p.x, p.y);
    const factor = deltaY > 0 ? 0.9 : 1.1;
    this.zoom = Math.max(0.3, Math.min(8, this.zoom * factor));
    // Preserve world point under cursor
    this.panX = p.x - pre.x * PIXELS_PER_INCH * this.zoom;
    this.panY = p.y - pre.y * PIXELS_PER_INCH * this.zoom;
    this.applyTransform();
    this.refreshStatus();
  }

  // ─── Input handling ──────────────────────────────────────────────────

  private pointerInCanvas(p: Phaser.Input.Pointer): boolean {
    return p.x >= this.canvasRect.x && p.x <= this.canvasRect.x + this.canvasRect.w
        && p.y >= this.canvasRect.y && p.y <= this.canvasRect.y + this.canvasRect.h;
  }

  private handlePointerDown(p: Phaser.Input.Pointer): void {
    if (!this.pointerInCanvas(p)) return;
    const wp = this.screenToWorld(p.x, p.y);
    const snapped = this.snapGrid ? { x: snap(wp.x), y: snap(wp.y) } : wp;

    // Pan on middle-mouse or space-held
    if (p.middleButtonDown() || this.spaceKey.isDown) {
      this.dragKind = 'pan';
      this.dragLastScreen = { x: p.x, y: p.y };
      return;
    }

    if (this.tool === 'select') {
      const picked = this.pickObject(wp.x, wp.y);
      this.selected = picked;
      if (picked) {
        this.dragKind = 'move-selected';
        this.dragStartWorld = snapped;
      }
      this.redrawWorld();
      this.refreshStatus();
      return;
    }

    // Place-rect tools — drag a rectangle
    if (this.tool === 'wall' || this.tool === 'building' || this.tool === 'floor') {
      this.dragKind = 'place-rect';
      this.dragStartWorld = snapped;
      return;
    }

    // Point-place tools — commit immediately
    if (this.tool === 'decoration') {
      this.map.decorations!.push({
        x: snapped.x, y: snapped.y,
        type: this.decoType,
      });
      this.redrawWorld();
      return;
    }

    if (this.tool === 'spawn') {
      this.map.spawnPoints.push({
        x: snapped.x, y: snapped.y,
        facing: this.spawnFacing,
        team: this.spawnTeam,
      });
      this.redrawWorld();
      return;
    }
  }

  private handlePointerMove(p: Phaser.Input.Pointer): void {
    this.refreshStatus();

    if (this.dragKind === 'pan' && this.dragLastScreen) {
      this.panX += p.x - this.dragLastScreen.x;
      this.panY += p.y - this.dragLastScreen.y;
      this.dragLastScreen = { x: p.x, y: p.y };
      this.applyTransform();
      return;
    }

    if (this.dragKind === 'place-rect' && this.dragStartWorld) {
      const wp = this.screenToWorld(p.x, p.y);
      const end = this.snapGrid ? { x: snap(wp.x), y: snap(wp.y) } : wp;
      this.drawPreviewRect(this.dragStartWorld, end);
      return;
    }

    if (this.dragKind === 'move-selected' && this.selected && this.dragStartWorld) {
      const wp = this.screenToWorld(p.x, p.y);
      const cur = this.snapGrid ? { x: snap(wp.x), y: snap(wp.y) } : wp;
      const dx = cur.x - this.dragStartWorld.x;
      const dy = cur.y - this.dragStartWorld.y;
      if (dx === 0 && dy === 0) return;
      this.moveSelected(dx, dy);
      this.dragStartWorld = cur;
      this.redrawWorld();
      return;
    }
  }

  private handlePointerUp(p: Phaser.Input.Pointer): void {
    if (this.dragKind === 'place-rect' && this.dragStartWorld) {
      const wp = this.screenToWorld(p.x, p.y);
      const end = this.snapGrid ? { x: snap(wp.x), y: snap(wp.y) } : wp;
      const cx = (this.dragStartWorld.x + end.x) / 2;
      const cy = (this.dragStartWorld.y + end.y) / 2;
      const w = Math.max(GRID_UNIT, Math.abs(end.x - this.dragStartWorld.x));
      const h = Math.max(GRID_UNIT, Math.abs(end.y - this.dragStartWorld.y));

      if (this.tool === 'wall' || this.tool === 'building') {
        const rect: Rect = { x: cx, y: cy, w, h, type: this.tool === 'building' ? 'building' : 'wall' };
        this.map.walls.push(rect);
      } else if (this.tool === 'floor') {
        const tile: FloorTile = { x: cx, y: cy, w, h, type: this.floorType };
        this.map.floor!.push(tile);
      }
      this.previewGfx.clear();
      this.redrawWorld();
    }

    this.dragKind = null;
    this.dragStartWorld = null;
    this.dragLastScreen = null;
  }

  // ─── Pick / move / delete ────────────────────────────────────────────

  private pickObject(wx: number, wy: number): SelectedRef | null {
    // Pick priority: spawns > walls > decorations > floor (top-down hit test)
    for (let i = this.map.spawnPoints.length - 1; i >= 0; i--) {
      const s = this.map.spawnPoints[i];
      if (Math.hypot(wx - s.x, wy - s.y) < 1.2) return { layer: 'spawnPoints', index: i };
    }
    for (let i = this.map.walls.length - 1; i >= 0; i--) {
      const r = this.map.walls[i];
      if (Math.abs(wx - r.x) <= r.w / 2 && Math.abs(wy - r.y) <= r.h / 2) {
        return { layer: 'walls', index: i };
      }
    }
    const decos = this.map.decorations ?? [];
    for (let i = decos.length - 1; i >= 0; i--) {
      const d = decos[i];
      const w = d.w ?? 1, h = d.h ?? 1;
      if (Math.abs(wx - d.x) <= w / 2 && Math.abs(wy - d.y) <= h / 2) {
        return { layer: 'decorations', index: i };
      }
    }
    const floors = this.map.floor ?? [];
    for (let i = floors.length - 1; i >= 0; i--) {
      const f = floors[i];
      if (Math.abs(wx - f.x) <= f.w / 2 && Math.abs(wy - f.y) <= f.h / 2) {
        return { layer: 'floor', index: i };
      }
    }
    return null;
  }

  private moveSelected(dx: number, dy: number): void {
    if (!this.selected) return;
    if (this.selected.layer === 'walls') {
      const r = this.map.walls[this.selected.index];
      r.x += dx; r.y += dy;
    } else if (this.selected.layer === 'floor') {
      const f = this.map.floor![this.selected.index];
      f.x += dx; f.y += dy;
    } else if (this.selected.layer === 'decorations') {
      const d = this.map.decorations![this.selected.index];
      d.x += dx; d.y += dy;
    } else if (this.selected.layer === 'spawnPoints') {
      const s = this.map.spawnPoints[this.selected.index];
      s.x += dx; s.y += dy;
    }
  }

  private deleteSelected(): void {
    if (!this.selected) return;
    const { layer, index } = this.selected;
    if (layer === 'walls')            this.map.walls.splice(index, 1);
    else if (layer === 'floor')        this.map.floor!.splice(index, 1);
    else if (layer === 'decorations')  this.map.decorations!.splice(index, 1);
    else if (layer === 'spawnPoints')  this.map.spawnPoints.splice(index, 1);
    this.selected = null;
    this.redrawWorld();
    this.refreshStatus();
  }

  // ─── Keyboard shortcuts ──────────────────────────────────────────────

  private bindKeyShortcuts(): void {
    const K = Phaser.Input.Keyboard.KeyCodes;
    const bind = (code: number, fn: () => void) => {
      this.input.keyboard!.addKey(code, false).on('down', fn);
    };
    bind(K.V, () => this.setTool('select'));
    bind(K.W, () => this.setTool('wall'));
    bind(K.B, () => this.setTool('building'));
    bind(K.F, () => this.setTool('floor'));
    bind(K.D, () => this.setTool('decoration'));
    bind(K.S, () => this.setTool('spawn'));
    bind(K.ESC, () => { this.selected = null; this.redrawWorld(); this.refreshStatus(); });
    bind(K.DELETE, () => this.deleteSelected());
    bind(K.BACKSPACE, () => this.deleteSelected());
    bind(K.G, () => { this.snapGrid = !this.snapGrid; this.refreshStatus(); });
    bind(K.R, () => { this.showScaleRef = !this.showScaleRef; this.redrawWorld(); });
    bind(K.ZERO, () => { this.fitMap(); this.redrawWorld(); });
  }

  private setTool(t: Tool): void {
    this.tool = t;
    this.selected = null;
    this.redrawToolPalette();
    this.refreshStatus();
    this.redrawWorld();
  }

  // ─── Rendering ───────────────────────────────────────────────────────

  private repaint(): void {
    // Recompute canvas + UI layout on every resize
    const viewW = this.scale.width;
    const viewH = this.scale.height;
    const toolbarW = 80;
    const sidePanelW = 220;
    const topBarH = 40;
    const statusH = 28;
    this.canvasRect = {
      x: toolbarW,
      y: topBarH,
      w: viewW - toolbarW - sidePanelW,
      h: viewH - topBarH - statusH,
    };

    // Rebuild UI
    this.uiObjects.forEach(o => o.destroy());
    this.uiObjects = [];
    this.paintTopBar(viewW);
    this.paintToolbar(toolbarW, topBarH, this.canvasRect.h);
    this.paintSidePanel(viewW - sidePanelW, topBarH, sidePanelW, this.canvasRect.h);
    this.paintStatusBar(viewW, viewH);
    this.redrawWorld();
  }

  private redrawWorld(): void {
    const opts: MapRenderOptions = { centerX: 0, centerY: 0, pixelsPerInch: PIXELS_PER_INCH };

    // Background — covers the map area plus a margin at any reasonable zoom
    this.bgGfx.clear();
    const bgSpan = Math.max(this.map.width, this.map.height) * 4 * PIXELS_PER_INCH;
    this.bgGfx.fillStyle(paletteBackground(this.map.palette), 1);
    this.bgGfx.fillRect(-bgSpan / 2, -bgSpan / 2, bgSpan, bgSpan);

    this.drawGrid();
    // Clear previous image-based tiles
    this.floorImages.forEach(img => img.destroy());
    this.floorImages = [];
    this.floorSprites.forEach(spr => spr.destroy());
    this.floorSprites = [];
    this.floorGfx.clear();

    switch (this.floorMode) {
      case 'stretch':
        this.floorImages = renderMapFloorStretch(this, this.map.floor ?? [], opts, this.floorContainer);
        break;
      case 'tiled':
        this.floorSprites = renderMapFloorTiled(this, this.map.floor ?? [], opts, this.floorContainer);
        break;
      case 'graphics':
      default:
        renderMapFloor(this.floorGfx, this.map.floor ?? [], opts);
        break;
    }
    renderMapDecorations(this.decorationGfx, this.map.decorations ?? [], opts);
    renderMapWalls(this.wallGfx, this.map.walls, opts);
    this.drawSpawnMarkers();
    this.drawSelection();
    this.drawScaleReference();
  }

  // Car Wars vehicle footprints (world units). Gives a constant visual anchor
  // for "how big is this wall relative to a car". Cycle / car / truck, painted
  // inside the bottom-left corner of the map extent, each labelled.
  private drawScaleReference(): void {
    const gfx = this.scaleRefGfx;
    gfx.clear();
    this.scaleRefLabels.forEach(t => t.destroy());
    this.scaleRefLabels = [];
    if (!this.showScaleRef) return;

    const pi = PIXELS_PER_INCH;
    const halfW = this.map.width / 2;
    const halfH = this.map.height / 2;
    const anchorX = -halfW + 2;           // 2 units inside the left edge
    const anchorY =  halfH - 6;            // 6 units up from the bottom

    // Header card — translucent dark panel behind the silhouettes
    const cardW = 14, cardH = 5.5;
    gfx.fillStyle(0x000000, 0.55);
    gfx.fillRect(anchorX * pi - 0.5 * pi, anchorY * pi - 0.5 * pi, cardW * pi, cardH * pi);
    gfx.lineStyle(1, 0x44aaff, 0.8);
    gfx.strokeRect(anchorX * pi - 0.5 * pi, anchorY * pi - 0.5 * pi, cardW * pi, cardH * pi);

    const header = this.add.text(anchorX * pi, (anchorY - 0.4) * pi, 'SCALE (world units)', {
      color: '#88aaff', fontSize: '11px', fontFamily: 'monospace', fontStyle: 'bold',
    });
    this.world.add(header);
    this.scaleRefLabels.push(header);

    const silhouettes: { w: number; h: number; colour: number; label: string }[] = [
      { w: 0.75, h: 0.3, colour: 0x88ff88, label: 'CYCLE 0.75 × 0.3' },
      { w: 1.0,  h: 0.5, colour: 0x88aaff, label: 'CAR   1.0  × 0.5' },
      { w: 3.0,  h: 1.0, colour: 0xffaa44, label: 'TRUCK 3.0  × 1.0' },
    ];

    let y = anchorY + 0.8;
    for (const s of silhouettes) {
      // Draw vehicle rect + small wheel markers so it reads as a vehicle
      gfx.fillStyle(s.colour, 0.85);
      gfx.fillRect(anchorX * pi, y * pi, s.w * pi, s.h * pi);
      gfx.lineStyle(1, 0xffffff, 0.7);
      gfx.strokeRect(anchorX * pi, y * pi, s.w * pi, s.h * pi);
      // Two wheel dots to hint "vehicle, not generic block"
      gfx.fillStyle(0x222222, 1);
      const wheelR = Math.min(s.w, s.h) * 0.15 * pi;
      gfx.fillCircle((anchorX + s.w * 0.15) * pi, (y + s.h / 2) * pi, wheelR);
      gfx.fillCircle((anchorX + s.w * 0.85) * pi, (y + s.h / 2) * pi, wheelR);
      // Label to the right of each silhouette
      const label = this.add.text((anchorX + s.w + 0.5) * pi, y * pi - 2, s.label, {
        color: '#cccccc', fontSize: '10px', fontFamily: 'monospace',
      });
      this.world.add(label);
      this.scaleRefLabels.push(label);
      y += 1.5;
    }
  }

  private drawGrid(): void {
    const gfx = this.gridGfx;
    gfx.clear();
    const halfW = this.map.width / 2;
    const halfH = this.map.height / 2;
    const pi = PIXELS_PER_INCH;

    gfx.lineStyle(1, 0x222233, 0.5);
    for (let x = -halfW; x <= halfW; x += 5) {
      gfx.beginPath();
      gfx.moveTo(x * pi, -halfH * pi);
      gfx.lineTo(x * pi,  halfH * pi);
      gfx.strokePath();
    }
    for (let y = -halfH; y <= halfH; y += 5) {
      gfx.beginPath();
      gfx.moveTo(-halfW * pi, y * pi);
      gfx.lineTo( halfW * pi, y * pi);
      gfx.strokePath();
    }
    gfx.lineStyle(1, 0x444455, 0.7);
    for (let x = -halfW; x <= halfW; x += 10) {
      gfx.beginPath();
      gfx.moveTo(x * pi, -halfH * pi);
      gfx.lineTo(x * pi,  halfH * pi);
      gfx.strokePath();
    }
    for (let y = -halfH; y <= halfH; y += 10) {
      gfx.beginPath();
      gfx.moveTo(-halfW * pi, y * pi);
      gfx.lineTo( halfW * pi, y * pi);
      gfx.strokePath();
    }
    // Map-extent border — dashed cyan so you can see the map edges
    gfx.lineStyle(2, 0x22ccff, 0.7);
    gfx.strokeRect(-halfW * pi, -halfH * pi, halfW * 2 * pi, halfH * 2 * pi);
    // Origin cross
    gfx.lineStyle(2, 0xffcc00, 0.8);
    gfx.beginPath(); gfx.moveTo(-5 * pi, 0); gfx.lineTo( 5 * pi, 0); gfx.strokePath();
    gfx.beginPath(); gfx.moveTo(0, -5 * pi); gfx.lineTo(0,  5 * pi); gfx.strokePath();
  }

  private drawSpawnMarkers(): void {
    const gfx = this.spawnGfx;
    gfx.clear();
    const pi = PIXELS_PER_INCH;
    for (const s of this.map.spawnPoints) {
      const px = s.x * pi;
      const py = s.y * pi;
      const colour = s.team === 'player' ? 0x44aaff : 0xff5544;
      gfx.fillStyle(colour, 0.85);
      gfx.fillCircle(px, py, 8);
      gfx.lineStyle(2, 0xffffff, 1);
      gfx.strokeCircle(px, py, 8);
      const facingRad = (s.facing - 90) * (Math.PI / 180);
      gfx.lineStyle(3, 0xffffff, 1);
      gfx.beginPath();
      gfx.moveTo(px, py);
      gfx.lineTo(px + Math.cos(facingRad) * 18, py + Math.sin(facingRad) * 18);
      gfx.strokePath();
    }
  }

  private drawSelection(): void {
    const gfx = this.selectionGfx;
    gfx.clear();
    if (!this.selected) return;
    const pi = PIXELS_PER_INCH;
    gfx.lineStyle(3, 0xffff00, 1);
    if (this.selected.layer === 'walls') {
      const r = this.map.walls[this.selected.index];
      gfx.strokeRect((r.x - r.w / 2) * pi, (r.y - r.h / 2) * pi, r.w * pi, r.h * pi);
    } else if (this.selected.layer === 'floor') {
      const f = this.map.floor![this.selected.index];
      gfx.strokeRect((f.x - f.w / 2) * pi, (f.y - f.h / 2) * pi, f.w * pi, f.h * pi);
    } else if (this.selected.layer === 'decorations') {
      const d = this.map.decorations![this.selected.index];
      const w = d.w ?? 1, h = d.h ?? 1;
      gfx.strokeRect((d.x - w / 2) * pi, (d.y - h / 2) * pi, w * pi, h * pi);
    } else if (this.selected.layer === 'spawnPoints') {
      const s = this.map.spawnPoints[this.selected.index];
      gfx.strokeCircle(s.x * pi, s.y * pi, 12);
    }
  }

  private drawPreviewRect(a: { x: number; y: number }, b: { x: number; y: number }): void {
    const gfx = this.previewGfx;
    gfx.clear();
    const pi = PIXELS_PER_INCH;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    const colour = this.tool === 'floor' ? 0x88aaff : 0xff88aa;
    gfx.fillStyle(colour, 0.25);
    gfx.fillRect(x * pi, y * pi, w * pi, h * pi);
    gfx.lineStyle(2, colour, 1);
    gfx.strokeRect(x * pi, y * pi, w * pi, h * pi);
  }

  // ─── UI paint ────────────────────────────────────────────────────────

  private paintTopBar(viewW: number): void {
    const bg = this.add.rectangle(0, 0, viewW, 40, 0x0f0f18, 1).setOrigin(0, 0);
    this.uiObjects.push(bg);
    const title = this.add.text(16, 10, `MAP EDITOR — ${this.map.id.toUpperCase()}`, {
      color: '#00ff88', fontSize: '16px', fontFamily: 'monospace', fontStyle: 'bold',
    });
    this.uiObjects.push(title);

    const back = this.add.text(viewW - 720, 8, '[< BACK]', {
      color: '#aaaaff', fontSize: '13px', fontFamily: 'monospace',
      backgroundColor: '#111133', padding: { x: 8, y: 4 },
    }).setInteractive();
    back.on('pointerdown', () => this.scene.start('GarageScene', { token: this.token }));
    this.uiObjects.push(back);

    const newBtn = this.add.text(viewW - 620, 8, '[NEW]', {
      color: '#cccccc', fontSize: '13px', fontFamily: 'monospace',
      backgroundColor: '#333344', padding: { x: 8, y: 4 },
    }).setInteractive();
    newBtn.on('pointerdown', () => {
      this.map = this.blankMap();
      this.selected = null;
      this.repaint();
      this.fitMap();
    });
    this.uiObjects.push(newBtn);

    const exportBtn = this.add.text(viewW - 530, 8, '[EXPORT JSON]', {
      color: '#88ffaa', fontSize: '13px', fontFamily: 'monospace',
      backgroundColor: '#113322', padding: { x: 8, y: 4 },
    }).setInteractive();
    exportBtn.on('pointerdown', () => {
      downloadJson(this.map, `${this.map.id}.json`);
    });
    this.uiObjects.push(exportBtn);

    const copyBtn = this.add.text(viewW - 380, 8, '[COPY TS]', {
      color: '#ffcc88', fontSize: '13px', fontFamily: 'monospace',
      backgroundColor: '#332211', padding: { x: 8, y: 4 },
    }).setInteractive();
    copyBtn.on('pointerdown', async () => {
      const ok = await copyTsSource(this.map, varNameFromId(this.map.id) + 'Map');
      this.flashStatus(ok ? 'TS source copied to clipboard' : 'Copy failed');
    });
    this.uiObjects.push(copyBtn);
  }

  private toolPaletteButtons: { tool: Tool; bg: Phaser.GameObjects.Rectangle; label: Phaser.GameObjects.Text }[] = [];

  private paintToolbar(w: number, topY: number, h: number): void {
    const bg = this.add.rectangle(0, topY, w, h, 0x0f0f18, 1).setOrigin(0, 0);
    this.uiObjects.push(bg);

    const tools: { id: Tool; label: string; key: string }[] = [
      { id: 'select',     label: 'SEL', key: 'V' },
      { id: 'wall',       label: 'WLL', key: 'W' },
      { id: 'building',   label: 'BLD', key: 'B' },
      { id: 'floor',      label: 'FLR', key: 'F' },
      { id: 'decoration', label: 'DEC', key: 'D' },
      { id: 'spawn',      label: 'SPN', key: 'S' },
    ];

    this.toolPaletteButtons = [];
    tools.forEach((t, i) => {
      const y = topY + 10 + i * 60;
      const btnBg = this.add.rectangle(8, y, w - 16, 50, 0x222233, 1).setOrigin(0, 0).setInteractive();
      const label = this.add.text(w / 2, y + 10, t.label, {
        color: '#cccccc', fontSize: '15px', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5, 0);
      const key = this.add.text(w / 2, y + 32, `[${t.key}]`, {
        color: '#666', fontSize: '10px', fontFamily: 'monospace',
      }).setOrigin(0.5, 0);
      btnBg.on('pointerdown', () => this.setTool(t.id));
      this.uiObjects.push(btnBg, label, key);
      this.toolPaletteButtons.push({ tool: t.id, bg: btnBg, label });
    });
    this.redrawToolPalette();
  }

  private redrawToolPalette(): void {
    for (const b of this.toolPaletteButtons) {
      const active = b.tool === this.tool;
      b.bg.setFillStyle(active ? 0x003322 : 0x222233);
      b.label.setColor(active ? '#00ff88' : '#cccccc');
    }
  }

  private paintSidePanel(x: number, topY: number, w: number, h: number): void {
    const bg = this.add.rectangle(x, topY, w, h, 0x0f0f18, 1).setOrigin(0, 0);
    this.uiObjects.push(bg);

    const pad = 12;
    let y = topY + pad;
    const heading = (txt: string) => {
      const t = this.add.text(x + pad, y, txt, {
        color: '#888', fontSize: '11px', fontFamily: 'monospace', fontStyle: 'bold',
      });
      this.uiObjects.push(t);
      y += 18;
    };
    const kvLine = (label: string, value: string) => {
      const l = this.add.text(x + pad, y, `${label}: ${value}`, {
        color: '#cccccc', fontSize: '12px', fontFamily: 'monospace',
      });
      this.uiObjects.push(l);
      y += 18;
    };
    const cycleBtn = (label: string, onClick: () => void) => {
      const b = this.add.text(x + pad, y, label, {
        color: '#aaccff', fontSize: '12px', fontFamily: 'monospace',
        backgroundColor: '#112233', padding: { x: 6, y: 2 },
      }).setInteractive();
      b.on('pointerdown', onClick);
      this.uiObjects.push(b);
      y += 24;
    };

    heading('MAP');
    kvLine('ID', this.map.id);
    cycleBtn(`palette: ${this.map.palette ?? '(default)'} — click to cycle`, () => {
      const i = PALETTES.indexOf(this.map.palette as MapPalette);
      this.map.palette = PALETTES[(i + 1) % PALETTES.length];
      this.redrawWorld();
      this.repaint();
    });
    kvLine('size', `${this.map.width} × ${this.map.height}`);
    cycleBtn('+5 width', () => { this.map.width += 5; this.redrawWorld(); this.repaint(); this.fitMap(); });
    cycleBtn('-5 width', () => { this.map.width = Math.max(10, this.map.width - 5); this.redrawWorld(); this.repaint(); this.fitMap(); });
    cycleBtn('+5 height', () => { this.map.height += 5; this.redrawWorld(); this.repaint(); this.fitMap(); });
    cycleBtn('-5 height', () => { this.map.height = Math.max(10, this.map.height - 5); this.redrawWorld(); this.repaint(); this.fitMap(); });

    y += 10;
    heading('TOOL DEFAULTS');
    cycleBtn(`floor: ${this.floorType}`, () => {
      const i = FLOOR_TYPES.indexOf(this.floorType);
      this.floorType = FLOOR_TYPES[(i + 1) % FLOOR_TYPES.length];
      this.repaint();
    });
    cycleBtn(`deco: ${this.decoType}`, () => {
      const i = DECORATION_TYPES.indexOf(this.decoType);
      this.decoType = DECORATION_TYPES[(i + 1) % DECORATION_TYPES.length];
      this.repaint();
    });
    cycleBtn(`spawn team: ${this.spawnTeam}`, () => {
      this.spawnTeam = this.spawnTeam === 'player' ? 'ai' : 'player';
      this.repaint();
    });
    cycleBtn(`spawn facing: ${this.spawnFacing}°`, () => {
      this.spawnFacing = (this.spawnFacing + 45) % 360;
      this.repaint();
    });

    y += 10;
    heading('COUNTS');
    kvLine('walls', String(this.map.walls.length));
    kvLine('floor', String(this.map.floor?.length ?? 0));
    kvLine('decos', String(this.map.decorations?.length ?? 0));
    kvLine('spawns', String(this.map.spawnPoints.length));

    y += 10;
    heading('HINTS');
    const hints = [
      '[V]   select',
      '[W]   wall',
      '[B]   building',
      '[F]   floor',
      '[D]   decoration',
      '[S]   spawn',
      '[Del] delete',
      '[Esc] deselect',
      '[G]   toggle snap',
      '[R]   toggle scale ref',
      '[0]   reset zoom',
      'wheel zoom',
      'space+drag pan',
    ];
    for (const h of hints) {
      const t = this.add.text(x + pad, y, h, {
        color: '#666', fontSize: '11px', fontFamily: 'monospace',
      });
      this.uiObjects.push(t);
      y += 14;
    }
  }

  private paintStatusBar(viewW: number, viewH: number): void {
    const bg = this.add.rectangle(0, viewH - 28, viewW, 28, 0x0f0f18, 1).setOrigin(0, 0);
    this.uiObjects.push(bg);
    this.statusText = this.add.text(12, viewH - 21, '', {
      color: '#cccccc', fontSize: '12px', fontFamily: 'monospace',
    });
    this.uiObjects.push(this.statusText);
    this.refreshStatus();
  }

  private refreshStatus(): void {
    if (!this.statusText) return;
    const p = this.input.activePointer;
    const wp = this.screenToWorld(p.x, p.y);
    const sel = this.selected
      ? ` | sel: ${this.selected.layer}[${this.selected.index}]`
      : '';
    this.statusText.setText(
      `tool: ${this.tool}  |  snap: ${this.snapGrid ? 'on' : 'off'}  |  zoom: ${this.zoom.toFixed(2)}×  |  cursor: (${wp.x.toFixed(1)}, ${wp.y.toFixed(1)})${sel}`
    );
  }

  private flashStatus(msg: string): void {
    if (!this.statusText) return;
    const prev = this.statusText.text;
    this.statusText.setText(msg).setColor('#88ff88');
    this.time.delayedCall(1500, () => {
      this.statusText?.setColor('#cccccc');
      this.refreshStatus();
      void prev;
    });
  }
}
