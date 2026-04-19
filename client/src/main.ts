import Phaser from 'phaser';
import { LoginScene } from './scenes/LoginScene';
import { GarageScene } from './scenes/GarageScene';
import { TownScene } from './scenes/TownScene';
import { JobBoardScene } from './scenes/JobBoardScene';
import { VehicleDesignerScene } from './scenes/VehicleDesignerScene';
import { ArenaScene } from './scenes/ArenaScene';
import { TacticalOverlay } from './scenes/TacticalOverlay';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 1280,
  height: 720,
  parent: 'game',
  backgroundColor: '#0a0a1a',
  dom: { createContainer: true },
  scene: [LoginScene, GarageScene, TownScene, JobBoardScene, VehicleDesignerScene, ArenaScene, TacticalOverlay]
};

(window as any).game = new Phaser.Game(config);
