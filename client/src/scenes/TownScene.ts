import Phaser from 'phaser';
import { bindFullscreenToggle, onLayout } from '../ui/responsive';

interface GarageStatus {
  owned: boolean;
  cost?: number;
  vehicleCount: number;
  maxVehicles: number;
  repairDiscount?: number;
  accumulatedIncome?: number;
  incomeThisVisit?: number;
}

export class TownScene extends Phaser.Scene {
  private token = '';
  private vehicleId = '';
  private money = 0;
  private garage: GarageStatus | null = null;
  private titleText!: Phaser.GameObjects.Text;
  private subtitleText!: Phaser.GameObjects.Text;
  private garageBtn!: Phaser.GameObjects.Text;
  private arenaBtn!: Phaser.GameObjects.Text;
  // Garage-bay UI — exactly one of these is created depending on ownership.
  private garageBayBtn?: Phaser.GameObjects.Text;
  private garageStatusText?: Phaser.GameObjects.Text;

  constructor() { super({ key: 'TownScene' }); }

  init(data: { zoneId: string; token: string; vehicleId: string }): void {
    this.token = data.token;
    this.vehicleId = data.vehicleId;
  }

  async create(): Promise<void> {
    const host = window.location.hostname;
    // Visiting town resolves garage passive income lazily (server-side on GET).
    const [meRes, gRes] = await Promise.all([
      fetch(`http://${host}:3001/api/me`, { headers: { Authorization: `Bearer ${this.token}` } }),
      fetch(`http://${host}:3001/api/garages`, { headers: { Authorization: `Bearer ${this.token}` } }),
    ]);
    const me = await meRes.json();
    this.money = me.money ?? 0;
    if (gRes.ok) this.garage = await gRes.json();

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

    this.buildGarageBayUi();

    bindFullscreenToggle(this);
    onLayout(this, () => this.layout());
  }

  private buildGarageBayUi(): void {
    if (this.garage?.owned) {
      const discountPct = Math.round((this.garage.repairDiscount ?? 0) * 100);
      const earned = this.garage.incomeThisVisit ?? 0;
      const lines = [
        `YOUR GARAGE — Storage ${this.garage.vehicleCount}/${this.garage.maxVehicles} · ${discountPct}% repair discount`,
        `Total passive income: $${(this.garage.accumulatedIncome ?? 0).toLocaleString()}` +
          (earned > 0 ? `   (+$${earned.toLocaleString()} collected)` : ''),
      ];
      this.garageStatusText = this.add.text(0, 0, lines.join('\n'), {
        color: '#ffcc00', fontSize: '14px', fontFamily: 'monospace', align: 'center',
      }).setOrigin(0.5);
    } else {
      const cost = this.garage?.cost ?? 50000;
      this.garageBayBtn = this.add.text(0, 0, `[ BUY GARAGE BAY — $${cost.toLocaleString()} ]`, {
        color: '#ffcc00', fontSize: '18px', fontFamily: 'monospace',
        backgroundColor: '#332200', padding: { x: 16, y: 8 },
      }).setOrigin(0.5).setInteractive();
      this.garageBayBtn.on('pointerdown', () => this.purchaseGarage());
    }
  }

  private async purchaseGarage(): Promise<void> {
    const host = window.location.hostname;
    const cost = this.garage?.cost ?? 50000;
    if (this.money < cost) {
      this.garageBayBtn?.setText('[ NOT ENOUGH MONEY ]').setColor('#ff6666');
      return;
    }
    const res = await fetch(`http://${host}:3001/api/garages/purchase`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.token}` },
    });
    if (res.ok) {
      this.scene.restart({ zoneId: 'midville', token: this.token, vehicleId: this.vehicleId });
    } else {
      const err = await res.json().catch(() => ({}));
      this.garageBayBtn?.setText(`[ ${err.error ?? 'PURCHASE FAILED'} ]`).setColor('#ff6666');
    }
  }

  private layout(): void {
    const { width, height } = this.scale;
    const cx = width / 2;
    this.titleText.setPosition(cx, height * 0.24);
    this.subtitleText.setPosition(cx, height * 0.32);
    this.garageBtn.setPosition(cx, height * 0.46);
    this.arenaBtn.setPosition(cx, height * 0.58);
    this.garageBayBtn?.setPosition(cx, height * 0.72);
    this.garageStatusText?.setPosition(cx, height * 0.72);
  }
}
