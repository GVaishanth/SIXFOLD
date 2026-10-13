import Phaser from 'phaser';
import { RESOLUTION } from '@/config/gameConfig';
import { ELEMENT_REGISTRY } from '@/data/elements';
import { gameBus } from '@/game/systems/eventBus';
import { ensureVfxTexture } from '@/game/textureFactory';
import type { VfxStyleId } from '@/types';
import { Atmosphere } from '@/game/scenes/atmosphere';

const H = RESOLUTION.height;

/**
 * MainMenuScene is the atmosphere behind the React front end: a layered ruin
 * that parallaxes with the pointer, an elemental sigil that answers whatever
 * the player is looking at, and one glyph per loadout slot orbiting it.
 *
 * The menu itself stays in the DOM, where typography, focus and keyboard
 * handling belong. This scene never renders text and never receives input —
 * React tells it what mood to wear through the bus.
 */
export class MainMenuScene extends Phaser.Scene {
  private atmosphere?: Atmosphere;
  private vignette?: Phaser.GameObjects.Graphics;
  private offHandlers: (() => void)[] = [];

  constructor() {
    super({ key: 'MainMenuScene' });
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#04060c');
    this.atmosphere = new Atmosphere(this, {
      accent: 0xf2c96b,
      intensity: 1,
      sigil: true,
      motes: 24,
      pointerParallax: true,
      seed: 3,
      horizon: 30,
      // Emblem behind the wordmark, not behind the menu: the tiles own the
      // middle of the screen, the crest owns the top.
      sigilY: 62,
      sigilScale: 0.78,
    });
    this.buildVignette();
    this.bindBus();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.cleanup());
  }

  private buildVignette(): void {
    // Screen-fixed: the frame can be taller than the authored 320x180 band on
    // a phone, and a falloff that only covered the band would read as a bar
    // laid across the middle of the screen.
    const graphics = this.add.graphics().setDepth(20).setScrollFactor(0);
    this.vignette = graphics;
    this.drawVignette();
    const onResize = (): void => this.drawVignette();
    this.scale.on('resize', onResize);
    this.offHandlers.push(() => this.scale.off('resize', onResize));
  }

  private drawVignette(): void {
    if (!this.vignette) return;
    const w = this.scale.width;
    const h = this.scale.height;
    this.vignette.clear();
    // Corner falloff instead of two black bars: reads as a lens, not a border.
    this.vignette.fillStyle(0x000000, 0.34);
    this.vignette.fillRect(0, 0, w, 10);
    this.vignette.fillRect(0, h - 10, w, 10);
    this.vignette.fillStyle(0x000000, 0.18);
    this.vignette.fillRect(0, 0, w, 22);
    this.vignette.fillRect(0, h - 22, w, 22);
  }

  /** Presentation-only listeners: the interface owns intent, we own the paint. */
  private bindBus(): void {
    this.offHandlers.push(
      gameBus.on('ui:atmosphere', ({ accent, mood, intensity }) => {
        this.atmosphere?.setAccent(accent, mood === 'danger' ? 180 : 420);
        this.atmosphere?.setMood(mood);
        this.atmosphere?.setIntensity(intensity, 260);
      }),
      gameBus.on('ui:elementPreview', ({ element }) => {
        if (!element) {
          this.atmosphere?.setIntensity(1, 320);
          return;
        }
        const def = ELEMENT_REGISTRY[element as keyof typeof ELEMENT_REGISTRY];
        if (!def) return;
        this.atmosphere?.setAccent(def.colorInt, 220);
        this.atmosphere?.setMood('focus');
        this.atmosphere?.setIntensity(1, 160);
        this.atmosphere?.burst(def.colorInt, 16);
        this.flashVfx(def.attack.vfx, def.colorInt);
      }),
      gameBus.on('ui:celebrate', ({ element, kind }) => {
        const def = element ? ELEMENT_REGISTRY[element as keyof typeof ELEMENT_REGISTRY] : undefined;
        const color = def?.colorInt ?? 0xf2c96b;
        this.atmosphere?.burst(color, kind === 'unlock' ? 26 : 18);
        this.atmosphere?.setIntensity(1, 140);
        this.cameras.main.flash(220, 8, 8, 12);
      }),
    );
  }

  /** A single element VFX sprite drifting through the frame on preview. */
  private flashVfx(style: VfxStyleId, color: number): void {
    const key = ensureVfxTexture(this, style, color);
    // The shelf sits at the bottom of the *frame* now, so the preview has to
    // drift up from there rather than from the bottom of the authored band.
    const frameW = Math.max(1, this.scale.width);
    const frameH = Math.max(H, this.scale.height);
    for (let i = 0; i < 6; i += 1) {
      const sprite = this.add
        .image(frameW / 2 + Phaser.Math.Between(-40, 40), frameH - 30 + Phaser.Math.Between(-8, 8), key)
        .setDepth(2)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setScale(1 + i * 0.2)
        .setAlpha(0.9);
      this.tweens.add({
        targets: sprite,
        y: sprite.y - Phaser.Math.Between(28, 74),
        x: sprite.x + Phaser.Math.Between(-18, 18),
        alpha: 0,
        angle: Phaser.Math.Between(-90, 90),
        duration: 700 + i * 90,
        ease: 'Sine.easeOut',
        onComplete: () => sprite.destroy(),
      });
    }
  }

  override update(time: number, delta: number): void {
    this.atmosphere?.update(time, delta);

  }

  private cleanup(): void {
    this.offHandlers.forEach((off) => off());
    this.offHandlers = [];
    this.atmosphere?.destroy();
    this.atmosphere = undefined;
    this.vignette?.destroy();
    this.vignette = undefined;
  }
}
