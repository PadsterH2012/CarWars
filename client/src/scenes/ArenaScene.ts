import Phaser from 'phaser';
import { Connection } from '../game/Connection';
import type { ZoneState, CombatEvent } from '@carwars/shared';
import { isPerceived, visibilityPolygon, sightRange, RADAR_ID, RADAR_RANGE, type Pt } from '../game/visibility';
import arenaMapData from '../tilemaps/arena-1.json';
import { preloadVehicleSprites, buildVehicleSprite, updateVehicleSprite, teamColorForVehicle } from '../game/VehicleSprite';
import { bindFullscreenToggle, onLayout } from '../ui/responsive';
import { paintEmblem, type EmblemId } from '../game/CoatOfArms';
import { renderMapFloor, renderMapWalls, renderMapDecorations, renderMapFloorStretch, renderMapFloorTiled, type MapRenderOptions } from '../rendering/mapRenderer';

const PIXELS_PER_INCH = 32;
const WORLD_CENTER_X = 640;
const WORLD_CENTER_Y = 360;
const RENDER_OPTS: MapRenderOptions = { centerX: WORLD_CENTER_X, centerY: WORLD_CENTER_Y, pixelsPerInch: PIXELS_PER_INCH };

// Interpolation target per vehicle — updated on each zone_state, lerped toward each frame
interface VehicleTarget { x: number; y: number; rotation: number; }

// ─── Map visual theming ──────────────────────────────────────────────────────
// Palette tints the off-grid background fill. Individual floor tiles override
// local surface so palette only sets the ambient tone.
function paletteBackground(palette?: import('@carwars/shared').MapPalette): number {
  switch (palette) {
    case 'industrial': return 0x0a0e14;
    case 'urban':      return 0x0b0810;
    case 'desert':     return 0x140d08;
    case 'wasteland':  return 0x080808;
    default:           return 0x0a0a14;
  }
}

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
  private defenseZoneId: string | undefined;
  private rivalId: string | undefined; // free-pick opponent chosen in the garage
  private lastInputSent = 0;
  private zoneEnded = false;
  private encounterTravelContext: { fromNodeId: string; toNodeId: string } | null = null;
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
  // ── Fog of war ───────────────────────────────────────────────────────────
  // World-space render textures over the map. fogDim darkens everywhere the
  // squad can't currently see; fogDark adds extra darkness on never-explored
  // ground; fogExplored is an offscreen buffer accumulating ever-seen area.
  // fogVis is a scratch Graphics holding this tick's visibility polygons.
  private fogDim?: Phaser.GameObjects.RenderTexture;
  private fogDark?: Phaser.GameObjects.RenderTexture;
  private fogExplored?: Phaser.GameObjects.RenderTexture;
  private fogVis?: Phaser.GameObjects.Graphics;
  private fogMapW = 0;  // map dimensions in inches
  private fogMapH = 0;
  // Extra layers (below walls): floor surfaces and non-colliding decorations
  private floorGraphics!: Phaser.GameObjects.Graphics;
  private floorImages: Phaser.GameObjects.Image[] = [];
  private floorSprites: Phaser.GameObjects.TileSprite[] = [];
  private floorMode: 'graphics' | 'stretch' | 'tiled' = 'stretch';  // <--- SWITCH HERE
  private floorContainer!: Phaser.GameObjects.Container;
  private decorationGraphics!: Phaser.GameObjects.Graphics;
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

  init(data: { token?: string; vehicleId?: string; jobId?: string; squadVehicleIds?: string[]; mapId?: string; gangPrimaryColour?: number; defenseZoneId?: string; rivalId?: string }): void {
    this.token = data.token ?? '';
    this.myVehicleId = data.vehicleId ?? 'v1';
    this.squadVehicleIds = data.squadVehicleIds && data.squadVehicleIds.length > 0
      ? data.squadVehicleIds
      : [this.myVehicleId];
    this.mapId = data.mapId ?? 'truck-stop';
    this.gangPrimaryColour = data.gangPrimaryColour;
    this.jobId = data.jobId ?? '';
    this.defenseZoneId = data.defenseZoneId;
    this.rivalId = data.rivalId;

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
    // Fog of war re-initialises from the next join (old RTs are destroyed with
    // the scene on restart). Lazy-created once map dimensions arrive.
    this.fogDim = this.fogDark = this.fogExplored = undefined;
    this.fogVis = undefined;
    this.fogMapW = this.fogMapH = 0;
    this.zoneEnded = false;
    this.firePending = false;
    this.selectedMountIndex = 0;
    this.autopilot = false;
    this.clientSpeed = 0;
  }

  preload(): void {
    preloadVehicleSprites(this);
    // Tile images for textured floor rendering (stretch / tiled modes)
    this.load.image('tile_asphalt', '/assets/tiles/asphalt.jpg');
    this.load.image('tile_concrete', '/assets/tiles/concrete.jpg');
    this.load.image('tile_dirt', '/assets/tiles/dirt.jpg');
    this.load.image('tile_gravel', '/assets/tiles/gravel.jpg');
    this.load.image('tile_sand', '/assets/tiles/sand.jpg');
    this.load.image('tile_scrub_grass', '/assets/tiles/scrub_grass.jpg');
    this.load.image('tile_rust_plate', '/assets/tiles/rust_plate.jpg');
    this.load.image('tile_neon', '/assets/tiles/neon.jpg');
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
    // Floor and decoration layers sit between the dark background fill (depth 0)
    // and the walls (depth 1) so walls always sit on top of painted surfaces.
    this.floorGraphics = this.add.graphics().setDepth(0.4);
    this.floorContainer = this.add.container(0, 0).setDepth(0.35);
    this.decorationGraphics = this.add.graphics().setDepth(0.7);
    this.mapGraphics = this.add.graphics().setDepth(1);  // above ground, below vehicles

    // Combat log panel — bottom-left, shows the last 6 events
    this.combatLogHeading = this.add.text(16, this.scale.height - 140, 'COMBAT', {
      fontSize: '11px', color: '#888', fontFamily: 'monospace', fontStyle: 'bold'
    }).setScrollFactor(0).setDepth(20);
    this.combatLogText = this.add.text(16, this.scale.height - 122, '', {
      fontSize: '11px', color: '#cccccc', fontFamily: 'monospace',
      backgroundColor: '#000000aa', padding: { x: 6, y: 4 }, lineSpacing: 2,
    }).setScrollFactor(0).setDepth(20);
    // Minimap label (right-edge)
    this.minimapLabel = this.add.text(this.scale.width - 136, 4, 'MAP', {
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
      const zoneId = this.defenseZoneId ?? zoneOverride ?? `arena-${this.mapId}`;
      this.connection.send({
        type: 'join_zone',
        zoneId: zoneId,
        vehicleId: this.myVehicleId,
        token: this.token,
        jobId: this.jobId || undefined,
        squadVehicleIds: this.squadVehicleIds,
        mapId: this.mapId,
        rivalId: this.rivalId,
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
            // Any map with explicit dimensions gets its own camera bounds + palette-
            // tinted background fill. The embedded default tilemap is hidden since
            // it's not authored to match this map's size.
            this.tilemapLayers.forEach(l => l.setVisible(false));
            const mapW = msg.state.mapWidth * PIXELS_PER_INCH;
            const mapH = msg.state.mapHeight * PIXELS_PER_INCH;
            const mapX = WORLD_CENTER_X - mapW / 2;
            const mapY = WORLD_CENTER_Y - mapH / 2;
            const bgColor = paletteBackground(msg.state.palette);
            this.bgGraphics.fillStyle(bgColor, 1);
            this.bgGraphics.fillRect(mapX, mapY, mapW, mapH);
            // Zoom level tuned by map size — bigger maps zoom out more so the player
            // can see across the arena
            const zoomForMap = msg.state.mapWidth > 80 ? 0.6 : msg.state.mapWidth > 50 ? 0.85 : 1.1;
            this.cameras.main.setZoom(zoomForMap);
            this.cameras.main.setBounds(mapX, mapY, mapW, mapH);
            this.initFog(msg.state.mapWidth, msg.state.mapHeight);
          }
          // Paint floor surfaces and decorations from the join message (both
          // are static for the match — re-rendered only on scene restart).
          if (msg.state.floor && msg.state.floor.length > 0) {
            this.renderMapFloor(msg.state.floor);
          }
          if (msg.state.decorations && msg.state.decorations.length > 0) {
            this.renderMapDecorations(msg.state.decorations);
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
        this.showZoneEnd(msg.winnerId, msg.reason, msg.prize ?? 0, msg.jobPayout ?? 0, msg.salvage ?? 0, msg.wages ?? 0, msg.maintenance ?? 0, msg.rival, msg.rivalQuote, msg.replayId, msg.spawnAt);
      } else if (msg.type === 'zone_join_error') {
        // The server refused entry (a selected vehicle is deployed, or its
        // driver is on a headless job). Without this the arena would sit on the
        // empty default grid forever, since no zone_state ever arrives.
        this.showJoinError(msg.error);
      }
    });
  }

  private syncSprites(state: ZoneState): void {
    const seen = new Set<string>();
    const viewers = this.friendlyViewers(state);

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

      // Fog of war: an enemy vehicle is only drawn while the squad can perceive
      // it (LOS or radar). It vanishes the moment it slips out of sight.
      const isEnemy = v.playerId === 'ai-team';
      container.setVisible(!isEnemy || isPerceived(v.position, viewers, this.mapWalls, sightRange(this.driverSkill)));

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
    this.updateFog(state);
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

    // Fog of war: only show enemy blips the squad can actually perceive (LOS
    // from any squad vehicle, or radar coverage). Shared with the main-view fog.
    const viewers = this.friendlyViewers(state);
    const radar = viewers.some(v => (v.stats.loadout?.accessories ?? []).some(a => a.id === RADAR_ID));
    if (this.minimapLabel) this.minimapLabel.setText(radar ? 'MAP ◉' : 'MAP');

    state.vehicles.forEach(v => {
      const isPlayer = v.id === this.myVehicleId;
      const isEnemy  = v.playerId === 'ai-team';
      if (isEnemy && !isPerceived(v.position, viewers, this.mapWalls, sightRange(this.driverSkill))) return;
      const color = isPlayer ? 0x00ff88 : (isEnemy ? 0xff4444 : 0xffaa00);
      const dotX = Math.max(MM_X + 2, Math.min(MM_X + MM_SIZE - 2, cx + v.position.x * MM_SCALE));
      const dotY = Math.max(MM_Y + 2, Math.min(MM_Y + MM_SIZE - 2, cy + v.position.y * MM_SCALE));
      gfx.fillStyle(color, 1);
      gfx.fillCircle(dotX, dotY, isPlayer ? 4 : 3);
    });
  }

  // The player's own living vehicles — the squad that provides vision.
  private friendlyViewers(state: ZoneState) {
    return state.vehicles.filter(v =>
      !v.stats.damageState?.destroyed &&
      (v.id === this.myVehicleId || this.squadVehicleIds.includes(v.id)),
    );
  }

  // Create the fog render textures once the map size is known (in inches).
  private initFog(mapWInch: number, mapHInch: number): void {
    this.fogMapW = mapWInch;
    this.fogMapH = mapHInch;
    const wPx = mapWInch * PIXELS_PER_INCH, hPx = mapHInch * PIXELS_PER_INCH;
    const x = WORLD_CENTER_X - wPx / 2, y = WORLD_CENTER_Y - hPx / 2;
    // Offscreen buffer that accumulates ever-seen area ("explored memory").
    this.fogExplored = this.add.renderTexture(0, 0, wPx, hPx).setOrigin(0, 0).setVisible(false);
    // Two world-space dark overlays above the action (below the HUD at 20).
    this.fogDim  = this.add.renderTexture(x, y, wPx, hPx).setOrigin(0, 0).setDepth(9);
    this.fogDark = this.add.renderTexture(x, y, wPx, hPx).setOrigin(0, 0).setDepth(9.1);
    // Scratch graphics holding this tick's visibility polygons (in RT-local px).
    this.fogVis = this.add.graphics().setVisible(false);
  }

  // Recompute the fog each tick: union the squad's visibility polygons (true
  // line-of-sight shadowcasting), accumulate explored area, then paint the dim
  // (not-currently-visible) and dark (never-explored) overlays.
  private updateFog(state: ZoneState): void {
    if (!this.fogDim || !this.fogDark || !this.fogExplored || !this.fogVis || !this.mapWalls.length) return;
    const PPI = PIXELS_PER_INCH;
    const halfW = this.fogMapW / 2, halfH = this.fogMapH / 2;
    const bounds = { x: 0, y: 0, w: this.fogMapW, h: this.fogMapH };
    const viewers = this.friendlyViewers(state);

    const g = this.fogVis;
    const toLocal = (p: Pt) => ({ x: (p.x + halfW) * PPI, y: (p.y + halfH) * PPI });
    const sight = sightRange(this.driverSkill);
    const radar = viewers.some(v => (v.stats.loadout?.accessories ?? []).some(a => a.id === RADAR_ID));

    // One LOS shadowcast per viewer, clipped to sight range (a torch shaped by
    // walls). Reused for both the explored buffer and the falloff fill.
    const polys = viewers.map(v => ({ v, poly: visibilityPolygon(v.position, this.mapWalls, bounds, sight) }));
    const fillPoly = (origin: Pt, poly: Pt[], f: number) => {
      if (poly.length < 3) return;
      g.beginPath();
      poly.forEach((p, i) => {
        const sx = origin.x + (p.x - origin.x) * f, sy = origin.y + (p.y - origin.y) * f;
        const l = toLocal({ x: sx, y: sy });
        if (i === 0) g.moveTo(l.x, l.y); else g.lineTo(l.x, l.y);
      });
      g.closePath();
      g.fillPath();
    };

    // Pass 1 — HARD lit area (full opacity) → accumulate "explored memory".
    g.clear();
    g.fillStyle(0xffffff, 1);
    for (const { v, poly } of polys) fillPoly(v.position, poly, 1);
    if (radar) for (const v of viewers) { const l = toLocal(v.position); g.fillCircle(l.x, l.y, RADAR_RANGE * PPI); }
    this.fogExplored.draw(g);

    // Pass 2 — SOFT lit area: nested polygons scaled toward each viewer build a
    // radial falloff (bright at the car, fading to the sight edge).
    g.clear();
    g.fillStyle(0xffffff, 0.38);
    const LAYERS = [1.0, 0.78, 0.56, 0.34];
    for (const { v, poly } of polys) for (const f of LAYERS) fillPoly(v.position, poly, f);
    if (radar) { g.fillStyle(0xffffff, 1); for (const v of viewers) { const l = toLocal(v.position); g.fillCircle(l.x, l.y, RADAR_RANGE * PPI); } }

    // Paint the overlays by erasing the lit area: fogDim fades with the soft
    // pass; fogDark uses the hard explored memory.
    this.fogDim.clear();  this.fogDim.fill(0x000000, 0.55);  this.fogDim.erase(g);
    this.fogDark.clear(); this.fogDark.fill(0x000000, 0.40); this.fogDark.erase(this.fogExplored);
  }

  private syncWreckage(state: ZoneState): void {
    const wrecks = state.wreckage ?? [];
    const seen = new Set<string>();
    const viewers = this.friendlyViewers(state);

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
      container.setVisible(isPerceived(w.position, viewers, this.mapWalls, sightRange(this.driverSkill))); // fog
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
    const viewers = this.friendlyViewers(state);
    state.hazardObjects.forEach(h => {
      seen.add(h.id);
      let sprite = this.hazardSprites.get(h.id) as (Phaser.GameObjects.Components.Visible & Phaser.GameObjects.GameObject) | undefined;
      if (!sprite) {
        const worldX = WORLD_CENTER_X + h.position.x * PIXELS_PER_INCH;
        const worldY = WORLD_CENTER_Y + h.position.y * PIXELS_PER_INCH;
        sprite = h.type === 'oil'
          ? this.add.ellipse(worldX, worldY, 32, 16, 0x112211, 0.7).setDepth(1.5)
          : this.add.circle(worldX, worldY, 6, 0xff2200).setDepth(1.5);
        this.hazardSprites.set(h.id, sprite as Phaser.GameObjects.GameObject);
      }
      sprite.setVisible(isPerceived(h.position, viewers, this.mapWalls, sightRange(this.driverSkill))); // fog
    });
    this.hazardSprites.forEach((sprite, id) => {
      if (!seen.has(id)) {
        (sprite as Phaser.GameObjects.Ellipse | Phaser.GameObjects.Arc).destroy();
        this.hazardSprites.delete(id);
      }
    });
  }

  // Paint each floor tile as a filled rectangle in palette-consistent colours.
  // Tiles are centred on their (x, y) world position — no rotation is applied here,
  // rotation has already been baked into w/h by the composer.
  private renderMapFloor(floor: import('@carwars/shared').FloorTile[]): void {
    // Clear previous image-based tiles
    this.floorImages.forEach(img => img.destroy());
    this.floorImages = [];
    this.floorSprites.forEach(spr => spr.destroy());
    this.floorSprites = [];
    this.floorGraphics.clear();

    switch (this.floorMode) {
      case 'stretch':
        this.floorImages = renderMapFloorStretch(this, floor, RENDER_OPTS, this.floorContainer);
        break;
      case 'tiled':
        this.floorSprites = renderMapFloorTiled(this, floor, RENDER_OPTS, this.floorContainer);
        break;
      case 'graphics':
      default:
        renderMapFloor(this.floorGraphics, floor, RENDER_OPTS);
        break;
    }
  }

  private renderMapDecorations(decorations: import('@carwars/shared').Decoration[]): void {
    renderMapDecorations(this.decorationGraphics, decorations, RENDER_OPTS);
  }

  private renderMapWalls(walls: import('@carwars/shared').Rect[]): void {
    renderMapWalls(this.mapGraphics, walls, RENDER_OPTS);
  }

  private showZoneEnd(winnerId: string | null, reason: string, prize: number, jobPayout: number, salvage: number, wages: number, maintenance: number, rival?: import('@carwars/shared').RivalInfo, rivalQuote?: string, replayId?: string, spawnAt?: 'garage' | 'town'): void {
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

    // Classify outcome for the result screen
    const result: 'win' | 'loss' | 'draw' | 'destroyed' =
      isWinner ? 'win'
      : wasDestroyed ? 'destroyed'
      : reason === 'all_destroyed' ? 'draw'
      : 'loss';

    // Brief 600 ms transition so the final hit lands, then hand off to ResultScene.
    // Disconnect the WebSocket so the runner can tear down the zone.
    this.time.delayedCall(600, () => {
      this.connection.send({ type: 'leave_zone' });
      this.connection.close();
      this.scene.start('ResultScene', {
        token: this.token,
        result,
        prize, jobPayout, salvage, wages, maintenance,
        rival, rivalQuote,
        vehicleIds: this.squadVehicleIds,
        primaryVehicleId: this.myVehicleId,
        mapId: this.mapId,
        gangPrimaryColour: this.gangPrimaryColour,
        replayId,
        spawnAt,
      });
    });
  }

  // Server refused the join — overlay the reason and bounce back to the garage
  // rather than leaving the player on an empty arena with no feedback.
  private showJoinError(error: string): void {
    this.connection.close();
    const { width, height } = this.scale;
    this.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.72).setScrollFactor(0).setDepth(50);
    this.add.text(width / 2, height / 2 - 24, 'CANNOT ENTER ARENA', {
      fontSize: '24px', fontFamily: 'monospace', color: '#ff4444', fontStyle: 'bold',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(51);
    this.add.text(width / 2, height / 2 + 14, error, {
      fontSize: '14px', fontFamily: 'monospace', color: '#ffcc88', align: 'center', wordWrap: { width: width * 0.7 },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(51);
    this.add.text(width / 2, height / 2 + 58, 'Returning to garage…', {
      fontSize: '12px', fontFamily: 'monospace', color: '#888888',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(51);
    this.time.delayedCall(2200, () => this.scene.start('GarageScene', { token: this.token }));
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
