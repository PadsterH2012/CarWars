import Phaser from 'phaser';
import { type EmblemId } from '../game/CoatOfArms';
import { bindFullscreenToggle } from '../ui/responsive';
import { preloadVehicleSprites, bodySpriteKey } from '../game/VehicleSprite';
import { esc, renderInto, buildSidebarHTML, createHubRoot, wireNavigation, redirectIfUnauthorized, showToast, SidebarOpts } from '../ui/hub';

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
  private pendingFightVehicleId = '';
  private pendingRepairVehicleId = '';
  private pendingSellVehicleId = '';
  private pendingDriverCardId = '';
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
    // Stale or invalid token → back to the login screen instead of crashing on
    // the error-shaped JSON bodies below.
    if (redirectIfUnauthorized(this, [meRes, vRes, dRes, gRes, reqRes, bayRes, repRes, depRes, actRes, lbRes])) return;
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

    this.appendModalsHTML();

    wireNavigation(this.root, this, this.token);
    this.root.addEventListener('click', this.onClick.bind(this));

    // Close modals on Escape
    this.input.keyboard?.on('keydown-ESC', () => {
      this.root.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
    });

    bindFullscreenToggle(this);
  }

  // ── Modal infrastructure ──────────────────────────────────────────────

  private appendModalsHTML(): void {
    const modalContainer = document.createElement('div');
    renderInto(modalContainer, this.buildModalsHTML());
    this.root.appendChild(modalContainer);
  }

  private buildModalsHTML(): string {
    const COLOURS = [
      { value: 0xff4444, hex: '#ff4444' },
      { value: 0xff8800, hex: '#ff8800' },
      { value: 0xffcc00, hex: '#ffcc00' },
      { value: 0x00ff88, hex: '#00ff88' },
      { value: 0x00ccff, hex: '#00ccff' },
      { value: 0x8844ff, hex: '#8844ff' },
      { value: 0xff44aa, hex: '#ff44aa' },
      { value: 0xaaaaaa, hex: '#aaaaaa' },
    ];
    const swatches = COLOURS.map(c =>
      `<div class="gang-color-swatch" data-color="${esc(c.hex)}"
            style="background:${esc(c.hex)}" data-action="gang-color"></div>`
    ).join('');

    return `
      <!-- Fight / Squad Picker -->
      <div class="modal-overlay" id="modal-fight">
        <div class="modal">
          <div class="modal-title" id="modal-fight-title">⚔ Select Squad</div>
          <div class="modal-body" id="modal-fight-body"></div>
          <div class="modal-footer">
            <button class="btn btn-ghost" data-action="close-modal" data-modal="modal-fight">Cancel</button>
            <button class="btn btn-red" data-action="confirm-fight">⚔ Enter Arena</button>
          </div>
        </div>
      </div>

      <!-- Repair -->
      <div class="modal-overlay" id="modal-repair">
        <div class="modal">
          <div class="modal-title">🔧 Repair Vehicle</div>
          <div class="modal-body" id="modal-repair-body"></div>
          <div class="modal-footer">
            <button class="btn btn-ghost" data-action="close-modal" data-modal="modal-repair">Cancel</button>
            <button class="btn btn-yellow" data-action="confirm-repair">🔧 Confirm Repair</button>
          </div>
        </div>
      </div>

      <!-- Sell -->
      <div class="modal-overlay" id="modal-sell">
        <div class="modal">
          <div class="modal-title">💰 Sell Vehicle</div>
          <div class="modal-body" id="modal-sell-body"></div>
          <div class="modal-footer">
            <button class="btn btn-ghost" data-action="close-modal" data-modal="modal-sell">Cancel</button>
            <button class="btn btn-red" data-action="confirm-sell">💰 Confirm Sale</button>
          </div>
        </div>
      </div>

      <!-- Driver Card -->
      <div class="modal-overlay" id="modal-driver">
        <div class="modal" style="max-width:560px;">
          <div class="modal-title" id="modal-driver-title">Driver</div>
          <div class="modal-body" id="modal-driver-body"></div>
          <div class="modal-footer">
            <button class="btn btn-ghost" data-action="close-modal" data-modal="modal-driver">Close</button>
          </div>
        </div>
      </div>

      <!-- Assign Driver to Vehicle -->
      <div class="modal-overlay" id="modal-assign">
        <div class="modal">
          <div class="modal-title" id="modal-assign-title">Assign Driver</div>
          <div class="modal-body" id="modal-assign-body"></div>
          <div class="modal-footer">
            <button class="btn btn-ghost" data-action="close-modal" data-modal="modal-assign">Cancel</button>
          </div>
        </div>
      </div>

      <!-- Hire Drivers -->
      <div class="modal-overlay" id="modal-hire">
        <div class="modal" style="max-width:640px;">
          <div class="modal-title">Hire Drivers</div>
          <div class="modal-body" id="modal-hire-body"><p style="font-size:12px;color:var(--gray)">Loading candidates…</p></div>
          <div class="modal-footer" id="modal-hire-footer">
            <button class="btn btn-ghost" data-action="close-modal" data-modal="modal-hire">Close</button>
          </div>
        </div>
      </div>

      <!-- Gang Settings -->
      <div class="modal-overlay" id="modal-gang">
        <div class="modal">
          <div class="modal-title">⚙ Gang Settings</div>
          <div class="modal-body" id="modal-gang-body">
            <div style="margin-bottom:12px">
              <div style="font-size:11px;color:var(--gray);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px">Gang Name</div>
              <input type="text" id="gang-name-input" maxlength="64"
                style="width:100%;background:#1a1a1a;border:1px solid #333;color:#fff;font-family:var(--font);font-size:14px;padding:8px 10px;outline:none;">
            </div>
            <div>
              <div style="font-size:11px;color:var(--gray);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px">Gang Colour</div>
              <div class="gang-color-row">${swatches}</div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-ghost" data-action="close-modal" data-modal="modal-gang">Cancel</button>
            <button class="btn btn-green" data-action="confirm-gang-settings">Save</button>
          </div>
        </div>
      </div>`;
  }

  private openModal(id: string): void {
    this.root.querySelector(`#${id}`)?.classList.add('open');
  }

  private closeModal(id: string): void {
    this.root.querySelector(`#${id}`)?.classList.remove('open');
  }

  // ── Modal openers ─────────────────────────────────────────────────────

  private openFightModal(vehicleId: string): void {
    const v = this.vehicles.find(v => v.id === vehicleId);
    if (!v) return;
    this.pendingFightVehicleId = vehicleId;

    const titleEl = this.root.querySelector('#modal-fight-title') as HTMLElement | null;
    if (titleEl) titleEl.textContent = `⚔ Select Squad — ${v.name}`;

    const otherVehicles = this.vehicles.filter(vv => vv.id !== vehicleId);
    const bodyEl = this.root.querySelector('#modal-fight-body') as HTMLElement;

    const rows = otherVehicles.map(vv => {
      const driver = this.drivers.find(d => d.assigned_vehicle_id === vv.id && d.alive);
      const canInclude = !!driver && !vv.damage_state?.destroyed && (vv.status ?? 'available') === 'available';
      return `<div class="squad-check">
        <input type="checkbox" ${canInclude ? '' : 'disabled'} data-squad-vehicle="${esc(vv.id)}"
          style="accent-color:var(--green);width:15px;height:15px;margin-top:2px;cursor:pointer;">
        <div>
          <div class="squad-vname">${esc(vv.name)}</div>
          ${driver
            ? `<div class="squad-vdetail">${esc(driver.name)} · Skill ${esc(driver.skill)}</div>`
            : `<div class="squad-vwarn">⚠ No driver assigned — cannot deploy</div>`}
        </div>
      </div>`;
    }).join('');

    renderInto(bodyEl, `
      <p style="font-size:12px;color:var(--gray);margin-bottom:14px">Choose vehicles to bring into the arena. The selected vehicle leads; others support.</p>
      ${rows || '<p style="font-size:12px;color:var(--gray)">No other vehicles available.</p>'}
    `);
    this.openModal('modal-fight');
  }

  private async openRepairModal(vehicleId: string): Promise<void> {
    this.pendingRepairVehicleId = vehicleId;
    const v = this.vehicles.find(v => v.id === vehicleId);
    const bodyEl = this.root.querySelector('#modal-repair-body') as HTMLElement;
    renderInto(bodyEl, '<p style="font-size:12px;color:var(--gray)">Fetching repair quote…</p>');
    this.openModal('modal-repair');

    const host = window.location.hostname;
    const quoteRes = await fetch(`http://${host}:3001/api/economy/repair/quote?vehicleId=${vehicleId}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!quoteRes.ok) {
      const err = await quoteRes.json().catch(() => ({}));
      renderInto(bodyEl, `<p style="color:var(--red);font-size:12px">${esc(err.error ?? 'Could not fetch repair quote')}</p>`);
      return;
    }
    const quote = await quoteRes.json();
    const maxArmor = this.sumArmor(v?.loadout?.armor);
    const curArmor = this.sumArmor(v?.damage_state?.armor);

    renderInto(bodyEl, `
      <div class="repair-detail">
        <div class="repair-row"><span>${esc(v?.name ?? '')}</span></div>
        <div class="repair-row"><span>Current armor</span><span class="cost">${esc(curArmor)}/${esc(maxArmor)}</span></div>
        <div class="repair-row"><span>Repair to</span><span style="color:var(--green)">${esc(maxArmor)}/${esc(maxArmor)}</span></div>
        ${quote.armor.cost > 0 ? `<div class="repair-row"><span>Armour (${esc(quote.armor.pts)} pts)</span><span class="cost">$${quote.armor.cost.toLocaleString()}</span></div>` : ''}
        ${quote.tires.cost > 0 ? `<div class="repair-row"><span>Tires (${esc(quote.tires.count)}×)</span><span class="cost">$${quote.tires.cost.toLocaleString()}</span></div>` : ''}
        ${quote.engine.cost > 0 ? `<div class="repair-row"><span>Engine</span><span class="cost">$${quote.engine.cost.toLocaleString()}</span></div>` : ''}
        ${quote.ammo.cost > 0 ? `<div class="repair-row"><span>Ammo refill</span><span class="cost">$${quote.ammo.cost.toLocaleString()}</span></div>` : ''}
        <div class="repair-row"><span>Total</span><span class="cost">$${quote.total.toLocaleString()}</span></div>
      </div>
    `);

    const confirmBtn = this.root.querySelector<HTMLButtonElement>('#modal-repair .btn-yellow');
    if (confirmBtn) {
      const treasury = this.gang?.treasury ?? 0;
      confirmBtn.disabled = treasury < quote.total;
    }
  }

  private openSellModal(vehicleId: string): void {
    this.pendingSellVehicleId = vehicleId;
    const v = this.vehicles.find(v => v.id === vehicleId);
    if (!v) return;
    const salePrice = Math.floor(v.value / 2);
    const bodyEl = this.root.querySelector('#modal-sell-body') as HTMLElement;
    renderInto(bodyEl, `
      <div class="confirm-text">Sell <strong>${esc(v.name)}</strong> for <strong style="color:var(--yellow)">$${salePrice.toLocaleString()}</strong>?</div>
      <div class="confirm-sub">This cannot be undone. Any driver assigned will be unassigned.</div>
    `);
    this.openModal('modal-sell');
  }

  private openDriverCardModal(driverId: string): void {
    this.pendingDriverCardId = driverId;
    const driver = this.drivers.find(d => d.id === driverId);
    if (!driver) return;

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

    const upgradeCost = (level: number, skillId: string): number => {
      const diff = SKILL_DIFFICULTY[skillId] ?? 1;
      const attrKey = SKILL_ATTR[skillId] ?? 'dx';
      const attrVal = (driver.attributes as any)?.[attrKey] ?? 10;
      const discount = Math.min(1.5, Math.max(0.5, 1.5 - attrVal / 20));
      return Math.round(Math.pow(level + 1, 2) * 50 * diff * discount);
    };

    const titleEl = this.root.querySelector('#modal-driver-title') as HTMLElement | null;
    if (titleEl) titleEl.textContent = driver.name;

    const bodyEl = this.root.querySelector('#modal-driver-body') as HTMLElement;
    const attrs = driver.attributes ?? { st: 10, dx: 10, iq: 10, ht: 10 };
    const skills = driver.skills ?? {};
    const xpPool = driver.xp_pool ?? 0;
    const assignedVehicle = driver.assigned_vehicle_id
      ? this.vehicles.find(v => v.id === driver.assigned_vehicle_id)?.name ?? 'Assigned'
      : 'Available';

    const allSkillIds = Object.keys(SKILL_LABELS);
    const topSkills = allSkillIds
      .map(id => [id, skills[id] ?? 0] as [string, number])
      .sort(([, a], [, b]) => b - a);

    const barHtml = (level: number, max = 10): string => {
      const filled = Math.min(level, max);
      return '<span style="color:#4488ff">' + '█'.repeat(filled) + '</span>' +
             '<span style="color:#333">' + '░'.repeat(max - filled) + '</span>';
    };

    const attrColors = ['#ff8844', '#44ff88', '#ffcc44', '#ff6688'];
    const attrLabels = ['ST', 'DX', 'IQ', 'HT'];
    const attrHtml = (['st', 'dx', 'iq', 'ht'] as const).map((k, i) => {
      const val = attrs[k];
      const cost = Math.pow(val + 1, 2) * 10;
      const can = xpPool >= cost && val < 20;
      return `<div style="text-align:center;">
        <button data-attr="${esc(k)}" data-driver-id="${esc(driver.id)}" data-cost="${cost}"
          style="background:transparent;border:1px solid ${can ? attrColors[i] + '55' : 'transparent'};
                 cursor:${can ? 'pointer' : 'default'};color:${attrColors[i]};font-size:18px;font-weight:bold;
                 font-family:inherit;padding:2px 8px;display:block;width:100%;
                 ${!can ? 'opacity:0.6;' : ''}"
          title="${can ? `Upgrade to ${val + 1} (${cost} XP)` : val >= 20 ? 'Max level' : `Need ${cost} XP`}"
          ${can ? '' : 'disabled'}>${val}
        </button>
        <div style="color:#666;font-size:10px;">${attrLabels[i]}</div>
      </div>`;
    }).join('');

    const skillRowsHtml = topSkills.map(([id, level]) => {
      const cost = upgradeCost(level, id);
      const canAfford = xpPool >= cost;
      const label = esc(SKILL_LABELS[id] ?? id);
      const safeId = esc(id);
      return `<div data-skill-id="${safeId}" style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px dotted #2a2a44;">
        <div style="width:110px;font-size:11px;color:#aac;">${label}</div>
        <div style="font-family:monospace;font-size:13px;letter-spacing:1px;">${barHtml(level)}</div>
        <div style="width:20px;color:#88ccff;font-size:13px;text-align:right;">${level}</div>
        <button data-skill="${safeId}" data-driver-id="${esc(driver.id)}" data-level="${level}" data-cost="${cost}"
          style="margin-left:auto;padding:2px 10px;font-family:inherit;font-size:11px;
                 background:${canAfford ? '#1a2a44' : '#111'};
                 color:${canAfford ? '#88ccff' : '#444'};
                 border:1px solid ${canAfford ? '#4466aa' : '#333'};
                 cursor:${canAfford ? 'pointer' : 'not-allowed'};"
          ${canAfford ? '' : 'disabled'}>
          +1 (${cost} XP)
        </button>
      </div>`;
    }).join('');

    const noSkillsMsg = topSkills.every(([, v]) => v === 0)
      ? '<div style="color:#555;font-size:11px;padding:8px 0;">No skills yet — earn XP by fighting!</div>'
      : skillRowsHtml;

    // Assignment section — one button per vehicle. Wrecked vehicles are shown
    // but disabled so the player can see why they can't be assigned.
    const assignRows = this.vehicles.map(v => {
      const isWrecked = !!v.damage_state?.destroyed;
      const isCurrent = driver.assigned_vehicle_id === v.id;
      const occupant = this.drivers.find(d => d.id !== driver.id && d.assigned_vehicle_id === v.id && d.alive);
      const note = isWrecked ? ' (wrecked)' : isCurrent ? ' ✓' : occupant ? ` (replaces ${esc(occupant.name)})` : '';
      const disabled = isCurrent || isWrecked;
      return `<button class="btn${isCurrent ? ' btn-green' : ''}" data-action="assign-driver"
                data-driver-id="${esc(driver.id)}" data-vehicle-id="${esc(v.id)}"
                ${disabled ? 'disabled' : ''} style="font-size:11px;margin:2px 4px 2px 0;">${esc(v.name)}${note}</button>`;
    }).join('');

    renderInto(bodyEl, `
      <div style="margin-bottom:4px;font-size:10px;color:#666;">PC STATS</div>
      <div style="display:flex;gap:20px;padding:8px 0;margin-bottom:4px;border-bottom:1px solid #2a2a44;">
        ${attrHtml}
        <div style="margin-left:auto;text-align:right;">
          <div style="color:#ffcc00;font-size:16px;font-weight:bold;">${xpPool} XP</div>
          <div style="color:#666;font-size:10px;">pool</div>
        </div>
      </div>
      <div style="margin-bottom:4px;font-size:11px;color:#aac;">SKILLS</div>
      ${noSkillsMsg}
      <div style="margin-top:12px;margin-bottom:4px;font-size:11px;color:#aac;">ASSIGN TO VEHICLE</div>
      <div style="display:flex;flex-wrap:wrap;">
        ${assignRows || '<span style="color:#555;font-size:11px;">No vehicles — buy one from the Shop.</span>'}
      </div>
      <div style="margin-top:12px;font-size:11px;color:#666;">
        ${esc(driver.title ?? '')} · ${esc(assignedVehicle)}
      </div>
    `);
    this.openModal('modal-driver');
  }

  private async openHireModal(): Promise<void> {
    const bodyEl = this.root.querySelector('#modal-hire-body') as HTMLElement;
    const footerEl = this.root.querySelector('#modal-hire-footer') as HTMLElement;
    renderInto(bodyEl, '<p style="font-size:12px;color:var(--gray)">Loading candidates…</p>');
    this.openModal('modal-hire');

    const host = window.location.hostname;
    const TIERS = [
      { key: 'rookie',   label: 'ROOKIE',   hint: 'skill 1-2 · cheap recruits' },
      { key: 'standard', label: 'STANDARD', hint: 'skill 1-6 · the regular pool' },
      { key: 'premium',  label: 'PREMIUM',  hint: 'skill 4-6 · elite (5 arena wins to unlock)' },
    ];
    let poolCandidates: any[] = [];
    let activeTier = 'rookie';

    const renderPool = (): void => {
      const inTier = poolCandidates.filter(c => (c.tier ?? 'standard') === activeTier);
      const tabs = TIERS.map(t => {
        const count = poolCandidates.filter(c => (c.tier ?? 'standard') === t.key).length;
        const on = t.key === activeTier;
        return `<button data-hire-tier="${esc(t.key)}" title="${esc(t.hint)}"
          style="padding:6px 12px;font-family:inherit;font-size:11px;cursor:pointer;
                 background:${on ? '#1a1a3a' : 'transparent'};color:${on ? '#00ff88' : '#889'};
                 border:1px solid ${on ? '#00ff88' : '#2a2a44'};border-bottom:none;">${esc(t.label)} (${count})</button>`;
      }).join('');

      const cards = inTier.map(c => {
        const hasPkg = !!c.vehicle_stock_id;
        const pkgCost = hasPkg ? Math.round(c.vehicle_cost * (1 - c.vehicle_discount_pct / 100)) : 0;
        const total = c.hire_cost + pkgCost;
        const stars = '★'.repeat(c.skill) + '☆'.repeat(Math.max(0, 6 - c.skill));
        const affordable = this.gang && this.gang.treasury >= total;
        return `<div style="background:#11112a;border:1px solid #2a2a44;padding:14px;margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;">
            <div style="color:#00ff88;font-size:13px;font-weight:bold;">${esc(c.name)}</div>
            <div style="color:#ffcc00;font-size:10px;letter-spacing:2px;">SKILL ${esc(String(c.skill))}</div>
          </div>
          <div style="color:#888;font-size:11px;margin-bottom:6px;">${esc(stars)} · aggro ${esc(String(c.aggression))} · loyalty ${esc(String(c.loyalty))}</div>
          <div style="color:#aac;font-size:11px;line-height:1.4;margin-bottom:8px;">${esc(c.blurb)}</div>
          ${hasPkg ? `<div style="background:#1a2a11;border-left:3px solid #88ccff;padding:6px 8px;font-size:11px;color:#aaccff;margin-bottom:8px;">
            Package: <b>${esc(c.vehicle_name)}</b> (Div ${esc(String(c.vehicle_division))}) · <span style="color:#ffcc00;">-${esc(String(c.vehicle_discount_pct))}% off</span> $${pkgCost.toLocaleString()}</div>` : ''}
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="color:#ffcc00;font-size:13px;font-weight:bold;">$${total.toLocaleString()}</span>
            <button data-hire-candidate="${esc(c.id)}"
              style="padding:5px 14px;font-family:inherit;font-size:11px;background:${affordable ? '#003322' : '#221122'};color:${affordable ? '#00ff88' : '#888'};border:1px solid ${affordable ? '#00ff88' : '#444'};cursor:${affordable ? 'pointer' : 'not-allowed'};"
              ${affordable ? '' : 'disabled'}>${affordable ? '[HIRE]' : '[NO FUNDS]'}</button>
          </div>
        </div>`;
      }).join('');

      const activeMeta = TIERS.find(t => t.key === activeTier)!;
      renderInto(bodyEl, `
        <div style="display:flex;gap:4px;border-bottom:1px solid #2a2a44;margin-bottom:12px;">${tabs}</div>
        ${inTier.length ? cards
          : `<div style="padding:32px;text-align:center;color:#778;font-size:12px;">No ${activeMeta.label.toLowerCase()} recruits available.<br><span style="color:#556;">${esc(activeMeta.hint)}</span></div>`}
      `);

      renderInto(footerEl, `
        <button class="btn btn-ghost" data-action="close-modal" data-modal="modal-hire">Close</button>
        <button class="btn btn-yellow" data-action="hire-refresh" style="font-size:11px;">[ Refresh Pool ($100) ]</button>
      `);
    };

    const loadPool = async (): Promise<void> => {
      renderInto(bodyEl, '<p style="font-size:12px;color:var(--gray)">Loading candidates…</p>');
      const r = await fetch(`http://${host}:3001/api/drivers/candidates`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      poolCandidates = r.ok ? await r.json() : [];
      const firstWith = TIERS.find(t => poolCandidates.some(c => (c.tier ?? 'standard') === t.key));
      activeTier = firstWith?.key ?? 'rookie';
      renderPool();
    };

    // Wire tier tabs and hire buttons dynamically
    const hireModal = this.root.querySelector('#modal-hire') as HTMLElement;
    if (!hireModal.dataset.hireWired) {
      hireModal.dataset.hireWired = '1';
      hireModal.addEventListener('click', async (e) => {
        const target = (e.target as HTMLElement).closest<HTMLElement>('[data-hire-tier],[data-hire-candidate],[data-action]');
        if (!target) return;
        if (target.dataset.hireTier) {
          activeTier = target.dataset.hireTier;
          renderPool();
          return;
        }
        if (target.dataset.hireCandidate) {
          const id = target.dataset.hireCandidate;
          const r = await fetch(`http://${host}:3001/api/drivers/candidates/${id}/hire`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.token}` },
          });
          if (r.ok) {
            this.closeModal('modal-hire');
            this.scene.restart({ token: this.token });
          } else {
            const body = await r.json().catch(() => ({}));
            showToast(this.root, body.error ?? 'Hire failed');
          }
          return;
        }
        if (target.dataset.action === 'hire-refresh') {
          const r = await fetch(`http://${host}:3001/api/drivers/candidates/refresh`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.token}` },
          });
          if (r.ok) await loadPool();
          else showToast(this.root, (await r.json().catch(() => ({}))).error ?? 'Refresh failed');
        }
      });
    }

    await loadPool();
  }

  private openGangSettingsModal(): void {
    if (!this.gang) return;
    const nameInput = this.root.querySelector<HTMLInputElement>('#gang-name-input');
    if (nameInput) nameInput.value = this.gang.name;

    // Mark the currently selected colour
    const hexColor = '#' + this.gang.primary_colour.toString(16).padStart(6, '0');
    this.root.querySelectorAll<HTMLElement>('.gang-color-swatch').forEach(sw => {
      sw.classList.toggle('selected', sw.dataset.color === hexColor);
    });

    this.openModal('modal-gang');
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

      // Anything broken — wrecked, lost armour, dead engine, blown tires —
      // gets a Repair button. The repair endpoint restores wrecks too
      // (it clears the destroyed flag).
      const needsRepair = !!v.damage_state?.destroyed
        || curArmor < maxArmor
        || !!v.damage_state?.engineDamaged
        || (v.damage_state?.tiresBlown?.length ?? 0) > 0;

      // Body sprite thumbnail — neutral-grey PNG tinted to the gang primary
      // colour via feColorMatrix, same approach as the Vehicle Designer.
      const bodyKey = bodySpriteKey(v.loadout?.bodyType);
      const tintColour = this.gang?.primary_colour ?? 0x00ff88;
      const tintR = (((tintColour >> 16) & 0xff) / 255).toFixed(3);
      const tintG = (((tintColour >>  8) & 0xff) / 255).toFixed(3);
      const tintB = ((tintColour & 0xff) / 255).toFixed(3);
      const thumbSvg = `
        <svg width="56" height="78" viewBox="0 0 56 78"${v.damage_state?.destroyed ? ' style="opacity:0.35"' : ''}>
          <defs>
            <filter id="thumb-tint-${esc(v.id)}" color-interpolation-filters="sRGB">
              <feColorMatrix type="matrix" values="
                ${tintR} 0 0 0 0
                0 ${tintG} 0 0 0
                0 0 ${tintB} 0 0
                0 0 0 1 0"/>
            </filter>
          </defs>
          <image href="/sprites/bodies/${esc(bodyKey)}.png"
                 x="4" y="4" width="48" height="70"
                 preserveAspectRatio="xMidYMid meet"
                 filter="url(#thumb-tint-${esc(v.id)})"
                 style="image-rendering: pixelated;"/>
        </svg>`;

      return `
        <div class="vehicle-card${isSelected ? ' selected' : ''}" data-vehicle-id="${esc(v.id)}">
          <div class="vehicle-thumb">
            ${thumbSvg}
            <span class="dot ${dotColor}" style="position:absolute;top:4px;right:4px"></span>
          </div>
          <div class="vehicle-info">
            <div class="vehicle-name ${nameColor}">${esc(v.name)}</div>
            <div class="vehicle-meta">
              <span>Value <span class="val">$${esc(v.value?.toLocaleString() ?? '0')}</span></span>
              <span>Div <span class="val">${esc(this.division)}</span></span>
              <span>Armor <span class="val">${esc(curArmor)}/${esc(maxArmor)}</span></span>
              ${v.damage_state?.destroyed ? '<span style="color:var(--red);font-weight:bold">WRECKED</span>' : ''}
              ${v.status && v.status !== 'available' ? `<span style="color:var(--amber)">${esc(v.status.replace('_', ' '))}</span>` : ''}
            </div>
            <div class="vehicle-driver${driver ? '' : ' unassigned'}">
              ${driver
                ? `<span class="dot dot-green"></span> ${esc(driver.name)} · Skill ${esc(driver.skill)}`
                : `— No driver assigned
                   <button class="btn" data-action="assign-vehicle-driver" data-vehicle-id="${esc(v.id)}"
                     style="font-size:10px;padding:2px 8px;margin-left:6px;">+ Assign Driver</button>`}
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

    // Click outside modal closes it
    if (target.classList.contains('modal-overlay')) {
      target.classList.remove('open');
      return;
    }

    // Vehicle card selection (click on card but not a button)
    const card = target.closest<HTMLElement>('.vehicle-card');
    if (card && !target.closest('button') && !target.closest('input')) {
      this.selectedVehicleId = card.dataset.vehicleId ?? '';
      this.rebuildVehiclePanel();
      return;
    }

    // data-attr / data-skill buttons (driver card upgrades) carry no
    // data-action — include them so the default case below can handle them.
    const actionEl = target.closest<HTMLElement>('[data-action],[data-attr],[data-skill]');
    if (!actionEl) return;
    const action = actionEl.dataset.action ?? '';

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
      case 'fight': {
        const vid = actionEl.closest<HTMLElement>('[data-vehicle-id]')?.dataset.vehicleId ?? actionEl.dataset.vehicleId ?? '';
        this.openFightModal(vid);
        break;
      }
      case 'repair': {
        const vid = actionEl.closest<HTMLElement>('[data-vehicle-id]')?.dataset.vehicleId ?? actionEl.dataset.vehicleId ?? '';
        this.openRepairModal(vid).catch(() => showToast(this.root, 'Could not load repair info.'));
        break;
      }
      case 'sell': {
        const vid = actionEl.closest<HTMLElement>('[data-vehicle-id]')?.dataset.vehicleId ?? actionEl.dataset.vehicleId ?? '';
        this.openSellModal(vid);
        break;
      }
      case 'driver-card': {
        const did = actionEl.closest<HTMLElement>('[data-driver-id]')?.dataset.driverId ?? actionEl.dataset.driverId ?? '';
        this.openDriverCardModal(did);
        break;
      }
      case 'assign-vehicle-driver': {
        const vid = actionEl.dataset.vehicleId ?? '';
        this.openAssignDriverModal(vid);
        break;
      }
      case 'assign-driver': {
        const did = actionEl.dataset.driverId ?? '';
        const vid = actionEl.dataset.vehicleId ?? '';
        this.doAssignDriver(did, vid);
        break;
      }
      case 'hire':
        this.openHireModal().catch(() => showToast(this.root, 'Could not load hire candidates.'));
        break;
      case 'gang-settings':
        this.openGangSettingsModal();
        break;
      case 'close-modal': {
        const modalId = actionEl.dataset.modal ?? '';
        this.closeModal(modalId);
        break;
      }
      case 'confirm-fight': {
        const checkboxes = Array.from(
          this.root.querySelectorAll<HTMLInputElement>('input[data-squad-vehicle]:checked')
        );
        const squadIds = [this.pendingFightVehicleId, ...checkboxes.map(cb => cb.dataset.squadVehicle!)];
        const mapId = localStorage.getItem('cw_selected_map') ?? 'truck-stop';
        this.closeModal('modal-fight');
        this.launchArena(squadIds, mapId);
        break;
      }
      case 'confirm-repair':
        this.doConfirmRepair();
        break;
      case 'confirm-sell':
        this.doConfirmSell();
        break;
      case 'confirm-gang-settings':
        this.doSaveGangSettings();
        break;
      case 'gang-color': {
        this.root.querySelectorAll<HTMLElement>('.gang-color-swatch').forEach(sw => sw.classList.remove('selected'));
        actionEl.classList.add('selected');
        break;
      }
      // Attr / skill upgrades in driver card modal
      default: {
        const attrKey = actionEl.dataset.attr;
        const driverIdForAttr = actionEl.dataset.driverId;
        if (attrKey && driverIdForAttr) {
          this.doAttrUpgrade(driverIdForAttr, attrKey, Number(actionEl.dataset.cost));
          break;
        }
        const skillId = actionEl.dataset.skill;
        const driverIdForSkill = actionEl.dataset.driverId;
        if (skillId && driverIdForSkill) {
          this.doSkillUpgrade(driverIdForSkill, skillId, Number(actionEl.dataset.cost));
        }
        break;
      }
    }
  }

  private async doConfirmRepair(): Promise<void> {
    const vehicleId = this.pendingRepairVehicleId;
    if (!vehicleId) return;
    const host = window.location.hostname;
    // Repair all parts
    const r = await fetch(`http://${host}:3001/api/economy/repair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ vehicleId, parts: ['armor', 'tires', 'engine', 'ammo'] }),
    });
    if (r.ok) {
      this.closeModal('modal-repair');
      this.scene.restart({ token: this.token });
    } else {
      const body = await r.json().catch(() => ({}));
      showToast(this.root, body.error ?? 'Repair failed');
    }
  }

  private async doConfirmSell(): Promise<void> {
    const vehicleId = this.pendingSellVehicleId;
    if (!vehicleId) return;
    const host = window.location.hostname;
    const res = await fetch(`http://${host}:3001/api/vehicles/${vehicleId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (res.ok) {
      this.closeModal('modal-sell');
      this.scene.restart({ token: this.token });
    } else {
      const body = await res.json().catch(() => ({}));
      showToast(this.root, body.error ?? 'Sell failed');
    }
  }

  private async doSaveGangSettings(): Promise<void> {
    const nameInput = this.root.querySelector<HTMLInputElement>('#gang-name-input');
    const selectedSwatch = this.root.querySelector<HTMLElement>('.gang-color-swatch.selected');
    const name = nameInput?.value ?? this.gang?.name ?? '';
    const hexColor = selectedSwatch?.dataset.color ?? ('#' + (this.gang?.primary_colour ?? 0xff4444).toString(16).padStart(6, '0'));
    const primaryColour = parseInt(hexColor.replace('#', ''), 16);
    const host = window.location.hostname;
    const res = await fetch(`http://${host}:3001/api/gangs/mine`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({
        name,
        primary_colour: primaryColour,
        secondary_colour: this.gang?.secondary_colour ?? primaryColour,
        emblem_id: this.gang?.emblem_id ?? 'stripes',
      }),
    });
    if (res.ok) {
      this.closeModal('modal-gang');
      this.scene.restart({ token: this.token });
    } else {
      const body = await res.json().catch(() => ({}));
      showToast(this.root, body.error ?? 'Save failed');
    }
  }

  // ── Driver assignment ────────────────────────────────────────────────

  // Vehicle-centric direction: pick a living driver for this vehicle.
  private openAssignDriverModal(vehicleId: string): void {
    const vehicle = this.vehicles.find(v => v.id === vehicleId);
    if (!vehicle) return;
    const titleEl = this.root.querySelector('#modal-assign-title') as HTMLElement | null;
    if (titleEl) titleEl.textContent = `Assign Driver — ${vehicle.name}`;

    const bodyEl = this.root.querySelector('#modal-assign-body') as HTMLElement;
    const candidates = this.drivers.filter(d => d.alive);
    const rows = candidates.map(d => {
      const isCurrent = d.assigned_vehicle_id === vehicleId;
      const currentVehicle = d.assigned_vehicle_id && !isCurrent
        ? this.vehicles.find(v => v.id === d.assigned_vehicle_id)?.name ?? null
        : null;
      const note = isCurrent ? ' ✓ assigned'
        : currentVehicle ? ` — currently on ${esc(currentVehicle)}`
        : ' — unassigned';
      return `<button class="btn${isCurrent ? ' btn-green' : ''}" data-action="assign-driver"
                data-driver-id="${esc(d.id)}" data-vehicle-id="${esc(vehicleId)}"
                ${isCurrent ? 'disabled' : ''}
                style="display:block;width:100%;text-align:left;margin-bottom:6px;font-size:12px;">
                ${esc(d.name)} · Skill ${esc(d.skill)}${note}</button>`;
    }).join('');

    renderInto(bodyEl, rows ||
      '<p style="font-size:12px;color:var(--gray)">No living drivers — hire one from the crew panel.</p>');
    this.openModal('modal-assign');
  }

  private async doAssignDriver(driverId: string, vehicleId: string): Promise<void> {
    if (!driverId || !vehicleId) return;
    const host = window.location.hostname;
    const res = await fetch(`http://${host}:3001/api/drivers/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ driverId, vehicleId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(this.root, err.error ?? 'Assignment failed');
      return;
    }
    // Mirror the server's displacement rule locally, then re-render.
    for (const d of this.drivers) {
      if (d.assigned_vehicle_id === vehicleId && d.id !== driverId) d.assigned_vehicle_id = null;
    }
    const driver = this.drivers.find(d => d.id === driverId);
    if (driver) driver.assigned_vehicle_id = vehicleId;
    this.closeModal('modal-assign');
    this.closeModal('modal-driver');
    this.rebuildMain();
    const vehicleName = this.vehicles.find(v => v.id === vehicleId)?.name ?? 'vehicle';
    showToast(this.root, `${driver?.name ?? 'Driver'} assigned to ${vehicleName}`);
  }

  private async doAttrUpgrade(driverId: string, attrKey: string, cost: number): Promise<void> {
    const driver = this.drivers.find(d => d.id === driverId);
    if (!driver || (driver.xp_pool ?? 0) < cost) return;
    const host = window.location.hostname;
    const r = await fetch(`http://${host}:3001/api/drivers/${driverId}/upgrade-attr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ attrKey }),
    });
    if (r.ok) {
      const updated = await r.json();
      driver.xp_pool = updated.xpPool;
      driver.attributes = updated.attributes;
      this.openDriverCardModal(driverId);
    } else {
      const err = await r.json().catch(() => ({}));
      showToast(this.root, err.error ?? 'Attribute upgrade failed');
    }
  }

  private async doSkillUpgrade(driverId: string, skillId: string, cost: number): Promise<void> {
    const driver = this.drivers.find(d => d.id === driverId);
    if (!driver || (driver.xp_pool ?? 0) < cost) return;
    const host = window.location.hostname;
    const r = await fetch(`http://${host}:3001/api/drivers/${driverId}/spend-xp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ skillId }),
    });
    if (r.ok) {
      const updated = await r.json();
      driver.xp_pool = updated.xpPool;
      driver.skills = updated.skills;
      this.openDriverCardModal(driverId);
    } else {
      const err = await r.json().catch(() => ({}));
      showToast(this.root, err.error ?? 'Upgrade failed');
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

  // Fire-and-forget persistence of the player's current vehicle (and the
  // driver assigned to it, if any). Updates local state immediately so the
  // highlight re-renders correctly even if the request races.
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

}
