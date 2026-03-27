import Phaser from 'phaser';
import { Connection } from '../game/Connection';
import type { ZoneState } from '@carwars/shared';
import arenaMapData from '../tilemaps/arena-1.json';

const PIXELS_PER_INCH = 32;
const WORLD_CENTER_X = 640;
const WORLD_CENTER_Y = 360;

export class ArenaScene extends Phaser.Scene {
  private connection!: Connection;
  private vehicleSprites = new Map<string, Phaser.GameObjects.Container>();
  private hazardSprites = new Map<string, Phaser.GameObjects.GameObject>();
  private zoneState: ZoneState | null = null;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private fireKey!: Phaser.Input.Keyboard.Key;
  private myVehicleId = 'v1';
  private token = '';
  private lastInputSent = 0;

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
    this.add.text(16, 48, 'Arrow keys: drive | Space: fire', {
      color: '#888888',
      fontSize: '12px',
      fontFamily: 'monospace'
    }).setScrollFactor(0);

    const wsHost = window.location.hostname;
    this.connection = new Connection(`ws://${wsHost}:3001`);
    this.connection.onOpen(() => {
      this.connection.send({ type: 'join_zone', zoneId: 'arena-1', vehicleId: this.myVehicleId, token: this.token });
    });
    this.connection.onMessage((msg) => {
      if (msg.type === 'zone_state') {
        this.zoneState = msg.state;
        this.syncSprites(msg.state);
        this.checkBoundary(msg.state);
      } else if (msg.type === 'zone_end') {
        this.showZoneEnd(msg.winnerId, msg.reason);
      }
    });
  }

  private checkBoundary(state: ZoneState): void {
    const myVehicle = state.vehicles.find(v => v.id === this.myVehicleId);
    if (!myVehicle) return;
    const MAP_HALF_H = 11.5; // 23 tiles / 2
    if (myVehicle.position.y < -MAP_HALF_H) {
      this.transitionToZone('town-1');
    }
  }

  private transitionToZone(zoneId: string): void {
    this.connection.send({ type: 'leave_zone' });
    this.scene.start('TownScene', { zoneId, token: this.token, vehicleId: this.myVehicleId });
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

        container = this.add.container(0, 0, [body, dirIndicator, label, barFront, barBack, barLeft, barRight]);
        this.vehicleSprites.set(v.id, container);
      }

      const worldX = WORLD_CENTER_X + v.position.x * PIXELS_PER_INCH;
      const worldY = WORLD_CENTER_Y + v.position.y * PIXELS_PER_INCH;
      container.setPosition(worldX, worldY);
      container.setRotation(Phaser.Math.DegToRad(v.facing));

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

        // Tint body: total armor drives color shift toward dark red
        const totalOrig = loadout.armor.front + loadout.armor.back + loadout.armor.left + loadout.armor.right;
        const totalRem  = (damage.armor.front  ?? loadout.armor.front) +
                          (damage.armor.back   ?? loadout.armor.back) +
                          (damage.armor.left   ?? loadout.armor.left) +
                          (damage.armor.right  ?? loadout.armor.right);
        const healthPct = totalOrig > 0 ? totalRem / totalOrig : 1;
        const body = container.getByName('body') as Phaser.GameObjects.Rectangle;
        if (body) {
          const r = Math.floor(255 * (1 - healthPct));
          const g = Math.floor(healthPct * (v.id === this.myVehicleId ? 255 : 68));
          const b = Math.floor(healthPct * (v.id === this.myVehicleId ? 136 : 68));
          body.setFillStyle((r << 16) | (g << 8) | b);
        }
      }

      if (v.id === this.myVehicleId && !this.cameras.main.following) {
        this.cameras.main.startFollow(container, true);
        this.cameras.main.setBounds(0, 0, 1280, 736);
      }
    });

    this.vehicleSprites.forEach((container, id) => {
      if (!seen.has(id)) {
        container.destroy();
        this.vehicleSprites.delete(id);
      }
    });

    this.syncHazards(state);
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
        sprite = this.add.ellipse(worldX, worldY, 32, 16, 0x112211, 0.7);
      } else {
        sprite = this.add.circle(worldX, worldY, 6, 0xff2200);
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

  private showZoneEnd(winnerId: string | null, reason: string): void {
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

    if (time - this.lastInputSent < 100) return;
    this.lastInputSent = time;

    const speed = this.cursors.up?.isDown ? 15
      : this.cursors.down?.isDown ? 5
      : 0;
    const steer = this.cursors.left?.isDown ? -15
      : this.cursors.right?.isDown ? 15
      : 0;
    const fireWeapon = Phaser.Input.Keyboard.JustDown(this.fireKey) ? 'mg' : null;

    this.connection.send({
      type: 'input',
      tick: this.zoneState.tick,
      speed,
      steer,
      fireWeapon
    });
  }
}
