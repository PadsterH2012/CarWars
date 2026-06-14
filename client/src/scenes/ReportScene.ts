import Phaser from 'phaser';
import { esc, renderInto, buildSidebarHTML, createHubRoot, wireNavigation, redirectIfUnauthorized, showToast, SidebarOpts } from '../ui/hub';

type Outcome = 'success' | 'partial' | 'failure' | 'routed';

interface PerDriver {
  driverId: string; driverName: string;
  status: 'unharmed' | 'wounded' | 'dead'; kills: number;
}
interface PerVehicle {
  vehicleId: string; name: string; damage: string; repairCost: number;
}
interface ReportBody {
  zone: string; zoneName: string; assignment: string; encounter: string; summary: string;
  perDriver: PerDriver[]; vehicles: PerVehicle[];
  income: number; repairCost: number; net: number;
  rivalRepChange: { rivalId: string; rivalName: string; delta: number } | null;
  influenceDelta?: number;
}
interface ReportRow {
  id: string; zone_id: string; outcome: Outcome; report: ReportBody;
  read: boolean; created_at: string;
}
interface Gang {
  id: string; name: string; primary_colour: number; treasury: number;
  reputation: number; division?: number; influence?: number;
}

function outcomeClass(o: Outcome): string {
  if (o === 'success') return 'outcome-v';
  if (o === 'partial') return 'outcome-w';
  if (o === 'routed')  return 'outcome-d';
  return 'outcome-d'; // failure
}

function outcomeLabel(o: Outcome): string {
  if (o === 'success') return 'Victory';
  if (o === 'partial') return 'Partial';
  if (o === 'routed')  return 'Routed';
  return 'Defeat';
}

function outcomeUnreadClass(o: Outcome): string {
  if (o === 'success') return 'victory';
  if (o === 'partial') return 'victory';
  if (o === 'routed')  return 'defeat';
  return 'defeat';
}

function reportIcon(r: ReportRow): string {
  const a = r.report?.assignment ?? '';
  if (a === 'job' || a.startsWith('job')) return '🚚';
  return '⚔';
}

function fmtTime(isoStr: string): string {
  try {
    const d = new Date(isoStr);
    const now = Date.now();
    const diff = now - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return d.toLocaleDateString();
  } catch {
    return '';
  }
}

export class ReportScene extends Phaser.Scene {
  private token = '';
  private reports: ReportRow[] = [];
  private gang: Gang | null = null;
  private unreadReports = 0;
  private unreadActivity = 0;
  private root!: HTMLDivElement;
  private sidebarEl!: HTMLElement;
  private mainEl!: HTMLElement;

  constructor() { super({ key: 'ReportScene' }); }

  init(data: { token: string }): void {
    this.token = data.token;
    this.reports = [];
  }

  async create(): Promise<void> {
    const host = window.location.hostname;
    const headers = { Authorization: `Bearer ${this.token}` };

    const [repRes, gangRes, repCountRes, actRes] = await Promise.all([
      fetch(`http://${host}:3001/api/reports`, { headers }),
      fetch(`http://${host}:3001/api/gangs/mine`, { headers }),
      fetch(`http://${host}:3001/api/reports/unread-count`, { headers }),
      fetch(`http://${host}:3001/api/territory/activity/unread-count`, { headers }),
    ]);
    if (redirectIfUnauthorized(this, [repRes, gangRes, repCountRes, actRes])) return;

    if (repRes.ok) this.reports = (await repRes.json()).reports ?? [];
    if (gangRes.ok) this.gang = await gangRes.json();
    if (repCountRes.ok) this.unreadReports = (await repCountRes.json()).unread ?? 0;
    if (actRes.ok) this.unreadActivity = (await actRes.json()).unread ?? 0;

    this.root = createHubRoot(this);

    this.sidebarEl = document.createElement('nav');
    this.sidebarEl.className = 'sidebar';

    this.mainEl = document.createElement('div');
    this.mainEl.className = 'main';

    this.root.appendChild(this.sidebarEl);
    this.root.appendChild(this.mainEl);

    this.rebuild();
    wireNavigation(this.root, this, this.token);
    this.root.addEventListener('click', this.onClick);
  }

  private rebuild(): void {
    const sidebarOpts: SidebarOpts = {
      gangName:      this.gang?.name ?? 'Unknown',
      gangColor:     this.gang?.primary_colour ?? 0xff4444,
      treasury:      this.gang?.treasury ?? 0,
      reputation:    this.gang?.reputation ?? 0,
      division:      this.gang?.division ?? 1,
      influence:     this.gang?.influence ?? 0,
      reportsBadge:  this.unreadReports,
      activityBadge: this.unreadActivity,
      activeNav:     'reports',
      token:         this.token,
    };
    renderInto(this.sidebarEl, buildSidebarHTML(sidebarOpts));
    renderInto(this.mainEl, this.buildMainHTML());
    wireNavigation(this.root, this, this.token);
  }

  private buildMainHTML(): string {
    if (!this.reports.length) {
      return `
        <div class="page-header">
          <div class="page-title">Battle Reports</div>
          <div class="page-subtitle">click any report to expand</div>
        </div>
        <div class="content" style="display:flex;align-items:center;justify-content:center;">
          <div style="text-align:center;color:var(--gray);font-size:13px;">
            No reports yet. Send a squad on a job or deploy from the World Map.
          </div>
        </div>`;
    }

    const cards = this.reports.map(r => this.renderCard(r)).join('');

    return `
      <div class="page-header">
        <div class="page-title">Battle Reports</div>
        <div class="page-subtitle">click any report to expand</div>
      </div>
      <div class="content" style="overflow-y:auto;">
        <div style="padding:16px 24px;display:flex;flex-direction:column;gap:8px;">
          ${cards}
        </div>
      </div>`;
  }

  private renderCard(r: ReportRow): string {
    const unreadClass  = r.read ? '' : ' unread ' + outcomeUnreadClass(r.outcome);
    const rep = r.report ?? {} as ReportBody;

    const detail = this.renderDetail(rep, r.outcome);

    return `
      <div class="report-card${unreadClass}" data-action="toggle-report" data-report-id="${esc(r.id)}" data-unread="${r.read ? 'false' : 'true'}">
        <div class="report-header">
          <div class="report-icon">${reportIcon(r)}</div>
          <div class="report-summary">
            <div class="report-title">${esc(rep.zoneName ?? r.zone_id)} — ${esc((rep.assignment ?? '').toUpperCase())}</div>
            <div class="report-meta">
              <span>${esc(rep.encounter ?? '')}</span>
              <span>${fmtTime(r.created_at)}</span>
            </div>
            ${rep.net !== undefined ? `<div class="report-reward">
              Net: ${rep.net >= 0 ? '+' : ''}$${rep.net.toLocaleString()}
              · Income $${(rep.income ?? 0).toLocaleString()}
              · Repairs $${(rep.repairCost ?? 0).toLocaleString()}
              ${rep.influenceDelta ? `· <span style="color:${rep.influenceDelta > 0 ? 'var(--green)' : 'var(--red)'}">Territory ${rep.influenceDelta > 0 ? '+' : ''}${rep.influenceDelta} influence</span>` : ''}
            </div>` : ''}
          </div>
          <div class="report-outcome">
            <span class="outcome-badge ${outcomeClass(r.outcome)}">${outcomeLabel(r.outcome)}</span>
          </div>
        </div>
        <div class="report-detail">
          ${detail}
        </div>
      </div>`;
  }

  private renderDetail(rep: ReportBody, outcome: Outcome): string {
    const outcomeColor = outcome === 'success' || outcome === 'partial'
      ? 'var(--green)' : 'var(--red)';

    const crewRows = (rep.perDriver ?? []).map(d => {
      const statusClass = d.status === 'unharmed' ? '' : d.status === 'wounded' ? ' wounded' : ' dead';
      const kills = d.kills ? ` · ${d.kills} kill${d.kills !== 1 ? 's' : ''}` : '';
      return `<div class="report-crew-line${statusClass}">${esc(d.driverName)} — ${esc(d.status)}${kills}</div>`;
    }).join('');

    const vehicleRows = (rep.vehicles ?? []).map(v => {
      const repair = v.repairCost > 0 ? ` · repair $${v.repairCost.toLocaleString()}` : '';
      const color = v.damage === 'wrecked' ? 'color:var(--red)' : '';
      return `<div style="font-size:12px;color:#aaaaaa;padding:2px 0;${color}">${esc(v.name)} — ${esc(v.damage)}${repair}</div>`;
    }).join('');

    const rival = rep.rivalRepChange
      ? `<div style="font-size:12px;color:#ff88aa;margin-top:6px;">
           Rival: ${esc(rep.rivalRepChange.rivalName)} — grudge ${rep.rivalRepChange.delta >= 0 ? '+' : ''}${rep.rivalRepChange.delta}
         </div>`
      : '';

    return `
      <div style="font-size:13px;color:${outcomeColor};font-weight:bold;margin-bottom:8px;">
        ${esc(rep.summary ?? '')}
      </div>
      ${crewRows ? `<div style="margin-bottom:8px;"><div style="font-size:10px;color:var(--gray);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:4px;">Crew</div>${crewRows}</div>` : ''}
      ${vehicleRows ? `<div style="margin-bottom:6px;"><div style="font-size:10px;color:var(--gray);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:4px;">Vehicles</div>${vehicleRows}</div>` : ''}
      ${rival}`;
  }

  private onClick = (e: MouseEvent): void => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('[data-action="toggle-report"]');
    if (!card) return;

    card.classList.toggle('expanded');

    // Mark as read if it was unread
    if (card.dataset.unread === 'true') {
      card.dataset.unread = 'false';
      card.classList.remove('unread', 'victory', 'defeat', 'draw');

      const reportId = card.dataset.reportId!;
      const report = this.reports.find(r => r.id === reportId);
      if (report && !report.read) {
        report.read = true;
        this.unreadReports = Math.max(0, this.unreadReports - 1);
        // Update sidebar badge without full rebuild
        const badge = this.sidebarEl.querySelector<HTMLElement>('[data-nav="reports"] .nav-badge');
        if (this.unreadReports > 0 && badge) {
          badge.textContent = String(this.unreadReports);
        } else if (badge) {
          badge.remove();
        }
        const host = window.location.hostname;
        fetch(`http://${host}:3001/api/reports/${reportId}/read`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.token}` },
        }).catch(() => {});
      }
    }
  };
}
