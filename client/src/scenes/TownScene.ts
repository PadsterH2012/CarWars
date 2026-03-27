import Phaser from 'phaser';

export class TownScene extends Phaser.Scene {
  private token = '';
  private vehicleId = '';

  constructor() { super({ key: 'TownScene' }); }

  init(data: { zoneId: string; token: string; vehicleId: string }): void {
    this.token = data.token;
    this.vehicleId = data.vehicleId;
  }

  create(): void {
    this.add.text(640, 200, 'MIDVILLE', {
      color: '#ff4444', fontSize: '36px', fontFamily: 'monospace', fontStyle: 'bold'
    }).setOrigin(0.5);

    this.add.text(640, 260, 'A dusty town on the autoduel circuit', {
      color: '#888888', fontSize: '16px', fontFamily: 'monospace'
    }).setOrigin(0.5);

    const garageBtn = this.add.text(640, 360, '[ GARAGE ]', {
      color: '#00ff88', fontSize: '24px', fontFamily: 'monospace',
      backgroundColor: '#003322', padding: { x: 20, y: 10 }
    }).setOrigin(0.5).setInteractive();
    garageBtn.on('pointerdown', () => this.scene.start('GarageScene', { token: this.token }));

    const arenaBtn = this.add.text(640, 450, '[ DRIVE TO ARENA ]', {
      color: '#ff4444', fontSize: '20px', fontFamily: 'monospace',
      backgroundColor: '#220000', padding: { x: 16, y: 8 }
    }).setOrigin(0.5).setInteractive();
    arenaBtn.on('pointerdown', () => {
      this.scene.start('ArenaScene', { token: this.token, vehicleId: this.vehicleId });
    });
  }
}
