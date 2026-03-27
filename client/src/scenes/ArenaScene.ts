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
      this.connection.send({ type: 'join_zone', zoneId: 'arena-1', vehicleId: this.myVehicleId });
    });
    this.connection.onMessage((msg) => {
      if (msg.type === 'zone_state') {
        this.zoneState = msg.state;
        this.syncSprites(msg.state);
        this.checkBoundary(msg.state);
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
        const color = isPlayer ? 0x00ff88 : 0xff4444;

        const body = this.add.rectangle(0, 0, 20, 32, color);
        const dirIndicator = this.add.triangle(0, -18, -6, 0, 6, 0, 0, -10, 0xffffff);
        const label = this.add.text(0, 20, v.id, {
          fontSize: '9px',
          color: '#ffffff',
          fontFamily: 'monospace'
        }).setOrigin(0.5);

        container = this.add.container(0, 0, [body, dirIndicator, label]);
        this.vehicleSprites.set(v.id, container);
      }

      const worldX = WORLD_CENTER_X + v.position.x * PIXELS_PER_INCH;
      const worldY = WORLD_CENTER_Y + v.position.y * PIXELS_PER_INCH;
      container.setPosition(worldX, worldY);
      container.setRotation(Phaser.Math.DegToRad(v.facing));

      // Camera follows player on first spawn
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
