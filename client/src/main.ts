import Phaser from 'phaser';
import { ArenaScene } from './scenes/ArenaScene';
import { TownScene } from './scenes/TownScene';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 1280,
  height: 720,
  parent: 'game',
  backgroundColor: '#0a0a1a',
  scene: [ArenaScene, TownScene]
};

new Phaser.Game(config);
