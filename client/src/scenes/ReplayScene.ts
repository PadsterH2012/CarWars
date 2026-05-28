import Phaser from 'phaser';
import { bindFullscreenToggle, onLayout } from '../ui/responsive';
import { renderMapFloor, renderMapWalls, renderMapDecorations, type MapRenderOptions } from '../rendering/mapRenderer';
import type { ArenaMap, CombatEvent, WreckageState } from '@carwars/shared';

const PIXELS_PER_INCH = 32;

export interface ReplaySceneData {
  token: string;
  replayId: string;
  returnTo?: string;
}

interface TickSnapshot {
  tick: number;
  vehicles: { id: string; x: number; y: number; facing: number; speed: number; playerId: string }[];
  combatEvents: CombatEvent[];
  wreckage: { id: string; x: number; y: number; facing: number; state: WreckageState; sourceVehicleId: string }[];
  winnerId: string | null;
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

// Speed-step → ticks-per-frame. The replay's native rate is one snapshot per
// engine tick (100 ms). At 1× we advance one tick per 100 ms of wall time.
const SPEED_STEPS = [0.5, 1, 2, 4] as const;
type Speed = typeof SPEED_STEPS[number];

function mapIdForZone(zoneId: string): string {
  const bare = zoneId.split(':')[0];
  if (bare.startsWith('arena-truck-stop')) return 'truck-stop';
  return 'open';
}

export class ReplayScene extends Phaser.Scene {
  private payload!: ReplaySceneData;
  private replay: ReplayPayload | null = null;
  private map: ArenaMap | null = null;
  private currentTick = 0;
  private speed: Speed = 1;
  private paused = false;
  private accumulator = 0; // wall-time ms since last tick advance

  private centerX = 0;
  private centerY = 0;
  private worldLayer!: Phaser.GameObjects.Container;
  private effectsLayer!: Phaser.GameObjects.Container;
  private hudText!: Phaser.GameObjects.Text;
  private timelineBar!: Phaser.GameObjects.Rectangle;
  private timelineFill!: Phaser.GameObjects.Rectangle;
  private statusText!: Phaser.GameObjects.Text;

  constructor() { super({ key: 'ReplayScene' }); }

  init(data: ReplaySceneData): void {
    this.payload = data;
    this.currentTick = 0;
    this.speed = 1;
    this.paused = false;
    this.accumulator = 0;
  }

  async create(): Promise<void> {
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

    const mapId = mapIdForZone(this.replay.zone_id);
    const mapRes = await fetch(`http://${host}:3001/api/maps/${mapId}`, { headers });
    if (mapRes.ok) this.map = await mapRes.json() as ArenaMap;

    this.worldLayer = this.add.container(0, 0);
    this.effectsLayer = this.add.container(0, 0);

    bindFullscreenToggle(this);
    onLayout(this, () => this.layout());
    this.layout();
    this.bindInput();
    this.renderFrame();
  }

  private layout(): void {
    const { width, height } = this.scale;
    this.centerX = width / 2;
    this.centerY = height / 2 - 20;

    this.worldLayer.removeAll(true);
    if (this.map) this.renderMap(this.map);

    // HUD
    if (this.hudText) this.hudText.destroy();
    this.hudText = this.add.text(20, 20, '', {
      fontSize: '14px', color: '#cccccc', fontFamily: 'monospace',
      backgroundColor: '#000000aa', padding: { x: 8, y: 4 },
    });

    // Status (top-right)
    if (this.statusText) this.statusText.destroy();
    this.statusText = this.add.text(width - 20, 20, '', {
      fontSize: '14px', color: '#ffcc00', fontFamily: 'monospace',
      backgroundColor: '#000000aa', padding: { x: 8, y: 4 },
    }).setOrigin(1, 0);

    // Timeline bar at bottom
    if (this.timelineBar) this.timelineBar.destroy();
    if (this.timelineFill) this.timelineFill.destroy();
    const barW = Math.min(width - 80, 800);
    const barX = width / 2;
    const barY = height - 40;
    this.timelineBar = this.add.rectangle(barX, barY, barW, 6, 0x333344);
    this.timelineFill = this.add.rectangle(barX - barW / 2, barY, 1, 6, 0xffcc00).setOrigin(0, 0.5);

    this.renderFrame();
  }

  private renderMap(map: ArenaMap): void {
    const opts: MapRenderOptions = { centerX: this.centerX, centerY: this.centerY, pixelsPerInch: PIXELS_PER_INCH };
    const bg = this.add.rectangle(this.centerX, this.centerY, map.width * PIXELS_PER_INCH, map.height * PIXELS_PER_INCH, 0x0a0a14);
    this.worldLayer.add(bg);
    if (map.floor && map.floor.length > 0) {
      const gfx = this.add.graphics();
      renderMapFloor(gfx, map.floor, opts);
      this.worldLayer.add(gfx);
    }
    if (map.decorations && map.decorations.length > 0) {
      const gfx = this.add.graphics();
      renderMapDecorations(gfx, map.decorations, opts);
      this.worldLayer.add(gfx);
    }
    if (map.walls && map.walls.length > 0) {
      const gfx = this.add.graphics();
      renderMapWalls(gfx, map.walls, opts);
      this.worldLayer.add(gfx);
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
    // Native rate: 1 tick per 100 ms wall time. Speed multiplier scales that.
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
    if (!this.replay) return;
    const snap = this.replay.data[this.currentTick];
    if (!snap) return;

    // Clear effects layer (vehicles, wreckage, combat tracers) and re-draw.
    // For a replay viewer, redrawing every frame keeps the implementation
    // tiny — no need for sprite reuse since maps are small.
    this.effectsLayer.removeAll(true);

    // Wreckage — small dark rectangles
    for (const w of snap.wreckage) {
      const wx = this.centerX + w.x * PIXELS_PER_INCH;
      const wy = this.centerY + w.y * PIXELS_PER_INCH;
      const color = w.state === 'burning' ? 0x882200 : w.state === 'smouldering' ? 0x442211 : 0x222222;
      const rect = this.add.rectangle(wx, wy, 22, 38, color).setStrokeStyle(1, 0x111111)
        .setRotation(Phaser.Math.DegToRad(w.facing));
      this.effectsLayer.add(rect);
    }

    // Vehicles — colored rectangles by playerId; player teams in green, AI in red, others auto-coloured
    for (const v of snap.vehicles) {
      const wx = this.centerX + v.x * PIXELS_PER_INCH;
      const wy = this.centerY + v.y * PIXELS_PER_INCH;
      const color = this.colorForPlayer(v.playerId);
      const body = this.add.rectangle(wx, wy, 22, 38, color)
        .setStrokeStyle(1, 0x111111)
        .setRotation(Phaser.Math.DegToRad(v.facing));
      this.effectsLayer.add(body);
      // Facing indicator — small wedge at front
      const arrow = this.add.triangle(wx, wy, 0, -22, -5, -14, 5, -14, 0xffffff)
        .setRotation(Phaser.Math.DegToRad(v.facing));
      this.effectsLayer.add(arrow);
    }

    // Combat events for this tick — faded tracers + hit flashes
    for (const ev of snap.combatEvents) {
      const fx = this.centerX + ev.fromX * PIXELS_PER_INCH;
      const fy = this.centerY + ev.fromY * PIXELS_PER_INCH;
      const tx = this.centerX + ev.toX   * PIXELS_PER_INCH;
      const ty = this.centerY + ev.toY   * PIXELS_PER_INCH;
      const line = this.add.line(0, 0, fx, fy, tx, ty,
        ev.hit ? 0xff4400 : 0xffff00, ev.hit ? 0.9 : 0.5).setOrigin(0, 0);
      this.effectsLayer.add(line);
      if (ev.hit) {
        const flash = this.add.circle(tx, ty, 12, 0xff6600, 0.7).setStrokeStyle(2, 0xffffff, 0.7);
        this.effectsLayer.add(flash);
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

  // Stable colour mapping per playerId. Special-cases the AI team to red and
  // player to green; everything else falls back to a deterministic hash colour.
  private colorForPlayer(playerId: string): number {
    if (playerId === 'ai-team') return 0xff4444;
    if (playerId === 'player')  return 0x00ff88;
    let h = 0;
    for (let i = 0; i < playerId.length; i++) h = (h * 31 + playerId.charCodeAt(i)) >>> 0;
    return 0x444466 + ((h & 0xffffff) >>> 0) % 0xbbbbbb;
  }

  private exit(): void {
    this.scene.start(this.payload.returnTo ?? 'GarageScene', { token: this.payload.token });
  }
}
