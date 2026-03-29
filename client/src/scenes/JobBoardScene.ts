import Phaser from 'phaser';

interface Job { id: string; job_type: string; description: string; payout: number; }

export class JobBoardScene extends Phaser.Scene {
  private token = '';
  constructor() { super({ key: 'JobBoardScene' }); }
  init(data: { token: string }): void { this.token = data.token; }

  async create(): Promise<void> {
    const host = window.location.hostname;
    const res = await fetch(`http://${host}:3001/api/jobs?zoneId=town-1`, {
      headers: { Authorization: `Bearer ${this.token}` }
    });
    const jobs: Job[] = await res.json();

    this.add.text(640, 30, 'JOB BOARD — Midville', {
      color: '#ff4444', fontSize: '24px', fontFamily: 'monospace', fontStyle: 'bold'
    }).setOrigin(0.5);

    const activeJobId = localStorage.getItem('cw_active_job');
    if (activeJobId) {
      this.add.text(640, 65, 'Active job in progress — complete it in the arena', {
        color: '#ffcc00', fontSize: '13px', fontFamily: 'monospace'
      }).setOrigin(0.5);
    }

    if (!jobs.length) {
      this.add.text(640, 360, 'No jobs available.', {
        color: '#888888', fontSize: '18px', fontFamily: 'monospace'
      }).setOrigin(0.5);
    } else {
      jobs.forEach((job, i) => {
        const y = 110 + i * 90;
        this.add.text(100, y, `[${job.job_type.toUpperCase()}] ${job.description}`, {
          color: '#cccccc', fontSize: '14px', fontFamily: 'monospace', wordWrap: { width: 700 }
        });
        this.add.text(100, y + 24, `Payout: $${job.payout.toLocaleString()}`, {
          color: '#ffcc00', fontSize: '14px', fontFamily: 'monospace'
        });

        const alreadyActive = activeJobId === job.id;
        const takeBtn = this.add.text(900, y + 10, alreadyActive ? '[ACTIVE]' : '[TAKE]', {
          color: alreadyActive ? '#ffcc00' : '#00ff88',
          fontSize: '14px', fontFamily: 'monospace',
          backgroundColor: alreadyActive ? '#332200' : '#003322',
          padding: { x: 6, y: 3 }
        }).setOrigin(1, 0);

        if (!alreadyActive) {
          takeBtn.setInteractive();
          takeBtn.on('pointerdown', () => this.takeJob(job));
        }
      });
    }

    const backBtn = this.add.text(100, 680, '[BACK TO GARAGE]', {
      color: '#888888', fontSize: '16px', fontFamily: 'monospace'
    }).setInteractive();
    backBtn.on('pointerdown', () => this.scene.start('GarageScene', { token: this.token }));
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
      this.add.text(640, 650, body.error ?? 'Failed to take job', {
        color: '#ff4444', fontSize: '14px', fontFamily: 'monospace'
      }).setOrigin(0.5);
    }
  }
}
