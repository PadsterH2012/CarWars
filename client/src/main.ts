import Phaser from 'phaser';
import { LoginScene } from './scenes/LoginScene';
import { GarageScene } from './scenes/GarageScene';
import { TownScene } from './scenes/TownScene';
import { JobBoardScene } from './scenes/JobBoardScene';
import { VehicleDesignerScene } from './scenes/VehicleDesignerScene';
import { ArenaScene } from './scenes/ArenaScene';
import { TacticalOverlay } from './scenes/TacticalOverlay';
import { ShopScene } from './scenes/ShopScene';
import { MapViewerScene } from './scenes/MapViewerScene';
import { MapEditorScene } from './scenes/MapEditorScene';
import { WorldMapScene } from './scenes/WorldMapScene';
import { ReportScene } from './scenes/ReportScene';
import { ResultScene } from './scenes/ResultScene';
import { ReplayScene } from './scenes/ReplayScene';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#0a0a1a',
  dom: { createContainer: true },
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: window.innerWidth,
    height: window.innerHeight,
    min: { width: 1024, height: 600 },
  },
  scene: [LoginScene, GarageScene, TownScene, JobBoardScene, VehicleDesignerScene, ArenaScene, TacticalOverlay, ShopScene, MapViewerScene, MapEditorScene, WorldMapScene, ReportScene, ResultScene, ReplayScene]
};

(window as any).game = new Phaser.Game(config);
