import Phaser from 'phaser';
import { Connection } from '../game/Connection';
import type { ZoneState, CombatEvent } from '@carwars/shared';
import arenaMapData from '../tilemaps/arena-1.json';

const PIXELS_PER_INCH = 32;
const WORLD_CENTER_X = 640;
const WORLD_CENTER_Y = 360;

// Interpolation target per vehicle — updated on each zone_state, lerped toward each frame
interface VehicleTarget { x: number; y: number; rotation: number; }

export class ArenaScene extends Phaser.Scene {
  private connection!: Connection;
  private vehicleSprites = new Map<string, Phaser.GameObjects.Container>();
  private vehicleTargets = new Map<string, VehicleTarget>();
  private hazardSprites = new Map<string, Phaser.GameObjects.GameObject>();
  private zoneState: ZoneState | null = null;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private fireKey!: Phaser.Input.Keyboard.Key;
  private autopilotKey!: Phaser.Input.Keyboard.Key;
  private myVehicleId = 'v1';
  private token = '';
  private jobId = '';
  private lastInputSent = 0;
  private zoneEnded = false;
  private firePending = false;
  private selectedMountIndex = 0;
  private selectedWeapon: string | null = null;
  private weaponKeys: Phaser.Input.Keyboard.Key[] = [];
  private autopilot = false;
  private autopilotLabel!: Phaser.GameObjects.Text;
  private clientSpeed = 0;
  private driverSkill = 3;
  private clientSteer = 15;  // max steer per skill (replaces hardcoded 15 in steer logic)
  private hudText!: Phaser.GameObjects.Text;
  private armorTexts: Partial<Record<string, Phaser.GameObjects.Text>> = {};
  private wasdKeys!: { w: Phaser.Input.Keyboard.Key; s: Phaser.Input.Keyboard.Key; a: Phaser.Input.Keyboard.Key; d: Phaser.Input.Keyboard.Key };
  private minimapGfx!: Phaser.GameObjects.Graphics;
  private mapWalls: import('@carwars/shared').Rect[] = [];
  private mapGraphics!: Phaser.GameObjects.Graphics;
  private tilemapLayers: Phaser.Tilemaps.TilemapLayer[] = [];
  private bgGraphics!: Phaser.GameObjects.Graphics;

  constructor() {
    super({ key: 'ArenaScene' });
  }

  init(data: { token?: string; vehicleId?: string; jobId?: string }): void {
    this.token = data.token ?? '';
    this.myVehicleId = data.vehicleId ?? 'v1';
    this.jobId = data.jobId ?? '';
  }

  create(): void {
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.fireKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.autopilotKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.TAB);
    this.input.keyboard!.addCapture(Phaser.Input.Keyboard.KeyCodes.TAB);
    this.wasdKeys = {
      w: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      s: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      a: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      d: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };
    // JustDown only fires for a single frame (~16ms) but inputs are batched every 100ms.
    // Use keydown event to accumulate fire intent so it isn't dropped between send ticks.
    this.fireKey.on('down', () => { this.firePending = true; });
    this.autopilotKey.on('down', () => {
      this.autopilot = !this.autopilot;
      this.connection.send({ type: 'autopilot', enabled: this.autopilot });
      this.autopilotLabel.setText(this.autopilot ? 'AUTOPILOT: ON' : 'AUTOPILOT: OFF');
      this.autopilotLabel.setColor(this.autopilot ? '#00ff88' : '#888888');
      if (!this.autopilot) this.clientSpeed = 0; // reset on manual takeover
    });
    const weaponKeyCodes = [
      Phaser.Input.Keyboard.KeyCodes.ONE,
      Phaser.Input.Keyboard.KeyCodes.TWO,
      Phaser.Input.Keyboard.KeyCodes.THREE,
      Phaser.Input.Keyboard.KeyCodes.FOUR,
      Phaser.Input.Keyboard.KeyCodes.FIVE,
    ];
    this.weaponKeys = weaponKeyCodes.map(code => this.input.keyboard!.addKey(code));
    this.weaponKeys.forEach((key, i) => {
      key.on('down', () => { this.selectedMountIndex = i; });
    });

    // Inject tilemap JSON into cache (bundled by Vite — no HTTP request needed)
    this.cache.tilemap.add('arena-1', {
      format: Phaser.Tilemaps.Formats.TILED_JSON,
      data: arenaMapData
    });

    // Generate tileset texture programmatically (no external image needed)
    const gfx = this.make.graphics({ x: 0, y: 0 });
    gfx.fillStyle(0x111122); gfx.fillRect(0, 0, 32, 32);   // tile 1: outer floor
    gfx.fillStyle(0x1a1a33); gfx.fillRect(32, 0, 32, 32);  // tile 2: unused
    gfx.fillStyle(0x222244); gfx.fillRect(0, 32, 32, 32);  // tile 3: arena floor
    gfx.fillStyle(0x4444aa); gfx.fillRect(32, 32, 32, 32); // tile 4: arena wall
    gfx.generateTexture('tiles-arena', 64, 64);
    gfx.destroy();

    const map = this.make.tilemap({ key: 'arena-1' });
    const tileset = map.addTilesetImage('arena', 'tiles-arena')!;
    const groundLayer = map.createLayer('ground', tileset);
    const wallLayer = map.createLayer('walls', tileset)!;
    wallLayer.setCollisionByExclusion([0]);
    this.tilemapLayers = [groundLayer, wallLayer].filter((l): l is Phaser.Tilemaps.TilemapLayer => l !== null);
    this.bgGraphics = this.add.graphics().setDepth(0);

    this.add.text(16, 16, 'CAR WARS', {
      color: '#ff4444',
      fontSize: '24px',
      fontStyle: 'bold',
      fontFamily: 'monospace'
    }).setScrollFactor(0);
    this.add.text(16, 48, 'Arrows/WASD: drive | Space: fire | 1-5: weapon | Tab: pilot', {
      color: '#888888',
      fontSize: '12px',
      fontFamily: 'monospace'
    }).setScrollFactor(0);

    this.autopilotLabel = this.add.text(16, 68, 'AUTOPILOT: OFF', {
      color: '#888888', fontSize: '12px', fontFamily: 'monospace'
    }).setScrollFactor(0);

    // Vehicle status HUD — top-left, fixed to camera
    this.hudText = this.add.text(16, 100, '', {
      color: '#00ff88',
      fontSize: '12px',
      fontFamily: 'monospace',
      backgroundColor: '#00000099',
      padding: { x: 6, y: 4 },
    }).setScrollFactor(0).setDepth(20);

    // Armor facing display
    const armorLayout: Array<{ key: string; label: string; x: number; y: number }> = [
      { key: 'top',       label: 'TOP', x: 60,  y: 130 },
      { key: 'front',     label: 'FNT', x: 60,  y: 150 },
      { key: 'left',      label: 'LFT', x: 20,  y: 168 },
      { key: 'right',     label: 'RGT', x: 100, y: 168 },
      { key: 'back',      label: 'BAK', x: 60,  y: 186 },
      { key: 'underbody', label: 'UDR', x: 60,  y: 204 },
    ];
    armorLayout.forEach(({ key, label, x, y }) => {
      this.armorTexts[key] = this.add.text(x, y, `${label}: --`, {
        color: '#00ff88', fontSize: '11px', fontFamily: 'monospace',
      }).setScrollFactor(0).setDepth(20);
    });

    this.minimapGfx = this.add.graphics().setScrollFactor(0).setDepth(20);
    this.mapGraphics = this.add.graphics().setDepth(1);  // above ground, below vehicles
    // Minimap label
    this.add.text(1144, 4, 'MAP', {
      fontSize: '9px', color: '#666666', fontFamily: 'monospace'
    }).setScrollFactor(0).setDepth(20);

    // Zoom out so player can see enemies approaching — 0.6x shows ~53 world units wide
    this.cameras.main.setZoom(0.6);
    // Smooth camera follow — lerp 0.08 means camera catches up over ~12 frames (soft tracking)
    this.cameras.main.setLerp(0.08, 0.08);
    this.cameras.main.scrollX = 0;
    this.cameras.main.scrollY = 0;

    const wsHost = window.location.hostname;
    this.connection = new Connection(`ws://${wsHost}:3001`);
    this.connection.onOpen(() => {
      const zoneId = new URLSearchParams(window.location.search).get('zone') ?? 'arena-truck-stop';
      this.connection.send({
        type: 'join_zone',
        zoneId: zoneId,
        vehicleId: this.myVehicleId,
        token: this.token,
        jobId: this.jobId || undefined,
      });
    });
    this.connection.onMessage((msg) => {
      if (msg.type === 'driver_info' && msg.vehicleId === this.myVehicleId) {
        this.driverSkill = msg.skill;
        this.clientSteer = msg.maxSteer;
      }
      if (msg.type === 'zone_state') {
        // Render map walls once on first message (walls only present on join)
        if (msg.state.walls && msg.state.walls.length > 0 && this.mapWalls.length === 0) {
          this.mapWalls = msg.state.walls;
          this.renderMapWalls(msg.state.walls);
          if (msg.state.mapId === 'truck-stop') {
            // Hide old 40×23 tilemap — it sits inside the truck stop and confuses the layout
            this.tilemapLayers.forEach(l => l.setVisible(false));
            // Draw a full dark background for the 80×50 map (depth 0, behind walls at depth 1)
            const mapW = 80 * PIXELS_PER_INCH;
            const mapH = 50 * PIXELS_PER_INCH;
            const mapX = WORLD_CENTER_X - mapW / 2;
            const mapY = WORLD_CENTER_Y - mapH / 2;
            this.bgGraphics.fillStyle(0x0a0a14, 1);
            this.bgGraphics.fillRect(mapX, mapY, mapW, mapH);
            // Constrain camera to the truck stop bounds; zoom 1x so vehicles are clearly visible
            this.cameras.main.setZoom(1.0);
            this.cameras.main.setBounds(mapX, mapY, mapW, mapH);
          }
        }
        this.zoneState = msg.state;
        this.syncSprites(msg.state);
      } else if (msg.type === 'zone_end') {
        this.showZoneEnd(msg.winnerId, msg.reason, msg.prize ?? 0, msg.jobPayout ?? 0);
      }
    });
  }

  private syncSprites(state: ZoneState): void {
    const seen = new Set<string>();

    state.vehicles.forEach(v => {
      seen.add(v.id);
      let container = this.vehicleSprites.get(v.id);

      if (!container) {
        const isPlayer = v.id === this.myVehicleId;
        const color = isPlayer ? 0x00ff88 : (v.playerId === 'ai-team' ? 0xff4444 : 0xffaa00);

        const body = this.add.rectangle(0, 0, 20, 32, color).setName('body');
        const dirIndicator = this.add.triangle(0, -18, -6, 0, 6, 0, 0, -10, 0xffffff);
        const label = this.add.text(0, 20, v.id.slice(0, 8), {
          fontSize: '9px', color: '#ffffff', fontFamily: 'monospace'
        }).setOrigin(0.5);

        // Armor bars: front (top of vehicle), back (bottom), left, right
        const barFront = this.add.rectangle(0, -18, 20, 3, 0x00ff00).setName('bar-front');
        const barBack  = this.add.rectangle(0,  18, 20, 3, 0x00ff00).setName('bar-back');
        const barLeft  = this.add.rectangle(-12, 0, 3, 20, 0x00ff00).setName('bar-left');
        const barRight = this.add.rectangle( 12, 0, 3, 20, 0x00ff00).setName('bar-right');

        container = this.add.container(0, 0, [body, dirIndicator, label, barFront, barBack, barLeft, barRight]).setDepth(2);
        this.vehicleSprites.set(v.id, container);
      }

      const worldX = WORLD_CENTER_X + v.position.x * PIXELS_PER_INCH;
      const worldY = WORLD_CENTER_Y + v.position.y * PIXELS_PER_INCH;
      const rotation = Phaser.Math.DegToRad(v.facing);
      if (!this.vehicleTargets.has(v.id)) {
        // Snap to position on first appearance
        container.setPosition(worldX, worldY);
        container.setRotation(rotation);
      }
      // Always update target — lerp runs in update()
      this.vehicleTargets.set(v.id, { x: worldX, y: worldY, rotation });

      // Update armor bars and body tint
      const loadout = v.stats.loadout;
      const damage = v.stats.damageState;
      if (loadout) {
        const pct = (loc: keyof typeof loadout.armor) => {
          const orig = loadout.armor[loc];
          if (!orig) return 1;
          return Math.max(0, (damage.armor[loc] ?? orig)) / orig;
        };
        const barColor = (p: number) => p > 0.5 ? 0x00ff00 : p > 0.25 ? 0xffaa00 : 0xff2200;

        const barFront = container.getByName('bar-front') as Phaser.GameObjects.Rectangle;
        const barBack  = container.getByName('bar-back')  as Phaser.GameObjects.Rectangle;
        const barLeft  = container.getByName('bar-left')  as Phaser.GameObjects.Rectangle;
        const barRight = container.getByName('bar-right') as Phaser.GameObjects.Rectangle;
        if (barFront) { const p = pct('front'); barFront.setSize(20 * p, 3).setFillStyle(barColor(p)); }
        if (barBack)  { const p = pct('back');  barBack.setSize(20 * p, 3).setFillStyle(barColor(p)); }
        if (barLeft)  { const p = pct('left');  barLeft.setSize(3, 20 * p).setFillStyle(barColor(p)); }
        if (barRight) { const p = pct('right'); barRight.setSize(3, 20 * p).setFillStyle(barColor(p)); }

        // Tint body: interpolate from team color (full health) toward red (no health)
        const totalOrig = (loadout.armor.front ?? 0) + (loadout.armor.back ?? 0) + (loadout.armor.left ?? 0) + (loadout.armor.right ?? 0);
        const totalRem  = (damage.armor.front  ?? loadout.armor.front  ?? 0) +
                          (damage.armor.back   ?? loadout.armor.back   ?? 0) +
                          (damage.armor.left   ?? loadout.armor.left   ?? 0) +
                          (damage.armor.right  ?? loadout.armor.right  ?? 0);
        const healthPct = totalOrig > 0 ? totalRem / totalOrig : 1;
        const body = container.getByName('body') as Phaser.GameObjects.Rectangle;
        if (body) {
          const isMe = v.id === this.myVehicleId;
          const baseR = isMe ? 0 : 255;
          const baseG = isMe ? 255 : 68;
          const baseB = isMe ? 136 : 68;
          // Lerp from damage color (0xff0000) at zero health to team color at full health
          const r = Math.floor(255 + (baseR - 255) * healthPct);
          const g = Math.floor(baseG * healthPct);
          const b = Math.floor(baseB * healthPct);
          body.setFillStyle((r << 16) | (g << 8) | b);
        }
      }

      if (v.id === this.myVehicleId) {
        // roundPixels=false so lerped sub-pixel positions render smoothly
        this.cameras.main.startFollow(container, false);
      }
    });

    this.vehicleSprites.forEach((container, id) => {
      if (!seen.has(id)) {
        container.destroy();
        this.vehicleSprites.delete(id);
        this.vehicleTargets.delete(id);
      }
    });

    this.syncHazards(state);
    this.drawMinimap(state);
    if (state.combatEvents?.length) {
      this.renderCombatEvents(state.combatEvents);
    }
  }

  private renderCombatEvents(events: CombatEvent[]): void {
    events.forEach(ev => {
      const fromX = WORLD_CENTER_X + ev.fromX * PIXELS_PER_INCH;
      const fromY = WORLD_CENTER_Y + ev.fromY * PIXELS_PER_INCH;
      const toX   = WORLD_CENTER_X + ev.toX   * PIXELS_PER_INCH;
      const toY   = WORLD_CENTER_Y + ev.toY   * PIXELS_PER_INCH;

      // Tracer line
      const tracer = this.add.graphics().setDepth(5);
      if (ev.hit) {
        tracer.lineStyle(2, 0xff4400, 0.9);
      } else {
        tracer.lineStyle(1, 0xffff00, 0.6);
      }
      tracer.beginPath();
      tracer.moveTo(fromX, fromY);
      tracer.lineTo(toX, toY);
      tracer.strokePath();
      this.time.delayedCall(180, () => tracer.destroy());

      // Hit flash on target vehicle
      if (ev.hit) {
        const flash = this.add.graphics().setDepth(5);
        flash.fillStyle(0xff6600, 0.85);
        flash.fillCircle(toX, toY, 14);
        flash.lineStyle(2, 0xffffff, 0.7);
        flash.strokeCircle(toX, toY, 14);
        this.time.delayedCall(200, () => flash.destroy());
      }
    });
  }

  private drawMinimap(state: ZoneState): void {
    const MM_X = 1144, MM_Y = 16, MM_SIZE = 120, MM_SCALE = 3;
    const gfx = this.minimapGfx;
    gfx.clear();

    // Background + border
    gfx.fillStyle(0x000000, 0.65);
    gfx.fillRect(MM_X, MM_Y, MM_SIZE, MM_SIZE);
    gfx.lineStyle(1, 0x444466, 1);
    gfx.strokeRect(MM_X, MM_Y, MM_SIZE, MM_SIZE);

    const cx = MM_X + MM_SIZE / 2;
    const cy = MM_Y + MM_SIZE / 2;

    state.vehicles.forEach(v => {
      const isPlayer = v.id === this.myVehicleId;
      const color = isPlayer ? 0x00ff88 : (v.playerId === 'ai-team' ? 0xff4444 : 0xffaa00);
      const dotX = Math.max(MM_X + 2, Math.min(MM_X + MM_SIZE - 2, cx + v.position.x * MM_SCALE));
      const dotY = Math.max(MM_Y + 2, Math.min(MM_Y + MM_SIZE - 2, cy + v.position.y * MM_SCALE));
      gfx.fillStyle(color, 1);
      gfx.fillCircle(dotX, dotY, isPlayer ? 4 : 3);
    });
  }

  private syncHazards(state: ZoneState): void {
    const seen = new Set<string>();
    state.hazardObjects.forEach(h => {
      seen.add(h.id);
      if (this.hazardSprites.has(h.id)) return;
      const worldX = WORLD_CENTER_X + h.position.x * PIXELS_PER_INCH;
      const worldY = WORLD_CENTER_Y + h.position.y * PIXELS_PER_INCH;
      let sprite: Phaser.GameObjects.GameObject;
      if (h.type === 'oil') {
        sprite = this.add.ellipse(worldX, worldY, 32, 16, 0x112211, 0.7).setDepth(1.5);
      } else {
        sprite = this.add.circle(worldX, worldY, 6, 0xff2200).setDepth(1.5);
      }
      this.hazardSprites.set(h.id, sprite);
    });
    this.hazardSprites.forEach((sprite, id) => {
      if (!seen.has(id)) {
        (sprite as Phaser.GameObjects.Ellipse | Phaser.GameObjects.Arc).destroy();
        this.hazardSprites.delete(id);
      }
    });
  }

  private renderMapWalls(walls: import('@carwars/shared').Rect[]): void {
    const gfx = this.mapGraphics;
    gfx.clear();

    walls.forEach(wall => {
      const px = WORLD_CENTER_X + wall.x * PIXELS_PER_INCH;
      const py = WORLD_CENTER_Y + wall.y * PIXELS_PER_INCH;
      const pw = wall.w * PIXELS_PER_INCH;
      const ph = wall.h * PIXELS_PER_INCH;

      if (wall.type === 'turret') {
        gfx.fillStyle(0x8b1a1a, 1);    // dark red
        gfx.lineStyle(1, 0xff3333, 1);
      } else if (wall.type === 'building') {
        gfx.fillStyle(0x3a3a4a, 1);    // medium grey-blue
        gfx.lineStyle(1, 0x555566, 1);
      } else {
        gfx.fillStyle(0x222233, 1);    // dark grey (outer wall / default)
        gfx.lineStyle(1, 0x333344, 1);
      }

      gfx.fillRect(px - pw / 2, py - ph / 2, pw, ph);
      gfx.strokeRect(px - pw / 2, py - ph / 2, pw, ph);
    });
  }

  private showZoneEnd(winnerId: string | null, reason: string, prize: number, jobPayout: number): void {
    if (this.zoneEnded) return;
    this.zoneEnded = true;

    const myVehicle = this.zoneState?.vehicles.find(v => v.id === this.myVehicleId);
    const isWinner = !!myVehicle && !!winnerId && myVehicle.playerId === winnerId;

    // Clear active job from localStorage if we won (job was auto-completed server-side)
    if (isWinner) {
      localStorage.removeItem('cw_active_job');
      localStorage.removeItem('cw_active_job_desc');
      localStorage.removeItem('cw_active_job_payout');
    }

    // Dim overlay
    this.add.rectangle(640, 360, 700, 380, 0x000000, 0.85).setScrollFactor(0).setDepth(10);

    // Title
    const titleText = isWinner ? 'VICTORY' : reason === 'ai_victory' ? 'DEFEATED' : 'BATTLE OVER';
    const titleColor = isWinner ? '#00ff88' : '#ff4444';
    this.add.text(640, 215, titleText, {
      fontSize: '42px', color: titleColor, fontFamily: 'monospace', fontStyle: 'bold'
    }).setOrigin(0.5).setScrollFactor(0).setDepth(11);

    // Financial summary (only meaningful for winner)
    let y = 275;
    if (isWinner) {
      if (prize > 0) {
        this.add.text(640, y, `Arena prize:  $${prize.toLocaleString()}`, {
          fontSize: '18px', color: '#ffcc00', fontFamily: 'monospace'
        }).setOrigin(0.5).setScrollFactor(0).setDepth(11);
        y += 30;
      }
      if (jobPayout > 0) {
        this.add.text(640, y, `Job payout:   $${jobPayout.toLocaleString()}`, {
          fontSize: '18px', color: '#ffcc00', fontFamily: 'monospace'
        }).setOrigin(0.5).setScrollFactor(0).setDepth(11);
        y += 30;
      }
      const total = prize + jobPayout;
      if (total > 0) {
        this.add.text(640, y, `Total earned: $${total.toLocaleString()}`, {
          fontSize: '20px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold'
        }).setOrigin(0.5).setScrollFactor(0).setDepth(11);
        y += 36;
      }
    }

    // Damage summary
    if (myVehicle) {
      const ds = myVehicle.stats.damageState;
      const armorLost = Object.entries(ds.armor)
        .reduce((sum, [k, v]) => {
          const orig = (myVehicle.stats.loadout.armor as Record<string, number>)[k] ?? 0;
          return sum + Math.max(0, orig - (v ?? 0));
        }, 0);
      const flags = [
        ds.engineDamaged ? 'ENGINE' : '',
        ds.onFire ? 'FIRE' : '',
        (ds.tiresBlown?.length ?? 0) > 0 ? `${ds.tiresBlown!.length} TIRE(S)` : '',
      ].filter(Boolean).join('  ');

      const dmgColor = armorLost > 0 ? '#ff8888' : '#88ff88';
      this.add.text(640, y, `Damage: ${armorLost} armor pts lost${flags ? `  [${flags}]` : ''}`, {
        fontSize: '14px', color: dmgColor, fontFamily: 'monospace'
      }).setOrigin(0.5).setScrollFactor(0).setDepth(11);
      y += 24;
    }

    // Return to garage button
    y = Math.max(y + 10, 460);
    const garageBtn = this.add.text(640, y, '[RETURN TO GARAGE]', {
      fontSize: '20px', color: '#aaaaff', fontFamily: 'monospace',
      backgroundColor: '#111133', padding: { x: 12, y: 6 }
    }).setOrigin(0.5).setScrollFactor(0).setDepth(11).setInteractive();

    garageBtn.on('pointerdown', () => {
      this.connection.send({ type: 'leave_zone' });
      this.connection.close();
      this.scene.start('GarageScene', {
        token: this.token,
        lastResult: isWinner ? { prize, jobPayout } : null,
      });
    });
  }

  private updateHud(): void {
    const myVehicle = this.zoneState?.vehicles.find(v => v.id === this.myVehicleId);
    if (!myVehicle) return;

    const ds = myVehicle.stats.damageState;
    const origArmor = myVehicle.stats.loadout?.armor ?? {};
    const mounts = myVehicle.stats.loadout?.mounts ?? [];
    const mount = mounts[this.selectedMountIndex] ?? mounts[0];
    const weaponLabel = mount
      ? `[${this.selectedMountIndex + 1}] ${mount.weaponId?.toUpperCase() ?? '?'}  ${mount.ammo}`
      : 'NO WEAPON';

    this.hudText.setText(
      `SPD: ${myVehicle.speed} mph   SKILL: ${this.driverSkill}\n` +
      `WEAPON: ${weaponLabel}`
    );

    // Update armor panels with colour coding
    const armorFaces = ['front', 'back', 'left', 'right', 'top', 'underbody'] as const;
    const labelMap: Record<string, string> = {
      front: 'FNT', back: 'BAK', left: 'LFT', right: 'RGT', top: 'TOP', underbody: 'UDR',
    };
    armorFaces.forEach(face => {
      const text = this.armorTexts[face];
      if (!text) return;
      const cur = ds.armor[face] ?? 0;
      const orig = (origArmor as Record<string, number>)[face] ?? 1;
      const pct = cur / orig;
      const color = pct >= 0.75 ? '#00ff88' : pct >= 0.25 ? '#ffaa00' : '#ff3333';
      text.setColor(color).setText(`${labelMap[face]}: ${cur}`);
    });
  }

  update(time: number): void {
    if (!this.zoneState) return;

    this.updateHud();

    // Interpolate all vehicle sprites toward their server-authoritative targets each frame.
    // LERP factor 0.25 = smooth over ~4 frames; fast enough to stay close, slow enough to feel smooth.
    const LERP = 0.25;
    this.vehicleTargets.forEach((target, id) => {
      const container = this.vehicleSprites.get(id);
      if (!container) return;
      container.x += (target.x - container.x) * LERP;
      container.y += (target.y - container.y) * LERP;
      // Angle lerp — handle wraparound so 359°→1° goes through 0° not 180°
      // Normalise to [0, 2π) first so the single ±π wrap is always sufficient
      const TWO_PI = Math.PI * 2;
      const curRot = ((container.rotation % TWO_PI) + TWO_PI) % TWO_PI;
      let dRot = target.rotation - curRot;
      if (dRot > Math.PI)  dRot -= TWO_PI;
      if (dRot < -Math.PI) dRot += TWO_PI;
      container.rotation = curRot + dRot * LERP;
    });

    if (time - this.lastInputSent < 100) return;
    this.lastInputSent = time;

    // When autopilot is on the server drives this vehicle — don't send human input
    if (this.autopilot) return;

    // Get max speed from our vehicle's stats (falls back to 70 if not yet received)
    const myVehicle = this.zoneState?.vehicles.find(v => v.id === this.myVehicleId);
    const mounts = myVehicle?.stats.loadout?.mounts ?? [];
    const mount = mounts[this.selectedMountIndex] ?? mounts[0];
    this.selectedWeapon = mount?.weaponId ?? null;
    const maxSpeed = myVehicle?.stats.maxSpeed ?? 70;

    // Continuous acceleration: ±5 mph per 100ms tick
    const upHeld = this.cursors.up?.isDown || this.wasdKeys.w.isDown;
    const downHeld = this.cursors.down?.isDown || this.wasdKeys.s.isDown;
    if (upHeld)   this.clientSpeed = Math.min(this.clientSpeed + 5, maxSpeed);
    if (downHeld) this.clientSpeed = Math.max(this.clientSpeed - 5, 0);
    // No key held = coast (speed persists)

    const leftHeld  = this.cursors.left?.isDown  || this.wasdKeys.a.isDown;
    const rightHeld = this.cursors.right?.isDown || this.wasdKeys.d.isDown;
    const steer = leftHeld ? -this.clientSteer : rightHeld ? this.clientSteer : 0;

    const fireWeapon = this.firePending ? this.selectedWeapon : null;
    this.firePending = false;

    this.connection.send({
      type: 'input',
      tick: this.zoneState.tick,
      speed: this.clientSpeed,
      steer,
      fireWeapon
    });
  }
}
