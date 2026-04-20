import Phaser from 'phaser';
import { bindFullscreenToggle } from '../ui/responsive';
import { bodySpriteKey } from '../game/VehicleSprite';

// AADA Vehicle Guide shop. DOM-overlay scene (same pattern as
// VehicleDesignerScene): native HTML cards for dense scrolling content, a
// tiny renderInto helper that parses HTML-safe templates via
// createContextualFragment, and every dynamic string routed through esc().

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

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function renderInto(el: HTMLElement, html: string): void {
  el.textContent = '';
  const range = document.createRange();
  range.selectNodeContents(el);
  const fragment = range.createContextualFragment(html);
  el.appendChild(fragment);
}

export class ShopScene extends Phaser.Scene {
  private token = '';
  private treasury = 0;
  private gangPrimaryColour = 0x00cd68;
  private stock: StockVehicle[] = [];
  private filter: 'all' | number = 'all';
  private statusMsg = '';
  private statusColor = '#888';
  private root!: HTMLDivElement;

  constructor() { super({ key: 'ShopScene' }); }

  init(data: { token?: string }): void {
    this.token = data?.token ?? '';
    this.filter = 'all';
    this.statusMsg = '';
  }

  async create(): Promise<void> {
    await Promise.all([this.loadStock(), this.loadGang()]);

    this.root = document.createElement('div');
    this.root.className = 'cw-shop';
    Object.assign(this.root.style, {
      position: 'fixed', inset: '0', zIndex: '50',
      background: '#0a0a1a', color: '#ccc',
      fontFamily: "'Courier New', monospace",
      display: 'grid', gridTemplateRows: 'auto auto 1fr auto',
      minHeight: '0',
    });
    document.body.appendChild(this.root);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.root.remove());
    this.rebuild();
    bindFullscreenToggle(this);
  }

  private async loadStock(): Promise<void> {
    try {
      const host = window.location.hostname;
      const res = await fetch(`http://${host}:3001/api/stock`);
      if (res.ok) this.stock = await res.json();
    } catch { /* empty */ }
  }

  private async loadGang(): Promise<void> {
    try {
      const host = window.location.hostname;
      const res = await fetch(`http://${host}:3001/api/gangs/mine`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (res.ok) {
        const g = await res.json();
        if (typeof g.treasury === 'number') this.treasury = g.treasury;
        if (typeof g.primary_colour === 'number') this.gangPrimaryColour = g.primary_colour;
      }
    } catch { /* empty */ }
  }

  private rebuild(): void {
    const html = this.renderStyles() + this.renderHeader() + this.renderTabs() + this.renderGrid() + this.renderFooter();
    renderInto(this.root, html);
    this.root.addEventListener('click', this.onClick);
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
      case 'filter':
        this.filter = value === 'all' ? 'all' : parseInt(value!, 10);
        this.rebuild();
        return;
      case 'buy':
        this.purchase(value!);
        return;
    }
  };

  private async purchase(id: string): Promise<void> {
    this.flashStatus('Purchasing…', '#aaa');
    this.rebuild();
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
        this.flashStatus(`${body.name} delivered to garage — $${this.treasury.toLocaleString()} left`, '#00ff88');
        this.rebuild();
      } else {
        this.flashStatus(body.error ?? 'Purchase failed', '#ff4444');
        this.rebuild();
      }
    } catch {
      this.flashStatus('Network error', '#ff4444');
      this.rebuild();
    }
  }

  private flashStatus(msg: string, colour: string): void {
    this.statusMsg = msg;
    this.statusColor = colour;
  }

  // ─── Rendering ──────────────────────────────────────────────────────────

  private renderStyles(): string {
    return `<style>
      .cw-shop, .cw-shop * { box-sizing: border-box; }
      .cw-shop h1 { margin: 0; color: #ff4444; font-size: 22px; letter-spacing: 2px; }
      .cw-shop h3 { margin: 0 0 6px 0; font-size: 11px; color: #ff4444; letter-spacing: 3px; text-transform: uppercase; }
      .cw-header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 12px 24px; background: #0f0f22; border-bottom: 1px solid #2a2a44;
      }
      .cw-header .meta { font-size: 12px; color: #888; display: flex; gap: 18px; }
      .cw-header .meta b { color: #ffcc00; font-weight: normal; }
      .cw-tabs { display: flex; gap: 2px; padding: 10px 24px 0 24px; background: #0a0a1a; }
      .cw-tabs .tab {
        padding: 8px 16px; background: #1a1a2e; border: 1px solid #2a2a44;
        border-bottom: none; color: #888; font-size: 12px; cursor: pointer;
        text-transform: uppercase; letter-spacing: 1.5px; font-family: inherit;
      }
      .cw-tabs .tab:hover { background: #222244; color: #aac; }
      .cw-tabs .tab.active { background: #003322; color: #00ff88; border-color: #00ff88; }
      .cw-body { padding: 16px 24px; background: #0a0a1a; overflow-y: auto; min-height: 0; }
      .grid {
        display: grid; gap: 14px;
        grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      }
      .card {
        background: #11112a; border: 1px solid #2a2a44; padding: 12px;
        display: grid; grid-template-rows: auto 1fr auto; gap: 8px;
      }
      .card header {
        display: flex; justify-content: space-between; align-items: baseline;
      }
      .card h4 { margin: 0; color: #00ff88; font-size: 15px; letter-spacing: 1.5px; }
      .card .div { font-size: 10px; color: #ffcc00; letter-spacing: 2px; }
      .card .thumb {
        background: radial-gradient(ellipse at center, #15152a 0%, #08081a 70%);
        border: 1px solid #2a2a44; padding: 12px; display: flex;
        justify-content: center; align-items: center; min-height: 110px;
      }
      .card .thumb img {
        image-rendering: pixelated; max-height: 110px;
      }
      .card .desc { color: #aac; font-size: 11px; line-height: 1.4; min-height: 44px; }
      .card .stats { font-size: 10px; color: #888; line-height: 1.4; }
      .card .stats b { color: #ccc; }
      .card footer {
        display: flex; justify-content: space-between; align-items: center;
        padding-top: 6px; border-top: 1px dotted #2a2a44;
      }
      .card .price { color: #ffcc00; font-size: 13px; font-weight: bold; }
      .btn {
        padding: 6px 16px; font-family: inherit; font-size: 11px; letter-spacing: 1px;
        border: 1px solid; background: transparent; cursor: pointer;
      }
      .btn-buy { color: #00ff88; border-color: #00ff88; background: #003322; }
      .btn-buy:hover { background: #00ff88; color: #0a0a1a; }
      .btn-buy[disabled] { opacity: 0.4; cursor: not-allowed; pointer-events: none; }
      .btn-back { color: #888; border-color: #444; }
      .btn-back:hover { color: #ccc; border-color: #888; }
      .cw-footer {
        display: flex; justify-content: space-between; align-items: center;
        padding: 12px 24px; border-top: 1px solid #2a2a44; background: #0f0f22;
      }
      .status-msg { flex: 1; text-align: center; font-size: 12px; }
      .empty { color: #666; text-align: center; padding: 40px; font-size: 13px; }
    </style>`;
  }

  private renderHeader(): string {
    return `
      <div class="cw-header">
        <h1>🛒 VEHICLE SHOP — AADA Vol 3</h1>
        <div class="meta">
          <span>Treasury <b>$${this.treasury.toLocaleString()}</b></span>
          <span>${this.stock.length} designs on offer</span>
        </div>
      </div>`;
  }

  private renderTabs(): string {
    const divisions = [...new Set(this.stock.map(s => s.division))].sort((a, b) => a - b);
    const tab = (v: string | number, label: string): string => `
      <button class="tab ${String(this.filter) === String(v) ? 'active' : ''}"
              data-action="filter" data-value="${v}">${label}</button>`;
    return `
      <div class="cw-tabs">
        ${tab('all', `All (${this.stock.length})`)}
        ${divisions.map(d => tab(d, `Div ${d}`)).join('')}
      </div>`;
  }

  private renderGrid(): string {
    const visible = this.filter === 'all'
      ? this.stock
      : this.stock.filter(s => s.division === this.filter);
    if (!visible.length) {
      return `<div class="cw-body"><div class="empty">No designs for that division.</div></div>`;
    }
    return `
      <div class="cw-body">
        <div class="grid">
          ${visible.map(v => this.renderCard(v)).join('')}
        </div>
      </div>`;
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
    const tint = this.tintFilterAttr();

    return `
      <div class="card">
        <header>
          <h4>${esc(v.name)}</h4>
          <span class="div">DIV ${v.division}</span>
        </header>
        <div class="thumb">
          <svg width="120" height="110" viewBox="0 0 80 100">
            <defs>${tint.defs}</defs>
            <image href="/sprites/bodies/${esc(bodyKey)}.png"
                   x="10" y="5" width="60" height="90"
                   preserveAspectRatio="xMidYMid meet"
                   filter="url(#${tint.id})"/>
          </svg>
        </div>
        <div class="desc">${esc(v.description)}</div>
        <div class="stats">
          <b>${esc((v.loadout.bodyType ?? '').replace(/_/g, ' '))}</b> · weight ${v.weight} lb<br>
          Armor: ${armorTotal} pts · Loadout: ${esc(loadoutSummary)}${v.loadout.hasRamplate ? ' · RAMPLATE' : ''}${v.loadout.hasSidecar ? ' · SIDECAR' : ''}
        </div>
        <footer>
          <span class="price">$${v.cost.toLocaleString()}</span>
          <button class="btn btn-buy" data-action="buy" data-value="${v.id}"
                  ${affordable ? '' : 'disabled'}
                  title="${affordable ? 'purchase & add to garage' : `need $${(v.cost - this.treasury).toLocaleString()} more`}">
            ${affordable ? '[ BUY ]' : '[ NO FUNDS ]'}
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

  private renderFooter(): string {
    return `
      <div class="cw-footer">
        <button class="btn btn-back" data-action="back">[ BACK TO GARAGE ]</button>
        <span class="status-msg" style="color:${this.statusColor};">${esc(this.statusMsg)}</span>
        <span style="color:#555;font-size:10px;">Source: AADA Vehicle Guide Vol 3</span>
      </div>`;
  }
}
