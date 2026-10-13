import Phaser from 'phaser';
import { generateCoreTextures } from '@/assets/textures';
import { gameBus } from '@/game/systems/eventBus';
import { audioEngine } from '@/game/systems/audio';
import { useSettingsStore } from '@/store/settingsStore';
import { validateElementRegistry } from '@/data/elements';

/**
 * BootScene generates every texture the game needs (all art is procedural) and
 * then hands control to the interface. It is deliberately fast — the React
 * main menu is visible while this runs behind the canvas.
 */
export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BootScene' });
  }

  create(): void {
    const settings = useSettingsStore.getState();

    // All art is generated here — see src/assets/textures.ts for the manifest.
    const manifest = generateCoreTextures(this);
    this.registry.set('assetManifest', manifest);

    const problems = validateElementRegistry();
    if (problems.length > 0) {
      console.error('[sixfold] element registry integrity problems:', problems);
      gameBus.emit('game:error', {
        message: problems.join('; '),
        where: 'BootScene.validateElementRegistry',
      });
    }

    // Autoplay policy: audio unlocks on the first user gesture.
    const unlock = () => {
      audioEngine.unlock();
      audioEngine.setVolumes({
        master: settings.masterVolume,
        sfx: settings.sfxVolume,
        music: settings.musicVolume,
      });
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchstart', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('touchstart', unlock);

    this.scene.start('MainMenuScene');
    gameBus.emit('game:ready', undefined);
  }
}
