import Phaser from "phaser";
import type { GeneratedWorld, GeneratedSettlement, GeneratedRoad } from "@carwars/shared";
import { bindFullscreenToggle, onLayout } from "../ui/responsive";
import { esc, renderInto, buildSidebarHTML, createHubRoot, wireNavigation } from "../ui/hub";

const C_ROAD_HIGHWAY  = 0x555566;
const C_ROAD_URBAN    = 0x666644;
const C_ROAD_DIRT     = 0x665544;
const C_ROAD_MOUNTAIN = 0x444444;

const C_NODE_CITY       = 0x44aaff;
const C_NODE_TOWN       = 0x88ccff;
const C_NODE_TRUCK_STOP = 0xffaa44;
const C_NODE_ARENA      = 0xff4444;
const C_NODE_GARAGE     = 0x00ff88;
const C_NODE_MARKET     = 0xff88ff;

const C_CURRENT_RING = 0x00ff88;
const C_HOVER_RING   = 0xffffff;

function nodeColour(kind: GeneratedSettlement["kind"]): number {
  switch (kind) {
    case "city":    return C_NODE_CITY;
    case "town":    return C_NODE_TOWN;
    case "village": return C_NODE_TRUCK_STOP;   // reuse warm amber
    case "outpost": return 0x996633;             // brown
    default:        return 0xaaaaaa;
  }
}

function roadColour(kind: GeneratedRoad["roadType"]): number {
  switch (kind) {
    case "highway": return C_ROAD_HIGHWAY;
    case "urban":   return C_ROAD_URBAN;
    case "dirt":    return C_ROAD_DIRT;
    case "mountain":return C_ROAD_MOUNTAIN;
    default:        return 0x444444;
  }
}

function roadWidth(kind: GeneratedRoad["roadType"]): number {
  switch (kind) {
    case "highway":  return 4;
    case "urban":    return 3;
    case "dirt":     return 2;
    case "mountain": return 2;
    default:         return 2;
  }
}

// A vehicle + its crew, as offered in the deploy panel's squad composition list.
interface SquadMember {
  vehicleId: string;
  vehicleName: string;
  armor: number;                 // current total armour points (a rough HP read-out)
  driverId: string | null;
  driverName: string | null;
  driverSkill: number | null;
  status: string;                // available | deployed | on_job | in_arena
}

// An in-transit deployment, tracked for the persistent world-map indicator.
interface ActiveDeployment {
  id: string;
  zoneId: string;
  zoneName: string;
  resolvesAtMs: number;
}

// Compact ETA: "1m 20s" / "45s".
function fmtEta(seconds: number): string {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

class WorldMapScene extends Phaser.Scene {
  private token = "";
  private region: GeneratedWorld | null = null;
  private currentNodeId = "";

  private roadGraphics!: Phaser.GameObjects.Graphics;
  private nodeContainer!: Phaser.GameObjects.Container;
  private uiCam!: Phaser.Cameras.Scene2D.Camera;
  private uiObjects: Phaser.GameObjects.GameObject[] = [];

  private nodeMap = new Map<string, Phaser.GameObjects.Container>();
  private hoverNodeId: string | null = null;
  private selectedNodeId: string | null = null;
  // HTML panel root (overlaid on the map area)
  private panelRoot!: HTMLDivElement;
  // Currently selected node data for travel/deploy actions
  private selectedNode: GeneratedSettlement | null = null;
  private selectedRoad: GeneratedRoad | null = null;

  private influenceBySettlement: Record<string, { gangId: string; influence: number }[]> = {};

  // Persistent "squads currently out" indicator (markers + list + countdown).
  private deployments: ActiveDeployment[] = [];
  private deploymentLayer: Phaser.GameObjects.Container | null = null;
  private deploymentTimer: Phaser.Time.TimerEvent | null = null;
  // Working set of vehicle ids selected in the open deploy panel.
  private squadSelection = new Set<string>();
  // Cached squad composition for the deploy panel
  private squadMembers: SquadMember[] = [];

  private worldScale = 1;
  private worldOffsetX = 0;
  private worldOffsetY = 0;

  // Gang / player data for sidebar
  private gang: { name: string; primary_colour: number; reputation: number; influence: number } | null = null;
  private money = 0;
  private division = 1;
  private unreadReports = 0;
  private unreadActivity = 0;

  constructor() { super({ key: "WorldMapScene" }); }

  init(data: { token: string }): void {
    this.token = data.token;
    this.region = null;
    this.nodeMap.clear();
    this.hoverNodeId = null;
    this.selectedNodeId = null;
    this.selectedNode = null;
    this.selectedRoad = null;
    this.uiObjects = [];
    this.influenceBySettlement = {};
    this.deployments = [];
    this.deploymentLayer = null;
    this.deploymentTimer = null;
    this.squadSelection = new Set();
    this.squadMembers = [];
    this.gang = null;
    this.money = 0;
    this.division = 1;
    this.unreadReports = 0;
    this.unreadActivity = 0;
  }

  async create(): Promise<void> {
    bindFullscreenToggle(this);
    this.roadGraphics = this.add.graphics();
    this.nodeContainer = this.add.container(0, 0);
    this.uiCam = this.cameras.add(0, 0, this.scale.width, this.scale.height, false, "ui");

    await Promise.all([
      this.fetchRegion(),
      this.fetchInfluence(),
      this.fetchCurrentLocation(),
      this.fetchPlayerData(),
    ]);

    if (!this.region) {
      this.showError("Failed to load world map");
      return;
    }

    // ── HTML overlay ──────────────────────────────────────────────────────
    const root = createHubRoot(this);

    // Sidebar
    const sidebar = document.createElement('nav');
    sidebar.className = 'sidebar';
    renderInto(sidebar, buildSidebarHTML({
      gangName:     this.gang?.name ?? '',
      gangColor:    this.gang?.primary_colour ?? 0xff4444,
      treasury:     this.money,
      reputation:   this.gang?.reputation ?? 0,
      division:     this.division,
      influence:    this.gang?.influence ?? 0,
      reportsBadge: this.unreadReports,
      activityBadge: this.unreadActivity,
      activeNav:    'worldmap',
      token:        this.token,
    }));
    root.appendChild(sidebar);
    wireNavigation(root, this, this.token);

    // Map area — the Phaser canvas lives here
    const mapArea = document.createElement('div');
    mapArea.style.cssText = 'flex:1;position:relative;overflow:hidden;';
    root.appendChild(mapArea);

    // Move the Phaser canvas into mapArea so it sits beside the sidebar
    const canvas = document.querySelector('#game canvas') as HTMLCanvasElement | null;
    if (canvas) {
      mapArea.appendChild(canvas);
      // Size canvas to fill mapArea (sidebar takes --sidebar-w = 220px)
      const sidebarW = 220;
      const availW = window.innerWidth - sidebarW;
      canvas.style.cssText = `display:block;width:${availW}px;height:${window.innerHeight}px;`;
      // Also update Phaser's scale manager so the map renders to the correct size
      this.scale.resize(availW, window.innerHeight);
      // Sync uiCam immediately so first-frame overlays use the correct bounds
      this.uiCam?.setPosition(0, 0);
      this.uiCam?.setSize(availW, window.innerHeight);
    }

    // Panel overlay layer (travel panel + deploy panel)
    this.panelRoot = document.createElement('div');
    this.panelRoot.style.cssText = 'position:absolute;inset:0;z-index:10;pointer-events:none;';
    mapArea.appendChild(this.panelRoot);

    renderInto(this.panelRoot, this.buildTravelPanelHTML() + this.buildDeployPanelHTML());
    this.panelRoot.addEventListener('click', this.onPanelClick.bind(this));

    // ── Phaser map rendering ──────────────────────────────────────────────
    this.computeTransform();
    this.drawRoads();
    this.drawNodes();
    this.setupUiCamera();

    // Persistent "squads out on deployment" indicator
    this.deploymentLayer = this.add.container(0, 0);
    this.uiCam.ignore(this.deploymentLayer);
    await this.fetchActiveDeployments();
    this.drawDeployments();
    this.deploymentTimer = this.time.addEvent({
      delay: 1000, loop: true, callback: () => { void this.onDeploymentTick(); },
    });

    onLayout(this, () => this.onResize());
  }

  // ── Sidebar data fetch ────────────────────────────────────────────────────

  private async fetchPlayerData(): Promise<void> {
    const host = window.location.hostname;
    const headers = { Authorization: `Bearer ${this.token}` };
    try {
      const [meRes, gangRes, repRes, actRes] = await Promise.all([
        fetch(`http://${host}:3001/api/me`, { headers }),
        fetch(`http://${host}:3001/api/gangs/mine`, { headers }),
        fetch(`http://${host}:3001/api/reports/unread-count`, { headers }),
        fetch(`http://${host}:3001/api/territory/activity/unread-count`, { headers }),
      ]);
      if (meRes.ok) {
        const me = await meRes.json();
        this.money    = me.money    ?? 0;
        this.division = me.division ?? 1;
      }
      if (gangRes.ok) this.gang = await gangRes.json();
      if (repRes.ok)  this.unreadReports  = (await repRes.json()).unread  ?? 0;
      if (actRes.ok)  this.unreadActivity = (await actRes.json()).unread  ?? 0;
    } catch (e) {
      console.error('WorldMapScene fetchPlayerData failed:', e);
    }
  }

  private async fetchRegion(): Promise<void> {
    try {
      const host = window.location.hostname;
      const res  = await fetch(`http://${host}:3001/api/world/map`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      this.region = await res.json();
    } catch (e) {
      console.error("WorldMapScene fetchRegion failed:", e);
      this.region = null;
    }
  }

  private async fetchCurrentLocation(): Promise<void> {
    try {
      const host = window.location.hostname;
      const res = await fetch(`http://${host}:3001/api/world/state`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.currentNodeId) this.currentNodeId = data.currentNodeId;
      }
    } catch (e) {
      console.error("WorldMapScene fetchCurrentLocation failed:", e);
    }
  }

  private async fetchInfluence(): Promise<void> {
    try {
      const host = window.location.hostname;
      const res  = await fetch(`http://${host}:3001/api/territory/influence`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (res.ok) {
        const data = await res.json();
        this.influenceBySettlement = data.bySettlement ?? {};
      }
    } catch (e) {
      console.error('WorldMapScene fetchInfluence failed:', e);
    }
  }

  private computeTransform(): void {
    if (!this.region || this.region.settlements.length === 0) return;
    const xs = this.region.settlements.map(n => n.x);
    const ys = this.region.settlements.map(n => n.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const pad = 80;
    const availW = this.scale.width - pad * 2;
    const availH = this.scale.height - pad * 2;
    const dataW = Math.max(maxX - minX, 1);
    const dataH = Math.max(maxY - minY, 1);
    this.worldScale = Math.min(availW / dataW, availH / dataH);
    this.worldOffsetX = pad + (availW - dataW * this.worldScale) / 2 - minX * this.worldScale;
    this.worldOffsetY = pad + (availH - dataH * this.worldScale) / 2 - minY * this.worldScale;
  }

  private toScreen(x: number, y: number): { x: number; y: number } {
    return { x: x * this.worldScale + this.worldOffsetX, y: y * this.worldScale + this.worldOffsetY };
  }

  private drawRoads(): void {
    if (!this.region) return;
    this.roadGraphics.clear();
    for (const road of this.region.roads) {
      const a = this.region.settlements.find(n => n.id === road.from);
      const b = this.region.settlements.find(n => n.id === road.to);
      if (!a || !b) continue;
      const p = this.toScreen(a.x, a.y);
      const q = this.toScreen(b.x, b.y);
      this.roadGraphics.lineStyle(roadWidth(road.roadType), roadColour(road.roadType), 0.7);
      this.roadGraphics.lineBetween(p.x, p.y, q.x, q.y);
    }
  }

  private drawNodes(): void {
    if (!this.region) return;
    this.nodeContainer.removeAll(true);
    this.nodeMap.clear();
    for (const node of this.region.settlements) {
      const pos = this.toScreen(node.x, node.y);
      const c = this.add.container(pos.x, pos.y);
      const r = node.kind === "city" ? 14 : 10;
      const colour = nodeColour(node.kind);
      // Tint by dominant gang influence
      let finalColour = colour;
      const influence = this.influenceBySettlement[node.id];
      if (influence && influence.length > 0) {
        const dominant = influence[0];
        // Derive a stable colour from the gang ID string (simple hash)
        const hash = dominant.gangId.split('').reduce(
          (h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0
        );
        const gangColour = Math.abs(hash) % 0xffffff;
        // 30% gang tint over base node colour
        const r2 = Math.round(((colour >> 16 & 0xff) * 0.7) + ((gangColour >> 16 & 0xff) * 0.3));
        const g  = Math.round(((colour >>  8 & 0xff) * 0.7) + ((gangColour >>  8 & 0xff) * 0.3));
        const b  = Math.round(((colour       & 0xff) * 0.7) + ((gangColour       & 0xff) * 0.3));
        finalColour = (r2 << 16) | (g << 8) | b;
      }
      const dot = this.add.circle(0, 0, r, finalColour).setStrokeStyle(2, 0, 0.5);
      const lbl = this.add.text(0, r + 6, node.name, { fontSize: "12px", fontFamily: "monospace", color: "#cccccc" }).setOrigin(0.5, 0);
      if (node.id === this.currentNodeId) {
        const ring = this.add.circle(0, 0, r + 6).setStrokeStyle(2, C_CURRENT_RING, 0.9);
        c.add(ring);
      }
      c.add([dot, lbl]);
      c.setSize(r * 2, r * 2);
      c.setInteractive(new Phaser.Geom.Circle(0, 0, r + 4), Phaser.Geom.Circle.Contains);
      c.on("pointerover", () => { this.hoverNodeId = node.id; dot.setStrokeStyle(2, C_HOVER_RING, 1); this.input.setDefaultCursor("pointer"); });
      c.on("pointerout",  () => { this.hoverNodeId = null; dot.setStrokeStyle(2, 0, 0.5); this.input.setDefaultCursor("default"); });
      c.on("pointerdown", () => { this.onNodeClick(node); });
      this.nodeContainer.add(c);
      this.nodeMap.set(node.id, c);
    }
  }

  private setupUiCamera(): void {
    // Make the UI camera ignore the world-space layers (roads, nodes) so they
    // are only seen by the main camera, not duplicated.
    this.uiCam.ignore(this.roadGraphics);
    this.uiCam.ignore(this.nodeContainer);
  }

  private showError(msg: string): void {
    const t = this.add.text(this.scale.width / 2, this.scale.height / 2, msg, { fontSize: "18px", fontFamily: "monospace", color: "#ff6666" }).setOrigin(0.5);
    this.uiObjects.push(t);
  }

  private showFlash(msg: string, colour = 16744192): void {
    const t = this.add.text(this.scale.width / 2, 60, msg, { fontSize: "14px", fontFamily: "monospace", color: "#" + colour.toString(16).padStart(6, "0"), backgroundColor: "#111122", padding: { x: 12, y: 6 } }).setOrigin(0.5, 0).setDepth(100);
    this.uiObjects.push(t);
    this.time.delayedCall(2500, () => { t.destroy(); this.uiObjects = this.uiObjects.filter(x => x !== t); });
  }

  private onNodeClick(node: GeneratedSettlement): void {
    if (node.id === this.currentNodeId) { this.closeTravelPanel(); return; }
    const road = this.findRoad(this.currentNodeId, node.id);
    if (!road) { this.closeTravelPanel(); return; }
    this.selectedNodeId = node.id;
    this.selectedNode = node;
    this.selectedRoad = road;
    this.showTravelPanel(node, road);
  }

  private findRoad(a: string, b: string): GeneratedRoad | undefined {
    return this.region?.roads.find(r => (r.from === a && r.to === b) || (r.from === b && r.to === a));
  }

  // ── HTML Panel builders ───────────────────────────────────────────────────

  private buildTravelPanelHTML(): string {
    return `
      <div id="cw-travel-panel" style="pointer-events:auto;position:absolute;right:16px;top:50%;transform:translateY(-50%);
        width:280px;background:var(--panel);border:1px solid #333;display:none">
        <div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <div class="panel-node-name" id="travel-node-name" style="font-size:15px;color:var(--yellow);font-weight:bold;text-transform:uppercase"></div>
          <button style="background:none;border:none;color:var(--gray);font-size:18px;cursor:pointer;line-height:1"
                  data-action="close-travel-panel">✕</button>
        </div>
        <div style="padding:12px 14px;display:flex;flex-direction:column;gap:8px" id="travel-panel-body">
        </div>
        <div style="padding:12px 14px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:7px">
          <button class="btn btn-green" data-action="open-deploy">Deploy Squad</button>
          <button class="btn btn-red" data-action="travel-to">Travel There</button>
          <button class="btn btn-ghost" data-action="close-travel-panel">Cancel</button>
        </div>
      </div>`;
  }

  private buildDeployPanelHTML(): string {
    return `
      <div id="cw-deploy-panel" style="pointer-events:auto;position:absolute;right:16px;top:50%;transform:translateY(-50%);
        width:300px;background:var(--panel);border:1px solid #333;display:none">
        <div style="padding:12px 14px;border-bottom:1px solid var(--border)">
          <div style="font-size:15px;color:var(--yellow);font-weight:bold;text-transform:uppercase"
               id="deploy-node-name"></div>
          <div style="font-size:11px;color:var(--gray);margin-top:3px">Select vehicles · max 3 per zone</div>
        </div>
        <div id="deploy-vehicle-list" style="max-height:220px;overflow-y:auto"></div>
        <div style="padding:12px 14px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:7px">
          <button class="btn btn-green" data-action="attend-personally">Attend Personally →</button>
          <button class="btn btn-yellow" data-action="delegate-squad">Delegate to Squad</button>
          <button class="btn btn-ghost" data-action="close-deploy-panel">Cancel</button>
        </div>
      </div>`;
  }

  // ── HTML Panel show/hide ──────────────────────────────────────────────────

  private showTravelPanel(node: GeneratedSettlement, road: GeneratedRoad): void {
    const panel = this.panelRoot.querySelector('#cw-travel-panel') as HTMLElement | null;
    const deployPanel = this.panelRoot.querySelector('#cw-deploy-panel') as HTMLElement | null;
    if (!panel) return;

    const nameEl = this.panelRoot.querySelector('#travel-node-name') as HTMLElement | null;
    if (nameEl) nameEl.textContent = node.name;

    const dangerPct = Math.round(road.danger * 100);
    const dangerColor = dangerPct > 60 ? 'var(--red)' : dangerPct > 30 ? 'var(--amber)' : 'var(--green)';
    const bodyEl = this.panelRoot.querySelector('#travel-panel-body') as HTMLElement | null;
    if (bodyEl) {
      renderInto(bodyEl, `
        <div style="display:flex;justify-content:space-between;font-size:12px">
          <span style="color:var(--gray)">Distance</span>
          <span>${esc(road.distance)} miles</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:12px">
          <span style="color:var(--gray)">Road type</span>
          <span>${esc(road.roadType)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:12px">
          <span style="color:var(--gray)">Danger</span>
          <span style="color:${dangerColor}">${esc(dangerPct)}%</span>
        </div>`);
    }

    panel.style.display = 'block';
    if (deployPanel) deployPanel.style.display = 'none';
  }

  private closeTravelPanel(): void {
    const tp = this.panelRoot?.querySelector('#cw-travel-panel') as HTMLElement | null;
    const dp = this.panelRoot?.querySelector('#cw-deploy-panel') as HTMLElement | null;
    if (tp) tp.style.display = 'none';
    if (dp) dp.style.display = 'none';
    this.selectedNodeId = null;
    this.selectedNode = null;
    this.selectedRoad = null;
  }

  // ── Panel click handler ───────────────────────────────────────────────────

  private onPanelClick(e: MouseEvent): void {
    const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
    if (!action) return;

    switch (action) {
      case 'close-travel-panel':
        this.closeTravelPanel();
        break;

      case 'open-deploy': {
        const travelP = this.panelRoot.querySelector('#cw-travel-panel') as HTMLElement | null;
        const deployP = this.panelRoot.querySelector('#cw-deploy-panel') as HTMLElement | null;
        if (!this.selectedNode) break;
        if (travelP) travelP.style.display = 'none';
        if (deployP) deployP.style.display = 'block';
        // Populate node name in deploy header
        const deployName = this.panelRoot.querySelector('#deploy-node-name') as HTMLElement | null;
        if (deployName) deployName.textContent = this.selectedNode.name;
        void this.populateDeployVehicleList();
        break;
      }

      case 'close-deploy-panel': {
        const dp = this.panelRoot.querySelector('#cw-deploy-panel') as HTMLElement | null;
        const tp = this.panelRoot.querySelector('#cw-travel-panel') as HTMLElement | null;
        if (dp) dp.style.display = 'none';
        // Re-show travel panel if we still have a selected node
        if (tp && this.selectedNode && this.selectedRoad) tp.style.display = 'block';
        break;
      }

      case 'attend-personally': {
        const vehicleIds = Array.from(
          this.panelRoot.querySelectorAll<HTMLInputElement>('input[data-deploy-vehicle]:checked')
        ).map(cb => cb.dataset.deployVehicle!);
        this.doAttend(vehicleIds);
        break;
      }

      case 'delegate-squad': {
        const vehicleIds = Array.from(
          this.panelRoot.querySelectorAll<HTMLInputElement>('input[data-deploy-vehicle]:checked')
        ).map(cb => cb.dataset.deployVehicle!);
        if (!this.selectedNode) break;
        void this.doDeploy(this.selectedNode, vehicleIds);
        break;
      }

      case 'travel-to':
        void this.doTravel();
        break;
    }
  }

  // ── Deploy vehicle list ───────────────────────────────────────────────────

  private async populateDeployVehicleList(): Promise<void> {
    const listEl = this.panelRoot.querySelector('#deploy-vehicle-list') as HTMLElement | null;
    if (!listEl) return;

    renderInto(listEl, '<div style="padding:10px 14px;font-size:12px;color:var(--gray)">Loading…</div>');

    this.squadMembers = await this.fetchSquadComposition();
    const eligible = this.squadMembers.filter(m => this.isEligible(m));
    this.squadSelection = new Set(eligible.slice(0, 3).map(m => m.vehicleId));

    if (this.squadMembers.length === 0) {
      renderInto(listEl, '<div style="padding:10px 14px;font-size:12px;color:var(--amber)">No vehicles — build or buy one first.</div>');
      return;
    }

    const rows = this.squadMembers.slice(0, 6).map(m => {
      const eligible = this.isEligible(m);
      const checked = this.squadSelection.has(m.vehicleId) ? 'checked' : '';
      const disabled = eligible ? '' : 'disabled';
      const detail = eligible
        ? `${esc(m.driverName ?? '')} · sk${esc(m.driverSkill ?? 0)} · armour ${esc(m.armor)}`
        : `— ${esc(this.ineligibleReason(m))} —`;
      const detailClass = eligible ? 'squad-vdetail' : 'squad-vwarn';
      return `
        <div class="squad-check${eligible ? '' : ''}" style="padding:9px 14px;border-bottom:1px solid #181818;display:flex;align-items:flex-start;gap:10px;${eligible ? '' : 'opacity:0.45;'}">
          <input type="checkbox" ${checked} ${disabled}
                 data-deploy-vehicle="${esc(m.vehicleId)}"
                 style="accent-color:var(--green);width:15px;height:15px;margin-top:2px;${eligible ? 'cursor:pointer' : 'cursor:not-allowed'}">
          <div>
            <div class="squad-vname">${esc(m.vehicleName)}</div>
            <div class="${detailClass}">${detail}</div>
          </div>
        </div>`;
    }).join('');
    renderInto(listEl, rows);
  }

  // ── Preserved Phaser deploy-action methods ────────────────────────────────

  private nodeHasArena(node: GeneratedSettlement): boolean {
    return (node.services ?? []).includes("arena");
  }

  // Assignment a squad takes at a node when delegated: raids for arenas, jobs
  // where work is posted, otherwise a patrol.
  private deployAssignment(node: GeneratedSettlement): "patrol" | "job" | "raid" {
    if (this.nodeHasArena(node)) return "raid";
    if ((node.services ?? []).includes("jobs")) return "job";
    return "patrol";
  }

  // Fetch the player's vehicles + crew and pair them into a squad-composition
  // list, carrying each vehicle's availability status so the deploy panel can
  // show who can be sent and who's tied up.
  private async fetchSquadComposition(): Promise<SquadMember[]> {
    const host = window.location.hostname;
    const headers = { Authorization: "Bearer " + this.token };
    const [vRes, dRes] = await Promise.all([
      fetch("http://" + host + ":3001/api/vehicles", { headers }),
      fetch("http://" + host + ":3001/api/drivers", { headers }),
    ]);
    if (!vRes.ok || !dRes.ok) return [];
    const vehicles = await vRes.json();
    const drivers = await dRes.json();
    const driverByVid = new Map<string, { id: string; name: string; skill: number }>();
    for (const d of drivers) {
      if (d.alive && d.assigned_vehicle_id) driverByVid.set(d.assigned_vehicle_id, d);
    }
    return vehicles
      .filter((v: { damage_state?: { destroyed?: boolean } }) => !v.damage_state?.destroyed)
      .map((v: any): SquadMember => {
        const driver = driverByVid.get(v.id) ?? null;
        const armorFaces = (v.damage_state?.armor ?? {}) as Record<string, number>;
        const armor = Object.values(armorFaces).reduce((s, n) => s + (Number(n) || 0), 0);
        return {
          vehicleId: v.id,
          vehicleName: v.name,
          armor,
          driverId: driver?.id ?? null,
          driverName: driver?.name ?? null,
          driverSkill: driver?.skill ?? null,
          status: v.status ?? "available",
        };
      });
  }

  // A vehicle can join a squad only if it has a living crew and is idle.
  private isEligible(m: SquadMember): boolean {
    return !!m.driverId && m.status === "available";
  }

  // Why a vehicle can't be sent, for the greyed-out rows.
  private ineligibleReason(m: SquadMember): string {
    if (!m.driverId) return "no driver";
    if (m.status === "deployed") return "deployed";
    if (m.status === "on_job") return "on job";
    if (m.status === "in_arena") return "in arena";
    return "unavailable";
  }

  private doAttend(vehicleIds: string[]): void {
    if (!vehicleIds.length) { this.showFlash("Select at least one crewed vehicle", 0xff4444); return; }
    this.closeTravelPanel();
    this.scene.start("ArenaScene", {
      token: this.token,
      vehicleId: vehicleIds[0],
      squadVehicleIds: vehicleIds,
    });
  }

  private async doDeploy(node: GeneratedSettlement, vehicleIds: string[]): Promise<void> {
    if (!vehicleIds.length) { this.showFlash("Select at least one crewed vehicle", 0xff4444); return; }
    this.closeTravelPanel();
    try {
      const host = window.location.hostname;
      const res = await fetch("http://" + host + ":3001/api/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + this.token },
        body: JSON.stringify({ zoneId: node.id, vehicleIds, assignment: this.deployAssignment(node) }),
      });
      const data = await res.json();
      if (!res.ok) { this.showFlash(data.error ?? "Deploy failed", 0xff4444); return; }
      this.showFlash(`Squad of ${vehicleIds.length} deployed to ${node.name} — back in ~${fmtEta(data.etaSeconds)}`, 0x00ff88);
      // Surface the persistent indicator straight away.
      await this.fetchActiveDeployments();
      this.drawDeployments();
    } catch (e) {
      console.error("Deploy failed:", e);
      this.showFlash("Deploy failed - network error", 0xff4444);
    }
  }

  // ── Active-deployment indicator ───────────────────────────────────────────

  private async fetchActiveDeployments(): Promise<void> {
    try {
      const host = window.location.hostname;
      const res = await fetch("http://" + host + ":3001/api/deploy", {
        headers: { Authorization: "Bearer " + this.token },
      });
      if (!res.ok) return;
      const rows: Array<{ id: string; zone_id: string; job_id: string | null; status: string; eta_seconds: number }> = await res.json();
      // Only zone deployments belong on the world map; job-deployments (job_id set)
      // are surfaced on the Job Board instead.
      const inTransit = rows.filter(r => r.status === "in_transit" && !r.job_id);
      // Flash for any squad that resolved since the last poll.
      const liveIds = new Set(inTransit.map(r => r.id));
      for (const prev of this.deployments) {
        if (!liveIds.has(prev.id)) {
          this.showFlash(`Squad returned from ${prev.zoneName} — see Reports`, 0x00ff88);
        }
      }
      const nameOf = (id: string) => this.region?.settlements.find(n => n.id === id)?.name ?? id;
      this.deployments = inTransit.map(r => ({
        id: r.id,
        zoneId: r.zone_id,
        zoneName: nameOf(r.zone_id),
        resolvesAtMs: Date.now() + (r.eta_seconds ?? 0) * 1000,
      }));
    } catch (e) {
      console.error("fetchActiveDeployments failed:", e);
    }
  }

  // Per-second tick: refresh the countdowns; when one is due, re-poll so the
  // server resolves it and the marker clears.
  private async onDeploymentTick(): Promise<void> {
    if (!this.deployments.length) return;
    if (this.deployments.some(d => d.resolvesAtMs - Date.now() <= 0)) {
      await this.fetchActiveDeployments();
    }
    this.drawDeployments();
  }

  // Markers on deployed nodes + a top-left list with live ETAs.
  private drawDeployments(): void {
    if (!this.deploymentLayer) return;
    this.deploymentLayer.removeAll(true);
    if (!this.deployments.length) return;

    const now = Date.now();
    for (const dep of this.deployments) {
      const node = this.region?.settlements.find(n => n.id === dep.zoneId);
      if (!node) continue;
      const pos = this.toScreen(node.x, node.y);
      const remain = Math.max(0, Math.ceil((dep.resolvesAtMs - now) / 1000));
      this.deploymentLayer.add(this.add.circle(pos.x, pos.y, 18).setStrokeStyle(2, 0xffaa44, 0.9));
      this.deploymentLayer.add(this.add.text(pos.x, pos.y - 22, remain > 0 ? "⚙ " + fmtEta(remain) : "resolving…", {
        fontSize: "11px", fontFamily: "monospace", color: "#ffaa44", backgroundColor: "#221500", padding: { x: 3, y: 1 },
      }).setOrigin(0.5, 1));
    }

    const x = 20, top = 52;
    this.deploymentLayer.add(this.add.text(x, top, `ACTIVE DEPLOYMENTS (${this.deployments.length})`, {
      fontSize: "12px", fontFamily: "monospace", color: "#ffaa44", fontStyle: "bold",
    }));
    this.deployments.slice(0, 6).forEach((dep, i) => {
      const remain = Math.max(0, Math.ceil((dep.resolvesAtMs - now) / 1000));
      this.deploymentLayer!.add(this.add.text(x, top + 20 + i * 16,
        `• ${dep.zoneName} — ${remain > 0 ? fmtEta(remain) : "resolving…"}`,
        { fontSize: "11px", fontFamily: "monospace", color: "#ddbb88" }));
    });
  }

  private async doTravel(): Promise<void> {
    const toNodeId = this.selectedNodeId;
    if (!toNodeId) return;
    this.closeTravelPanel();
    try {
      const host = window.location.hostname;
      const res = await fetch("http://" + host + ":3001/api/world/travel", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + this.token },
        body: JSON.stringify({ toNodeId }),
      });
      const data = await res.json();
      if (!res.ok) { this.showFlash(data.error ?? "Travel failed"); return; }
      if (data.outcome === "arrived") {
        this.currentNodeId = data.currentNodeId;
        this.showFlash("Arrived at " + toNodeId);
        this.drawNodes();
      } else if (data.outcome === "encounter") {
        // Launch ArenaScene for the encounter
        try {
          const vRes = await fetch("http://" + host + ":3001/api/vehicles", {
            headers: { Authorization: "Bearer " + this.token },
          });
          if (vRes.ok) {
            const vehicles = await vRes.json();
            if (vehicles.length > 0) {
              this.scene.start("ArenaScene", {
                token: this.token,
                vehicleId: vehicles[0].id,
                squadVehicleIds: [vehicles[0].id],
                mapId: data.tacticalMapId,
                travelContext: { fromNodeId: this.currentNodeId, toNodeId: toNodeId },
              });
              return;
            }
          }
        } catch (e) {
          console.error("Failed to launch encounter:", e);
        }
        // Fallback if no vehicle or fetch fails
        this.showFlash(data.description, 0xff4444);
      } else {
        this.showFlash("Unknown travel outcome");
      }
    } catch (e) {
      console.error("Travel failed:", e);
      this.showFlash("Travel failed - network error");
    }
  }

  private onResize(): void {
    // Resize the Phaser canvas to fill the map area (viewport minus sidebar)
    const sidebarW = 220;
    const availW = window.innerWidth - sidebarW;
    const h = window.innerHeight;
    this.scale.resize(availW, h);
    this.uiCam.setSize(availW, h);

    this.computeTransform();
    this.drawRoads();
    this.drawNodes();
    this.drawDeployments();
  }
}

export { WorldMapScene };
