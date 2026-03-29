import Phaser from 'phaser';

interface Vehicle { id: string; name: string; value: number; damage_state: any; loadout: any; }

export class GarageScene extends Phaser.Scene {
  private token = '';
  private vehicles: Vehicle[] = [];
  private money = 0;
  private lastResult: { prize: number; jobPayout: number } | null = null;

  constructor() { super({ key: 'GarageScene' }); }

  init(data: { token: string; lastResult?: { prize: number; jobPayout: number } | null }): void {
    this.token = data.token;
    this.lastResult = data.lastResult ?? null;
  }

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

    if (this.lastResult) {
      const total = this.lastResult.prize + this.lastResult.jobPayout;
      this.add.text(640, 55, `Last fight: +$${total.toLocaleString()} earned`, {
        color: '#00ff88', fontSize: '14px', fontFamily: 'monospace'
      }).setOrigin(0.5);
    }

    const activeJobId = localStorage.getItem('cw_active_job');
    const activeJobDesc = localStorage.getItem('cw_active_job_desc');
    const activeJobPayout = localStorage.getItem('cw_active_job_payout');
    if (activeJobId && activeJobDesc) {
      this.add.text(100, 92, `Active job: ${activeJobDesc} — $${Number(activeJobPayout).toLocaleString()} on win`, {
        color: '#ffcc00', fontSize: '13px', fontFamily: 'monospace'
      });
    }

    if (this.vehicles.length === 0) {
      this.add.text(640, 300, 'No vehicles. Build one!', {
        color: '#888888', fontSize: '18px', fontFamily: 'monospace'
      }).setOrigin(0.5);
    } else {
      this.vehicles.forEach((v, i) => {
        const y = 140 + i * 80;
        const ds = v.damage_state ?? {};
        const isDestroyed = ds.destroyed;
        const nameColor = isDestroyed ? '#ff4444' : '#00ff88';

        // Line 1: name + value
        this.add.text(100, y, `${v.name}`, { color: nameColor, fontSize: '16px', fontFamily: 'monospace' });
        this.add.text(370, y, `$${v.value.toLocaleString()}`, { color: '#888888', fontSize: '14px', fontFamily: 'monospace' });

        // Line 2: ammo + tire status
        const mounts: any[] = v.loadout?.mounts ?? [];
        const ammoStr = mounts.length
          ? mounts.map((m: any) => `${m.weaponId ?? '?'}:${m.ammo}`).join(' ')
          : 'no weapons';
        const tiresBlow = ds.tiresBlown?.length ?? 0;
        const tireStr = tiresBlow > 0 ? `  [${tiresBlow} TIRE${tiresBlow > 1 ? 'S' : ''} BLOWN]` : '';
        const engineStr = ds.engineDamaged ? '  [ENGINE]' : '';
        this.add.text(100, y + 20, `${ammoStr}${tireStr}${engineStr}`, {
          color: '#666666', fontSize: '11px', fontFamily: 'monospace'
        });

        // [REPAIR] button
        const repairBtn = this.add.text(600, y, '[REPAIR]', {
          color: '#ffcc00', fontSize: '13px', fontFamily: 'monospace',
          backgroundColor: '#332200', padding: { x: 5, y: 2 }
        }).setInteractive();
        repairBtn.on('pointerdown', () => this.repairVehicle(v.id));

        // [FIGHT] or [DESTROYED]
        const fightBtn = this.add.text(690, y, isDestroyed ? '[DESTROYED]' : '[FIGHT]', {
          color: isDestroyed ? '#444444' : '#00ff88',
          fontSize: '13px', fontFamily: 'monospace',
          backgroundColor: isDestroyed ? '#221111' : '#003322',
          padding: { x: 5, y: 2 }
        });
        if (!isDestroyed) {
          fightBtn.setInteractive();
          fightBtn.on('pointerdown', () => {
            const activeJobId = localStorage.getItem('cw_active_job') ?? undefined;
            this.scene.start('ArenaScene', { token: this.token, vehicleId: v.id, jobId: activeJobId });
          });
        }

        // [SELL] button
        const sellBtn = this.add.text(800, y, '[SELL]', {
          color: '#ff8844', fontSize: '13px', fontFamily: 'monospace',
          backgroundColor: '#221100', padding: { x: 5, y: 2 }
        }).setInteractive();
        sellBtn.on('pointerdown', () => this.sellVehicle(v.id, v.name));
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

  private async sellVehicle(vehicleId: string, name: string): Promise<void> {
    if (!confirm(`Sell ${name} for 50% value?`)) return;
    const host = window.location.hostname;
    const res = await fetch(`http://${host}:3001/api/vehicles/${vehicleId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.token}` }
    });
    const body = await res.json();
    if (res.ok) {
      this.scene.restart({ token: this.token });
    } else {
      this.add.text(640, 650, body.error ?? 'Sell failed', {
        color: '#ff4444', fontSize: '14px', fontFamily: 'monospace'
      }).setOrigin(0.5);
    }
  }
}
