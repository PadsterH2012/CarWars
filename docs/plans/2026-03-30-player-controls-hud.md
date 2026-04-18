# Player Controls & HUD Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current binary speed/fixed-steer controls with continuous acceleration, skill-gated steering, weapon selection, and a live armor/speed HUD.

**Architecture:** All changes are in the client (`ArenaScene.ts`) except skill enforcement (server `handler.ts`) and a new `driver_info` shared message type. The client reads vehicle state directly from `ZoneState` — no new data fetching needed.

**Tech Stack:** Phaser 3 (client), TypeScript, WebSocket messages (`shared/src/types/messages.ts`), Express/ws (server)

---

## Context You Need

**Key files:**
- `client/src/scenes/ArenaScene.ts` — the main game scene; all controls and rendering live here
- `shared/src/types/messages.ts` — WebSocket message union types (both client→server and server→client)
- `server/src/ws/handler.ts` — handles incoming WS messages; line ~340 loads driver skill; line ~360+ handles `input` message

**How speed works today:**
- Client sends `{ type: 'input', speed: 15 | 0, steer: ±15, fireWeapon }` every 100ms
- Server engine uses whatever speed is in the input; `lastInputs` persists speed between ticks
- Vehicle `maxSpeed` is in `ZoneState.vehicles[i].stats.maxSpeed`

**How skill works today:**
- Server loads `skill` (1–6) from the `drivers` DB table for the player's vehicle on join
- Sets it via `runner.setVehicleSkill(vehicleId, skill)` — used only for AI
- Server never sends skill back to the client
- Human player input goes through with no steer capping

**Armor data location:**
- `ZoneState.vehicles[i].stats.damageState.armor` — `{ front, back, left, right, top, underbody }` (all numbers)
- `ZoneState.vehicles[i].stats.loadout.armor` — original values (for % calculation)

**Weapon data location:**
- `ZoneState.vehicles[i].stats.loadout.mounts` — array of `{ id, arc, weaponId, ammo }`

---

## Task 1: Add `driver_info` server→client message type

**Files:**
- Modify: `shared/src/types/messages.ts`
- Modify: `server/src/ws/handler.ts` (around line 349, after `runner.addClient(ws)`)

**Step 1: Add the type to shared messages**

Open `shared/src/types/messages.ts`. The `ServerMessage` union currently includes `zone_state`, `zone_end`, etc. Add:

```typescript
| { type: 'driver_info'; vehicleId: string; skill: number; maxSteer: number }
```

Full context — find the `ServerMessage` export and add the new member to the union.

**Step 2: Run TypeScript check to confirm no errors**

```bash
cd /Users/paddyharker/carwars
npm run -w server build 2>&1 | tail -5
```

Expected: build succeeds (0 errors).

**Step 3: Send `driver_info` from server after join**

In `server/src/ws/handler.ts`, find the block after `runner.addClient(ws)` (around line 349). The driver skill is loaded in the block just above it (`setVehicleSkill`). After that block, add sending the message:

```typescript
// Send driver skill back to client so HUD and steer cap are known
{
  const skill = driverRes?.rows?.[0]?.skill ?? 3;
  const maxSteer = skillToMaxSteer(skill);
  const infoMsg: ServerMessage = { type: 'driver_info', vehicleId: msg.vehicleId, skill, maxSteer };
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(infoMsg));
}
```

Add the `skillToMaxSteer` helper near the top of `handler.ts` (after imports):

```typescript
function skillToMaxSteer(skill: number): number {
  if (skill <= 2) return 15;
  if (skill <= 4) return 21;
  return 30;
}
```

**Step 4: Build and verify no TypeScript errors**

```bash
npm run -w server build 2>&1 | tail -5
```

Expected: clean build.

**Step 5: Enforce steer cap on human vehicle input**

In the `input` message handler in `handler.ts` (find the `case 'input':` or `msg.type === 'input'` block), add steer clamping before passing to `queueInput`:

```typescript
// Cap steer to driver's skill level for human vehicles
const vehicleSkill = runner['vehicleSkills']?.get(msg.vehicleId) ?? 3;
const maxSteer = skillToMaxSteer(vehicleSkill);
const clampedSteer = Math.max(-maxSteer, Math.min(maxSteer, msg.steer));
runner.queueInput(msg.vehicleId, { speed: msg.speed, steer: clampedSteer, fireWeapon: msg.fireWeapon });
```

Note: `vehicleSkills` is a private Map on ZoneRunner. Either make it accessible via a getter, or move the steer cap into `ZoneRunner.queueInput`. The cleanest approach: add a `getDriverSkill(vehicleId)` method to `ZoneRunner` and call it here.

**Step 6: Commit**

```bash
cd /Users/paddyharker/carwars
git add shared/src/types/messages.ts server/src/ws/handler.ts
git commit -m "feat: add driver_info message and server-side steer enforcement per skill"
```

---

## Task 2: Continuous speed with acceleration

**Files:**
- Modify: `client/src/scenes/ArenaScene.ts`

**Step 1: Add client speed state and WASD keys**

In `ArenaScene`, find the private fields at the top of the class (around line 20). Add:

```typescript
private clientSpeed = 0;
private wasdKeys!: { w: Phaser.Input.Keyboard.Key; s: Phaser.Input.Keyboard.Key; a: Phaser.Input.Keyboard.Key; d: Phaser.Input.Keyboard.Key };
```

In `create()`, after the cursor keys setup (around line 47), add:

```typescript
this.wasdKeys = {
  w: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.W),
  s: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.S),
  a: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.A),
  d: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.D),
};
```

Note: `A` is currently the autopilot key. Move autopilot to `Tab`:

```typescript
// Change from:
this.autopilotKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.A);
// To:
this.autopilotKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.TAB);
```

Update the HUD text accordingly (line ~89): change `'A: autopilot'` to `'Tab: autopilot'`.

**Step 2: Replace the send-input block with continuous speed logic**

Find the `update()` method, specifically the block starting at line ~472:

```typescript
const speed = this.cursors.up?.isDown ? 15
  : this.cursors.down?.isDown ? 5
  : 0;
const steer = this.cursors.left?.isDown ? -15
  : this.cursors.right?.isDown ? 15
  : 0;
const fireWeapon = this.firePending ? 'mg' : null;
this.firePending = false;
```

Replace with:

```typescript
// Get max speed from our vehicle's stats (falls back to 70 if not yet received)
const myVehicle = this.zoneState?.vehicles.find(v => v.id === this.myVehicleId);
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

const fireWeapon = this.firePending ? (this.selectedWeapon ?? null) : null;
this.firePending = false;

this.connection.send({
  type: 'input',
  tick: this.zoneState.tick,
  speed: this.clientSpeed,
  steer,
  fireWeapon
});
```

`this.clientSteer` and `this.selectedWeapon` will be added in Tasks 3 and 4. For now temporarily use `15` and `'mg'` as placeholders.

**Step 3: Test manually**

Deploy and drive. Up arrow should now accelerate gradually. Releasing up should coast at current speed. Down should brake.

```bash
bash /Users/paddyharker/carwars/scripts/deploy.sh 2>&1 | tail -5
```

**Step 4: Commit**

```bash
git add client/src/scenes/ArenaScene.ts
git commit -m "feat: continuous speed acceleration, WASD keys, Tab for autopilot"
```

---

## Task 3: Weapon selection (keys 1–5)

**Files:**
- Modify: `client/src/scenes/ArenaScene.ts`

**Step 1: Add weapon state fields**

In the private fields block, add:

```typescript
private selectedMountIndex = 0;
private selectedWeapon: string | null = null;
private weaponKeys: Phaser.Input.Keyboard.Key[] = [];
```

**Step 2: Register weapon keys 1–5 in create()**

After the key setup in `create()`:

```typescript
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
```

**Step 3: Update selectedWeapon in update()**

At the top of the send-input block in `update()`, before the connection.send:

```typescript
const mounts = myVehicle?.stats.loadout?.mounts ?? [];
const mount = mounts[this.selectedMountIndex] ?? mounts[0];
this.selectedWeapon = mount?.weaponId ?? null;
```

Replace the temporary `'mg'` with `this.selectedWeapon`.

**Step 4: Commit**

```bash
git add client/src/scenes/ArenaScene.ts
git commit -m "feat: weapon selection with keys 1-5"
```

---

## Task 4: HUD — speed, skill, armor, weapon display

**Files:**
- Modify: `client/src/scenes/ArenaScene.ts`

**Step 1: Add HUD state fields**

```typescript
private driverSkill = 3;
private clientSteer = 15;  // max steer per skill (replaces hardcoded 15)
private hudText!: Phaser.GameObjects.Text;
private armorTexts: Partial<Record<string, Phaser.GameObjects.Text>> = {};
```

**Step 2: Handle `driver_info` message**

In the WebSocket `onMessage` handler (find where `zone_state` and `zone_end` are handled), add:

```typescript
if (msg.type === 'driver_info' && msg.vehicleId === this.myVehicleId) {
  this.driverSkill = msg.skill;
  this.clientSteer = msg.maxSteer;
}
```

**Step 3: Create HUD panel in create()**

After the autopilot label setup (around line 97), add:

```typescript
// Vehicle status HUD — bottom-left, fixed to camera
this.hudText = this.add.text(16, 100, '', {
  color: '#00ff88',
  fontSize: '12px',
  fontFamily: 'monospace',
  backgroundColor: '#00000099',
  padding: { x: 6, y: 4 },
}).setScrollFactor(0).setDepth(20);

// Armor facing display (top/front/back/left/right/underbody)
const armorLayout: Array<{ key: string; label: string; x: number; y: number }> = [
  { key: 'top',      label: 'TOP',   x: 60, y: 130 },
  { key: 'front',    label: 'FNT',   x: 60, y: 150 },
  { key: 'left',     label: 'LFT',   x: 20, y: 168 },
  { key: 'right',    label: 'RGT',   x: 100, y: 168 },
  { key: 'back',     label: 'BAK',   x: 60, y: 186 },
  { key: 'underbody',label: 'UDR',   x: 60, y: 204 },
];
armorLayout.forEach(({ key, label, x, y }) => {
  this.armorTexts[key] = this.add.text(x, y, `${label}: --`, {
    color: '#00ff88', fontSize: '11px', fontFamily: 'monospace',
  }).setScrollFactor(0).setDepth(20);
});
```

**Step 4: Update HUD each frame in update()**

At the top of `update()`, after the null-check for `zoneState`:

```typescript
this.updateHud();
```

Add the `updateHud()` method to the class:

```typescript
private updateHud(): void {
  const myVehicle = this.zoneState?.vehicles.find(v => v.id === this.myVehicleId);
  if (!myVehicle) return;

  const ds = myVehicle.stats.damageState;
  const origArmor = myVehicle.stats.loadout?.armor ?? {};
  const mounts = myVehicle.stats.loadout?.mounts ?? [];
  const mount = mounts[this.selectedMountIndex] ?? mounts[0];
  const weaponLabel = mount ? `[${this.selectedMountIndex + 1}] ${mount.weaponId?.toUpperCase() ?? '?'}  ${mount.ammo}` : 'NO WEAPON';

  this.hudText.setText(
    `SPD: ${myVehicle.speed} mph   SKILL: ${this.driverSkill}\n` +
    `WEAPON: ${weaponLabel}`
  );

  // Update armor panels with colour coding
  const armorFaces: Array<keyof typeof ds.armor> = ['front', 'back', 'left', 'right', 'top', 'underbody'];
  const labelMap: Record<string, string> = { front: 'FNT', back: 'BAK', left: 'LFT', right: 'RGT', top: 'TOP', underbody: 'UDR' };
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
```

**Step 5: Update controls hint text**

Change the existing hint text (line ~89) from:
```typescript
'Arrows: drive | Space: fire | A: autopilot'
```
to:
```typescript
'Arrows/WASD: drive | Space: fire | 1-5: weapon | Tab: pilot'
```

**Step 6: Deploy and verify**

```bash
bash /Users/paddyharker/carwars/scripts/deploy.sh 2>&1 | tail -5
```

Open the game. Confirm:
- Speed display increments smoothly as you hold up
- Armor values show and change colour when hit
- Weapon shows name and ammo count
- Skill level shown in HUD

**Step 7: Commit**

```bash
git add client/src/scenes/ArenaScene.ts
git commit -m "feat: HUD with speed, skill, armor per face, weapon ammo"
```

---

## Final Deploy & Smoke Test

```bash
bash /Users/paddyharker/carwars/scripts/deploy.sh 2>&1 | tail -5
```

Checklist:
- [ ] Up arrow accelerates from 0 to max smoothly
- [ ] Down arrow brakes to 0
- [ ] Releasing both keys coasts at current speed
- [ ] WASD works identically to arrow keys
- [ ] Tab toggles autopilot (A key now steers left)
- [ ] Key `1` fires MG, `2` would fire second mount if equipped
- [ ] Armor panel shows current HP per face, turns red when low
- [ ] Speed shown in HUD matches server logs (`spd=N`)
- [ ] Driver skill shown (3 for AI test vehicles, actual skill for DB vehicles)
