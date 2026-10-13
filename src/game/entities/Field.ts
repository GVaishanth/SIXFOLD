import Phaser from 'phaser';
import { POOLS } from '@/config/gameConfig';
import type { CombatContext } from '@/game/combat/context';
import { ensureVfxTexture } from '@/game/textureFactory';
import type { StatusApplication, VfxStyleId } from '@/types';

export interface FieldConfig {
  x: number;
  y: number;
  radius: number;
  dps: number;
  duration: number;
  element: string;
  vfx: VfxStyleId;
  color: number;
  statuses?: StatusApplication[];
  friendly: boolean;
  /** Negative pulls targets inward, positive pushes them out. */
  pull?: number;
  followPlayer?: boolean;
}

interface FieldInstance extends FieldConfig {
  sprite: Phaser.GameObjects.Image;
  aura: Phaser.GameObjects.Image;
  age: number;
  tickTimer: number;
  pullTimer: number;
}

/**
 * Lingering area effects: steam vents, poison pools, healing springs, storm
 * cells and vortex pull fields all share this entity.
 */
export class FieldManager {
  private scene: Phaser.Scene;
  private fields: FieldInstance[] = [];
  private sprites: Phaser.GameObjects.Image[] = [];
  private auras: Phaser.GameObjects.Image[] = [];
  private cursor = 0;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    for (let i = 0; i < POOLS.fields; i += 1) {
      const sprite = scene.add.image(0, 0, 'fx_puff').setDepth(20).setVisible(false);
      sprite.setBlendMode(Phaser.BlendModes.ADD);
      const aura = scene.add.image(0, 0, 'fx_ring').setDepth(19).setVisible(false).setAlpha(0.5);
      this.sprites.push(sprite);
      this.auras.push(aura);
    }
  }

  add(config: FieldConfig): void {
    if (this.fields.length >= POOLS.fields) {
      // Recycle the oldest field rather than refusing to place a new one.
      const oldest = this.fields.shift();
      if (oldest) {
        oldest.sprite.setVisible(false);
        oldest.aura.setVisible(false);
      }
    }
    const sprite = this.sprites[this.cursor];
    const aura = this.auras[this.cursor];
    this.cursor = (this.cursor + 1) % this.sprites.length;

    sprite.setTexture(ensureVfxTexture(this.scene, config.vfx, config.color));
    sprite.setPosition(Math.round(config.x), Math.round(config.y));
    sprite.setTint(config.color);
    sprite.setAlpha(config.friendly ? 0.85 : 0.95);
    sprite.setScale(Math.max(1, (config.radius * 2) / 8));
    sprite.setVisible(true);

    aura.setTexture('fx_ring');
    aura.setPosition(Math.round(config.x), Math.round(config.y));
    aura.setTint(config.color);
    aura.setScale((config.radius * 2) / 16);
    aura.setVisible(true);

    this.fields.push({
      ...config,
      sprite,
      aura,
      age: 0,
      tickTimer: 0,
      pullTimer: 0,
    });
  }

  update(deltaMs: number, context: CombatContext): void {
    const dt = deltaMs / 1000;
    for (let i = this.fields.length - 1; i >= 0; i -= 1) {
      const field = this.fields[i];
      field.age += dt;
      const lifeRatio = 1 - field.age / field.duration;

      if (field.followPlayer && field.friendly) {
        field.x = context.player.x;
        field.y = context.player.y;
        field.sprite.setPosition(Math.round(field.x), Math.round(field.y));
        field.aura.setPosition(Math.round(field.x), Math.round(field.y));
      }

      field.sprite.setAlpha(Math.max(0, lifeRatio) * (field.friendly ? 0.7 : 0.9));
      field.aura.setAlpha(Math.max(0, lifeRatio) * 0.35);

      field.tickTimer += dt;
      if (field.tickTimer >= 0.45) {
        field.tickTimer = 0;
        context.damageArea({
          x: field.x,
          y: field.y,
          radius: field.radius,
          damage: field.dps * 0.45,
          element: field.element,
          vfx: field.vfx,
          color: field.color,
          statuses: field.statuses,
          knockback: 0,
          friendly: field.friendly,
        });
      }

      if (field.pull && field.pull !== 0) {
        field.pullTimer += dt;
        if (field.pullTimer >= 0.2) {
          field.pullTimer = 0;
          const targets = field.friendly
            ? (context.enemies.getChildren() as Phaser.Physics.Arcade.Sprite[])
            : [context.player as unknown as Phaser.Physics.Arcade.Sprite];
          for (const target of targets) {
            if (!target.active) continue;
            const distance = Phaser.Math.Distance.Between(field.x, field.y, target.x, target.y);
            if (distance > field.radius || distance < 4) continue;
            const angle = Math.atan2(target.y - field.y, target.x - field.x);
            const body = target.body as Phaser.Physics.Arcade.Body | null;
            if (!body) continue;
            const sign = field.pull < 0 ? -1 : 1;
            body.velocity.x += Math.cos(angle) * field.pull * 0.25 * sign;
            body.velocity.y += Math.sin(angle) * field.pull * 0.25 * sign;
          }
        }
      }

      if (field.age >= field.duration) {
        field.sprite.setVisible(false);
        field.aura.setVisible(false);
        this.fields.splice(i, 1);
      }
    }
  }

  /** True when a friendly field covers this point (used by the HUD/feedback). */
  covers(x: number, y: number, friendly = true): boolean {
    return this.fields.some(
      (field) =>
        field.friendly === friendly && Phaser.Math.Distance.Between(field.x, field.y, x, y) <= field.radius,
    );
  }

  clear(): void {
    for (const field of this.fields) {
      field.sprite.setVisible(false);
      field.aura.setVisible(false);
    }
    this.fields = [];
  }

  get activeCount(): number {
    return this.fields.length;
  }
}
