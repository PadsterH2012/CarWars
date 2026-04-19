import Phaser from 'phaser';
import { bindFullscreenToggle, onLayout } from '../ui/responsive';

export class LoginScene extends Phaser.Scene {
  private titleText!: Phaser.GameObjects.Text;
  private subtitleText!: Phaser.GameObjects.Text;
  private formElement!: Phaser.GameObjects.DOMElement;

  constructor() { super({ key: 'LoginScene' }); }

  create(): void {
    const saved = localStorage.getItem('cw_token');
    if (saved) {
      this.scene.start('GarageScene', { token: saved });
      return;
    }

    this.titleText = this.add.text(0, 0, 'CAR WARS', {
      color: '#ff4444', fontSize: '48px', fontFamily: 'monospace', fontStyle: 'bold'
    }).setOrigin(0.5);

    this.subtitleText = this.add.text(0, 0, 'Armed Vehicular Combat', {
      color: '#888888', fontSize: '18px', fontFamily: 'monospace'
    }).setOrigin(0.5);

    this.formElement = this.add.dom(0, 0).createFromHTML(`
      <div style="text-align:center;font-family:monospace">
        <input id="username" type="text" placeholder="Username"
               style="background:#111;color:#fff;border:1px solid #444;padding:8px;margin:8px;font-size:16px;width:200px"><br>
        <input id="password" type="password" placeholder="Password"
               style="background:#111;color:#fff;border:1px solid #444;padding:8px;margin:8px;font-size:16px;width:200px"><br>
        <div id="error" style="color:#ff4444;min-height:20px;margin:4px"></div>
        <button id="loginBtn" style="background:#222;color:#00ff88;border:1px solid #00ff88;padding:10px 24px;font-size:16px;font-family:monospace;cursor:pointer;margin:4px">LOGIN</button>
        <button id="registerBtn" style="background:#222;color:#aaaaff;border:1px solid #aaaaff;padding:10px 24px;font-size:16px;font-family:monospace;cursor:pointer;margin:4px">REGISTER</button>
      </div>
    `);

    this.formElement.addListener('click');
    this.formElement.on('click', (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.id === 'loginBtn') this.doAuth('login');
      if (target.id === 'registerBtn') this.doAuth('register');
    });

    bindFullscreenToggle(this);
    onLayout(this, () => this.layout());
  }

  private layout(): void {
    const { width, height } = this.scale;
    const cx = width / 2;
    this.titleText.setPosition(cx, Math.max(100, height * 0.18));
    this.subtitleText.setPosition(cx, Math.max(160, height * 0.26));
    this.formElement.setPosition(cx, height * 0.55);
  }

  private async doAuth(action: 'login' | 'register'): Promise<void> {
    const username = (document.getElementById('username') as HTMLInputElement)?.value;
    const password = (document.getElementById('password') as HTMLInputElement)?.value;
    const errorEl = document.getElementById('error');

    if (!username || !password) {
      if (errorEl) errorEl.textContent = 'Username and password required';
      return;
    }

    const host = window.location.hostname;
    const res = await fetch(`http://${host}:3001/api/auth/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const body = await res.json();
    if (res.ok) {
      localStorage.setItem('cw_token', body.token);
      this.scene.start('GarageScene', { token: body.token });
    } else {
      if (errorEl) errorEl.textContent = body.error ?? 'Auth failed';
    }
  }
}
