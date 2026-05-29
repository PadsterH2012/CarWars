import Phaser from "phaser";
import type { WorldRegion, WorldNode, WorldRoad } from "@carwars/shared";
import { bindFullscreenToggle, onLayout } from "../ui/responsive";

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
const C_PANEL_BG     = 0x0f0f18;

function nodeColour(kind: WorldNode["kind"]): number {
  switch (kind) {
    case "city":       return C_NODE_CITY;
    case "town":       return C_NODE_TOWN;
    case "truck_stop": return C_NODE_TRUCK_STOP;
    case "arena":      return C_NODE_ARENA;
    case "garage":     return C_NODE_GARAGE;
    case "market":     return C_NODE_MARKET;
    default:           return 0xaaaaaa;
  }
}

function roadColour(kind: WorldRoad["roadType"]): number {
  switch (kind) {
    case "highway": return C_ROAD_HIGHWAY;
    case "urban":   return C_ROAD_URBAN;
    case "dirt":    return C_ROAD_DIRT;
    case "mountain":return C_ROAD_MOUNTAIN;
    default:        return 0x444444;
  }
}

function roadWidth(kind: WorldRoad["roadType"]): number {
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
  private region: WorldRegion | null = null;
  private currentNodeId = "midville-city";

  private roadGraphics!: Phaser.GameObjects.Graphics;
  private nodeContainer!: Phaser.GameObjects.Container;
  private uiCam!: Phaser.Cameras.Scene2D.Camera;
  private uiObjects: Phaser.GameObjects.GameObject[] = [];

  private nodeMap = new Map<string, Phaser.GameObjects.Container>();
  private hoverNodeId: string | null = null;
  private selectedNodeId: string | null = null;
  private travelPanel: Phaser.GameObjects.Container | null = null;

  // Persistent "squads currently out" indicator (markers + list + countdown).
  private deployments: ActiveDeployment[] = [];
  private deploymentLayer: Phaser.GameObjects.Container | null = null;
  private deploymentTimer: Phaser.Time.TimerEvent | null = null;
  // Working set of vehicle ids selected in the open deploy panel.
  private squadSelection = new Set<string>();

  private worldScale = 1;
  private worldOffsetX = 0;
  private worldOffsetY = 0;

  constructor() { super({ key: "WorldMapScene" }); }

  init(data: { token: string }): void {
    this.token = data.token;
    this.region = null;
    this.nodeMap.clear();
    this.hoverNodeId = null;
    this.selectedNodeId = null;
    this.travelPanel = null;
    this.uiObjects = [];
    this.deployments = [];
    this.deploymentLayer = null;
    this.deploymentTimer = null;
    this.squadSelection = new Set();
  }

  async create(): Promise<void> {
    bindFullscreenToggle(this);
    this.roadGraphics = this.add.graphics();
    this.nodeContainer = this.add.container(0, 0);
    this.uiCam = this.cameras.add(0, 0, this.scale.width, this.scale.height, false, "ui");

    await this.fetchRegion();
    if (!this.region) {
      this.showError("Failed to load world map");
      return;
    }

    // Fetch actual player location from server
    await this.fetchCurrentLocation();

    this.computeTransform();
    this.drawRoads();
    this.drawNodes();
    this.paintTitle();
    this.paintBackButton();

    // Persistent "squads out on deployment" indicator: markers on the target
    // nodes plus a list with live countdowns. Re-fetched when one comes due so
    // the marker clears and the player is nudged toward the Reports screen.
    this.deploymentLayer = this.add.container(0, 0);
    this.uiCam.ignore(this.deploymentLayer);
    await this.fetchActiveDeployments();
    this.drawDeployments();
    this.deploymentTimer = this.time.addEvent({
      delay: 1000, loop: true, callback: () => { void this.onDeploymentTick(); },
    });

    onLayout(this, () => this.onResize());
  }

  private async fetchRegion(): Promise<void> {
    try {
      const host = window.location.hostname;
      const res = await fetch(`http://${host}:3001/api/world/regions/midville`, {
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

  private computeTransform(): void {
    if (!this.region || this.region.nodes.length === 0) return;
    const xs = this.region.nodes.map(n => n.x);
    const ys = this.region.nodes.map(n => n.y);
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
      const a = this.region.nodes.find(n => n.id === road.from);
      const b = this.region.nodes.find(n => n.id === road.to);
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
    for (const node of this.region.nodes) {
      const pos = this.toScreen(node.x, node.y);
      const c = this.add.container(pos.x, pos.y);
      const r = node.kind === "city" ? 14 : 10;
      const dot = this.add.circle(0, 0, r, nodeColour(node.kind)).setStrokeStyle(2, 0, 0.5);
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

  private paintTitle(): void {
    const t = this.add.text(20, 16, "MIDVILLE REGION", { fontSize: "22px", fontFamily: "monospace", color: "#ffcc00", fontStyle: "bold" });
    this.uiObjects.push(t);
    this.uiCam.ignore(this.roadGraphics);
    this.uiCam.ignore(this.nodeContainer);
  }

  private paintBackButton(): void {
    const btn = this.add.text(this.scale.width - 20, 20, "[BACK]", { fontSize: "16px", fontFamily: "monospace", color: "#ff4444" }).setOrigin(1, 0).setInteractive({ useHandCursor: true });
    btn.on("pointerdown", () => { this.scene.start("GarageScene", { token: this.token }); });
    this.uiObjects.push(btn);
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

  private onNodeClick(node: WorldNode): void {
    if (node.id === this.currentNodeId) { this.closeTravelPanel(); return; }
    const road = this.findRoad(this.currentNodeId, node.id);
    if (!road) { this.closeTravelPanel(); return; }
    this.selectedNodeId = node.id;
    this.openTravelPanel(node, road);
  }

  private findRoad(a: string, b: string): WorldRoad | undefined {
    return this.region?.roads.find(r => (r.from === a && r.to === b) || (r.from === b && r.to === a));
  }

  private openTravelPanel(node: WorldNode, road: WorldRoad): void {
    this.closeTravelPanel();
    const pw = 280, ph = 214;
    const px = (this.scale.width - pw) / 2, py = (this.scale.height - ph) / 2;
    const panel = this.add.container(px, py);
    const bg = this.add.rectangle(0, 0, pw, ph, C_PANEL_BG, 0.95).setOrigin(0, 0).setStrokeStyle(2, 0x333344, 1);
    panel.add(bg);
    const title = this.add.text(pw / 2, 16, node.name, { fontSize: "16px", fontFamily: "monospace", color: "#ffcc00", fontStyle: "bold" }).setOrigin(0.5, 0);
    panel.add(title);
    let y = 50;
    for (const line of ["Distance: " + road.distance + " miles", "Road: " + road.roadType, "Danger: " + Math.round(road.danger * 100) + "%"]) {
      panel.add(this.add.text(20, y, line, { fontSize: "13px", fontFamily: "monospace", color: "#aaaaaa" }));
      y += 22;
    }
    // Send a squad to operate here without moving the player (Phase 4).
    const deployBtn = this.add.text(pw / 2, ph - 74, "[DEPLOY SQUAD]", { fontSize: "14px", fontFamily: "monospace", color: "#ffaa44", backgroundColor: "#332211", padding: { x: 8, y: 4 } }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    deployBtn.on("pointerdown", () => { this.openDeployPanel(node); });
    panel.add(deployBtn);
    const travelBtn = this.add.text(pw / 2 - 60, ph - 36, "[TRAVEL]", { fontSize: "14px", fontFamily: "monospace", color: "#00ff88" }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    travelBtn.on("pointerdown", () => { this.doTravel(node.id); });
    const cancelBtn = this.add.text(pw / 2 + 60, ph - 36, "[CANCEL]", { fontSize: "14px", fontFamily: "monospace", color: "#ff4444" }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    cancelBtn.on("pointerdown", () => { this.closeTravelPanel(); });
    panel.add([travelBtn, cancelBtn]);
    this.travelPanel = panel;
    this.uiObjects.push(panel);
  }

  private nodeHasArena(node: WorldNode): boolean {
    return node.kind === "arena" || (node.services ?? []).includes("arena");
  }

  // Assignment a squad takes at a node when delegated: raids for arenas, jobs
  // where work is posted, otherwise a patrol.
  private deployAssignment(node: WorldNode): "patrol" | "job" | "raid" {
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

  // Deploy panel (Phase 4, reworked for issue #7). Shows the squad composition
  // — each vehicle, its armour, and its crew — with the eligible ones toggled
  // on by default (capped at 4). Arena nodes also offer attending in person.
  private async openDeployPanel(node: WorldNode): Promise<void> {
    this.closeTravelPanel();
    const members = await this.fetchSquadComposition();
    const eligible = members.filter(m => this.isEligible(m));
    this.squadSelection = new Set(eligible.slice(0, 4).map(m => m.vehicleId));

    const hasArena = this.nodeHasArena(node);
    const pw = 440;
    const rowH = 34;
    const listTop = 92;
    const visible = members.slice(0, 6);
    const footer = hasArena ? 104 : 64;
    // Reserve a line below the rows for the "nobody available" hint when there
    // are vehicles but none can deploy (otherwise it would overlap the rows).
    const hintRows = (members.length > 0 && eligible.length === 0) ? 1 : 0;
    const ph = listTop + Math.max(1, visible.length) * rowH + hintRows * 30 + footer;
    const px = (this.scale.width - pw) / 2, py = (this.scale.height - ph) / 2;

    const panel = this.add.container(px, py);
    const bg = this.add.rectangle(0, 0, pw, ph, C_PANEL_BG, 0.98).setOrigin(0, 0).setStrokeStyle(2, 0x444466, 1);
    panel.add(bg);
    panel.add(this.add.text(pw / 2, 12, "Deploy to " + node.name, { fontSize: "16px", fontFamily: "monospace", color: "#ffcc00", fontStyle: "bold" }).setOrigin(0.5, 0));
    panel.add(this.add.text(pw / 2, 36, "Assignment: " + this.deployAssignment(node) + " · max 4", { fontSize: "12px", fontFamily: "monospace", color: "#88aacc" }).setOrigin(0.5, 0));
    panel.add(this.add.text(20, 62, "SQUAD COMPOSITION — tap to toggle", { fontSize: "11px", fontFamily: "monospace", color: "#888899" }));

    // Buttons declared up front so the row toggles can re-enable/disable them.
    const attendBtn = hasArena
      ? this.add.text(20, ph - 84, "[ ATTEND PERSONALLY ]", { fontSize: "13px", fontFamily: "monospace", color: "#00ff88", backgroundColor: "#003322", padding: { x: 8, y: 5 } })
      : null;
    const deployBtn = this.add.text(20, ph - (hasArena ? 44 : 44), hasArena ? "[ DELEGATE TO SQUAD ]" : "[ DEPLOY SQUAD ]", { fontSize: "13px", fontFamily: "monospace", color: "#ffaa44", backgroundColor: "#332211", padding: { x: 8, y: 5 } });

    const refreshButtons = () => {
      const n = this.squadSelection.size;
      const ok = n > 0;
      deployBtn.setAlpha(ok ? 1 : 0.4);
      if (ok) deployBtn.setInteractive({ useHandCursor: true }); else deployBtn.disableInteractive();
      deployBtn.setText((hasArena ? "[ DELEGATE TO SQUAD" : "[ DEPLOY SQUAD") + (n ? ` — ${n} ]` : " ]"));
      if (attendBtn) {
        attendBtn.setAlpha(ok ? 1 : 0.4);
        if (ok) attendBtn.setInteractive({ useHandCursor: true }); else attendBtn.disableInteractive();
      }
    };

    // No vehicles at all → a single message where the rows would be.
    if (members.length === 0) {
      panel.add(this.add.text(20, listTop, "No vehicles. Build or buy one first.", {
        fontSize: "12px", fontFamily: "monospace", color: "#ffaa44",
      }));
    }

    visible.forEach((m, i) => {
      const y = listTop + i * rowH;
      const eligibleRow = this.isEligible(m);
      const marker = this.add.text(20, y, "[ ]", { fontSize: "14px", fontFamily: "monospace", color: "#666" });
      const nameTxt = this.add.text(54, y, `${m.vehicleName}  (armor ${m.armor})`, { fontSize: "13px", fontFamily: "monospace", color: "#cccccc" });
      const crewTxt = this.add.text(54, y + 15, eligibleRow
        ? `Driver: ${m.driverName} (sk${m.driverSkill})`
        : `— ${this.ineligibleReason(m)} —`,
        { fontSize: "10px", fontFamily: "monospace", color: eligibleRow ? "#88ccff" : "#ff8855" });

      const paint = () => {
        const on = this.squadSelection.has(m.vehicleId);
        marker.setText(on ? "[X]" : "[ ]").setColor(on ? "#00ff88" : "#666");
        nameTxt.setColor(eligibleRow ? (on ? "#00ff88" : "#cccccc") : "#666677");
      };
      paint();

      if (eligibleRow) {
        const hit = this.add.rectangle(16, y - 2, pw - 32, rowH - 4, 0x000000, 0).setOrigin(0, 0).setInteractive({ useHandCursor: true });
        hit.on("pointerdown", () => {
          if (this.squadSelection.has(m.vehicleId)) this.squadSelection.delete(m.vehicleId);
          else if (this.squadSelection.size < 4) this.squadSelection.add(m.vehicleId);
          paint();
          refreshButtons();
        });
        panel.add(hit);
      } else {
        marker.setText("—").setColor("#444");
      }
      panel.add([marker, nameTxt, crewTxt]);
    });

    // Vehicles exist but all are tied up → a hint below the rows.
    if (members.length > 0 && eligible.length === 0) {
      panel.add(this.add.text(20, listTop + visible.length * rowH + 4,
        "No idle crewed vehicles — assign a driver or wait for a squad to return.",
        { fontSize: "11px", fontFamily: "monospace", color: "#ffaa44", wordWrap: { width: pw - 40 }, lineSpacing: 3 }));
    }

    if (attendBtn) {
      attendBtn.on("pointerdown", () => { this.doAttend([...this.squadSelection]); });
      panel.add(attendBtn);
      panel.add(this.add.text(232, ph - 80, "Fight in real time.\nHigher reward, real risk.", { fontSize: "10px", fontFamily: "monospace", color: "#88ccaa", lineSpacing: 2 }));
    }
    deployBtn.on("pointerdown", () => { this.doDeploy(node, [...this.squadSelection]); });
    panel.add(deployBtn);
    if (!hasArena) {
      panel.add(this.add.text(232, ph - 44, "Resolves automatically;\nreturns a report.", { fontSize: "10px", fontFamily: "monospace", color: "#ddbb88", lineSpacing: 2 }));
    }
    refreshButtons();

    const cancelBtn = this.add.text(pw - 20, 64, "[CANCEL]", { fontSize: "12px", fontFamily: "monospace", color: "#ff4444" }).setOrigin(1, 0).setInteractive({ useHandCursor: true });
    cancelBtn.on("pointerdown", () => { this.closeTravelPanel(); });
    panel.add(cancelBtn);

    this.travelPanel = panel;
    this.uiObjects.push(panel);
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

  private async doDeploy(node: WorldNode, vehicleIds: string[]): Promise<void> {
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
      const rows: Array<{ id: string; zone_id: string; status: string; eta_seconds: number }> = await res.json();
      const inTransit = rows.filter(r => r.status === "in_transit");
      // Flash for any squad that resolved since the last poll.
      const liveIds = new Set(inTransit.map(r => r.id));
      for (const prev of this.deployments) {
        if (!liveIds.has(prev.id)) {
          this.showFlash(`Squad returned from ${prev.zoneName} — see Reports`, 0x00ff88);
        }
      }
      const nameOf = (id: string) => this.region?.nodes.find(n => n.id === id)?.name ?? id;
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
      const node = this.region?.nodes.find(n => n.id === dep.zoneId);
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

  private closeTravelPanel(): void {
    if (this.travelPanel) {
      this.travelPanel.destroy();
      this.travelPanel = null;
      this.selectedNodeId = null;
    }
  }

  private async doTravel(toNodeId: string): Promise<void> {
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
    this.uiCam.setSize(this.scale.width, this.scale.height);
    for (const obj of this.uiObjects) {
      if (obj instanceof Phaser.GameObjects.Text && obj.text === "[BACK]") {
        obj.setPosition(this.scale.width - 20, 20);
      }
    }
    if (this.travelPanel) {
      this.travelPanel.setPosition((this.scale.width - 280) / 2, (this.scale.height - 180) / 2);
    }
    this.computeTransform();
    this.drawRoads();
    this.drawNodes();
    this.drawDeployments();
  }
}

export { WorldMapScene };
