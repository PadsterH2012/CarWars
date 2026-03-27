import Phaser from 'phaser';

export class TownScene extends Phaser.Scene {
  private token = '';
  private vehicleId = '';

  constructor() { super({ key: 'TownScene' }); }

  init(data: { zoneId: string; token: string; vehicleId: string }): void {
    this.token = data.token;
    this.vehicleId = data.vehicleId;
    console.log('Entered town', data.zoneId);
  }

  create(): void {
    this.add.text(640, 360, 'TOWN — Coming in Task 13', {
      color: '#ffffff', fontSize: '24px', fontFamily: 'monospace'
    }).setOrigin(0.5);

    // Press E to return to arena
    this.input.keyboard!.once('keydown-E', () => {
      this.scene.start('ArenaScene', { token: this.token, vehicleId: this.vehicleId });
    });
  }
}
