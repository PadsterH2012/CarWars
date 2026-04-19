import Phaser from 'phaser';

interface Vehicle { id: string; name: string; value: number; damage_state: any; loadout: any; in_arena?: boolean; }
interface Driver { id: string; name: string; skill: number; assigned_vehicle_id: string | null; alive: boolean; }

export class GarageScene extends Phaser.Scene {
  private token = '';
  private vehicles: Vehicle[] = [];
  private drivers: Driver[] = [];
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
    const [meRes, vRes, dRes] = await Promise.all([
      fetch(`http://${host}:3001/api/me`, { headers: { Authorization: `Bearer ${this.token}` } }),
      fetch(`http://${host}:3001/api/vehicles`, { headers: { Authorization: `Bearer ${this.token}` } }),
      fetch(`http://${host}:3001/api/drivers`, { headers: { Authorization: `Bearer ${this.token}` } })
    ]);
    const me = await meRes.json();
    this.money = me.money ?? 0;
    this.vehicles = await vRes.json();
    this.drivers = await dRes.json();

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
          fightBtn.on('pointerdown', () => this.showSquadModal(v.id));
        }

        // [SELL] button
        const sellBtn = this.add.text(830, y, '[SELL]', {
          color: '#ff8844', fontSize: '13px', fontFamily: 'monospace',
          backgroundColor: '#221100', padding: { x: 5, y: 2 }
        }).setInteractive();
        sellBtn.on('pointerdown', () => this.sellVehicle(v.id, v.name));
      });
    }

    // Map picker — always visible on the main garage so solo fights and squads
    // both pick a map. Selection persists via localStorage.
    const MAPS = [
      { id: 'truck-stop',  label: 'Truck Stop' },
      { id: 'town-square', label: 'Town Square' },
      { id: 'open',        label: 'Open Arena' },
    ];
    let selectedMap = localStorage.getItem('cw_selected_map') ?? 'truck-stop';
    if (!MAPS.find(m => m.id === selectedMap)) selectedMap = 'truck-stop';

    this.add.text(100, 540, 'ARENA:', {
      color: '#aaa', fontSize: '13px', fontFamily: 'monospace', fontStyle: 'bold'
    });
    const mapButtons: Phaser.GameObjects.Text[] = [];
    const refreshMapButtons = () => {
      mapButtons.forEach((btn, i) => {
        const isSel = MAPS[i].id === selectedMap;
        btn.setColor(isSel ? '#00ff88' : '#888');
        btn.setBackgroundColor(isSel ? '#003322' : '#111122');
      });
    };
    MAPS.forEach((m, i) => {
      const btn = this.add.text(180 + i * 130, 538, m.label, {
        fontSize: '13px', fontFamily: 'monospace',
        padding: { x: 6, y: 4 },
      }).setInteractive();
      btn.on('pointerdown', () => {
        selectedMap = m.id;
        localStorage.setItem('cw_selected_map', selectedMap);
        refreshMapButtons();
      });
      mapButtons.push(btn);
    });
    refreshMapButtons();

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

  private showSquadModal(primaryId: string): void {
    // Eligible = not destroyed AND has an assigned alive driver AND not already in another arena
    const driverByVehicleId = new Map<string, Driver>();
    for (const d of this.drivers) {
      if (d.alive && d.assigned_vehicle_id) driverByVehicleId.set(d.assigned_vehicle_id, d);
    }
    const eligible = this.vehicles.filter(v =>
      !v.damage_state?.destroyed && !v.in_arena && driverByVehicleId.has(v.id)
    );
    if (!eligible.find(v => v.id === primaryId)) {
      // Primary has no driver or is otherwise ineligible — launch solo as fallback
      const lastMap = localStorage.getItem('cw_selected_map') ?? 'truck-stop';
      this.launchArena([primaryId], lastMap);
      return;
    }

    const selected = new Set<string>([primaryId]);
    const MAX_SQUAD = 4;

    // Dim overlay + modal bg
    const overlay = this.add.rectangle(640, 360, 1280, 720, 0x000000, 0.75).setDepth(30).setInteractive();
    const panel   = this.add.rectangle(640, 360, 640, 460, 0x111122, 0.98).setDepth(31).setStrokeStyle(2, 0x4466aa);
    const title   = this.add.text(640, 160, 'BUILD SQUAD', {
      color: '#ffcc00', fontSize: '22px', fontFamily: 'monospace', fontStyle: 'bold'
    }).setOrigin(0.5).setDepth(32);
    const hint    = this.add.text(640, 192, `Select up to ${MAX_SQUAD} — primary auto-highlighted`, {
      color: '#888', fontSize: '12px', fontFamily: 'monospace'
    }).setOrigin(0.5).setDepth(32);

    const created: Phaser.GameObjects.GameObject[] = [overlay, panel, title, hint];

    // Row per eligible vehicle
    eligible.slice(0, 8).forEach((v, i) => {
      const y = 230 + i * 36;
      const driver = driverByVehicleId.get(v.id)!;
      const isPrimary = v.id === primaryId;

      const rowBg = this.add.rectangle(640, y, 580, 30, 0x222233, 1).setDepth(32).setInteractive();
      const marker = this.add.text(370, y, '[X]', {
        color: '#00ff88', fontSize: '14px', fontFamily: 'monospace'
      }).setOrigin(0, 0.5).setDepth(33);
      const label = this.add.text(410, y, `${v.name}${isPrimary ? '  (PRIMARY)' : ''}`, {
        color: isPrimary ? '#00ff88' : '#cccccc', fontSize: '13px', fontFamily: 'monospace'
      }).setOrigin(0, 0.5).setDepth(33);
      const driverLabel = this.add.text(820, y, `Driver: ${driver.name} (skill ${driver.skill})`, {
        color: '#888', fontSize: '11px', fontFamily: 'monospace'
      }).setOrigin(1, 0.5).setDepth(33);

      const refreshVisual = () => {
        const on = selected.has(v.id);
        marker.setText(on ? '[X]' : '[ ]');
        marker.setColor(on ? '#00ff88' : '#666');
        rowBg.setFillStyle(on ? 0x223322 : 0x222233);
      };
      refreshVisual();

      rowBg.on('pointerdown', () => {
        if (isPrimary) return;  // primary can't be deselected
        if (selected.has(v.id)) {
          selected.delete(v.id);
        } else if (selected.size < MAX_SQUAD) {
          selected.add(v.id);
        }
        refreshVisual();
      });
      created.push(rowBg, marker, label, driverLabel);
    });

    // Show the current arena choice as a reminder (picker lives on main garage)
    const currentMap = localStorage.getItem('cw_selected_map') ?? 'truck-stop';
    const mapNote = this.add.text(640, 510, `Arena: ${currentMap}   (change on garage screen)`, {
      color: '#888', fontSize: '11px', fontFamily: 'monospace'
    }).setOrigin(0.5).setDepth(33);
    created.push(mapNote);

    // Fight + Cancel buttons
    const fightBtn = this.add.text(540, 555, '[FIGHT WITH SQUAD]', {
      color: '#00ff88', fontSize: '14px', fontFamily: 'monospace',
      backgroundColor: '#003322', padding: { x: 8, y: 4 }
    }).setOrigin(0.5).setDepth(33).setInteractive();
    const cancelBtn = this.add.text(760, 555, '[CANCEL]', {
      color: '#888', fontSize: '14px', fontFamily: 'monospace',
      backgroundColor: '#221122', padding: { x: 8, y: 4 }
    }).setOrigin(0.5).setDepth(33).setInteractive();

    const destroy = () => created.concat([fightBtn, cancelBtn]).forEach(o => o.destroy());
    cancelBtn.on('pointerdown', destroy);
    fightBtn.on('pointerdown', () => {
      const ids = [primaryId, ...[...selected].filter(id => id !== primaryId)];
      const mapId = localStorage.getItem('cw_selected_map') ?? 'truck-stop';
      destroy();
      this.launchArena(ids, mapId);
    });

    created.push(fightBtn, cancelBtn);
  }

  private launchArena(squadVehicleIds: string[], mapId: string = 'truck-stop'): void {
    const activeJobId = localStorage.getItem('cw_active_job') ?? undefined;
    this.scene.start('ArenaScene', {
      token: this.token,
      vehicleId: squadVehicleIds[0],
      squadVehicleIds,
      jobId: activeJobId,
      mapId,
    });
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
