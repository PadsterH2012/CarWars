import Phaser from 'phaser';

interface Vehicle { id: string; name: string; value: number; damage_state: any; }

export class GarageScene extends Phaser.Scene {
  private token = '';
  private vehicles: Vehicle[] = [];
  private money = 0;

  constructor() { super({ key: 'GarageScene' }); }

  init(data: { token: string }): void { this.token = data.token; }

  async create(): Promise<void> {
    const host = window.location.hostname;

    // Load player data
    const [meRes, vRes] = await Promise.all([
      fetch(`http://${host}:3001/api/me`, { headers: { Authorization: `Bearer ${this.token}` } }),
      fetch(`http://${host}:3001/api/vehicles`, { headers: { Authorization: `Bearer ${this.token}` } })
    ]);
    const me = await meRes.json();
    this.money = me.money ?? 0;
    this.vehicles = await vRes.json();

    this.add.text(640, 30, 'GARAGE', {
      color: '#ff4444', fontSize: '28px', fontFamily: 'monospace', fontStyle: 'bold'
    }).setOrigin(0.5);

    this.add.text(100, 70, `Money: $${this.money.toLocaleString()} | Division: ${me.division}`, {
      color: '#ffcc00', fontSize: '16px', fontFamily: 'monospace'
    });

    if (this.vehicles.length === 0) {
      this.add.text(640, 300, 'No vehicles. Build one!', {
        color: '#888888', fontSize: '18px', fontFamily: 'monospace'
      }).setOrigin(0.5);
    } else {
      this.vehicles.forEach((v, i) => {
        const y = 140 + i * 60;
        const color = v.damage_state?.destroyed ? '#ff4444' : '#00ff88';
        this.add.text(100, y, `${v.name}  $${v.value.toLocaleString()}`, {
          color, fontSize: '16px', fontFamily: 'monospace'
        });
        // Repair button
        const repairBtn = this.add.text(500, y, '[REPAIR]', {
          color: '#ffcc00', fontSize: '14px', fontFamily: 'monospace',
          backgroundColor: '#332200', padding: { x: 6, y: 3 }
        }).setInteractive();
        repairBtn.on('pointerdown', () => this.repairVehicle(v.id));

        // Enter arena button
        const arenaBtn = this.add.text(620, y, '[FIGHT]', {
          color: '#00ff88', fontSize: '14px', fontFamily: 'monospace',
          backgroundColor: '#003322', padding: { x: 6, y: 3 }
        }).setInteractive();
        arenaBtn.on('pointerdown', () => {
          this.scene.start('ArenaScene', { token: this.token, vehicleId: v.id });
        });
      });
    }

    // Nav buttons
    const buildBtn = this.add.text(100, 600, '[BUILD NEW CAR]', {
      color: '#aaaaff', fontSize: '16px', fontFamily: 'monospace',
      backgroundColor: '#111133', padding: { x: 8, y: 4 }
    }).setInteractive();
    buildBtn.on('pointerdown', () => this.scene.start('VehicleDesignerScene', { token: this.token }));

    const jobsBtn = this.add.text(400, 600, '[JOB BOARD]', {
      color: '#ffaaaa', fontSize: '16px', fontFamily: 'monospace',
      backgroundColor: '#331111', padding: { x: 8, y: 4 }
    }).setInteractive();
    jobsBtn.on('pointerdown', () => this.scene.start('JobBoardScene', { token: this.token }));
  }

  private async repairVehicle(vehicleId: string): Promise<void> {
    const host = window.location.hostname;
    const res = await fetch(`http://${host}:3001/api/economy/repair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ vehicleId })
    });
    const body = await res.json();
    if (res.ok) {
      this.scene.restart({ token: this.token });
    } else {
      // Show error
      this.add.text(640, 650, body.error ?? 'Repair failed', {
        color: '#ff4444', fontSize: '14px', fontFamily: 'monospace'
      }).setOrigin(0.5);
    }
  }
}
