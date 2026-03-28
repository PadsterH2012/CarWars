import Phaser from 'phaser';
import {
  BODY_TYPES, POWER_PLANTS, SUSPENSIONS, TIRE_TYPES, ARMOR_TYPES, WEAPONS, ARCS,
  type MountConfig, type ArcType,
} from '../ui/DesignerUI';

const SEL_COLOR   = '#00ff88';
const SEL_BG      = '#003322';
const UNSEL_COLOR = '#888888';
const UNSEL_BG    = '#222233';
const LABEL_COLOR = '#aaaaaa';
const HEADING_COLOR = '#ff4444';

const BTN_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontSize: '12px', fontFamily: 'monospace',
  backgroundColor: UNSEL_BG, padding: { x: 6, y: 3 },
};

const LABEL_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontSize: '13px', fontFamily: 'monospace', color: LABEL_COLOR,
};

const STAT_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontSize: '13px', fontFamily: 'monospace', color: '#cccccc',
};

export class VehicleDesignerScene extends Phaser.Scene {
  private token = '';

  // State
  private bodyType      = 'mid_sized';
  private powerPlantType = 'medium';
  private suspensionType = 'standard';
  private tireType      = 'standard';
  private armorType     = 'ablative';
  private mounts: MountConfig[] = [
    { id: 'm0', arc: 'front', weaponId: 'mg', ammo: 50 },
  ];
  private armor = { front: 20, back: 15, left: 15, right: 15 };
  private vehicleName   = 'My Car';
  private derivedCost   = 0;

  // Button maps for in-place updates
  private bodyBtns       = new Map<string, Phaser.GameObjects.Text>();
  private powerBtns      = new Map<string, Phaser.GameObjects.Text>();
  private suspBtns       = new Map<string, Phaser.GameObjects.Text>();
  private tireBtns       = new Map<string, Phaser.GameObjects.Text>();
  private armorTypeBtns  = new Map<string, Phaser.GameObjects.Text>();
  private weaponBtns     = new Map<string, Phaser.GameObjects.Text>();
  private arcBtns        = new Map<string, Phaser.GameObjects.Text>();

  // Armor value texts
  private armorTexts = new Map<string, Phaser.GameObjects.Text>();

  // Stats panel texts
  private statsSpeedText!:  Phaser.GameObjects.Text;
  private statsAccelText!:  Phaser.GameObjects.Text;
  private statsHcText!:     Phaser.GameObjects.Text;
  private statsWeightText!: Phaser.GameObjects.Text;
  private statsCostText!:   Phaser.GameObjects.Text;
  private statusText!:      Phaser.GameObjects.Text;

  constructor() { super({ key: 'VehicleDesignerScene' }); }

  init(data: { token?: string }): void {
    this.token = data.token ?? '';
  }

  create(): void {
    // Background
    this.add.rectangle(640, 360, 1280, 720, 0x111122);

    // Title
    this.add.text(640, 25, 'VEHICLE DESIGNER', {
      color: HEADING_COLOR, fontSize: '24px', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);

    this.buildLeftPanel();
    this.buildWeaponsPanel();
    this.buildRightPanel();
    this.buildBottomButtons();

    // Trigger initial stats fetch
    this.refreshStats();
  }

  // ─── LEFT PANEL (x=10..430) ──────────────────────────────────────────────

  private buildLeftPanel(): void {
    let y = 55;
    const x0 = 10;

    // Body Type
    this.add.text(x0, y, 'Body Type:', LABEL_STYLE);
    y += 18;
    y = this.buildOptionGrid(BODY_TYPES, x0, y, 3, this.bodyBtns, () => this.bodyType,
      (id) => { this.bodyType = id; this.updateOptionBtns(this.bodyBtns, () => this.bodyType); this.refreshStats(); });

    y += 6;
    // Power Plant
    this.add.text(x0, y, 'Power Plant:', LABEL_STYLE);
    y += 18;
    y = this.buildOptionGrid(POWER_PLANTS, x0, y, 3, this.powerBtns, () => this.powerPlantType,
      (id) => { this.powerPlantType = id; this.updateOptionBtns(this.powerBtns, () => this.powerPlantType); this.refreshStats(); });

    y += 6;
    // Suspension
    this.add.text(x0, y, 'Suspension:', LABEL_STYLE);
    y += 18;
    y = this.buildOptionGrid(SUSPENSIONS, x0, y, 3, this.suspBtns, () => this.suspensionType,
      (id) => { this.suspensionType = id; this.updateOptionBtns(this.suspBtns, () => this.suspensionType); this.refreshStats(); });

    y += 6;
    // Tires
    this.add.text(x0, y, 'Tires:', LABEL_STYLE);
    y += 18;
    y = this.buildOptionGrid(TIRE_TYPES, x0, y, 3, this.tireBtns, () => this.tireType,
      (id) => { this.tireType = id; this.updateOptionBtns(this.tireBtns, () => this.tireType); this.refreshStats(); });

    y += 6;
    // Armor Type
    this.add.text(x0, y, 'Armor Type:', LABEL_STYLE);
    y += 18;
    this.buildOptionGrid(ARMOR_TYPES, x0, y, 3, this.armorTypeBtns, () => this.armorType,
      (id) => { this.armorType = id; this.updateOptionBtns(this.armorTypeBtns, () => this.armorType); this.refreshStats(); });
  }

  /**
   * Lay out option buttons in a grid of `cols` columns.
   * Returns the y position after the last row.
   */
  private buildOptionGrid<T extends { id: string; label: string }>(
    options: readonly T[],
    x0: number,
    y: number,
    cols: number,
    btnMap: Map<string, Phaser.GameObjects.Text>,
    getCurrent: () => string,
    onSelect: (id: string) => void,
  ): number {
    const colWidth = 138;
    const rowHeight = 28;
    let maxRow = 0;

    options.forEach(({ id, label }, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      maxRow = Math.max(maxRow, row);
      const bx = x0 + col * colWidth;
      const by = y + row * rowHeight;
      const isSelected = getCurrent() === id;
      const btn = this.add.text(bx, by, label, {
        ...BTN_STYLE,
        color: isSelected ? SEL_COLOR : UNSEL_COLOR,
        backgroundColor: isSelected ? SEL_BG : UNSEL_BG,
      }).setInteractive();
      btn.on('pointerdown', () => onSelect(id));
      btnMap.set(id, btn);
    });

    return y + (maxRow + 1) * rowHeight;
  }

  private updateOptionBtns(btnMap: Map<string, Phaser.GameObjects.Text>, getCurrent: () => string): void {
    btnMap.forEach((btn, id) => {
      const selected = getCurrent() === id;
      btn.setColor(selected ? SEL_COLOR : UNSEL_COLOR);
      btn.setBackgroundColor(selected ? SEL_BG : UNSEL_BG);
    });
  }

  // ─── CENTER WEAPONS PANEL (x=440..770) ───────────────────────────────────

  private buildWeaponsPanel(): void {
    const x0 = 440;
    let y = 55;

    this.add.text(x0 + 130, y, 'WEAPONS', {
      color: HEADING_COLOR, fontSize: '14px', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);
    y += 20;

    const colWidth = 165;
    const rowHeight = 28;

    WEAPONS.forEach(({ id, label }, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const bx = x0 + col * colWidth;
      const by = y + row * rowHeight;

      const isActive = this.mounts.some(m => m.weaponId === id);

      // Weapon label button
      const wBtn = this.add.text(bx, by, label, {
        ...BTN_STYLE,
        color: isActive ? SEL_COLOR : '#555555',
        backgroundColor: isActive ? SEL_BG : UNSEL_BG,
      }).setInteractive();
      wBtn.on('pointerdown', () => this.toggleWeapon(id));
      this.weaponBtns.set(id, wBtn);

      // Arc button (only meaningful when active, always shown for layout)
      const mount = this.mounts.find(m => m.weaponId === id);
      const arcLabel = mount ? `▸${mount.arc.charAt(0).toUpperCase()}` : '  ';
      const arcBtn = this.add.text(bx + 82, by, arcLabel, {
        ...BTN_STYLE,
        color: isActive ? '#ffcc00' : '#333333',
        backgroundColor: isActive ? '#332200' : '#1a1a2e',
      }).setInteractive();
      arcBtn.on('pointerdown', () => this.cycleArc(id));
      this.arcBtns.set(id, arcBtn);
    });
  }

  private toggleWeapon(weaponId: string): void {
    const mountIdx = this.mounts.findIndex(m => m.weaponId === weaponId);
    if (mountIdx >= 0) {
      // Remove
      this.mounts.splice(mountIdx, 1);
    } else {
      if (this.mounts.length >= 3) {
        this.statusText.setColor('#ff4444').setText('Max 3 weapons');
        return;
      }
      const newMount: MountConfig = {
        id: `m${Date.now()}`,
        arc: 'front',
        weaponId,
        ammo: 50,
      };
      this.mounts.push(newMount);
    }
    this.updateWeaponButtons();
    this.refreshStats();
  }

  private cycleArc(weaponId: string): void {
    const mount = this.mounts.find(m => m.weaponId === weaponId);
    if (!mount) return;
    const currentIdx = ARCS.indexOf(mount.arc);
    mount.arc = ARCS[(currentIdx + 1) % ARCS.length] as ArcType;
    this.updateWeaponButtons();
    this.refreshStats();
  }

  private updateWeaponButtons(): void {
    WEAPONS.forEach(({ id }) => {
      const wBtn = this.weaponBtns.get(id);
      const arcBtn = this.arcBtns.get(id);
      if (!wBtn || !arcBtn) return;

      const mount = this.mounts.find(m => m.weaponId === id);
      const isActive = !!mount;

      wBtn.setColor(isActive ? SEL_COLOR : '#555555');
      wBtn.setBackgroundColor(isActive ? SEL_BG : UNSEL_BG);

      arcBtn.setText(isActive ? `▸${mount!.arc.charAt(0).toUpperCase()}` : '  ');
      arcBtn.setColor(isActive ? '#ffcc00' : '#333333');
      arcBtn.setBackgroundColor(isActive ? '#332200' : '#1a1a2e');
    });
  }

  // ─── RIGHT PANEL (x=780..1270) ────────────────────────────────────────────

  private buildRightPanel(): void {
    const x0 = 790;
    let y = 55;

    // Stats section
    this.add.text(x0, y, '── STATS ──', {
      color: HEADING_COLOR, fontSize: '13px', fontFamily: 'monospace',
    });
    y += 22;

    this.statsSpeedText  = this.add.text(x0, y, 'Max Speed:  --',  STAT_STYLE); y += 20;
    this.statsAccelText  = this.add.text(x0, y, 'Accel:      --',  STAT_STYLE); y += 20;
    this.statsHcText     = this.add.text(x0, y, 'HC:         --',  STAT_STYLE); y += 20;
    this.statsWeightText = this.add.text(x0, y, 'Weight:     --',  STAT_STYLE); y += 20;
    this.statsCostText   = this.add.text(x0, y, 'Cost:       --',  STAT_STYLE); y += 30;

    // Armor section
    this.add.text(x0, y, '── ARMOR (pts) ──', {
      color: HEADING_COLOR, fontSize: '13px', fontFamily: 'monospace',
    });
    y += 22;

    type ArmorFace = 'front' | 'back' | 'left' | 'right';
    const armorFaces: Array<{ key: ArmorFace; label: string }> = [
      { key: 'front', label: 'Front' },
      { key: 'back',  label: 'Back ' },
      { key: 'left',  label: 'Left ' },
      { key: 'right', label: 'Right' },
    ];

    armorFaces.forEach(({ key, label }: { key: ArmorFace; label: string }) => {
      this.add.text(x0, y, `${label}:`, STAT_STYLE);

      const minusBtn = this.add.text(x0 + 80, y, '[−]', {
        fontSize: '13px', fontFamily: 'monospace', color: '#ff6666',
        backgroundColor: '#330011', padding: { x: 4, y: 2 },
      }).setInteractive();
      minusBtn.on('pointerdown', () => {
        if (this.armor[key] > 0) { this.armor[key]--; this.updateArmorText(key); this.refreshStats(); }
      });

      const valText = this.add.text(x0 + 120, y, String(this.armor[key]).padStart(2, ' '), STAT_STYLE);
      this.armorTexts.set(key, valText);

      const plusBtn = this.add.text(x0 + 145, y, '[+]', {
        fontSize: '13px', fontFamily: 'monospace', color: '#66ff88',
        backgroundColor: '#002211', padding: { x: 4, y: 2 },
      }).setInteractive();
      plusBtn.on('pointerdown', () => {
        if (this.armor[key] < 99) { this.armor[key]++; this.updateArmorText(key); this.refreshStats(); }
      });

      y += 24;
    });
  }

  private updateArmorText(key: 'front' | 'back' | 'left' | 'right'): void {
    this.armorTexts.get(key)?.setText(String(this.armor[key]).padStart(2, ' '));
  }

  // ─── BOTTOM BUTTONS ───────────────────────────────────────────────────────

  private buildBottomButtons(): void {
    // Status text (shared)
    this.statusText = this.add.text(640, 645, '', {
      fontSize: '13px', fontFamily: 'monospace', color: '#ff4444',
    }).setOrigin(0.5);

    // Back button
    const backBtn = this.add.text(30, 685, '[ BACK ]', {
      color: '#888888', fontSize: '15px', fontFamily: 'monospace',
      backgroundColor: '#222233', padding: { x: 10, y: 5 },
    }).setInteractive();
    backBtn.on('pointerdown', () => this.scene.start('GarageScene', { token: this.token }));

    // Build button
    const buildBtn = this.add.text(640, 685, '[ BUILD THIS CAR ]', {
      color: SEL_COLOR, fontSize: '18px', fontFamily: 'monospace',
      backgroundColor: SEL_BG, padding: { x: 16, y: 6 },
    }).setOrigin(0.5).setInteractive();
    buildBtn.on('pointerdown', () => this.saveVehicle());
  }

  // ─── API CALLS ────────────────────────────────────────────────────────────

  async refreshStats(): Promise<void> {
    this.statsSpeedText.setText('Max Speed:  Calculating...');
    this.statsAccelText.setText('Accel:      ...');
    this.statsHcText.setText('HC:         ...');
    this.statsWeightText.setText('Weight:     ...');
    this.statsCostText.setText('Cost:       ...');

    try {
      const host = window.location.hostname;
      const res = await fetch(`http://${host}:3001/api/vehicles/design`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.buildDesignPayload()),
      });

      if (res.ok) {
        const data = await res.json() as {
          maxSpeed: number;
          acceleration: number;
          handlingClass: number;
          totalWeight: number;
          totalCost: number;
        };
        this.derivedCost = data.totalCost ?? 0;
        this.statsSpeedText.setText(`Max Speed:  ${data.maxSpeed} mph`);
        this.statsAccelText.setText(`Accel:      ${data.acceleration} mph/turn`);
        this.statsHcText.setText(`HC:         ${data.handlingClass}`);
        this.statsWeightText.setText(`Weight:     ${data.totalWeight} lbs`);
        this.statsCostText.setText(`Cost:       $${data.totalCost.toLocaleString()}`);
        // Clear any status message on success
        if (this.statusText.text === 'Max 3 weapons') {
          // keep it until user takes action
        } else {
          this.statusText.setText('');
        }
      } else {
        const err = await res.json() as { error?: string };
        const msg = err.error ?? 'Design error';
        this.statsSpeedText.setColor('#ff4444').setText(msg);
        this.statsAccelText.setText('');
        this.statsHcText.setText('');
        this.statsWeightText.setText('');
        this.statsCostText.setText('');
        // Reset text color after setting error
        this.time.delayedCall(100, () => this.statsSpeedText.setColor('#cccccc'));
      }
    } catch {
      this.statsSpeedText.setText('Network error');
      this.statsAccelText.setText('');
      this.statsHcText.setText('');
      this.statsWeightText.setText('');
      this.statsCostText.setText('');
    }
  }

  private buildDesignPayload() {
    return {
      chassisId:     this.bodyType,
      engineId:      this.powerPlantType,
      suspensionId:  this.suspensionType,
      tires: [
        { id: 't0', blown: false }, { id: 't1', blown: false },
        { id: 't2', blown: false }, { id: 't3', blown: false },
      ],
      mounts: this.mounts,
      armor: { ...this.armor, top: 0, underbody: 0 },
      totalCost: 0,
      bodyType:         this.bodyType,
      powerPlantType:   this.powerPlantType,
      suspensionType:   this.suspensionType,
      tireType:         this.tireType,
      armorType:        this.armorType,
    };
  }

  private async saveVehicle(): Promise<void> {
    this.statusText.setColor('#aaaaaa').setText('Saving...');
    try {
      const host = window.location.hostname;
      const res = await fetch(`http://${host}:3001/api/vehicles`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          name: this.vehicleName,
          loadout: {
            chassisId:     this.bodyType,
            engineId:      this.powerPlantType,
            suspensionId:  this.suspensionType,
            tires: [
              { id: 't0', blown: false }, { id: 't1', blown: false },
              { id: 't2', blown: false }, { id: 't3', blown: false },
            ],
            mounts: this.mounts,
            armor: { ...this.armor, top: 0, underbody: 0 },
            totalCost: this.derivedCost,
            bodyType:       this.bodyType,
            powerPlantType: this.powerPlantType,
            suspensionType: this.suspensionType,
            tireType:       this.tireType,
            armorType:      this.armorType,
          },
        }),
      });

      if (res.ok) {
        this.statusText.setColor(SEL_COLOR).setText('Vehicle created!');
        this.time.delayedCall(1500, () => this.scene.start('GarageScene', { token: this.token }));
      } else {
        const err = await res.json() as { error?: string };
        this.statusText.setColor('#ff4444').setText(err.error ?? 'Save failed');
      }
    } catch {
      this.statusText.setColor('#ff4444').setText('Network error');
    }
  }
}
