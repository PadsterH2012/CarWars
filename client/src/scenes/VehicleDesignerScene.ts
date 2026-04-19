import Phaser from 'phaser';
import {
  BODY_TYPES, POWER_PLANTS, SUSPENSIONS, TIRE_TYPES, ARMOR_TYPES, WEAPONS, ARCS,
  type MountConfig, type ArcType,
} from '../ui/DesignerUI';
import { bindFullscreenToggle } from '../ui/responsive';

type Mode = 'simple' | 'datasheet';
type Face = 'front' | 'back' | 'left' | 'right';
type Tab = 'body' | 'engine' | 'armor' | 'weapons' | 'tires' | 'suspension';

interface WeaponDef {
  id: string; name: string; category: string; cost: number;
  toHit: number; damageDice: number; damageMod: number;
  shotsPerMag: number; ammoCost: number;
  allowedArcs: string[];
}

interface DesignerStats {
  maxSpeed: number;
  acceleration: number;
  handlingClass: number;
  totalWeight: number;
  totalCost: number;
}

const LS_MODE = 'cw_designer_mode';

function armorFillCss(pts: number): string {
  if (pts >= 15) return '#00aa44';
  if (pts >= 5)  return '#aaaa00';
  if (pts >= 1)  return '#aa4400';
  return '#440000';
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

// Replace the contents of `el` by parsing `html` through the DOM parser.
// Every user-supplied substring in our templates is routed through esc() first,
// so dynamic values are HTML-safe by the time they land here.
function renderInto(el: HTMLElement, html: string): void {
  el.textContent = '';
  const range = document.createRange();
  range.selectNodeContents(el);
  const fragment = range.createContextualFragment(html);
  el.appendChild(fragment);
}

export class VehicleDesignerScene extends Phaser.Scene {
  private token = '';
  private editVehicleId: string | null = null;
  private gangPrimaryColour = 0x00cd68;
  private treasury = 0;

  // Design state
  private vehicleName = 'My Car';
  private bodyType = 'mid_sized';
  private powerPlantType = 'elec_medium';
  private suspensionType = 'standard';
  private tireType = 'standard';
  private armorType = 'ablative';
  private mounts: MountConfig[] = [{ id: 'm0', arc: 'front', weaponId: 'mg', ammo: 50 }];
  private armor: Record<Face, number> = { front: 20, back: 15, left: 15, right: 15 };

  // UI state
  private mode: Mode = 'simple';
  private activeTab: Tab = 'body';
  private selectedFace: Face = 'front';
  private weaponCatalog: WeaponDef[] = [];
  private stats: DesignerStats | null = null;
  private statusMsg = '';
  private statusColor = '#888';

  // Debounce
  private statsReqId = 0;
  private statsDebounce: ReturnType<typeof setTimeout> | null = null;

  // DOM root
  private root!: HTMLDivElement;

  constructor() { super({ key: 'VehicleDesignerScene' }); }

  init(data: { token?: string; vehicleId?: string }): void {
    this.token = data.token ?? '';
    this.editVehicleId = data.vehicleId ?? null;

    // Reset state on scene restart (Phaser reuses instances)
    this.vehicleName = 'My Car';
    this.bodyType = 'mid_sized';
    this.powerPlantType = 'elec_medium';
    this.suspensionType = 'standard';
    this.tireType = 'standard';
    this.armorType = 'ablative';
    this.mounts = [{ id: 'm0', arc: 'front', weaponId: 'mg', ammo: 50 }];
    this.armor = { front: 20, back: 15, left: 15, right: 15 };
    this.activeTab = 'body';
    this.selectedFace = 'front';
    this.stats = null;
    this.statusMsg = '';
  }

  async create(): Promise<void> {
    const savedMode = localStorage.getItem(LS_MODE) as Mode | null;
    this.mode = savedMode === 'datasheet' ? 'datasheet' : 'simple';

    await Promise.all([this.loadGang(), this.loadWeaponCatalog(), this.loadVehicleIfEditing()]);

    this.root = document.createElement('div');
    this.root.className = 'cw-designer';
    Object.assign(this.root.style, {
      position: 'fixed', inset: '0', zIndex: '50',
      background: '#0a0a1a', color: '#ccc',
      fontFamily: "'Courier New', monospace",
      display: 'grid', gridTemplateRows: 'auto auto 1fr auto',
      minHeight: '0',
    });
    document.body.appendChild(this.root);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.root.remove();
      if (this.statsDebounce) clearTimeout(this.statsDebounce);
    });

    this.rebuild();
    this.refreshStats();

    bindFullscreenToggle(this);
  }

  // ── Loaders ──────────────────────────────────────────────────────────────

  private async loadGang(): Promise<void> {
    try {
      const host = window.location.hostname;
      const res = await fetch(`http://${host}:3001/api/gangs/mine`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (res.ok) {
        const g = await res.json();
        if (typeof g.primary_colour === 'number') this.gangPrimaryColour = g.primary_colour;
        if (typeof g.treasury === 'number') this.treasury = g.treasury;
      }
    } catch { /* defaults */ }
  }

  private async loadWeaponCatalog(): Promise<void> {
    try {
      const host = window.location.hostname;
      const res = await fetch(`http://${host}:3001/api/weapons`);
      if (res.ok) this.weaponCatalog = await res.json();
    } catch { /* empty */ }
  }

  private async loadVehicleIfEditing(): Promise<void> {
    if (!this.editVehicleId) return;
    try {
      const host = window.location.hostname;
      const res = await fetch(`http://${host}:3001/api/vehicles/${this.editVehicleId}`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (!res.ok) return;
      const v: any = await res.json();
      const l = v.loadout ?? {};
      this.vehicleName    = v.name ?? this.vehicleName;
      this.bodyType       = l.bodyType       ?? this.bodyType;
      this.powerPlantType = l.powerPlantType ?? this.powerPlantType;
      this.suspensionType = l.suspensionType ?? this.suspensionType;
      this.tireType       = l.tireType       ?? this.tireType;
      this.armorType      = l.armorType      ?? this.armorType;
      if (Array.isArray(l.mounts) && l.mounts.length > 0) this.mounts = l.mounts;
      if (l.armor) {
        this.armor = {
          front: l.armor.front ?? this.armor.front,
          back:  l.armor.back  ?? this.armor.back,
          left:  l.armor.left  ?? this.armor.left,
          right: l.armor.right ?? this.armor.right,
        };
      }
    } catch { /* keep defaults */ }
  }

  // ── Rebuild + event delegation ───────────────────────────────────────────

  private rebuild(): void {
    const html = this.renderStyles() + this.renderHeader()
      + (this.mode === 'simple' ? this.renderSimple() : this.renderDatasheet())
      + this.renderFooter();
    renderInto(this.root, html);
    this.root.addEventListener('click', this.onClick, { once: false });
  }

  private onClick = (e: MouseEvent): void => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!t) return;
    const action = t.dataset.action!;
    const value = t.dataset.value;

    switch (action) {
      case 'back':
        this.scene.start('GarageScene', { token: this.token });
        return;
      case 'save':
        this.saveVehicle();
        return;
      case 'mode':
        this.switchMode(value as Mode);
        return;
      case 'rename':
        this.doRename();
        return;
      case 'tab':
        this.activeTab = value as Tab;
        this.rebuild();
        return;
      case 'body':
        this.setBodyType(value!);
        return;
      case 'engine':
        this.powerPlantType = value!;
        this.markDirty();
        return;
      case 'suspension':
        this.suspensionType = value!;
        this.markDirty();
        return;
      case 'tires':
        this.tireType = value!;
        this.markDirty();
        return;
      case 'armor-type':
        this.armorType = value!;
        this.markDirty();
        return;
      case 'select-face':
        this.selectedFace = value as Face;
        this.rebuild();
        return;
      case 'armor-adjust': {
        const delta = parseInt(value!, 10);
        const face = this.selectedFace;
        this.armor[face] = Math.max(0, Math.min(99, this.armor[face] + delta));
        this.markDirty();
        return;
      }
      case 'weapon-toggle':
        this.toggleWeapon(value!);
        return;
      case 'cycle-arc':
        this.cycleArc(value!);
        return;
      case 'set-mount-weapon': {
        const [mountId, weaponIdRaw] = value!.split(':');
        const weaponId = weaponIdRaw === 'null' ? null : weaponIdRaw;
        this.setMountWeapon(mountId, weaponId);
        return;
      }
      case 'add-mount':
        this.addMount(value as ArcType);
        return;
      case 'remove-mount':
        this.removeMount(value!);
        return;
    }
  };

  // ── State mutators ───────────────────────────────────────────────────────

  private markDirty(): void {
    this.rebuild();
    this.scheduleStatsRefresh();
  }

  private switchMode(m: Mode): void {
    if (m !== 'simple' && m !== 'datasheet') return;
    this.mode = m;
    localStorage.setItem(LS_MODE, m);
    this.rebuild();
  }

  private setBodyType(id: string): void {
    if (!BODY_TYPES.find(b => b.id === id)) return;
    this.bodyType = id;
    this.syncPowerPlantToBody();
    this.markDirty();
  }

  private syncPowerPlantToBody(): void {
    const bodyDef = BODY_TYPES.find(b => b.id === this.bodyType);
    const isCycle = bodyDef?.isCycle ?? false;
    const current = POWER_PLANTS.find(p => p.id === this.powerPlantType);
    if ((current?.cycleOnly ?? false) !== isCycle) {
      const first = POWER_PLANTS.find(p => p.cycleOnly === isCycle);
      if (first) this.powerPlantType = first.id;
    }
  }

  private toggleWeapon(id: string): void {
    const idx = this.mounts.findIndex(m => m.weaponId === id);
    if (idx >= 0) {
      this.mounts.splice(idx, 1);
      this.flashStatus('', '#888');
    } else {
      if (this.mounts.length >= 3) {
        this.flashStatus('Max 3 weapons', '#ff4444');
        this.rebuild();
        return;
      }
      this.mounts.push({ id: `m${Date.now()}`, arc: 'front', weaponId: id, ammo: 50 });
    }
    this.markDirty();
  }

  private cycleArc(weaponId: string): void {
    const mount = this.mounts.find(m => m.weaponId === weaponId);
    if (!mount) return;
    const idx = ARCS.indexOf(mount.arc);
    mount.arc = ARCS[(idx + 1) % ARCS.length] as ArcType;
    this.markDirty();
  }

  private setMountWeapon(mountId: string, weaponId: string | null): void {
    const mount = this.mounts.find(m => m.id === mountId);
    if (!mount) return;
    mount.weaponId = weaponId;
    if (weaponId) {
      const wep = this.weaponCatalog.find(w => w.id === weaponId);
      if (wep) mount.ammo = wep.shotsPerMag ?? 50;
    } else {
      mount.ammo = 0;
    }
    this.markDirty();
  }

  private addMount(arc: ArcType): void {
    if (this.mounts.length >= 3) {
      this.flashStatus('Max 3 mounts', '#ff4444');
      this.rebuild();
      return;
    }
    this.mounts.push({ id: `m${Date.now()}`, arc, weaponId: null, ammo: 0 });
    this.markDirty();
  }

  private removeMount(mountId: string): void {
    this.mounts = this.mounts.filter(m => m.id !== mountId);
    this.markDirty();
  }

  private doRename(): void {
    const name = window.prompt('Enter vehicle name:', this.vehicleName);
    if (name && name.trim()) {
      this.vehicleName = name.trim().slice(0, 64);
      this.rebuild();
    }
  }

  private flashStatus(msg: string, colour: string): void {
    this.statusMsg = msg;
    this.statusColor = colour;
  }

  // ── Rendering: styles ────────────────────────────────────────────────────

  private renderStyles(): string {
    return `<style>
      .cw-designer, .cw-designer * { box-sizing: border-box; }
      .cw-designer h1 { margin: 0; color: #ff4444; font-size: 20px; letter-spacing: 2px; }
      .cw-designer h3 {
        margin: 0 0 10px 0; font-size: 11px; color: #ff4444;
        letter-spacing: 3px; text-transform: uppercase;
      }
      .cw-header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 12px 24px; background: #0f0f22; border-bottom: 1px solid #2a2a44;
      }
      .cw-header .meta { font-size: 11px; color: #888; display: flex; gap: 16px; }
      .cw-header .meta b { color: #ffcc00; font-weight: normal; }
      .cw-toggle { display: flex; gap: 2px; margin-left: 14px; }
      .cw-toggle button {
        padding: 6px 14px; font-family: inherit; font-size: 11px; letter-spacing: 1px;
        background: #1a1a2e; border: 1px solid #2a2a44; color: #888; cursor: pointer;
      }
      .cw-toggle button.active { background: #003322; color: #00ff88; border-color: #00ff88; }
      .cw-tabs { display: flex; gap: 2px; padding: 12px 24px 0 24px; background: #0a0a1a; }
      .cw-tabs .tab {
        padding: 9px 20px; background: #1a1a2e; border: 1px solid #2a2a44;
        border-bottom: none; color: #888; font-size: 12px; cursor: pointer;
        text-transform: uppercase; letter-spacing: 1.5px; font-family: inherit;
      }
      .cw-tabs .tab:hover { background: #222244; color: #aac; }
      .cw-tabs .tab.active { background: #003322; color: #00ff88; border-color: #00ff88; }
      .cw-tabs .tab .badge { margin-left: 6px; padding: 1px 5px; background: #332200; color: #ffcc00; font-size: 9px; }
      .cw-body { min-height: 0; overflow: hidden; display: grid; gap: 12px; padding: 0 24px 12px 24px; background: #0a0a1a; }
      .cw-panel { background: #11112a; border: 1px solid #2a2a44; padding: 14px; overflow-y: auto; }
      .cw-panel h3 { border-bottom: 1px solid #2a2a44; padding-bottom: 8px; }
      .opt-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
      .opt {
        padding: 7px 8px; background: #1a1a33; border: 1px solid transparent;
        font-size: 11px; color: #888; cursor: pointer; text-align: center;
        font-family: inherit;
      }
      .opt:hover { background: #222244; color: #aac; }
      .opt.selected { background: #003322; color: #00ff88; border-color: #00ff88; }
      .stage {
        background: radial-gradient(ellipse at center, #15152a 0%, #08081a 70%);
        border: 1px solid #2a2a44; position: relative;
        display: flex; align-items: center; justify-content: center; overflow: hidden;
      }
      .stage svg { filter: drop-shadow(0 18px 24px rgba(0,0,0,0.6)); }
      .stage-hint { position: absolute; top: 8px; left: 12px; color: #556; font-size: 10px; letter-spacing: 2px; }
      .stats-list { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
      .stat-row { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px dotted #2a2a44; }
      .stat-row span:first-child { color: #888; }
      .stat-row span:last-child { color: #00ff88; }
      .armor-controls { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
      .armor-controls .value {
        flex: 1; text-align: center; font-size: 22px; color: #00ff88;
        padding: 6px; background: #001a11; border: 1px solid #00ff88;
      }
      .face-btn-row { display: flex; gap: 4px; margin-top: 8px; flex-wrap: wrap; }
      .face-btn {
        flex: 1 1 auto; padding: 6px; background: #1a1a33; border: 1px solid #2a2a44;
        color: #888; font-size: 10px; cursor: pointer; font-family: inherit;
        letter-spacing: 1px;
      }
      .face-btn.selected { background: #002211; color: #00ff88; border-color: #00ff88; }
      .adj-btn {
        width: 40px; height: 36px; font-size: 18px;
        background: #111122; border: 1px solid #444; color: #ccc;
        cursor: pointer; font-family: inherit;
      }
      .adj-btn:hover { background: #222244; }
      .cw-footer {
        display: flex; justify-content: space-between; padding: 12px 24px;
        border-top: 1px solid #2a2a44; background: #0f0f22; align-items: center;
      }
      .btn {
        padding: 9px 22px; font-family: inherit; font-size: 12px; letter-spacing: 1px;
        border: 1px solid; background: transparent; cursor: pointer;
      }
      .btn-cancel { color: #888; border-color: #444; }
      .btn-cancel:hover { color: #ccc; border-color: #888; }
      .btn-save { color: #00ff88; border-color: #00ff88; background: #003322; }
      .btn-save:hover { background: #00ff88; color: #0a0a1a; }

      /* Datasheet */
      .cw-body.datasheet { grid-template-columns: 300px 1fr 360px; }
      .cw-body.simple   { grid-template-columns: 260px 1fr 300px; }
      .category { background: #0f0f22; border: 1px solid #2a2a44; margin-bottom: 10px; }
      .category > header {
        padding: 7px 12px; font-size: 10px; color: #aac; letter-spacing: 2px;
        background: #11112a; border-bottom: 1px solid #2a2a44;
        display: flex; justify-content: space-between;
      }
      .category > header .current { color: #00ff88; }
      .category .items { max-height: 280px; overflow-y: auto; }
      .item {
        display: grid; grid-template-columns: 24px 1fr 70px 80px;
        gap: 6px; align-items: center; padding: 7px 10px;
        border-bottom: 1px solid #1a1a33; font-size: 11px; cursor: pointer;
      }
      .item:hover { background: #1a1a33; }
      .item.current { background: #001a11; }
      .item .tag { color: #556; font-size: 10px; }
      .item .name { color: #ccc; }
      .item.current .name { color: #00ff88; font-weight: bold; }
      .item .stat { text-align: right; color: #aac; font-size: 10px; }
      .item .cost { text-align: right; color: #ffcc00; font-size: 10px; }
      .mount-chip {
        display: inline-flex; align-items: center; gap: 4px;
        padding: 2px 7px; margin: 2px 4px 2px 0;
        background: #332200; color: #ffcc00; font-size: 10px;
        border: 1px solid #664400;
      }
      .mount-chip.empty { background: #1a1a2e; color: #666; border-color: #333; }
      .mount-chip button {
        background: none; border: none; color: #ff6666; font-family: inherit;
        cursor: pointer; padding: 0 2px; font-size: 12px; margin-left: 2px;
      }
      .status-msg { font-size: 11px; text-align: center; min-height: 16px; }
    </style>`;
  }

  // ── Header + footer (shared) ─────────────────────────────────────────────

  private renderHeader(): string {
    const title = this.editVehicleId ? `WORKSHOP — ${esc(this.vehicleName)}` : 'VEHICLE DESIGNER';
    const cost = this.stats?.totalCost ?? 0;
    const simpleActive = this.mode === 'simple' ? 'active' : '';
    const dsActive = this.mode === 'datasheet' ? 'active' : '';
    return `
      <div class="cw-header">
        <h1>⚙ ${title}</h1>
        <div class="meta" style="align-items:center;">
          <span>Treasury <b>$${this.treasury.toLocaleString()}</b></span>
          <span>Build <b>$${cost.toLocaleString()}</b></span>
          <div class="cw-toggle">
            <button class="${simpleActive}" data-action="mode" data-value="simple">SIMPLE</button>
            <button class="${dsActive}" data-action="mode" data-value="datasheet">ADVANCED</button>
          </div>
        </div>
      </div>`;
  }

  private renderFooter(): string {
    const save = this.editVehicleId ? 'SAVE CHANGES' : 'BUILD THIS CAR';
    return `
      <div class="cw-footer">
        <button class="btn btn-cancel" data-action="back">[ BACK ]</button>
        <div style="flex:1;text-align:center;">
          <span style="color:#aac;">Name: ${esc(this.vehicleName)}</span>
          <button class="btn btn-cancel" style="margin-left:8px;padding:4px 10px;font-size:10px;" data-action="rename">[RENAME]</button>
          <span class="status-msg" style="display:inline-block;margin-left:14px;color:${this.statusColor};">${esc(this.statusMsg)}</span>
        </div>
        <button class="btn btn-save" data-action="save">[ ${save} ]</button>
      </div>`;
  }

  // ── SIMPLE mode (A) ──────────────────────────────────────────────────────

  private renderSimple(): string {
    const tab = this.activeTab;
    const tabs: Array<{ id: Tab; label: string; badge?: string }> = [
      { id: 'body',       label: 'Body' },
      { id: 'engine',     label: 'Engine' },
      { id: 'armor',      label: 'Armor' },
      { id: 'weapons',    label: 'Weapons', badge: `${this.mounts.length}/3` },
      { id: 'tires',      label: 'Tires' },
      { id: 'suspension', label: 'Suspension' },
    ];
    const tabStrip = `
      <div class="cw-tabs">
        ${tabs.map(t => `
          <button class="tab ${t.id === tab ? 'active' : ''}" data-action="tab" data-value="${t.id}">
            ${t.label}${t.badge ? `<span class="badge">${t.badge}</span>` : ''}
          </button>
        `).join('')}
      </div>`;

    const optionPanel = this.renderSimpleOptionsForTab(tab);
    const stage = `
      <div class="stage">
        <div class="stage-hint">▼ INSPECTION LIFT</div>
        ${this.renderCarSvg(320)}
      </div>`;
    const statsPanel = this.renderSimpleStats();

    return `
      ${tabStrip}
      <div class="cw-body simple">
        ${optionPanel}
        ${stage}
        ${statsPanel}
      </div>`;
  }

  private renderSimpleOptionsForTab(tab: Tab): string {
    if (tab === 'body')       return this.renderOptionList('BODY TYPE', BODY_TYPES, this.bodyType, 'body');
    if (tab === 'engine')     return this.renderEnginePanel();
    if (tab === 'suspension') return this.renderOptionList('SUSPENSION', SUSPENSIONS, this.suspensionType, 'suspension');
    if (tab === 'tires')      return this.renderOptionList('TIRES', TIRE_TYPES, this.tireType, 'tires');
    if (tab === 'armor')      return this.renderArmorPanel();
    if (tab === 'weapons')    return this.renderWeaponsPanel();
    return '';
  }

  private renderOptionList(heading: string, opts: readonly { id: string; label: string }[], current: string, action: string): string {
    return `
      <div class="cw-panel">
        <h3>${heading}</h3>
        <div class="opt-grid">
          ${opts.map(o => `
            <button class="opt ${current === o.id ? 'selected' : ''}" data-action="${action}" data-value="${o.id}">${o.label}</button>
          `).join('')}
        </div>
      </div>`;
  }

  private renderEnginePanel(): string {
    const bodyDef = BODY_TYPES.find(b => b.id === this.bodyType);
    const isCycle = bodyDef?.isCycle ?? false;
    const compat = POWER_PLANTS.filter(p => (p.cycleOnly ?? false) === isCycle);
    return `
      <div class="cw-panel">
        <h3>POWER PLANT</h3>
        <div class="opt-grid">
          ${compat.map(p => `
            <button class="opt ${this.powerPlantType === p.id ? 'selected' : ''}" data-action="engine" data-value="${p.id}">${p.label}</button>
          `).join('')}
        </div>
        <div style="margin-top:14px;font-size:11px;color:#666;">
          ${isCycle ? 'Showing cycle-compatible plants.' : 'Showing car/truck plants.'}
        </div>
      </div>`;
  }

  private renderArmorPanel(): string {
    const faces: Face[] = ['front', 'back', 'left', 'right'];
    return `
      <div class="cw-panel">
        <h3>ARMOR — Type</h3>
        <div class="opt-grid">
          ${ARMOR_TYPES.map(a => `
            <button class="opt ${this.armorType === a.id ? 'selected' : ''}" data-action="armor-type" data-value="${a.id}">${a.label}</button>
          `).join('')}
        </div>
        <h3 style="margin-top:18px;">FACE</h3>
        <div class="face-btn-row">
          ${faces.map(f => `
            <button class="face-btn ${this.selectedFace === f ? 'selected' : ''}" data-action="select-face" data-value="${f}">${f.toUpperCase()}</button>
          `).join('')}
        </div>
        <div class="armor-controls">
          <button class="adj-btn" data-action="armor-adjust" data-value="-1">−</button>
          <div class="value">${this.armor[this.selectedFace]}</div>
          <button class="adj-btn" data-action="armor-adjust" data-value="1">+</button>
        </div>
        <div style="margin-top:8px;font-size:10px;color:#666;text-align:center;">
          Selected face: ${this.selectedFace.toUpperCase()}
        </div>
      </div>`;
  }

  private renderWeaponsPanel(): string {
    return `
      <div class="cw-panel">
        <h3>WEAPONS (${this.mounts.length}/3)</h3>
        <div style="display:grid;grid-template-columns:1fr 50px;gap:4px;">
          ${WEAPONS.map(({ id, label }) => {
            const mount = this.mounts.find(m => m.weaponId === id);
            const active = !!mount;
            const arc = mount ? mount.arc.charAt(0).toUpperCase() : '';
            return `
              <button class="opt ${active ? 'selected' : ''}" data-action="weapon-toggle" data-value="${id}" style="text-align:left;padding-left:10px;">${label}</button>
              <button class="opt" data-action="cycle-arc" data-value="${id}" style="${active ? 'color:#ffcc00;border-color:#664400;background:#332200' : 'opacity:0.3'}" ${active ? '' : 'disabled'}>▸${arc}</button>
            `;
          }).join('')}
        </div>
      </div>`;
  }

  private renderSimpleStats(): string {
    const s = this.stats;
    return `
      <div class="cw-panel">
        <h3>LIVE STATS</h3>
        <div class="stats-list">
          <div class="stat-row"><span>Max Speed</span><span>${s ? `${s.maxSpeed} mph` : '—'}</span></div>
          <div class="stat-row"><span>Accel</span><span>${s ? `${s.acceleration} mph/turn` : '—'}</span></div>
          <div class="stat-row"><span>Handling</span><span>${s ? `${s.handlingClass}` : '—'}</span></div>
          <div class="stat-row"><span>Weight</span><span>${s ? `${s.totalWeight} lbs` : '—'}</span></div>
          <div class="stat-row"><span>Armor total</span><span>${this.armorTotal()} pts</span></div>
        </div>
        <h3 style="margin-top:18px;">COST</h3>
        <div class="stats-list">
          <div class="stat-row"><span>Build cost</span><span style="color:#ccc;">${s ? `$${s.totalCost.toLocaleString()}` : '—'}</span></div>
          <div class="stat-row"><span>Treasury</span><span style="color:#ffcc00;">$${this.treasury.toLocaleString()}</span></div>
          ${s && this.editVehicleId ? `
            <div class="stat-row"><span>After save</span><span>$${Math.max(0, this.treasury - s.totalCost).toLocaleString()}</span></div>
          ` : ''}
        </div>
      </div>`;
  }

  // ── DATASHEET mode (C) ───────────────────────────────────────────────────

  private renderDatasheet(): string {
    return `
      <div class="cw-body datasheet">
        ${this.renderDsPreview()}
        ${this.renderDsComponents()}
        ${this.renderDsImpact()}
      </div>`;
  }

  private renderDsPreview(): string {
    const s = this.stats;
    const mountChips = this.mounts.map(m => {
      if (!m.weaponId) {
        return `<span class="mount-chip empty">▸${m.arc.charAt(0).toUpperCase()} —<button data-action="remove-mount" data-value="${m.id}">×</button></span>`;
      }
      const wep = this.weaponCatalog.find(w => w.id === m.weaponId);
      return `<span class="mount-chip">▸${m.arc.charAt(0).toUpperCase()} ${esc(wep?.name ?? m.weaponId)}<button data-action="remove-mount" data-value="${m.id}">×</button></span>`;
    }).join('');

    const weakFace = (Object.entries(this.armor) as [Face, number][])
      .reduce((min, [face, v]) => v < min[1] ? [face, v] : min, ['front', 99] as [Face, number]);

    return `
      <div class="cw-panel">
        <div style="display:flex;justify-content:center;background:#0a0a1a;border:1px solid #2a2a44;padding:12px;margin-bottom:14px;">
          ${this.renderCarSvg(220)}
        </div>
        <h3>PERFORMANCE</h3>
        <div class="stats-list">
          <div class="stat-row"><span>Max Speed</span><span>${s ? `${s.maxSpeed} mph` : '—'}</span></div>
          <div class="stat-row"><span>Accel</span><span>${s ? `${s.acceleration} mph/t` : '—'}</span></div>
          <div class="stat-row"><span>Handling</span><span>${s ? s.handlingClass : '—'}</span></div>
          <div class="stat-row"><span>Weight</span><span>${s ? `${s.totalWeight} lbs` : '—'}</span></div>
        </div>
        <h3 style="margin-top:14px;">PROTECTION</h3>
        <div class="stats-list">
          <div class="stat-row"><span>Armor total</span><span>${this.armorTotal()} pts</span></div>
          <div class="stat-row"><span>Armor type</span><span>${esc(ARMOR_TYPES.find(a => a.id === this.armorType)?.label ?? '')}</span></div>
          <div class="stat-row"><span>Weak face</span><span style="color:${armorFillCss(weakFace[1])};">${weakFace[0].toUpperCase()} (${weakFace[1]})</span></div>
        </div>
        <h3 style="margin-top:14px;">LOADOUT</h3>
        <div style="margin:6px 0;">${mountChips || '<span style="color:#666;font-size:11px;">No mounts.</span>'}</div>
        <div style="display:flex;gap:4px;margin-top:6px;">
          <button class="opt" style="padding:4px 8px;font-size:10px;" data-action="add-mount" data-value="front">+ front</button>
          <button class="opt" style="padding:4px 8px;font-size:10px;" data-action="add-mount" data-value="back">+ back</button>
          <button class="opt" style="padding:4px 8px;font-size:10px;" data-action="add-mount" data-value="turret">+ turret</button>
        </div>
      </div>`;
  }

  private renderDsComponents(): string {
    const bodyDef = BODY_TYPES.find(b => b.id === this.bodyType);
    const isCycle = bodyDef?.isCycle ?? false;
    const compatPlants = POWER_PLANTS.filter(p => (p.cycleOnly ?? false) === isCycle);

    const section = (title: string, currentLabel: string, items: string): string => `
      <div class="category">
        <header>${title}<span class="current">${esc(currentLabel)}</span></header>
        <div class="items">${items}</div>
      </div>`;

    const row = (tag: string, name: string, selected: boolean, action: string, value: string, cost = '', stat = ''): string => `
      <div class="item ${selected ? 'current' : ''}" data-action="${action}" data-value="${value}">
        <span class="tag">${tag}</span>
        <span class="name">${esc(name)}${selected ? ' ▸ current' : ''}</span>
        <span class="stat">${stat}</span>
        <span class="cost">${cost}</span>
      </div>`;

    const bodyItems = BODY_TYPES.map((b, i) => row(
      `B${i + 1}`, b.label, b.id === this.bodyType, 'body', b.id, '', b.isCycle ? 'cycle' : ''
    )).join('');

    const engineItems = compatPlants.map((p, i) => row(
      `E${i + 1}`, p.label, p.id === this.powerPlantType, 'engine', p.id
    )).join('');

    const suspItems = SUSPENSIONS.map((s, i) => row(
      `S${i + 1}`, s.label, s.id === this.suspensionType, 'suspension', s.id
    )).join('');

    const tireItems = TIRE_TYPES.map((t, i) => row(
      `T${i + 1}`, t.label, t.id === this.tireType, 'tires', t.id
    )).join('');

    const armorItems = ARMOR_TYPES.map((a, i) => row(
      `A${i + 1}`, a.label, a.id === this.armorType, 'armor-type', a.id
    )).join('');

    const weaponItems = this.mounts.map(m => {
      const rows = [`
        <div style="padding:6px 10px;background:#0a0a1a;font-size:10px;color:#aac;letter-spacing:2px;">
          ▸ MOUNT ${esc(m.id.slice(0, 6))} — ARC: ${m.arc.toUpperCase()}
          ${m.weaponId ? `<button class="opt" style="padding:2px 6px;margin-left:8px;font-size:10px;" data-action="cycle-arc" data-value="${esc(m.weaponId)}">cycle arc</button>` : ''}
          <button class="opt" style="padding:2px 6px;margin-left:6px;font-size:10px;color:#ff6666;" data-action="remove-mount" data-value="${m.id}">remove</button>
        </div>
      `];
      rows.push(`
        <div class="item ${!m.weaponId ? 'current' : ''}" data-action="set-mount-weapon" data-value="${m.id}:null">
          <span class="tag">—</span>
          <span class="name">(empty)${!m.weaponId ? ' ▸ current' : ''}</span>
          <span class="stat">refund 50%</span>
          <span class="cost">$0</span>
        </div>`);
      for (const wep of this.weaponCatalog) {
        if (wep.category === 'dropped') continue;
        if (wep.allowedArcs?.length && !wep.allowedArcs.includes(m.arc)) continue;
        const isCurrent = m.weaponId === wep.id;
        const dmg = `${wep.damageDice}d${wep.damageMod ? (wep.damageMod > 0 ? `+${wep.damageMod}` : wep.damageMod) : ''}`;
        rows.push(`
          <div class="item ${isCurrent ? 'current' : ''}" data-action="set-mount-weapon" data-value="${m.id}:${wep.id}">
            <span class="tag">${esc(wep.id.toUpperCase())}</span>
            <span class="name">${esc(wep.name)}${isCurrent ? ' ▸ current' : ''}</span>
            <span class="stat">${dmg} tH${wep.toHit}</span>
            <span class="cost">$${wep.cost.toLocaleString()}</span>
          </div>`);
      }
      return rows.join('');
    }).join('');

    const weaponCurrent = this.mounts.filter(m => m.weaponId).map(m => {
      const w = this.weaponCatalog.find(w => w.id === m.weaponId);
      return w?.name ?? m.weaponId!;
    }).join(' · ') || 'no weapons';

    return `
      <div class="cw-panel">
        ${section('BODY', bodyDef?.label ?? '', bodyItems)}
        ${section('ENGINE', POWER_PLANTS.find(p => p.id === this.powerPlantType)?.label ?? '', engineItems)}
        ${section('SUSPENSION', SUSPENSIONS.find(s => s.id === this.suspensionType)?.label ?? '', suspItems)}
        ${section('TIRES', TIRE_TYPES.find(t => t.id === this.tireType)?.label ?? '', tireItems)}
        ${section('ARMOR TYPE', ARMOR_TYPES.find(a => a.id === this.armorType)?.label ?? '', armorItems)}
        ${section(`WEAPONS (${this.mounts.length}/3)`, weaponCurrent, weaponItems || '<div style="padding:10px;color:#666;font-size:11px;">No mounts — add one from the left panel.</div>')}
      </div>`;
  }

  private renderDsImpact(): string {
    const s = this.stats;
    const faces: Face[] = ['front', 'back', 'left', 'right'];
    const weakFace = faces.reduce((min, f) => this.armor[f] < this.armor[min] ? f : min, faces[0]);
    const weakWarn = this.armor[weakFace] < 10
      ? `<div style="background:#2a1111;border-left:3px solid #ff4444;padding:10px;font-size:11px;color:#ffaaaa;margin-top:10px;">
           <b>${weakFace.toUpperCase()}</b> armor is only ${this.armor[weakFace]} pts. Consider reinforcing.
         </div>` : '';

    return `
      <div class="cw-panel">
        <h3>ARMOR PANEL — ${this.selectedFace.toUpperCase()}</h3>
        <div class="face-btn-row">
          ${faces.map(f => `<button class="face-btn ${this.selectedFace === f ? 'selected' : ''}" data-action="select-face" data-value="${f}">${f.toUpperCase()}</button>`).join('')}
        </div>
        <div class="armor-controls">
          <button class="adj-btn" data-action="armor-adjust" data-value="-1">−</button>
          <div class="value">${this.armor[this.selectedFace]}</div>
          <button class="adj-btn" data-action="armor-adjust" data-value="1">+</button>
        </div>
        <h3 style="margin-top:18px;">CURRENT STATS</h3>
        <div class="stats-list">
          <div class="stat-row"><span>Max Speed</span><span>${s ? `${s.maxSpeed} mph` : '—'}</span></div>
          <div class="stat-row"><span>Handling</span><span>${s ? s.handlingClass : '—'}</span></div>
          <div class="stat-row"><span>Weight</span><span>${s ? `${s.totalWeight} lbs` : '—'}</span></div>
          <div class="stat-row"><span>Build cost</span><span style="color:#ffcc00;">${s ? `$${s.totalCost.toLocaleString()}` : '—'}</span></div>
          <div class="stat-row"><span>Treasury</span><span>$${this.treasury.toLocaleString()}</span></div>
        </div>
        ${weakWarn}
      </div>`;
  }

  // ── Car SVG preview (shared) ─────────────────────────────────────────────

  private renderCarSvg(height: number): string {
    const primary = `#${this.gangPrimaryColour.toString(16).padStart(6, '0')}`;
    const primaryDark = `#${Math.floor(this.gangPrimaryColour * 0.35).toString(16).padStart(6, '0')}`;
    const isCycle = BODY_TYPES.find(b => b.id === this.bodyType)?.isCycle ?? false;
    const bodyW = isCycle ? 40 : 90;
    const bodyH = isCycle ? 140 : 200;

    const vbW = 240;
    const vbH = 340;
    const cx = vbW / 2;
    const cy = vbH / 2;
    const halfW = bodyW / 2;
    const halfH = bodyH / 2;

    const panels: Array<{ face: Face; x: number; y: number; w: number; h: number; labelY: number }> = [
      { face: 'front', x: cx - halfW, y: cy - halfH - 20, w: bodyW, h: 18, labelY: cy - halfH - 8 },
      { face: 'back',  x: cx - halfW, y: cy + halfH + 2,  w: bodyW, h: 18, labelY: cy + halfH + 14 },
      { face: 'left',  x: cx - halfW - 22, y: cy - halfH, w: 18, h: bodyH, labelY: cy },
      { face: 'right', x: cx + halfW + 4,  y: cy - halfH, w: 18, h: bodyH, labelY: cy },
    ];
    const armorSvg = panels.map(p => {
      const pts = this.armor[p.face];
      const fill = armorFillCss(pts);
      return `
        <rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" fill="${fill}" opacity="0.85" stroke="#666" stroke-width="1"/>
        <text x="${p.x + p.w / 2}" y="${p.labelY}" text-anchor="middle" fill="#fff" font-size="10" font-family="monospace" font-weight="bold" dominant-baseline="middle">${pts}</text>`;
    }).join('');

    const wheels = isCycle ? '' : [
      { x: cx - halfW - 10, y: cy - halfH * 0.7 },
      { x: cx + halfW - 4,  y: cy - halfH * 0.7 },
      { x: cx - halfW - 10, y: cy + halfH * 0.4 },
      { x: cx + halfW - 4,  y: cy + halfH * 0.4 },
    ].map(w => `<rect x="${w.x}" y="${w.y}" width="14" height="30" fill="#000" stroke="#fff" stroke-width="1" rx="3"/>`).join('');

    const weaponDots = this.mounts.map(m => {
      if (!m.weaponId) return '';
      const wep = this.weaponCatalog.find(w => w.id === m.weaponId);
      const label = wep ? wep.id.toUpperCase().slice(0, 3) : '?';
      const anchors: Record<ArcType, { x: number; y: number }> = {
        front:  { x: cx, y: cy - halfH - 28 },
        back:   { x: cx, y: cy + halfH + 28 },
        left:   { x: cx - halfW - 30, y: cy },
        right:  { x: cx + halfW + 30, y: cy },
        turret: { x: cx, y: cy },
      };
      const a = anchors[m.arc];
      return `
        <circle cx="${a.x}" cy="${a.y}" r="11" fill="#332200" stroke="#ffcc00" stroke-width="1.5"/>
        <text x="${a.x}" y="${a.y + 3}" text-anchor="middle" fill="#ffcc00" font-size="9" font-family="monospace" font-weight="bold">${esc(label)}</text>`;
    }).join('');

    const chevron = `<polygon points="${cx},${cy - halfH - 34} ${cx + 7},${cy - halfH - 24} ${cx - 7},${cy - halfH - 24}" fill="#ffff88"/>`;

    const faceLabels = `
      <text x="${cx}" y="${cy - halfH - 26}" text-anchor="middle" fill="#ffcc88" font-size="9" font-family="monospace" letter-spacing="2">FRONT</text>
      <text x="${cx}" y="${cy + halfH + 30}" text-anchor="middle" fill="#ccaa66" font-size="9" font-family="monospace" letter-spacing="2">BACK</text>`;

    return `
      <svg width="${height * (vbW / vbH)}" height="${height}" viewBox="0 0 ${vbW} ${vbH}">
        ${wheels}
        <rect x="${cx - halfW}" y="${cy - halfH}" width="${bodyW}" height="${bodyH}" fill="${primary}" stroke="${primaryDark}" stroke-width="2" rx="10"/>
        <rect x="${cx - halfW + 8}" y="${cy - halfH + 16}" width="${bodyW - 16}" height="${bodyH * 0.28}" fill="#00000033" rx="4"/>
        <rect x="${cx - halfW + 8}" y="${cy + halfH - 16 - bodyH * 0.28}" width="${bodyW - 16}" height="${bodyH * 0.28}" fill="#00000033" rx="4"/>
        ${chevron}
        ${armorSvg}
        ${weaponDots}
        ${faceLabels}
      </svg>`;
  }

  // ── Misc helpers ─────────────────────────────────────────────────────────

  private armorTotal(): number {
    return this.armor.front + this.armor.back + this.armor.left + this.armor.right;
  }

  // ── Live stats (debounced) ───────────────────────────────────────────────

  private scheduleStatsRefresh(): void {
    if (this.statsDebounce) clearTimeout(this.statsDebounce);
    this.statsDebounce = setTimeout(() => {
      this.statsDebounce = null;
      this.refreshStats();
    }, 180);
  }

  private async refreshStats(): Promise<void> {
    const reqId = ++this.statsReqId;
    try {
      const host = window.location.hostname;
      const res = await fetch(`http://${host}:3001/api/vehicles/design`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify(this.buildDesignPayload()),
      });
      if (reqId !== this.statsReqId) return;
      if (res.ok) {
        const s = await res.json();
        this.stats = {
          maxSpeed: s.maxSpeed,
          acceleration: s.acceleration,
          handlingClass: s.handlingClass,
          totalWeight: s.totalWeight,
          totalCost: s.totalCost,
        };
        this.flashStatus('', '#888');
      } else {
        const err = await res.json().catch(() => ({}));
        this.stats = null;
        this.flashStatus(err.error ?? 'Design error', '#ff4444');
      }
    } catch {
      if (reqId !== this.statsReqId) return;
      this.flashStatus('Network error', '#ff4444');
    }
    this.rebuild();
  }

  private buildDesignPayload() {
    return {
      chassisId:    this.bodyType,
      engineId:     this.powerPlantType,
      suspensionId: this.suspensionType,
      tires: [
        { id: 't0', blown: false }, { id: 't1', blown: false },
        { id: 't2', blown: false }, { id: 't3', blown: false },
      ],
      mounts: this.mounts,
      armor: { ...this.armor, top: 0, underbody: 0 },
      totalCost: 0,
      bodyType:       this.bodyType,
      powerPlantType: this.powerPlantType,
      suspensionType: this.suspensionType,
      tireType:       this.tireType,
      armorType:      this.armorType,
    };
  }

  // ── Save ─────────────────────────────────────────────────────────────────

  private async saveVehicle(): Promise<void> {
    if (!this.stats) {
      this.flashStatus('Stats still loading — try again', '#ffaa00');
      this.rebuild();
      return;
    }
    this.flashStatus('Saving…', '#aaa');
    this.rebuild();
    try {
      const host = window.location.hostname;
      const loadout = { ...this.buildDesignPayload(), totalCost: this.stats.totalCost };
      let res: Response;
      if (this.editVehicleId) {
        res = await fetch(`http://${host}:3001/api/vehicles/${this.editVehicleId}/loadout`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
          body: JSON.stringify(loadout),
        });
      } else {
        res = await fetch(`http://${host}:3001/api/vehicles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
          body: JSON.stringify({ name: this.vehicleName, loadout }),
        });
      }
      if (res.ok) {
        this.flashStatus(this.editVehicleId ? 'Changes saved!' : 'Vehicle created!', '#00ff88');
        this.rebuild();
        this.time.delayedCall(900, () => this.scene.start('GarageScene', { token: this.token }));
      } else {
        const err = await res.json().catch(() => ({}));
        this.flashStatus(err.error ?? 'Save failed', '#ff4444');
        this.rebuild();
      }
    } catch {
      this.flashStatus('Network error', '#ff4444');
      this.rebuild();
    }
  }
}
