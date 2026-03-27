import Phaser from 'phaser';
import { Connection } from '../game/Connection';
import type { ZoneState } from '@carwars/shared';

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
  private lastInputSent = 0;

  constructor() {
    super({ key: 'ArenaScene' });
  }

  create(): void {
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.fireKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);

    this.drawGrid();
    this.add.text(16, 16, 'CAR WARS', {
      color: '#ff4444',
      fontSize: '24px',
      fontStyle: 'bold',
      fontFamily: 'monospace'
    });
    this.add.text(16, 48, 'Arrow keys: drive | Space: fire', {
      color: '#888888',
      fontSize: '12px',
      fontFamily: 'monospace'
    });

    const wsHost = window.location.hostname;
    this.connection = new Connection(`ws://${wsHost}:3001`);
    this.connection.onOpen(() => {
      this.connection.send({ type: 'join_zone', zoneId: 'arena-1', vehicleId: this.myVehicleId });
    });
    this.connection.onMessage((msg) => {
      if (msg.type === 'zone_state') {
        this.zoneState = msg.state;
        this.syncSprites(msg.state);
      }
    });
  }

  private drawGrid(): void {
    const graphics = this.add.graphics();
    graphics.lineStyle(1, 0x222244, 0.8);
    for (let x = 0; x < 1280; x += PIXELS_PER_INCH) {
      graphics.lineBetween(x, 0, x, 720);
    }
    for (let y = 0; y < 720; y += PIXELS_PER_INCH) {
      graphics.lineBetween(0, y, 1280, y);
    }
    // Arena border
    graphics.lineStyle(2, 0x4444aa, 1);
    graphics.strokeRect(64, 64, 1152, 592);
  }

  private syncSprites(state: ZoneState): void {
    const seen = new Set<string>();

    state.vehicles.forEach(v => {
      seen.add(v.id);
      let container = this.vehicleSprites.get(v.id);

      if (!container) {
        // Create vehicle sprite: body + direction indicator
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

      const screenX = WORLD_CENTER_X + v.position.x * PIXELS_PER_INCH;
      const screenY = WORLD_CENTER_Y + v.position.y * PIXELS_PER_INCH;
      container.setPosition(screenX, screenY);
      container.setRotation(Phaser.Math.DegToRad(v.facing));
    });

    // Remove sprites for vehicles no longer in state
    this.vehicleSprites.forEach((container, id) => {
      if (!seen.has(id)) {
        container.destroy();
        this.vehicleSprites.delete(id);
      }
    });
  }

  update(time: number): void {
    if (!this.zoneState) return;

    // Rate-limit input to server tick rate (~100ms)
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
