import Phaser from 'phaser';
import { bindFullscreenToggle, onLayout } from '../ui/responsive';

interface Job { id: string; job_type: string; description: string; payout: number; }

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
  private backBtn!: Phaser.GameObjects.Text;
  private errorText?: Phaser.GameObjects.Text;

  constructor() { super({ key: 'JobBoardScene' }); }
  init(data: { token: string }): void { this.token = data.token; }

  async create(): Promise<void> {
    const host = window.location.hostname;
    const res = await fetch(`http://${host}:3001/api/jobs?zoneId=town-1`, {
      headers: { Authorization: `Bearer ${this.token}` }
    });
    const jobs: Job[] = await res.json();

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

    this.backBtn.setPosition(leftX, height - 40);
    this.errorText?.setPosition(cx, height - 70);
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
