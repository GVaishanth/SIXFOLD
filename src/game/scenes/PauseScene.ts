import Phaser from 'phaser';

/**
 * PauseScene is a thin visual layer: it sinks the frozen gameplay frame so the
 * React pause interface has something to sit on top of. All pause *interface*
 * is React, which is what allows the same pause menu to host the skill tree and
 * settings without duplicating UI in two rendering stacks.
 *
 * The dim is screen-fixed rather than arena-sized: since the render buffer
 * follows the window, a frame can show more than the arena (a tall phone sees
 * the void above and below it), and an unlit band there would read as a
 * letterbox the moment the game paused.
 */
export class PauseScene extends Phaser.Scene {
  private overlay?: Phaser.GameObjects.Graphics;

  constructor() {
    super({ key: 'PauseScene', active: false });
  }

  create(): void {
    const graphics = this.add.graphics();
    graphics.setDepth(100).setScrollFactor(0);
    this.overlay = graphics;
    this.dimFrame();

    const onResize = (): void => this.dimFrame();
    this.scale.on('resize', onResize);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off('resize', onResize);
    });

    this.scene.setVisible(false, this);
  }

  private dimFrame(): void {
    if (!this.overlay) return;
    this.overlay.clear();
    this.overlay.fillStyle(0x05070d, 0.55);
    this.overlay.fillRect(0, 0, this.scale.width, this.scale.height);
  }

  show(): void {
    this.scene.setVisible(true, this);
    this.scene.bringToTop();
  }

  hide(): void {
    this.scene.setVisible(false, this);
  }
}
