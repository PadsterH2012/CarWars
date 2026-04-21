import Phaser from 'phaser';
import { Connection } from '../game/Connection';
import type { ZoneState, CombatEvent } from '@carwars/shared';
import arenaMapData from '../tilemaps/arena-1.json';
import { preloadVehicleSprites, buildVehicleSprite, updateVehicleSprite, teamColorForVehicle } from '../game/VehicleSprite';
import { bindFullscreenToggle, onLayout } from '../ui/responsive';
import { paintEmblem, type EmblemId } from '../game/CoatOfArms';

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
  private wreckSprites = new Map<string, Phaser.GameObjects.Container>();
  private squadOrders = new Map<string, import('@carwars/shared').SquadOrder>();
  private zoneState: ZoneState | null = null;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private fireKey!: Phaser.Input.Keyboard.Key;
  private autopilotKey!: Phaser.Input.Keyboard.Key;
  private myVehicleId = 'v1';
  private squadVehicleIds: string[] = [];
  private mapId = 'truck-stop';
  private gangPrimaryColour: number | undefined;
  private rival: import('@carwars/shared').RivalInfo | null = null;
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

  // HUD elements that anchor to viewport corners/edges — repositioned on resize
  private hudTitle!: Phaser.GameObjects.Text;
  private hudHelp!: Phaser.GameObjects.Text;
  private minimapLabel!: Phaser.GameObjects.Text;
  private combatLogHeading!: Phaser.GameObjects.Text;
  // Rival banner — shown while a rival is active
  private rivalBanner?: Phaser.GameObjects.Text;
  private rivalEmblem?: Phaser.GameObjects.Image;

  // Separate camera for HUD so main-camera zoom doesn't drag scroll-fixed UI
  // toward the map centre. Pairs with refreshHud() which routes each child to
  // exactly one camera based on its scrollFactorX.
  private uiCam!: Phaser.Cameras.Scene2D.Camera;
  private hudIgnored = new WeakSet<Phaser.GameObjects.GameObject>();
  private worldIgnored = new WeakSet<Phaser.GameObjects.GameObject>();

  constructor() {
    super({ key: 'ArenaScene' });
  }

  init(data: { token?: string; vehicleId?: string; jobId?: string; squadVehicleIds?: string[]; mapId?: string; gangPrimaryColour?: number }): void {
    this.token = data.token ?? '';
    this.myVehicleId = data.vehicleId ?? 'v1';
    this.squadVehicleIds = data.squadVehicleIds && data.squadVehicleIds.length > 0
      ? data.squadVehicleIds
      : [this.myVehicleId];
    this.mapId = data.mapId ?? 'truck-stop';
    this.gangPrimaryColour = data.gangPrimaryColour;
    this.jobId = data.jobId ?? '';

    // Class-field state must be reset on every scene restart — Phaser reuses the
    // same scene instance when scene.start() is called a second time, so field
    // initializers don't re-run. Without this reset, the mapWalls guard
    // (`this.mapWalls.length === 0`) on the first zone_state silently skips
    // rendering the new match's walls, leaving the previous map on screen.
    this.vehicleSprites.clear();
    this.vehicleTargets.clear();
    this.hazardSprites.clear();
    this.wreckSprites.clear();
    this.squadOrders.clear();
    this.hudIgnored = new WeakSet();
    this.worldIgnored = new WeakSet();
    this.combatLog = [];
    this.rival = null;
    this.mapWalls = [];
    this.tilemapLayers = [];
    this.zoneState = null;
    this.zoneEnded = false;
    this.firePending = false;
    this.selectedMountIndex = 0;
    this.autopilot = false;
    this.clientSpeed = 0;
  }

  preload(): void {
    preloadVehicleSprites(this);
  }

  create(): void {
    // All key bindings use enableCapture=false so leaving the arena doesn't leave
    // lingering preventDefault captures that block DOM text inputs elsewhere
    // (gang settings modal, vehicle-name fields, etc.)
    const K = Phaser.Input.Keyboard.KeyCodes;
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.fireKey = this.input.keyboard!.addKey(K.SPACE, false);
    this.autopilotKey = this.input.keyboard!.addKey(K.P, false);
    // Commander mode: T pauses the match and opens the tactical overlay
    this.input.keyboard!.addKey(K.T, false).on('down', () => {
      if (this.zoneEnded) return;
      if (this.squadVehicleIds.length < 2) return;  // no squad → no point opening overlay
      this.connection.send({ type: 'pause' });
      this.scene.launch('TacticalOverlay', {
        zoneState: this.zoneState,
        myVehicleId: this.myVehicleId,
        squadVehicleIds: this.squadVehicleIds,
        sendOrder: (vid: string, order: import('@carwars/shared').SquadOrder) => {
          // Track locally so we can draw an indicator over the squadmate sprite
          if (order.type === 'clear') this.squadOrders.delete(vid);
          else this.squadOrders.set(vid, order);
          this.connection.send({ type: 'squad_order', vehicleId: vid, order });
        },
        onClose: () => this.connection.send({ type: 'unpause' }),
      });
    });
    this.wasdKeys = {
      w: this.input.keyboard!.addKey(K.W, false),
      s: this.input.keyboard!.addKey(K.S, false),
      a: this.input.keyboard!.addKey(K.A, false),
      d: this.input.keyboard!.addKey(K.D, false),
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
    this.weaponKeys = weaponKeyCodes.map(code => this.input.keyboard!.addKey(code, false));
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

    this.hudTitle = this.add.text(16, 16, 'CAR WARS', {
      color: '#ff4444',
      fontSize: '24px',
      fontStyle: 'bold',
      fontFamily: 'monospace'
    }).setScrollFactor(0);
    this.hudHelp = this.add.text(16, 48, 'Arrows/WASD: drive | Space: fire | 1-5: weapon | P: pilot | T: tactical | F: fullscreen', {
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

    // Combat log panel — bottom-left, shows the last 6 events
    this.combatLogHeading = this.add.text(16, 580, 'COMBAT', {
      fontSize: '11px', color: '#888', fontFamily: 'monospace', fontStyle: 'bold'
    }).setScrollFactor(0).setDepth(20);
    this.combatLogText = this.add.text(16, 598, '', {
      fontSize: '11px', color: '#cccccc', fontFamily: 'monospace',
      backgroundColor: '#000000aa', padding: { x: 6, y: 4 }, lineSpacing: 2,
    }).setScrollFactor(0).setDepth(20);
    // Minimap label (right-edge)
    this.minimapLabel = this.add.text(1144, 4, 'MAP', {
      fontSize: '9px', color: '#666666', fontFamily: 'monospace'
    }).setScrollFactor(0).setDepth(20);

    // Zoom out so player can see enemies approaching — 0.6x shows ~53 world units wide
    this.cameras.main.setZoom(0.6);
    // Smooth camera follow — lerp 0.08 means camera catches up over ~12 frames (soft tracking)
    this.cameras.main.setLerp(0.08, 0.08);
    this.cameras.main.scrollX = 0;
    this.cameras.main.scrollY = 0;

    // Dedicated UI camera at zoom 1 so HUD stays glued to the viewport corners
    // regardless of how far the main camera zooms out for bigger maps.
    this.uiCam = this.cameras.add(0, 0, this.scale.width, this.scale.height);
    this.uiCam.setZoom(1);
    this.uiCam.setScroll(0, 0);

    bindFullscreenToggle(this);
    onLayout(this, () => this.layoutHud());

    const wsHost = window.location.hostname;
    this.connection = new Connection(`ws://${wsHost}:3001`);
    this.connection.onOpen(() => {
      const zoneOverride = new URLSearchParams(window.location.search).get('zone');
      const zoneId = zoneOverride ?? `arena-${this.mapId}`;
      this.connection.send({
        type: 'join_zone',
        zoneId: zoneId,
        vehicleId: this.myVehicleId,
        token: this.token,
        jobId: this.jobId || undefined,
        squadVehicleIds: this.squadVehicleIds,
        mapId: this.mapId,
      });
    });
    this.connection.onMessage((msg) => {
      if (msg.type === 'driver_info' && msg.vehicleId === this.myVehicleId) {
        this.driverSkill = msg.skill;
        this.clientSteer = msg.maxSteer;
      }
      if (msg.type === 'zone_state') {
        // If the tactical overlay is open, mirror the new state to it so
        // commander mode sees vehicles move in real time instead of a frozen
        // one-shot snapshot from when the overlay was opened.
        const tactical = this.scene.get('TacticalOverlay') as unknown as { updateState?: (s: import('@carwars/shared').ZoneState) => void } | null;
        if (tactical && this.scene.isActive('TacticalOverlay') && typeof tactical.updateState === 'function') {
          tactical.updateState(msg.state);
        }
        // Render map walls once on first message (walls only present on join)
        if (msg.state.walls && msg.state.walls.length > 0 && this.mapWalls.length === 0) {
          this.mapWalls = msg.state.walls;
          this.renderMapWalls(msg.state.walls);
          if (msg.state.mapWidth && msg.state.mapHeight) {
            // Any map with explicit dimensions gets its own camera bounds + dark
            // background fill. The embedded default tilemap is hidden since it's
            // not authored to match this map's size.
            this.tilemapLayers.forEach(l => l.setVisible(false));
            const mapW = msg.state.mapWidth * PIXELS_PER_INCH;
            const mapH = msg.state.mapHeight * PIXELS_PER_INCH;
            const mapX = WORLD_CENTER_X - mapW / 2;
            const mapY = WORLD_CENTER_Y - mapH / 2;
            this.bgGraphics.fillStyle(0x0a0a14, 1);
            this.bgGraphics.fillRect(mapX, mapY, mapW, mapH);
            // Zoom level tuned by map size — bigger maps zoom out more so the player
            // can see across the arena
            const zoomForMap = msg.state.mapWidth > 80 ? 0.6 : msg.state.mapWidth > 50 ? 0.85 : 1.1;
            this.cameras.main.setZoom(zoomForMap);
            this.cameras.main.setBounds(mapX, mapY, mapW, mapH);
          }
        }
        this.zoneState = msg.state;
        this.syncSprites(msg.state);
      } else if (msg.type === 'rival_info') {
        // Persist the rival for this match; enemies will render in their colours
        // and the post-arena screen can show their banner + quote
        this.rival = msg.rival;
        this.showRivalBanner(msg.rival);
      } else if (msg.type === 'zone_end') {
        this.showZoneEnd(msg.winnerId, msg.reason, msg.prize ?? 0, msg.jobPayout ?? 0, msg.salvage ?? 0, msg.wages ?? 0, msg.maintenance ?? 0, msg.rival, msg.rivalQuote);
      }
    });
  }

  private syncSprites(state: ZoneState): void {
    const seen = new Set<string>();

    state.vehicles.forEach(v => {
      seen.add(v.id);
      let container = this.vehicleSprites.get(v.id);
      const teamColor = teamColorForVehicle(v, this.myVehicleId, this.squadVehicleIds, this.gangPrimaryColour, this.rival?.primary_colour);
      // Orders only apply to squadmates other than the player-driven primary
      const isSquadmate = this.squadVehicleIds.includes(v.id) && v.id !== this.myVehicleId;
      const order = isSquadmate ? this.squadOrders.get(v.id) : undefined;
      const opts = { isPlayer: v.id === this.myVehicleId, teamColor, order };

      if (!container) {
        container = buildVehicleSprite(this, v, opts);
        this.vehicleSprites.set(v.id, container);
      }

      const worldX = WORLD_CENTER_X + v.position.x * PIXELS_PER_INCH;
      const worldY = WORLD_CENTER_Y + v.position.y * PIXELS_PER_INCH;
      const rotation = Phaser.Math.DegToRad(v.facing);
      if (!this.vehicleTargets.has(v.id)) {
        container.setPosition(worldX, worldY);
        container.setRotation(rotation);
      }
      this.vehicleTargets.set(v.id, { x: worldX, y: worldY, rotation });

      updateVehicleSprite(container, v, opts);

      if (v.id === this.myVehicleId) {
        this.cameras.main.startFollow(container, false);
      }
    });

    this.vehicleSprites.forEach((container, id) => {
      if (!seen.has(id)) {
        container.destroy();
        this.vehicleSprites.delete(id);
        this.vehicleTargets.delete(id);
        this.squadOrders.delete(id); // clear stale order when squadmate is destroyed
      }
    });

    this.syncWreckage(state);
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

      // Weapon-typed tracer: colour by hit/miss, keep it subtle
      const tracer = this.add.graphics().setDepth(5);
      if (ev.hit) tracer.lineStyle(2, 0xff4400, 0.9);
      else        tracer.lineStyle(1, 0xffff00, 0.5);
      tracer.beginPath();
      tracer.moveTo(fromX, fromY);
      tracer.lineTo(toX, toY);
      tracer.strokePath();
      this.time.delayedCall(220, () => tracer.destroy());

      // Hit flash + floating "−{dmg} {weapon}" in red, MISS label in grey
      if (ev.hit) {
        const flash = this.add.graphics().setDepth(5);
        flash.fillStyle(0xff6600, 0.85);
        flash.fillCircle(toX, toY, 14);
        flash.lineStyle(2, 0xffffff, 0.7);
        flash.strokeCircle(toX, toY, 14);
        this.time.delayedCall(200, () => flash.destroy());

        const damage = ev.damage ?? 0;
        const destroyed = !!ev.destroyed;
        const label = destroyed
          ? `💀 -${damage} ${ev.weapon.toUpperCase()}`
          : `-${damage} ${ev.weapon.toUpperCase()}`;
        const color = destroyed ? '#ffdd44' : '#ff5544';
        const fontSize = destroyed ? '18px' : '15px';
        const txt = this.add.text(toX, toY - 18, label, {
          fontSize, color, fontFamily: 'monospace', fontStyle: 'bold',
          stroke: '#000', strokeThickness: 3,
        }).setOrigin(0.5).setDepth(15);
        this.tweens.add({
          targets: txt,
          y: toY - 48,
          alpha: 0,
          duration: 1000,
          ease: 'Cubic.easeOut',
          onComplete: () => txt.destroy(),
        });
      } else {
        const txt = this.add.text(toX, toY - 18, `MISS ${ev.weapon.toUpperCase()}`, {
          fontSize: '12px', color: '#888888', fontFamily: 'monospace',
          stroke: '#000', strokeThickness: 2,
        }).setOrigin(0.5).setDepth(15);
        this.tweens.add({
          targets: txt,
          y: toY - 38,
          alpha: 0,
          duration: 700,
          ease: 'Cubic.easeOut',
          onComplete: () => txt.destroy(),
        });
      }

      // Combat log: append this event and re-render
      this.logCombatEvent(ev);
    });
  }

  private combatLog: string[] = [];
  private combatLogText!: Phaser.GameObjects.Text;

  private logCombatEvent(ev: CombatEvent): void {
    const shortId = (id: string) => {
      if (id === this.myVehicleId) return 'YOU';
      if (id.startsWith('ai-')) return id.toUpperCase();
      return id.slice(0, 6);
    };
    const line = ev.hit
      ? `${shortId(ev.attackerId)} → ${shortId(ev.targetId)}  ${ev.weapon.toUpperCase()}  -${ev.damage ?? 0}${ev.destroyed ? ' 💀' : ''}`
      : `${shortId(ev.attackerId)} → ${shortId(ev.targetId)}  ${ev.weapon.toUpperCase()}  MISS`;
    this.combatLog.push(line);
    if (this.combatLog.length > 6) this.combatLog.shift();
    if (this.combatLogText) this.combatLogText.setText(this.combatLog.join('\n'));
  }

  private drawMinimap(state: ZoneState): void {
    const MM_SIZE = 120, MM_SCALE = 3;
    const MM_X = this.scale.width - MM_SIZE - 16;
    const MM_Y = 16;
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

  private syncWreckage(state: ZoneState): void {
    const wrecks = state.wreckage ?? [];
    const seen = new Set<string>();

    wrecks.forEach(w => {
      seen.add(w.id);
      let container = this.wreckSprites.get(w.id);
      const bodyKey = w.bodyType ?? 'mid_sized';
      const texKey = `wreck_${bodyKey}_${w.state}`;

      if (!container) {
        const sprite = this.add.image(0, 0, texKey).setName('body');
        const children: Phaser.GameObjects.GameObject[] = [sprite];
        if (w.state === 'burning') {
          const flame = this.add.circle(0, 0, 10, 0xff8844, 0.45).setName('flame');
          children.unshift(flame);
        }
        container = this.add.container(0, 0, children).setDepth(1);  // below vehicles (depth 2)
        this.wreckSprites.set(w.id, container);
      } else {
        // State may have transitioned — swap the body texture
        const body = container.getByName('body') as Phaser.GameObjects.Image | null;
        if (body && body.texture.key !== texKey) body.setTexture(texKey);
        // Remove/add flame as state changes
        const flame = container.getByName('flame') as Phaser.GameObjects.Arc | null;
        if (w.state === 'burning' && !flame) {
          const newFlame = this.add.circle(0, 0, 10, 0xff8844, 0.45).setName('flame');
          container.addAt(newFlame, 0);
        } else if (w.state !== 'burning' && flame) {
          flame.destroy();
        }
      }

      const worldX = WORLD_CENTER_X + w.position.x * PIXELS_PER_INCH;
      const worldY = WORLD_CENTER_Y + w.position.y * PIXELS_PER_INCH;
      container.setPosition(worldX, worldY);
      container.setRotation(Phaser.Math.DegToRad(w.facing));
    });

    this.wreckSprites.forEach((c, id) => {
      if (!seen.has(id)) {
        c.destroy();
        this.wreckSprites.delete(id);
      }
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

  private showZoneEnd(winnerId: string | null, reason: string, prize: number, jobPayout: number, salvage: number, wages: number, maintenance: number, rival?: import('@carwars/shared').RivalInfo, rivalQuote?: string): void {
    if (this.zoneEnded) return;
    this.zoneEnded = true;

    // Player vehicle may be alive (in state.vehicles) or destroyed (now a wreck).
    // If alive, we can read its playerId for the winner check; if wrecked, the player
    // can't have won — whoever's left is.
    const myVehicle = this.zoneState?.vehicles.find(v => v.id === this.myVehicleId);
    const myWreck = this.zoneState?.wreckage?.find(w => w.sourceVehicleId === this.myVehicleId);
    const wasDestroyed = !myVehicle && !!myWreck;
    const isWinner = !!myVehicle && !!winnerId && myVehicle.playerId === winnerId;

    // Clear active job from localStorage if we won (job was auto-completed server-side)
    if (isWinner) {
      localStorage.removeItem('cw_active_job');
      localStorage.removeItem('cw_active_job_desc');
      localStorage.removeItem('cw_active_job_payout');
    }

    // Sidebar-style panel on the right so the battlefield remains visible
    const { width: screenW, height: screenH } = this.scale;
    const PW = 360;      // panel width
    const PX = screenW - PW / 2 - 20;     // panel centre x — anchored to the right edge
    const PH = Math.min(700, screenH - 20);
    this.add.rectangle(PX, screenH / 2, PW, PH, 0x000000, 0.92).setScrollFactor(0).setDepth(10)
      .setStrokeStyle(2, 0x4466aa);

    // Title: VICTORY if we survived as the winner; DEFEATED if our car was destroyed
    // or the AI was the last team standing; DRAW if everyone died simultaneously.
    let titleText: string;
    let titleColor: string;
    if (isWinner) {
      titleText = 'VICTORY';
      titleColor = '#00ff88';
    } else if (wasDestroyed || reason === 'ai_victory') {
      titleText = 'DEFEATED';
      titleColor = '#ff4444';
    } else if (reason === 'all_destroyed') {
      titleText = 'DRAW — ALL DESTROYED';
      titleColor = '#ffaa00';
    } else {
      titleText = 'BATTLE OVER';
      titleColor = '#ffaa00';
    }
    const panelTopY = Math.max(20, screenH / 2 - PH / 2);
    this.add.text(PX, panelTopY + 40, titleText, {
      fontSize: '32px', color: titleColor, fontFamily: 'monospace', fontStyle: 'bold'
    }).setOrigin(0.5).setScrollFactor(0).setDepth(11);

    let y = panelTopY + 80;

    // Rival banner: name + quote (if the server sent us one)
    if (rival) {
      const bannerColor = '#' + rival.primary_colour.toString(16).padStart(6, '0');
      this.add.text(PX, y, `vs. ${rival.name}`, {
        fontSize: '16px', color: bannerColor, fontFamily: 'monospace', fontStyle: 'italic'
      }).setOrigin(0.5).setScrollFactor(0).setDepth(11);
      y += 22;
      if (rivalQuote) {
        const quoteText = this.add.text(PX, y, `"${rivalQuote}"`, {
          fontSize: '11px', color: '#bbb', fontFamily: 'monospace',
          wordWrap: { width: PW - 30 }, align: 'center',
        }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(11);
        y += quoteText.height + 10;
      }
    }

    // Financial summary (only meaningful for winner)
    if (isWinner) {
      if (prize > 0) {
        this.add.text(PX, y, `Prize:      $${prize.toLocaleString()}`, {
          fontSize: '14px', color: '#ffcc00', fontFamily: 'monospace'
        }).setOrigin(0.5).setScrollFactor(0).setDepth(11);
        y += 22;
      }
      if (jobPayout > 0) {
        this.add.text(PX, y, `Job:        $${jobPayout.toLocaleString()}`, {
          fontSize: '14px', color: '#ffcc00', fontFamily: 'monospace'
        }).setOrigin(0.5).setScrollFactor(0).setDepth(11);
        y += 22;
      }
      if (salvage > 0) {
        this.add.text(PX, y, `Salvage:    $${salvage.toLocaleString()}`, {
          fontSize: '14px', color: '#aa88ff', fontFamily: 'monospace'
        }).setOrigin(0.5).setScrollFactor(0).setDepth(11);
        y += 22;
      }
      const income = prize + jobPayout + salvage;
      if (income > 0) {
        this.add.text(PX, y, `Income:     $${income.toLocaleString()}`, {
          fontSize: '14px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold'
        }).setOrigin(0.5).setScrollFactor(0).setDepth(11);
        y += 26;
      }
    }

    // Expenses — always shown if present (both winners and losers pay)
    if (wages > 0 || maintenance > 0) {
      if (wages > 0) {
        this.add.text(PX, y, `Wages:     -$${wages.toLocaleString()}`, {
          fontSize: '14px', color: '#ff8888', fontFamily: 'monospace'
        }).setOrigin(0.5).setScrollFactor(0).setDepth(11);
        y += 22;
      }
      if (maintenance > 0) {
        this.add.text(PX, y, `Upkeep:    -$${maintenance.toLocaleString()}`, {
          fontSize: '14px', color: '#ff8888', fontFamily: 'monospace'
        }).setOrigin(0.5).setScrollFactor(0).setDepth(11);
        y += 22;
      }
      const net = prize + jobPayout + salvage - wages - maintenance;
      const netColor = net >= 0 ? '#00ff88' : '#ff4444';
      this.add.text(PX, y, `Net:  ${net >= 0 ? '+' : '-'}$${Math.abs(net).toLocaleString()}`, {
        fontSize: '15px', color: netColor, fontFamily: 'monospace', fontStyle: 'bold'
      }).setOrigin(0.5).setScrollFactor(0).setDepth(11);
      y += 28;
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
      this.add.text(PX, y, `Damage: ${armorLost} armor pts lost${flags ? `  [${flags}]` : ''}`, {
        fontSize: '14px', color: dmgColor, fontFamily: 'monospace'
      }).setOrigin(0.5).setScrollFactor(0).setDepth(11);
      y += 24;
    } else if (wasDestroyed) {
      this.add.text(PX, y, `Vehicle: TOTAL LOSS  [${myWreck!.state.toUpperCase()}]`, {
        fontSize: '14px', color: '#ff5555', fontFamily: 'monospace'
      }).setOrigin(0.5).setScrollFactor(0).setDepth(11);
      y += 24;
    }

    // Per-vehicle kill breakdown when squad > 1
    if (this.squadVehicleIds.length > 1 && this.zoneState) {
      y += 6;
      this.add.text(PX, y, 'SQUAD REPORT', {
        fontSize: '13px', color: '#aaa', fontFamily: 'monospace', fontStyle: 'bold'
      }).setOrigin(0.5).setScrollFactor(0).setDepth(11);
      y += 20;
      for (const vid of this.squadVehicleIds) {
        const alive = this.zoneState.vehicles.find(v => v.id === vid);
        const wreck = this.zoneState.wreckage?.find(w => w.sourceVehicleId === vid);
        const kills = (this.zoneState.wreckage ?? []).filter(w => w.killedByVehicleId === vid).length;
        const name = (alive?.stats.name ?? wreck?.sourceVehicleId ?? vid).slice(0, 20);
        const statusStr = alive ? 'survived' : wreck ? `[${wreck.state.toUpperCase()}]` : 'lost';
        const statusColor = alive ? '#88ff88' : '#ff5555';
        this.add.text(PX, y, `${name}: ${kills} kill${kills === 1 ? '' : 's'}, ${statusStr}`, {
          fontSize: '12px', color: statusColor, fontFamily: 'monospace'
        }).setOrigin(0.5).setScrollFactor(0).setDepth(11);
        y += 18;
      }
    }

    // Return to garage button — always near bottom of the sidebar
    y = Math.max(y + 10, panelTopY + PH - 60);
    const garageBtn = this.add.text(PX, y, '[RETURN TO GARAGE]', {
      fontSize: '14px', color: '#aaaaff', fontFamily: 'monospace',
      backgroundColor: '#111133', padding: { x: 10, y: 5 }
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
      const orig = (origArmor as Record<string, number>)[face];
      if (!orig) {
        text.setText(`${labelMap[face]}: --`);
        return;
      }
      const pct = cur / orig;
      const color = pct >= 0.75 ? '#00ff88' : pct >= 0.25 ? '#ffaa00' : '#ff3333';
      text.setColor(color).setText(`${labelMap[face]}: ${cur}`);
    });
  }

  // Top-centre banner: 'vs. THE IRON WOLVES' in the rival's primary colour,
  // with a small emblem to its left painted from the gang's palette.
  private showRivalBanner(rival: import('@carwars/shared').RivalInfo): void {
    const { width } = this.scale;
    const cx = width / 2;
    const color = '#' + rival.primary_colour.toString(16).padStart(6, '0');

    if (!this.rivalBanner) {
      this.rivalBanner = this.add.text(cx, 36, `vs. ${rival.name.toUpperCase()}`, {
        color, fontSize: '18px', fontFamily: 'monospace', fontStyle: 'bold',
        backgroundColor: '#000000aa', padding: { x: 10, y: 4 },
      }).setOrigin(0.5).setScrollFactor(0).setDepth(25);
    } else {
      this.rivalBanner.setText(`vs. ${rival.name.toUpperCase()}`).setColor(color);
    }

    const emblemKey = `rival-emblem-${rival.id}`;
    if (!this.textures.exists(emblemKey)) {
      const canvas = document.createElement('canvas');
      canvas.width = 28; canvas.height = 28;
      paintEmblem(canvas, rival.emblem_id as EmblemId, rival.primary_colour, rival.secondary_colour);
      this.textures.addCanvas(emblemKey, canvas);
    }
    if (!this.rivalEmblem) {
      this.rivalEmblem = this.add.image(cx, 36, emblemKey)
        .setOrigin(0.5).setScrollFactor(0).setDepth(26).setDisplaySize(24, 24);
    } else {
      this.rivalEmblem.setTexture(emblemKey);
    }
    this.positionRivalBanner();
  }

  private positionRivalBanner(): void {
    if (!this.rivalBanner) return;
    const cx = this.scale.width / 2;
    // Put the emblem to the left of the text, separated by a small gap
    this.rivalBanner.setPosition(cx, 36);
    const textLeftEdge = this.rivalBanner.x - this.rivalBanner.displayWidth / 2;
    this.rivalEmblem?.setPosition(textLeftEdge - 18, 36);
  }

  private layoutHud(): void {
    const { width, height } = this.scale;
    // HUD that lives in the top-left stays put — just make sure the minimap label
    // and combat log track the right and bottom edges respectively.
    const MM_SIZE = 120;
    this.minimapLabel?.setPosition(width - MM_SIZE - 16, 4);
    this.combatLogHeading?.setPosition(16, height - 140);
    this.combatLogText?.setPosition(16, height - 122);
    this.positionRivalBanner();
    // Resize the main + UI camera viewports to match the new canvas size so
    // world rendering and the HUD both use the full window.
    this.cameras.main.setSize(width, height);
    this.uiCam?.setSize(width, height);
  }

  // Partition the display list across the two cameras: scrollFactorX===0 means
  // "fixed HUD" → main cam ignores it so it's only drawn by the unzoomed UI
  // cam. Everything else (world objects) stays on the main cam and is hidden
  // from the UI cam. WeakSets dedupe so a child is only ignored once.
  private refreshHud(): void {
    if (!this.uiCam) return;
    for (const obj of this.children.list) {
      const isHud = (obj as unknown as { scrollFactorX?: number }).scrollFactorX === 0;
      if (isHud) {
        if (!this.hudIgnored.has(obj)) {
          this.cameras.main.ignore(obj);
          this.hudIgnored.add(obj);
        }
      } else {
        if (!this.worldIgnored.has(obj)) {
          this.uiCam.ignore(obj);
          this.worldIgnored.add(obj);
        }
      }
    }
  }

  update(time: number): void {
    if (!this.zoneState) return;

    this.refreshHud();
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

    // Continuous acceleration: ±5 mph per 100ms tick.
    // Forward range: 0 → maxSpeed (hold up/W).
    // Reverse range: 0 → -30 mph (hold down/S past 0). Reverse is capped at a
    // fraction of forward max, matching real vehicle feel.
    const upHeld = this.cursors.up?.isDown || this.wasdKeys.w.isDown;
    const downHeld = this.cursors.down?.isDown || this.wasdKeys.s.isDown;
    const REVERSE_MAX = -30;
    if (upHeld)   this.clientSpeed = Math.min(this.clientSpeed + 5, maxSpeed);
    if (downHeld) this.clientSpeed = Math.max(this.clientSpeed - 5, REVERSE_MAX);
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
