import Phaser from 'phaser';

/**
 * Object pools.
 *
 * Combat creates thousands of short-lived objects over a run (projectiles,
 * sparks, damage numbers). Everything that appears more than a handful of
 * times per second is pooled here so the GC never sees a spike mid-fight.
 */

/** A physics sprite pool backed by an Arcade group with a hard cap. */
export class PhysicsSpritePool<T extends Phaser.Physics.Arcade.Sprite> {
  readonly group: Phaser.Physics.Arcade.Group;
  private readonly classType: new (scene: Phaser.Scene, x: number, y: number, key: string) => T;

  constructor(
    scene: Phaser.Scene,
    classType: new (scene: Phaser.Scene, x: number, y: number, key: string) => T,
    maxSize: number,
    textureKey: string,
  ) {
    this.classType = classType;
    this.group = scene.physics.add.group({
      classType: classType as unknown as typeof Phaser.Physics.Arcade.Sprite,
      maxSize,
      runChildUpdate: false,
    });
    this.group.defaultKey = textureKey;
  }

  /** Fetch an inactive sprite, or null when the pool is exhausted. */
  acquire(x: number, y: number, textureKey: string): T | null {
    const existing = this.group.getFirstDead(false) as T | null;
    if (existing) {
      existing.setTexture(textureKey);
      existing.setPosition(x, y);
      existing.setActive(true);
      existing.setVisible(true);
      const body = existing.body as Phaser.Physics.Arcade.Body | null;
      if (body) {
        body.enable = true;
        body.reset(x, y);
      }
      return existing;
    }
    if (this.group.getLength() >= this.group.maxSize) return null;
    const created = new this.classType(
      this.group.scene,
      x,
      y,
      textureKey,
    ) as T;
    this.group.add(created, true);
    return created;
  }

  release(sprite: T): void {
    sprite.setActive(false);
    sprite.setVisible(false);
    const body = sprite.body as Phaser.Physics.Arcade.Body | null;
    if (body) {
      body.stop();
      body.enable = false;
    }
  }

  releaseAll(): void {
    for (const child of this.group.getChildren()) {
      const sprite = child as T;
      if (sprite.active) this.release(sprite);
    }
  }

  get activeCount(): number {
    return this.group.getChildren().reduce((sum, child) => sum + ((child as T).active ? 1 : 0), 0);
  }
}

/** Lightweight image particle with a custom integrator (no tween allocation). */
export class ImageParticlePool {
  private group: Phaser.GameObjects.Group;
  private index = 0;
  private particles: {
    sprite: Phaser.GameObjects.Image;
    vx: number;
    vy: number;
    life: number;
    maxLife: number;
    drag: number;
    gravity: number;
    startScale: number;
    endScale: number;
    startAlpha: number;
    pixel: boolean;
  }[] = [];

  constructor(scene: Phaser.Scene, size: number) {
    this.group = scene.add.group({ classType: Phaser.GameObjects.Image, maxSize: size });
    for (let i = 0; i < size; i += 1) {
      const sprite = scene.add.image(0, 0, 'fx_dot');
      sprite.setVisible(false).setActive(false).setDepth(60);
      this.group.add(sprite);
      this.particles.push({
        sprite,
        vx: 0,
        vy: 0,
        life: 0,
        maxLife: 1,
        drag: 0,
        gravity: 0,
        startScale: 1,
        endScale: 0.2,
        startAlpha: 1,
        pixel: true,
      });
    }
  }

  spawn(config: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
    scale?: number;
    endScale?: number;
    alpha?: number;
    tint: number;
    drag?: number;
    gravity?: number;
    texture: string;
    pixel?: boolean;
  }): void {
    const particle = this.particles[this.index];
    this.index = (this.index + 1) % this.particles.length;
    particle.sprite.setTexture(config.texture);
    particle.sprite.setPosition(Math.round(config.x), Math.round(config.y));
    particle.sprite.setTint(config.tint);
    particle.sprite.setAlpha(config.alpha ?? 1);
    particle.sprite.setScale(config.scale ?? 1);
    particle.sprite.setVisible(true);
    particle.sprite.setActive(true);
    particle.vx = config.vx;
    particle.vy = config.vy;
    particle.life = 0;
    particle.maxLife = config.life;
    particle.drag = config.drag ?? 0;
    particle.gravity = config.gravity ?? 0;
    particle.startScale = config.scale ?? 1;
    particle.endScale = config.endScale ?? 0.2;
    particle.startAlpha = config.alpha ?? 1;
    particle.pixel = config.pixel ?? true;
  }

  update(deltaMs: number): void {
    const dt = deltaMs / 1000;
    for (const particle of this.particles) {
      if (!particle.sprite.active) continue;
      particle.life += dt;
      const t = particle.life / particle.maxLife;
      if (t >= 1) {
        particle.sprite.setVisible(false).setActive(false);
        continue;
      }
      particle.vx -= particle.vx * particle.drag * dt;
      particle.vy -= particle.vy * particle.drag * dt;
      particle.vy += particle.gravity * dt;
      const nx = particle.sprite.x + particle.vx * dt;
      const ny = particle.sprite.y + particle.vy * dt;
      particle.sprite.setPosition(
        particle.pixel ? Math.round(nx) : nx,
        particle.pixel ? Math.round(ny) : ny,
      );
      particle.sprite.setScale(
        particle.startScale + (particle.endScale - particle.startScale) * t,
      );
      particle.sprite.setAlpha(particle.startAlpha * (1 - t));
    }
  }

  killAll(): void {
    for (const particle of this.particles) {
      particle.sprite.setVisible(false).setActive(false);
    }
  }
}

/** Floating text pool used for damage numbers and short callouts. */
export class FloatingTextPool {
  private entries: {
    text: Phaser.GameObjects.Text;
    life: number;
    maxLife: number;
    vy: number;
    vx: number;
  }[] = [];
  private index = 0;

  constructor(scene: Phaser.Scene, size: number) {
    for (let i = 0; i < size; i += 1) {
      const text = scene.add
        .text(0, 0, '', {
          fontFamily: '"Silkscreen", "Courier New", ui-monospace, monospace',
          fontSize: '8px',
          color: '#ffffff',
          stroke: '#05070d',
          strokeThickness: 3,
        })
        .setDepth(80)
        .setVisible(false)
        .setActive(false);
      text.setResolution(2);
      text.setOrigin(0.5, 1);
      this.entries.push({ text, life: 0, maxLife: 0.8, vy: -26, vx: 0 });
    }
  }

  spawn(config: {
    x: number;
    y: number;
    label: string;
    color: string;
    life?: number;
    size?: number;
    vy?: number;
    bold?: boolean;
  }): void {
    const entry = this.entries[this.index];
    this.index = (this.index + 1) % this.entries.length;
    entry.text.setText(config.label);
    entry.text.setColor(config.color);
    entry.text.setFontSize(config.size ?? 8);
    entry.text.setFontStyle(config.bold ? 'bold' : 'normal');
    entry.text.setPosition(Math.round(config.x), Math.round(config.y));
    entry.text.setAlpha(1);
    entry.text.setScale(1);
    entry.text.setVisible(true).setActive(true);
    entry.life = 0;
    entry.maxLife = config.life ?? 0.75;
    entry.vy = config.vy ?? -30;
    entry.vx = (Math.random() - 0.5) * 14;
  }

  update(deltaMs: number): void {
    const dt = deltaMs / 1000;
    for (const entry of this.entries) {
      if (!entry.text.active) continue;
      entry.life += dt;
      const t = entry.life / entry.maxLife;
      if (t >= 1) {
        entry.text.setVisible(false).setActive(false);
        continue;
      }
      entry.text.y += entry.vy * dt;
      entry.text.x += entry.vx * dt;
      entry.text.setAlpha(t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4);
    }
  }

  killAll(): void {
    for (const entry of this.entries) entry.text.setVisible(false).setActive(false);
  }
}
