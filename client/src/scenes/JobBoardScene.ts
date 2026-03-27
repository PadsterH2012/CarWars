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

    if (!jobs.length) {
      this.add.text(640, 360, 'No jobs available.', { color: '#888888', fontSize: '18px', fontFamily: 'monospace' }).setOrigin(0.5);
    } else {
      jobs.forEach((job, i) => {
        const y = 100 + i * 80;
        this.add.text(100, y, `[${job.job_type.toUpperCase()}] ${job.description}`, {
          color: '#cccccc', fontSize: '14px', fontFamily: 'monospace', wordWrap: { width: 800 }
        });
        this.add.text(100, y + 24, `Payout: $${job.payout.toLocaleString()}`, {
          color: '#ffcc00', fontSize: '14px', fontFamily: 'monospace'
        });
      });
    }

    const backBtn = this.add.text(100, 680, '[BACK TO GARAGE]', {
      color: '#888888', fontSize: '16px', fontFamily: 'monospace'
    }).setInteractive();
    backBtn.on('pointerdown', () => this.scene.start('GarageScene', { token: this.token }));
  }
}
