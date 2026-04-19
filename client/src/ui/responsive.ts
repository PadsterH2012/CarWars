import Phaser from 'phaser';

export function bindFullscreenToggle(scene: Phaser.Scene): void {
  const key = scene.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.F, false);
  key?.on('down', () => {
    if (scene.scale.isFullscreen) scene.scale.stopFullscreen();
    else scene.scale.startFullscreen();
  });
}

export function onLayout(scene: Phaser.Scene, cb: () => void): void {
  cb();
  scene.scale.on('resize', cb, scene);
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
    scene.scale.off('resize', cb, scene);
  });
}
