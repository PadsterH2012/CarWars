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
