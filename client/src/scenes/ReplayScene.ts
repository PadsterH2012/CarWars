import Phaser from 'phaser';
import { bindFullscreenToggle, onLayout } from '../ui/responsive';
import arenaMapData from '../tilemaps/arena-1.json';
import { renderMapFloor, renderMapWalls, renderMapDecorations, type MapRenderOptions } from '../rendering/mapRenderer';
import { buildVehicleSprite, updateVehicleSprite, preloadVehicleSprites } from '../game/VehicleSprite';
import type { ArenaMap, CombatEvent, WreckageState, VehicleState } from '@carwars/shared';

const PIXELS_PER_INCH = 32;
const WORLD_CENTER_X = 640;
const WORLD_CENTER_Y = 360;
const RENDER_OPTS: MapRenderOptions = { centerX: WORLD_CENTER_X, centerY: WORLD_CENTER_Y, pixelsPerInch: PIXELS_PER_INCH };

export interface ReplaySceneData {
  token: string;
  replayId: string;
  returnTo?: string;
}

interface TickSnapshot {
  tick: number;
  vehicles: {
    id: string; x: number; y: number; facing: number; speed: number; playerId: string;
    stats?: import('@carwars/shared').VehicleStats;
  }[];
  combatEvents: CombatEvent[];
  wreckage: { id: string; x: number; y: number; facing: number; state: WreckageState; sourceVehicleId: string }[];
  winnerId: string | null;
  roster?: import('@carwars/shared').VehicleState[];
}

interface ReplayPayload {
  id: string;
  zone_id: string;
  opponent: string | null;
  duration_ticks: number;
  result: string;
  prize: number;
  data: TickSnapshot[];
  recorded_at: string;
}

const SPEED_STEPS = [0.5, 1, 2, 4] as const;
type Speed = typeof SPEED_STEPS[number];

function mapIdForZone(zoneId: string): string {
  const bare = zoneId.split(':')[0];
  if (bare.startsWith('arena-truck-stop')) return 'truck-stop';
  return 'open';
}

function paletteBackground(palette?: string): number {
  switch (palette) {
    case 'industrial': return 0x0a0e14;
    case 'urban':      return 0x0b0810;
    case 'desert':     return 0x140d08;
    case 'wasteland':  return 0x080808;
    default:           return 0x0a0a14;
  }
}

export class ReplayScene extends Phaser.Scene {
  private payload!: ReplaySceneData;
  private replay: ReplayPayload | null = null;
  private map: ArenaMap | null = null;
  private currentTick = 0;
  private speed: Speed = 1;
  private paused = false;
  private accumulator = 0;

  // Vehicle sprite containers, indexed by vehicle id
  private vehicleSprites = new Map<string, Phaser.GameObjects.Container>();
  // Vehicle roster from tick 0 — used for sprite building
  private roster: VehicleState[] = [];

  private worldLayer!: Phaser.GameObjects.Container;
  private effectsLayer!: Phaser.GameObjects.Container;
  private vehicleLayer!: Phaser.GameObjects.Container;
  private tilemapLayers: Phaser.Tilemaps.TilemapLayer[] = [];
  private hudText!: Phaser.GameObjects.Text;
  private timelineBar!: Phaser.GameObjects.Rectangle;
  private timelineFill!: Phaser.GameObjects.Rectangle;
  private statusText!: Phaser.GameObjects.Text;

  constructor() { super({ key: 'ReplayScene' }); }

  preload(): void {
    preloadVehicleSprites(this);
  }

  init(data: ReplaySceneData): void {
    this.payload = data;
    this.currentTick = 0;
    this.speed = 1;
    this.paused = false;
    this.accumulator = 0;
    this.vehicleSprites.clear();
    this.roster = [];
  }

  async create(): Promise<void> {
    try {
      // Create layers FIRST — must exist before any layout/update call,
      // since onLayout may fire layout() synchronously during create().
      this.worldLayer = this.add.container(0, 0);
      this.vehicleLayer = this.add.container(0, 0);
      this.effectsLayer = this.add.container(0, 0);

      const host = window.location.hostname;
      const headers = { Authorization: `Bearer ${this.payload.token}` };
      const [replayRes] = await Promise.all([
        fetch(`http://${host}:3001/api/replays/${this.payload.replayId}`, { headers }),
      ]);
      if (!replayRes.ok) {
        this.add.text(this.scale.width / 2, this.scale.height / 2, 'Replay not found', {
          fontSize: '24px', color: '#ff4444', fontFamily: 'monospace',
        }).setOrigin(0.5);
        this.input.keyboard?.on('keydown-ESC', () => this.exit());
        return;
      }
      this.replay = await replayRes.json() as ReplayPayload;

      // Build roster from tick 0 if available, or from the roster field
      const firstSnap = this.replay.data[0];
      if (firstSnap?.roster && firstSnap.roster.length > 0) {
        this.roster = firstSnap.roster;
      } else if (firstSnap?.vehicles?.[0]?.stats) {
        // Fallback: build synthetic roster from tick 0 vehicle data
        this.roster = firstSnap.vehicles.map(v => ({
          id: v.id,
          position: { x: v.x, y: v.y },
          facing: v.facing,
          speed: v.speed,
          playerId: v.playerId,
          stats: v.stats!,
        })) as unknown as VehicleState[];
      }

      const mapId = mapIdForZone(this.replay.zone_id);
      const mapRes = await fetch(`http://${host}:3001/api/maps/${mapId}`, { headers });
      if (mapRes.ok) this.map = await mapRes.json() as ArenaMap;

      // Camera setup — match ArenaScene
      this.cameras.main.setZoom(0.6);
      this.cameras.main.setLerp(0.08, 0.08);
      this.cameras.main.scrollX = 0;
      this.cameras.main.scrollY = 0;

      bindFullscreenToggle(this);
      onLayout(this, () => this.layout());
      this.layout();
      this.bindInput();

      // Build vehicle sprites from roster (empty = old replay, rectangle fallback used)
      this.buildVehicleSprites();

      // Render first frame
      this.renderFrame();
    } catch (e) {
      console.error('ReplayScene error:', e);
      this.add.text(this.scale.width / 2, this.scale.height / 2, 'Replay error: ' + (e as Error).message, {
        fontSize: '16px', color: '#ff4444', fontFamily: 'monospace',
      }).setOrigin(0.5);
    }
  }

  private buildVehicleSprites(): void {
    this.vehicleLayer.removeAll(true);
    this.vehicleSprites.clear();
    for (const roV of this.roster) {
      const teamColor = this.replayColor(roV.playerId);
      const sprite = buildVehicleSprite(this, roV, {
        isPlayer: roV.playerId === 'player',
        teamColor,
      });
      this.vehicleSprites.set(roV.id, sprite);
      this.vehicleLayer.add(sprite);
    }
  }

  private layout(): void {
    const { width, height } = this.scale;

    // Remove old tilemap layers so they're re-created on resize
    this.tilemapLayers.forEach(l => l.destroy());
    this.tilemapLayers = [];
    this.worldLayer.removeAll(true);
    if (this.map) this.renderMap(this.map);

    // Re-size camera to match viewport
    this.cameras.main.setViewport(0, 0, width, height);

    // HUD — top-left, fixed to camera (scrollFactor 0)
    if (this.hudText) this.hudText.destroy();
    this.hudText = this.add.text(20, 20, '', {
      fontSize: '14px', color: '#cccccc', fontFamily: 'monospace',
      backgroundColor: '#000000aa', padding: { x: 8, y: 4 },
    }).setScrollFactor(0);

    if (this.statusText) this.statusText.destroy();
    this.statusText = this.add.text(width - 20, 20, '', {
      fontSize: '14px', color: '#ffcc00', fontFamily: 'monospace',
      backgroundColor: '#000000aa', padding: { x: 8, y: 4 },
    }).setOrigin(1, 0).setScrollFactor(0);

    // Timeline bar at bottom
    if (this.timelineBar) this.timelineBar.destroy();
    if (this.timelineFill) this.timelineFill.destroy();
    const barW = Math.min(width - 80, 800);
    const barX = width / 2;
    const barY = height - 40;
    this.timelineBar = this.add.rectangle(barX, barY, barW, 6, 0x333344).setScrollFactor(0);
    this.timelineFill = this.add.rectangle(barX - barW / 2, barY, 1, 6, 0xffcc00).setOrigin(0, 0.5).setScrollFactor(0);

    this.renderFrame();
  }

  private renderMap(map: ArenaMap): void {
    const mapW = map.width * PIXELS_PER_INCH;
    const mapH = map.height * PIXELS_PER_INCH;

    // Tilemap background — same textured look as ArenaScene
    this.cache.tilemap.add('replay-arena', {
      format: Phaser.Tilemaps.Formats.TILED_JSON,
      data: arenaMapData,
    });
    const gfx = this.make.graphics({ x: 0, y: 0 });
    gfx.fillStyle(0x111122); gfx.fillRect(0, 0, 32, 32);   // tile 1: outer floor
    gfx.fillStyle(0x1a1a33); gfx.fillRect(32, 0, 32, 32);  // tile 2: unused
    gfx.fillStyle(0x222244); gfx.fillRect(0, 32, 32, 32);  // tile 3: arena floor
    gfx.fillStyle(0x4444aa); gfx.fillRect(32, 32, 32, 32); // tile 4: arena wall
    gfx.generateTexture('tiles-replay', 64, 64);
    gfx.destroy();

    const tilemap = this.make.tilemap({ key: 'replay-arena' });
    const tileset = tilemap.addTilesetImage('arena', 'tiles-replay')!;
    const groundLayer = tilemap.createLayer('ground', tileset);
    const wallLayer = tilemap.createLayer('walls', tileset);
    // Position the tilemap so its center aligns with WORLD_CENTER
    // The tilemap is 40 tiles wide x 30 tiles tall = 1280 x 960 pixels
    tilemap.setPosition(WORLD_CENTER_X - 640, WORLD_CENTER_Y - 480);

    // If the game map has explicit dimensions, create a palette-tinted
    // background rectangle so the tilemap tiles outside the map boundaries
    // are hidden by the solid background colour.
    const bgColor = paletteBackground(map.palette);
    const bg = this.add.rectangle(
      WORLD_CENTER_X, WORLD_CENTER_Y, mapW, mapH, bgColor
    );
    this.worldLayer.add(bg);

    // Floor surfaces from map data — painted on top of the tilemap
    // but below walls, so the tilemap shows through on uncovered areas.
    if (map.floor && map.floor.length > 0) {
      const ffx = this.add.graphics();
      renderMapFloor(ffx, map.floor, RENDER_OPTS);
      this.worldLayer.add(ffx);
    }
    if (map.decorations && map.decorations.length > 0) {
      const dfx = this.add.graphics();
      renderMapDecorations(dfx, map.decorations, RENDER_OPTS);
      this.worldLayer.add(dfx);
    }
    // Walls drawn with the game map's layout — these are the actual collision walls
    if (map.walls && map.walls.length > 0) {
      const wfx = this.add.graphics();
      renderMapWalls(wfx, map.walls, RENDER_OPTS);
      this.worldLayer.add(wfx);
    }
  }

  private bindInput(): void {
    const kb = this.input.keyboard;
    if (!kb) return;
    kb.on('keydown-SPACE', () => { this.paused = !this.paused; this.updateHud(); });
    kb.on('keydown-LEFT',  () => { this.currentTick = Math.max(0, this.currentTick - 5); this.renderFrame(); });
    kb.on('keydown-RIGHT', () => {
      const max = (this.replay?.data.length ?? 1) - 1;
      this.currentTick = Math.min(max, this.currentTick + 5);
      this.renderFrame();
    });
    kb.on('keydown-ONE',   () => { this.speed = 1; this.updateHud(); });
    kb.on('keydown-TWO',   () => { this.speed = 2; this.updateHud(); });
    kb.on('keydown-FOUR',  () => { this.speed = 4; this.updateHud(); });
    kb.on('keydown-ESC',   () => this.exit());
  }

  update(_time: number, delta: number): void {
    if (!this.replay || this.paused) {
      this.updateHud();
      return;
    }
    this.accumulator += delta * this.speed;
    while (this.accumulator >= 100 && this.currentTick < this.replay.data.length - 1) {
      this.accumulator -= 100;
      this.currentTick++;
    }
    if (this.currentTick >= this.replay.data.length - 1) {
      this.paused = true;
    }
    this.renderFrame();
  }

  private renderFrame(): void {
    if (!this.replay || !this.effectsLayer) return;
    const snap = this.replay.data[this.currentTick];
    if (!snap) return;

    // Clear effects — combat tracers, wreckage, and rectangle-fallback vehicles
    this.effectsLayer.removeAll(true);

    // Render vehicles: sprites from roster, or rectangle fallback for old replays
    for (const vd of snap.vehicles) {
      const sprite = this.vehicleSprites.get(vd.id);
      if (sprite) {
        // Position
        sprite.x = WORLD_CENTER_X + vd.x * PIXELS_PER_INCH;
        sprite.y = WORLD_CENTER_Y + vd.y * PIXELS_PER_INCH;
        sprite.setRotation(Phaser.Math.DegToRad(vd.facing));

        // Update damage state + ammo from per-tick stats
        const roV = this.roster.find(r => r.id === vd.id);
        if (roV && vd.stats) {
          const updatedV: VehicleState = {
            ...roV,
            stats: vd.stats,
            facing: vd.facing,
            speed: vd.speed,
          };
          updateVehicleSprite(sprite, updatedV, {
            isPlayer: vd.playerId === 'player',
            teamColor: this.replayColor(vd.playerId),
          });
        }
      } else {
        // Fallback: old replay without enriched snapshot data — coloured rectangle
        const wx = WORLD_CENTER_X + vd.x * PIXELS_PER_INCH;
        const wy = WORLD_CENTER_Y + vd.y * PIXELS_PER_INCH;
        const color = vd.playerId === 'player' ? 0x00ff88 : vd.playerId === 'ai-team' ? 0xff4444 : 0x6666aa;
        this.effectsLayer.add(
          this.add.rectangle(wx, wy, 22, 38, color).setStrokeStyle(1, 0x111111)
            .setRotation(Phaser.Math.DegToRad(vd.facing))
        );
        this.effectsLayer.add(
          this.add.triangle(wx, wy, 0, -22, -5, -14, 5, -14, 0xffffff)
            .setRotation(Phaser.Math.DegToRad(vd.facing))
        );
      }
    }

    // Wreckage
    for (const w of snap.wreckage) {
      const wx = WORLD_CENTER_X + w.x * PIXELS_PER_INCH;
      const wy = WORLD_CENTER_Y + w.y * PIXELS_PER_INCH;
      const color = w.state === 'burning' ? 0x882200 : w.state === 'smouldering' ? 0x442211 : 0x222222;
      this.effectsLayer.add(
        this.add.rectangle(wx, wy, 22, 38, color).setStrokeStyle(1, 0x111111)
          .setRotation(Phaser.Math.DegToRad(w.facing))
      );
    }

    // Combat events for this tick
    for (const ev of snap.combatEvents) {
      const fx = WORLD_CENTER_X + ev.fromX * PIXELS_PER_INCH;
      const fy = WORLD_CENTER_Y + ev.fromY * PIXELS_PER_INCH;
      const tx = WORLD_CENTER_X + ev.toX   * PIXELS_PER_INCH;
      const ty = WORLD_CENTER_Y + ev.toY   * PIXELS_PER_INCH;
      this.effectsLayer.add(
        this.add.line(0, 0, fx, fy, tx, ty,
          ev.hit ? 0xff4400 : 0xffff00, ev.hit ? 0.9 : 0.5).setOrigin(0, 0)
      );
      if (ev.hit) {
        this.effectsLayer.add(
          this.add.circle(tx, ty, 12, 0xff6600, 0.7).setStrokeStyle(2, 0xffffff, 0.7)
        );
      }
    }

    this.updateHud();
    this.updateTimeline();
  }

  private updateHud(): void {
    if (!this.hudText || !this.replay) return;
    const total = this.replay.data.length;
    const winLabel = this.replay.result.toUpperCase();
    const speedLabel = this.paused ? 'PAUSED' : `${this.speed}×`;
    this.hudText.setText([
      `REPLAY  ${winLabel}${this.replay.opponent ? `  vs ${this.replay.opponent}` : ''}`,
      `Tick ${this.currentTick + 1} / ${total}   ${speedLabel}`,
      `[Space] pause  [←/→] scrub  [1/2/4] speed  [Esc] back`,
    ].join('\n'));

    if (this.statusText && this.replay) {
      this.statusText.setText(this.replay.prize > 0 ? `Prize +$${this.replay.prize.toLocaleString()}` : '');
    }
  }

  private updateTimeline(): void {
    if (!this.timelineBar || !this.timelineFill || !this.replay) return;
    const total = this.replay.data.length;
    const ratio = total > 0 ? this.currentTick / Math.max(1, total - 1) : 0;
    this.timelineFill.setSize(Math.max(1, this.timelineBar.width * ratio), 6);
  }

  // Stable colour by playerId — mirrors arena scene team colors
  private replayColor(playerId: string): number {
    if (playerId === 'player')  return 0x00ff88;
    if (playerId === 'ai-team') return 0xff4444;
    let h = 0;
    for (let i = 0; i < playerId.length; i++) h = (h * 31 + playerId.charCodeAt(i)) >>> 0;
    return 0x444466 + ((h & 0xffffff) >>> 0) % 0xbbbbbb;
  }

  private exit(): void {
    this.scene.start(this.payload.returnTo ?? 'GarageScene', { token: this.payload.token });
  }
}