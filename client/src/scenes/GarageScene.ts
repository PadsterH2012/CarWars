import Phaser from 'phaser';
import { paintEmblem, EMBLEM_IDS, type EmblemId } from '../game/CoatOfArms';
import { bindFullscreenToggle, onLayout } from '../ui/responsive';
import { preloadVehicleSprites, bodySpriteKey } from '../game/VehicleSprite';

interface Vehicle { id: string; name: string; value: number; damage_state: any; loadout: any; in_arena?: boolean; }
interface Driver { id: string; name: string; skill: number; xp: number; assigned_vehicle_id: string | null; alive: boolean; title?: string; xpToNext?: number; }
interface Gang { id: string; name: string; primary_colour: number; secondary_colour: number; emblem_id: EmblemId; treasury: number; reputation: number; }
interface DriverRequest {
  id: string; kind: string; description: string; cost: number;
  driver_id: string; driver_name: string; driver_skill: number;
  vehicle_id: string | null; vehicle_name: string | null;
}

export class GarageScene extends Phaser.Scene {
  private token = '';
  private vehicles: Vehicle[] = [];
  private drivers: Driver[] = [];
  private driverRequests: DriverRequest[] = [];
  private gang: Gang | null = null;
  private money = 0;
  private division = 0;
  private lastResult: { prize: number; jobPayout: number } | null = null;

  // Container for everything the main garage screen paints — we wipe + repaint on resize
  private mainLayer!: Phaser.GameObjects.Container;

  constructor() { super({ key: 'GarageScene' }); }

  preload(): void {
    preloadVehicleSprites(this);
  }

  init(data: { token: string; lastResult?: { prize: number; jobPayout: number } | null }): void {
    this.token = data.token;
    this.lastResult = data.lastResult ?? null;
  }

  async create(): Promise<void> {
    const host = window.location.hostname;

    const [meRes, vRes, dRes, gRes, reqRes] = await Promise.all([
      fetch(`http://${host}:3001/api/me`, { headers: { Authorization: `Bearer ${this.token}` } }),
      fetch(`http://${host}:3001/api/vehicles`, { headers: { Authorization: `Bearer ${this.token}` } }),
      fetch(`http://${host}:3001/api/drivers`, { headers: { Authorization: `Bearer ${this.token}` } }),
      fetch(`http://${host}:3001/api/gangs/mine`, { headers: { Authorization: `Bearer ${this.token}` } }),
      fetch(`http://${host}:3001/api/drivers/requests`, { headers: { Authorization: `Bearer ${this.token}` } }),
    ]);
    const me = await meRes.json();
    this.money = me.money ?? 0;
    this.division = me.division ?? 0;
    this.vehicles = await vRes.json();
    this.drivers = await dRes.json();
    if (gRes.ok) this.gang = await gRes.json();
    if (reqRes.ok) this.driverRequests = await reqRes.json();

    this.mainLayer = this.add.container(0, 0);

    bindFullscreenToggle(this);
    onLayout(this, () => this.renderGarage());
  }

  private renderGarage(): void {
    this.mainLayer.removeAll(true);
    const { width, height } = this.scale;
    const cx = width / 2;
    const leftX = Math.max(60, width * 0.07);
    const rightX = Math.min(width - 60, width * 0.93);
    const add = (obj: Phaser.GameObjects.GameObject) => { this.mainLayer.add(obj); return obj; };

    add(this.add.text(cx, 30, 'GARAGE', {
      color: '#ff4444', fontSize: '28px', fontFamily: 'monospace', fontStyle: 'bold'
    }).setOrigin(0.5));

    if (this.gang) {
      const key = `gang-emblem-header`;
      this.renderEmblemTexture(key, this.gang.emblem_id, this.gang.primary_colour, this.gang.secondary_colour, 32);
      add(this.add.image(leftX, 70, key).setOrigin(0, 0.5).setDisplaySize(32, 32));
      const nameBtn = this.add.text(leftX + 40, 70, this.gang.name, {
        color: '#ffffff', fontSize: '18px', fontFamily: 'monospace', fontStyle: 'bold'
      }).setOrigin(0, 0.5).setInteractive();
      nameBtn.on('pointerdown', () => this.showGangSettings());
      add(nameBtn);
      add(this.add.text(leftX, 100, `Treasury: $${this.gang.treasury.toLocaleString()} | Rep: ${this.gang.reputation} | Division: ${this.division}`, {
        color: '#ffcc00', fontSize: '14px', fontFamily: 'monospace'
      }));
    } else {
      add(this.add.text(leftX, 70, `Money: $${this.money.toLocaleString()} | Division: ${this.division}`, {
        color: '#ffcc00', fontSize: '16px', fontFamily: 'monospace'
      }));
    }

    if (this.lastResult) {
      const total = this.lastResult.prize + this.lastResult.jobPayout;
      add(this.add.text(cx, 55, `Last fight: +$${total.toLocaleString()} earned`, {
        color: '#00ff88', fontSize: '14px', fontFamily: 'monospace'
      }).setOrigin(0.5));
    }

    const activeJobId = localStorage.getItem('cw_active_job');
    const activeJobDesc = localStorage.getItem('cw_active_job_desc');
    const activeJobPayout = localStorage.getItem('cw_active_job_payout');
    if (activeJobId && activeJobDesc) {
      add(this.add.text(leftX, 128, `Active job: ${activeJobDesc} — $${Number(activeJobPayout).toLocaleString()} on win`, {
        color: '#ffcc00', fontSize: '13px', fontFamily: 'monospace'
      }));
    }

    // Split into two columns: vehicle list on the left, crew panel on the right
    const crewX = Math.min(width - 340, rightX - 280);
    const vehicleListMaxX = crewX - 40;

    if (this.vehicles.length === 0) {
      add(this.add.text(cx, height * 0.45, 'No vehicles. Build one!', {
        color: '#888888', fontSize: '18px', fontFamily: 'monospace'
      }).setOrigin(0.5));
    } else {
      const driverByVid = new Map<string, Driver>();
      for (const d of this.drivers) {
        if (d.alive && d.assigned_vehicle_id) driverByVid.set(d.assigned_vehicle_id, d);
      }

      const thumbBoxW = 42, thumbBoxH = 64;
      const textX = leftX + thumbBoxW + 10;
      this.vehicles.forEach((v, i) => {
        const y = 160 + i * 80;
        const ds = v.damage_state ?? {};
        const isDestroyed = ds.destroyed;
        const nameColor = isDestroyed ? '#ff4444' : '#00ff88';

        // Thumbnail — body PNG tinted with the gang's primary colour so each
        // vehicle reads at a glance as a cycle / pickup / bus etc.
        const spriteKey = `body_${bodySpriteKey(v.loadout?.bodyType)}`;
        if (this.textures.exists(spriteKey)) {
          const src = this.textures.get(spriteKey).getSourceImage() as HTMLImageElement;
          const scale = Math.min(thumbBoxW / src.width, thumbBoxH / src.height);
          const thumb = this.add.image(leftX + thumbBoxW / 2, y + 28, spriteKey)
            .setOrigin(0.5)
            .setScale(scale);
          if (this.gang) thumb.setTint(this.gang.primary_colour);
          if (isDestroyed) thumb.setTint(0x555555);
          add(thumb);
        }

        add(this.add.text(textX, y, `${v.name}`, { color: nameColor, fontSize: '16px', fontFamily: 'monospace' }));
        add(this.add.text(textX + 230, y, `$${v.value.toLocaleString()}`, { color: '#888888', fontSize: '14px', fontFamily: 'monospace' }));

        const driver = driverByVid.get(v.id);
        const driverStr = driver ? `Driver: ${driver.name} (sk${driver.skill})` : '\u26A0 NO DRIVER';
        const driverColor = driver ? '#88ccff' : '#ffaa44';
        add(this.add.text(textX, y + 20, driverStr, {
          color: driverColor, fontSize: '11px', fontFamily: 'monospace'
        }));
        const mounts: any[] = v.loadout?.mounts ?? [];
        const ammoStr = mounts.length
          ? mounts.map((m: any) => `${m.weaponId ?? '?'}:${m.ammo}`).join(' ')
          : 'no weapons';
        const tiresBlow = ds.tiresBlown?.length ?? 0;
        const tireStr = tiresBlow > 0 ? `  [${tiresBlow} TIRE${tiresBlow > 1 ? 'S' : ''} BLOWN]` : '';
        const engineStr = ds.engineDamaged ? '  [ENGINE]' : '';
        add(this.add.text(textX, y + 38, `${ammoStr}${tireStr}${engineStr}`, {
          color: '#666666', fontSize: '10px', fontFamily: 'monospace'
        }));

        // Action buttons: REPAIR / WORKSHOP / FIGHT / SELL — right-aligned in the vehicle column
        const btnTop = y;
        const btnSpan = Math.min(360, vehicleListMaxX - (leftX + 380));
        const btn0 = leftX + 380;
        const btn1 = btn0 + btnSpan * 0.22;
        const btn2 = btn0 + btnSpan * 0.52;
        const btn3 = btn0 + btnSpan * 0.84;

        const repairBtn = this.add.text(btn0, btnTop, '[REPAIR]', {
          color: '#ffcc00', fontSize: '12px', fontFamily: 'monospace',
          backgroundColor: '#332200', padding: { x: 4, y: 2 }
        }).setInteractive();
        repairBtn.on('pointerdown', () => this.repairVehicle(v.id));
        add(repairBtn);

        const workBtn = this.add.text(btn1, btnTop, '[WORKSHOP]', {
          color: '#aaccff', fontSize: '12px', fontFamily: 'monospace',
          backgroundColor: '#112244', padding: { x: 4, y: 2 }
        });
        if (!isDestroyed) {
          workBtn.setInteractive();
          workBtn.on('pointerdown', () =>
            this.scene.start('VehicleDesignerScene', { token: this.token, vehicleId: v.id })
          );
        }
        add(workBtn);

        const fightBtn = this.add.text(btn2, btnTop, isDestroyed ? '[DESTROYED]' : '[FIGHT]', {
          color: isDestroyed ? '#444444' : '#00ff88',
          fontSize: '12px', fontFamily: 'monospace',
          backgroundColor: isDestroyed ? '#221111' : '#003322',
          padding: { x: 4, y: 2 }
        });
        if (!isDestroyed) {
          fightBtn.setInteractive();
          fightBtn.on('pointerdown', () => this.showSquadModal(v.id));
        }
        add(fightBtn);

        const sellBtn = this.add.text(btn3, btnTop, '[SELL]', {
          color: '#ff8844', fontSize: '12px', fontFamily: 'monospace',
          backgroundColor: '#221100', padding: { x: 4, y: 2 }
        }).setInteractive();
        sellBtn.on('pointerdown', () => this.sellVehicle(v.id, v.name));
        add(sellBtn);
      });
    }

    // ── CREW panel ────────────────────────────────────────────────────────
    add(this.add.text(crewX, 130, 'CREW', {
      color: '#aaa', fontSize: '13px', fontFamily: 'monospace', fontStyle: 'bold'
    }));
    const hireBtn = this.add.text(crewX + 80, 130, '[HIRE DRIVERS...]', {
      color: '#88ff88', fontSize: '12px', fontFamily: 'monospace',
      backgroundColor: '#002211', padding: { x: 6, y: 3 },
    }).setInteractive();
    hireBtn.on('pointerdown', () => this.hireDriver());
    add(hireBtn);

    // Driver-request badge — only shown when there are pending requests
    const CREW_PANEL_W = 280;
    let firstRowY = 162;
    if (this.driverRequests.length > 0) {
      const reqBtn = this.add.text(crewX, 154, `⚠ ${this.driverRequests.length} DRIVER REQUEST${this.driverRequests.length > 1 ? 'S' : ''}`, {
        color: '#ffcc00', fontSize: '11px', fontFamily: 'monospace',
        backgroundColor: '#332200', padding: { x: 6, y: 3 },
      }).setInteractive();
      reqBtn.on('pointerdown', () => this.showRequestsModal());
      add(reqBtn);
      // Push the first driver row below the badge so they don't collide
      firstRowY = 188;
    }

    const livingDrivers = this.drivers.filter(d => d.alive);
    if (livingDrivers.length === 0) {
      add(this.add.text(crewX, firstRowY, 'No drivers hired.\nHire at least one to\nfield a vehicle in arena.', {
        color: '#777', fontSize: '11px', fontFamily: 'monospace'
      }));
    } else {
      const ROW_H = 50;
      livingDrivers.forEach((d, i) => {
        const y = firstRowY + i * ROW_H;
        const assignedVehicle = this.vehicles.find(v => v.id === d.assigned_vehicle_id);
        // Row 1: driver name (left) + assignment button (right-aligned)
        add(this.add.text(crewX, y, d.name, {
          color: '#ffffff', fontSize: '13px', fontFamily: 'monospace'
        }));
        const assignStr = assignedVehicle ? `▶ ${assignedVehicle.name}` : 'unassigned';
        const assignBtn = this.add.text(crewX + CREW_PANEL_W, y, assignStr, {
          color: assignedVehicle ? '#88ccff' : '#ffaa44', fontSize: '11px', fontFamily: 'monospace',
          backgroundColor: '#111122', padding: { x: 6, y: 3 }
        }).setOrigin(1, 0).setInteractive();
        assignBtn.on('pointerdown', () => this.showAssignDriverMenu(d));
        add(assignBtn);
        // Row 2: title · skill · XP (never collides because it's on its own line)
        const titleLine = d.title
          ? `${d.title} · sk${d.skill} · ${d.xp} PP${d.xpToNext ? ` (${d.xpToNext} to next)` : ''}`
          : `skill ${d.skill} · ${d.xp} XP`;
        add(this.add.text(crewX, y + 18, titleLine, {
          color: '#888', fontSize: '10px', fontFamily: 'monospace'
        }));
        // Subtle divider between rows for scannability (skip after last driver)
        if (i < livingDrivers.length - 1) {
          add(this.add.rectangle(crewX, y + 40, CREW_PANEL_W, 1, 0x333344, 0.8).setOrigin(0, 0));
        }
      });
    }

    // Arena picker + nav buttons — bottom of the screen
    const MAPS = [
      { id: 'truck-stop',  label: 'Truck Stop' },
      { id: 'town-square', label: 'Town Square' },
      { id: 'open',        label: 'Open Arena' },
    ];
    let selectedMap = localStorage.getItem('cw_selected_map') ?? 'truck-stop';
    if (!MAPS.find(m => m.id === selectedMap)) selectedMap = 'truck-stop';

    const arenaY = height - 180;
    add(this.add.text(leftX, arenaY, 'ARENA:', {
      color: '#aaa', fontSize: '13px', fontFamily: 'monospace', fontStyle: 'bold'
    }));
    const mapButtons: Phaser.GameObjects.Text[] = [];
    const refreshMapButtons = () => {
      mapButtons.forEach((btn, i) => {
        const isSel = MAPS[i].id === selectedMap;
        btn.setColor(isSel ? '#00ff88' : '#888');
        btn.setBackgroundColor(isSel ? '#003322' : '#111122');
      });
    };
    MAPS.forEach((m, i) => {
      const btn = this.add.text(leftX + 80 + i * 130, arenaY - 2, m.label, {
        fontSize: '13px', fontFamily: 'monospace',
        padding: { x: 6, y: 4 },
      }).setInteractive();
      btn.on('pointerdown', () => {
        selectedMap = m.id;
        localStorage.setItem('cw_selected_map', selectedMap);
        refreshMapButtons();
      });
      mapButtons.push(btn);
      add(btn);
    });
    refreshMapButtons();

    const navY = height - 100;
    const buildBtn = this.add.text(leftX, navY, '[BUILD NEW CAR]', {
      color: '#aaaaff', fontSize: '16px', fontFamily: 'monospace',
      backgroundColor: '#111133', padding: { x: 8, y: 4 }
    }).setInteractive();
    buildBtn.on('pointerdown', () => this.scene.start('VehicleDesignerScene', { token: this.token }));
    add(buildBtn);

    const shopBtn = this.add.text(leftX + 230, navY, '[STOCK SHOP]', {
      color: '#aaffcc', fontSize: '16px', fontFamily: 'monospace',
      backgroundColor: '#113322', padding: { x: 8, y: 4 }
    }).setInteractive();
    shopBtn.on('pointerdown', () => this.scene.start('ShopScene', { token: this.token }));
    add(shopBtn);

    const jobsBtn = this.add.text(leftX + 450, navY, '[JOB BOARD]', {
      color: '#ffaaaa', fontSize: '16px', fontFamily: 'monospace',
      backgroundColor: '#331111', padding: { x: 8, y: 4 }
    }).setInteractive();
    jobsBtn.on('pointerdown', () => this.scene.start('JobBoardScene', { token: this.token }));
    add(jobsBtn);

    add(this.add.text(rightX - 140, height - 30, '[F] Fullscreen', {
      color: '#555', fontSize: '11px', fontFamily: 'monospace'
    }).setOrigin(0, 0.5));
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
    if (quote.total === 0) {
      alert('Vehicle is in pristine condition — nothing to repair.');
      return;
    }

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

    const row = (label: string, detail: string, cost: number, key: string): string => `
      <label style="display:grid;grid-template-columns:20px 1fr auto;gap:10px;align-items:center;padding:8px 0;border-bottom:1px dotted #2a2a44;cursor:${cost > 0 ? 'pointer' : 'default'};">
        <input type="checkbox" name="part" value="${key}" ${cost > 0 ? 'checked' : 'disabled'} style="cursor:inherit;"/>
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
        ${row('Ammo refill', quote.ammo.rounds > 0 ? `${quote.ammo.rounds} rounds across ${quote.ammo.byMount.length} mount(s)` : 'full load', quote.ammo.cost, 'ammo')}
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

    panel.addEventListener('change', () => {
      const { total } = selectedTotal();
      const totalEl = panel.querySelector('#repair-total');
      const btn = panel.querySelector<HTMLButtonElement>('#btn-repair');
      if (totalEl) totalEl.textContent = '$' + total.toLocaleString();
      if (btn) {
        const ok = aff(total) && total > 0;
        btn.disabled = !ok;
        btn.style.cursor = ok ? 'pointer' : 'not-allowed';
        btn.style.background = ok ? '#332200' : '#221100';
        btn.style.color = ok ? '#ffcc00' : '#555';
        btn.style.borderColor = ok ? '#ffcc00' : '#555';
        btn.textContent = total === 0 ? '[ NOTHING SELECTED ]' : (ok ? '[ REPAIR ]' : '[ NO FUNDS ]');
      }
    });

    panel.addEventListener('click', async (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'cancel') { overlay.remove(); return; }
      if (btn.dataset.action === 'repair') {
        const { parts, total } = selectedTotal();
        if (total === 0) return;
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

  private showSquadModal(primaryId: string): void {
    const driverByVehicleId = new Map<string, Driver>();
    for (const d of this.drivers) {
      if (d.alive && d.assigned_vehicle_id) driverByVehicleId.set(d.assigned_vehicle_id, d);
    }
    const eligible = this.vehicles.filter(v =>
      !v.damage_state?.destroyed && !v.in_arena && driverByVehicleId.has(v.id)
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

    const render = (candidates: any[]): void => {
      const cards = candidates.map(c => {
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
        <div class="hire-grid">${cards}</div>
        <div style="margin-top:16px;display:flex;justify-content:space-between;align-items:center;padding-top:12px;border-top:1px solid #2a2a44;">
          <button data-action="close" style="padding:8px 18px;font-family:inherit;font-size:12px;background:transparent;color:#888;border:1px solid #444;cursor:pointer;">[ CLOSE ]</button>
          <button data-action="refresh" style="padding:8px 18px;font-family:inherit;font-size:12px;background:#332200;color:#ffaa00;border:1px solid #664400;cursor:pointer;">[ REFRESH POOL ($100) ]</button>
        </div>`;
      panel.appendChild(range.createContextualFragment(html));
    };

    const loadPool = async (): Promise<void> => {
      panel.textContent = 'Loading candidates\u2026';
      const r = await fetch(`http://${host}:3001/api/drivers/candidates`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      render(r.ok ? await r.json() : []);
    };

    const close = (): void => { overlay.remove(); };

    panel.addEventListener('click', async (e) => {
      const t = e.target as HTMLElement;
      const btn = t.closest<HTMLElement>('[data-action],[data-candidate-id]');
      if (!btn) return;
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
