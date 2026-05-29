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

  // The "attend personally" choice (Phase 4 Task 4). For an arena node the
  // player picks between fighting in person (ArenaScene) or delegating to a
  // headless squad engagement; non-arena nodes only offer delegation.
  private openDeployPanel(node: WorldNode): void {
    this.closeTravelPanel();
    const hasArena = this.nodeHasArena(node);
    const pw = 340, ph = hasArena ? 260 : 210;
    const px = (this.scale.width - pw) / 2, py = (this.scale.height - ph) / 2;
    const panel = this.add.container(px, py);
    const bg = this.add.rectangle(0, 0, pw, ph, C_PANEL_BG, 0.97).setOrigin(0, 0).setStrokeStyle(2, 0x444466, 1);
    panel.add(bg);
    panel.add(this.add.text(pw / 2, 14, "Deploy to " + node.name, { fontSize: "16px", fontFamily: "monospace", color: "#ffcc00", fontStyle: "bold" }).setOrigin(0.5, 0));

    if (hasArena) {
      const attendBtn = this.add.text(20, 50, "[ ATTEND PERSONALLY ]", { fontSize: "14px", fontFamily: "monospace", color: "#00ff88", backgroundColor: "#003322", padding: { x: 8, y: 5 } }).setInteractive({ useHandCursor: true });
      attendBtn.on("pointerdown", () => { this.doAttend(node); });
      panel.add(attendBtn);
      panel.add(this.add.text(20, 84, "Higher chance of victory, earn XP,\nbut you risk your driver in real-time.", { fontSize: "12px", fontFamily: "monospace", color: "#88ccaa", lineSpacing: 3 }));

      const delegateBtn = this.add.text(20, 134, "[ DELEGATE TO SQUAD ]", { fontSize: "14px", fontFamily: "monospace", color: "#ffaa44", backgroundColor: "#332211", padding: { x: 8, y: 5 } }).setInteractive({ useHandCursor: true });
      delegateBtn.on("pointerdown", () => { this.doDeploy(node); });
      panel.add(delegateBtn);
      panel.add(this.add.text(20, 168, "Squad resolves automatically while you\ndo other things. Lower success rate.", { fontSize: "12px", fontFamily: "monospace", color: "#ddbb88", lineSpacing: 3 }));
    } else {
      panel.add(this.add.text(20, 52, "Send your squad to run a " + this.deployAssignment(node) + "\nhere. They resolve automatically and\nreturn with an after-action report.", { fontSize: "12px", fontFamily: "monospace", color: "#aaaaaa", lineSpacing: 3 }));
      const deployBtn = this.add.text(20, 124, "[ DEPLOY SQUAD ]", { fontSize: "14px", fontFamily: "monospace", color: "#ffaa44", backgroundColor: "#332211", padding: { x: 8, y: 5 } }).setInteractive({ useHandCursor: true });
      deployBtn.on("pointerdown", () => { this.doDeploy(node); });
      panel.add(deployBtn);
    }

    const cancelBtn = this.add.text(pw - 20, ph - 28, "[CANCEL]", { fontSize: "13px", fontFamily: "monospace", color: "#ff4444" }).setOrigin(1, 0.5).setInteractive({ useHandCursor: true });
    cancelBtn.on("pointerdown", () => { this.closeTravelPanel(); });
    panel.add(cancelBtn);

    this.travelPanel = panel;
    this.uiObjects.push(panel);
  }

  // Fetch up to 4 of the player's intact vehicles to crew a squad.
  private async fetchSquadVehicleIds(): Promise<string[]> {
    const host = window.location.hostname;
    const res = await fetch("http://" + host + ":3001/api/vehicles", { headers: { Authorization: "Bearer " + this.token } });
    if (!res.ok) return [];
    const vehicles = await res.json();
    return vehicles
      .filter((v: { damage_state?: { destroyed?: boolean }; in_arena?: boolean }) => !v.damage_state?.destroyed && !v.in_arena)
      .slice(0, 4)
      .map((v: { id: string }) => v.id);
  }

  private async doAttend(node: WorldNode): Promise<void> {
    this.closeTravelPanel();
    const vehicleIds = await this.fetchSquadVehicleIds();
    if (!vehicleIds.length) { this.showFlash("No available vehicles to attend with", 0xff4444); return; }
    this.scene.start("ArenaScene", {
      token: this.token,
      vehicleId: vehicleIds[0],
      squadVehicleIds: vehicleIds,
    });
  }

  private async doDeploy(node: WorldNode): Promise<void> {
    this.closeTravelPanel();
    const vehicleIds = await this.fetchSquadVehicleIds();
    if (!vehicleIds.length) { this.showFlash("No available vehicles to deploy", 0xff4444); return; }
    try {
      const host = window.location.hostname;
      const res = await fetch("http://" + host + ":3001/api/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + this.token },
        body: JSON.stringify({ zoneId: node.id, vehicleIds, assignment: this.deployAssignment(node) }),
      });
      const data = await res.json();
      if (!res.ok) { this.showFlash(data.error ?? "Deploy failed", 0xff4444); return; }
      this.showFlash("Squad deployed to " + node.name + " — back in ~" + data.etaSeconds + "s", 0x00ff88);
    } catch (e) {
      console.error("Deploy failed:", e);
      this.showFlash("Deploy failed - network error", 0xff4444);
    }
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
  }
}

export { WorldMapScene };
