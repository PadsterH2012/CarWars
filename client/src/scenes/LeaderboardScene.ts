import Phaser from 'phaser';
import { esc, renderInto, buildSidebarHTML, createHubRoot, wireNavigation, showToast, SidebarOpts } from '../ui/hub';

interface LeaderboardEntry {
  rank: number;
  gangId: string;
  gangName: string;
  primaryColour: number;
  isPlayer: boolean;
  totalInfluence: number;
  settlementCount: number;
}

interface LeaderboardData {
  entries: LeaderboardEntry[];
  playerRank: number;
  totalGangs: number;
  endgame: boolean;
  retired: boolean;
  retireBonus: number;
}

interface Gang {
  id: string; name: string; primary_colour: number; treasury: number;
  reputation: number; division?: number; influence?: number;
}

export class LeaderboardScene extends Phaser.Scene {
  private token = '';
  private data_: LeaderboardData | null = null;
  private gang: Gang | null = null;
  private unreadReports = 0;
  private unreadActivity = 0;
  private retiring = false;
  private root!: HTMLDivElement;
  private sidebarEl!: HTMLElement;
  private mainEl!: HTMLElement;

  constructor() { super({ key: 'LeaderboardScene' }); }

  init(data: { token: string }): void {
    this.token = data.token;
    this.data_ = null;
    this.retiring = false;
  }

  async create(): Promise<void> {
    const host = window.location.hostname;
    const headers = { Authorization: `Bearer ${this.token}` };

    const [lbRes, gangRes, repRes, actRes] = await Promise.all([
      fetch(`http://${host}:3001/api/leaderboard`, { headers }),
      fetch(`http://${host}:3001/api/gangs/mine`, { headers }),
      fetch(`http://${host}:3001/api/reports/unread-count`, { headers }),
      fetch(`http://${host}:3001/api/territory/activity/unread-count`, { headers }),
    ]);

    if (lbRes.ok) this.data_ = await lbRes.json();
    if (gangRes.ok) this.gang = await gangRes.json();
    if (repRes.ok) this.unreadReports = (await repRes.json()).unread ?? 0;
    if (actRes.ok) this.unreadActivity = (await actRes.json()).unread ?? 0;

    this.root = createHubRoot(this);

    this.sidebarEl = document.createElement('nav');
    this.sidebarEl.className = 'sidebar';

    this.mainEl = document.createElement('div');
    this.mainEl.className = 'main';

    this.root.appendChild(this.sidebarEl);
    this.root.appendChild(this.mainEl);

    this.rebuild();
    this.root.appendChild(this.buildRetireModal());
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
      activeNav:     'leaderboard',
      token:         this.token,
    };
    renderInto(this.sidebarEl, buildSidebarHTML(sidebarOpts));
    renderInto(this.mainEl, this.buildMainHTML());
    wireNavigation(this.root, this, this.token);
  }

  private buildMainHTML(): string {
    const d = this.data_;

    const tableBody = d
      ? d.entries.map(e => {
          const hexColor = '#' + e.primaryColour.toString(16).padStart(6, '0');
          const playerClass = e.isPlayer ? ' player-row' : '';
          return `
            <tr class="${playerClass}">
              <td class="rank">#${esc(e.rank)}</td>
              <td>
                <span class="gang-swatch" style="background:${esc(hexColor)};margin-right:8px;vertical-align:middle;"></span>
                ${esc(e.gangName)}
              </td>
              <td class="pts">${esc(e.totalInfluence.toLocaleString())}</td>
              <td class="zones">${esc(e.settlementCount)}</td>
            </tr>`;
        }).join('')
      : `<tr><td colspan="4" style="padding:32px;text-align:center;color:var(--gray)">Loading…</td></tr>`;

    const endgameBanner = (d?.endgame && !d?.retired) ? `
      <div class="endgame-banner">
        <div>
          <div class="endgame-text">★ YOU ARE THE DOMINANT POWER IN THE REGION ★</div>
          <div class="endgame-sub">You control more territory than any other gang.</div>
        </div>
        <button class="btn btn-gold" data-action="retire" ${this.retiring ? 'disabled' : ''}>
          ${this.retiring ? 'Retiring…' : 'Retire Your Gang'}
        </button>
      </div>` : (d?.retired ? `
      <div class="endgame-banner">
        <div>
          <div class="endgame-text">RETIRED</div>
          <div class="endgame-sub">Bonus $${(d.retireBonus ?? 0).toLocaleString()} credited to treasury</div>
        </div>
      </div>` : '');

    const playerRankFooter = (d && d.playerRank > 20) ? `
      <div style="padding:12px 24px;border-top:1px solid var(--border);font-size:13px;color:var(--gold);">
        Your rank: #${esc(d.playerRank)} of ${esc(d.totalGangs)} gangs
      </div>` : (d ? `
      <div style="padding:12px 24px;border-top:1px solid var(--border);font-size:12px;color:var(--gray);">
        ${esc(d.totalGangs)} gangs total
      </div>` : '');

    return `
      <div class="page-header">
        <div class="page-title">Territory Leaderboard</div>
        <div class="page-subtitle">Ranked by total influence across all zones</div>
      </div>
      <div class="content" style="display:flex;flex-direction:column;overflow:hidden;">
        <div style="flex:1;overflow-y:auto;padding:16px 24px;">
          ${endgameBanner}
          <table class="lb-table">
            <thead>
              <tr>
                <th style="width:50px;text-align:center;">Rank</th>
                <th>Gang</th>
                <th class="r">Influence</th>
                <th class="r">Zones</th>
              </tr>
            </thead>
            <tbody>
              ${tableBody}
            </tbody>
          </table>
        </div>
        ${playerRankFooter}
      </div>`;
  }

  private buildRetireModal(): HTMLElement {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'modal-retire-confirm';
    const d = this.data_;
    const bonusPreview = d ? `$${(d.retireBonus ?? 0).toLocaleString()}` : 'a bonus';
    renderInto(overlay, `
      <div class="modal">
        <div class="modal-title">★ Retire Your Gang</div>
        <div class="modal-body">
          <p>You are the dominant power in the region. Retiring locks in your victory and awards ${bonusPreview} to your treasury.</p>
          <p style="color:var(--red);font-size:12px;margin-top:8px;">This action is irreversible.</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" data-action="close-modal">Not Yet</button>
          <button class="btn btn-gold" data-action="confirm-retire">★ Confirm Retirement</button>
        </div>
      </div>`);
    return overlay;
  }

  private openRetireModal(): void {
    const overlay = this.root.querySelector<HTMLElement>('#modal-retire-confirm');
    overlay?.classList.add('open');
  }

  private closeRetireModal(): void {
    const overlay = this.root.querySelector<HTMLElement>('#modal-retire-confirm');
    overlay?.classList.remove('open');
  }

  private onClick = (e: MouseEvent): void => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!t) return;
    const action = t.dataset.action;
    if (action === 'retire') {
      this.openRetireModal();
    } else if (action === 'close-modal') {
      this.closeRetireModal();
    } else if (action === 'confirm-retire') {
      this.closeRetireModal();
      this.doRetire();
    }
    // Close modal on overlay click
    const overlay = this.root.querySelector('#modal-retire-confirm');
    if (overlay && e.target === overlay) {
      this.closeRetireModal();
    }
  };

  private async doRetire(): Promise<void> {
    if (this.retiring) return;
    this.retiring = true;
    this.rebuild();

    const host = window.location.hostname;
    try {
      const res = await fetch(`http://${host}:3001/api/leaderboard/retire`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (res.ok) {
        const { bonus } = await res.json();
        if (this.data_) {
          this.data_.retired    = true;
          this.data_.retireBonus = bonus;
          this.data_.endgame    = false;
        }
        this.retiring = false;
        this.rebuild();
        showToast(this.root, `Gang retired — $${(bonus ?? 0).toLocaleString()} bonus credited`);
      } else {
        this.retiring = false;
        this.rebuild();
        showToast(this.root, 'Retire failed — try again');
      }
    } catch {
      this.retiring = false;
      this.rebuild();
      showToast(this.root, 'Network error');
    }
  }
}
