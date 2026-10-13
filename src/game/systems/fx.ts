import Phaser from 'phaser';
import { CAMERA_CONFIG, COMBAT_CONFIG, POOLS } from '@/config/gameConfig';
import { ensureDotTexture, ensurePuffTexture, ensureRingTexture, ensureSquareParticle, ensureVfxTexture } from '@/game/textureFactory';
import { FloatingTextPool, ImageParticlePool } from '@/game/systems/objectPool';
import type { VfxStyleId } from '@/types';
import type { ElementFamily } from '@/data/elements/palette';
import { hexToInt } from '@/utils/color';
import { pulse } from '@/utils/haptics';
import { sfx } from '@/game/systems/audio';

/** How hard a hit is allowed to push the frame around. */
export type ImpactTier = keyof typeof COMBAT_CONFIG.impacts;

export interface FxOptions {
  screenShake: boolean;
  damageNumbers: boolean;
  pixelEffects: boolean;
  reducedMotion: boolean;
  particleScale: number;
}

/**
 * Feedback system: every hit, cast and death routes through here so the game
 * feels consistent and the particle budget stays bounded.
 */
export class FxSystem {
  private scene: Phaser.Scene;
  private particles: ImageParticlePool;
  private text: FloatingTextPool;
  private rings: Phaser.GameObjects.Image[] = [];
  private wash?: Phaser.GameObjects.Image;
  private options: FxOptions;
  private camera: Phaser.Cameras.Scene2D.Camera;
  private damageNumberBudget = 0;
  /** Zoom the frame was fitted with; see `setBaseZoom`. */
  private baseZoom = 1;
  /** The camera punch in flight, if any. One at a time, always from the base. */
  private punch: Phaser.Tweens.Tween | null = null;
  /** True while a hit-stop holds the clocks below 1, so a second big hit cannot nest. */
  private stopped = false;


  constructor(scene: Phaser.Scene, camera: Phaser.Cameras.Scene2D.Camera, options: FxOptions) {
    this.scene = scene;
    this.camera = camera;
    this.options = options;
    ensureDotTexture(scene);
    ensureSquareParticle(scene);
    ensureRingTexture(scene);
    ensurePuffTexture(scene);
    this.particles = new ImageParticlePool(scene, POOLS.particles);
    this.text = new FloatingTextPool(scene, POOLS.damageNumbers);
    for (let i = 0; i < POOLS.fields; i += 1) {
      const ring = scene.add
        .image(0, 0, 'fx_ring')
        .setDepth(50)
        .setVisible(false)
        .setActive(false);
      this.rings.push(ring);
    }
  }

  setOptions(options: Partial<FxOptions>): void {
    this.options = { ...this.options, ...options };
  }

  private get scale(): number {
    return this.options.particleScale;
  }

  /* ---------------------- core feedback ---------------------- */

  /**
   * Sparks with a grammar.
   *
   * Each element family throws pixels differently, so a hit is identifiable
   * without reading a name: fire spits upward, water falls and splashes, gas
   * billows wide and slow, earth chunks drop, crystals shard, current snaps
   * along a line, organic creeps, radiant blooms outward.
   */
  hitSpark(
    x: number,
    y: number,
    color: number,
    power = 1,
    style: VfxStyleId = 'spark',
    family?: ElementFamily,
  ): void {
    const count = Math.round(Math.min(16, (4 + power * 4) * (family ? 1.15 : 1)) * this.scale);
    const texture = this.options.pixelEffects ? ensureVfxTexture(this.scene, style, color) : 'fx_square';
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const base = 30 + Math.random() * 70 * power;
      const bias = this.familyBias(family);
      this.particles.spawn({
        x,
        y,
        vx: Math.cos(angle) * base * bias.spread,
        vy: Math.sin(angle) * base * bias.spread + bias.lift,
        life: 0.18 + Math.random() * 0.28 + bias.life,
        tint: color,
        texture,
        scale: (0.5 + Math.random() * 0.5) * bias.scale,
        endScale: bias.endScale,
        drag: bias.drag,
        pixel: this.options.pixelEffects,
      });
    }
    if (family === 'crystalline' || family === 'radiant') {
      this.ring(x, y, color, 8 + power * 6, 0.2, 0.5);
    }
  }

  private familyBias(family?: ElementFamily): {
    spread: number;
    lift: number;
    life: number;
    scale: number;
    endScale: number;
    drag: number;
  } {
    switch (family) {
      case 'combustion':
        // Embers spit up and die fast.
        return { spread: 0.85, lift: -34, life: 0.1, scale: 0.9, endScale: 0.02, drag: 3.2 };
      case 'liquid':
        // Droplets are heavy: they arc and fall.
        return { spread: 0.7, lift: 18, life: 0.06, scale: 0.8, endScale: 0.1, drag: 1.6 };
      case 'gas':
        // Vapour billows wide, slow and faint.
        return { spread: 1.5, lift: -6, life: 0.36, scale: 1.5, endScale: 1.4, drag: 6.5 };
      case 'solid':
        // Chunks drop with weight.
        return { spread: 0.6, lift: 26, life: 0.12, scale: 1.15, endScale: 0.35, drag: 1.1 };
      case 'crystalline':
        // Shards fly straight and hard.
        return { spread: 1.1, lift: 0, life: 0.05, scale: 0.7, endScale: 0.02, drag: 7.5 };
      case 'current':
        // Bolts snap outward then vanish.
        return { spread: 1.9, lift: 0, life: -0.06, scale: 0.6, endScale: 0.02, drag: 9 };
      case 'organic':
        // Spores creep.
        return { spread: 0.55, lift: -8, life: 0.42, scale: 1.05, endScale: 0.6, drag: 5.2 };
      case 'radiant':
        // Light blooms.
        return { spread: 1.25, lift: 0, life: 0.2, scale: 1.3, endScale: 1.1, drag: 4.4 };
      default:
        return { spread: 1, lift: 0, life: 0, scale: 1, endScale: 0.05, drag: 5 };
    }
  }

  deathBurst(x: number, y: number, color: number, size = 1): void {
    const count = Math.round(Math.min(22, 10 + size * 8) * this.scale);
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 40 + Math.random() * 90;
      this.particles.spawn({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.3 + Math.random() * 0.4,
        tint: color,
        texture: 'fx_square',
        scale: 0.8 + Math.random() * 0.8,
        endScale: 0,
        drag: 3.4,
      });
    }
    this.ring(x, y, color, 10 + size * 12, 0.32);
  }

  ring(x: number, y: number, color: number, radius: number, duration = 0.4, thickness = 1): void {
    const ring = this.rings.find((entry) => !entry.active);
    if (!ring) return;
    ring.setTexture('fx_ring');
    ring.setPosition(Math.round(x), Math.round(y));
    ring.setTint(color);
    ring.setAlpha(0.9);
    ring.setVisible(true).setActive(true);
    ring.setScale((radius * 2) / 16);
    ring.setDepth(52);
    ring.setBlendMode(Phaser.BlendModes.ADD);
    this.scene.tweens.add({
      targets: ring,
      alpha: 0,
      scale: ((radius * 2) / 16) * (1 + 0.35 * thickness),
      duration: duration * 1000,
      ease: 'Quad.easeOut',
      onComplete: () => {
        ring.setVisible(false).setActive(false).setBlendMode(Phaser.BlendModes.NORMAL);
      },
    });
  }

  damageNumber(x: number, y: number, amount: number, isCrit: boolean, color = '#E8EDF7'): void {
    if (!this.options.damageNumbers) return;
    if (this.damageNumberBudget > COMBAT_CONFIG.maxDamageNumbers) return;
    this.damageNumberBudget += 1;
    this.text.spawn({
      x,
      y,
      label: isCrit ? `${Math.round(amount)}!` : `${Math.round(amount)}`,
      color: isCrit ? '#F2C96B' : color,
      size: isCrit ? 11 : 8,
      bold: isCrit,
      life: isCrit ? 0.95 : 0.7,
      vy: isCrit ? -42 : -30,
    });
  }

  healNumber(x: number, y: number, amount: number): void {
    this.text.spawn({ x, y, label: `+${Math.round(amount)}`, color: '#6BE39A', size: 8, life: 0.8 });
  }

  energyNumber(x: number, y: number, amount: number): void {
    this.text.spawn({ x, y, label: `+${Math.round(amount)}`, color: '#57C7FF', size: 7, life: 0.6 });
  }

  callout(x: number, y: number, label: string, color: string, size = 12): void {
    this.text.spawn({ x, y, label, color, size, life: 1.6, vy: -14, bold: true });
  }

  flash(entity: Phaser.GameObjects.Sprite & { setTintFill?: unknown }, color = 0xffffff): void {
    if (this.options.reducedMotion) return;
    const sprite = entity as Phaser.GameObjects.Sprite;
    sprite.setTintFill(color);
    this.scene.time.delayedCall(COMBAT_CONFIG.hitFlashMs, () => {
      if (sprite.active) sprite.clearTint();
    });
  }

  /* ---------------------- camera ---------------------- */

  shake(strength: 'light' | 'medium' | 'heavy' = 'light'): void {
    if (!this.options.screenShake || this.options.reducedMotion) return;
    const amount = CAMERA_CONFIG.shake[strength];
    this.camera.shake(CAMERA_CONFIG.shake.duration, amount / 1000 * 1.6, false);
  }

  /**
   * The zoom the frame was fitted with. Every punch returns here rather than to "wherever
   * the camera happens to be right now", which is what let a crit punch leave the view a
   * little wider than it found it and ratchet the whole game in, permanently, one hit at a
   * time. `viewport` scales the *buffer*; it never touches the camera, so 1 is the truth.
   */
  setBaseZoom(zoom: number): void {
    this.baseZoom = zoom;
    this.settle();
  }

  /** Drop any punch in flight and put the camera back on its base. */
  settle(): void {
    if (this.punch) {
      this.punch.stop();
      this.punch = null;
    }
    if (this.camera.zoom !== this.baseZoom) this.camera.setZoom(this.baseZoom);
  }

  /**
   * Hand the clocks back after a freeze landed inside a hit-stop window. `setFrozen` pauses
   * the scene clock, which also parks the delayed call that restores them, so a run that was
   * interrupted at exactly the wrong frame could keep playing (and cooling) at 0.55 speed.
   */
  clearHitStop(): void {
    if (!this.stopped) return;
    this.scene.physics.world.timeScale = 1;
    this.scene.time.timeScale = 1;
    this.stopped = false;
  }

  zoomPunch(scale: number = CAMERA_CONFIG.zoomPunch): void {
    if (!this.options.screenShake || this.options.reducedMotion) return;
    // Overlapping punches are the normal case (a big hit is several crits in one frame), so
    // the in-flight tween is retired and the new one runs from the base to the base plus its
    // own scale. Nothing reads the current zoom any more — that was the ratchet.
    if (this.punch) {
      this.punch.stop();
      this.punch = null;
    }
    if (this.camera.zoom !== this.baseZoom) this.camera.setZoom(this.baseZoom);
    this.punch = this.scene.tweens.add({
      targets: this.camera,
      zoom: { from: this.baseZoom, to: this.baseZoom + scale },
      duration: CAMERA_CONFIG.zoomPunchMs * 0.35,
      yoyo: true,
      ease: 'Quad.easeOut',
      onComplete: () => {
        this.camera.setZoom(this.baseZoom);
        this.punch = null;
      },
    });
  }

  /** Slow-motion punch reserved for exceptional hits. */
  hitStop(durationMs = 70): void {
    if (this.options.reducedMotion || this.stopped) return;
    const scene = this.scene;
    const physics = scene.physics.world;
    this.stopped = true;
    physics.timeScale = 0.28;
    scene.time.timeScale = 0.55;
    scene.time.delayedCall(durationMs, () => {
      // Both clocks go back to 1, unconditionally. Reading the "previous" value at entry
      // looked harmless until two stops overlapped: the second captured the first's 0.55
      // and handed it back as the resting state, so the run kept playing at half speed.
      physics.timeScale = 1;
      scene.time.timeScale = 1;
      this.stopped = false;
    });
  }

  hitFeedback(config: {
    x: number;
    y: number;
    amount: number;
    isCrit: boolean;
    color: number;
    vfx: VfxStyleId;
    power: number;
    silent?: boolean;
  }): void {
    this.hitSpark(config.x, config.y, config.color, config.power, config.vfx);
    this.damageNumber(config.x, config.y - 6, config.amount, config.isCrit);
    if (config.isCrit) {
      this.shake('light');
      this.zoomPunch(CAMERA_CONFIG.zoomPunch * 0.6);
    }
    if (!config.silent) {
      sfx(config.isCrit ? 'crit' : 'hit', { gain: Math.min(1, 0.5 + config.power * 0.2) });
    }
    if (config.amount >= COMBAT_CONFIG.criticalPunchThreshold && config.isCrit) {
      this.hitStop(80);
      this.shake('medium');
    }
  }

  /**
   * The graded impact. Callers say what happened (tier, position, colour,
   * family, who got hit) and this decides how the frame answers: how long it
   * holds, how far the camera moves, whether a ring is drawn, how the victim
   * deforms. Screen shake stays off for ordinary hits by construction.
   */
  impact(config: {
    tier: keyof typeof COMBAT_CONFIG.impacts;
    x: number;
    y: number;
    amount: number;
    isCrit: boolean;
    color: number;
    vfx: VfxStyleId;
    family?: ElementFamily;
    target?: Phaser.GameObjects.Sprite;
    silent?: boolean;
    /** Direction the victim should be shoved, in radians. */
    knockAngle?: number;
  }): void {
    const spec = COMBAT_CONFIG.impacts[config.tier];
    // The same grading the frame gets, in the hand. Ordinary hits stay silent:
    // a buzz per jab is noise, and `pulse` collapses a burst inside its window
    // to the strongest pattern anyway.
    if (config.tier === 'ultimate') pulse('ultimate');
    else if (config.tier === 'bossPhase') pulse('bossPhase');
    else if (config.tier === 'crit') pulse('crit');
    else if (config.tier === 'skill') pulse('skill');
    this.hitSpark(config.x, config.y, config.color, spec.sparks, config.vfx, config.family);
    this.damageNumber(
      config.x,
      config.y - 6,
      Math.round(config.amount * spec.damageScale),
      config.isCrit || config.tier === 'ultimate' || config.tier === 'bossPhase',
      config.tier === 'bossPhase' ? '#FF5C6C' : '#E8EDF7',
    );
    if (spec.ring > 0) this.ring(config.x, config.y, config.color, spec.ring, 0.26, config.tier === 'bossPhase' ? 2 : 1);
    if (spec.holdMs > 0) this.hitStop(spec.holdMs);
    if (spec.shake !== 'none') this.shake(spec.shake);
    if (spec.punch > 0) this.zoomPunch(spec.punch);
    if (config.target) this.squash(config.target, spec.squash, config.knockAngle ?? 0);
    if (!config.silent) {
      const sound =
        config.tier === 'ultimate'
          ? 'ultimate'
          : config.tier === 'bossPhase'
            ? 'boss_enter'
            : config.tier === 'crit'
              ? 'crit'
              : 'hit';
      sfx(sound, {
        gain: Math.min(1, 0.45 + spec.sparks * 0.16),
        rate: spec.audioRate,
      });
    }
  }

  /**
   * A colour wash across the whole frame.
   *
   * Used for moments that change the rules of the screen — an element swap, a
   * warden changing phase — where the answer has to be felt peripherally before
   * it is read. Under reduced motion it survives at half strength, because it
   * is information about a state change, not decoration.
   */
  screenWash(color: number, peakAlpha = 0.16, ms = 240): void {
    if (!this.wash) {
      this.wash = this.scene.add
        .image(0, 0, 'fx_square')
        .setScrollFactor(0)
        .setDepth(29)
        .setBlendMode(Phaser.BlendModes.ADD);
    }
    const { width, height } = this.scene.scale;
    this.wash.setPosition(width / 2, height / 2);
    this.wash.setDisplaySize(width, height);
    this.wash.setTint(color);
    const peak = this.options.reducedMotion ? peakAlpha * 0.5 : peakAlpha;
    this.scene.tweens.killTweensOf(this.wash);
    this.wash.setAlpha(peak);
    this.scene.tweens.add({
      targets: this.wash,
      alpha: 0,
      duration: this.options.reducedMotion ? Math.min(120, ms) : ms,
      ease: 'Quad.easeOut',
    });
  }

  /** The element swap must land in a fraction of a second and never pause play. */
  elementShift(color: number): void {
    this.screenWash(color, 0.14, 200);
    this.zoomPunch(0.018);
  }

  /**
   * Squash and stretch along the impact axis. Animation is only worth its cost
   * if the eye can read it, so this stays brief and never fires under reduced
   * motion (the flash and the number already carry the information).
   */
  squash(target: Phaser.GameObjects.Sprite, amount: number, angle = 0): void {
    if (this.options.reducedMotion || amount <= 0 || !target.active) return;
    // Remember the sprite's own scale: enemies and bosses are not all 1:1, and a
    // squash that "corrects" them to 1 would visibly resize the world.
    const baseX = target.scaleX;
    const baseY = target.scaleY;
    const along = 1 + amount;
    const across = 1 - amount * 0.7;
    const cos = Math.abs(Math.cos(angle));
    const sx = across + (along - across) * cos;
    const sy = across + (along - across) * (1 - cos);
    this.scene.tweens.add({
      targets: target,
      scaleX: baseX * sx,
      scaleY: baseY * sy,
      duration: 64,
      ease: 'Quad.easeOut',
      yoyo: true,
      onComplete: () => {
        if (!target.active) return;
        target.setScale(baseX, baseY);
      },
    });
  }

  /** A world-space word. Used sparingly: reaction names, nothing else. */
  label(x: number, y: number, text: string, color: string): void {
    if (!this.options.damageNumbers) return;
    this.text.spawn({
      x,
      y,
      label: text,
      color,
      size: 8,
      life: 0.9,
      vy: -14,
      bold: true,
    });
  }

  update(deltaMs: number): void {
    this.particles.update(deltaMs);
    this.text.update(deltaMs);
    this.damageNumberBudget = Math.max(0, this.damageNumberBudget - deltaMs / 120);
  }

  destroy(): void {
    this.particles.killAll();
    this.text.killAll();
    for (const ring of this.rings) ring.destroy();
    this.rings = [];
    this.wash?.destroy();
    this.wash = undefined;
  }
}

export function colorToCss(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

export function cssToColor(hex: string): number {
  return hexToInt(hex);
}
