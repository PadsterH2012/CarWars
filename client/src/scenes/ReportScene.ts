import Phaser from "phaser";
import { bindFullscreenToggle, onLayout } from "../ui/responsive";

type Outcome = "success" | "partial" | "failure" | "routed";

interface PerDriver { driverId: string; driverName: string; status: "unharmed" | "wounded" | "dead"; kills: number; }
interface PerVehicle { vehicleId: string; name: string; damage: string; repairCost: number; }
interface ReportBody {
  zone: string; zoneName: string; assignment: string; encounter: string; summary: string;
  perDriver: PerDriver[]; vehicles: PerVehicle[];
  income: number; repairCost: number; net: number;
  rivalRepChange: { rivalId: string; rivalName: string; delta: number } | null;
}
interface ReportRow { id: string; zone_id: string; outcome: Outcome; report: ReportBody; read: boolean; created_at: string; }

const OUTCOME_COLOUR: Record<Outcome, string> = {
  success: "#00ff88",
  partial: "#ffcc00",
  failure: "#ff8844",
  routed: "#ff4444",
};
const STATUS_COLOUR: Record<PerDriver["status"], string> = {
  unharmed: "#88ccaa",
  wounded: "#ffcc00",
  dead: "#ff4444",
};

class ReportScene extends Phaser.Scene {
  private token = "";
  private reports: ReportRow[] = [];
  private selectedId: string | null = null;
  private layer!: Phaser.GameObjects.Container;

  constructor() { super({ key: "ReportScene" }); }

  init(data: { token: string }): void {
    this.token = data.token;
    this.reports = [];
    this.selectedId = null;
  }

  async create(): Promise<void> {
    bindFullscreenToggle(this);
    this.layer = this.add.container(0, 0);
    await this.fetchReports();
    if (this.reports.length && !this.selectedId) this.selectReport(this.reports[0]);
    this.render();
    onLayout(this, () => this.render());
  }

  private async fetchReports(): Promise<void> {
    try {
      const host = window.location.hostname;
      const res = await fetch(`http://${host}:3001/api/reports`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (res.ok) this.reports = (await res.json()).reports ?? [];
    } catch (e) {
      console.error("ReportScene fetchReports failed:", e);
    }
  }

  // Opening a report marks it read (server-side) so the garage badge clears.
  private selectReport(r: ReportRow): void {
    this.selectedId = r.id;
    if (!r.read) {
      r.read = true;
      const host = window.location.hostname;
      fetch(`http://${host}:3001/api/reports/${r.id}/read`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}` },
      }).catch(e => console.error("mark-read failed:", e));
    }
  }

  private render(): void {
    this.layer.removeAll(true);
    const { width, height } = this.scale;
    const add = (o: Phaser.GameObjects.GameObject) => { this.layer.add(o); return o; };

    add(this.add.text(20, 16, "AFTER-ACTION REPORTS", {
      fontSize: "22px", fontFamily: "monospace", color: "#ffcc00", fontStyle: "bold",
    }));
    const back = this.add.text(width - 20, 20, "[BACK]", {
      fontSize: "16px", fontFamily: "monospace", color: "#ff4444",
    }).setOrigin(1, 0).setInteractive({ useHandCursor: true });
    back.on("pointerdown", () => this.scene.start("GarageScene", { token: this.token }));
    add(back);

    if (!this.reports.length) {
      add(this.add.text(width / 2, height / 2, "No reports yet.\nSend a squad on a job or deploy from the World Map.", {
        fontSize: "16px", fontFamily: "monospace", color: "#888888", align: "center",
      }).setOrigin(0.5));
      return;
    }

    const listX = 20;
    const listW = Math.min(360, width * 0.34);
    const detailX = listX + listW + 24;
    let y = 60;

    for (const r of this.reports) {
      const colour = OUTCOME_COLOUR[r.outcome];
      const selected = r.id === this.selectedId;
      const rowH = 54;
      const bg = this.add.rectangle(listX, y, listW, rowH, selected ? 0x222233 : 0x14141c, 0.95)
        .setOrigin(0, 0).setStrokeStyle(1, selected ? 0x4444aa : 0x2a2a38, 1).setInteractive({ useHandCursor: true });
      bg.on("pointerdown", () => { this.selectReport(r); this.render(); });
      add(bg);
      if (!r.read) add(this.add.circle(listX + listW - 14, y + 14, 5, 0xff3333));
      add(this.add.text(listX + 10, y + 8, r.report.zoneName ?? r.zone_id, {
        fontSize: "14px", fontFamily: "monospace", color: "#dddddd", fontStyle: "bold",
      }));
      add(this.add.text(listX + 10, y + 30, `${r.outcome.toUpperCase()} · ${r.report.assignment ?? ""}`, {
        fontSize: "12px", fontFamily: "monospace", color: colour,
      }));
      y += rowH + 6;
      if (y > height - 60) break; // simple cap; full scroll is out of scope for Phase 4
    }

    const sel = this.reports.find(r => r.id === this.selectedId);
    if (sel) this.renderDetail(add, sel, detailX, 60, width - detailX - 20);
  }

  private renderDetail(
    add: (o: Phaser.GameObjects.GameObject) => Phaser.GameObjects.GameObject,
    r: ReportRow, x: number, top: number, w: number,
  ): void {
    const rep = r.report;
    const colour = OUTCOME_COLOUR[r.outcome];
    let y = top;

    add(this.add.text(x, y, `${rep.zoneName ?? r.zone_id} — ${r.outcome.toUpperCase()}`, {
      fontSize: "18px", fontFamily: "monospace", color: colour, fontStyle: "bold",
    }));
    y += 28;
    add(this.add.text(x, y, `Encounter: ${rep.encounter ?? "unknown"}`, {
      fontSize: "13px", fontFamily: "monospace", color: "#aaaaaa",
    }));
    y += 22;
    add(this.add.text(x, y, rep.summary ?? "", {
      fontSize: "13px", fontFamily: "monospace", color: "#cccccc",
      wordWrap: { width: w }, lineSpacing: 4,
    }));
    y += Math.max(40, (this.add.text(0, 0, rep.summary ?? "", { fontSize: "13px", fontFamily: "monospace", wordWrap: { width: w } }).setVisible(false).height) + 12);

    add(this.add.text(x, y, "CREW", { fontSize: "14px", fontFamily: "monospace", color: "#ffcc00", fontStyle: "bold" }));
    y += 22;
    for (const d of rep.perDriver ?? []) {
      add(this.add.text(x, y, `  ${d.driverName} — ${d.status}${d.kills ? ` · ${d.kills} kill(s)` : ""}`, {
        fontSize: "13px", fontFamily: "monospace", color: STATUS_COLOUR[d.status],
      }));
      y += 20;
    }

    y += 6;
    add(this.add.text(x, y, "VEHICLES", { fontSize: "14px", fontFamily: "monospace", color: "#ffcc00", fontStyle: "bold" }));
    y += 22;
    for (const v of rep.vehicles ?? []) {
      const repair = v.repairCost > 0 ? ` · repair $${v.repairCost.toLocaleString()}` : "";
      add(this.add.text(x, y, `  ${v.name} — ${v.damage}${repair}`, {
        fontSize: "13px", fontFamily: "monospace", color: v.damage === "wrecked" ? "#ff4444" : "#cccccc",
      }));
      y += 20;
    }

    y += 10;
    const netColour = rep.net >= 0 ? "#00ff88" : "#ff8844";
    add(this.add.text(x, y, `Income $${rep.income.toLocaleString()} − repairs $${rep.repairCost.toLocaleString()} = `, {
      fontSize: "14px", fontFamily: "monospace", color: "#cccccc",
    }));
    const prefixW = this.add.text(0, 0, `Income $${rep.income.toLocaleString()} − repairs $${rep.repairCost.toLocaleString()} = `, { fontSize: "14px", fontFamily: "monospace" }).setVisible(false).width;
    add(this.add.text(x + prefixW, y, `${rep.net >= 0 ? "+" : ""}$${rep.net.toLocaleString()}`, {
      fontSize: "14px", fontFamily: "monospace", color: netColour, fontStyle: "bold",
    }));
    y += 26;

    if (rep.rivalRepChange) {
      const rc = rep.rivalRepChange;
      add(this.add.text(x, y, `Rival: ${rc.rivalName} — grudge ${rc.delta >= 0 ? "+" : ""}${rc.delta}`, {
        fontSize: "13px", fontFamily: "monospace", color: "#ff88aa",
      }));
    }
  }
}

export { ReportScene };
