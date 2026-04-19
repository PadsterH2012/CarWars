import Phaser from 'phaser';
import type { ZoneState, SquadOrder } from '@carwars/shared';

// Tactical commander view — shown as an overlay on top of the paused ArenaScene.
// Player clicks a squadmate to select them, then clicks a target or spot to issue an
// order. F = follow primary, R = retreat, C = clear order, T/Esc = close and resume.

interface InitData {
  zoneState: ZoneState | null;
  myVehicleId: string;
  squadVehicleIds: string[];
  sendOrder: (vehicleId: string, order: SquadOrder) => void;
  onClose: () => void;
}

const PANEL_W = 800;
const PANEL_H = 560;
const MAP_SCALE = 6; // pixels per world unit in the overlay map

export class TacticalOverlay extends Phaser.Scene {
  private cmdData!: InitData;
  private selectedSquadmate: string | null = null;
  private cleanup: Phaser.GameObjects.GameObject[] = [];

  constructor() { super({ key: 'TacticalOverlay' }); }

  init(d: InitData): void {
    this.cmdData = d;
    this.selectedSquadmate = null;
    this.cleanup = [];
  }

  create(): void {
    const { width, height } = this.scale;
    const cx = width / 2;
    const cy = height / 2;

    const overlay = this.add.rectangle(cx, cy, width, height, 0x000000, 0.85).setInteractive();
    const panel   = this.add.rectangle(cx, cy, PANEL_W, PANEL_H, 0x111122, 0.98).setStrokeStyle(2, 0x4466aa);
    const title   = this.add.text(cx, cy - PANEL_H / 2 + 20, 'TACTICAL — COMMANDER MODE', {
      color: '#ffcc00', fontSize: '18px', fontFamily: 'monospace', fontStyle: 'bold'
    }).setOrigin(0.5);
    const hint = this.add.text(cx, cy - PANEL_H / 2 + 46,
      'Click squadmate to select  |  click enemy = ATTACK  |  click ground = MOVE  |  F = Follow  |  R = Retreat  |  C = Clear  |  T/Esc = resume',
      { color: '#888', fontSize: '11px', fontFamily: 'monospace' }
    ).setOrigin(0.5);

    this.cleanup.push(overlay, panel, title, hint);

    this.drawTactical();

    const K = Phaser.Input.Keyboard.KeyCodes;
    const close = () => this.closeOverlay();
    this.input.keyboard!.addKey(K.ESC, false).on('down', close);
    this.input.keyboard!.addKey(K.T, false).on('down', close);

    this.input.keyboard!.addKey(K.F, false).on('down', () => {
      if (this.selectedSquadmate) {
        this.cmdData.sendOrder(this.selectedSquadmate, { type: 'follow', leaderId: this.cmdData.myVehicleId });
        this.flashFeedback(`${this.selectedSquadmate.slice(0, 8)}: FOLLOW`);
      }
    });
    this.input.keyboard!.addKey(K.R, false).on('down', () => {
      if (this.selectedSquadmate) {
        this.cmdData.sendOrder(this.selectedSquadmate, { type: 'retreat' });
        this.flashFeedback(`${this.selectedSquadmate.slice(0, 8)}: RETREAT`);
      }
    });
    this.input.keyboard!.addKey(K.C, false).on('down', () => {
      if (this.selectedSquadmate) {
        this.cmdData.sendOrder(this.selectedSquadmate, { type: 'clear' });
        this.flashFeedback(`${this.selectedSquadmate.slice(0, 8)}: ORDER CLEARED`);
      }
    });
  }

  private closeOverlay(): void {
    this.cmdData.onClose();
    this.cleanup.forEach(o => o.destroy());
    this.scene.stop();
  }

  private flashFeedback(text: string): void {
    const cx = this.scale.width / 2;
    const y = this.scale.height / 2 + PANEL_H / 2 - 20;
    const t = this.add.text(cx, y, text, {
      color: '#00ff88', fontSize: '13px', fontFamily: 'monospace',
      backgroundColor: '#001a11', padding: { x: 8, y: 4 },
    }).setOrigin(0.5);
    this.time.delayedCall(1200, () => t.destroy());
  }

  private drawTactical(): void {
    const state = this.cmdData.zoneState;
    if (!state) return;
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;

    const wallGfx = this.add.graphics();
    wallGfx.fillStyle(0x334466, 1);
    (state.walls ?? []).forEach(w => {
      const px = cx + w.x * MAP_SCALE - (w.w * MAP_SCALE) / 2;
      const py = cy + w.y * MAP_SCALE - (w.h * MAP_SCALE) / 2;
      wallGfx.fillRect(px, py, w.w * MAP_SCALE, w.h * MAP_SCALE);
    });
    this.cleanup.push(wallGfx);

    (state.wreckage ?? []).forEach(w => {
      const px = cx + w.position.x * MAP_SCALE;
      const py = cy + w.position.y * MAP_SCALE;
      const color = w.state === 'burning' ? 0xff6622 : w.state === 'smouldering' ? 0x664422 : 0x333333;
      this.cleanup.push(this.add.circle(px, py, 4, color, 0.8));
    });

    state.vehicles.forEach(v => {
      const isEnemy = v.playerId === 'ai-team';
      const isSquad = this.cmdData.squadVehicleIds.includes(v.id);
      if (!isEnemy && !isSquad) return;

      const px = cx + v.position.x * MAP_SCALE;
      const py = cy + v.position.y * MAP_SCALE;
      const isMe = v.id === this.cmdData.myVehicleId;
      const color = isEnemy ? 0xff4444 : isMe ? 0x00ff88 : 0x66cc88;

      const dot = this.add.circle(px, py, 7, color, 0.95).setStrokeStyle(1, 0xffffff).setInteractive();
      const label = this.add.text(px + 10, py - 8, v.id.slice(0, 6), {
        color: '#ccc', fontSize: '10px', fontFamily: 'monospace'
      });
      this.cleanup.push(dot, label);

      dot.on('pointerdown', () => {
        if (isEnemy) {
          if (this.selectedSquadmate) {
            this.cmdData.sendOrder(this.selectedSquadmate, { type: 'attack', targetId: v.id });
            this.flashFeedback(`${this.selectedSquadmate.slice(0, 8)}: ATTACK ${v.id.slice(0, 6)}`);
          }
        } else if (isSquad && !isMe) {
          this.selectedSquadmate = v.id;
          this.flashFeedback(`Selected: ${v.id.slice(0, 8)} — click target or press F/R/C`);
        }
      });
    });

    const clickCatcher = this.add.rectangle(cx, cy, this.scale.width, this.scale.height, 0x000000, 0.01).setInteractive();
    clickCatcher.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (!this.selectedSquadmate) return;
      const worldX = (p.x - cx) / MAP_SCALE;
      const worldY = (p.y - cy) / MAP_SCALE;
      this.cmdData.sendOrder(this.selectedSquadmate, { type: 'move', x: worldX, y: worldY });
      this.flashFeedback(`${this.selectedSquadmate.slice(0, 8)}: MOVE to (${worldX.toFixed(0)}, ${worldY.toFixed(0)})`);
    });
    this.cleanup.unshift(clickCatcher);
  }
}
