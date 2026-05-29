import Phaser from 'phaser';
import { bindFullscreenToggle, onLayout } from '../ui/responsive';
import { openDriverPicker } from '../ui/DriverPicker';

interface Job { id: string; job_type: string; description: string; payout: number; }
interface Contract { id: string; job_type: string; description: string; payout: number; difficulty: number; }
interface ActiveContract {
  id: string; jobType: string; description: string; payout: number;
  driverId: string; driverName: string; skill: number; remainingSeconds: number;
}

// Compact ETA used by the in-progress contract list ("1m 20s" / "45s").
function fmtRemaining(seconds: number): string {
  if (seconds <= 0) return 'now';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// Difficulty → colour: green easy, amber moderate, orange hard.
function difficultyColour(difficulty: number): string {
  if (difficulty <= 3) return '#00ff88';
  if (difficulty <= 6) return '#ffcc00';
  return '#ff8844';
}

export class JobBoardScene extends Phaser.Scene {
  private token = '';
  private header!: Phaser.GameObjects.Text;
  private activeBanner?: Phaser.GameObjects.Text;
  private emptyText?: Phaser.GameObjects.Text;
  private jobRows: Array<{
    descText: Phaser.GameObjects.Text;
    payoutText: Phaser.GameObjects.Text;
    takeBtn: Phaser.GameObjects.Text;
  }> = [];
  private contracts: Contract[] = [];
  private activeContracts: ActiveContract[] = [];
  private contractsHeading?: Phaser.GameObjects.Text;
  private contractRows: Array<{
    descText: Phaser.GameObjects.Text;
    payoutText: Phaser.GameObjects.Text;
    difficultyText: Phaser.GameObjects.Text;
    assignBtn: Phaser.GameObjects.Text;
  }> = [];
  private inProgressHeading?: Phaser.GameObjects.Text;
  private inProgressRows: Array<{
    info: ActiveContract;
    descText: Phaser.GameObjects.Text;
    etaText: Phaser.GameObjects.Text;
  }> = [];
  private etaTimer?: Phaser.Time.TimerEvent;
  private backBtn!: Phaser.GameObjects.Text;
  private errorText?: Phaser.GameObjects.Text;

  constructor() { super({ key: 'JobBoardScene' }); }
  init(data: { token: string }): void { this.token = data.token; }

  async create(): Promise<void> {
    // Reset per-run state so scene.restart() doesn't retain stale references.
    this.jobRows = [];
    this.contractRows = [];
    this.inProgressRows = [];
    const host = window.location.hostname;
    const res = await fetch(`http://${host}:3001/api/jobs?zoneId=town-1`, {
      headers: { Authorization: `Bearer ${this.token}` }
    });
    const jobs: Job[] = await res.json();

    this.contracts = await (await fetch(`http://${host}:3001/api/jobs/headless?zoneId=town-1`, {
      headers: { Authorization: `Bearer ${this.token}` }
    })).json();
    this.activeContracts = await (await fetch(`http://${host}:3001/api/jobs/active`, {
      headers: { Authorization: `Bearer ${this.token}` }
    })).json();

    this.header = this.add.text(0, 0, 'JOB BOARD — Midville', {
      color: '#ff4444', fontSize: '24px', fontFamily: 'monospace', fontStyle: 'bold'
    }).setOrigin(0.5);

    const activeJobId = localStorage.getItem('cw_active_job');
    if (activeJobId) {
      this.activeBanner = this.add.text(0, 0, 'Active job in progress — complete it in the arena', {
        color: '#ffcc00', fontSize: '13px', fontFamily: 'monospace'
      }).setOrigin(0.5);
    }

    if (!jobs.length) {
      this.emptyText = this.add.text(0, 0, 'No jobs available.', {
        color: '#888888', fontSize: '18px', fontFamily: 'monospace'
      }).setOrigin(0.5);
    } else {
      jobs.forEach(job => {
        const descText = this.add.text(0, 0, `[${job.job_type.toUpperCase()}] ${job.description}`, {
          color: '#cccccc', fontSize: '14px', fontFamily: 'monospace', wordWrap: { width: 700 }
        });
        const payoutText = this.add.text(0, 0, `Payout: $${job.payout.toLocaleString()}`, {
          color: '#ffcc00', fontSize: '14px', fontFamily: 'monospace'
        });
        const alreadyActive = activeJobId === job.id;
        const takeBtn = this.add.text(0, 0, alreadyActive ? '[ACTIVE]' : '[TAKE]', {
          color: alreadyActive ? '#ffcc00' : '#00ff88',
          fontSize: '14px', fontFamily: 'monospace',
          backgroundColor: alreadyActive ? '#332200' : '#003322',
          padding: { x: 6, y: 3 }
        }).setOrigin(1, 0);

        if (!alreadyActive) {
          takeBtn.setInteractive();
          takeBtn.on('pointerdown', () => this.takeJob(job));
        }
        this.jobRows.push({ descText, payoutText, takeBtn });
      });
    }

    // --- Contracts section: send a driver on a headless job ---
    this.contractsHeading = this.add.text(0, 0, 'CONTRACTS — send a driver', {
      color: '#ff4444', fontSize: '18px', fontFamily: 'monospace', fontStyle: 'bold'
    });
    this.contracts.forEach(contract => {
      const descText = this.add.text(0, 0, `[${contract.job_type.toUpperCase()}] ${contract.description}`, {
        color: '#cccccc', fontSize: '14px', fontFamily: 'monospace', wordWrap: { width: 700 }
      });
      const payoutText = this.add.text(0, 0, `Payout: $${contract.payout.toLocaleString()}`, {
        color: '#ffcc00', fontSize: '14px', fontFamily: 'monospace'
      });
      const difficultyText = this.add.text(0, 0, `Difficulty ${contract.difficulty}`, {
        color: difficultyColour(contract.difficulty), fontSize: '14px', fontFamily: 'monospace'
      });
      const assignBtn = this.add.text(0, 0, '[ASSIGN DRIVER]', {
        color: '#00ff88', fontSize: '14px', fontFamily: 'monospace',
        backgroundColor: '#003322', padding: { x: 6, y: 3 }
      }).setOrigin(1, 0).setInteractive();
      assignBtn.on('pointerdown', () => this.assignContract(contract));
      this.contractRows.push({ descText, payoutText, difficultyText, assignBtn });
    });

    // --- In-progress contracts with live ETA ---
    this.inProgressHeading = this.add.text(0, 0, 'IN PROGRESS', {
      color: '#ffaa44', fontSize: '18px', fontFamily: 'monospace', fontStyle: 'bold'
    });
    this.activeContracts.forEach(ac => {
      const descText = this.add.text(0, 0, `${ac.driverName} (sk${ac.skill}) → [${ac.jobType.toUpperCase()}] ${ac.description}`, {
        color: '#cccccc', fontSize: '14px', fontFamily: 'monospace', wordWrap: { width: 700 }
      });
      const etaText = this.add.text(0, 0, `ETA ${fmtRemaining(ac.remainingSeconds)}`, {
        color: '#ffaa44', fontSize: '14px', fontFamily: 'monospace'
      }).setOrigin(1, 0);
      this.inProgressRows.push({ info: ac, descText, etaText });
    });

    // Tick in-progress ETAs down once a second. Phaser clears scene timers on
    // restart/shutdown, so this does not stack across scene.restart().
    if (this.inProgressRows.length) {
      this.etaTimer = this.time.addEvent({
        delay: 1000, loop: true, callback: () => this.onEtaTick(),
      });
    }

    this.backBtn = this.add.text(0, 0, '[BACK TO GARAGE]', {
      color: '#888888', fontSize: '16px', fontFamily: 'monospace'
    }).setInteractive();
    this.backBtn.on('pointerdown', () => this.scene.start('GarageScene', { token: this.token }));

    bindFullscreenToggle(this);
    onLayout(this, () => this.layout());
  }

  private layout(): void {
    const { width, height } = this.scale;
    const cx = width / 2;
    this.header.setPosition(cx, 30);
    this.activeBanner?.setPosition(cx, 65);
    this.emptyText?.setPosition(cx, height / 2);

    const leftX = Math.max(60, width * 0.08);
    const rightX = Math.min(width - 60, width * 0.92);
    this.jobRows.forEach((row, i) => {
      const y = 110 + i * 90;
      row.descText.setPosition(leftX, y);
      row.descText.setStyle({ wordWrap: { width: rightX - leftX - 120 } });
      row.payoutText.setPosition(leftX, y + 24);
      row.takeBtn.setPosition(rightX, y + 10);
    });

    // Stack the contracts section below the last arena-job row.
    let y = 110 + this.jobRows.length * 90 + 20;
    this.contractsHeading?.setPosition(leftX, y);
    y += 36;
    this.contractRows.forEach(row => {
      row.descText.setPosition(leftX, y);
      row.descText.setStyle({ wordWrap: { width: rightX - leftX - 140 } });
      row.payoutText.setPosition(leftX, y + 24);
      row.difficultyText.setPosition(leftX + 180, y + 24);
      row.assignBtn.setPosition(rightX, y + 10);
      y += 78;
    });

    y += 12;
    this.inProgressHeading?.setPosition(leftX, y);
    y += 36;
    this.inProgressRows.forEach(row => {
      row.descText.setPosition(leftX, y);
      row.descText.setStyle({ wordWrap: { width: rightX - leftX - 140 } });
      row.etaText.setPosition(rightX, y);
      y += 40;
    });

    this.backBtn.setPosition(leftX, height - 40);
    this.errorText?.setPosition(cx, height - 70);
  }

  private onEtaTick(): void {
    this.inProgressRows.forEach(row => {
      if (row.info.remainingSeconds > 0) row.info.remainingSeconds -= 1;
      row.etaText.setText(`ETA ${fmtRemaining(row.info.remainingSeconds)}`);
    });
  }

  private async assignContract(contract: Contract): Promise<void> {
    const driverId = await openDriverPicker(this, this.token, { title: 'ASSIGN DRIVER TO CONTRACT' });
    if (!driverId) return; // cancelled
    const host = window.location.hostname;
    const res = await fetch(`http://${host}:3001/api/jobs/assign`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: contract.id, driverId }),
    });
    if (res.ok) {
      this.scene.restart();
    } else {
      const body = await res.json();
      this.errorText = this.add.text(0, 0, body.error ?? 'Failed to assign contract', {
        color: '#ff4444', fontSize: '14px', fontFamily: 'monospace'
      }).setOrigin(0.5);
      this.layout();
    }
  }

  private async takeJob(job: Job): Promise<void> {
    const host = window.location.hostname;
    const res = await fetch(`http://${host}:3001/api/jobs/${job.id}/take`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` }
    });
    if (res.ok) {
      localStorage.setItem('cw_active_job', job.id);
      localStorage.setItem('cw_active_job_desc', job.description);
      localStorage.setItem('cw_active_job_payout', String(job.payout));
      this.scene.start('GarageScene', { token: this.token });
    } else {
      const body = await res.json();
      this.errorText = this.add.text(0, 0, body.error ?? 'Failed to take job', {
        color: '#ff4444', fontSize: '14px', fontFamily: 'monospace'
      }).setOrigin(0.5);
      this.layout();
    }
  }
}
