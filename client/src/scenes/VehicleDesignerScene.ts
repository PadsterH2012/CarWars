import Phaser from 'phaser';
import {
  BODY_TYPES, POWER_PLANTS, SUSPENSIONS, TIRE_TYPES, ARMOR_TYPES, WEAPONS, ARCS,
  type MountConfig, type ArcType,
} from '../ui/DesignerUI';
import { preloadVehicleSprites, bodySpriteKey, weaponSpriteKey } from '../game/VehicleSprite';

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

  // Workshop edit-mode state (when launched from garage [WORKSHOP])
  private editVehicleId: string | null = null;
  private gangPrimaryColour: number = 0x00cd68;  // default green, replaced from /api/gangs/mine

  // Sprite preview objects (recreated each redraw)
  private previewBody: Phaser.GameObjects.Image | null = null;
  private previewWeapons: Phaser.GameObjects.Image[] = [];

  init(data: { token?: string; vehicleId?: string }): void {
    this.token = data.token ?? '';
    this.editVehicleId = data.vehicleId ?? null;
  }

  preload(): void {
    // Ensure body + weapon sprites are available for the schematic preview
    preloadVehicleSprites(this);
  }

  async create(): Promise<void> {
    // Background
    this.add.rectangle(640, 360, 1280, 720, 0x111122);

    // Pull the gang's primary colour so the preview sprite tints correctly
    try {
      const host = window.location.hostname;
      const gRes = await fetch(`http://${host}:3001/api/gangs/mine`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (gRes.ok) {
        const g = await gRes.json();
        if (typeof g.primary_colour === 'number') this.gangPrimaryColour = g.primary_colour;
      }
    } catch { /* fall back to default green */ }

    // When launched in workshop edit mode, pre-load the existing vehicle's loadout
    // into our state fields BEFORE the UI is built, so every panel renders with the
    // real current settings (body type, power plant, tires, weapons, armor). The
    // vehicle name also defaults to the existing one so we don't overwrite it.
    if (this.editVehicleId) {
      try {
        const host = window.location.hostname;
        const res = await fetch(`http://${host}:3001/api/vehicles/${this.editVehicleId}`, {
          headers: { Authorization: `Bearer ${this.token}` },
        });
        if (res.ok) {
          const v: any = await res.json();
          const l = v.loadout ?? {};
          this.vehicleName     = v.name ?? this.vehicleName;
          this.bodyType        = l.bodyType        ?? this.bodyType;
          this.powerPlantType  = l.powerPlantType  ?? this.powerPlantType;
          this.suspensionType  = l.suspensionType  ?? this.suspensionType;
          this.tireType        = l.tireType        ?? this.tireType;
          this.armorType       = l.armorType       ?? this.armorType;
          if (Array.isArray(l.mounts) && l.mounts.length > 0) this.mounts = l.mounts;
          if (l.armor) {
            this.armor = {
              front: l.armor.front ?? this.armor.front,
              back:  l.armor.back  ?? this.armor.back,
              left:  l.armor.left  ?? this.armor.left,
              right: l.armor.right ?? this.armor.right,
            };
          }
        }
      } catch {
        // If the load fails we fall back to defaults and the user can still edit
      }
    }

    // Title — switches between BUILD and WORKSHOP depending on mode
    const titleText = this.editVehicleId ? `WORKSHOP — ${this.vehicleName}` : 'VEHICLE DESIGNER';
    this.add.text(640, 25, titleText, {
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
        this.redrawSchematic();  // body-type changed → refresh preview sprite
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
    const cy = topY + 120;   // push centre down to accommodate the bigger panels
    this.schematicCy = cy;

    // Graphics layer for fills and borders (redrawn each update)
    this.schematicGfx = this.add.graphics();

    // Panel definitions (1.5× the previous schematic size for a clearer preview)
    type FaceKey = 'front' | 'back' | 'left' | 'right';
    const panels: Array<{ key: FaceKey; rx: number; ry: number; rw: number; rh: number; lx: number; ly: number }> = [
      { key: 'front', rx: cx - 75, ry: cy - 130, rw: 150, rh: 35,  lx: cx,       ly: cy - 113 },
      { key: 'back',  rx: cx - 75, ry: cy +  95, rw: 150, rh: 35,  lx: cx,       ly: cy + 113 },
      { key: 'left',  rx: cx -115, ry: cy -  60, rw: 35,  rh: 120, lx: cx - 97,  ly: cy       },
      { key: 'right', rx: cx + 80, ry: cy -  60, rw: 35,  rh: 120, lx: cx + 97,  ly: cy       },
    ];

    // Static FRONT / BACK / L / R labels above / below / outside each armor panel
    this.add.text(cx, cy - 145, 'FRONT', {
      fontSize: '11px', fontFamily: 'monospace', color: '#ffcc88', fontStyle: 'bold'
    }).setOrigin(0.5);
    this.add.text(cx, cy + 145, 'BACK', {
      fontSize: '11px', fontFamily: 'monospace', color: '#ccaa66'
    }).setOrigin(0.5);
    this.add.text(cx - 130, cy, 'L', {
      fontSize: '11px', fontFamily: 'monospace', color: '#bbbbbb'
    }).setOrigin(0.5);
    this.add.text(cx + 130, cy, 'R', {
      fontSize: '11px', fontFamily: 'monospace', color: '#bbbbbb'
    }).setOrigin(0.5);

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
    const controlY = cy + 165;   // below the larger back panel + BACK label
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

    // Clear previous sprite preview so selector changes take effect
    this.previewBody?.destroy();
    this.previewBody = null;
    this.previewWeapons.forEach(img => img.destroy());
    this.previewWeapons = [];

    // Render the body sprite at the centre of the schematic, tinted with the
    // gang primary colour. Scale so the sprite fits the 150×180 area.
    const bKey = `body_${bodySpriteKey(this.bodyType)}`;
    let bodyHalfW = 50;  // fallback half-width for wheel placement
    let bodyHalfH = 80;
    if (this.textures.exists(bKey)) {
      const tex = this.textures.get(bKey).getSourceImage();
      const scaleX = 150 / tex.width;
      const scaleY = 180 / tex.height;
      const scale = Math.min(scaleX, scaleY);
      bodyHalfW = (tex.width  * scale) / 2;
      bodyHalfH = (tex.height * scale) / 2;
      this.previewBody = this.add.image(cx, cy, bKey)
        .setOrigin(0.5)
        .setScale(scale)
        .setTint(this.gangPrimaryColour);
    } else {
      // Fallback: original dark-blue rectangle if the sprite hasn't loaded yet
      this.schematicGfx.fillStyle(0x1a1a3a, 1);
      this.schematicGfx.fillRect(cx - 75, cy - 90, 150, 180);
      this.schematicGfx.lineStyle(1, 0x444466, 1);
      this.schematicGfx.strokeRect(cx - 75, cy - 90, 150, 180);
    }

    // Draw wheels as separate graphics on TOP of the tinted body sprite so
    // they stay pure black regardless of what tint is active. Four wheels
    // protrude slightly from each side of the hull — classic top-down look.
    // Skip for cycles (2-wheel body types) — they already look narrow enough
    // that the body sprite itself reads correctly.
    const isCycle = this.bodyType.includes('cycle');
    if (!isCycle) {
      const wheelW = 14;
      const wheelH = 26;
      const wheelXOut = bodyHalfW - 2;  // slight overlap with hull
      const wheelFrontY = -bodyHalfH * 0.45;
      const wheelRearY  =  bodyHalfH * 0.35;
      const wheels = [
        { x: cx - wheelXOut - wheelW * 0.5, y: cy + wheelFrontY },
        { x: cx + wheelXOut - wheelW * 0.5, y: cy + wheelFrontY },
        { x: cx - wheelXOut - wheelW * 0.5, y: cy + wheelRearY  },
        { x: cx + wheelXOut - wheelW * 0.5, y: cy + wheelRearY  },
      ];
      this.schematicGfx.fillStyle(0x000000, 1);
      this.schematicGfx.lineStyle(1, 0xffffff, 0.9);
      wheels.forEach(({ x, y }) => {
        this.schematicGfx.fillRoundedRect(x, y, wheelW, wheelH, 2);
        this.schematicGfx.strokeRoundedRect(x, y, wheelW, wheelH, 2);
      });
      // Lug nut dots (white) — make the wheels unmistakably wheels
      this.schematicGfx.fillStyle(0xffffff, 0.9);
      wheels.forEach(({ x, y }) => {
        this.schematicGfx.fillCircle(x + wheelW / 2, y + wheelH / 2, 1.5);
      });
    }

    // Direction indicator: bright yellow chevron above the body
    this.schematicGfx.fillStyle(0xffff88, 0.9);
    this.schematicGfx.beginPath();
    this.schematicGfx.moveTo(cx,     cy - 160);
    this.schematicGfx.lineTo(cx + 8, cy - 150);
    this.schematicGfx.lineTo(cx - 8, cy - 150);
    this.schematicGfx.closePath();
    this.schematicGfx.fillPath();

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

    // Weapon overlays — anchored to the body sprite's actual scaled extents so
    // weapons sit at the hull edge (front/back/left/right) rather than inside the
    // body. Small 4-px offset pushes them slightly outboard so the barrel
    // clearly points away from the car.
    const mountAnchors: Record<string, { x: number; y: number; rot: number }> = {
      front:  { x: cx,                    y: cy - bodyHalfH - 4, rot: 0              },
      back:   { x: cx,                    y: cy + bodyHalfH + 4, rot: Math.PI        },
      left:   { x: cx - bodyHalfW - 4,    y: cy,                 rot: -Math.PI / 2   },
      right:  { x: cx + bodyHalfW + 4,    y: cy,                 rot:  Math.PI / 2   },
      turret: { x: cx,                    y: cy,                 rot: 0              },
    };
    // Track per-arc index so stacked mounts don't sit on top of each other
    const arcOffset = new Map<string, number>();
    this.mounts.forEach(mount => {
      const anchor = mountAnchors[mount.arc as keyof typeof mountAnchors];
      if (!anchor) return;
      const count = arcOffset.get(mount.arc) ?? 0;
      arcOffset.set(mount.arc, count + 1);
      const lateralOffset = (count % 2 === 0 ? 1 : -1) * Math.floor(count / 2) * 10;

      const wKey = weaponSpriteKey(mount.weaponId ?? null);
      if (!wKey || !this.textures.exists(`weapon_${wKey}`)) return;

      // Lateral offset along the perpendicular to anchor rotation
      const perpX = Math.cos(anchor.rot + Math.PI / 2);
      const perpY = Math.sin(anchor.rot + Math.PI / 2);
      const img = this.add.image(
        anchor.x + perpX * lateralOffset,
        anchor.y + perpY * lateralOffset,
        `weapon_${wKey}`,
      )
        .setOrigin(0.5)
        .setRotation(anchor.rot)
        .setScale(1.4);
      this.previewWeapons.push(img);
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

    // Build / Save button — label and behaviour depend on mode
    const label = this.editVehicleId ? '[ SAVE CHANGES ]' : '[ BUILD THIS CAR ]';
    const buildBtn = this.add.text(640, 685, label, {
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
      const loadout = { ...this.buildDesignPayload(), totalCost: this.derivedCost };

      let res: Response;
      if (this.editVehicleId) {
        // Workshop edit: PATCH just the loadout; server handles delta pricing
        res = await fetch(`http://${host}:3001/api/vehicles/${this.editVehicleId}/loadout`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
          body: JSON.stringify(loadout),
        });
      } else {
        // New-vehicle create path
        res = await fetch(`http://${host}:3001/api/vehicles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
          body: JSON.stringify({ name: this.vehicleName, loadout }),
        });
      }

      if (res.ok) {
        const successText = this.editVehicleId ? 'Changes saved!' : 'Vehicle created!';
        this.statusText.setColor(SEL_COLOR).setText(successText);
        this.time.delayedCall(1200, () => this.scene.start('GarageScene', { token: this.token }));
      } else {
        const err = await res.json() as { error?: string };
        this.statusText.setColor('#ff4444').setText(err.error ?? 'Save failed');
      }
    } catch {
      this.statusText.setColor('#ff4444').setText('Network error');
    }
  }
}
