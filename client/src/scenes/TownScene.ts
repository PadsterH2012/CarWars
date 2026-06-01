import Phaser from 'phaser';
import { esc, renderInto, createHubRoot } from '../ui/hub';

export class TownScene extends Phaser.Scene {
  private token = '';
  private vehicleId = '';
  private root!: HTMLDivElement;

  constructor() { super({ key: 'TownScene' }); }

  init(data: { zoneId?: string; token: string; vehicleId?: string }): void {
    this.token = data.token;
    this.vehicleId = data.vehicleId ?? '';
  }

  async create(): Promise<void> {
    this.root = createHubRoot(this);

    renderInto(this.root, `
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;background:var(--bg)">
        <div style="font-size:36px;color:var(--red);font-family:monospace;text-transform:uppercase;letter-spacing:0.08em">
          MIDVILLE</div>
        <div style="font-size:14px;color:var(--gray);font-family:monospace">A dusty town on the autoduel circuit</div>
        <div style="display:flex;flex-direction:column;gap:12px;margin-top:20px">
          <button class="btn btn-green" data-action="go-garage" style="font-size:18px;padding:12px 32px">&#9881; Garage</button>
          <button class="btn btn-red" data-action="go-arena" style="font-size:16px;padding:10px 24px">&#128308; Drive to Arena</button>
        </div>
      </div>`);

    this.root.addEventListener('click', (e) => {
      const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
      if (action === 'go-garage') this.scene.start('GarageScene', { token: this.token });
      if (action === 'go-arena')  this.scene.start('ArenaScene',  { token: this.token, vehicleId: this.vehicleId });
    });
  }
}
