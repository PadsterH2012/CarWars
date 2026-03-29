import Phaser from 'phaser';
import { Connection } from '../game/Connection';
import type { ZoneState } from '@carwars/shared';
import arenaMapData from '../tilemaps/arena-1.json';

const PIXELS_PER_INCH = 32;
const WORLD_CENTER_X = 640;
const WORLD_CENTER_Y = 360;

// Interpolation target per vehicle — updated on each zone_state, lerped toward each frame
interface VehicleTarget { x: number; y: number; rotation: number; }

export class ArenaScene extends Phaser.Scene {
  private connection!: Connection;
  private vehicleSprites = new Map<string, Phaser.GameObjects.Container>();
  private vehicleTargets = new Map<string, VehicleTarget>();
  private hazardSprites = new Map<string, Phaser.GameObjects.GameObject>();
  private zoneState: ZoneState | null = null;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private fireKey!: Phaser.Input.Keyboard.Key;
  private autopilotKey!: Phaser.Input.Keyboard.Key;
  private myVehicleId = 'v1';
  private token = '';
  private lastInputSent = 0;
  private zoneEnded = false;
  private firePending = false;
  private autopilot = false;
  private autopilotLabel!: Phaser.GameObjects.Text;
  private minimapGfx!: Phaser.GameObjects.Graphics;
  private mapWalls: import('@carwars/shared').Rect[] = [];
  private mapGraphics!: Phaser.GameObjects.Graphics;

  constructor() {
    super({ key: 'ArenaScene' });
  }

  init(data: { token?: string; vehicleId?: string }): void {
    this.token = data.token ?? '';
    this.myVehicleId = data.vehicleId ?? 'v1';
  }

  create(): void {
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.fireKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.autopilotKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.A);
    // JustDown only fires for a single frame (~16ms) but inputs are batched every 100ms.
    // Use keydown event to accumulate fire intent so it isn't dropped between send ticks.
    this.fireKey.on('down', () => { this.firePending = true; });
    this.autopilotKey.on('down', () => {
      this.autopilot = !this.autopilot;
      this.connection.send({ type: 'autopilot', enabled: this.autopilot });
      this.autopilotLabel.setText(this.autopilot ? 'AUTOPILOT: ON' : 'AUTOPILOT: OFF');
      this.autopilotLabel.setColor(this.autopilot ? '#00ff88' : '#888888');
    });

    // Inject tilemap JSON into cache (bundled by Vite — no HTTP request needed)
    this.cache.tilemap.add('arena-1', {
      format: Phaser.Tilemaps.Formats.TILED_JSON,
      data: arenaMapData
    });

    // Generate tileset texture programmatically (no external image needed)
    const gfx = this.make.graphics({ x: 0, y: 0, add: false });
    gfx.fillStyle(0x111122); gfx.fillRect(0, 0, 32, 32);   // tile 1: outer floor
    gfx.fillStyle(0x1a1a33); gfx.fillRect(32, 0, 32, 32);  // tile 2: unused
    gfx.fillStyle(0x222244); gfx.fillRect(0, 32, 32, 32);  // tile 3: arena floor
    gfx.fillStyle(0x4444aa); gfx.fillRect(32, 32, 32, 32); // tile 4: arena wall
    gfx.generateTexture('tiles-arena', 64, 64);
    gfx.destroy();

    const map = this.make.tilemap({ key: 'arena-1' });
    const tileset = map.addTilesetImage('arena', 'tiles-arena')!;
    map.createLayer('ground', tileset);
    const wallLayer = map.createLayer('walls', tileset)!;
    wallLayer.setCollisionByExclusion([0]);

    this.add.text(16, 16, 'CAR WARS', {
      color: '#ff4444',
      fontSize: '24px',
      fontStyle: 'bold',
      fontFamily: 'monospace'
    }).setScrollFactor(0);
    this.add.text(16, 48, 'Arrows: drive | Space: fire | A: autopilot', {
      color: '#888888',
      fontSize: '12px',
      fontFamily: 'monospace'
    }).setScrollFactor(0);

    this.autopilotLabel = this.add.text(16, 68, 'AUTOPILOT: OFF', {
      color: '#888888', fontSize: '12px', fontFamily: 'monospace'
    }).setScrollFactor(0);

    this.minimapGfx = this.add.graphics().setScrollFactor(0).setDepth(20);
    this.mapGraphics = this.add.graphics().setDepth(1);  // above ground, below vehicles
    // Minimap label
    this.add.text(1144, 4, 'MAP', {
      fontSize: '9px', color: '#666666', fontFamily: 'monospace'
    }).setScrollFactor(0).setDepth(20);

    // Zoom out so player can see enemies approaching — 0.6x shows ~53 world units wide
    this.cameras.main.setZoom(0.6);
    // Smooth camera follow — lerp 0.08 means camera catches up over ~12 frames (soft tracking)
    this.cameras.main.setLerp(0.08, 0.08);
    this.cameras.main.scrollX = 0;
    this.cameras.main.scrollY = 0;

    const wsHost = window.location.hostname;
    this.connection = new Connection(`ws://${wsHost}:3001`);
    this.connection.onOpen(() => {
      const zoneId = new URLSearchParams(window.location.search).get('zone') ?? 'arena-truck-stop';
      this.connection.send({ type: 'join_zone', zoneId, vehicleId: this.myVehicleId, token: this.token });
    });
    this.connection.onMessage((msg) => {
      if (msg.type === 'zone_state') {
        // Render map walls once on first message (walls only present on join)
        if (msg.state.walls && msg.state.walls.length > 0 && this.mapWalls.length === 0) {
          this.mapWalls = msg.state.walls;
          this.renderMapWalls(msg.state.walls);
          // Zoom out further for the large truck stop map
          if (msg.state.mapId === 'truck-stop') {
            this.cameras.main.setZoom(0.35);
          }
        }
        this.zoneState = msg.state;
        this.syncSprites(msg.state);
      } else if (msg.type === 'zone_end') {
        this.showZoneEnd(msg.winnerId, msg.reason);
      }
    });
  }

  private syncSprites(state: ZoneState): void {
    const seen = new Set<string>();

    state.vehicles.forEach(v => {
      seen.add(v.id);
      let container = this.vehicleSprites.get(v.id);

      if (!container) {
        const isPlayer = v.id === this.myVehicleId;
        const color = isPlayer ? 0x00ff88 : (v.playerId === 'ai-team' ? 0xff4444 : 0xffaa00);

        const body = this.add.rectangle(0, 0, 20, 32, color).setName('body');
        const dirIndicator = this.add.triangle(0, -18, -6, 0, 6, 0, 0, -10, 0xffffff);
        const label = this.add.text(0, 20, v.id.slice(0, 8), {
          fontSize: '9px', color: '#ffffff', fontFamily: 'monospace'
        }).setOrigin(0.5);

        // Armor bars: front (top of vehicle), back (bottom), left, right
        const barFront = this.add.rectangle(0, -18, 20, 3, 0x00ff00).setName('bar-front');
        const barBack  = this.add.rectangle(0,  18, 20, 3, 0x00ff00).setName('bar-back');
        const barLeft  = this.add.rectangle(-12, 0, 3, 20, 0x00ff00).setName('bar-left');
        const barRight = this.add.rectangle( 12, 0, 3, 20, 0x00ff00).setName('bar-right');

        container = this.add.container(0, 0, [body, dirIndicator, label, barFront, barBack, barLeft, barRight]).setDepth(2);
        this.vehicleSprites.set(v.id, container);
      }

      const worldX = WORLD_CENTER_X + v.position.x * PIXELS_PER_INCH;
      const worldY = WORLD_CENTER_Y + v.position.y * PIXELS_PER_INCH;
      const rotation = Phaser.Math.DegToRad(v.facing);
      if (!this.vehicleTargets.has(v.id)) {
        // Snap to position on first appearance
        container.setPosition(worldX, worldY);
        container.setRotation(rotation);
      }
      // Always update target — lerp runs in update()
      this.vehicleTargets.set(v.id, { x: worldX, y: worldY, rotation });

      // Update armor bars and body tint
      const loadout = v.stats.loadout;
      const damage = v.stats.damageState;
      if (loadout) {
        const pct = (loc: keyof typeof loadout.armor) => {
          const orig = loadout.armor[loc];
          if (!orig) return 1;
          return Math.max(0, (damage.armor[loc] ?? orig)) / orig;
        };
        const barColor = (p: number) => p > 0.5 ? 0x00ff00 : p > 0.25 ? 0xffaa00 : 0xff2200;

        const barFront = container.getByName('bar-front') as Phaser.GameObjects.Rectangle;
        const barBack  = container.getByName('bar-back')  as Phaser.GameObjects.Rectangle;
        const barLeft  = container.getByName('bar-left')  as Phaser.GameObjects.Rectangle;
        const barRight = container.getByName('bar-right') as Phaser.GameObjects.Rectangle;
        if (barFront) { const p = pct('front'); barFront.setSize(20 * p, 3).setFillStyle(barColor(p)); }
        if (barBack)  { const p = pct('back');  barBack.setSize(20 * p, 3).setFillStyle(barColor(p)); }
        if (barLeft)  { const p = pct('left');  barLeft.setSize(3, 20 * p).setFillStyle(barColor(p)); }
        if (barRight) { const p = pct('right'); barRight.setSize(3, 20 * p).setFillStyle(barColor(p)); }

        // Tint body: interpolate from team color (full health) toward red (no health)
        const totalOrig = loadout.armor.front + loadout.armor.back + loadout.armor.left + loadout.armor.right;
        const totalRem  = (damage.armor.front  ?? loadout.armor.front) +
                          (damage.armor.back   ?? loadout.armor.back) +
                          (damage.armor.left   ?? loadout.armor.left) +
                          (damage.armor.right  ?? loadout.armor.right);
        const healthPct = totalOrig > 0 ? totalRem / totalOrig : 1;
        const body = container.getByName('body') as Phaser.GameObjects.Rectangle;
        if (body) {
          const isMe = v.id === this.myVehicleId;
          const baseR = isMe ? 0 : 255;
          const baseG = isMe ? 255 : 68;
          const baseB = isMe ? 136 : 68;
          // Lerp from damage color (0xff0000) at zero health to team color at full health
          const r = Math.floor(255 + (baseR - 255) * healthPct);
          const g = Math.floor(baseG * healthPct);
          const b = Math.floor(baseB * healthPct);
          body.setFillStyle((r << 16) | (g << 8) | b);
        }
      }

      if (v.id === this.myVehicleId) {
        // roundPixels=false so lerped sub-pixel positions render smoothly
        this.cameras.main.startFollow(container, false);
      }
    });

    this.vehicleSprites.forEach((container, id) => {
      if (!seen.has(id)) {
        container.destroy();
        this.vehicleSprites.delete(id);
        this.vehicleTargets.delete(id);
      }
    });

    this.syncHazards(state);
    this.drawMinimap(state);
  }

  private drawMinimap(state: ZoneState): void {
    const MM_X = 1144, MM_Y = 16, MM_SIZE = 120, MM_SCALE = 3;
    const gfx = this.minimapGfx;
    gfx.clear();

    // Background + border
    gfx.fillStyle(0x000000, 0.65);
    gfx.fillRect(MM_X, MM_Y, MM_SIZE, MM_SIZE);
    gfx.lineStyle(1, 0x444466, 1);
    gfx.strokeRect(MM_X, MM_Y, MM_SIZE, MM_SIZE);

    const cx = MM_X + MM_SIZE / 2;
    const cy = MM_Y + MM_SIZE / 2;

    state.vehicles.forEach(v => {
      const isPlayer = v.id === this.myVehicleId;
      const color = isPlayer ? 0x00ff88 : (v.playerId === 'ai-team' ? 0xff4444 : 0xffaa00);
      const dotX = Math.max(MM_X + 2, Math.min(MM_X + MM_SIZE - 2, cx + v.position.x * MM_SCALE));
      const dotY = Math.max(MM_Y + 2, Math.min(MM_Y + MM_SIZE - 2, cy + v.position.y * MM_SCALE));
      gfx.fillStyle(color, 1);
      gfx.fillCircle(dotX, dotY, isPlayer ? 4 : 3);
    });
  }

  private syncHazards(state: ZoneState): void {
    const seen = new Set<string>();
    state.hazardObjects.forEach(h => {
      seen.add(h.id);
      if (this.hazardSprites.has(h.id)) return;
      const worldX = WORLD_CENTER_X + h.position.x * PIXELS_PER_INCH;
      const worldY = WORLD_CENTER_Y + h.position.y * PIXELS_PER_INCH;
      let sprite: Phaser.GameObjects.GameObject;
      if (h.type === 'oil') {
        sprite = this.add.ellipse(worldX, worldY, 32, 16, 0x112211, 0.7).setDepth(1.5);
      } else {
        sprite = this.add.circle(worldX, worldY, 6, 0xff2200).setDepth(1.5);
      }
      this.hazardSprites.set(h.id, sprite);
    });
    this.hazardSprites.forEach((sprite, id) => {
      if (!seen.has(id)) {
        (sprite as Phaser.GameObjects.Ellipse | Phaser.GameObjects.Arc).destroy();
        this.hazardSprites.delete(id);
      }
    });
  }

  private renderMapWalls(walls: import('@carwars/shared').Rect[]): void {
    const gfx = this.mapGraphics;
    gfx.clear();

    walls.forEach(wall => {
      const px = WORLD_CENTER_X + wall.x * PIXELS_PER_INCH;
      const py = WORLD_CENTER_Y + wall.y * PIXELS_PER_INCH;
      const pw = wall.w * PIXELS_PER_INCH;
      const ph = wall.h * PIXELS_PER_INCH;

      if (wall.type === 'turret') {
        gfx.fillStyle(0x8b1a1a, 1);    // dark red
        gfx.lineStyle(1, 0xff3333, 1);
      } else if (wall.type === 'building') {
        gfx.fillStyle(0x3a3a4a, 1);    // medium grey-blue
        gfx.lineStyle(1, 0x555566, 1);
      } else {
        gfx.fillStyle(0x222233, 1);    // dark grey (outer wall / default)
        gfx.lineStyle(1, 0x333344, 1);
      }

      gfx.fillRect(px - pw / 2, py - ph / 2, pw, ph);
      gfx.strokeRect(px - pw / 2, py - ph / 2, pw, ph);
    });
  }

  private showZoneEnd(winnerId: string | null, reason: string): void {
    if (this.zoneEnded) return;
    this.zoneEnded = true;
    const myVehicle = this.zoneState?.vehicles.find(v => v.id === this.myVehicleId);
    const isWinner = myVehicle && winnerId && myVehicle.playerId === winnerId;
    const text = isWinner ? 'YOU WIN! +$5000' : 'ARENA OVER';
    const color = isWinner ? '#00ff88' : '#ff4444';

    this.add.rectangle(640, 360, 400, 100, 0x000000, 0.8).setScrollFactor(0).setDepth(10);
    this.add.text(640, 340, text, {
      fontSize: '36px', color, fontFamily: 'monospace', fontStyle: 'bold'
    }).setOrigin(0.5).setScrollFactor(0).setDepth(11);
    this.add.text(640, 390, reason === 'last_standing' ? 'Last vehicle standing' : reason, {
      fontSize: '16px', color: '#aaaaaa', fontFamily: 'monospace'
    }).setOrigin(0.5).setScrollFactor(0).setDepth(11);
  }

  update(time: number): void {
    if (!this.zoneState) return;

    // Interpolate all vehicle sprites toward their server-authoritative targets each frame.
    // LERP factor 0.25 = smooth over ~4 frames; fast enough to stay close, slow enough to feel smooth.
    const LERP = 0.25;
    this.vehicleTargets.forEach((target, id) => {
      const container = this.vehicleSprites.get(id);
      if (!container) return;
      container.x += (target.x - container.x) * LERP;
      container.y += (target.y - container.y) * LERP;
      // Angle lerp — handle wraparound so 359°→1° goes through 0° not 180°
      let dRot = target.rotation - container.rotation;
      if (dRot > Math.PI)  dRot -= Math.PI * 2;
      if (dRot < -Math.PI) dRot += Math.PI * 2;
      container.rotation += dRot * LERP;
    });

    if (time - this.lastInputSent < 100) return;
    this.lastInputSent = time;

    // When autopilot is on the server drives this vehicle — don't send human input
    if (this.autopilot) return;

    const speed = this.cursors.up?.isDown ? 15
      : this.cursors.down?.isDown ? 5
      : 0;
    const steer = this.cursors.left?.isDown ? -15
      : this.cursors.right?.isDown ? 15
      : 0;
    const fireWeapon = this.firePending ? 'mg' : null;
    this.firePending = false;

    if (fireWeapon) {
      const myVehicle = this.zoneState.vehicles.find(v => v.id === this.myVehicleId);
      const mySprite = this.vehicleSprites.get(this.myVehicleId);
      if (myVehicle && mySprite) {
        const PIXELS_PER_INCH = 32;
        const FIRE_RANGE_PX = 16 * PIXELS_PER_INCH; // matches server FIRE_RANGE
        const rad = Phaser.Math.DegToRad(myVehicle.facing - 90);
        const facingDx = Math.cos(rad);
        const facingDy = Math.sin(rad);

        // Find closest enemy in front arc (within ±45° and fire range)
        let tracerEndX = facingDx * FIRE_RANGE_PX;
        let tracerEndY = facingDy * FIRE_RANGE_PX;
        let hitTarget = false;

        const enemies = this.zoneState.vehicles.filter(v => v.id !== this.myVehicleId);
        let closestDist = Infinity;
        for (const enemy of enemies) {
          const eSprite = this.vehicleSprites.get(enemy.id);
          if (!eSprite) continue;
          const ex = eSprite.x - mySprite.x;
          const ey = eSprite.y - mySprite.y;
          const dist = Math.sqrt(ex * ex + ey * ey);
          if (dist > FIRE_RANGE_PX || dist === 0) continue;
          // Angle between facing direction and direction to enemy
          const dot = (ex / dist) * facingDx + (ey / dist) * facingDy;
          if (dot < Math.cos(Phaser.Math.DegToRad(45))) continue; // outside ±45° arc
          if (dist < closestDist) {
            closestDist = dist;
            tracerEndX = ex;
            tracerEndY = ey;
            hitTarget = true;
          }
        }

        const color = hitTarget ? 0xff4400 : 0xffff00;
        const flash = this.add.graphics().setDepth(5);
        flash.lineStyle(hitTarget ? 2 : 1, color, 1);
        flash.beginPath();
        flash.moveTo(mySprite.x, mySprite.y);
        flash.lineTo(mySprite.x + tracerEndX, mySprite.y + tracerEndY);
        flash.strokePath();
        this.time.delayedCall(150, () => flash.destroy());
      }
    }

    this.connection.send({
      type: 'input',
      tick: this.zoneState.tick,
      speed,
      steer,
      fireWeapon
    });
  }
}
