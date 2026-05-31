import Phaser from 'phaser';
import { bindFullscreenToggle } from '../ui/responsive';

interface LeaderboardEntry {
  rank: number;
  gangId: string;
  gangName: string;
  primaryColour: number;
  isPlayer: boolean;
  totalInfluence: number;
  settlementCount: number;
}

interface LeaderboardData {
  entries: LeaderboardEntry[];
  playerRank: number;
  totalGangs: number;
  endgame: boolean;
  retired: boolean;
  retireBonus: number;
}

export class LeaderboardScene extends Phaser.Scene {
  private token = '';
  private data_: LeaderboardData | null = null;
  private retiring = false;

  constructor() { super({ key: 'LeaderboardScene' }); }

  init(data: { token: string }): void {
    this.token = data.token;
    this.data_ = null;
    this.retiring = false;
  }

  async create(): Promise<void> {
    const host = window.location.hostname;
    try {
      const res = await fetch(`http://${host}:3001/api/leaderboard`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (res.ok) this.data_ = await res.json();
    } catch (_e) {}

    bindFullscreenToggle(this);
    this.render();
  }

  private render(): void {
    this.children.removeAll(true);
    const { width, height } = this.scale;
    const cx   = width / 2;
    const left = Math.max(60, width * 0.12);

    this.add.text(cx, 32, 'TERRITORY LEADERBOARD', {
      color: '#ff4444', fontSize: '28px', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);

    if (!this.data_) {
      this.add.text(cx, height / 2, 'Loading...', {
        color: '#888888', fontSize: '16px', fontFamily: 'monospace',
      }).setOrigin(0.5);
    } else {
      const d = this.data_;

      // Endgame banner
      if (d.endgame && !d.retired) {
        const banner = this.add.text(cx, 75,
          '★  YOU ARE THE DOMINANT POWER IN THE REGION  ★', {
            color: '#ffdd00', fontSize: '18px', fontFamily: 'monospace', fontStyle: 'bold',
            backgroundColor: '#332200', padding: { x: 16, y: 8 },
          }).setOrigin(0.5);

        const retireBtn = this.add.text(cx, 115,
          '[ RETIRE YOUR GANG ]', {
            color: this.retiring ? '#888888' : '#ffcc00',
            fontSize: '16px', fontFamily: 'monospace',
            backgroundColor: this.retiring ? '#222222' : '#332200',
            padding: { x: 12, y: 6 },
          }).setOrigin(0.5).setInteractive();
        retireBtn.on('pointerdown', () => this.doRetire(retireBtn));
      } else if (d.retired) {
        this.add.text(cx, 80, `RETIRED — bonus $${d.retireBonus.toLocaleString()} credited to treasury`, {
          color: '#888888', fontSize: '14px', fontFamily: 'monospace',
        }).setOrigin(0.5);
      }

      const startY = (d.endgame || d.retired) ? 150 : 85;
      const rowH   = 36;

      // Header row
      this.add.text(left,        startY, 'RANK', { color: '#555', fontSize: '13px', fontFamily: 'monospace' });
      this.add.text(left + 70,   startY, 'GANG',  { color: '#555', fontSize: '13px', fontFamily: 'monospace' });
      this.add.text(left + 380,  startY, 'INFLUENCE', { color: '#555', fontSize: '13px', fontFamily: 'monospace' });
      this.add.text(left + 500,  startY, 'ZONES', { color: '#555', fontSize: '13px', fontFamily: 'monospace' });

      this.add.rectangle(left, startY + 16, width - left * 2, 1, 0x333333).setOrigin(0, 0.5);

      d.entries.forEach((entry, i) => {
        const y        = startY + 24 + (i + 1) * rowH;
        const isPlayer = entry.isPlayer;
        const rowColor = isPlayer ? '#ffdd00' : '#cccccc';

        if (isPlayer) {
          this.add.rectangle(left - 8, y - 14, width - left * 2 + 16, rowH - 2, 0x332200, 0.5)
            .setOrigin(0, 0)
            .setStrokeStyle(1, 0xffdd00, 0.6);
        }

        // Rank
        this.add.text(left, y, `#${entry.rank}`, {
          color: isPlayer ? '#ffdd00' : '#888888',
          fontSize: '15px', fontFamily: 'monospace', fontStyle: isPlayer ? 'bold' : 'normal',
        });

        // Colour swatch
        this.add.circle(left + 58, y + 8, 7, entry.primaryColour);

        // Gang name
        this.add.text(left + 72, y, entry.gangName, {
          color: rowColor,
          fontSize: '15px', fontFamily: 'monospace', fontStyle: isPlayer ? 'bold' : 'normal',
        });

        // Influence
        this.add.text(left + 380, y, entry.totalInfluence.toLocaleString(), {
          color: rowColor, fontSize: '15px', fontFamily: 'monospace',
        });

        // Zone count
        this.add.text(left + 500, y, String(entry.settlementCount), {
          color: rowColor, fontSize: '15px', fontFamily: 'monospace',
        });
      });

      // Player rank footer (if outside top 20)
      if (d.playerRank > 20) {
        const footY = startY + 24 + 21 * rowH;
        this.add.rectangle(left, footY - 4, width - left * 2, 1, 0x333333).setOrigin(0, 0.5);
        this.add.text(left, footY + 4,
          `Your rank: #${d.playerRank} of ${d.totalGangs} gangs`, {
            color: '#ffdd00', fontSize: '14px', fontFamily: 'monospace',
          });
      } else {
        const footY = startY + 24 + (d.entries.length + 1) * rowH + 8;
        this.add.text(cx, footY, `${d.totalGangs} gangs total`, {
          color: '#555555', fontSize: '13px', fontFamily: 'monospace',
        }).setOrigin(0.5);
      }
    }

    // Back button
    const backBtn = this.add.text(40, height - 50, '[ BACK ]', {
      color: '#888888', fontSize: '16px', fontFamily: 'monospace',
      backgroundColor: '#111111', padding: { x: 10, y: 6 },
    }).setInteractive();
    backBtn.on('pointerdown', () => this.scene.start('GarageScene', { token: this.token }));
  }

  private async doRetire(btn: Phaser.GameObjects.Text): Promise<void> {
    if (this.retiring) return;
    this.retiring = true;
    btn.setText('[ RETIRING... ]').setColor('#888888');

    const host = window.location.hostname;
    try {
      const res = await fetch(`http://${host}:3001/api/leaderboard/retire`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (res.ok) {
        const { bonus } = await res.json();
        if (this.data_) {
          this.data_.retired    = true;
          this.data_.retireBonus = bonus;
          this.data_.endgame    = false;
        }
        this.render();
      } else {
        btn.setText('[ RETIRE YOUR GANG ]').setColor('#ffcc00');
        this.retiring = false;
      }
    } catch (_e) {
      btn.setText('[ RETIRE YOUR GANG ]').setColor('#ffcc00');
      this.retiring = false;
    }
  }
}
