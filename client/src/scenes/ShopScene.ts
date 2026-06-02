import Phaser from 'phaser';
import { bindFullscreenToggle } from '../ui/responsive';
import { bodySpriteKey } from '../game/VehicleSprite';
import { esc, renderInto, buildSidebarHTML, createHubRoot, wireNavigation, redirectIfUnauthorized, showToast, SidebarOpts } from '../ui/hub';

// AADA Vehicle Guide shop. Migrated to the shared HTML "hub" layout so the
// sidebar navigation persists (same pattern as JobBoardScene / GarageScene):
// a persistent sidebar + a `.main` column holding the page header, division
// tabs and a scrolling grid of stock-vehicle cards. Every dynamic string is
// routed through esc().

interface StockVehicle {
  id: string;
  name: string;
  division: number;
  description: string;
  cost: number;
  weight: number;
  loadout: {
    bodyType?: string;
    powerPlantType?: string;
    armor?: Record<string, number>;
    mounts?: Array<{ weaponId: string | null; arc: string; ammo: number; turretSize?: string }>;
    hasSidecar?: boolean;
    hasRamplate?: boolean;
  };
  source: string;
}

interface Gang {
  id: string; name: string; primary_colour: number;
  reputation?: number; influence?: number;
}

interface GarageStatus {
  owned: boolean; cost?: number; vehicleCount: number; maxVehicles: number;
}

export class ShopScene extends Phaser.Scene {
  private token = '';
  private treasury = 0;
  private division = 1;
  private gang: Gang | null = null;
  private gangPrimaryColour = 0x00cd68;
  private reputation = 0;
  private influence = 0;
  private unreadReports = 0;
  private unreadActivity = 0;
  private stock: StockVehicle[] = [];
  private garage: GarageStatus | null = null;
  private filter: 'all' | number = 'all';
  private root!: HTMLDivElement;
  private mainEl!: HTMLElement;

  constructor() { super({ key: 'ShopScene' }); }

  init(data: { token?: string }): void {
    this.token = data?.token ?? '';
    this.filter = 'all';
  }

  async create(): Promise<void> {
    const host = window.location.hostname;
    const headers = { Authorization: `Bearer ${this.token}` };

    const [stockRes, meRes, gangRes, repRes, actRes, bayRes] = await Promise.all([
      fetch(`http://${host}:3001/api/stock`, { headers }),
      fetch(`http://${host}:3001/api/me`, { headers }),
      fetch(`http://${host}:3001/api/gangs/mine`, { headers }),
      fetch(`http://${host}:3001/api/reports/unread-count`, { headers }),
      fetch(`http://${host}:3001/api/territory/activity/unread-count`, { headers }),
      // Storage cap status — used to disable Buy buttons and explain the limit.
      fetch(`http://${host}:3001/api/garages`, { headers }),
    ]);

    if (redirectIfUnauthorized(this, [stockRes, meRes, gangRes, repRes, actRes, bayRes])) return;

    if (stockRes.ok) this.stock = await stockRes.json();
    if (bayRes.ok) this.garage = await bayRes.json();
    if (meRes.ok) {
      const me = await meRes.json();
      if (typeof me.money === 'number') this.treasury = me.money;
      if (typeof me.division === 'number') this.division = me.division;
    }
    if (gangRes.ok) {
      this.gang = await gangRes.json();
      if (typeof this.gang?.primary_colour === 'number') this.gangPrimaryColour = this.gang.primary_colour;
      this.reputation = this.gang?.reputation ?? 0;
      this.influence = this.gang?.influence ?? 0;
    }
    if (repRes.ok) this.unreadReports = (await repRes.json()).unread ?? 0;
    if (actRes.ok) this.unreadActivity = (await actRes.json()).unread ?? 0;

    this.root = createHubRoot(this);

    const sidebar = document.createElement('nav');
    sidebar.className = 'sidebar';

    this.mainEl = document.createElement('div');
    this.mainEl.className = 'main';

    this.root.appendChild(sidebar);
    this.root.appendChild(this.mainEl);

    const sidebarOpts: SidebarOpts = {
      gangName:      this.gang?.name ?? 'Unknown',
      gangColor:     this.gangPrimaryColour,
      treasury:      this.treasury,
      reputation:    this.reputation,
      division:      this.division,
      influence:     this.influence,
      reportsBadge:  this.unreadReports,
      activityBadge: this.unreadActivity,
      activeNav:     'shop',
      token:         this.token,
    };
    renderInto(sidebar, buildSidebarHTML(sidebarOpts));

    this.rebuildMain();

    wireNavigation(this.root, this, this.token);
    this.root.addEventListener('click', this.onClick);

    bindFullscreenToggle(this);
  }

  private rebuildMain(): void {
    renderInto(this.mainEl, this.renderStyles() + this.buildMainHTML());
  }

  private onClick = (e: MouseEvent): void => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!t) return;
    const action = t.dataset.action!;
    const value = t.dataset.value;
    switch (action) {
      case 'filter':
        this.filter = value === 'all' ? 'all' : parseInt(value!, 10);
        this.rebuildMain();
        return;
      case 'buy':
        this.purchase(value!);
        return;
    }
  };

  private async purchase(id: string): Promise<void> {
    showToast(this.root, 'Purchasing…');
    try {
      const host = window.location.hostname;
      const res = await fetch(`http://${host}:3001/api/stock/${id}/purchase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        this.treasury = body.moneyRemaining ?? this.treasury;
        // The new vehicle takes a storage slot — keep the cap banner/buttons accurate.
        if (this.garage) this.garage.vehicleCount += 1;
        showToast(this.root, `${body.name} delivered to garage — $${this.treasury.toLocaleString()} left`);
        this.rebuildMain();
      } else {
        showToast(this.root, body.error ?? 'Purchase failed');
      }
    } catch {
      showToast(this.root, 'Network error');
    }
  }

  // ─── Rendering ──────────────────────────────────────────────────────────

  private renderStyles(): string {
    return `<style>
      .shop-grid {
        display: grid; gap: 14px; padding: 16px 24px;
        grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      }
      .shop-card {
        background: var(--card); border: 1px solid var(--border); padding: 12px;
        display: grid; grid-template-rows: auto 1fr auto auto auto; gap: 8px;
      }
      .shop-card header { display: flex; justify-content: space-between; align-items: baseline; }
      .shop-card h4 { margin: 0; color: var(--green); font-size: 15px; letter-spacing: 1.5px; }
      .shop-card .div { font-size: 10px; color: var(--yellow); letter-spacing: 2px; }
      .shop-thumb {
        background: radial-gradient(ellipse at center, #15152a 0%, #08081a 70%);
        border: 1px solid var(--border); padding: 12px; display: flex;
        justify-content: center; align-items: center; min-height: 110px;
      }
      .shop-thumb img { image-rendering: pixelated; max-height: 110px; }
      .shop-desc { color: #aac; font-size: 11px; line-height: 1.4; min-height: 44px; }
      .shop-stats { font-size: 10px; color: var(--gray); line-height: 1.4; }
      .shop-stats b { color: #ccc; }
      .shop-card footer {
        display: flex; justify-content: space-between; align-items: center;
        padding-top: 6px; border-top: 1px dotted var(--border);
      }
      .shop-price { color: var(--yellow); font-size: 13px; font-weight: bold; }
      .shop-empty { color: #666; text-align: center; padding: 40px; font-size: 13px; }
      .shop-source { padding: 8px 24px 16px; font-size: 10px; color: #555; }
      .shop-storage-banner {
        margin: 14px 24px 0; padding: 10px 14px;
        background: #2a1a11; border: 1px solid var(--yellow); color: var(--yellow);
        font-size: 12px; letter-spacing: 0.5px;
      }
    </style>`;
  }

  // True when the player can't take delivery of another vehicle — the server
  // would reject the purchase with "Vehicle limit reached".
  private storageFull(): boolean {
    return !!this.garage && this.garage.vehicleCount >= this.garage.maxVehicles;
  }

  private renderStorageBanner(): string {
    if (!this.storageFull()) return '';
    const g = this.garage!;
    const hint = g.owned
      ? 'Sell or scrap a vehicle to free up a slot.'
      : 'Buy a garage bay in the Garage to unlock more slots.';
    return `
      <div class="shop-storage-banner">
        ⚠ Garage storage full (${esc(g.vehicleCount)}/${esc(g.maxVehicles)}) — ${esc(hint)}
      </div>`;
  }

  private buildMainHTML(): string {
    return `
      <div class="page-header">
        <div class="page-title">🛒 Vehicle Shop</div>
        <div class="page-subtitle">AADA Vehicle Guide Vol 3 · ${this.stock.length} designs on offer</div>
      </div>
      <div class="topbar">${this.renderTabs()}</div>
      <div class="content" style="overflow-y:auto;">
        ${this.renderStorageBanner()}
        ${this.renderGrid()}
        <div class="shop-source">Source: AADA Vehicle Guide Vol 3</div>
      </div>`;
  }

  private renderTabs(): string {
    const divisions = [...new Set(this.stock.map(s => s.division))].sort((a, b) => a - b);
    const tab = (v: string | number, label: string): string => `
      <button class="arena-tab${String(this.filter) === String(v) ? ' active' : ''}"
              data-action="filter" data-value="${esc(v)}">${esc(label)}</button>`;
    return `
      <span class="topbar-label">Division</span>
      <div class="arena-tabs">
        ${tab('all', `All (${this.stock.length})`)}
        ${divisions.map(d => tab(d, `Div ${d}`)).join('')}
      </div>`;
  }

  private renderGrid(): string {
    const visible = this.filter === 'all'
      ? this.stock
      : this.stock.filter(s => s.division === this.filter);
    if (!visible.length) {
      return `<div class="shop-empty">No designs for that division.</div>`;
    }
    return `<div class="shop-grid">${visible.map(v => this.renderCard(v)).join('')}</div>`;
  }

  private renderCard(v: StockVehicle): string {
    const bodyKey = bodySpriteKey(v.loadout.bodyType);
    const mounts = v.loadout.mounts ?? [];
    const loadoutSummary = mounts.length
      ? mounts.map(m => {
          const arc = m.arc === 'turret' && m.turretSize ? `T·${m.turretSize[0]}` : m.arc.charAt(0).toUpperCase();
          return `${(m.weaponId ?? '—').toUpperCase()}(${arc})`;
        }).join(' · ')
      : '—';
    const armorTotal = Object.values(v.loadout.armor ?? {}).reduce((s, n) => s + (n as number), 0);
    const affordable = this.treasury >= v.cost;
    const storageFull = this.storageFull();
    const canBuy = affordable && !storageFull;
    const buyLabel = storageFull ? 'Storage Full' : affordable ? 'Buy' : 'No Funds';
    const buyTitle = storageFull
      ? (this.garage?.owned ? 'garage storage full — sell a vehicle to free up a slot' : 'garage storage full — buy a garage bay to store more vehicles')
      : affordable ? 'purchase & add to garage' : `need $${(v.cost - this.treasury).toLocaleString()} more`;
    const tint = this.tintFilterAttr();

    return `
      <div class="shop-card">
        <header>
          <h4>${esc(v.name)}</h4>
          <span class="div">DIV ${esc(v.division)}</span>
        </header>
        <div class="shop-thumb">
          <svg width="120" height="110" viewBox="0 0 80 100">
            <defs>${tint.defs}</defs>
            <image href="/sprites/bodies/${esc(bodyKey)}.png"
                   x="10" y="5" width="60" height="90"
                   preserveAspectRatio="xMidYMid meet"
                   filter="url(#${tint.id})"/>
          </svg>
        </div>
        <div class="shop-desc">${esc(v.description)}</div>
        <div class="shop-stats">
          <b>${esc((v.loadout.bodyType ?? '').replace(/_/g, ' '))}</b> · weight ${esc(v.weight)} lb<br>
          Armor: ${esc(armorTotal)} pts · Loadout: ${esc(loadoutSummary)}${v.loadout.hasRamplate ? ' · RAMPLATE' : ''}${v.loadout.hasSidecar ? ' · SIDECAR' : ''}
        </div>
        <footer>
          <span class="shop-price">$${esc(v.cost.toLocaleString())}</span>
          <button class="btn btn-green" data-action="buy" data-value="${esc(v.id)}"
                  ${canBuy ? '' : 'disabled'}
                  title="${esc(buyTitle)}">
            ${esc(buyLabel)}
          </button>
        </footer>
      </div>`;
  }

  // SVG filter that multiplies each channel by the gang primary — same tint
  // as the designer preview and the arena sprite.
  private tintFilterAttr(): { id: string; defs: string } {
    const id = 'shop-tint';
    const r = (((this.gangPrimaryColour >> 16) & 0xff) / 255).toFixed(3);
    const g = (((this.gangPrimaryColour >>  8) & 0xff) / 255).toFixed(3);
    const b = ((this.gangPrimaryColour & 0xff) / 255).toFixed(3);
    return {
      id,
      defs: `
        <filter id="${id}" color-interpolation-filters="sRGB">
          <feColorMatrix type="matrix" values="
            ${r} 0 0 0 0
            0 ${g} 0 0 0
            0 0 ${b} 0 0
            0 0 0 1 0"/>
        </filter>`,
    };
  }
}
