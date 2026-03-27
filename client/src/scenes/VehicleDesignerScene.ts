import Phaser from 'phaser';
import type { VehicleLoadout } from '@carwars/shared';
import { calculateLoadoutCost, validateLoadout } from '../ui/DesignerUI';

const CHASSIS_OPTIONS = ['compact', 'mid', 'van', 'pickup'];
const ENGINE_OPTIONS = ['small', 'medium', 'large', 'super'];
const WEAPON_OPTIONS = ['mg', 'hmg', 'rl', 'laser', 'oil', 'mine'];

export class VehicleDesignerScene extends Phaser.Scene {
  private token = '';
  private loadout: VehicleLoadout = {
    chassisId: 'mid', engineId: 'medium', suspensionId: 'standard',
    tires: [{ id: 't0', blown: false }, { id: 't1', blown: false },
            { id: 't2', blown: false }, { id: 't3', blown: false }],
    mounts: [{ id: 'm0', arc: 'front', weaponId: 'mg', ammo: 50 }],
    armor: { front: 6, back: 4, left: 4, right: 4, top: 2, underbody: 2 },
    totalCost: 0
  };
  private nameInput = 'My Car';
  private statusText!: Phaser.GameObjects.Text;

  constructor() { super({ key: 'VehicleDesignerScene' }); }

  init(data: { token: string }): void {
    this.token = data.token;
  }

  create(): void {
    this.add.text(640, 30, 'VEHICLE DESIGNER', {
      color: '#ff4444', fontSize: '28px', fontFamily: 'monospace', fontStyle: 'bold'
    }).setOrigin(0.5);

    // Chassis selector
    this.add.text(100, 100, 'Chassis:', { color: '#cccccc', fontSize: '16px', fontFamily: 'monospace' });
    CHASSIS_OPTIONS.forEach((id, i) => {
      const btn = this.add.text(100 + i * 120, 125, id, {
        color: this.loadout.chassisId === id ? '#00ff88' : '#888888',
        fontSize: '14px', fontFamily: 'monospace',
        backgroundColor: '#222233', padding: { x: 8, y: 4 }
      }).setInteractive();
      btn.on('pointerdown', () => {
        this.loadout.chassisId = id;
        this.scene.restart({ token: this.token });
      });
    });

    // Engine selector
    this.add.text(100, 170, 'Engine:', { color: '#cccccc', fontSize: '16px', fontFamily: 'monospace' });
    ENGINE_OPTIONS.forEach((id, i) => {
      const btn = this.add.text(100 + i * 130, 195, id, {
        color: this.loadout.engineId === id ? '#00ff88' : '#888888',
        fontSize: '14px', fontFamily: 'monospace',
        backgroundColor: '#222233', padding: { x: 8, y: 4 }
      }).setInteractive();
      btn.on('pointerdown', () => {
        this.loadout.engineId = id;
        this.scene.restart({ token: this.token });
      });
    });

    // Weapon selector
    this.add.text(100, 250, 'Weapon (front mount):', { color: '#cccccc', fontSize: '16px', fontFamily: 'monospace' });
    WEAPON_OPTIONS.forEach((id, i) => {
      const x = 100 + (i % 3) * 160;
      const y = 275 + Math.floor(i / 3) * 35;
      const currentWeapon = this.loadout.mounts[0]?.weaponId;
      const btn = this.add.text(x, y, id, {
        color: currentWeapon === id ? '#00ff88' : '#888888',
        fontSize: '14px', fontFamily: 'monospace',
        backgroundColor: '#222233', padding: { x: 8, y: 4 }
      }).setInteractive();
      btn.on('pointerdown', () => {
        this.loadout.mounts = [{ id: 'm0', arc: 'front', weaponId: id, ammo: 50 }];
        this.scene.restart({ token: this.token });
      });
    });

    // Cost display
    const cost = calculateLoadoutCost(this.loadout);
    this.loadout.totalCost = cost;
    this.add.text(640, 500, `Cost: $${cost.toLocaleString()}`, {
      color: '#ffcc00', fontSize: '20px', fontFamily: 'monospace'
    }).setOrigin(0.5);

    this.statusText = this.add.text(640, 550, '', {
      color: '#ff4444', fontSize: '14px', fontFamily: 'monospace'
    }).setOrigin(0.5);

    // Save button
    const saveBtn = this.add.text(640, 610, '[ BUILD THIS CAR ]', {
      color: '#00ff88', fontSize: '20px', fontFamily: 'monospace',
      backgroundColor: '#003322', padding: { x: 16, y: 8 }
    }).setOrigin(0.5).setInteractive();
    saveBtn.on('pointerdown', () => this.saveVehicle());

    // Back button
    const backBtn = this.add.text(100, 680, '[ BACK ]', {
      color: '#888888', fontSize: '16px', fontFamily: 'monospace'
    }).setInteractive();
    backBtn.on('pointerdown', () => this.scene.start('GarageScene', { token: this.token }));
  }

  private async saveVehicle(): Promise<void> {
    const errors = validateLoadout(this.loadout);
    if (errors.length) {
      this.statusText.setText(errors[0]);
      return;
    }
    try {
      const host = window.location.hostname;
      const res = await fetch(`http://${host}:3001/api/vehicles`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({ name: this.nameInput, loadout: this.loadout })
      });
      if (res.ok) {
        this.statusText.setColor('#00ff88').setText('Vehicle created!');
        this.time.delayedCall(1500, () => this.scene.start('GarageScene', { token: this.token }));
      } else {
        const err = await res.json();
        this.statusText.setText(err.error ?? 'Save failed');
      }
    } catch {
      this.statusText.setText('Network error');
    }
  }
}
