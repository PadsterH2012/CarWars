import Phaser from 'phaser';
import { bindFullscreenToggle, onLayout } from '../ui/responsive';

export class TownScene extends Phaser.Scene {
  private token = '';
  private vehicleId = '';
  private titleText!: Phaser.GameObjects.Text;
  private subtitleText!: Phaser.GameObjects.Text;
  private garageBtn!: Phaser.GameObjects.Text;
  private arenaBtn!: Phaser.GameObjects.Text;

  constructor() { super({ key: 'TownScene' }); }

  init(data: { zoneId: string; token: string; vehicleId: string }): void {
    this.token = data.token;
    this.vehicleId = data.vehicleId;
  }

  create(): void {
    this.titleText = this.add.text(0, 0, 'MIDVILLE', {
      color: '#ff4444', fontSize: '36px', fontFamily: 'monospace', fontStyle: 'bold'
    }).setOrigin(0.5);

    this.subtitleText = this.add.text(0, 0, 'A dusty town on the autoduel circuit', {
      color: '#888888', fontSize: '16px', fontFamily: 'monospace'
    }).setOrigin(0.5);

    this.garageBtn = this.add.text(0, 0, '[ GARAGE ]', {
      color: '#00ff88', fontSize: '24px', fontFamily: 'monospace',
      backgroundColor: '#003322', padding: { x: 20, y: 10 }
    }).setOrigin(0.5).setInteractive();
    this.garageBtn.on('pointerdown', () => this.scene.start('GarageScene', { token: this.token }));

    this.arenaBtn = this.add.text(0, 0, '[ DRIVE TO ARENA ]', {
      color: '#ff4444', fontSize: '20px', fontFamily: 'monospace',
      backgroundColor: '#220000', padding: { x: 16, y: 8 }
    }).setOrigin(0.5).setInteractive();
    this.arenaBtn.on('pointerdown', () => {
      this.scene.start('ArenaScene', { token: this.token, vehicleId: this.vehicleId });
    });

    bindFullscreenToggle(this);
    onLayout(this, () => this.layout());
  }

  private layout(): void {
    const { width, height } = this.scale;
    const cx = width / 2;
    this.titleText.setPosition(cx, height * 0.28);
    this.subtitleText.setPosition(cx, height * 0.36);
    this.garageBtn.setPosition(cx, height * 0.5);
    this.arenaBtn.setPosition(cx, height * 0.63);
  }
}
