import Phaser from 'phaser';
import { esc, renderInto, buildSidebarHTML, createHubRoot, wireNavigation, showToast, SidebarOpts } from '../ui/hub';

interface ActivityEntry {
  id: string;
  action_type: string;
  gang_name: string;
  settlement_name: string;
  description: string;
  read: boolean;
  resolved: boolean;
  created_at: string;
}

interface RivalEntry {
  id: string;
  gang_id: string;
  gang_name: string;
  primary_colour?: number;
  settlement_name: string;
  description: string;
  action_type: string;
  created_at: string;
}

interface Gang {
  id: string; name: string; primary_colour: number; treasury: number;
  reputation: number; division?: number; influence?: number;
}

function fmtTime(isoStr: string): string {
  try {
    const d = new Date(isoStr);
    const now = Date.now();
    const diff = now - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 2) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    if (hrs < 48) return 'Yesterday';
    return d.toLocaleDateString();
  } catch {
    return '';
  }
}

function dayLabel(isoStr: string): string {
  try {
    const d = new Date(isoStr);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Today';
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function actionIcon(actionType: string): string {
  switch (actionType) {
    case 'arena_win':      return '⚔';
    case 'arena_loss':     return '💥';
    case 'arena_draw':     return '🤝';
    case 'job_complete':   return '🚚';
    case 'zone_control':   return '🗺';
    case 'driver_xp':      return '📈';
    case 'repair':         return '🔧';
    case 'attack':         return '⚠';
    case 'defend':         return '🛡';
    case 'purchase':       return '🛒';
    default:               return '📋';
  }
}

export class ActivityScene extends Phaser.Scene {
  private token = '';
  private entries: ActivityEntry[] = [];
  private rivals: RivalEntry[] = [];
  private gang: Gang | null = null;
  private unreadReports = 0;
  private unreadActivity = 0;
  private root!: HTMLDivElement;
  private sidebarEl!: HTMLElement;
  private mainEl!: HTMLElement;

  constructor() { super({ key: 'ActivityScene' }); }

  init(data: { token: string }): void {
    this.token = data.token;
    this.entries = [];
    this.rivals = [];
  }

  async create(): Promise<void> {
    const host = window.location.hostname;
    const headers = { Authorization: `Bearer ${this.token}` };

    const [actRes, gangRes, repRes, actCountRes] = await Promise.all([
      fetch(`http://${host}:3001/api/territory/activity`, { headers }),
      fetch(`http://${host}:3001/api/gangs/mine`, { headers }),
      fetch(`http://${host}:3001/api/reports/unread-count`, { headers }),
      fetch(`http://${host}:3001/api/territory/activity/unread-count`, { headers }),
    ]);

    if (actRes.ok) {
      const body = await actRes.json();
      const all: ActivityEntry[] = body.entries ?? [];
      // Split: entries with gang_name are rival activity; entries without (player's own) are the timeline
      this.entries = all.filter(e => !e.gang_name || e.gang_name === this.gang?.name || e.action_type !== 'attack');
      this.rivals  = all.filter(e => e.gang_name && e.action_type === 'attack') as unknown as RivalEntry[];
    }
    if (gangRes.ok) this.gang = await gangRes.json();
    if (repRes.ok) this.unreadReports = (await repRes.json()).unread ?? 0;
    if (actCountRes.ok) this.unreadActivity = (await actCountRes.json()).unread ?? 0;

    // Re-fetch entries now that we have the gang name
    if (actRes.ok) {
      const body2Res = await fetch(`http://${host}:3001/api/territory/activity`, { headers });
      if (body2Res.ok) {
        const body2 = await body2Res.json();
        const all2: ActivityEntry[] = body2.entries ?? [];
        const myGangName = this.gang?.name ?? '';
        this.entries = all2.filter(e => !e.gang_name || e.gang_name === myGangName);
        this.rivals  = all2.filter(e => e.gang_name && e.gang_name !== myGangName) as unknown as RivalEntry[];
      }
    }

    // Mark all as read on load
    fetch(`http://${host}:3001/api/territory/activity/read-all`, {
      method: 'POST',
      headers,
    }).catch(() => {});

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
      activityBadge: 0, // cleared on load
      activeNav:     'activity',
      token:         this.token,
    };
    renderInto(this.sidebarEl, buildSidebarHTML(sidebarOpts));
    renderInto(this.mainEl, this.buildMainHTML());
    wireNavigation(this.root, this, this.token);
  }

  private buildMainHTML(): string {
    const unreadCount = this.entries.filter(e => !e.read).length;
    const awayBanner = unreadCount > 0 ? `
      <div class="away-banner">
        <div class="away-banner-title">&#9200; While You Were Away</div>
        <div class="away-banner-sub">${unreadCount} thing${unreadCount !== 1 ? 's' : ''} happened since your last visit</div>
      </div>` : '';

    const timeline = this.buildTimeline();
    const rivalFeed = this.buildRivalFeed();

    return `
      <div class="page-header">
        <div class="page-title">Activity</div>
        <div class="page-subtitle">Your gang's feed — battles, jobs, territory</div>
        <button class="btn btn-ghost" data-action="mark-all-read" style="margin-left:auto;font-size:11px;">Mark all read</button>
      </div>
      <div class="content" style="display:flex;overflow:hidden;">
        <div class="activity-col">
          ${awayBanner}
          ${timeline}
        </div>
        <div class="col-divider"></div>
        <div class="activity-col" style="max-width:340px;">
          ${rivalFeed}
        </div>
      </div>`;
  }

  private buildTimeline(): string {
    if (!this.entries.length) {
      return `<div style="color:var(--gray);font-size:13px;padding:20px 0;">No activity recorded yet.</div>`;
    }

    const rows: string[] = [];
    let lastDay = '';

    for (const e of this.entries) {
      const day = dayLabel(e.created_at);
      if (day !== lastDay) {
        rows.push(`<div class="tl-day">${esc(day)}</div>`);
        lastDay = day;
      }
      rows.push(`
        <div class="tl-item">
          <div class="tl-icon">${actionIcon(e.action_type)}</div>
          <div class="tl-body">
            <div class="tl-text">${esc(e.description)}</div>
            <div class="tl-time">${fmtTime(e.created_at)}</div>
          </div>
        </div>`);
    }

    return rows.join('');
  }

  private buildRivalFeed(): string {
    const header = `
      <div class="rival-heading">
        <span>Rival Activity</span>
        <span style="color:var(--dim)">last 24h</span>
      </div>`;

    if (!this.rivals.length) {
      return header + `<div style="color:var(--gray);font-size:12px;">No rival activity recorded.</div>`;
    }

    const cards = this.rivals.map(r => {
      const hexColor = r.primary_colour
        ? '#' + r.primary_colour.toString(16).padStart(6, '0')
        : '#888888';
      return `
        <div class="rival-card">
          <div class="rival-card-header">
            <span class="gang-swatch" style="background:${esc(hexColor)};width:8px;height:8px;"></span>
            <span class="rival-gang-name">${esc(r.gang_name)}</span>
            <span class="rival-time">${fmtTime(r.created_at)}</span>
          </div>
          <div class="rival-event">${esc(r.description)}</div>
        </div>`;
    }).join('');

    return header + cards;
  }

  private onClick = (e: MouseEvent): void => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!t) return;
    if (t.dataset.action === 'mark-all-read') {
      this.markAllRead();
    }
  };

  private markAllRead(): void {
    for (const e of this.entries) e.read = true;
    this.unreadActivity = 0;
    this.rebuild();
    showToast(this.root, 'All activity marked as read');
    const host = window.location.hostname;
    fetch(`http://${host}:3001/api/territory/activity/read-all`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
    }).catch(() => {});
  }
}
