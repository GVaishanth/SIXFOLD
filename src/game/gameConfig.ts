import Phaser from 'phaser';
import { COLOR_INTS, DEBUG_CONFIG, RESOLUTION } from '@/config/gameConfig';
import { BootScene } from '@/game/scenes/BootScene';
import { MainMenuScene } from '@/game/scenes/MainMenuScene';
import { GameplayScene } from '@/game/scenes/GameplayScene';
import { DungeonScene } from '@/game/scenes/DungeonScene';
import { PauseScene } from '@/game/scenes/PauseScene';

/**
 * Phaser bootstrap configuration.
 *
 * The canvas renders at a low internal resolution with nearest-neighbour
 * sampling, which is what gives the game its pixel-art identity. Phaser's own
 * scaler is switched off: `systems/viewport.ts` sizes the buffer to the host
 * element, so the game fills the frame at any aspect ratio instead of
 * letterboxing itself into a 16:9 band. `pixelArt: true` disables smoothing on
 * every texture.
 */
export function createPhaserConfig(parent: HTMLElement): Phaser.Types.Core.GameConfig {
  return {
    type: Phaser.AUTO,
    parent,
    width: RESOLUTION.width,
    height: RESOLUTION.height,
    backgroundColor: COLOR_INTS.bg,
    pixelArt: true,
    antialias: false,
    roundPixels: true,
    disableContextMenu: true,
    scale: {
      // NONE, not FIT: FIT letterboxes the canvas inside its parent, which is
      // exactly the black band players notice on phones and in short windows.
      mode: Phaser.Scale.NONE,
      width: RESOLUTION.width,
      height: RESOLUTION.height,
    },
    physics: {
      default: 'arcade',
      arcade: {
        gravity: { x: 0, y: 0 },
        debug: false,
        fps: 60,
        tileBias: 16,
      },
    },
    render: {
      pixelArt: true,
      antialias: false,
      roundPixels: true,
      powerPreference: 'high-performance',
      batchSize: 4096,
    },
    fps: {
      target: 60,
      min: 30,
      smoothStep: true,
    },
    input: {
      keyboard: true,
      mouse: true,
      touch: true,
      smoothFactor: 0,
    },
    audio: {
      // Audio is fully procedural (Web Audio) — Phaser's sound manager stays off.
      noAudio: true,
    },
    banner: false,
    scene: [BootScene, MainMenuScene, GameplayScene, DungeonScene, PauseScene],
    callbacks: {
      postBoot: (game) => {
        const canvas = game.canvas;
        canvas.setAttribute('tabindex', '0');
        canvas.setAttribute('aria-label', 'SIXFOLD game canvas');
        if (!DEBUG_CONFIG.enabled) {
          game.events.on('hidden', () => game.loop.sleep());
        }
      },
    },
  };
}
