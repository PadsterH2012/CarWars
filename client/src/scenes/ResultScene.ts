import Phaser from 'phaser';
import { bindFullscreenToggle, onLayout } from '../ui/responsive';
import type { RivalInfo } from '@carwars/shared';

export type ResultOutcome = 'win' | 'loss' | 'draw' | 'destroyed';

export interface ResultSceneData {
  token: string;
  result: ResultOutcome;
  prize: number;
  jobPayout: number;
  salvage: number;
  wages: number;
  maintenance: number;
  rival?: RivalInfo;
  rivalQuote?: string;
  // Squad vehicle ids — used by [REPAIR & RETURN] to repair every vehicle that
  // fought, and to re-enter the same fight composition.
  vehicleIds: string[];
  primaryVehicleId: string;
  // mapId / gangPrimaryColour are echoed straight back into ArenaScene init data
  // so [REPAIR & RETURN] returns to the same arena visuals.
  mapId?: string;
  gangPrimaryColour?: number;
  replayId?: string;
}

export class ResultScene extends Phaser.Scene {
  private payload!: ResultSceneData;
  private layer!: Phaser.GameObjects.Container;

  constructor() { super({ key: 'ResultScene' }); }

  init(data: ResultSceneData): void {
    this.payload = data;
  }

  create(): void {
    this.layer = this.add.container(0, 0);
    bindFullscreenToggle(this);
    onLayout(this, () => this.render());
    this.render();
  }

  private render(): void {
    this.layer.removeAll(true);
    const { width, height } = this.scale;
    const cx = width / 2;
    const add = (obj: Phaser.GameObjects.GameObject) => { this.layer.add(obj); return obj; };

    // Background — solid dark with a translucent strip behind the P&L
    add(this.add.rectangle(cx, height / 2, width, height, 0x0a0a14, 1));

    // Title — big, full-width, position at the top third
    const { title, color } = this.titleFor(this.payload.result);
    const titleY = Math.max(80, height * 0.16);
    add(this.add.text(cx, titleY, title, {
      fontSize: '72px', color, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5));

    let y = titleY + 70;

    // Rival banner + quote — coloured by the rival's primary colour
    if (this.payload.rival) {
      const rivalColor = '#' + this.payload.rival.primary_colour.toString(16).padStart(6, '0');
      add(this.add.text(cx, y, `vs. ${this.payload.rival.name}`, {
        fontSize: '20px', color: rivalColor, fontFamily: 'monospace', fontStyle: 'italic',
      }).setOrigin(0.5));
      y += 28;
      if (this.payload.rivalQuote) {
        const quote = add(this.add.text(cx, y, `"${this.payload.rivalQuote}"`, {
          fontSize: '14px', color: '#bbbbbb', fontFamily: 'monospace',
          wordWrap: { width: Math.min(width - 80, 560) }, align: 'center',
        }).setOrigin(0.5, 0)) as Phaser.GameObjects.Text;
        y += quote.height + 16;
      }
    }

    // P&L panel — boxed in the middle third
    y = Math.max(y, height * 0.36);
    const panelW = Math.min(420, width - 60);
    const lineH = 26;
    const incomeLines: [string, string, number][] = [];
    if (this.payload.prize > 0)     incomeLines.push(['Prize',   '#ffcc00', this.payload.prize]);
    if (this.payload.jobPayout > 0) incomeLines.push(['Job',     '#ffcc00', this.payload.jobPayout]);
    if (this.payload.salvage > 0)   incomeLines.push(['Salvage', '#aa88ff', this.payload.salvage]);
    const expenseLines: [string, string, number][] = [];
    if (this.payload.wages > 0)       expenseLines.push(['Wages',  '#ff8888', this.payload.wages]);
    if (this.payload.maintenance > 0) expenseLines.push(['Upkeep', '#ff8888', this.payload.maintenance]);

    const totalRows = incomeLines.length + expenseLines.length + 1; // +1 for net
    const panelH = totalRows * lineH + 50;
    add(this.add.rectangle(cx, y + panelH / 2, panelW, panelH, 0x000000, 0.7)
      .setStrokeStyle(2, 0x4466aa));

    let py = y + 20;
    add(this.add.text(cx, py, 'BALANCE SHEET', {
      fontSize: '14px', color: '#888888', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5));
    py += 24;
    for (const [label, c, amt] of incomeLines) {
      add(this.add.text(cx, py, `${label.padEnd(10)}  +$${amt.toLocaleString()}`, {
        fontSize: '15px', color: c, fontFamily: 'monospace',
      }).setOrigin(0.5));
      py += lineH;
    }
    for (const [label, c, amt] of expenseLines) {
      add(this.add.text(cx, py, `${label.padEnd(10)}  -$${amt.toLocaleString()}`, {
        fontSize: '15px', color: c, fontFamily: 'monospace',
      }).setOrigin(0.5));
      py += lineH;
    }
    const net = this.payload.prize + this.payload.jobPayout + this.payload.salvage - this.payload.wages - this.payload.maintenance;
    const netColor = net >= 0 ? '#00ff88' : '#ff4444';
    add(this.add.text(cx, py, `Net        ${net >= 0 ? '+' : '-'}$${Math.abs(net).toLocaleString()}`, {
      fontSize: '17px', color: netColor, fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5));

    // Action buttons — bottom third
    const buttonY = Math.max(y + panelH + 50, height * 0.78);
    const buttons: { label: string; color: string; bg: string; fn: () => void }[] = [];
    if (this.payload.replayId) {
      buttons.push({ label: '[ WATCH REPLAY ]', color: '#aaccff', bg: '#112244',
        fn: () => this.scene.start('ReplayScene', {
          token: this.payload.token, replayId: this.payload.replayId, returnTo: 'GarageScene',
        }) });
    }
    // Repair & Return only makes sense if we have a primary vehicle and it isn't a total loss.
    // For 'destroyed' result the player has no car to re-enter with — repair flow goes to garage.
    if (this.payload.result !== 'destroyed' && this.payload.primaryVehicleId) {
      buttons.push({ label: '[ REPAIR & RETURN ]', color: '#00ff88', bg: '#003322',
        fn: () => this.repairAndReturn() });
    }
    buttons.push({ label: '[ BACK TO GARAGE ]', color: '#cccccc', bg: '#222222',
      fn: () => this.scene.start('GarageScene', { token: this.payload.token }) });

    const btnSpacing = 50;
    const totalH = buttons.length * btnSpacing;
    let by = buttonY - totalH / 2;
    for (const b of buttons) {
      const btn = add(this.add.text(cx, by, b.label, {
        fontSize: '18px', color: b.color, fontFamily: 'monospace',
        backgroundColor: b.bg, padding: { x: 22, y: 10 },
      }).setOrigin(0.5).setInteractive()) as Phaser.GameObjects.Text;
      btn.on('pointerdown', b.fn);
      by += btnSpacing;
    }
  }

  private titleFor(result: ResultOutcome): { title: string; color: string } {
    switch (result) {
      case 'win':       return { title: 'VICTORY',   color: '#00ff88' };
      case 'loss':      return { title: 'DEFEATED',  color: '#ff4444' };
      case 'destroyed': return { title: 'DESTROYED', color: '#aa0000' };
      case 'draw':      return { title: 'DRAW',      color: '#ffaa00' };
    }
  }

  // Fire-and-forget repair for every squad vehicle, then re-launch the same arena.
  // If any repair fails (e.g. no funds) we still proceed — the player will see
  // partially-repaired vehicles in the next match, which is honest behaviour.
  private async repairAndReturn(): Promise<void> {
    const host = window.location.hostname;
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${this.payload.token}` };
    await Promise.all(this.payload.vehicleIds.map(id =>
      fetch(`http://${host}:3001/api/economy/repair`, {
        method: 'POST', headers,
        body: JSON.stringify({ vehicleId: id }),
      }).catch(() => null)
    ));
    this.scene.start('ArenaScene', {
      token: this.payload.token,
      vehicleId: this.payload.primaryVehicleId,
      squadVehicleIds: this.payload.vehicleIds,
      mapId: this.payload.mapId,
      gangPrimaryColour: this.payload.gangPrimaryColour,
    });
  }
}
