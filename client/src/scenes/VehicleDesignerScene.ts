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

function armorColor(pts: number): number {
  if (pts >= 15) return 0x00aa44;  // green
  if (pts >= 5)  return 0xaaaa00;  // yellow
  if (pts >= 1)  return 0xaa4400;  // orange
  return 0x440000;                  // dark red
}

export class VehicleDesignerScene extends Phaser.Scene {
  private token = '';

  // State
  private bodyType      = 'mid_sized';
  private powerPlantType = 'elec_medium';
  private suspensionType = 'standard';
  private tireType      = 'standard';
  private armorType     = 'ablative';
  private mounts: MountConfig[] = [
    { id: 'm0', arc: 'front', weaponId: 'mg', ammo: 50 },
  ];
  private armor = { front: 20, back: 15, left: 15, right: 15 };
  private vehicleName   = 'My Car';
  private derivedCost   = 0;
  private statsReqId    = 0;

  // Debounce timer for stats refresh
  private statsDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Button maps for in-place updates
  private bodyBtns       = new Map<string, Phaser.GameObjects.Text>();
  private powerBtns      = new Map<string, Phaser.GameObjects.Text>();
  private suspBtns       = new Map<string, Phaser.GameObjects.Text>();
  private tireBtns       = new Map<string, Phaser.GameObjects.Text>();
  private armorTypeBtns  = new Map<string, Phaser.GameObjects.Text>();
  private weaponBtns     = new Map<string, Phaser.GameObjects.Text>();
  private arcBtns        = new Map<string, Phaser.GameObjects.Text>();

  // Stats panel texts
  private statsSpeedText!:  Phaser.GameObjects.Text;
  private statsAccelText!:  Phaser.GameObjects.Text;
  private statsHcText!:     Phaser.GameObjects.Text;
  private statsWeightText!: Phaser.GameObjects.Text;
  private statsCostText!:   Phaser.GameObjects.Text;
  private statusText!:      Phaser.GameObjects.Text;

  // Schematic state
  private schematicCy = 0;
  private selectedArmorFace: 'front' | 'back' | 'left' | 'right' = 'front';
  private schematicGfx!: Phaser.GameObjects.Graphics;
  private schematicTexts = new Map<string, Phaser.GameObjects.Text>();
  private selectedFaceLabel!: Phaser.GameObjects.Text;
  private armorEditText!: Phaser.GameObjects.Text;

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

    // Trigger initial stats fetch (immediate, no debounce)
    this.refreshStats();

    // Draw initial schematic after objects are created
    this.redrawSchematic();
  }

  // ─── LEFT PANEL (x=10..430) ──────────────────────────────────────────────

  private buildLeftPanel(): void {
    let y = 55;
    const x0 = 10;

    // Body Type
    this.add.text(x0, y, 'Body Type:', LABEL_STYLE);
    y += 18;
    y = this.buildOptionGrid(BODY_TYPES, x0, y, 3, this.bodyBtns, () => this.bodyType,
      (id) => {
        this.bodyType = id;
        this.updateOptionBtns(this.bodyBtns, () => this.bodyType);
        this.syncPowerPlantToBody();
        this.scheduleStatsRefresh();
      });

    y += 6;
    // Power Plant
    this.add.text(x0, y, 'Power Plant:', LABEL_STYLE);
    y += 18;
    y = this.buildOptionGrid(POWER_PLANTS, x0, y, 3, this.powerBtns, () => this.powerPlantType,
      (id) => { this.powerPlantType = id; this.updateOptionBtns(this.powerBtns, () => this.powerPlantType); this.scheduleStatsRefresh(); });

    y += 6;
    // Suspension
    this.add.text(x0, y, 'Suspension:', LABEL_STYLE);
    y += 18;
    y = this.buildOptionGrid(SUSPENSIONS, x0, y, 3, this.suspBtns, () => this.suspensionType,
      (id) => { this.suspensionType = id; this.updateOptionBtns(this.suspBtns, () => this.suspensionType); this.scheduleStatsRefresh(); });

    y += 6;
    // Tires
    this.add.text(x0, y, 'Tires:', LABEL_STYLE);
    y += 18;
    y = this.buildOptionGrid(TIRE_TYPES, x0, y, 3, this.tireBtns, () => this.tireType,
      (id) => { this.tireType = id; this.updateOptionBtns(this.tireBtns, () => this.tireType); this.scheduleStatsRefresh(); });

    y += 6;
    // Armor Type
    this.add.text(x0, y, 'Armor Type:', LABEL_STYLE);
    y += 18;
    this.buildOptionGrid(ARMOR_TYPES, x0, y, 3, this.armorTypeBtns, () => this.armorType,
      (id) => { this.armorType = id; this.updateOptionBtns(this.armorTypeBtns, () => this.armorType); this.scheduleStatsRefresh(); });
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

  private syncPowerPlantToBody(): void {
    const bodyDef = BODY_TYPES.find(b => b.id === this.bodyType);
    const isCycle = bodyDef?.isCycle ?? false;

    // Show only compatible plants; hide the rest
    this.powerBtns.forEach((btn, id) => {
      const plantDef = POWER_PLANTS.find(p => p.id === id);
      const compatible = (plantDef?.cycleOnly ?? false) === isCycle;
      btn.setVisible(compatible);
    });

    // If current plant is incompatible, switch to first compatible one
    const currentPlant = POWER_PLANTS.find(p => p.id === this.powerPlantType);
    if ((currentPlant?.cycleOnly ?? false) !== isCycle) {
      const first = POWER_PLANTS.find(p => p.cycleOnly === isCycle);
      if (first) {
        this.powerPlantType = first.id;
        this.updateOptionBtns(this.powerBtns, () => this.powerPlantType);
      }
    }
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
      this.statusText.setText('');
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
    this.redrawSchematic();
    this.scheduleStatsRefresh();
  }

  private cycleArc(weaponId: string): void {
    const mount = this.mounts.find(m => m.weaponId === weaponId);
    if (!mount) return;
    const currentIdx = ARCS.indexOf(mount.arc);
    mount.arc = ARCS[(currentIdx + 1) % ARCS.length] as ArcType;
    this.updateWeaponButtons();
    this.redrawSchematic();
    this.scheduleStatsRefresh();
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

    // Armor section heading
    this.add.text(x0, y, '── ARMOR ──', {
      color: HEADING_COLOR, fontSize: '13px', fontFamily: 'monospace',
    });
    y += 22;

    // Build the schematic (creates graphics + interactive zones + texts)
    this.buildSchematic(y);
  }

  /**
   * Build the top-down vehicle schematic in the right panel.
   * All interactive zones and text labels are created here once.
   * Visual state (colors, borders) is handled by redrawSchematic().
   */
  private buildSchematic(topY: number): void {
    const cx = 985;
    const cy = topY + 90; // ~490 with topY=400
    this.schematicCy = cy;

    // Graphics layer for fills and borders (redrawn each update)
    this.schematicGfx = this.add.graphics();

    // Panel definitions: key → rect [rx, ry, rw, rh]
    type FaceKey = 'front' | 'back' | 'left' | 'right';
    const panels: Array<{ key: FaceKey; rx: number; ry: number; rw: number; rh: number; lx: number; ly: number }> = [
      { key: 'front', rx: cx - 50, ry: cy - 90, rw: 100, rh: 30,  lx: cx,      ly: cy - 75 },
      { key: 'back',  rx: cx - 50, ry: cy + 60, rw: 100, rh: 30,  lx: cx,      ly: cy + 75 },
      { key: 'left',  rx: cx - 80, ry: cy - 40, rw: 30,  rh: 80,  lx: cx - 65, ly: cy      },
      { key: 'right', rx: cx + 50, ry: cy - 40, rw: 30,  rh: 80,  lx: cx + 65, ly: cy      },
    ];

    // Create interactive hit zones (invisible rects) and value labels
    panels.forEach(({ key, rx, ry, rw, rh, lx, ly }) => {
      // Invisible hit zone
      const zone = this.add.zone(rx, ry, rw, rh).setOrigin(0, 0).setInteractive();
      zone.on('pointerdown', () => {
        this.selectedArmorFace = key;
        this.selectedFaceLabel.setText(`Selected: ${key.toUpperCase()}`);
        this.armorEditText.setText(String(this.armor[key]));
        this.redrawSchematic();
      });
      // Armor value text centered on panel
      const txt = this.add.text(lx, ly, String(this.armor[key]), {
        fontSize: '11px', fontFamily: 'monospace', color: '#ffffff',
      }).setOrigin(0.5).setDepth(1);
      this.schematicTexts.set(key, txt);
    });

    // Selected face label + ± controls below the diagram
    const controlY = cy + 110;
    this.selectedFaceLabel = this.add.text(cx, controlY, `Selected: ${this.selectedArmorFace.toUpperCase()}`, {
      fontSize: '12px', fontFamily: 'monospace', color: LABEL_COLOR,
    }).setOrigin(0.5);

    const minusBtn = this.add.text(cx - 40, controlY + 22, '[−]', {
      fontSize: '13px', fontFamily: 'monospace', color: '#ff6666',
      backgroundColor: '#330011', padding: { x: 4, y: 2 },
    }).setInteractive().setOrigin(0.5);
    minusBtn.on('pointerdown', () => {
      const key = this.selectedArmorFace;
      if (this.armor[key] > 0) {
        this.armor[key]--;
        this.armorEditText.setText(String(this.armor[key]));
        this.redrawSchematic();
        this.scheduleStatsRefresh();
      }
    });

    this.armorEditText = this.add.text(cx, controlY + 22, String(this.armor[this.selectedArmorFace]), {
      fontSize: '13px', fontFamily: 'monospace', color: '#cccccc',
    }).setOrigin(0.5);

    const plusBtn = this.add.text(cx + 40, controlY + 22, '[+]', {
      fontSize: '13px', fontFamily: 'monospace', color: '#66ff88',
      backgroundColor: '#002211', padding: { x: 4, y: 2 },
    }).setInteractive().setOrigin(0.5);
    plusBtn.on('pointerdown', () => {
      const key = this.selectedArmorFace;
      if (this.armor[key] < 99) {
        this.armor[key]++;
        this.armorEditText.setText(String(this.armor[key]));
        this.redrawSchematic();
        this.scheduleStatsRefresh();
      }
    });
  }

  /**
   * Redraw the schematic graphics: panel fills, selection border, car body, weapon dots.
   */
  private redrawSchematic(): void {
    if (!this.schematicGfx) return;

    const cx = 985;
    const cy = this.schematicCy;

    this.schematicGfx.clear();

    // Car body interior (darker background)
    this.schematicGfx.fillStyle(0x1a1a3a, 1);
    this.schematicGfx.fillRect(cx - 50, cy - 60, 100, 120);
    this.schematicGfx.lineStyle(1, 0x444466, 1);
    this.schematicGfx.strokeRect(cx - 50, cy - 60, 100, 120);

    // Panel definitions
    type FaceKey = 'front' | 'back' | 'left' | 'right';
    const panels: Array<{ key: FaceKey; rx: number; ry: number; rw: number; rh: number }> = [
      { key: 'front', rx: cx - 50, ry: cy - 90, rw: 100, rh: 30  },
      { key: 'back',  rx: cx - 50, ry: cy + 60, rw: 100, rh: 30  },
      { key: 'left',  rx: cx - 80, ry: cy - 40, rw: 30,  rh: 80  },
      { key: 'right', rx: cx + 50, ry: cy - 40, rw: 30,  rh: 80  },
    ];

    panels.forEach(({ key, rx, ry, rw, rh }) => {
      const pts = this.armor[key];
      const fillCol = armorColor(pts);

      // Fill
      this.schematicGfx.fillStyle(fillCol, 0.85);
      this.schematicGfx.fillRect(rx, ry, rw, rh);

      // Normal border
      this.schematicGfx.lineStyle(1, 0x666666, 1);
      this.schematicGfx.strokeRect(rx, ry, rw, rh);

      // Selected highlight border
      if (key === this.selectedArmorFace) {
        this.schematicGfx.lineStyle(2, 0xffffff, 1);
        this.schematicGfx.strokeRect(rx, ry, rw, rh);
      }

      // Update value label text
      this.schematicTexts.get(key)?.setText(String(pts));
    });

    // Weapon mount dots
    const mountPositions: Record<string, { x: number; y: number }> = {
      front:  { x: cx,      y: cy - 30 },
      back:   { x: cx,      y: cy + 30 },
      left:   { x: cx - 25, y: cy      },
      right:  { x: cx + 25, y: cy      },
      turret: { x: cx,      y: cy      },
    };

    const categoryColors: Record<string, number> = {
      small_bore: 0xffff00,
      large_bore: 0xff8800,
      rocket:     0xff4444,
      laser:      0x00ffff,
      flamer:     0xff6600,
      dropped:    0x888888,
    };

    const arcDotOffset = new Map<string, number>();
    this.mounts.forEach(mount => {
      const pos = mountPositions[mount.arc as keyof typeof mountPositions];
      if (!pos) return;

      const count = arcDotOffset.get(mount.arc) ?? 0;
      arcDotOffset.set(mount.arc, count + 1);
      const offsetX = (count % 2 === 0 ? 1 : -1) * Math.floor(count / 2) * 8;

      // Look up weapon category from WEAPONS list
      const weaponDef = WEAPONS.find(w => w.id === mount.weaponId);
      const category = weaponDef?.category ?? 'small_bore';
      const dotColor = categoryColors[category] ?? 0xffffff;

      this.schematicGfx.fillStyle(dotColor, 1);
      this.schematicGfx.fillCircle(pos.x + offsetX, pos.y, 5);
      this.schematicGfx.lineStyle(1, 0x000000, 0.6);
      this.schematicGfx.strokeCircle(pos.x + offsetX, pos.y, 5);
    });
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

    // Vehicle name display
    const nameDisplay = this.add.text(640, 640, `Name: ${this.vehicleName}`, {
      color: '#cccccc', fontSize: '13px', fontFamily: 'monospace'
    }).setOrigin(0.5);

    const renameBtn = this.add.text(900, 640, '[RENAME]', {
      color: '#aaaaff', fontSize: '13px', fontFamily: 'monospace',
      backgroundColor: '#111133', padding: { x: 6, y: 3 }
    }).setInteractive();
    renameBtn.on('pointerdown', () => {
      const name = window.prompt('Enter vehicle name:', this.vehicleName);
      if (name && name.trim()) {
        this.vehicleName = name.trim();
        nameDisplay.setText(`Name: ${this.vehicleName}`);
      }
    });

    // Build button
    const buildBtn = this.add.text(640, 685, '[ BUILD THIS CAR ]', {
      color: SEL_COLOR, fontSize: '18px', fontFamily: 'monospace',
      backgroundColor: SEL_BG, padding: { x: 16, y: 6 },
    }).setOrigin(0.5).setInteractive();
    buildBtn.on('pointerdown', () => this.saveVehicle());
  }

  // ─── LIFECYCLE ────────────────────────────────────────────────────────────

  shutdown(): void {
    if (this.statsDebounceTimer) {
      clearTimeout(this.statsDebounceTimer);
      this.statsDebounceTimer = null;
    }
  }

  // ─── DEBOUNCE ─────────────────────────────────────────────────────────────

  private scheduleStatsRefresh(): void {
    if (this.statsDebounceTimer) clearTimeout(this.statsDebounceTimer);
    this.statsDebounceTimer = setTimeout(() => {
      this.statsDebounceTimer = null;
      this.refreshStats();
    }, 150);
  }

  // ─── API CALLS ────────────────────────────────────────────────────────────

  private async refreshStats(): Promise<void> {
    const reqId = ++this.statsReqId;
    // Don't wipe existing values — show a subtle indicator instead so stats remain readable
    this.statusText.setColor('#555577').setText('Updating...');

    try {
      const host = window.location.hostname;
      const res = await fetch(`http://${host}:3001/api/vehicles/design`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
        body: JSON.stringify(this.buildDesignPayload()),
      });

      if (reqId !== this.statsReqId) return;

      if (res.ok) {
        const data = await res.json() as {
          maxSpeed: number;
          acceleration: number;
          handlingClass: number;
          totalWeight: number;
          totalCost: number;
        };
        if (reqId !== this.statsReqId) return;
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
        this.statsSpeedText.setText('--');
        this.statsAccelText.setText('--');
        this.statsHcText.setText('--');
        this.statsWeightText.setText('--');
        this.statsCostText.setText('--');
        this.statusText.setColor('#ff4444').setText(msg);
      }
    } catch {
      if (reqId !== this.statsReqId) return;
      this.statsSpeedText.setText('--');
      this.statsAccelText.setText('--');
      this.statsHcText.setText('--');
      this.statsWeightText.setText('--');
      this.statsCostText.setText('--');
      this.statusText.setColor('#ff4444').setText('Network error');
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
            ...this.buildDesignPayload(),
            totalCost: this.derivedCost,
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
