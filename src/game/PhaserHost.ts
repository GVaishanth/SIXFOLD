import Phaser from 'phaser';
import { createPhaserConfig } from '@/game/gameConfig';
import { attachViewport } from '@/game/systems/viewport';
import { useUiStore } from '@/store/uiStore';

/**
 * Single Phaser game instance for the whole application.
 *
 * The React tree mounts the canvas once and never re-creates it — scenes are
 * started/stopped through this host, which is what prevents duplicate timers,
 * listeners and enemy groups across navigation.
 */
class PhaserHost {
  private game: Phaser.Game | null = null;
  private parent: HTMLElement | null = null;
  private detachViewport: (() => void) | null = null;

  mount(parent: HTMLElement): Phaser.Game {
    if (this.game && this.parent === parent) return this.game;
    if (this.game) {
      this.game.destroy(true);
      this.game = null;
    }
    this.parent = parent;
    this.game = new Phaser.Game(createPhaserConfig(parent));
    // The buffer follows the host element rather than a fixed aspect ratio, so
    // the world fills the screen at any shape of window.
    this.detachViewport = attachViewport(this.game, parent);
    this.attachDebugHandle();
    return this.game;
  }

  get instance(): Phaser.Game | null {
    return this.game;
  }

  get isRunning(): boolean {
    return Boolean(this.game && this.game.isRunning);
  }

  /**
   * Scene keys that own a run.
   *
   * The dungeon is a second run scene rather than a flag inside `GameplayScene`'s loop, so both the
   * entry and the exit have to consider every key: one canvas, one pause scene, one audio engine.
   */
  private static readonly RUN_SCENES = ['GameplayScene', 'DungeonScene'];

  /** Bring one run scene up, take every other one down. */
  private enterRun(key: string, restart: boolean): void {
    if (!this.game) return;
    for (const other of PhaserHost.RUN_SCENES) {
      if (other === key) continue;
      const rival = this.game.scene.getScene(other);
      if (rival && rival.scene.isActive()) rival.scene.stop();
    }
    const scene = this.game.scene.getScene(key);
    if (scene && scene.scene.isActive()) {
      if (restart) scene.scene.restart();
      return;
    }
    this.game.scene.stop('MainMenuScene');
    this.game.scene.start(key);
  }

  /** Switch to gameplay, optionally restarting it with a new run request. */
  startGameplay(restart = false): void {
    this.enterRun('GameplayScene', restart);
  }

  /** Switch to a generated strip. The run request is written by the flow, which owns run decisions. */
  startDungeon(restart = true): void {
    this.enterRun('DungeonScene', restart);
  }

  private stopRunScenes(): void {
    if (!this.game) return;
    this.game.scene.stop('PauseScene');
    for (const key of PhaserHost.RUN_SCENES) {
      const scene = this.game.scene.getScene(key);
      if (scene && scene.scene.isActive()) scene.scene.stop();
    }
  }

  stopGameplay(): void {
    if (!this.game) return;
    this.stopRunScenes();
    if (!this.game.scene.isActive('MainMenuScene')) {
      this.game.scene.start('MainMenuScene');
    }
  }

  showMainMenu(): void {
    if (!this.game) return;
    this.stopRunScenes();
    if (!this.game.scene.isActive('MainMenuScene')) this.game.scene.start('MainMenuScene');
  }

  /**
   * Pause the simulation because the window lost focus.
   *
   * Routed through the same UI state the overlays use, so the pause menu and
   * the tab-switch pause can never fight each other.
   */
  pauseForFocusLoss(): void {
    const ui = useUiStore.getState();
    if (ui.screen !== 'playing') return;
    if (ui.deathOpen || ui.transition) return;
    if (!ui.paused) ui.setPaused(true);
  }

  /** Frames-per-second reading for the debug panel. */
  get fps(): number {
    return this.game ? Math.round(this.game.loop.actualFps) : 0;
  }

  /**
   * Development handle. Attached only in dev builds so the scene graph can be
   * inspected from the console; production bundles never expose it.
   */
  private attachDebugHandle(): void {
    if (!import.meta.env.DEV || !this.game) return;
    (window as unknown as Record<string, unknown>).__sixfoldGame = this.game;
  }

  destroy(): void {
    this.detachViewport?.();
    this.detachViewport = null;
    this.game?.destroy(true);
    this.game = null;
    this.parent = null;
  }
}

export const phaserHost = new PhaserHost();
