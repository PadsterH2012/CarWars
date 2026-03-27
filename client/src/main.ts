import Phaser from 'phaser';
import { ArenaScene } from './scenes/ArenaScene';
import { TownScene } from './scenes/TownScene';
import { VehicleDesignerScene } from './scenes/VehicleDesignerScene';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 1280,
  height: 720,
  parent: 'game',
  backgroundColor: '#0a0a1a',
  scene: [ArenaScene, TownScene, VehicleDesignerScene]
};

new Phaser.Game(config);
