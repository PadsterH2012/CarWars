import Phaser from 'phaser';
import { esc, renderInto, buildSidebarHTML, createHubRoot, wireNavigation, showToast, SidebarOpts } from '../ui/hub';

interface Job {
  id: string; job_type: string; description: string; payout: number;
  difficulty: number; division_min: number;
}
interface ActiveJob {
  id: string; jobId: string; jobType: string; description: string;
  payout: number; vehicleCount: number; remainingSeconds: number;
}
interface Gang {
  id: string; name: string; primary_colour: number; treasury: number;
  reputation: number; division?: number; influence?: number;
}
interface VehicleLite {
  id: string; name: string; status?: string;
  damage_state?: { armor?: Record<string, number> };
}
interface DriverLite {
  id: string; name: string; skill: number; status?: string; assigned_vehicle_id?: string | null;
}

function fmtRemaining(seconds: number): string {
  if (seconds <= 0) return 'now';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

function difficultyTag(d: number): string {
  if (d <= 3) return `<span class="tag tag-easy">Difficulty ${d}/10</span>`;
  if (d <= 6) return `<span class="tag tag-medium">Difficulty ${d}/10</span>`;
  return `<span class="tag tag-hard">Difficulty ${d}/10</span>`;
}

function jobIcon(jobType: string): string {
  switch (jobType.toLowerCase()) {
    case 'convoy':   return '🚚';
    case 'courier':  return '🚗';
    case 'assault':  return '⚡';
    case 'salvage':  return '🏗';
    case 'recon':    return '🔍';
    case 'demolition': return '💣';
    case 'bodyguard': return '🛡';
    default:         return '📋';
  }
}

export class JobBoardScene extends Phaser.Scene {
  private token = '';
  private jobs: Job[] = [];
  private activeJobs: ActiveJob[] = [];
  private gang: Gang | null = null;
  private unreadReports = 0;
  private unreadActivity = 0;
  private root!: HTMLDivElement;
  private etaIntervalId?: ReturnType<typeof setInterval>;

  // Squad picker modal state
  private vehicles: VehicleLite[] = [];
  private drivers: DriverLite[] = [];
  private selectedVehicleIds: Set<string> = new Set();
  private pendingJob: Job | null = null;
  private squadModalOpen = false;

  constructor() { super({ key: 'JobBoardScene' }); }

  init(data: { token: string }): void {
    this.token = data.token;
    this.jobs = [];
    this.activeJobs = [];
    this.pendingJob = null;
    this.squadModalOpen = false;
    this.selectedVehicleIds = new Set();
  }

  async create(): Promise<void> {
    const host = window.location.hostname;
    const headers = { Authorization: `Bearer ${this.token}` };

    const [jobsRes, activeRes, gangRes, repRes, actRes, vRes, dRes] = await Promise.all([
      fetch(`http://${host}:3001/api/jobs/headless?zoneId=town-1`, { headers }),
      fetch(`http://${host}:3001/api/jobs/active`, { headers }),
      fetch(`http://${host}:3001/api/gangs/mine`, { headers }),
      fetch(`http://${host}:3001/api/reports/unread-count`, { headers }),
      fetch(`http://${host}:3001/api/territory/activity/unread-count`, { headers }),
      fetch(`http://${host}:3001/api/vehicles`, { headers }),
      fetch(`http://${host}:3001/api/drivers`, { headers }),
    ]);

    if (jobsRes.ok) this.jobs = await jobsRes.json();
    if (activeRes.ok) this.activeJobs = await activeRes.json();
    if (gangRes.ok) this.gang = await gangRes.json();
    if (repRes.ok) this.unreadReports = (await repRes.json()).unread ?? 0;
    if (actRes.ok) this.unreadActivity = (await actRes.json()).unread ?? 0;
    if (vRes.ok) this.vehicles = await vRes.json();
    if (dRes.ok) this.drivers = await dRes.json();

    this.root = createHubRoot(this);

    const sidebar = document.createElement('nav');
    sidebar.className = 'sidebar';

    const main = document.createElement('div');
    main.className = 'main';

    this.root.appendChild(sidebar);
    this.root.appendChild(main);

    const sidebarOpts: SidebarOpts = {
      gangName:       this.gang?.name ?? 'Unknown',
      gangColor:      this.gang?.primary_colour ?? 0xff4444,
      treasury:       this.gang?.treasury ?? 0,
      reputation:     this.gang?.reputation ?? 0,
      division:       this.gang?.division ?? 1,
      influence:      this.gang?.influence ?? 0,
      reportsBadge:   this.unreadReports,
      activityBadge:  this.unreadActivity,
      activeNav:      'jobboard',
      token:          this.token,
    };
    renderInto(sidebar, buildSidebarHTML(sidebarOpts));

    renderInto(main, this.buildMainHTML());

    this.root.appendChild(this.buildSquadModal());

    wireNavigation(this.root, this, this.token);
    this.root.addEventListener('click', this.onClick);

    this.startEtaTick();

    this.input.keyboard?.on('keydown-ESC', () => {
      this.closeSquadModal();
    });
  }

  private buildMainHTML(): string {
    const activeSection = this.activeJobs.length > 0 ? `
      <div class="section-heading">
        In Progress
        <span class="section-count">${this.activeJobs.length} active</span>
      </div>
      ${this.activeJobs.map(aj => this.renderActiveCard(aj)).join('')}
      <div class="section-heading" style="margin-top:6px">
        Available Jobs
        <span class="section-count">${this.jobs.length} open</span>
      </div>` : `
      <div class="section-heading">
        Available Jobs
        <span class="section-count">${this.jobs.length} open</span>
      </div>`;

    const jobCards = this.jobs.length > 0
      ? this.jobs.map(j => this.renderJobCard(j)).join('')
      : `<div style="padding:32px;text-align:center;color:var(--gray);font-size:13px;">No jobs available at this time.</div>`;

    return `
      <div class="page-header">
        <div class="page-title">Job Board</div>
        <div class="page-subtitle">Send a crew to earn credits and reputation</div>
      </div>
      <div class="content" style="overflow-y:auto;">
        <div class="job-list">
          ${activeSection}
          ${jobCards}
        </div>
      </div>`;
  }

  private renderActiveCard(aj: ActiveJob): string {
    return `
      <div class="active-card">
        <div class="job-icon">${jobIcon(aj.jobType)}</div>
        <div class="active-body">
          <div class="active-title">${esc(aj.description)}</div>
          <div class="active-detail">
            <span>${aj.vehicleCount} vehicle${aj.vehicleCount === 1 ? '' : 's'}</span>
            <span class="payout">$${aj.payout.toLocaleString()}</span>
          </div>
        </div>
        <div class="eta-block">
          <div class="eta-label">ETA</div>
          <div class="eta-time" data-active-id="${esc(aj.id)}">${fmtRemaining(aj.remainingSeconds)}</div>
        </div>
      </div>`;
  }

  private renderJobCard(j: Job): string {
    return `
      <div class="job-card">
        <div class="job-icon">${jobIcon(j.job_type)}</div>
        <div class="job-body">
          <div class="job-title">${esc(j.description)}</div>
          <div class="job-tags">
            <span class="tag tag-payout">$${j.payout.toLocaleString()}</span>
            ${difficultyTag(j.difficulty)}
            <span class="tag">Min div ${j.division_min}</span>
          </div>
        </div>
        <div class="job-actions">
          <button class="btn btn-green" data-action="send-squad" data-job-id="${esc(j.id)}">Send Squad →</button>
        </div>
      </div>`;
  }

  private buildSquadModal(): HTMLElement {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'modal-squad';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title" id="squad-modal-title">📋 Send Squad</div>
        <div class="modal-body" id="squad-modal-body"></div>
        <div class="modal-footer">
          <button class="btn btn-ghost" data-action="close-squad-modal">Cancel</button>
          <button class="btn btn-green" data-action="confirm-squad" disabled id="squad-confirm-btn">Dispatch →</button>
        </div>
      </div>`;
    return overlay;
  }

  private onClick = (e: MouseEvent): void => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!t) return;
    const action = t.dataset.action!;

    if (action === 'send-squad') {
      const jobId = t.dataset.jobId!;
      const job = this.jobs.find(j => j.id === jobId);
      if (job) this.openSquadModal(job);
    } else if (action === 'close-squad-modal') {
      this.closeSquadModal();
    } else if (action === 'toggle-vehicle') {
      const vid = t.dataset.vehicleId!;
      if (this.selectedVehicleIds.has(vid)) {
        this.selectedVehicleIds.delete(vid);
      } else if (this.selectedVehicleIds.size < 4) {
        this.selectedVehicleIds.add(vid);
      }
      this.refreshSquadModal();
    } else if (action === 'confirm-squad') {
      this.dispatchSquad();
    }

    // Close modal on overlay click
    const overlay = this.root.querySelector('#modal-squad');
    if (overlay && e.target === overlay) {
      this.closeSquadModal();
    }
  };

  private openSquadModal(job: Job): void {
    this.pendingJob = job;
    this.selectedVehicleIds = new Set();
    this.squadModalOpen = true;

    const titleEl = this.root.querySelector<HTMLElement>('#squad-modal-title');
    if (titleEl) titleEl.textContent = `📋 Send Squad — ${job.description}`;

    this.refreshSquadModal();

    const overlay = this.root.querySelector<HTMLElement>('#modal-squad');
    overlay?.classList.add('open');
  }

  private closeSquadModal(): void {
    this.squadModalOpen = false;
    const overlay = this.root.querySelector<HTMLElement>('#modal-squad');
    overlay?.classList.remove('open');
  }

  private refreshSquadModal(): void {
    const body = this.root.querySelector<HTMLElement>('#squad-modal-body');
    if (!body) return;

    // Build driver lookup
    const driverByVid = new Map<string, DriverLite>();
    for (const d of this.drivers) {
      if (d.assigned_vehicle_id) driverByVid.set(d.assigned_vehicle_id, d);
    }

    const rows = this.vehicles.map(v => {
      const driver = driverByVid.get(v.id) ?? null;
      const armorFaces = (v.damage_state?.armor ?? {}) as Record<string, number>;
      const armour = Object.values(armorFaces).reduce((s, n) => s + (Number(n) || 0), 0);
      const eligible = v.status === 'available' && !!driver && driver.status === 'available';
      const checked = this.selectedVehicleIds.has(v.id);

      if (!eligible) {
        const reason = !driver ? 'No driver' : driver.status !== 'available' ? 'Driver unavailable' : 'Unavailable';
        return `
          <div class="squad-check" style="opacity:0.5">
            <input type="checkbox" disabled>
            <div>
              <div class="squad-vname">${esc(v.name)}</div>
              <div class="squad-vwarn">⚠ ${esc(reason)}</div>
            </div>
          </div>`;
      }

      return `
        <div class="squad-check">
          <input type="checkbox" ${checked ? 'checked' : ''} data-action="toggle-vehicle" data-vehicle-id="${esc(v.id)}" style="cursor:pointer">
          <div>
            <div class="squad-vname">${esc(v.name)}</div>
            <div class="squad-vdetail">${esc(driver!.name)} · sk${driver!.skill} · armour ${armour}</div>
          </div>
        </div>`;
    });

    renderInto(body, rows.join(''));

    // Wire checkboxes (since renderInto clears old listeners)
    body.querySelectorAll<HTMLInputElement>('input[type=checkbox][data-action]').forEach(cb => {
      cb.addEventListener('change', () => {
        const vid = cb.dataset.vehicleId!;
        if (cb.checked && this.selectedVehicleIds.size < 4) {
          this.selectedVehicleIds.add(vid);
        } else {
          this.selectedVehicleIds.delete(vid);
          cb.checked = false;
        }
        this.refreshSquadModal();
      });
    });

    const confirmBtn = this.root.querySelector<HTMLButtonElement>('#squad-confirm-btn');
    if (confirmBtn) {
      confirmBtn.disabled = this.selectedVehicleIds.size === 0;
    }
  }

  private async dispatchSquad(): Promise<void> {
    if (!this.pendingJob || this.selectedVehicleIds.size === 0) return;
    const confirmBtn = this.root.querySelector<HTMLButtonElement>('#squad-confirm-btn');
    if (confirmBtn) confirmBtn.disabled = true;

    const host = window.location.hostname;
    try {
      const res = await fetch(`http://${host}:3001/api/jobs/${this.pendingJob.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ vehicleIds: [...this.selectedVehicleIds] }),
      });
      if (res.ok) {
        this.closeSquadModal();
        showToast(this.root, 'Squad dispatched!');
        // Reload scene to show updated state
        this.scene.restart({ token: this.token });
      } else {
        const body = await res.json().catch(() => ({}));
        showToast(this.root, body.error ?? 'Failed to dispatch squad');
        if (confirmBtn) confirmBtn.disabled = false;
      }
    } catch {
      showToast(this.root, 'Network error');
      if (confirmBtn) confirmBtn.disabled = false;
    }
  }

  private startEtaTick(): void {
    if (this.activeJobs.length === 0) return;

    this.etaIntervalId = setInterval(() => {
      for (const aj of this.activeJobs) {
        if (aj.remainingSeconds > 0) aj.remainingSeconds -= 1;
        const el = this.root.querySelector<HTMLElement>(`[data-active-id="${aj.id}"]`);
        if (el) el.textContent = fmtRemaining(aj.remainingSeconds);
      }
    }, 1000);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      if (this.etaIntervalId !== undefined) clearInterval(this.etaIntervalId);
    });
  }
}
