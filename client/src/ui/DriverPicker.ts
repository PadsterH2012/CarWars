import Phaser from 'phaser';

interface DriverLite { id: string; name: string; skill: number; status?: string; title?: string; }

// Opens a modal driver picker over `scene`. Resolves with the chosen driver id,
// or null if the player cancels. Only `available` drivers are selectable.
export function openDriverPicker(
  scene: Phaser.Scene,
  token: string,
  opts: { title?: string } = {},
): Promise<string | null> {
  return new Promise(async (resolve) => {
    const host = window.location.hostname;
    const drivers: DriverLite[] = await (await fetch(`http://${host}:3001/api/drivers`, {
      headers: { Authorization: `Bearer ${token}` },
    })).json();
    const available = drivers.filter(d => d.status === 'available');

    const { width, height } = scene.scale;
    const layer = scene.add.container(0, 0).setDepth(1000);
    const backdrop = scene.add.rectangle(0, 0, width, height, 0x000000, 0.7)
      .setOrigin(0).setInteractive();
    layer.add(backdrop);

    const cx = width / 2;
    const title = scene.add.text(cx, height * 0.2, opts.title ?? 'ASSIGN DRIVER', {
      color: '#00ff88', fontSize: '20px', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);
    layer.add(title);

    const close = (id: string | null) => { layer.destroy(); resolve(id); };

    if (!available.length) {
      const none = scene.add.text(cx, height * 0.35, 'No available drivers — all are out or wounded.', {
        color: '#ff8844', fontSize: '14px', fontFamily: 'monospace',
      }).setOrigin(0.5);
      layer.add(none);
    } else {
      available.forEach((d, i) => {
        const row = scene.add.text(cx, height * 0.3 + i * 36,
          `${d.name}  ·  skill ${d.skill}${d.title ? '  ·  ' + d.title : ''}`, {
          color: '#cccccc', fontSize: '15px', fontFamily: 'monospace',
          backgroundColor: '#003322', padding: { x: 10, y: 5 },
        }).setOrigin(0.5).setInteractive();
        row.on('pointerover', () => row.setColor('#00ff88'));
        row.on('pointerout', () => row.setColor('#cccccc'));
        row.on('pointerdown', () => close(d.id));
        layer.add(row);
      });
    }

    const cancel = scene.add.text(cx, height * 0.8, '[CANCEL]', {
      color: '#888888', fontSize: '15px', fontFamily: 'monospace',
    }).setOrigin(0.5).setInteractive();
    cancel.on('pointerdown', () => close(null));
    backdrop.on('pointerdown', () => close(null));
    layer.add(cancel);
  });
}

interface VehicleLite {
  id: string;
  name: string;
  status?: string;
  damage_state?: { armor?: Record<string, number> };
}
interface DriverFull { id: string; name: string; skill: number; status?: string; assigned_vehicle_id?: string | null; }

interface SquadEntry {
  vehicleId: string;
  vehicleName: string;
  armour: number;
  driverName: string | null;
  driverSkill: number | null;
  eligible: boolean;
  reason: string | null;
}

// Opens a modal squad picker over `scene`. The player selects 1–4 vehicles,
// each of which must be `available` and have an `available` assigned driver.
// Resolves with the chosen vehicleIds, or null if cancelled. Self-contained:
// it owns its own container and cleans it up on close.
export function openSquadPicker(
  scene: Phaser.Scene,
  token: string,
  opts: { title?: string } = {},
): Promise<string[] | null> {
  return new Promise(async (resolve) => {
    const host = window.location.hostname;
    const headers = { Authorization: `Bearer ${token}` };
    const [vRes, dRes] = await Promise.all([
      fetch(`http://${host}:3001/api/vehicles`, { headers }),
      fetch(`http://${host}:3001/api/drivers`, { headers }),
    ]);

    const { width, height } = scene.scale;
    const layer = scene.add.container(0, 0).setDepth(1000);
    const backdrop = scene.add.rectangle(0, 0, width, height, 0x000000, 0.7)
      .setOrigin(0).setInteractive();
    layer.add(backdrop);

    const cx = width / 2;
    const title = scene.add.text(cx, height * 0.16, opts.title ?? 'SEND SQUAD', {
      color: '#00ff88', fontSize: '20px', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);
    layer.add(title);

    const close = (ids: string[] | null) => { layer.destroy(); resolve(ids); };
    backdrop.on('pointerdown', () => close(null));

    if (!vRes.ok || !dRes.ok) {
      const err = scene.add.text(cx, height * 0.35, 'Could not load vehicles or drivers.', {
        color: '#ff8844', fontSize: '14px', fontFamily: 'monospace',
      }).setOrigin(0.5);
      layer.add(err);
      const cancel = scene.add.text(cx, height * 0.8, '[CANCEL]', {
        color: '#888888', fontSize: '15px', fontFamily: 'monospace',
      }).setOrigin(0.5).setInteractive();
      cancel.on('pointerdown', () => close(null));
      layer.add(cancel);
      return;
    }

    const vehicles: VehicleLite[] = await vRes.json();
    const drivers: DriverFull[] = await dRes.json();

    // Map the (available) assigned driver onto each vehicle.
    const driverByVid = new Map<string, DriverFull>();
    for (const d of drivers) {
      if (d.assigned_vehicle_id) driverByVid.set(d.assigned_vehicle_id, d);
    }

    const entries: SquadEntry[] = vehicles.map((v): SquadEntry => {
      const driver = driverByVid.get(v.id) ?? null;
      const armorFaces = (v.damage_state?.armor ?? {}) as Record<string, number>;
      const armour = Object.values(armorFaces).reduce((s, n) => s + (Number(n) || 0), 0);
      const driverAvailable = !!driver && driver.status === 'available';
      const eligible = v.status === 'available' && driverAvailable;
      let reason: string | null = null;
      if (!eligible) {
        if (!driver) reason = 'no driver';
        else if (driver.status !== 'available') reason = 'driver unavailable';
        else if (v.status === 'deployed') reason = 'deployed';
        else if (v.status === 'on_job') reason = 'on job';
        else if (v.status === 'in_arena') reason = 'in arena';
        else if (v.status === 'wounded') reason = 'wounded';
        else reason = 'unavailable';
      }
      return {
        vehicleId: v.id,
        vehicleName: v.name,
        armour,
        driverName: driver?.name ?? null,
        driverSkill: driver?.skill ?? null,
        eligible,
        reason,
      };
    });

    const hasEligible = entries.some(e => e.eligible);

    if (!hasEligible) {
      const none = scene.add.text(cx, height * 0.35,
        'No available vehicles — all are out, wounded, or have no driver.', {
        color: '#ff8844', fontSize: '14px', fontFamily: 'monospace',
        wordWrap: { width: width * 0.7 }, align: 'center',
      }).setOrigin(0.5);
      layer.add(none);
      const cancel = scene.add.text(cx, height * 0.8, '[CANCEL]', {
        color: '#888888', fontSize: '15px', fontFamily: 'monospace',
      }).setOrigin(0.5).setInteractive();
      cancel.on('pointerdown', () => close(null));
      layer.add(cancel);
      return;
    }

    const selected = new Set<string>();
    const rows: { entry: SquadEntry; text: Phaser.GameObjects.Text }[] = [];

    // Show eligible vehicles first, then ineligible (greyed with reason).
    const ordered = [...entries].sort((a, b) => Number(b.eligible) - Number(a.eligible));

    let sendBtn: Phaser.GameObjects.Text;
    let hint: Phaser.GameObjects.Text;

    const refresh = () => {
      const n = selected.size;
      sendBtn.setText(n ? `[SEND — ${n}]` : '[SEND]');
      sendBtn.setAlpha(n ? 1 : 0.4);
      if (n) sendBtn.setInteractive(); else sendBtn.disableInteractive();
      hint.setText(n >= 4 ? 'Squad full (max 4).' : '');
    };

    const paint = (row: { entry: SquadEntry; text: Phaser.GameObjects.Text }) => {
      const e = row.entry;
      if (!e.eligible) {
        row.text.setColor('#666677');
        return;
      }
      row.text.setColor(selected.has(e.vehicleId) ? '#00ff88' : '#cccccc');
    };

    ordered.forEach((e, i) => {
      const label = e.eligible
        ? `${e.vehicleName}  ·  armour ${e.armour}  ·  ${e.driverName} (sk${e.driverSkill})`
        : `${e.vehicleName}  ·  armour ${e.armour}  ·  — ${e.reason} —`;
      const row = scene.add.text(cx, height * 0.26 + i * 32, label, {
        color: e.eligible ? '#cccccc' : '#666677', fontSize: '14px', fontFamily: 'monospace',
        backgroundColor: e.eligible ? '#003322' : '#222222', padding: { x: 10, y: 5 },
      }).setOrigin(0.5);
      const r = { entry: e, text: row };
      rows.push(r);
      layer.add(row);

      if (e.eligible) {
        row.setInteractive();
        row.on('pointerover', () => { if (!selected.has(e.vehicleId)) row.setColor('#00ff88'); });
        row.on('pointerout', () => paint(r));
        row.on('pointerdown', () => {
          if (selected.has(e.vehicleId)) {
            selected.delete(e.vehicleId);
          } else if (selected.size < 4) {
            selected.add(e.vehicleId);
          }
          paint(r);
          refresh();
        });
      }
    });

    hint = scene.add.text(cx, height * 0.74, '', {
      color: '#ffaa44', fontSize: '12px', fontFamily: 'monospace',
    }).setOrigin(0.5);
    layer.add(hint);

    sendBtn = scene.add.text(cx - 70, height * 0.8, '[SEND]', {
      color: '#ffaa44', fontSize: '15px', fontFamily: 'monospace',
      backgroundColor: '#332211', padding: { x: 8, y: 5 },
    }).setOrigin(0.5);
    sendBtn.on('pointerdown', () => { if (selected.size) close([...selected]); });
    layer.add(sendBtn);

    const cancel = scene.add.text(cx + 70, height * 0.8, '[CANCEL]', {
      color: '#888888', fontSize: '15px', fontFamily: 'monospace',
    }).setOrigin(0.5).setInteractive();
    cancel.on('pointerdown', () => close(null));
    layer.add(cancel);

    refresh();
  });
}
