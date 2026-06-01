# Hub UI Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace all hub screens (Garage, Job Board, Leaderboard, Reports, Town, World Map panels) with responsive HTML/CSS overlays, and add a new Activity scene — keeping the arena/combat gameplay in Phaser.

**Architecture:** Each hub scene follows the pattern already established by `ShopScene.ts`: a full-screen `HTMLDivElement` appended to `document.body` in `create()`, auto-removed on Phaser's `SHUTDOWN` event, populated via a safe `renderInto()` helper, with all user interaction wired via a single event-delegated click handler on the root. A shared CSS file (`hub.css`) and utility module (`hub.ts`) eliminate sidebar duplication across scenes. The Phaser canvas stays active underneath for scenes that need it (WorldMapScene renders its SVG map there; ArenaScene stays entirely Phaser).

**Tech Stack:** TypeScript, Phaser 3, Vite, plain HTML/CSS (no framework), existing REST API on port 3001.

**Design reference:** `docs/mockups/` — interactive HTML mockups. All visual decisions (colours, spacing, component structure) are already validated there. When in doubt, open the matching `.html` file.

---

## Context You Must Know

- **ShopScene is the gold-standard pattern.** Read `client/src/scenes/ShopScene.ts` in full before starting any task. Every hub scene must follow its exact structure.
- **API base URL:** `http://${window.location.hostname}:3001`
- **Auth:** every fetch needs `headers: { Authorization: 'Bearer ' + this.token }`
- **Token flow:** passed via `this.scene.start('SceneName', { token: this.token })`; received in `init(data)`.
- **Safe HTML — CRITICAL:** Never use `innerHTML` to inject content. Always use `renderInto()` (which uses `createContextualFragment`) for HTML, and `textContent` for plain text clearing. Every dynamic value in a template literal must be wrapped in `esc()`. Violating this introduces XSS.
- **Cleanup:** `this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.root.remove())` — that single line is the entire cleanup.
- **Build:** `npm -w @carwars/client run build` — TypeScript then Vite. Dev server on port 3000.
- **Tests:** `npm -w @carwars/server run test` — server-side only. No existing client tests.

---

## Phase 1 — Shared Infrastructure

### Task 1: Shared Hub CSS

**Files:**
- Create: `client/src/ui/hub.css`
- Modify: `client/src/main.ts` (add one import line)

**Step 1: Create `client/src/ui/hub.css`**

Copy the full contents of `docs/mockups/shared.css` verbatim into `client/src/ui/hub.css`. This is already validated in the browser — do not change values without testing.

Key classes defined (reference for all subsequent tasks):
```
.cw-shell, .cw-sidebar, .cw-gang-block, .cw-nav-item, .cw-nav-item.active,
.cw-nav-badge, .cw-main, .cw-page-header, .cw-content,
.btn, .btn-green, .btn-red, .btn-yellow, .btn-blue, .btn-gold, .btn-ghost,
.modal-overlay, .modal-overlay.open, .modal, .modal-title, .modal-footer,
.dot, .dot-green, .dot-yellow, .dot-red, .dot-amber, .dot-gray, .dot-dim,
.toast, .toast.show
```

Prefix all class names with `cw-` EXCEPT the utility classes (`btn`, `modal-overlay`, `modal`, `dot`, `toast`) which are already namespaced by context. This avoids conflicts with any Phaser or third-party CSS.

**Step 2: Import in main.ts**

```typescript
// client/src/main.ts — add at top, before scene imports
import './ui/hub.css';
```

**Step 3: Verify build picks it up**

```bash
npm -w @carwars/client run build
```
Expected: build succeeds, no CSS errors.

**Step 4: Commit**
```bash
git add client/src/ui/hub.css client/src/main.ts
git commit -m "feat(ui): add shared hub CSS"
```

---

### Task 2: Shared Hub Utilities

**Files:**
- Create: `client/src/ui/hub.ts`
- Create: `client/src/ui/hub.test.ts`

**Step 1: Write failing tests**

```typescript
// client/src/ui/hub.test.ts
import { esc, renderInto, buildSidebarHTML } from './hub';

describe('esc', () => {
  it('escapes HTML special chars', () => {
    expect(esc('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });
  it('converts non-strings', () => {
    expect(esc(42)).toBe('42');
  });
});

describe('renderInto', () => {
  it('clears existing content before rendering', () => {
    const el = document.createElement('div');
    el.textContent = 'old';
    renderInto(el, '<span>new</span>');
    expect(el.querySelector('span')?.textContent).toBe('new');
    expect(el.textContent).toBe('new');
  });
});

describe('buildSidebarHTML', () => {
  it('marks the active nav item', () => {
    const html = buildSidebarHTML({ gangName: 'Test', treasury: 1000,
      reputation: 5, division: 1, influence: 0,
      reportsBadge: 0, activityBadge: 0, activeNav: 'garage', token: 'tok' });
    expect(html).toContain('active');
    expect(html).toContain('Test');
    expect(html).toContain('$1,000');
  });
});
```

**Step 2: Run tests to confirm they fail**
```bash
cd /Users/paddyharker/carwars && npx vitest run client/src/ui/hub.test.ts 2>&1 | head -20
```
Expected: FAIL — module not found.

**Step 3: Implement `client/src/ui/hub.ts`**

```typescript
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
  gangColor: number;     // Phaser hex colour e.g. 0xff4444
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
  const initials = o.gangName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const navItem = (id: string, icon: string, label: string, badge = 0) =>
    `<a class="cw-nav-item${o.activeNav === id ? ' active' : ''}"
        data-nav="${esc(id)}" href="#">
       <i class="cw-nav-icon">${icon}</i> ${esc(label)}
       ${badge > 0 ? `<span class="cw-nav-badge">${badge}</span>` : ''}
     </a>`;

  return `
    <div class="cw-gang-block" data-action="gang-settings">
      <svg class="cw-gang-emblem" viewBox="0 0 48 48" fill="none">
        <polygon points="24,4 44,14 44,34 24,44 4,34 4,14"
          fill="${hexColor}22" stroke="${hexColor}" stroke-width="1.5"/>
        <text x="24" y="28" text-anchor="middle" fill="${hexColor}"
          font-family="monospace" font-size="14" font-weight="bold">${esc(initials)}</text>
      </svg>
      <div class="cw-gang-name">${esc(o.gangName)}</div>
      <div class="cw-gang-stats">
        <div class="cw-stat-row"><span class="cw-stat-label">Treasury</span>
          <span class="cw-stat-val-yellow">$${o.treasury.toLocaleString()}</span></div>
        <div class="cw-stat-row"><span class="cw-stat-label">Reputation</span>
          <span class="cw-stat-val-green">${esc(o.reputation)}</span></div>
        <div class="cw-stat-row"><span class="cw-stat-label">Division</span>
          <span class="cw-stat-val-red">Div ${esc(o.division)}</span></div>
        ${o.influence > 0
          ? `<div class="cw-stat-row"><span class="cw-stat-label">Influence</span>
             <span class="cw-stat-val-yellow">${esc(o.influence)} pts</span></div>`
          : ''}
      </div>
    </div>
    <div class="cw-nav-links">
      <div class="cw-nav-section">Headquarters</div>
      ${navItem('garage',      '⚙', 'Garage')}
      ${navItem('shop',        '🛒', 'Shop')}
      ${navItem('jobboard',    '📋', 'Job Board')}
      <div class="cw-nav-section">Territory</div>
      ${navItem('worldmap',    '🗺', 'World Map')}
      ${navItem('leaderboard', '🏆', 'Leaderboard')}
      <div class="cw-nav-section">Records</div>
      ${navItem('reports',     '📄', 'Reports',  o.reportsBadge)}
      ${navItem('activity',    '📡', 'Activity', o.activityBadge)}
    </div>
    <div class="cw-sidebar-footer">
      <button class="cw-logout-btn" data-action="logout">⏏ Logout</button>
    </div>`;
}

/** Create the full-screen root div used by all hub scenes. */
export function createHubRoot(scene: { events: Phaser.Events.EventEmitter }): HTMLDivElement {
  const root = document.createElement('div');
  root.className = 'cw-shell';
  root.style.cssText = 'position:fixed;inset:0;z-index:50;display:flex;';
  document.body.appendChild(root);
  scene.events.once('shutdown', () => root.remove());
  return root;
}

/** Show a brief toast message inside a hub root element. */
export function showToast(root: HTMLElement, message: string): void {
  let toast = root.querySelector<HTMLDivElement>('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    root.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast!.classList.remove('show'), 2200);
}

/** Wire sidebar nav clicks to scene transitions. */
export function wireNavigation(
  root: HTMLElement,
  scene: Phaser.Scene,
  token: string
): void {
  const NAV_SCENES: Record<string, string> = {
    garage:      'GarageScene',
    shop:        'ShopScene',
    jobboard:    'JobBoardScene',
    worldmap:    'WorldMapScene',
    leaderboard: 'LeaderboardScene',
    reports:     'ReportScene',
    activity:    'ActivityScene',
  };
  root.querySelector('.cw-sidebar')?.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('[data-nav]');
    if (!item) return;
    e.preventDefault();
    const sceneName = NAV_SCENES[item.dataset.nav!];
    if (sceneName) scene.scene.start(sceneName, { token });
    if (item.dataset.action === 'logout') {
      localStorage.removeItem('cw_token');
      scene.scene.start('LoginScene');
    }
  });
}
```

**Step 4: Run tests**
```bash
cd /Users/paddyharker/carwars && npx vitest run client/src/ui/hub.test.ts
```
Expected: 4 tests pass.

Note: if vitest isn't configured for the client package, add it or run the tests manually in browser console. If client tests aren't runnable, skip to Step 5.

**Step 5: Commit**
```bash
git add client/src/ui/hub.ts client/src/ui/hub.test.ts
git commit -m "feat(ui): add shared hub utilities — esc, renderInto, buildSidebar"
```

---

## Phase 2 — GarageScene Migration

This is the largest migration. Work through Tasks 3–7 in order. Do not skip ahead — each task builds on the previous.

### Task 3: GarageScene — DOM Scaffold

**Files:**
- Modify: `client/src/scenes/GarageScene.ts`

**Goal:** Replace the entire Phaser-rendered `renderGarage()` method with a DOM overlay root. After this task the screen will show the sidebar and layout skeleton but no vehicle data yet.

**Step 1: Add imports at top of GarageScene.ts**
```typescript
import { esc, renderInto, buildSidebarHTML, createHubRoot, wireNavigation, showToast, SidebarOpts } from '../ui/hub';
```

**Step 2: Add instance fields**
```typescript
private root!: HTMLDivElement;
private sidebarEl!: HTMLElement;
private vehiclePanelEl!: HTMLElement;
private crewPanelEl!: HTMLElement;
```

**Step 3: Replace `create()` body**

Remove all Phaser object creation from `create()`. The new structure:

```typescript
async create(): Promise<void> {
  // Fetch all data (keep existing parallel fetch block unchanged)
  await Promise.all([...existing fetches...]);

  // Build DOM overlay
  this.root = createHubRoot(this);
  this.buildLayout();
  wireNavigation(this.root, this, this.token);
  this.root.addEventListener('click', this.onClick.bind(this));
}
```

**Step 4: Add `buildLayout()`**

```typescript
private buildLayout(): void {
  const sidebar = document.createElement('nav');
  sidebar.className = 'cw-sidebar';
  this.sidebarEl = sidebar;

  const main = document.createElement('div');
  main.className = 'cw-main';

  this.root.appendChild(sidebar);
  this.root.appendChild(main);

  this.rebuildSidebar();
  this.rebuildMain(main);
}
```

**Step 5: Add `rebuildSidebar()`**

```typescript
private rebuildSidebar(): void {
  const opts: SidebarOpts = {
    gangName:       this.gang?.name ?? '',
    gangColor:      this.gang?.primary_colour ?? 0xff4444,
    emblemId:       this.gang?.emblem_id,
    treasury:       this.money,
    reputation:     this.gang?.reputation ?? 0,
    division:       this.division,
    influence:      this.gang?.influence ?? 0,
    reportsBadge:   this.unreadReports,
    activityBadge:  this.unreadActivity,
    activeNav:      'garage',
    token:          this.token,
  };
  renderInto(this.sidebarEl, buildSidebarHTML(opts));
}
```

**Step 6: Add `rebuildMain()` stub (fills in later tasks)**
```typescript
private rebuildMain(container: HTMLElement): void {
  // Use renderInto (never innerHTML) — replaced with full implementation in Task 4
  renderInto(container, '<p style="color:#555;padding:24px;font-family:monospace">Loading vehicles...</p>');
}
```

**Step 7: Remove `renderGarage()` and `onLayout()` wiring**

Delete the existing `renderGarage()` method and the `onLayout(this, () => this.renderGarage())` call. HTML reflows automatically.

**Step 8: Manual verify**

Start dev server: `npm -w @carwars/client run dev`
Load the game, login, reach Garage. Expected: sidebar visible with gang name and nav links, main area shows "Loading vehicles..." placeholder. Nav links should navigate to other scenes (Shop confirmed working if it was already working).

**Step 9: Commit**
```bash
git add client/src/scenes/GarageScene.ts
git commit -m "feat(garage): scaffold DOM overlay — sidebar + layout shell"
```

---

### Task 4: GarageScene — Vehicle List

**Files:**
- Modify: `client/src/scenes/GarageScene.ts`

**Goal:** Render vehicle cards in the left panel with full UI (name, stats, driver info, action buttons). Selection state is visual only — buttons don't call APIs yet (wired in Task 7).

**Step 1: Replace `rebuildMain()` with the full vehicle panel**

```typescript
private rebuildMain(container: HTMLElement): void {
  // renderInto clears the container safely then injects — never use innerHTML directly
  renderInto(container, `
    <div class="cw-topbar">
      ${this.buildArenaTabsHTML()}
    </div>
    <div class="cw-content">
      <div class="cw-vehicle-panel" id="cw-vehicle-panel">
        ${this.buildVehicleListHTML()}
      </div>
      <div class="cw-crew-panel" id="cw-crew-panel">
        ${this.buildCrewPanelHTML()}
      </div>
    </div>
  `);
}
```

**Step 2: Add `buildVehicleListHTML()`**

```typescript
private buildVehicleListHTML(): string {
  const cards = this.vehicles.map(v => {
    const driver = this.drivers.find(d => d.vehicle_id === v.id);
    const isSelected = v.id === this.selectedVehicleId;
    const armorPct = v.armour / v.max_armour;
    const nameColor = armorPct > 0.6 ? 'vn-green' : armorPct > 0.2 ? 'vn-yellow' : 'vn-red';
    const canFight = !!driver && v.armour > 0;

    return `
      <div class="cw-vehicle-card${isSelected ? ' selected' : ''}" data-vehicle-id="${esc(v.id)}">
        <div class="cw-vehicle-thumb">
          <span class="dot ${armorPct > 0.5 ? 'dot-green' : armorPct > 0.2 ? 'dot-yellow' : 'dot-red'}"
                style="position:absolute;top:4px;right:4px"></span>
        </div>
        <div class="cw-vehicle-info">
          <div class="cw-vehicle-name ${nameColor}">${esc(v.name)}</div>
          <div class="cw-vehicle-meta">
            <span>Value <span class="val">$${v.value.toLocaleString()}</span></span>
            <span>Div <span class="val">${esc(v.division)}</span></span>
            <span>Armor <span class="val">${esc(v.armour)}/${esc(v.max_armour)}</span></span>
          </div>
          <div class="cw-vehicle-driver${driver ? '' : ' unassigned'}">
            ${driver
              ? `<span class="dot dot-green"></span> ${esc(driver.name)} · Refl ${esc(driver.reflexes)} · Guns ${esc(driver.gunnery)}`
              : '— No driver assigned'}
          </div>
          <div class="cw-vehicle-weapons">${esc(v.loadout_summary ?? '')}</div>
          <div class="cw-vehicle-actions">
            <button class="btn btn-red"
              ${canFight ? '' : 'disabled'}
              data-action="fight" data-vehicle-id="${esc(v.id)}">⚔ Fight</button>
            ${v.armour < v.max_armour
              ? `<button class="btn btn-yellow" data-action="repair"
                   data-vehicle-id="${esc(v.id)}">🔧 Repair</button>` : ''}
            <button class="btn btn-blue" data-action="workshop"
              data-vehicle-id="${esc(v.id)}">🔩 Workshop</button>
            <button class="btn" data-action="sell"
              data-vehicle-id="${esc(v.id)}">💰 Sell</button>
          </div>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="cw-panel-heading">
      <span>Vehicles (${esc(this.vehicles.length)})</span>
      <button class="btn btn-green" data-action="build-new" style="font-size:11px;padding:4px 10px">+ Build New</button>
    </div>
    ${cards || '<p style="color:var(--gray);padding:16px;font-size:13px">No vehicles — buy one from the Shop.</p>'}`;
}
```

**Step 3: Add vehicle selection click handler stub**

In `onClick(e: MouseEvent)`:
```typescript
private onClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const card = target.closest<HTMLElement>('.cw-vehicle-card');
  if (card && !target.closest('button')) {
    this.selectedVehicleId = Number(card.dataset.vehicleId);
    this.rebuildVehiclePanel(); // re-render cards to update .selected class
    return;
  }
  // action buttons handled in Task 7
}

private rebuildVehiclePanel(): void {
  const el = this.root.querySelector('#cw-vehicle-panel');
  if (el) renderInto(el as HTMLElement, this.buildVehicleListHTML());
}
```

**Step 4: Manual verify**

Load Garage. Expected: vehicle cards visible with name, stats, driver info, buttons. Clicking a card highlights it. Buttons visible (Fight disabled if no driver).

**Step 5: Commit**
```bash
git add client/src/scenes/GarageScene.ts
git commit -m "feat(garage): render vehicle list as HTML cards"
```

---

### Task 5: GarageScene — Crew Panel + Arena Topbar

**Files:**
- Modify: `client/src/scenes/GarageScene.ts`

**Step 1: Add `buildCrewPanelHTML()`**

```typescript
private buildCrewPanelHTML(): string {
  const driverRows = this.drivers.map(d => {
    const status = d.vehicle_id
      ? this.vehicles.find(v => v.id === d.vehicle_id)?.name ?? 'Assigned'
      : d.on_mission ? 'On Mission' : 'Available';
    const dotClass = d.vehicle_id ? 'dot-yellow' : d.on_mission ? 'dot-amber' : 'dot-dim';
    const statusColor = d.vehicle_id ? 'var(--amber)' : d.on_mission ? 'var(--amber)' : 'var(--green)';

    return `
      <div class="cw-driver-row" data-action="driver-card" data-driver-id="${esc(d.id)}">
        <span class="dot ${dotClass}"></span>
        <div class="cw-driver-name">${esc(d.name)}</div>
        <div class="cw-driver-meta">
          <span style="color:${statusColor};font-size:10px">${esc(status)}</span>
          <span style="color:var(--dim);font-size:10px">Refl ${esc(d.reflexes)} · Guns ${esc(d.gunnery)}</span>
        </div>
      </div>
      <div class="cw-driver-skills">${esc(d.skills?.join(' · ') ?? '—')}</div>`;
  }).join('');

  const deploymentRows = (this.deployments ?? []).slice(0, 4).map(dep =>
    `<div class="cw-deployment-row">
       <span>${esc(dep.zone_name ?? 'Unknown zone')}</span>
       <span class="cw-eta">${esc(dep.eta_label ?? '?')}</span>
     </div>`
  ).join('');

  return `
    <div class="cw-crew-header">
      <span class="cw-crew-title">Crew (${esc(this.drivers.length)})</span>
      <button class="btn btn-green" data-action="hire"
              style="font-size:11px;padding:4px 8px">+ Hire</button>
    </div>
    <div class="cw-driver-list">${driverRows}</div>
    ${deploymentRows ? `
      <div class="cw-deployments-section">
        <div class="cw-deployments-title">Active Deployments</div>
        ${deploymentRows}
      </div>` : ''}`;
}
```

**Step 2: Add `buildArenaTabsHTML()`**

```typescript
private buildArenaTabsHTML(): string {
  const maps = ['Truck Stop', 'Town Square', 'Open Arena', 'Double Drum'];
  const tabs = maps.map(m =>
    `<button class="cw-arena-tab${m === (this.selectedMap ?? maps[0]) ? ' active' : ''}"
             data-action="select-map" data-map="${esc(m)}">${esc(m)}</button>`
  ).join('');

  return `
    <span class="cw-topbar-label">Arena</span>
    <div class="cw-arena-tabs">${tabs}</div>
    <div class="cw-map-btns" style="margin-left:auto">
      <button class="btn btn-ghost" data-action="view-map"
              style="font-size:11px;padding:4px 9px">View Map</button>
      <button class="btn btn-ghost" data-action="edit-map"
              style="font-size:11px;padding:4px 9px">Edit Map</button>
    </div>`;
}
```

**Step 3: Add arena tab and map button handling to `onClick()`**

```typescript
const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
switch (action) {
  case 'select-map': {
    const map = target.closest<HTMLElement>('[data-map]')?.dataset.map ?? '';
    this.selectedMap = map;
    localStorage.setItem('cw_selected_map', map);
    this.rebuildTopbar();
    break;
  }
  case 'view-map':
    this.scene.start('MapViewerScene', { token: this.token });
    break;
  case 'edit-map':
    this.scene.start('MapEditorScene', { token: this.token });
    break;
}
```

**Step 4: Manual verify**

Crew panel shows drivers with status dots. Arena tabs click to switch. Map buttons navigate.

**Step 5: Commit**
```bash
git add client/src/scenes/GarageScene.ts
git commit -m "feat(garage): crew panel, arena tabs, map buttons"
```

---

### Task 6: GarageScene — All Modals

**Files:**
- Modify: `client/src/scenes/GarageScene.ts`

The modals live inside the root div and are toggled with `modal-overlay.open`. Add a `buildModalsHTML()` call inside `buildLayout()` and append to root.

**Step 1: Add `buildModalsHTML()` and call from `buildLayout()`**

Each modal follows this shape:
```typescript
private buildModalsHTML(): string {
  return `
    <!-- FIGHT / SQUAD PICKER -->
    <div class="modal-overlay" id="cw-modal-fight">
      <div class="modal">
        <div class="modal-title">⚔ Select Squad — <span id="cw-fight-vname"></span></div>
        <div class="modal-body" id="cw-squad-list"></div>
        <div class="modal-footer">
          <button class="btn btn-ghost" data-action="close-modal" data-modal="cw-modal-fight">Cancel</button>
          <button class="btn btn-red" data-action="enter-arena">⚔ Enter Arena</button>
        </div>
      </div>
    </div>

    <!-- REPAIR -->
    <div class="modal-overlay" id="cw-modal-repair">
      <div class="modal">
        <div class="modal-title">🔧 Repair Vehicle</div>
        <div class="modal-body" id="cw-repair-body"></div>
        <div class="modal-footer">
          <button class="btn btn-ghost" data-action="close-modal" data-modal="cw-modal-repair">Cancel</button>
          <button class="btn btn-yellow" data-action="confirm-repair">🔧 Confirm Repair</button>
        </div>
      </div>
    </div>

    <!-- SELL -->
    <div class="modal-overlay" id="cw-modal-sell">
      <div class="modal">
        <div class="modal-title">💰 Sell Vehicle</div>
        <div class="modal-body" id="cw-sell-body"></div>
        <div class="modal-footer">
          <button class="btn btn-ghost" data-action="close-modal" data-modal="cw-modal-sell">Cancel</button>
          <button class="btn btn-red" data-action="confirm-sell">💰 Confirm Sale</button>
        </div>
      </div>
    </div>

    <!-- DRIVER CARD -->
    <div class="modal-overlay" id="cw-modal-driver">
      <div class="modal">
        <div class="modal-title" id="cw-driver-modal-title">Driver</div>
        <div class="modal-body" id="cw-driver-modal-body"></div>
        <div class="modal-footer">
          <button class="btn btn-ghost" data-action="close-modal" data-modal="cw-modal-driver">Close</button>
          <button class="btn btn-blue" data-action="upgrade-skill">↑ Upgrade Skill</button>
        </div>
      </div>
    </div>

    <!-- HIRE -->
    <div class="modal-overlay" id="cw-modal-hire">
      <div class="modal">
        <div class="modal-title">Hire Drivers</div>
        <div class="modal-body" id="cw-hire-body">Loading...</div>
        <div class="modal-footer">
          <button class="btn btn-ghost" data-action="close-modal" data-modal="cw-modal-hire">Close</button>
        </div>
      </div>
    </div>

    <!-- GANG SETTINGS -->
    <div class="modal-overlay" id="cw-modal-gang">
      <div class="modal">
        <div class="modal-title">⚙ Gang Settings</div>
        <div class="modal-body" id="cw-gang-modal-body"></div>
        <div class="modal-footer">
          <button class="btn btn-ghost" data-action="close-modal" data-modal="cw-modal-gang">Cancel</button>
          <button class="btn btn-green" data-action="save-gang">Save</button>
        </div>
      </div>
    </div>`;
}
```

**Step 2: Wire modal open/close helpers**

```typescript
private openModal(id: string): void {
  this.root.querySelector(`#${id}`)?.classList.add('open');
}
private closeModal(id: string): void {
  this.root.querySelector(`#${id}`)?.classList.remove('open');
}
```

**Step 3: Wire `Escape` key**

```typescript
// In create(), after building layout:
this.input.keyboard?.on('keydown-ESC', () =>
  this.root.querySelectorAll('.modal-overlay.open')
    .forEach(m => m.classList.remove('open'))
);
```

**Step 4: Wire overlay click-outside-to-close**

```typescript
this.root.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).classList.contains('modal-overlay')) {
    (e.target as HTMLElement).classList.remove('open');
  }
});
```

**Step 5: Hook modal opens into `onClick()`**

```typescript
case 'fight': {
  const vid = Number(target.closest<HTMLElement>('[data-vehicle-id]')?.dataset.vehicleId);
  this.openFightModal(vid);
  break;
}
case 'repair': {
  const vid = Number(target.closest<HTMLElement>('[data-vehicle-id]')?.dataset.vehicleId);
  this.openRepairModal(vid);
  break;
}
case 'sell': {
  const vid = Number(target.closest<HTMLElement>('[data-vehicle-id]')?.dataset.vehicleId);
  this.openSellModal(vid);
  break;
}
case 'driver-card': {
  const did = Number(target.closest<HTMLElement>('[data-driver-id]')?.dataset.driverId);
  this.openDriverCardModal(did);
  break;
}
case 'hire':
  this.openHireModal();
  break;
case 'gang-settings':
  this.openGangSettingsModal();
  break;
case 'close-modal':
  this.closeModal(target.closest<HTMLElement>('[data-modal]')?.dataset.modal ?? '');
  break;
case 'build-new':
  this.scene.start('VehicleDesignerScene', { token: this.token, mode: 'new' });
  break;
case 'workshop': {
  const vid = Number(target.closest<HTMLElement>('[data-vehicle-id]')?.dataset.vehicleId);
  this.scene.start('VehicleDesignerScene', { token: this.token, vehicleId: vid });
  break;
}
```

**Step 6: Add `openFightModal()`, `openRepairModal()`, `openSellModal()`, etc.**

Each method populates its modal body and then calls `openModal()`. See `docs/mockups/garage.html` for exact content. Keep body content simple — use `renderInto()` for the body element.

Example:
```typescript
private openRepairModal(vehicleId: number): void {
  const v = this.vehicles.find(v => v.id === vehicleId);
  if (!v) return;
  this.pendingRepairVehicleId = vehicleId;
  const cost = Math.ceil((v.max_armour - v.armour) * 10); // placeholder — use real cost from API
  const bodyEl = this.root.querySelector('#cw-repair-body') as HTMLElement;
  renderInto(bodyEl, `
    <div class="cw-repair-detail">
      <div class="cw-repair-row"><span>${esc(v.name)}</span></div>
      <div class="cw-repair-row"><span>Current armor</span>
        <span style="color:var(--yellow)">${esc(v.armour)}/${esc(v.max_armour)}</span></div>
      <div class="cw-repair-row"><span>Cost</span>
        <span style="color:var(--yellow)">$${cost.toLocaleString()}</span></div>
    </div>`);
  this.openModal('cw-modal-repair');
}
```

**Step 7: Manual verify**

All modal open/close buttons work. Escape closes. Click outside overlay closes.

**Step 8: Commit**
```bash
git add client/src/scenes/GarageScene.ts
git commit -m "feat(garage): add all modals — fight, repair, sell, driver, hire, gang settings"
```

---

### Task 7: GarageScene — API Action Wiring

**Files:**
- Modify: `client/src/scenes/GarageScene.ts`

Wire every button that touches the server. After a successful API call, re-fetch data and call `rebuildSidebar()` + `rebuildVehiclePanel()` + `rebuildCrewPanel()`.

**Step 1: Add `refreshData()` helper**

```typescript
private async refreshData(): Promise<void> {
  // Re-run the same parallel fetch from create()
  // Then call: this.rebuildSidebar(); this.rebuildVehiclePanel(); this.rebuildCrewPanel();
}
```

**Step 2: Wire `confirm-repair`**

```typescript
case 'confirm-repair': {
  const host = window.location.hostname;
  const res = await fetch(
    `http://${host}:3001/api/vehicles/${this.pendingRepairVehicleId}/repair`,
    { method: 'POST', headers: { Authorization: `Bearer ${this.token}` } }
  );
  this.closeModal('cw-modal-repair');
  if (res.ok) {
    await this.refreshData();
    showToast(this.root, 'Vehicle repaired!');
  } else {
    showToast(this.root, 'Repair failed.');
  }
  break;
}
```

**Step 3: Wire `confirm-sell`, `enter-arena`, `upgrade-skill`, `save-gang`** — same pattern as repair. Refer to the existing GarageScene for the correct endpoint for each action (they're already implemented in the Phaser version).

**Step 4: Wire `enter-arena`** — validate squad selection checkboxes, then `this.scene.start('ArenaScene', { token, vehicleId, squadIds })`.

**Step 5: Manual verify**

Repair a vehicle → armour updates. Sell a vehicle → removed from list. Fight → arena launches.

**Step 6: Commit**
```bash
git add client/src/scenes/GarageScene.ts
git commit -m "feat(garage): wire all API actions with data refresh"
```

---

## Phase 3 — Secondary Hub Scenes

### Task 8: JobBoardScene

**Files:**
- Modify: `client/src/scenes/JobBoardScene.ts`

Follow the exact ShopScene pattern. Read ShopScene before starting.

**Step 1: Scaffold**

```typescript
async create(): Promise<void> {
  // existing data fetch (jobs, active job from localStorage, money, gang)
  this.root = createHubRoot(this);
  renderInto(this.root, this.buildHTML());
  wireNavigation(this.root, this, this.token);
  this.root.addEventListener('click', this.onClick.bind(this));
  this.startEtaTick();
}
```

**Step 2: `buildHTML()`** — see `docs/mockups/jobboard.html` for layout. Structure:
- Sidebar (from `buildSidebarHTML()` with `activeNav: 'jobboard'`)
- Main with page header ("Job Board"), job list section, in-progress section
- Squad picker modal

**Step 3: ETA countdown**

```typescript
private startEtaTick(): void {
  const interval = setInterval(() => {
    if (!document.body.contains(this.root)) { clearInterval(interval); return; }
    this.rebuildInProgressSection();
  }, 1000);
  this.events.once('shutdown', () => clearInterval(interval));
}
```

**Step 4: Wire `send-squad` action** → open squad picker modal.
**Step 5: Wire `dispatch-squad` action** → POST to job endpoint, refresh.

**Step 6: Manual verify** — all jobs visible, in-progress ETAs tick, Send Squad opens picker.

**Step 7: Commit**
```bash
git add client/src/scenes/JobBoardScene.ts
git commit -m "feat(jobboard): migrate to HTML/CSS overlay"
```

---

### Task 9: LeaderboardScene

**Files:**
- Modify: `client/src/scenes/LeaderboardScene.ts`

**Step 1: Scaffold** — same pattern as above.

**Step 2: `buildHTML()`** — see `docs/mockups/leaderboard.html`. Structure:
- Sidebar with `activeNav: 'leaderboard'`
- Main with page header
- Endgame banner (if `this.endgame` flag is set)
- `<table>` with RANK/GANG/INFLUENCE/ZONES columns
- Player row highlighted in gold
- Retire modal

**Step 3: Wire `retire-gang` action**

```typescript
case 'retire-gang': {
  const host = window.location.hostname;
  const res = await fetch(`http://${host}:3001/api/leaderboard/retire`,
    { method: 'POST', headers: { Authorization: `Bearer ${this.token}` } });
  if (res.ok) {
    this.closeModal('cw-modal-retire');
    this.scene.start('GarageScene', { token: this.token });
  }
  break;
}
```

**Step 4: Commit**
```bash
git add client/src/scenes/LeaderboardScene.ts
git commit -m "feat(leaderboard): migrate to HTML/CSS overlay"
```

---

### Task 10: TownScene

**Files:**
- Modify: `client/src/scenes/TownScene.ts`

TownScene is small (4 buttons). This is a quick migration.

**Step 1:** Replace all Phaser text/button creation with:

```typescript
async create(): Promise<void> {
  await this.fetchData(); // keep existing data fetch
  this.root = createHubRoot(this);
  renderInto(this.root, this.buildHTML());
  this.root.addEventListener('click', this.onClick.bind(this));
}

private buildHTML(): string {
  return `
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px">
      <div style="font-size:36px;color:var(--red);font-family:monospace;text-transform:uppercase;letter-spacing:0.08em">
        ${esc(this.townName ?? 'Midville')}</div>
      <div style="font-size:14px;color:var(--gray);font-family:monospace">A dusty town on the autoduel circuit</div>
      <div style="display:flex;flex-direction:column;gap:12px;margin-top:20px">
        <button class="btn btn-green" data-action="go-garage"
          style="font-size:18px;padding:12px 32px">⚙ Garage</button>
        <button class="btn btn-red" data-action="go-arena"
          style="font-size:16px;padding:10px 24px">🔴 Drive to Arena</button>
      </div>
    </div>`;
}
```

**Step 2: Wire buttons** → `go-garage` → `GarageScene`, `go-arena` → `ArenaScene`.

**Step 3: Commit**
```bash
git add client/src/scenes/TownScene.ts
git commit -m "feat(town): migrate to HTML/CSS overlay"
```

---

### Task 11: ReportScene

**Files:**
- Modify: `client/src/scenes/ReportScene.ts`

**Step 1: Scaffold** — same DOM overlay pattern.

**Step 2: `buildHTML()`** — see `docs/mockups/reports.html`. Report cards are expandable:

```html
<div class="cw-report-card" data-report-id="...">
  <div class="cw-report-header">...</div>
  <div class="cw-report-detail">...</div>  <!-- hidden until expanded -->
</div>
```

Toggle class `.expanded` on the card when clicked. The `.cw-report-detail` is `display:none` by default, `display:block` when parent has `.expanded`.

**Step 3: Wire expand** — in onClick, toggle `.expanded` on the card element.

**Step 4: Mark reports as read** — when a card is expanded, POST to `/api/reports/{id}/read`.

**Step 5: Commit**
```bash
git add client/src/scenes/ReportScene.ts
git commit -m "feat(reports): migrate to HTML/CSS overlay with expandable cards"
```

---

### Task 12: New ActivityScene

**Files:**
- Create: `client/src/scenes/ActivityScene.ts`
- Modify: `client/src/main.ts` (register scene)

Activity is currently an inline overlay in GarageScene. Make it a proper scene.

**Step 1: Create `ActivityScene.ts`**

```typescript
import Phaser from 'phaser';
import { esc, renderInto, buildSidebarHTML, createHubRoot, wireNavigation, showToast } from '../ui/hub';

export class ActivityScene extends Phaser.Scene {
  private token = '';
  private root!: HTMLDivElement;
  private activityLog: ActivityEntry[] = [];
  private rivalLog: RivalEntry[] = [];
  private unreadReports = 0;

  constructor() { super({ key: 'ActivityScene' }); }

  init(data: { token: string }): void { this.token = data.token; }

  async create(): Promise<void> {
    const host = window.location.hostname;
    const headers = { Authorization: `Bearer ${this.token}` };
    const [actRes, gangRes, unreadRes] = await Promise.all([
      fetch(`http://${host}:3001/api/territory/activity`, { headers }),
      fetch(`http://${host}:3001/api/gangs/mine`, { headers }),
      fetch(`http://${host}:3001/api/reports/unread-count`, { headers }),
    ]);
    if (actRes.ok)    this.activityLog = await actRes.json();
    if (gangRes.ok)   this.gang = await gangRes.json();
    if (unreadRes.ok) ({ count: this.unreadReports } = await unreadRes.json());

    this.root = createHubRoot(this);
    renderInto(this.root, this.buildHTML());
    wireNavigation(this.root, this, this.token);
    this.root.addEventListener('click', this.onClick.bind(this));

    // Mark all as read on scene load
    fetch(`http://${host}:3001/api/territory/activity/read-all`,
      { method: 'POST', headers });
  }
  // ... buildHTML() — see docs/mockups/activity.html for layout
}
```

**Step 2: Register in `main.ts`**

```typescript
import { ActivityScene } from './scenes/ActivityScene';
// Add ActivityScene to the scenes array in Phaser.Game config
```

**Step 3: Commit**
```bash
git add client/src/scenes/ActivityScene.ts client/src/main.ts
git commit -m "feat(activity): add ActivityScene — while-you-were-away feed"
```

---

## Phase 4 — Hybrid Scene

### Task 13: WorldMapScene — HTML Panels

**Files:**
- Modify: `client/src/scenes/WorldMapScene.ts`

The Phaser canvas is kept for rendering the map (roads, nodes, influence zones). Only the popup panels (Travel, Deploy) migrate to HTML overlays.

**Step 1: Create HTML panel container in `create()`**

```typescript
// After existing Phaser map setup:
this.panelRoot = document.createElement('div');
this.panelRoot.style.cssText = 'position:fixed;inset:0;z-index:40;pointer-events:none;';
document.body.appendChild(this.panelRoot);
this.events.once('shutdown', () => this.panelRoot.remove());
```

Note `pointer-events:none` on the container — only the panels themselves have `pointer-events:auto`.

**Step 2: Build travel panel and deploy panel as HTML**

```typescript
renderInto(this.panelRoot, `
  ${this.buildTravelPanelHTML()}
  ${this.buildDeployPanelHTML()}
`);
```

See `docs/mockups/worldmap.html` for exact panel structure.

**Step 3: When a node is clicked in Phaser, show the HTML panel**

```typescript
// In existing node click handler:
node.on('pointerdown', () => {
  this.selectedNode = node.data;
  this.showTravelPanel(node.data);
});

private showTravelPanel(node: WorldNode): void {
  this.populateTravelPanel(node);
  this.panelRoot.querySelector('#cw-travel-panel')?.classList.add('open');
}
```

**Step 4: Wire panel buttons**

- Travel button → `this.scene.start('ArenaScene', ...)` or update player position
- Deploy button → show deploy panel
- Cancel → remove `.open`

**Step 5: Manual verify** — click a node, panel appears. Deploy picker shows vehicles. Cancel closes panel.

**Step 6: Commit**
```bash
git add client/src/scenes/WorldMapScene.ts
git commit -m "feat(worldmap): replace Phaser popup panels with HTML overlays"
```

---

## Phase 5 — ArenaScene HUD Fixes

### Task 14: ArenaScene Responsive HUD

**Files:**
- Modify: `client/src/scenes/ArenaScene.ts`

Fix the three hardcoded positions that break on non-1280px viewports.

**Step 1: Fix minimap position**

Find: `x=1144` (hardcoded)
Replace with: `this.scale.width - 136`

Ensure `layoutHud()` (or equivalent) is called on every resize via `onLayout(this, () => this.layoutHud())`.

**Step 2: Fix combat log Y position**

Find: `y=580` and `y=598` (hardcoded)
Replace with: `this.scale.height - 120` and `this.scale.height - 102`

**Step 3: Fix armor display positions**

The armor facing display at `x=20–100, y=130–204` is relative to top-left which is fine — but confirm `layoutHud()` recalculates these on resize. If not, add `onLayout()` binding.

**Step 4: Manual verify** — resize browser window. HUD elements should stay in correct positions.

**Step 5: Commit**
```bash
git add client/src/scenes/ArenaScene.ts
git commit -m "fix(arena): responsive HUD — minimap, combat log, armor positions"
```

---

## Phase 6 — Cleanup & Verification

### Task 15: Remove Deprecated Code

**Files:**
- Modify: `client/src/scenes/GarageScene.ts`
- Modify: `client/src/ui/DriverPicker.ts` (if superseded by HTML squad picker)

**Step 1: Delete dead Phaser rendering code from GarageScene**

After Tasks 3–7, the old `renderGarage()` method and all `this.add.text()`, `this.add.image()`, `this.add.rectangle()` calls should already be gone. Double-check with `grep 'this.add\.' client/src/scenes/GarageScene.ts`. If any remain, remove them.

**Step 2: Check DriverPicker.ts**

If the squad picker modal in GarageScene fully replaces `DriverPicker`, remove `DriverPicker.ts` and any imports. If it's still used by VehicleDesignerScene or ArenaScene, leave it alone.

**Step 3: Remove old `mainLayer` container if it exists**

```typescript
// grep for: mainLayer, this.children, this.add.container
```

**Step 4: Commit**
```bash
git add -u
git commit -m "chore(garage): remove legacy Phaser rendering code"
```

---

### Task 16: Build, Smoke Test, Deploy

**Step 1: Full TypeScript + Vite build**

```bash
npm -w @carwars/client run build
```
Expected: zero TypeScript errors, build output in `client/dist/`.

**Step 2: Smoke test checklist** (manual, in browser at `localhost:3000`)

- [ ] Login → reaches Garage
- [ ] Garage: vehicles visible, crew visible, select a vehicle
- [ ] Garage: Fight button opens squad picker modal
- [ ] Garage: Repair opens modal, confirm calls API
- [ ] Garage: Sidebar nav — each link reaches the correct scene
- [ ] Shop: tabs filter vehicles, Buy opens modal, deducts treasury
- [ ] Job Board: jobs visible, Send Squad opens picker, ETA ticks
- [ ] World Map: click a node shows travel panel, Deploy shows vehicle picker
- [ ] Leaderboard: table visible, Retire button opens modal
- [ ] Reports: cards expand on click
- [ ] Activity: feed visible, rival log visible, Mark All Read works
- [ ] Arena: join from Fight, HUD visible at various window widths (1024, 1280, 1920)
- [ ] Escape closes any open modal on all hub screens
- [ ] Resize window — no layout breakage on any hub screen

**Step 3: Fix any failures** — do not proceed to deploy until all checklist items pass.

**Step 4: Deploy**

```bash
./scripts/deploy.sh
```

**Step 5: Final commit if any fixes were made**
```bash
git add -A
git commit -m "fix: post-smoke-test adjustments"
```

---

## Summary

| Task | Scene | Complexity |
|------|-------|------------|
| 1–2  | Infrastructure | Low |
| 3–7  | GarageScene | High |
| 8    | JobBoardScene | Medium |
| 9    | LeaderboardScene | Low |
| 10   | TownScene | Low |
| 11   | ReportScene | Low |
| 12   | ActivityScene (new) | Medium |
| 13   | WorldMapScene panels | Medium |
| 14   | ArenaScene HUD | Low |
| 15–16 | Cleanup + deploy | Low |

**Phaser scenes that are NOT migrated (keep as-is):**
- `LoginScene` — works fine, simple canvas form
- `ArenaScene` — game canvas (HUD improved in Task 14 only)
- `VehicleDesignerScene` — complex Phaser tool, out of scope
- `MapEditorScene` / `MapViewerScene` — Phaser tools, out of scope
- `ResultScene` / `ReplayScene` — post-match screens, out of scope
- `TacticalOverlay` — in-combat overlay, out of scope
