import Phaser from 'phaser';
import { bindFullscreenToggle, onLayout } from '../ui/responsive';
import { openSquadPicker } from '../ui/DriverPicker';

interface Job {
  id: string; job_type: string; description: string; payout: number;
  difficulty: number; division_min: number;
}
interface ActiveJob {
  id: string; jobId: string; jobType: string; description: string;
  payout: number; vehicleCount: number; remainingSeconds: number;
}

// Compact ETA used by the in-progress job list ("1m 20s" / "45s").
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
  private emptyText?: Phaser.GameObjects.Text;
  private jobs: Job[] = [];
  private activeJobs: ActiveJob[] = [];
  private jobRows: Array<{
    descText: Phaser.GameObjects.Text;
    payoutText: Phaser.GameObjects.Text;
    difficultyText: Phaser.GameObjects.Text;
    sendBtn: Phaser.GameObjects.Text;
  }> = [];
  private inProgressHeading?: Phaser.GameObjects.Text;
  private inProgressRows: Array<{
    info: ActiveJob;
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
    this.inProgressRows = [];
    const host = window.location.hostname;

    this.jobs = await (await fetch(`http://${host}:3001/api/jobs/headless?zoneId=town-1`, {
      headers: { Authorization: `Bearer ${this.token}` }
    })).json();
    this.activeJobs = await (await fetch(`http://${host}:3001/api/jobs/active`, {
      headers: { Authorization: `Bearer ${this.token}` }
    })).json();

    this.header = this.add.text(0, 0, 'JOBS — send a crew', {
      color: '#ff4444', fontSize: '24px', fontFamily: 'monospace', fontStyle: 'bold'
    }).setOrigin(0.5);

    if (!this.jobs.length) {
      this.emptyText = this.add.text(0, 0, 'No jobs available.', {
        color: '#888888', fontSize: '18px', fontFamily: 'monospace'
      }).setOrigin(0.5);
    } else {
      this.jobs.forEach(job => {
        const descText = this.add.text(0, 0, `[${job.job_type.toUpperCase()}] ${job.description}`, {
          color: '#cccccc', fontSize: '14px', fontFamily: 'monospace', wordWrap: { width: 700 }
        });
        const payoutText = this.add.text(0, 0, `Payout $${job.payout.toLocaleString()}`, {
          color: '#ffcc00', fontSize: '14px', fontFamily: 'monospace'
        });
        const difficultyText = this.add.text(0, 0, `Difficulty ${job.difficulty}`, {
          color: difficultyColour(job.difficulty), fontSize: '14px', fontFamily: 'monospace'
        });
        const sendBtn = this.add.text(0, 0, '[SEND SQUAD]', {
          color: '#00ff88', fontSize: '14px', fontFamily: 'monospace',
          backgroundColor: '#003322', padding: { x: 6, y: 3 }
        }).setOrigin(1, 0).setInteractive();
        sendBtn.on('pointerdown', () => this.sendSquad(job));
        this.jobRows.push({ descText, payoutText, difficultyText, sendBtn });
      });
    }

    // --- In-progress job deployments with live ETA ---
    this.inProgressHeading = this.add.text(0, 0, 'IN PROGRESS', {
      color: '#ffaa44', fontSize: '18px', fontFamily: 'monospace', fontStyle: 'bold'
    });
    this.activeJobs.forEach(aj => {
      const descText = this.add.text(0, 0,
        `[${aj.jobType.toUpperCase()}] ${aj.description}  (${aj.vehicleCount} car${aj.vehicleCount === 1 ? '' : 's'})`, {
        color: '#cccccc', fontSize: '14px', fontFamily: 'monospace', wordWrap: { width: 700 }
      });
      const etaText = this.add.text(0, 0, `ETA ${fmtRemaining(aj.remainingSeconds)}`, {
        color: '#ffaa44', fontSize: '14px', fontFamily: 'monospace'
      }).setOrigin(1, 0);
      this.inProgressRows.push({ info: aj, descText, etaText });
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
    this.emptyText?.setPosition(cx, height / 2);

    const leftX = Math.max(60, width * 0.08);
    const rightX = Math.min(width - 60, width * 0.92);

    let y = 90;
    this.jobRows.forEach(row => {
      row.descText.setPosition(leftX, y);
      row.descText.setStyle({ wordWrap: { width: rightX - leftX - 140 } });
      row.payoutText.setPosition(leftX, y + 24);
      row.difficultyText.setPosition(leftX + 180, y + 24);
      row.sendBtn.setPosition(rightX, y + 10);
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

  private async sendSquad(job: Job): Promise<void> {
    const vehicleIds = await openSquadPicker(this, this.token, { title: 'SEND SQUAD ON JOB' });
    if (!vehicleIds) return; // cancelled
    const host = window.location.hostname;
    const res = await fetch(`http://${host}:3001/api/jobs/${job.id}/deploy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ vehicleIds }),
    });
    if (res.ok) {
      this.scene.restart();
    } else {
      const body = await res.json();
      this.errorText = this.add.text(0, 0, body.error ?? 'Failed to deploy squad', {
        color: '#ff4444', fontSize: '14px', fontFamily: 'monospace'
      }).setOrigin(0.5);
      this.layout();
    }
  }
}
