import Phaser from 'phaser';
import { POOLS } from '@/config/gameConfig';
import type { CombatContext } from '@/game/combat/context';
import type { DamagePacket } from '@/game/combat/damage';
import { ensureVfxTexture } from '@/game/textureFactory';
import type { ProjectileSpec, StatusApplication, VfxStyleId } from '@/types';

export interface ProjectileConfig {
  x: number;
  y: number;
  angle: number;
  speed: number;
  damage: number;
  isCrit?: boolean;
  /** A support-cast projectile: damage counts, vitals payout does not. */
  auto?: boolean;
  owner: 'player' | 'enemy';
  element: string | null;
  vfx: VfxStyleId;
  color: number;
  radius: number;
  lifetime: number;
  pierce: number;
  chain: number;
  homing: number;
  knockback: number;
  statuses: StatusApplication[];
  explodeRadius: number;
  explodeDamageMult: number;
  trailField?: ProjectileSpec['trailField'];
  destroysEnemyProjectiles: boolean;
  boomerang: boolean;
  /** Boss/enemy projectiles can be flagged unblockable for telegraphed attacks. */
  heavy?: boolean;
}

/**
 * Pooled projectile. Behaviour is entirely data-driven: the same entity serves
 * firebolts, chain lightning, crystal shards and boss volleys.
 */
export class Projectile extends Phaser.Physics.Arcade.Sprite {
  damage = 0;
  isCrit = false;
  auto = false;
  owner: 'player' | 'enemy' = 'player';
  element: string | null = null;
  vfx: VfxStyleId = 'spark';
  colorInt = 0xffffff;
  pierce = 0;
  chainCount = 0;
  homing = 0;
  knockback = 0;
  statuses: StatusApplication[] = [];
  explodeRadius = 0;
  explodeDamageMult = 0;
  lifetime = 1;
  age = 0;
  trailField: ProjectileSpec['trailField'] | undefined;
  destroysEnemyProjectiles = false;
  boomerang = false;
  boomerangTimer = 0;
  heavy = false;
  private hitIds = new Set<number>();

  constructor(scene: Phaser.Scene, x: number, y: number, texture: string) {
    super(scene, x, y, texture);
    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.setDepth(40);
  }

  fire(config: ProjectileConfig): void {
    this.setTexture(ensureVfxTexture(this.scene, config.vfx, config.color));
    this.setPosition(Math.round(config.x), Math.round(config.y));
    this.setRotation(config.angle);
    if (this.scene.textures.exists(this.texture.key)) {
      const width = this.width || 4;
      const height = this.height || 4;
      const body = this.body as Phaser.Physics.Arcade.Body;
      body.setSize(Math.max(4, config.radius * 2), Math.max(3, height * 0.7), true);
      body.setAllowRotation(true);
      this.setOrigin(0.5, 0.5);
      void width;
    }
    this.damage = config.damage;
    this.isCrit = config.isCrit ?? false;
    this.auto = config.auto ?? false;
    this.owner = config.owner;
    this.element = config.element;
    this.vfx = config.vfx;
    this.colorInt = config.color;
    this.pierce = config.pierce;
    this.chainCount = config.chain;
    this.homing = config.homing;
    this.knockback = config.knockback;
    this.statuses = config.statuses;
    this.explodeRadius = config.explodeRadius;
    this.explodeDamageMult = config.explodeDamageMult;
    this.lifetime = config.lifetime;
    this.trailField = config.trailField;
    this.destroysEnemyProjectiles = config.destroysEnemyProjectiles;
    this.boomerang = config.boomerang;
    this.boomerangTimer = config.lifetime * 0.55;
    this.heavy = config.heavy ?? false;
    this.age = 0;
    this.hitIds.clear();
    this.setTint(0xffffff);
    this.setActive(true).setVisible(true).setAlpha(1).setScale(config.heavy ? 1.6 : 1);

    const body = this.body as Phaser.Physics.Arcade.Body;
    body.enable = true;
    body.reset(Math.round(config.x), Math.round(config.y));
    this.scene.physics.velocityFromRotation(
      config.angle,
      config.speed,
      body.velocity as Phaser.Math.Vector2,
    );
    body.setCircle(Math.max(2, config.radius), undefined, undefined);
  }

  registerHit(id: number): boolean {
    if (this.hitIds.has(id)) return false;
    this.hitIds.add(id);
    return true;
  }

  /** Advance one frame. Returns true when the projectile should be released. */
  step(deltaMs: number, context: CombatContext): boolean {
    const dt = deltaMs / 1000;
    this.age += dt;
    const body = this.body as Phaser.Physics.Arcade.Body;
    if (!body) return true;

    if (this.homing > 0) {
      const target =
        this.owner === 'player'
          ? findNearest(context.enemies.getChildren() as Phaser.Physics.Arcade.Sprite[], this.x, this.y, 120)
          : null;
      if (target) {
        const desired = Math.atan2(target.y - this.y, target.x - this.x);
        const current = Math.atan2(body.velocity.y, body.velocity.x);
        const speed = body.velocity.length();
        const next = Phaser.Math.Angle.RotateTo(current, desired, this.homing * 6 * dt);
        body.velocity.setTo(Math.cos(next) * speed, Math.sin(next) * speed);
        this.setRotation(next);
      }
    }

    if (this.boomerang) {
      this.boomerangTimer -= dt;
      if (this.boomerangTimer <= 0) {
        const dx = context.player.x - this.x;
        const dy = context.player.y - this.y;
        const angle = Math.atan2(dy, dx);
        const speed = body.velocity.length() || 120;
        body.velocity.setTo(Math.cos(angle) * speed, Math.sin(angle) * speed);
        this.setRotation(angle);
      }
    }

    // Pixel dust trail for fast projectiles.
    if (Math.random() < 0.6) {
      context.fx.hitSpark(this.x, this.y, this.colorInt, 0.3, this.vfx);
    }

    if (this.age >= this.lifetime) {
      this.detonate(context);
      return true;
    }

    const bounds = context.scene.physics.world.bounds;
    if (this.x < bounds.x - 24 || this.y < bounds.y - 24 || this.x > bounds.right + 24 || this.y > bounds.bottom + 24) {
      return true;
    }
    return false;
  }

  /** Explode / leave a trail field when the projectile expires. */
  detonate(context: CombatContext): void {
    if (this.explodeRadius > 0) {
      context.fx.ring(this.x, this.y, this.colorInt, this.explodeRadius, 0.3);
      context.fx.hitSpark(this.x, this.y, this.colorInt, 1.2, this.vfx);
      context.damageArea({
        x: this.x,
        y: this.y,
        radius: this.explodeRadius,
        damage: this.damage * Math.max(0.1, this.explodeDamageMult || 0.5),
        element: this.element,
        vfx: this.vfx,
        color: this.colorInt,
        statuses: this.statuses,
        knockback: this.knockback,
        friendly: this.owner === 'player',
        isCrit: this.isCrit,
        auto: this.auto,
      });
    }
    if (this.trailField) {
      context.addField({
        x: this.x,
        y: this.y,
        radius: this.trailField.radius,
        dps: this.damage * this.trailField.dpsMult,
        duration: this.trailField.lifetime,
        element: this.element ?? 'fire',
        vfx: this.vfx,
        color: this.colorInt,
        statuses: this.statuses,
        friendly: this.owner === 'player',
      });
    }
  }

  toDamagePacket(): DamagePacket {
    return {
      amount: this.damage,
      isCrit: this.isCrit,
      auto: this.auto,
      element: (this.element as DamagePacket['element']) ?? null,
      vfx: this.vfx,
      damageType: 'elemental',
      statuses: this.statuses,
      knockback: this.knockback,
      source: this.owner === 'player' ? 'player' : 'enemy',
      sourceX: this.x,
      sourceY: this.y,
    };
  }
}

export function findNearest<T extends { x: number; y: number; active: boolean }>(
  list: T[],
  x: number,
  y: number,
  maxRange = Infinity,
): T | null {
  let best: T | null = null;
  let bestDistance = maxRange;
  for (const item of list) {
    if (!item.active) continue;
    const distance = Phaser.Math.Distance.Between(x, y, item.x, item.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = item;
    }
  }
  return best;
}

/** Owns the projectile pool, overlaps and per-frame updates. */
export class ProjectileManager {
  private pool: Phaser.Physics.Arcade.Group;
  private active: Projectile[] = [];
  private scene: Phaser.Scene;

  constructor(scene: Phaser.Scene, maxSize: number) {
    this.scene = scene;
    this.pool = scene.physics.add.group({
      classType: Projectile as unknown as typeof Phaser.Physics.Arcade.Sprite,
      maxSize,
      runChildUpdate: false,
    });
  }

  get group(): Phaser.Physics.Arcade.Group {
    return this.pool;
  }

  get count(): number {
    return this.active.length;
  }

  fire(config: ProjectileConfig): Projectile | null {
    const projectile = this.pool.getFirstDead(false) as Projectile | null;
    if (!projectile) {
      if (this.pool.getLength() >= this.pool.maxSize) return null;
      const created = new Projectile(this.scene, config.x, config.y, 'fx_dot');
      this.pool.add(created, true);
      created.fire(config);
      this.active.push(created);
      return created;
    }
    projectile.fire(config);
    if (!this.active.includes(projectile)) this.active.push(projectile);
    return projectile;
  }

  step(deltaMs: number, context: CombatContext): void {
    for (let i = this.active.length - 1; i >= 0; i -= 1) {
      const projectile = this.active[i];
      if (!projectile.active) {
        this.active.splice(i, 1);
        continue;
      }
      const finished = projectile.step(deltaMs, context);
      if (finished) {
        projectile.detonate(context);
        this.release(projectile);
        this.active.splice(i, 1);
      }
    }
  }

  release(projectile: Projectile): void {
    projectile.setActive(false).setVisible(false);
    const body = projectile.body as Phaser.Physics.Arcade.Body | null;
    if (body) {
      body.stop();
      body.enable = false;
    }
  }

  releaseAll(): void {
    for (const projectile of this.active) this.release(projectile);
    this.active = [];
  }

  /** Nearest active projectile within `radius` of a point (used for clears). */
  findWithin(x: number, y: number, radius: number): Projectile[] {
    return this.active.filter(
      (projectile) =>
        projectile.active && Phaser.Math.Distance.Between(x, y, projectile.x, projectile.y) <= radius,
    );
  }
}

export const PROJECTILE_POOL_SIZES = {
  player: POOLS.projectiles,
  enemy: POOLS.enemyProjectiles,
} as const;
