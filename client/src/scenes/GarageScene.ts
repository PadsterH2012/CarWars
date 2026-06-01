import Phaser from 'phaser';
import { paintEmblem, EMBLEM_IDS, type EmblemId } from '../game/CoatOfArms';
import { bindFullscreenToggle } from '../ui/responsive';
import { preloadVehicleSprites, bodySpriteKey } from '../game/VehicleSprite';
import { esc, renderInto, buildSidebarHTML, createHubRoot, wireNavigation, showToast, SidebarOpts } from '../ui/hub';

type AvailabilityStatus = 'available' | 'deployed' | 'on_job' | 'in_arena' | 'wounded';
interface Vehicle { id: string; name: string; value: number; damage_state: any; loadout: any; in_arena?: boolean; status?: AvailabilityStatus; remainingSeconds?: number; deploymentZone?: string | null; }
interface DriverAttributes { st: number; dx: number; iq: number; ht: number; }
interface Driver { id: string; name: string; skill: number; xp: number; xp_pool?: number; assigned_vehicle_id: string | null; alive: boolean; wounded: boolean; wounded_until: string | null; title?: string; xpToNext?: number; status?: AvailabilityStatus; remainingSeconds?: number; attributes?: DriverAttributes; skills?: Record<string, number>; }
interface Deployment { id: string; zone_id: string; job_id?: string | null; assignment: string; status: string; eta_seconds: number; }

// Compact ETA used by the status pills + deployments list ("1m 20s" / "45s").
function fmtRemaining(seconds: number): string {
  if (seconds <= 0) return 'now';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// Status → dot colour for the vehicle/driver rows.
const STATUS_DOT: Record<AvailabilityStatus, number> = {
  available: 0x00ff88,
  deployed: 0xffaa00,
  on_job: 0xff8800,
  in_arena: 0x44aaff,
  wounded: 0xff4444,
};
interface Gang { id: string; name: string; primary_colour: number; secondary_colour: number; emblem_id: EmblemId; treasury: number; reputation: number; }
interface DriverRequest {
  id: string; kind: string; description: string; cost: number;
  driver_id: string; driver_name: string; driver_skill: number;
  vehicle_id: string | null; vehicle_name: string | null;
}
interface GarageStatus {
  owned: boolean; cost?: number; vehicleCount: number; maxVehicles: number;
  repairDiscount?: number; accumulatedIncome?: number; incomeThisVisit?: number;
}

export class GarageScene extends Phaser.Scene {
  private token = '';
  private vehicles: Vehicle[] = [];
  private drivers: Driver[] = [];
  private driverRequests: DriverRequest[] = [];
  private gang: Gang | null = null;
  private garage: GarageStatus | null = null;
  private money = 0;
  private division = 0;
  private unreadReports = 0; // squad after-action reports awaiting the player
  private unreadActivity = 0;
  private activityLog: { id: string; description: string; action_type: string; read: boolean; resolved: boolean }[] = [];
  private showActivityLog = false;
  private deployments: Deployment[] = []; // squads currently out (in_transit)
  private selectedVehicleId = '';
  private selectedDriverId = '';
  private justFoughtVehicleId = ''; // vehicle just back from arena
  private playerRank = 0;
  private totalGangs = 0;
  private endgame = false;
  private root!: HTMLDivElement;
  private sidebarEl!: HTMLElement;
  private mainEl!: HTMLElement;

  constructor() { super({ key: 'GarageScene' }); }

  preload(): void {
    preloadVehicleSprites(this);
  }

  init(data: { token: string; justFoughtVehicleId?: string }): void {
    this.token = data.token;
    this.justFoughtVehicleId = data.justFoughtVehicleId ?? '';
    this.unreadActivity = 0;
    this.activityLog = [];
    this.showActivityLog = false;
    this.playerRank = 0;
    this.totalGangs = 0;
    this.endgame = false;
  }

  async create(): Promise<void> {
    const host = window.location.hostname;

    const [meRes, vRes, dRes, gRes, reqRes, bayRes, repRes, depRes, actRes, lbRes] = await Promise.all([
      fetch(`http://${host}:3001/api/me`, { headers: { Authorization: `Bearer ${this.token}` } }),
      fetch(`http://${host}:3001/api/vehicles`, { headers: { Authorization: `Bearer ${this.token}` } }),
      fetch(`http://${host}:3001/api/drivers`, { headers: { Authorization: `Bearer ${this.token}` } }),
      fetch(`http://${host}:3001/api/gangs/mine`, { headers: { Authorization: `Bearer ${this.token}` } }),
      fetch(`http://${host}:3001/api/drivers/requests`, { headers: { Authorization: `Bearer ${this.token}` } }),
      // Visiting the garage resolves passive income lazily (server-side on GET).
      fetch(`http://${host}:3001/api/garages`, { headers: { Authorization: `Bearer ${this.token}` } }),
      // Resolves any due squad deployments and returns the unread report count.
      fetch(`http://${host}:3001/api/reports/unread-count`, { headers: { Authorization: `Bearer ${this.token}` } }),
      // Active squad deployments (in_transit) for the status panel + ETAs.
      fetch(`http://${host}:3001/api/deploy`, { headers: { Authorization: `Bearer ${this.token}` } }),
      fetch(`http://${host}:3001/api/territory/activity/unread-count`, { headers: { Authorization: `Bearer ${this.token}` } }),
      fetch(`http://${host}:3001/api/leaderboard`, { headers: { Authorization: `Bearer ${this.token}` } }),
    ]);
    const me = await meRes.json();
    this.money = me.money ?? 0;
    this.division = me.division ?? 0;
    this.selectedVehicleId = me.selected_vehicle_id ?? '';
    this.selectedDriverId = me.selected_driver_id ?? '';
    this.vehicles = await vRes.json();
    this.drivers = await dRes.json();
    if (gRes.ok) this.gang = await gRes.json();
    if (reqRes.ok) this.driverRequests = await reqRes.json();
    if (bayRes.ok) this.garage = await bayRes.json();
    if (repRes.ok) this.unreadReports = (await repRes.json()).unread ?? 0;
    if (actRes?.ok) this.unreadActivity = (await actRes.json()).unread ?? 0;
    // Fetch activity log if there are unread entries
    if (this.unreadActivity > 0) {
      try {
        const logRes = await fetch(`http://${host}:3001/api/territory/activity`, {
          headers: { Authorization: `Bearer ${this.token}` },
        });
        if (logRes.ok) this.activityLog = (await logRes.json()).entries ?? [];
      } catch (_e) {}
    }
    if (depRes.ok) {
      const rows: Deployment[] = await depRes.json();
      // Job deployments surface on the Job Board's "in progress" list (and the
      // vehicle/driver rows already show DEPLOYED/ON JOB), so the garage's
      // squad-deployment panel shows only zone deployments — never a job's null zone.
      this.deployments = rows.filter(d => d.status === 'in_transit' && !d.job_id);
    }
    if (lbRes?.ok) {
      const lb = await lbRes.json();
      this.playerRank = lb.playerRank ?? 0;
      this.totalGangs = lb.totalGangs ?? 0;
      this.endgame    = lb.endgame ?? false;
    }

    // Build DOM overlay
    this.root = createHubRoot(this);

    const sidebar = document.createElement('nav');
    sidebar.className = 'sidebar';
    this.sidebarEl = sidebar;

    this.mainEl = document.createElement('div');
    this.mainEl.className = 'main';

    this.root.appendChild(sidebar);
    this.root.appendChild(this.mainEl);

    this.rebuildSidebar();
    this.rebuildMain();

    wireNavigation(this.root, this, this.token);
    this.root.addEventListener('click', this.onClick.bind(this));

    // Close modals on Escape
    this.input.keyboard?.on('keydown-ESC', () => {
      this.root.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
    });

    bindFullscreenToggle(this);
  }

  private renderGarage(): void {
    // migrated to HTML overlay
  }

  private rebuildSidebar(): void {
    const opts: SidebarOpts = {
      gangName:      this.gang?.name ?? '',
      gangColor:     this.gang?.primary_colour ?? 0xff4444,
      treasury:      this.money ?? 0,
      reputation:    this.gang?.reputation ?? 0,
      division:      this.division ?? 1,
      influence:     (this.gang as any)?.influence ?? 0,
      reportsBadge:  this.unreadReports ?? 0,
      activityBadge: this.unreadActivity ?? 0,
      activeNav:     'garage',
      token:         this.token,
    };
    renderInto(this.sidebarEl, buildSidebarHTML(opts));
  }

  private rebuildMain(): void {
    renderInto(this.mainEl, `
      <div class="topbar">${this.buildArenaTabsHTML()}</div>
      <div class="garage-content">
        <div class="vehicle-panel" id="garage-vehicle-panel">${this.buildVehicleListHTML()}</div>
        <div class="crew-panel" id="garage-crew-panel">${this.buildCrewPanelHTML()}</div>
      </div>
    `);
  }

  private buildArenaTabsHTML(): string {
    const maps = ['Truck Stop', 'Town Square', 'Open Arena', 'Double Drum'];
    const selectedMap = localStorage.getItem('cw_selected_map') ?? maps[0];
    const tabs = maps.map(m =>
      `<button class="arena-tab${m === selectedMap ? ' active' : ''}"
               data-action="select-map" data-map="${esc(m)}">${esc(m)}</button>`
    ).join('');
    return `
      <span class="topbar-label">Arena</span>
      <div class="arena-tabs">${tabs}</div>
      <div class="map-btns" style="margin-left:auto">
        <button class="btn btn-ghost" data-action="view-map" style="font-size:11px;padding:4px 9px">View Map</button>
        <button class="btn btn-ghost" data-action="edit-map" style="font-size:11px;padding:4px 9px">Edit Map</button>
      </div>`;
  }

  /** Sum all per-facing values in an armor object. */
  private sumArmor(armorObj: Record<string, number> | undefined): number {
    if (!armorObj) return 0;
    return Object.values(armorObj).reduce((s, v) => s + (v ?? 0), 0);
  }

  private buildVehicleListHTML(): string {
    if (!this.vehicles.length) {
      return `<div class="panel-heading">
        <span>Vehicles (0)</span>
        <button class="btn btn-green" data-action="build-new" style="font-size:11px;padding:4px 10px">+ Build New</button>
      </div>
      <p style="color:var(--gray);padding:16px;font-size:13px">No vehicles yet — buy one from the Shop.</p>`;
    }

    const cards = this.vehicles.map(v => {
      const driver = this.drivers.find(d => d.assigned_vehicle_id === v.id && d.alive);
      const isSelected = v.id === this.selectedVehicleId;

      const maxArmor = this.sumArmor(v.loadout?.armor);
      const curArmor = this.sumArmor(v.damage_state?.armor);
      const armourPct = maxArmor > 0 ? curArmor / maxArmor : 1;
      const nameColor = v.damage_state?.destroyed ? 'vn-gray'
        : armourPct > 0.6 ? 'vn-green'
        : armourPct > 0.2 ? 'vn-yellow'
        : 'vn-red';
      const dotColor = v.damage_state?.destroyed ? 'dot-dim'
        : v.status === 'in_arena' ? 'dot-amber'
        : v.status === 'deployed' || v.status === 'on_job' ? 'dot-yellow'
        : armourPct > 0.5 ? 'dot-green'
        : armourPct > 0.2 ? 'dot-yellow'
        : 'dot-red';

      const canFight = !!driver && !v.damage_state?.destroyed && v.status === 'available';

      // Build a weapon summary from the loadout mounts
      const mounts: any[] = v.loadout?.mounts ?? [];
      const weaponsSummary = mounts
        .filter((m: any) => m.weapon)
        .map((m: any) => m.weapon.name ?? m.weapon.id ?? '')
        .filter(Boolean)
        .join(', ');

      const needsRepair = !v.damage_state?.destroyed && curArmor < maxArmor;

      return `
        <div class="vehicle-card${isSelected ? ' selected' : ''}" data-vehicle-id="${esc(v.id)}">
          <div class="vehicle-thumb">
            <span class="dot ${dotColor}" style="position:absolute;top:4px;right:4px"></span>
          </div>
          <div class="vehicle-info">
            <div class="vehicle-name ${nameColor}">${esc(v.name)}</div>
            <div class="vehicle-meta">
              <span>Value <span class="val">$${esc(v.value?.toLocaleString() ?? '0')}</span></span>
              <span>Div <span class="val">${esc(this.division)}</span></span>
              <span>Armor <span class="val">${esc(curArmor)}/${esc(maxArmor)}</span></span>
              ${v.status && v.status !== 'available' ? `<span style="color:var(--amber)">${esc(v.status.replace('_', ' '))}</span>` : ''}
            </div>
            <div class="vehicle-driver${driver ? '' : ' unassigned'}">
              ${driver
                ? `<span class="dot dot-green"></span> ${esc(driver.name)} · Skill ${esc(driver.skill)}`
                : '— No driver assigned'}
            </div>
            <div class="vehicle-weapons">${esc(weaponsSummary)}</div>
            <div class="vehicle-actions">
              <button class="btn btn-red" ${canFight ? '' : 'disabled'}
                data-action="fight" data-vehicle-id="${esc(v.id)}">Fight</button>
              ${needsRepair
                ? `<button class="btn btn-yellow" data-action="repair" data-vehicle-id="${esc(v.id)}">Repair</button>`
                : ''}
              <button class="btn btn-blue" data-action="workshop" data-vehicle-id="${esc(v.id)}">Workshop</button>
              <button class="btn" data-action="sell" data-vehicle-id="${esc(v.id)}">Sell</button>
            </div>
          </div>
        </div>`;
    }).join('');

    return `
      <div class="panel-heading">
        <span>Vehicles (${esc(this.vehicles.length)})</span>
        <button class="btn btn-green" data-action="build-new" style="font-size:11px;padding:4px 10px">+ Build New</button>
      </div>
      ${cards}`;
  }

  private buildCrewPanelHTML(): string {
    const driverRows = this.drivers.map(d => {
      const assignedVehicle = d.assigned_vehicle_id
        ? this.vehicles.find(v => v.id === d.assigned_vehicle_id)?.name ?? 'Assigned'
        : null;
      const status = d.wounded ? 'Wounded'
        : assignedVehicle ?? 'Available';
      const dotClass = d.wounded ? 'dot-red'
        : assignedVehicle ? 'dot-yellow'
        : 'dot-dim';
      const statusColor = d.wounded ? 'var(--red)'
        : assignedVehicle ? 'var(--amber)'
        : 'var(--green)';
      const skillKeys = Object.keys(d.skills ?? {}).filter(k => (d.skills![k] ?? 0) > 0);
      const skillSummary = skillKeys.length
        ? skillKeys.map(k => `${k.replace(/_/g, ' ')} ${d.skills![k]}`).join(' · ')
        : '—';

      return `
        <div class="driver-row" data-action="driver-card" data-driver-id="${esc(d.id)}">
          <span class="dot ${dotClass}"></span>
          <div class="driver-name">${esc(d.name)}</div>
          <div class="driver-meta">
            <span style="color:${statusColor};font-size:10px">${esc(status)}</span>
            <span style="color:var(--dim);font-size:10px">Skill ${esc(d.skill)}</span>
          </div>
        </div>
        <div class="driver-skills">${esc(skillSummary)}</div>`;
    }).join('');

    const deploymentRows = this.deployments.slice(0, 4).map(dep =>
      `<div class="deployment-row">
         <span>${esc(dep.assignment ?? dep.zone_id)}</span>
         <span class="eta">${esc(fmtRemaining(dep.eta_seconds))}</span>
       </div>`
    ).join('');

    return `
      <div class="crew-header">
        <span class="crew-title">Crew (${esc(this.drivers.length)})</span>
        <button class="btn btn-green" data-action="hire" style="font-size:11px;padding:4px 8px">+ Hire</button>
      </div>
      <div class="driver-list">${driverRows || '<p style="color:var(--dim);font-size:12px;padding:12px 14px">No crew hired yet.</p>'}</div>
      ${deploymentRows ? `
        <div class="deployments-section">
          <div class="deployments-title">Active Deployments</div>
          ${deploymentRows}
        </div>` : ''}`;
  }

  private rebuildVehiclePanel(): void {
    const el = this.mainEl.querySelector('#garage-vehicle-panel') as HTMLElement | null;
    if (el) renderInto(el, this.buildVehicleListHTML());
  }

  private onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;

    // Vehicle card selection (click on card but not a button)
    const card = target.closest<HTMLElement>('.vehicle-card');
    if (card && !target.closest('button')) {
      this.selectedVehicleId = card.dataset.vehicleId ?? '';
      this.rebuildVehiclePanel();
      return;
    }

    const actionEl = target.closest<HTMLElement>('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action!;

    switch (action) {
      case 'select-map': {
        const map = actionEl.dataset.map ?? '';
        localStorage.setItem('cw_selected_map', map);
        const topbar = this.mainEl.querySelector('.topbar') as HTMLElement | null;
        if (topbar) renderInto(topbar, this.buildArenaTabsHTML());
        break;
      }
      case 'view-map':
        this.scene.start('MapViewerScene', { token: this.token });
        break;
      case 'edit-map':
        this.scene.start('MapEditorScene', { token: this.token });
        break;
      case 'build-new':
        this.scene.start('VehicleDesignerScene', { token: this.token, mode: 'new' });
        break;
      case 'workshop': {
        const vid = actionEl.dataset.vehicleId ?? '';
        this.scene.start('VehicleDesignerScene', { token: this.token, vehicleId: vid });
        break;
      }
      // fight, repair, sell, driver-card, hire handled in Task 6
    }
  }

  private async doDefend(logEntryId: string): Promise<void> {
    const h = window.location.hostname;
    const res = await fetch(`http://${h}:3001/api/territory/attack/prepare-defense`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ logEntryId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error ?? 'Could not prepare defense');
      return;
    }
    const { vehicleIds, logEntryId: confirmedId } = await res.json();
    this.scene.start('ArenaScene', {
      token: this.token,
      vehicleId: vehicleIds[0],
      squadVehicleIds: vehicleIds,
      defenseZoneId: `arena-defense-${confirmedId}`,
    });
  }

  private async doSimulate(logEntryId: string, btn: HTMLButtonElement): Promise<void> {
    btn.textContent = '[SIMULATING...]';
    btn.style.color = '#888888';
    const h = window.location.hostname;
    const res = await fetch(`http://${h}:3001/api/territory/attack/simulate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ logEntryId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      btn.textContent = '[SIMULATE]';
      btn.style.color = '#ffaa44';
      alert(err.error ?? 'Simulation failed');
      return;
    }
    const result = await res.json();
    this.activityLog = this.activityLog.filter(e => e.id !== logEntryId);
    this.rebuildMain();
    const msg = result.playerWon
      ? `DEFENSE SUCCESS vs ${result.gangName} — ${result.gangName} lost influence in ${result.settlementName}.${result.repairCost ? ` Repairs: $${result.repairCost.toLocaleString()}` : ''}`
      : `DEFENSE FAILED vs ${result.gangName} — you lost influence in ${result.settlementName}. Repairs: $${(result.repairCost ?? 0).toLocaleString()}`;
    alert(msg);
  }

  // Buy a garage bay ($50k). On success, restart the scene so the storage cap,
  // discount and income status all refresh from the server.
  private async purchaseGarageBay(btn: Phaser.GameObjects.Text): Promise<void> {
    const host = window.location.hostname;
    const cost = this.garage?.cost ?? 50000;
    if (this.money < cost) { btn.setText('[ NOT ENOUGH MONEY ]').setColor('#ff6666'); return; }
    const res = await fetch(`http://${host}:3001/api/garages/purchase`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.token}` },
    });
    if (res.ok) {
      this.scene.restart({ token: this.token });
    } else {
      const err = await res.json().catch(() => ({}));
      btn.setText(`[ ${err.error ?? 'PURCHASE FAILED'} ]`).setColor('#ff6666');
    }
  }

  // Fire-and-forget persistence of the player's current vehicle (and the
  // driver assigned to it, if any). Updates local state immediately so the
  // highlight survives the next renderGarage(), even if the request races.
  private persistSelection(vehicleId: string, driverId: string | null): void {
    const host = window.location.hostname;
    this.selectedVehicleId = vehicleId;
    fetch(`http://${host}:3001/api/me/select-vehicle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ vehicleId }),
    }).catch(() => { /* selection persistence is best-effort */ });
    if (driverId) {
      this.selectedDriverId = driverId;
      fetch(`http://${host}:3001/api/me/select-driver`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ driverId }),
      }).catch(() => { /* selection persistence is best-effort */ });
    }
  }

  private async repairVehicle(vehicleId: string): Promise<void> {
    await this.showRepairModal(vehicleId);
  }

  private async showRepairModal(vehicleId: string): Promise<void> {
    const host = window.location.hostname;
    const quoteRes = await fetch(`http://${host}:3001/api/economy/repair/quote?vehicleId=${vehicleId}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!quoteRes.ok) {
      const body = await quoteRes.json().catch(() => ({}));
      alert(body.error ?? 'Could not fetch repair quote');
      return;
    }
    const quote = await quoteRes.json();

    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', zIndex: '200',
      background: 'rgba(0,0,0,0.82)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: "'Courier New', monospace",
    });
    const panel = document.createElement('div');
    Object.assign(panel.style, {
      background: '#0f0f22', border: '2px solid #ffcc00', color: '#ccc',
      padding: '20px', width: 'min(540px, 92vw)',
      boxShadow: '0 10px 40px rgba(0,0,0,0.6)',
    });
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const esc = (s: string): string =>
      s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

    // hasWork defaults to cost > 0, but free-ammo repairs pass rounds > 0 explicitly
    const row = (label: string, detail: string, cost: number, key: string, hasWork = cost > 0): string => `
      <label style="display:grid;grid-template-columns:20px 1fr auto;gap:10px;align-items:center;padding:8px 0;border-bottom:1px dotted #2a2a44;cursor:${hasWork ? 'pointer' : 'default'};">
        <input type="checkbox" name="part" value="${key}" ${hasWork ? 'checked' : 'disabled'} style="cursor:inherit;"/>
        <div>
          <div style="color:#ccc;font-size:12px;">${esc(label)}</div>
          ${detail ? `<div style="color:#888;font-size:10px;">${esc(detail)}</div>` : ''}
        </div>
        <span style="color:${cost > 0 ? '#ffcc00' : '#555'};font-size:12px;font-weight:bold;">${cost > 0 ? '$' + cost.toLocaleString() : '—'}</span>
      </label>`;

    const aff = (n: number): boolean => !!this.gang && this.gang.treasury >= n;
    const render = (): void => {
      panel.textContent = '';
      const range = document.createRange();
      range.selectNodeContents(panel);
      const html = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <h2 style="margin:0;color:#ffcc00;letter-spacing:2px;">REPAIR BREAKDOWN</h2>
          <div style="font-size:11px;color:#888;">Treasury <b style="color:#ffcc00;">$${this.gang?.treasury.toLocaleString() ?? 0}</b></div>
        </div>
        <div style="margin-bottom:10px;font-size:11px;color:#aac;">Uncheck items to leave them damaged — only pay for what you want fixed.</div>
        ${row('Armour', `${quote.armor.pts} pts missing`, quote.armor.cost, 'armor')}
        ${row('Tires',  quote.tires.count > 0 ? `${quote.tires.count} blown × $${quote.tires.eachCost} each` : 'none blown', quote.tires.cost, 'tires')}
        ${row('Engine', quote.engine.damaged ? 'damaged (half install cost)' : 'no damage', quote.engine.cost, 'engine')}
        ${row('Ammo refill', quote.ammo.rounds > 0 ? `${quote.ammo.rounds} rounds across ${quote.ammo.byMount.length} mount(s)` : 'full load', quote.ammo.cost, 'ammo', quote.ammo.rounds > 0)}
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0 4px;border-top:1px solid #2a2a44;margin-top:8px;">
          <span style="color:#ccc;font-size:13px;">TOTAL SELECTED</span>
          <span id="repair-total" style="color:#ffcc00;font-size:16px;font-weight:bold;">$${quote.total.toLocaleString()}</span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:14px;gap:8px;">
          <button data-action="cancel" style="padding:8px 18px;font-family:inherit;font-size:12px;background:transparent;color:#888;border:1px solid #444;cursor:pointer;">[ CANCEL ]</button>
          <button data-action="repair" id="btn-repair" style="padding:8px 22px;font-family:inherit;font-size:13px;background:${aff(quote.total) ? '#332200' : '#221100'};color:${aff(quote.total) ? '#ffcc00' : '#555'};border:1px solid ${aff(quote.total) ? '#ffcc00' : '#555'};cursor:${aff(quote.total) ? 'pointer' : 'not-allowed'};">${aff(quote.total) ? '[ REPAIR ]' : '[ NO FUNDS ]'}</button>
        </div>`;
      panel.appendChild(range.createContextualFragment(html));
    };

    const selectedTotal = (): { parts: string[]; total: number } => {
      const checks = Array.from(panel.querySelectorAll<HTMLInputElement>('input[name="part"]:checked'));
      const parts = checks.map(c => c.value);
      let total = 0;
      if (parts.includes('armor'))  total += quote.armor.cost;
      if (parts.includes('tires'))  total += quote.tires.cost;
      if (parts.includes('engine')) total += quote.engine.cost;
      if (parts.includes('ammo'))   total += quote.ammo.cost;
      return { parts, total };
    };

    // True when the selected parts include at least one free repair (rounds depleted, cost = 0).
    const hasFreeWork = (parts: string[]): boolean =>
      parts.includes('ammo') && quote.ammo.rounds > 0 && quote.ammo.cost === 0;

    panel.addEventListener('change', () => {
      const { parts, total } = selectedTotal();
      const totalEl = panel.querySelector('#repair-total');
      const btn = panel.querySelector<HTMLButtonElement>('#btn-repair');
      if (totalEl) totalEl.textContent = '$' + total.toLocaleString();
      if (btn) {
        const ok = (aff(total) && total > 0) || hasFreeWork(parts);
        btn.disabled = !ok;
        btn.style.cursor = ok ? 'pointer' : 'not-allowed';
        btn.style.background = ok ? '#332200' : '#221100';
        btn.style.color = ok ? '#ffcc00' : '#555';
        btn.style.borderColor = ok ? '#ffcc00' : '#555';
        btn.textContent = ok ? '[ REPAIR ]' : total === 0 ? '[ NOTHING SELECTED ]' : '[ NO FUNDS ]';
      }
    });

    panel.addEventListener('click', async (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'cancel') { overlay.remove(); return; }
      if (btn.dataset.action === 'repair') {
        const { parts, total } = selectedTotal();
        if (total === 0 && !hasFreeWork(parts)) return;
        const r = await fetch(`http://${host}:3001/api/economy/repair`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
          body: JSON.stringify({ vehicleId, parts }),
        });
        if (r.ok) {
          overlay.remove();
          this.scene.restart({ token: this.token });
        } else {
          const body = await r.json().catch(() => ({}));
          alert(body.error ?? 'Repair failed');
        }
      }
    });

    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    render();
  }

  private showDriverCard(driver: Driver): void {
    const SKILL_LABELS: Record<string, string> = {
      driving_light: 'Light Drive', driving_standard: 'Std Drive', driving_heavy: 'Hvy Drive', driving_mega: 'Mega Drive',
      gunnery_guns: 'Guns', gunnery_heavy: 'Hvy Guns', gunnery_rockets: 'Rockets', gunnery_lasers: 'Lasers',
      gunnery_flamers: 'Flamers', gunnery_tactical: 'Tactical',
      mechanic: 'Mechanic', leadership: 'Leadership', medical: 'Medical', fire_aid: 'Fire Aid',
      barter: 'Barter', navigation: 'Navigation', streetwise: 'Streetwise',
    };
    const SKILL_DIFFICULTY: Record<string, number> = {
      driving_light: 1, driving_standard: 1, driving_heavy: 1, driving_mega: 1,
      gunnery_guns: 1, gunnery_heavy: 3, gunnery_rockets: 2, gunnery_lasers: 2,
      gunnery_flamers: 3, gunnery_tactical: 3,
      mechanic: 1, leadership: 2, medical: 3, fire_aid: 3, barter: 1, navigation: 1, streetwise: 2,
    };
    const SKILL_ATTR: Record<string, string> = {
      driving_light: 'dx', driving_standard: 'dx', driving_heavy: 'dx', driving_mega: 'dx',
      gunnery_guns: 'dx', gunnery_heavy: 'st', gunnery_rockets: 'dx', gunnery_lasers: 'dx',
      gunnery_flamers: 'dx', gunnery_tactical: 'dx',
      mechanic: 'iq', leadership: 'iq', medical: 'iq', fire_aid: 'ht',
      barter: 'iq', navigation: 'iq', streetwise: 'iq',
    };
    const SKILL_INFO: Record<string, { cover: string; bonus: string }> = {
      driving_light:    { cover: 'Subcompact, Compact, Light/Med Cycle',     bonus: '+1 HC per 3 lvls' },
      driving_standard: { cover: 'Mid-Sized, Sedan, Luxury, Station Wagon, Trike', bonus: '+1 HC per 3 lvls' },
      driving_heavy:    { cover: 'Pickup, Van, Camper, Hvy Cycle',           bonus: '+1 HC per 3 lvls' },
      driving_mega:     { cover: 'Truck, Trailer, Bus',                      bonus: '+1 HC per 3 lvls' },
      gunnery_guns:     { cover: 'MG, VMG, AC, RR, HMG',                     bonus: '+1 accuracy per 2 lvls; -1 link penalty per 3' },
      gunnery_heavy:    { cover: 'GL, ATG, BC',                              bonus: '+1 accuracy per 2 lvls; -1 link penalty per 3' },
      gunnery_rockets:  { cover: 'LTR, MR, HR, RL, MML',                     bonus: '+1 accuracy per 2 lvls; -1 link penalty per 3' },
      gunnery_lasers:   { cover: 'LL, ML, L, HL',                            bonus: '+1 accuracy per 2 lvls; -1 link penalty per 3' },
      gunnery_flamers:  { cover: 'LFT, FT',                                  bonus: '+1 accuracy per 2 lvls; -1 link penalty per 3' },
      gunnery_tactical: { cover: 'Spikedropper, Oil Jet, Oil Slick, Mine',   bonus: '+1 accuracy per 2 lvls; -1 link penalty per 3' },
      mechanic:         { cover: 'Repair costs, upgrade options',             bonus: '-2% repair cost per lvl' },
      leadership:       { cover: 'Squad size, driver loyalty',                bonus: '+1 squad size at 5/10' },
      medical:          { cover: 'Driver wound recovery',                     bonus: 'Faster recovery rate' },
      fire_aid:         { cover: 'Fire suppression',                          bonus: '-1 fire dmg per 3 lvls' },
      barter:           { cover: 'Trade prices (buy/sell/repair)',            bonus: 'Better prices per lvl' },
      navigation:       { cover: 'Fuel efficiency, travel speed',             bonus: 'Less fuel, faster travel' },
      streetwise:       { cover: 'Contract quality, hire quality',            bonus: 'Better jobs & recruits' },
    };
    const upgradeCost = (level: number, skillId: string): number => {
      const diff = SKILL_DIFFICULTY[skillId] ?? 1;
      const attrKey = SKILL_ATTR[skillId] ?? 'dx';
      const attrVal = (driver.attributes as any)?.[attrKey] ?? 10;
      const discount = Math.min(1.5, Math.max(0.5, 1.5 - attrVal / 20));
      return Math.round(Math.pow(level + 1, 2) * 50 * diff * discount);
    };

    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', zIndex: '200',
      background: 'rgba(0,0,0,0.82)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: "'Courier New', monospace",
    });
    const panel = document.createElement('div');
    Object.assign(panel.style, {
      background: '#0f0f22', border: '2px solid #4466aa', color: '#ccc',
      padding: '20px', width: 'min(520px, 92vw)',
      boxShadow: '0 10px 40px rgba(0,0,0,0.6)',
    });
    const tooltip = document.createElement('div');
    Object.assign(tooltip.style, {
      position: 'fixed', display: 'none', zIndex: '210',
      background: '#11112a', border: '1px solid #4466aa', borderRadius: '4px',
      color: '#ccc', fontFamily: "'Courier New', monospace",
      fontSize: '11px', padding: '10px 14px', maxWidth: '320px',
      pointerEvents: 'none', lineHeight: '1.5',
    });
    overlay.appendChild(tooltip);
    overlay.addEventListener('mousemove', (e: MouseEvent) => {
      const tx = Math.min(e.clientX + 14, window.innerWidth - 340);
      const ty = Math.min(e.clientY + 14, window.innerHeight - 140);
      tooltip.style.left = tx + 'px';
      tooltip.style.top = ty + 'px';
    });
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const attrs = driver.attributes ?? { st: 10, dx: 10, iq: 10, ht: 10 };
    const skills = driver.skills ?? {};
    const xpPool = driver.xp_pool ?? 0;
    const host = window.location.hostname;

    const esc = (s: string): string =>
      s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

    const skillTip = (id: string, show: boolean): void => {
      if (!show) { tooltip.style.display = 'none'; return; }
      const info = SKILL_INFO[id];
      const lvl = skills[id] ?? 0;
      const bText = id.startsWith('driving_') ? `Active: +${Math.floor(lvl / 3)} HC`
        : id.startsWith('gunnery_') ? `Active: +${Math.floor(lvl / 2)} accuracy, -${Math.floor(lvl / 3)} link penalty`
        : id === 'mechanic' ? `Active: -${lvl * 2}% repair cost`
        : id === 'fire_aid' ? `Active: -${Math.floor(lvl / 3)} fire dmg`
        : id === 'leadership' ? (lvl >= 10 ? 'Active: +2 squad size' : lvl >= 5 ? 'Active: +1 squad size' : 'No bonus yet')
        : '';
      tooltip.innerHTML = '<b style="color:#88ccff;">' + esc(SKILL_LABELS[id] ?? id) + '</b>' +
        '<br><span style="color:#888;">Covers:</span> ' + esc(info.cover) +
        '<br><span style="color:#888;">Per level:</span> ' + esc(info.bonus) +
        (bText ? '<br><span style="color:#44ff88;">' + esc(bText) + '</span>' : '');
      tooltip.style.display = 'block';
    };
    const attachSkillHover = (): void => {
      const rows = panel.querySelectorAll('[data-skill-id]');
      for (let i = 0; i < rows.length; i++) {
        const el = rows[i] as HTMLElement;
        el.addEventListener('mouseenter', () => skillTip(el.dataset.skillId ?? '', true));
        el.addEventListener('mouseleave', () => skillTip('', false));
      }
    };

    const render = (): void => {
      panel.innerHTML = '';
      const allSkillIds = Object.keys(SKILL_LABELS);
      const topSkills = allSkillIds
        .map(id => [id, skills[id] ?? 0] as [string, number])
        .sort(([, a], [, b]) => b - a);

      const barHtml = (level: number, max = 10): string => {
        const filled = Math.min(level, max);
        return '<span style="color:#4488ff">' + '█'.repeat(filled) + '</span>' +
               '<span style="color:#333">' + '░'.repeat(max - filled) + '</span>';
      };

      const skillRows = topSkills.map(([id, level]) => {
        const cost = upgradeCost(level, id);
        const canAfford = xpPool >= cost;
        // SKILL_LABELS values and id are from controlled dictionaries — still escaped defensively
        const label = esc(SKILL_LABELS[id] ?? id);
        const safeId = esc(id);
        return `
          <div data-skill-id="${safeId}" style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px dotted #2a2a44;cursor:help;">
            <div style="width:110px;font-size:11px;color:#aac;">${label}</div>
            <div style="font-family:monospace;font-size:13px;letter-spacing:1px;">${barHtml(level)}</div>
            <div style="width:20px;color:#88ccff;font-size:13px;text-align:right;">${level}</div>
            <button data-skill="${safeId}" data-level="${level}" data-cost="${cost}"
              style="margin-left:auto;padding:2px 10px;font-family:inherit;font-size:11px;
                     background:${canAfford ? '#1a2a44' : '#111'};
                     color:${canAfford ? '#88ccff' : '#444'};
                     border:1px solid ${canAfford ? '#4466aa' : '#333'};
                     cursor:${canAfford ? 'pointer' : 'not-allowed'};">
              +1 (${cost} XP)
            </button>
          </div>`;
      }).join('');

      const noSkills = topSkills.every(([, v]) => v === 0)
        ? '<div style="color:#555;font-size:11px;padding:8px 0;">No skills yet \u2014 earn XP by fighting!</div>'
        : skillRows;

      panel.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <h2 style="margin:0;color:#88ccff;letter-spacing:2px;">${esc(driver.name)}</h2>
          <div style="font-size:11px;color:#888;">${esc(driver.title ?? '')}</div>
        </div>
        <div style="margin-bottom:4px;font-size:10px;color:#666;">PC STATS</div>
        <div style="display:flex;gap:20px;padding:8px 0;margin-bottom:4px;border-bottom:1px solid #2a2a44;">
          ${(["st","dx","iq","ht"] as const).map((k, i) => {
            const colors = ["#ff8844","#44ff88","#ffcc44","#ff6688"];
            const labels = ["ST","DX","IQ","HT"];
            const val = attrs[k];
            const cost = Math.pow(val + 1, 2) * 10;
            const can = xpPool >= cost && val < 20;
            return `<div style="text-align:center;">
              <button data-attr="${k}" data-cost="${cost}"
                style="background:transparent;border:1px solid ${can ? colors[i] + '55' : 'transparent'};
                       cursor:${can ? 'pointer' : 'default'};color:${colors[i]};font-size:18px;font-weight:bold;
                       font-family:inherit;padding:2px 8px;display:block;width:100%;
                       ${!can ? 'opacity:0.6;' : ''}"
                title="${can ? `Upgrade to ${val+1} (${cost} XP)` : val >= 20 ? 'Max level' : `Need ${cost} XP`}"
                ${can ? '' : 'disabled'}>${val}
              </button>
              <div style="color:#666;font-size:10px;">${labels[i]}</div>
            </div>`;
          }).join('')}
          <div style="margin-left:auto;text-align:right;">
            <div style="color:#ffcc00;font-size:16px;font-weight:bold;">${xpPool} XP</div>
            <div style="color:#666;font-size:10px;">pool</div>
          </div>
        </div>
        <div style="margin-bottom:8px;font-size:11px;color:#aac;">SKILLS</div>
        ${noSkills}
        <div style="margin-top:16px;text-align:right;">
          <button data-action="close" style="padding:6px 18px;font-family:inherit;font-size:12px;background:transparent;color:#888;border:1px solid #444;cursor:pointer;">[ CLOSE ]</button>
        </div>`;
      attachSkillHover();
    };

    panel.addEventListener('click', async (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!btn) return;
      if (btn.dataset.action === 'close') { overlay.remove(); return; }

      const attrKey = btn.dataset.attr;
      if (attrKey) {
        const cost = Number(btn.dataset.cost);
        if ((driver.xp_pool ?? 0) < cost) return;
        const r = await fetch(`http://${host}:3001/api/drivers/${driver.id}/upgrade-attr`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
          body: JSON.stringify({ attrKey }),
        });
        if (r.ok) {
          const updated = await r.json();
          driver.xp_pool = updated.xpPool;
          driver.attributes = updated.attributes;
          render();
        } else {
          const err = await r.json().catch(() => ({}));
          alert(err.error ?? 'Attribute upgrade failed');
        }
        return;
      }

      const skillId = btn.dataset.skill;
      if (!skillId) return;
      const cost = Number(btn.dataset.cost);
      if ((driver.xp_pool ?? 0) < cost) return;
      const r = await fetch(`http://${host}:3001/api/drivers/${driver.id}/spend-xp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ skillId }),
      });
      if (r.ok) {
        const updated = await r.json();
        driver.xp_pool = updated.xpPool;
        driver.skills = updated.skills;
        render();
      } else {
        const err = await r.json().catch(() => ({}));
        alert(err.error ?? 'Upgrade failed');
      }
    });

    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    render();
  }

  private showSquadModal(primaryId: string): void {
    const driverByVehicleId = new Map<string, Driver>();
    for (const d of this.drivers) {
      if (d.alive && d.assigned_vehicle_id) driverByVehicleId.set(d.assigned_vehicle_id, d);
    }
    const eligible = this.vehicles.filter(v =>
      !v.damage_state?.destroyed && !v.in_arena && driverByVehicleId.has(v.id) &&
      (v.status ?? 'available') === 'available'
    );
    if (!eligible.find(v => v.id === primaryId)) {
      const lastMap = localStorage.getItem('cw_selected_map') ?? 'truck-stop';
      this.launchArena([primaryId], lastMap);
      return;
    }

    const selected = new Set<string>([primaryId]);
    const MAX_SQUAD = 4;
    const { width, height } = this.scale;
    const cx = width / 2, cy = height / 2;

    const overlay = this.add.rectangle(cx, cy, width, height, 0x000000, 0.75).setDepth(30).setInteractive();
    const panel   = this.add.rectangle(cx, cy, 640, 460, 0x111122, 0.98).setDepth(31).setStrokeStyle(2, 0x4466aa);
    const title   = this.add.text(cx, cy - 200, 'BUILD SQUAD', {
      color: '#ffcc00', fontSize: '22px', fontFamily: 'monospace', fontStyle: 'bold'
    }).setOrigin(0.5).setDepth(32);
    const hint    = this.add.text(cx, cy - 168, `Select up to ${MAX_SQUAD} — primary auto-highlighted`, {
      color: '#888', fontSize: '12px', fontFamily: 'monospace'
    }).setOrigin(0.5).setDepth(32);

    const created: Phaser.GameObjects.GameObject[] = [overlay, panel, title, hint];

    eligible.slice(0, 8).forEach((v, i) => {
      const y = cy - 130 + i * 36;
      const driver = driverByVehicleId.get(v.id)!;
      const isPrimary = v.id === primaryId;

      const rowBg = this.add.rectangle(cx, y, 580, 30, 0x222233, 1).setDepth(32).setInteractive();
      const marker = this.add.text(cx - 270, y, '[X]', {
        color: '#00ff88', fontSize: '14px', fontFamily: 'monospace'
      }).setOrigin(0, 0.5).setDepth(33);
      const label = this.add.text(cx - 230, y, `${v.name}${isPrimary ? '  (PRIMARY)' : ''}`, {
        color: isPrimary ? '#00ff88' : '#cccccc', fontSize: '13px', fontFamily: 'monospace'
      }).setOrigin(0, 0.5).setDepth(33);
      const driverLabel = this.add.text(cx + 180, y, `Driver: ${driver.name} (skill ${driver.skill})`, {
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
        if (isPrimary) return;
        if (selected.has(v.id)) selected.delete(v.id);
        else if (selected.size < MAX_SQUAD) selected.add(v.id);
        refreshVisual();
      });
      created.push(rowBg, marker, label, driverLabel);
    });

    const currentMap = localStorage.getItem('cw_selected_map') ?? 'truck-stop';
    const mapNote = this.add.text(cx, cy + 150, `Arena: ${currentMap}   (change on garage screen)`, {
      color: '#888', fontSize: '11px', fontFamily: 'monospace'
    }).setOrigin(0.5).setDepth(33);
    created.push(mapNote);

    const fightBtn = this.add.text(cx - 100, cy + 195, '[FIGHT WITH SQUAD]', {
      color: '#00ff88', fontSize: '14px', fontFamily: 'monospace',
      backgroundColor: '#003322', padding: { x: 8, y: 4 }
    }).setOrigin(0.5).setDepth(33).setInteractive();
    const cancelBtn = this.add.text(cx + 120, cy + 195, '[CANCEL]', {
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
      gangPrimaryColour: this.gang?.primary_colour,
    });
  }

  private renderEmblemTexture(key: string, emblem: EmblemId, primary: number, secondary: number, size: number): void {
    if (this.textures.exists(key)) this.textures.remove(key);
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    paintEmblem(canvas, emblem, primary, secondary);
    this.textures.addCanvas(key, canvas);
  }

  private showGangSettings(): void {
    if (!this.gang) return;
    const COLOURS = [
      { value: 0x00cd68, name: 'Green'  },
      { value: 0xff4400, name: 'Red'    },
      { value: 0x4488ff, name: 'Blue'   },
      { value: 0xffaa00, name: 'Amber'  },
      { value: 0xaa66ff, name: 'Violet' },
      { value: 0xffffff, name: 'White'  },
      { value: 0x333333, name: 'Black'  },
    ];

    const { width, height } = this.scale;
    const cx = width / 2, cy = height / 2;

    const created: Phaser.GameObjects.GameObject[] = [];
    const overlay = this.add.rectangle(cx, cy, width, height, 0x000000, 0.75).setDepth(30).setInteractive();
    const panel   = this.add.rectangle(cx, cy, 640, 540, 0x111122, 0.98).setDepth(31).setStrokeStyle(2, 0x4466aa);
    const title   = this.add.text(cx, cy - 240, 'GANG SETTINGS', {
      color: '#ffcc00', fontSize: '20px', fontFamily: 'monospace', fontStyle: 'bold'
    }).setOrigin(0.5).setDepth(32);
    created.push(overlay, panel, title);

    let chosenPrimary = this.gang.primary_colour;
    let chosenSecondary = this.gang.secondary_colour;
    let chosenEmblem: EmblemId = this.gang.emblem_id ?? 'stripes';

    const previewKey = 'gang-emblem-preview';
    this.renderEmblemTexture(previewKey, chosenEmblem, chosenPrimary, chosenSecondary, 96);
    const preview = this.add.image(cx, cy - 185, previewKey).setOrigin(0.5).setDepth(32).setDisplaySize(72, 72);
    created.push(preview);
    const emblemTiles: Phaser.GameObjects.Image[] = [];
    const emblemBorders: Phaser.GameObjects.Rectangle[] = [];
    const refreshAllEmblems = () => {
      this.renderEmblemTexture(previewKey, chosenEmblem, chosenPrimary, chosenSecondary, 96);
      preview.setTexture(previewKey);
      EMBLEM_IDS.forEach((id, i) => {
        const tileKey = `gang-emblem-picker-${id}`;
        this.renderEmblemTexture(tileKey, id, chosenPrimary, chosenSecondary, 40);
        emblemTiles[i]?.setTexture(tileKey);
        emblemBorders[i]?.setStrokeStyle(id === chosenEmblem ? 3 : 1, id === chosenEmblem ? 0x00ff88 : 0x666666);
      });
    };

    const nameLabel = this.add.text(cx - 260, cy - 110, 'Name:', { color: '#ccc', fontSize: '13px', fontFamily: 'monospace' }).setDepth(32);
    const nameInput = document.createElement('input');
    const canvasRect = this.game.canvas.getBoundingClientRect();
    Object.assign(nameInput.style, {
      position: 'absolute',
      left: `${canvasRect.left + cx - 190}px`,
      top: `${canvasRect.top + cy - 120}px`,
      width: '400px', height: '28px', background: '#222',
      color: '#fff', border: '1px solid #4466aa', padding: '2px 6px',
      fontFamily: 'monospace', fontSize: '14px',
    });
    nameInput.value = this.gang.name;
    nameInput.maxLength = 64;
    document.body.appendChild(nameInput);
    created.push(nameLabel);

    const makeColourRow = (label: string, y: number, getCurrent: () => number, onPick: (v: number) => void) => {
      const lab = this.add.text(cx - 260, y, label, { color: '#ccc', fontSize: '13px', fontFamily: 'monospace' }).setDepth(32);
      created.push(lab);
      const swatches: Phaser.GameObjects.Rectangle[] = [];
      COLOURS.forEach((c, i) => {
        const sw = this.add.rectangle(cx - 190 + i * 42, y + 8, 32, 18, c.value).setDepth(32).setStrokeStyle(
          c.value === getCurrent() ? 3 : 1, 0xffffff
        ).setInteractive();
        sw.on('pointerdown', () => {
          onPick(c.value);
          swatches.forEach((s, j) => s.setStrokeStyle(COLOURS[j].value === getCurrent() ? 3 : 1, 0xffffff));
          refreshAllEmblems();
        });
        swatches.push(sw);
        created.push(sw);
      });
    };
    makeColourRow('Primary:',   cy - 60, () => chosenPrimary,   v => { chosenPrimary = v; });
    makeColourRow('Secondary:', cy - 20, () => chosenSecondary, v => { chosenSecondary = v; });

    const emblemLabel = this.add.text(cx - 260, cy + 35, 'Emblem:', { color: '#ccc', fontSize: '13px', fontFamily: 'monospace' }).setDepth(32);
    created.push(emblemLabel);
    EMBLEM_IDS.forEach((id, i) => {
      const tileKey = `gang-emblem-picker-${id}`;
      this.renderEmblemTexture(tileKey, id, chosenPrimary, chosenSecondary, 40);
      const tile = this.add.image(cx - 178 + i * 46, cy + 60, tileKey).setOrigin(0.5).setDepth(32).setDisplaySize(36, 36).setInteractive();
      const border = this.add.rectangle(tile.x, tile.y, 42, 42, 0, 0).setStrokeStyle(
        id === chosenEmblem ? 3 : 1, id === chosenEmblem ? 0x00ff88 : 0x666666
      ).setDepth(31);
      tile.on('pointerdown', () => {
        chosenEmblem = id;
        refreshAllEmblems();
      });
      emblemTiles.push(tile);
      emblemBorders.push(border);
      created.push(tile, border);
    });

    const saveBtn = this.add.text(cx - 100, cy + 220, '[SAVE]', {
      color: '#00ff88', fontSize: '14px', fontFamily: 'monospace',
      backgroundColor: '#003322', padding: { x: 8, y: 4 }
    }).setOrigin(0.5).setDepth(32).setInteractive();
    const cancelBtn = this.add.text(cx + 100, cy + 220, '[CANCEL]', {
      color: '#888', fontSize: '14px', fontFamily: 'monospace',
      backgroundColor: '#221122', padding: { x: 8, y: 4 }
    }).setOrigin(0.5).setDepth(32).setInteractive();

    const destroy = () => { nameInput.remove(); [...created, saveBtn, cancelBtn].forEach(o => o.destroy()); };
    cancelBtn.on('pointerdown', destroy);
    saveBtn.on('pointerdown', async () => {
      const host = window.location.hostname;
      await fetch(`http://${host}:3001/api/gangs/mine`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({
          name: nameInput.value,
          primary_colour: chosenPrimary,
          secondary_colour: chosenSecondary,
          emblem_id: chosenEmblem,
        }),
      });
      destroy();
      this.scene.restart({ token: this.token });
    });
    created.push(saveBtn, cancelBtn);
  }

  private async hireDriver(): Promise<void> {
    // Opens a DOM-overlay modal listing generated candidates. Pool auto-
    // generates on first fetch. Clicking [HIRE] on a candidate closes the
    // modal and restarts the garage to reflect the new driver (and vehicle
    // if package deal).
    await this.showHireModal();
  }

  private async showRequestsModal(): Promise<void> {
    const host = window.location.hostname;
    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', zIndex: '200',
      background: 'rgba(0,0,0,0.82)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: "'Courier New', monospace",
    });
    const panel = document.createElement('div');
    Object.assign(panel.style, {
      background: '#0f0f22', border: '2px solid #ffcc00', color: '#ccc',
      padding: '20px', width: 'min(760px, 92vw)', maxHeight: '88vh',
      overflow: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.6)',
    });
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const esc = (s: string): string =>
      s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

    const render = (requests: DriverRequest[]): void => {
      const kindIcon: Record<string, string> = {
        repair: '🔧', ammo: '📦', accessory_add: '💻', armor_up: '🛡️',
        compound_swap: '🔄',
      };
      const rows = requests.length === 0
        ? '<div style="color:#666;padding:12px;text-align:center;font-size:12px;">No pending requests.</div>'
        : requests.map(r => {
          const affordable = this.gang && this.gang.treasury >= r.cost;
          return `
            <div style="background:#11112a;border:1px solid #2a2a44;padding:12px;margin-bottom:10px;display:grid;grid-template-columns:40px 1fr auto;gap:12px;align-items:center;">
              <div style="font-size:22px;">${kindIcon[r.kind] ?? '❓'}</div>
              <div>
                <div style="color:#ccc;font-size:12px;line-height:1.4;">${esc(r.description)}</div>
                <div style="color:#888;font-size:10px;margin-top:2px;">${esc(r.driver_name)} (sk${r.driver_skill})${r.vehicle_name ? ` · ${esc(r.vehicle_name)}` : ''}</div>
              </div>
              <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;">
                <span style="color:#ffcc00;font-size:13px;font-weight:bold;">$${r.cost.toLocaleString()}</span>
                <div style="display:flex;gap:4px;">
                  <button data-action="approve" data-id="${r.id}"
                          style="padding:4px 10px;font-family:inherit;font-size:10px;background:${affordable ? '#003322' : '#221122'};color:${affordable ? '#00ff88' : '#888'};border:1px solid ${affordable ? '#00ff88' : '#444'};cursor:${affordable ? 'pointer' : 'not-allowed'};"
                          ${affordable ? '' : 'disabled'}>APPROVE</button>
                  <button data-action="deny" data-id="${r.id}"
                          style="padding:4px 10px;font-family:inherit;font-size:10px;background:#221122;color:#ff6666;border:1px solid #663333;cursor:pointer;">DENY</button>
                </div>
              </div>
            </div>`;
        }).join('');

      panel.textContent = '';
      const range = document.createRange();
      range.selectNodeContents(panel);
      const html = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <h2 style="margin:0;color:#ffcc00;letter-spacing:2px;">DRIVER REQUESTS</h2>
          <div style="font-size:11px;color:#888;">Treasury <b style="color:#ffcc00;">$${this.gang?.treasury.toLocaleString() ?? 0}</b></div>
        </div>
        <div style="font-size:11px;color:#888;margin-bottom:10px;">Denying a request costs driver loyalty. Approving boosts it.</div>
        ${rows}
        <div style="margin-top:14px;padding-top:10px;border-top:1px solid #2a2a44;display:flex;justify-content:flex-end;">
          <button data-action="close" style="padding:8px 18px;font-family:inherit;font-size:12px;background:transparent;color:#888;border:1px solid #444;cursor:pointer;">[ CLOSE ]</button>
        </div>`;
      panel.appendChild(range.createContextualFragment(html));
    };

    const loadPending = async (): Promise<void> => {
      panel.textContent = 'Loading requests\u2026';
      const r = await fetch(`http://${host}:3001/api/drivers/requests`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      this.driverRequests = r.ok ? await r.json() : [];
      render(this.driverRequests);
    };

    const close = (): void => { overlay.remove(); this.scene.restart({ token: this.token }); };

    panel.addEventListener('click', async (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'close') { close(); return; }
      const id = btn.dataset.id;
      if (!id) return;
      if (action === 'approve' || action === 'deny') {
        const r = await fetch(`http://${host}:3001/api/drivers/requests/${id}/${action}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.token}` },
        });
        if (r.ok) {
          await loadPending();
          // Refresh gang treasury from the response
          if (action === 'approve') {
            const gr = await fetch(`http://${host}:3001/api/gangs/mine`, {
              headers: { Authorization: `Bearer ${this.token}` },
            });
            if (gr.ok) this.gang = await gr.json();
          }
        } else {
          const body = await r.json().catch(() => ({}));
          alert(body.error ?? 'Action failed');
        }
      }
    });

    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    await loadPending();
  }

  private async showHireModal(): Promise<void> {
    const host = window.location.hostname;
    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', zIndex: '200',
      background: 'rgba(0,0,0,0.82)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: "'Courier New', monospace",
    });
    const panel = document.createElement('div');
    Object.assign(panel.style, {
      background: '#0f0f22', border: '2px solid #4466aa', color: '#ccc',
      padding: '20px', width: 'min(900px, 92vw)', maxHeight: '88vh',
      overflow: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.6)',
    });
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const escHtml = (s: string): string =>
      s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

    // Tier tabs — candidates are grouped Rookie / Standard / Premium server-side
    // (Phase 2 Task 1). Premium is empty until the player has 5 arena wins.
    const TIERS = [
      { key: 'rookie',   label: 'ROOKIE',   hint: 'skill 1-2 · cheap recruits' },
      { key: 'standard', label: 'STANDARD', hint: 'skill 1-6 · the regular pool' },
      { key: 'premium',  label: 'PREMIUM',  hint: 'skill 4-6 · elite (5 arena wins to unlock)' },
    ];
    let activeTier = 'rookie';

    const render = (candidates: any[]): void => {
      const inTier = candidates.filter(c => (c.tier ?? 'standard') === activeTier);
      const tabs = TIERS.map(t => {
        const count = candidates.filter(c => (c.tier ?? 'standard') === t.key).length;
        const on = t.key === activeTier;
        return `<button data-tier="${t.key}" title="${t.hint}"
          style="padding:8px 16px;font-family:inherit;font-size:12px;cursor:pointer;
                 background:${on ? '#1a1a3a' : 'transparent'};color:${on ? '#00ff88' : '#889'};
                 border:1px solid ${on ? '#00ff88' : '#2a2a44'};border-bottom:none;">${t.label} (${count})</button>`;
      }).join('');
      const activeMeta = TIERS.find(t => t.key === activeTier)!;
      const cards = inTier.map(c => {
        const hasPkg = !!c.vehicle_stock_id;
        const pkgCost = hasPkg
          ? Math.round(c.vehicle_cost * (1 - c.vehicle_discount_pct / 100))
          : 0;
        const total = c.hire_cost + pkgCost;
        const stars = '★'.repeat(c.skill) + '☆'.repeat(Math.max(0, 6 - c.skill));
        const affordable = this.gang && this.gang.treasury >= total;
        return `
          <div style="background:#11112a;border:1px solid #2a2a44;padding:14px;display:grid;grid-template-rows:auto auto 1fr auto;gap:8px;min-height:220px;">
            <div style="display:flex;justify-content:space-between;align-items:baseline;">
              <div style="color:#00ff88;font-size:14px;font-weight:bold;">${escHtml(c.name)}</div>
              <div style="color:#ffcc00;font-size:10px;letter-spacing:2px;">SKILL ${c.skill}</div>
            </div>
            <div style="color:#888;font-size:11px;">${stars} · aggro ${c.aggression} · loyalty ${c.loyalty}</div>
            <div style="color:#aac;font-size:11px;line-height:1.4;">${escHtml(c.blurb)}</div>
            ${hasPkg ? `
              <div style="background:#1a2a11;border-left:3px solid #88ccff;padding:8px;font-size:11px;color:#aaccff;">
                🚗 Package deal: brings <b>${escHtml(c.vehicle_name)}</b> (Div ${c.vehicle_division})<br>
                <span style="color:#ffcc00;">-${c.vehicle_discount_pct}% off</span> $${pkgCost.toLocaleString()}
              </div>
            ` : ''}
            <div style="display:flex;justify-content:space-between;align-items:center;padding-top:8px;border-top:1px dotted #2a2a44;">
              <span style="color:#ffcc00;font-size:14px;font-weight:bold;">$${total.toLocaleString()}</span>
              <button data-candidate-id="${c.id}"
                      style="padding:6px 16px;font-family:inherit;font-size:12px;background:${affordable ? '#003322' : '#221122'};color:${affordable ? '#00ff88' : '#888'};border:1px solid ${affordable ? '#00ff88' : '#444'};cursor:${affordable ? 'pointer' : 'not-allowed'};"
                      ${affordable ? '' : 'disabled'}>
                ${affordable ? '[HIRE]' : '[NO FUNDS]'}
              </button>
            </div>
          </div>`;
      }).join('');

      panel.textContent = '';
      const range = document.createRange();
      range.selectNodeContents(panel);
      const html = `
        <style>
          .hire-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap:12px; }
        </style>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <h2 style="margin:0;color:#ff4444;letter-spacing:2px;">HIRE DRIVERS</h2>
          <div style="font-size:11px;color:#888;">Treasury <b style="color:#ffcc00;">$${this.gang?.treasury.toLocaleString() ?? 0}</b></div>
        </div>
        <div style="display:flex;gap:4px;border-bottom:1px solid #2a2a44;margin-bottom:14px;">${tabs}</div>
        ${inTier.length
          ? `<div class="hire-grid">${cards}</div>`
          : `<div style="padding:40px;text-align:center;color:#778;font-size:12px;line-height:1.6;">No ${activeMeta.label.toLowerCase()} recruits available right now.<br><span style="color:#556;">${escHtml(activeMeta.hint)}</span></div>`}
        <div style="margin-top:16px;display:flex;justify-content:space-between;align-items:center;padding-top:12px;border-top:1px solid #2a2a44;">
          <button data-action="close" style="padding:8px 18px;font-family:inherit;font-size:12px;background:transparent;color:#888;border:1px solid #444;cursor:pointer;">[ CLOSE ]</button>
          <button data-action="refresh" style="padding:8px 18px;font-family:inherit;font-size:12px;background:#332200;color:#ffaa00;border:1px solid #664400;cursor:pointer;">[ REFRESH POOL ($100) ]</button>
        </div>`;
      panel.appendChild(range.createContextualFragment(html));
    };

    let poolCandidates: any[] = [];
    const loadPool = async (): Promise<void> => {
      panel.textContent = 'Loading candidates\u2026';
      const r = await fetch(`http://${host}:3001/api/drivers/candidates`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      poolCandidates = r.ok ? await r.json() : [];
      // Default to the first tab that actually has candidates.
      const firstWith = TIERS.find(t => poolCandidates.some(c => (c.tier ?? 'standard') === t.key));
      activeTier = firstWith?.key ?? 'rookie';
      render(poolCandidates);
    };

    const close = (): void => { overlay.remove(); };

    panel.addEventListener('click', async (e) => {
      const t = e.target as HTMLElement;
      const btn = t.closest<HTMLElement>('[data-action],[data-candidate-id],[data-tier]');
      if (!btn) return;
      if (btn.dataset.tier) { activeTier = btn.dataset.tier; render(poolCandidates); return; }
      if (btn.dataset.action === 'close') { close(); return; }
      if (btn.dataset.action === 'refresh') {
        const r = await fetch(`http://${host}:3001/api/drivers/candidates/refresh`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.token}` },
        });
        if (r.ok) await loadPool();
        else alert((await r.json().catch(() => ({}))).error ?? 'Refresh failed');
        return;
      }
      const id = btn.dataset.candidateId;
      if (id) {
        const r = await fetch(`http://${host}:3001/api/drivers/candidates/${id}/hire`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.token}` },
        });
        if (r.ok) {
          close();
          this.scene.restart({ token: this.token });
        } else {
          const body = await r.json().catch(() => ({}));
          alert(body.error ?? 'Hire failed');
        }
      }
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    await loadPool();
  }

  private showAssignDriverMenu(driver: Driver): void {
    const { width, height } = this.scale;
    const cx = width / 2, cy = height / 2;

    const created: Phaser.GameObjects.GameObject[] = [];
    const overlay = this.add.rectangle(cx, cy, width, height, 0x000000, 0.8).setDepth(30).setInteractive();
    const panel   = this.add.rectangle(cx, cy, 500, 400, 0x111122, 0.98).setDepth(31).setStrokeStyle(2, 0x4466aa);
    const title   = this.add.text(cx, cy - 180, `ASSIGN ${driver.name.toUpperCase()}`, {
      color: '#ffcc00', fontSize: '16px', fontFamily: 'monospace', fontStyle: 'bold'
    }).setOrigin(0.5).setDepth(32);
    created.push(overlay, panel, title);

    const destroy = () => created.forEach(o => o.destroy());

    const alive = this.vehicles.filter(v => !v.damage_state?.destroyed);
    if (alive.length === 0) {
      const none = this.add.text(cx, cy - 100, 'No vehicles to assign — build one first.', {
        color: '#888', fontSize: '12px', fontFamily: 'monospace'
      }).setOrigin(0.5).setDepth(32);
      created.push(none);
    } else {
      alive.forEach((v, i) => {
        const y = cy - 130 + i * 32;
        const currentDriver = this.drivers.find(d => d.assigned_vehicle_id === v.id);
        const conflict = currentDriver && currentDriver.id !== driver.id;
        const label = `${v.name}${conflict ? `  (replaces ${currentDriver.name})` : currentDriver?.id === driver.id ? '  (current)' : ''}`;
        const row = this.add.text(cx, y, label, {
          color: conflict ? '#ffaa44' : '#cccccc', fontSize: '13px', fontFamily: 'monospace',
          backgroundColor: '#222233', padding: { x: 8, y: 4 },
        }).setOrigin(0.5).setDepth(32).setInteractive();
        row.on('pointerdown', async () => {
          const host = window.location.hostname;
          await fetch(`http://${host}:3001/api/drivers/assign`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
            body: JSON.stringify({ driverId: driver.id, vehicleId: v.id }),
          });
          destroy();
          this.scene.restart({ token: this.token });
        });
        created.push(row);
      });
    }

    const cancel = this.add.text(cx, cy + 140, '[CANCEL]', {
      color: '#888', fontSize: '13px', fontFamily: 'monospace',
      backgroundColor: '#221122', padding: { x: 8, y: 4 },
    }).setOrigin(0.5).setDepth(32).setInteractive();
    cancel.on('pointerdown', destroy);
    created.push(cancel);
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
      this.add.text(this.scale.width / 2, this.scale.height - 40, body.error ?? 'Sell failed', {
        color: '#ff4444', fontSize: '14px', fontFamily: 'monospace'
      }).setOrigin(0.5);
    }
  }
}
