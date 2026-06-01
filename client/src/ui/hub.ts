import Phaser from 'phaser';

export function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderInto(el: HTMLElement, html: string): void {
  el.textContent = '';
  el.appendChild(document.createRange().createContextualFragment(html));
}

export interface SidebarOpts {
  gangName: string;
  gangColor: number;
  emblemId?: number;
  treasury: number;
  reputation: number;
  division: number;
  influence: number;
  reportsBadge: number;
  activityBadge: number;
  activeNav: 'garage' | 'shop' | 'jobboard' | 'worldmap' | 'leaderboard' | 'reports' | 'activity';
  token: string;
}

export function buildSidebarHTML(o: SidebarOpts): string {
  const hexColor = '#' + o.gangColor.toString(16).padStart(6, '0');
  const initials = o.gangName.split(' ').map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase();

  const navItem = (id: string, icon: string, label: string, badge = 0): string =>
    `<a class="nav-item${o.activeNav === id ? ' active' : ''}" data-nav="${esc(id)}" href="#">
       <i class="nav-icon">${icon}</i> ${esc(label)}
       ${badge > 0 ? `<span class="nav-badge">${esc(badge)}</span>` : ''}
     </a>`;

  return `
    <div class="gang-block" data-action="gang-settings">
      <svg class="gang-emblem" viewBox="0 0 48 48" fill="none">
        <polygon points="24,4 44,14 44,34 24,44 4,34 4,14"
          fill="${esc(hexColor)}22" stroke="${esc(hexColor)}" stroke-width="1.5"/>
        <text x="24" y="28" text-anchor="middle" fill="${esc(hexColor)}"
          font-family="monospace" font-size="14" font-weight="bold">${esc(initials)}</text>
      </svg>
      <div class="gang-name">${esc(o.gangName)}</div>
      <div class="gang-stats">
        <div class="stat-row">
          <span class="stat-label">Treasury</span>
          <span class="stat-val-yellow">$${esc(o.treasury.toLocaleString())}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Reputation</span>
          <span class="stat-val-green">${esc(o.reputation)}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Division</span>
          <span class="stat-val-red">Div ${esc(o.division)}</span>
        </div>
        ${o.influence > 0 ? `
        <div class="stat-row">
          <span class="stat-label">Influence</span>
          <span class="stat-val-yellow">${esc(o.influence)} pts</span>
        </div>` : ''}
      </div>
    </div>
    <div class="nav-links">
      <div class="nav-section">Headquarters</div>
      ${navItem('garage',      '⚙', 'Garage')}
      ${navItem('shop',        '🛒', 'Shop')}
      ${navItem('jobboard',    '📋', 'Job Board')}
      <div class="nav-section">Territory</div>
      ${navItem('worldmap',    '🗺', 'World Map')}
      ${navItem('leaderboard', '🏆', 'Leaderboard')}
      <div class="nav-section">Records</div>
      ${navItem('reports',     '📄', 'Reports',  o.reportsBadge)}
      ${navItem('activity',    '📡', 'Activity', o.activityBadge)}
    </div>
    <div class="sidebar-footer">
      <button class="logout-btn" data-action="logout">⏏ Logout</button>
    </div>`;
}

// If any API response came back 401 the saved token is stale or invalid —
// clear it and return to the login screen so the player can sign in again.
// Returns true when the redirect happened; callers should bail out of scene setup.
export function redirectIfUnauthorized(scene: Phaser.Scene, responses: Response[]): boolean {
  if (!responses.some(r => r.status === 401)) return false;
  localStorage.removeItem('cw_token');
  scene.scene.start('LoginScene');
  return true;
}

export function createHubRoot(scene: Phaser.Scene): HTMLDivElement {
  const root = document.createElement('div');
  root.className = 'shell';
  root.style.cssText = 'position:fixed;inset:0;z-index:50;display:flex;';
  document.body.appendChild(root);
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => root.remove());
  return root;
}

export function showToast(root: HTMLElement, message: string): void {
  let toast = root.querySelector<HTMLElement>('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    root.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  const t = toast;
  setTimeout(() => t.classList.remove('show'), 2200);
}

export function wireNavigation(root: HTMLElement, scene: Phaser.Scene, token: string): void {
  const NAV_SCENES: Record<string, string> = {
    garage:      'GarageScene',
    shop:        'ShopScene',
    jobboard:    'JobBoardScene',
    worldmap:    'WorldMapScene',
    leaderboard: 'LeaderboardScene',
    reports:     'ReportScene',
    activity:    'ActivityScene',
  };
  root.querySelector('.sidebar')?.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('[data-nav]');
    if (!item) return;
    e.preventDefault();
    const sceneName = NAV_SCENES[item.dataset.nav!];
    if (sceneName) scene.scene.start(sceneName, { token });
  });
  root.querySelector('.logout-btn')?.addEventListener('click', () => {
    localStorage.removeItem('cw_token');
    scene.scene.start('LoginScene');
  });
}
