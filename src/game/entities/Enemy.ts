import Phaser from 'phaser';
import { COMBAT_CONFIG, DIFFICULTY } from '@/config/gameConfig';
import { ENEMY_AFFIXES } from '@/data/enemies';
import { ELEMENT_REGISTRY } from '@/data/elements';
import { ELEMENT_FAMILY } from '@/data/elements/palette';
import { resolveReaction } from '@/game/combat/reactionSystem';
import { getDropTable } from '@/data/loot';
import type { CombatContext } from '@/game/combat/context';
import { capHitDamage, mitigate } from '@/game/combat/damage';
import type { DamagePacket } from '@/game/combat/damage';
import { ensureEnemyTexture } from '@/game/textureFactory';
import { StatusTracker } from '@/game/systems/statusSystem';
import { sfx } from '@/game/systems/audio';
import { executeBossPattern } from '@/game/entities/BossController';
import type {
  AttackPatternStep,
  BossDef,
  EnemyAffixId,
  EnemyDef,
  EnemyRank,
  StatusApplication, ElementId
} from '@/types';
import { clamp } from '@/utils/math';

export type { EnemyRank };

export interface EnemySpawnConfig {
  def: EnemyDef;
  rank: EnemyRank;
  affixes: EnemyAffixId[];
  hpMult: number;
  damageMult: number;
  speedMult: number;
  scale: number;
  /** Ceiling on a single hit's damage, in HP (see `DIFFICULTY.damageCapBaseHp`). */
  damageCap?: number;
  /** Share of the damage above `damageCap` that still lands. */
  damageCapKnee?: number;
  boss?: BossDef | null;
  /** Wave-scaled damage multiplier for boss patterns. */
  waveDamageMult?: number;
}

interface BossRuntime {
  def: BossDef;
  phaseIndex: number;
  patternCooldown: number;
  telegraphing: boolean;
  telegraphTimer: number;
  queuedPattern: number;
  spiralAngle: number;
  abilityTimer: number;
  warnedLowHp: boolean;
  pendingPattern: AttackPatternStep | null;
}

/**
 * Generic enemy.
 *
 * All eight archetypes share this class; the differences live in the data
 * (behaviour block) and in small `runX()` methods. Bosses reuse the same
 * movement, damage and status pipeline and add a phase/pattern controller.
 */
export class Enemy extends Phaser.Physics.Arcade.Sprite {
  def!: EnemyDef;
  rank: EnemyRank = 'normal';
  affixes: EnemyAffixId[] = [];
  boss: BossRuntime | null = null;

  maxHp = 20;
  hp = 20;
  maxShield = 0;
  shield = 0;
  damage = 5;
  speed = 40;
  armor = 0;
  essenceValue = 3;
  damageMult = 1;
  speedMult = 1;

  statuses: StatusTracker;
  /** Bosses and elites shorten statuses; this is their floor before the player's amp. */
  statusDurationBase = 1;
  /** The element that landed the last player hit — who the kill belongs to. */
  lastHitElement: ElementId | null = null;

  private context: CombatContext | null = null;
  private attackReadyAt = 0;
  private telegraphUntil = 0;
  chargeUntil = 0;
  chargeAngle = 0;
  private summonReadyAt = 0;
  private lastShieldHitAt = 0;
  private wanderAngle = 0;
  private wanderTimer = 0;
  private knockbackTimer = 0;
  pendingPattern: AttackPatternStep | null = null;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y, 'enemy_chaser');
    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.setDepth(35);
    this.statuses = new StatusTracker({
      isDead: () => !this.active || this.hp <= 0,
      onDotDamage: (amount, id) => this.applyStatusDamage(amount, id),
    });
  }

  setContext(context: CombatContext): void {
    this.context = context;
  }

  spawn(config: EnemySpawnConfig, x: number, y: number): void {
    const { def, rank, affixes, hpMult, damageMult, speedMult, scale } = config;
    this.def = def;
    this.rank = rank;
    this.affixes = affixes;
    this.boss = config.boss
      ? {
          def: config.boss,
          phaseIndex: 0,
          patternCooldown: 2.4,
          telegraphing: false,
          telegraphTimer: 0,
          queuedPattern: 0,
          spiralAngle: 0,
          abilityTimer: 0,
          warnedLowHp: false,
          pendingPattern: null,
        }
      : null;

    const affixHp = affixes.reduce((mult, id) => mult * (ENEMY_AFFIXES[id]?.hpMult ?? 1), 1);
    const affixDamage = affixes.reduce((mult, id) => mult * (ENEMY_AFFIXES[id]?.damageMult ?? 1), 1);
    const affixSpeed = affixes.reduce((mult, id) => mult * (ENEMY_AFFIXES[id]?.speedMult ?? 1), 1);
    const affixScale = affixes.reduce((mult, id) => mult * (ENEMY_AFFIXES[id]?.scaleMult ?? 1), 1);
    const affixArmor = affixes.reduce((sum, id) => sum + (ENEMY_AFFIXES[id]?.armorAdd ?? 0), 0);
    const affixShield = affixes.reduce((sum, id) => sum + (ENEMY_AFFIXES[id]?.shieldHp ?? 0), 0);

    const baseHp = config.boss ? config.boss.hp : def.hp;
    const baseDamage = config.boss ? config.boss.damage : def.damage;
    const baseSpeed = config.boss ? config.boss.speed : def.speed;

    this.maxHp = Math.round(baseHp * hpMult * affixHp);
    this.hp = this.maxHp;
    const rawDamage = baseDamage * damageMult * affixDamage;
    /* The caller decides the ceiling and how much of the excess still lands, so the
       entity holds no opinion about difficulty. `capHitDamage` keeps the promise that
       one touch cannot delete a health bar without muting the curve behind it. */
    const kneeled = capHitDamage(rawDamage, config.damageCap, config.damageCapKnee ?? 0);
    // …and one touch can never delete the bar it is aimed at.
    const pool = this.context?.player.stats.maxHp ?? 0;
    this.damage = pool > 0 ? Math.min(kneeled, pool * DIFFICULTY.damageHardCapFraction) : kneeled;
    this.damageMult = damageMult * affixDamage;
    this.speed = baseSpeed * speedMult * affixSpeed;
    this.speedMult = speedMult * affixSpeed;
    this.armor = (config.boss ? config.boss.armor : def.armor) + affixArmor;
    this.essenceValue = config.boss ? config.boss.essence : def.essence;
    this.maxShield = (def.behavior.shieldHp ?? 0) + affixShield;
    this.shield = this.maxShield;

    this.setTexture(ensureEnemyTexture(this.scene, def.spriteKey, def.colorInt));
    this.setTint(config.boss ? config.boss.colorInt : def.colorInt);
    const finalScale = scale * affixScale * (config.boss ? 1.35 : 1);
    this.setScale(finalScale);
    this.setPosition(Math.round(x), Math.round(y));
    this.setActive(true).setVisible(true).setAlpha(1).setAngle(0);

    const body = this.body as Phaser.Physics.Arcade.Body;
    const radius = (config.boss ? config.boss.radius : def.radius) * finalScale * 0.55;
    body.enable = true;
    body.reset(Math.round(x), Math.round(y));
    body.setCircle(radius);
    // Velocity is steered every frame by the archetype AI, so arcade drag is
    // deliberately zero — otherwise drag cancels the steering acceleration and
    // enemies crawl. Knockback and stun decay are handled explicitly instead.
    body.setDrag(0, 0);
    body.setMaxVelocity(this.speed * 3.4, this.speed * 3.4);
    body.setCollideWorldBounds(true);
    body.setBounce(0.1);

    this.statuses = new StatusTracker({
      isDead: () => !this.active || this.hp <= 0,
      onDotDamage: (amount, id) => this.applyStatusDamage(amount, id),
    });
    /* Bosses resist hard control so fights stay readable. The resistance is a *base*
       now: the warden's own status-duration amp is layered on top of it per hit, so
       `stats.statusDurationMult` finally reaches the tracker that uses it (docs §B5). */
    this.statusDurationBase = config.boss ? 0.5 : 1;
    if (config.boss) {
      this.statuses.immunity.add('root');
    }
    this.lastHitElement = null;
    this.refreshStatusDuration();
    this.attackReadyAt = this.scene.time.now + 600;
    this.telegraphUntil = 0;
    this.chargeUntil = 0;
    this.summonReadyAt = this.scene.time.now + 2500;
    this.wanderAngle = Math.random() * Math.PI * 2;
    this.wanderTimer = 0;
    this.essenceBonus = 1;
  }

  essenceBonus = 1;

  /* ---------------------- per-frame ---------------------- */

  tick(deltaMs: number): void {
    if (!this.active) return;
    const context = this.context;
    if (!context) return;
    const now = this.scene.time.now;
    const dt = deltaMs / 1000;
    const body = this.body as Phaser.Physics.Arcade.Body;

    this.statuses.tick(deltaMs);
    for (const affixId of this.affixes) {
      const affix = ENEMY_AFFIXES[affixId];
      if (affix?.regenPerSecond) {
        this.hp = clamp(this.hp + affix.regenPerSecond * (this.rank === 'boss' ? 8 : 1) * dt, 0, this.maxHp);
      }
    }

    // Shield regeneration out of combat.
    if (this.maxShield > 0 && this.shield < this.maxShield) {
      const delay = this.def.behavior.shieldRegenDelay ?? 3;
      if ((now - this.lastShieldHitAt) / 1000 > delay) {
        this.shield = clamp(this.shield + this.maxShield * 0.25 * dt, 0, this.maxShield);
      }
    }

    if (this.statuses.pendingImpulse > 0) {
      const impulse = this.statuses.pendingImpulse;
      this.statuses.pendingImpulse = 0;
      const angle = Math.atan2(body.velocity.y, body.velocity.x);
      this.knockbackTimer = 0.22;
      body.velocity.x += Math.cos(angle) * impulse;
      body.velocity.y += Math.sin(angle) * impulse;
    }
    if (this.knockbackTimer > 0) {
      this.knockbackTimer -= dt;
      body.velocity.scale(Math.pow(0.02, dt));
      if (this.knockbackTimer <= 0) body.velocity.scale(0.3);
      this.setFlipX(body.velocity.x < 0);
      return;
    }

    const movementMultiplier = this.statuses.movementMultiplier();
    if (this.boss) {
      this.runBoss(deltaMs, context);
    } else {
      this.runArchetype(deltaMs, context, movementMultiplier);
    }

    if (this.statuses.movementMultiplier() === 0) body.velocity.scale(0.1);

    if (Math.abs(body.velocity.x) > 2) this.setFlipX(body.velocity.x < 0);
    this.setDepth(34 + Math.round(this.y / 100));
  }

  /** Distance to the player. */
  private playerDistance(context: CombatContext): number {
    return Phaser.Math.Distance.Between(this.x, this.y, context.player.x, context.player.y);
  }

  private moveToward(context: CombatContext, speedMultiplier = 1): void {
    const body = this.body as Phaser.Physics.Arcade.Body;
    const angle = Math.atan2(context.player.y - this.y, context.player.x - this.x);
    const speed = this.speed * this.statuses.movementMultiplier() * speedMultiplier;
    body.velocity.x += (Math.cos(angle) * speed - body.velocity.x) * 0.12;
    body.velocity.y += (Math.sin(angle) * speed - body.velocity.y) * 0.12;
  }

  private moveAway(context: CombatContext, speedMultiplier = 1): void {
    const body = this.body as Phaser.Physics.Arcade.Body;
    const angle = Math.atan2(this.y - context.player.y, this.x - context.player.x);
    const speed = this.speed * this.statuses.movementMultiplier() * speedMultiplier;
    body.velocity.x += (Math.cos(angle) * speed - body.velocity.x) * 0.1;
    body.velocity.y += (Math.sin(angle) * speed - body.velocity.y) * 0.1;
  }

  private strafe(context: CombatContext): void {
    const body = this.body as Phaser.Physics.Arcade.Body;
    this.wanderTimer -= 1 / 60;
    if (this.wanderTimer <= 0) {
      this.wanderTimer = 1.2 + Math.random() * 1.4;
      this.wanderAngle = Math.random() * Math.PI * 2;
    }
    const speed = this.speed * this.statuses.movementMultiplier() * 0.6;
    body.velocity.x += (Math.cos(this.wanderAngle) * speed - body.velocity.x) * 0.05;
    body.velocity.y += (Math.sin(this.wanderAngle) * speed - body.velocity.y) * 0.05;
    void context;
  }

  /* ---------------------- archetypes ---------------------- */

  private runArchetype(_deltaMs: number, context: CombatContext, movementMultiplier: number): void {
    const now = this.scene.time.now;
    const distance = this.playerDistance(context);
    const behavior = this.def.behavior ?? {};
    const attackDisabled = this.statuses.attackDisabled() || movementMultiplier === 0;

    switch (this.def.archetype) {
      case 'chaser': {
        this.moveToward(context);
        if (distance < this.def.attackRange + 6 && now >= this.attackReadyAt && !attackDisabled) {
          this.meleeAttack(context);
        }
        break;
      }
      case 'charger': {
        if (now < this.telegraphUntil) {
          const body = this.body as Phaser.Physics.Arcade.Body;
          body.velocity.scale(0.82);
        } else if (now < this.chargeUntil) {
          const body = this.body as Phaser.Physics.Arcade.Body;
          body.velocity.setTo(
            Math.cos(this.chargeAngle) * (behavior.chargeSpeed ?? 170) * this.speedMult,
            Math.sin(this.chargeAngle) * (behavior.chargeSpeed ?? 170) * this.speedMult,
          );
          if (distance < this.def.attackRange + 8 && !attackDisabled) this.meleeAttack(context);
        } else if (distance < 150 && now >= this.attackReadyAt) {
          this.telegraphUntil = now + (behavior.telegraph ?? 0.5) * 1000;
          this.chargeUntil = this.telegraphUntil + 620;
          this.chargeAngle = Math.atan2(context.player.y - this.y, context.player.x - this.x);
          this.attackReadyAt = this.chargeUntil + this.def.attackCooldown * 1000;
          context.telegraph(this.x, this.y, 26, this.def.colorInt, (behavior.telegraph ?? 0.5) * 1000);
        } else {
          this.moveToward(context, 0.7);
        }
        break;
      }
      case 'caster': {
        const preferred = behavior.preferredRange ?? 100;
        if (distance < preferred * 0.75) this.moveAway(context, 0.9);
        else if (distance > preferred * 1.15) this.moveToward(context, 0.8);
        else this.strafe(context);
        if (distance < this.def.attackRange && now >= this.attackReadyAt && !attackDisabled) {
          this.rangedAttack(context);
        }
        break;
      }
      case 'tank': {
        this.moveToward(context, 0.85);
        if (distance < this.def.attackRange + 8 && now >= this.attackReadyAt && !attackDisabled) {
          this.meleeAttack(context);
        }
        break;
      }
      case 'assassin': {
        if (now < this.telegraphUntil) {
          this.strafe(context);
        } else if (now < this.chargeUntil) {
          const body = this.body as Phaser.Physics.Arcade.Body;
          body.velocity.setTo(
            Math.cos(this.chargeAngle) * (behavior.chargeSpeed ?? 220) * this.speedMult,
            Math.sin(this.chargeAngle) * (behavior.chargeSpeed ?? 220) * this.speedMult,
          );
          if (distance < this.def.attackRange + 10 && !attackDisabled) this.meleeAttack(context);
        } else if (now >= this.attackReadyAt) {
          this.telegraphUntil = now + (behavior.telegraph ?? 0.5) * 1000;
          this.chargeUntil = this.telegraphUntil + 420;
          this.chargeAngle = Math.atan2(context.player.y - this.y, context.player.x - this.x);
          this.attackReadyAt = this.chargeUntil + this.def.attackCooldown * 1000;
          context.telegraph(context.player.x, context.player.y, 18, this.def.colorInt, (behavior.telegraph ?? 0.5) * 1000);
        } else if (distance > 130) {
          this.moveToward(context, 0.9);
        } else {
          this.strafe(context);
        }
        break;
      }
      case 'splitter': {
        this.moveToward(context, 0.95);
        if (distance < this.def.attackRange + 6 && now >= this.attackReadyAt && !attackDisabled) {
          this.meleeAttack(context);
        }
        break;
      }
      case 'summoner': {
        const preferred = behavior.preferredRange ?? 100;
        if (distance < preferred * 0.8) this.moveAway(context, 0.8);
        else this.strafe(context);
        if (now >= this.summonReadyAt && !attackDisabled && context.enemies.countActive(true) < 40) {
          this.summonReadyAt = now + (behavior.summonCooldown ?? 7) * 1000;
          this.summon(context);
        }
        if (distance < this.def.attackRange && now >= this.attackReadyAt && !attackDisabled) {
          this.rangedAttack(context);
        }
        break;
      }
      case 'shielded':
      default: {
        this.moveToward(context, 0.9);
        if (distance < this.def.attackRange + 6 && now >= this.attackReadyAt && !attackDisabled) {
          this.meleeAttack(context);
        }
        break;
      }
    }
  }

  /* ---------------------- attacks ---------------------- */

  private attackStatuses(): StatusApplication[] {
    const combined: StatusApplication[] = [...(this.def.onHitStatuses ?? [])];
    for (const affixId of this.affixes) {
      const affix = ENEMY_AFFIXES[affixId];
      if (affix?.onHitStatuses) combined.push(...affix.onHitStatuses);
    }
    return combined;
  }

  private meleeAttack(context: CombatContext): void {
    this.attackReadyAt = this.scene.time.now + this.def.attackCooldown * 1000;
    const angle = Math.atan2(context.player.y - this.y, context.player.x - this.x);
    context.fx.hitSpark(this.x + Math.cos(angle) * 8, this.y + Math.sin(angle) * 8, this.def.colorInt, 0.6);
    context.player.takeDamage({
      amount: this.damage * this.statuses.damageDealtMultiplier(),
      isCrit: false,
      element: this.def.element,
      vfx: this.def.archetype === 'splitter' ? 'vine' : 'spark',
      damageType: 'physical',
      statuses: this.attackStatuses(),
      knockback: 0,
      source: 'enemy',
      sourceX: this.x,
      sourceY: this.y,
    });
    sfx('attack', { gain: 0.35, rate: 0.8 });
  }

  private rangedAttack(context: CombatContext): void {
    const behavior = this.def.behavior;
    this.attackReadyAt = this.scene.time.now + this.def.attackCooldown * 1000;
    const count = behavior.volleyCount ?? 1;
    const baseAngle = Math.atan2(context.player.y - this.y, context.player.x - this.x);
    const elementDef = ELEMENT_REGISTRY[this.def.element];
    for (let i = 0; i < count; i += 1) {
      const offset = count === 1 ? 0 : (i - (count - 1) / 2) * 0.16;
      context.enemyProjectiles.fire({
        x: this.x,
        y: this.y,
        angle: baseAngle + offset,
        speed: behavior.projectileSpeed ?? 100,
        damage: this.damage * this.statuses.damageDealtMultiplier(),
        owner: 'enemy',
        element: this.def.element,
        vfx: elementDef.attack.vfx,
        color: this.def.colorInt,
        radius: this.rank === 'boss' ? 5 : 3.5,
        lifetime: 2.4,
        pierce: 0,
        chain: 0,
        homing: 0,
        knockback: 0,
        statuses: this.attackStatuses(),
        explodeRadius: 0,
        explodeDamageMult: 1,
        destroysEnemyProjectiles: false,
        boomerang: false,
      });
    }
    sfx('attack', { gain: 0.3, rate: 0.7 + Math.random() * 0.2 });
  }

  private summon(context: CombatContext): void {
    const behavior = this.def.behavior;
    const defId = behavior.summonDefId ?? 'cinder_chaser';
    const count = behavior.summonCount ?? 2;
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const distance = 26 + Math.random() * 20;
      context.spawnEnemy(defId, this.x + Math.cos(angle) * distance, this.y + Math.sin(angle) * distance, {
        portal: false,
      });
    }
    context.fx.ring(this.x, this.y, this.def.colorInt, 34, 0.5);
    context.fx.callout(this.x, this.y - 16, 'SUMMON', '#F2C96B', 7);
  }

  /* ---------------------- boss controller ---------------------- */

  private runBoss(deltaMs: number, context: CombatContext): void {
    const boss = this.boss;
    if (!boss) return;
    const now = this.scene.time.now;
    const dt = deltaMs / 1000;
    const hpRatio = this.hp / this.maxHp;

    // Phase transitions: take the *deepest* phase whose HP threshold the boss
    // has fallen to (phase 0 is always `hpThreshold: 1`, so scanning downwards
    // and keeping the last match would pin bosses in phase 0 forever).
    let nextPhase = 0;
    for (let i = boss.def.phases.length - 1; i >= 0; i -= 1) {
      if (hpRatio <= boss.def.phases[i].hpThreshold) {
        nextPhase = i;
        break;
      }
    }
    if (nextPhase !== boss.phaseIndex) {
      boss.phaseIndex = nextPhase;
      const phase = boss.def.phases[nextPhase];
      context.fx.shake(phase.shake > 5 ? 'heavy' : 'medium');
      context.fx.ring(this.x, this.y, this.def.colorInt, 70, 0.8, 2);
      // "The boss has changed" has to be unmistakable: wash, hold, shockwave.
      context.fx.screenWash(0xff5c6c, 0.22, 420);
      context.fx.hitStop(120);
      context.fx.impact({
        tier: 'bossPhase',
        x: this.x,
        y: this.y,
        amount: 0,
        isCrit: false,
        color: this.def.colorInt,
        vfx: 'bolt',
        silent: true,
      });
      context.onBossPhase?.(this, nextPhase, phase.banner);
      sfx('boss_enter', { gain: 0.5 });
    }
    const phase = boss.def.phases[boss.phaseIndex];

    if (boss.telegraphing) {
      boss.telegraphTimer -= deltaMs;
      const body = this.body as Phaser.Physics.Arcade.Body;
      body.velocity.scale(0.9);
      if (boss.telegraphTimer <= 0) {
        boss.telegraphing = false;
        this.executeBossPattern(context, phase, boss.spiralAngle);
      }
      return;
    }

    boss.patternCooldown -= dt;
    // Movement rhythm between attacks: repositioning keeps fights dynamic.
    const distance = this.playerDistance(context);
    const desired = 110 + Math.sin(now / 900) * 40;
    if (distance > desired + 30) this.moveToward(context, phase.speedMult * 0.9);
    else if (distance < desired - 40) this.moveAway(context, phase.speedMult * 0.6);
    else this.strafe(context);

    if (boss.patternCooldown <= 0) {
      const steps = phase.patterns;
      const total = steps.reduce((sum, step) => sum + step.weight, 0);
      let roll = Math.random() * total;
      let chosen = steps[0];
      for (const step of steps) {
        roll -= step.weight;
        if (roll <= 0) {
          chosen = step;
          break;
        }
      }
      boss.pendingPattern = chosen;
      const telegraphMs = this.patternTelegraph(chosen.pattern);
      boss.telegraphing = true;
      boss.telegraphTimer = telegraphMs;
      boss.patternCooldown = (chosen.cooldown ?? 4) / phase.attackSpeedMult;
      boss.spiralAngle = Math.atan2(context.player.y - this.y, context.player.x - this.x);
      const color = this.def.colorInt;
      context.telegraph(
        this.x,
        this.y,
        this.patternRadius(chosen.params),
        color,
        telegraphMs,
      );
      context.fx.callout(this.x, this.y - 20, chosen.pattern.replace(/([A-Z])/g, ' $1').toUpperCase(), '#F2C96B', 7);
      context.onBossTelegraph?.(this, chosen.pattern);
    }

    // Passive minion upkeep for boss phases that summon.
    boss.abilityTimer -= dt;
    if (boss.abilityTimer <= 0) {
      boss.abilityTimer = 12;
      if (boss.def.minionDefId && context.enemies.countActive(true) < 30 && boss.phaseIndex > 0) {
        this.summon(context);
      }
    }
  }

  /**
   * Starts a charge. The speed comes from the attack pattern's data when it
   * supplies one, so bosses can be tuned per pattern instead of relying on a
   * single multiplier of their walking speed.
   */
  beginCharge(angle: number, durationMs: number, speedOverride?: number): void {
    this.chargeAngle = angle;
    this.chargeUntil = this.scene.time.now + durationMs;
    const body = this.body as Phaser.Physics.Arcade.Body;
    const speed = Math.max(180, speedOverride ?? this.speed * 5);
    body.velocity.setTo(Math.cos(angle) * speed, Math.sin(angle) * speed);
  }

  patternTelegraph(pattern: string): number {
    switch (pattern) {
      case 'chargeDash':
        return 620;
      case 'radialBurst':
      case 'spiral':
        return 520;
      case 'beamSweep':
        return 780;
      case 'eruptionField':
        return 900;
      default:
        return 480;
    }
  }

  patternRadius(params: Record<string, number>): number {
    return params.radius ?? 46;
  }

  private executeBossPattern(context: CombatContext, phase: BossDef['phases'][number], aimAngle: number): void {
    const boss = this.boss;
    if (!boss) return;
    executeBossPattern(this, context, boss, phase, aimAngle);
  }

  /* ---------------------- damage + death ---------------------- */

  /**
   * Status uptime on this target: its own resistance × whatever the warden's stat
   * engine reports, clamped by `statusDurationCap`.
   */
  refreshStatusDuration(): void {
    const amp = this.context?.player.stats.statusDurationMult ?? 1;
    this.statuses.durationMultiplier =
      this.statusDurationBase * Math.max(1, Math.min(COMBAT_CONFIG.statusDurationCap, amp));
  }

  takeDamage(packet: DamagePacket): { dealt: number; killed: boolean } {
    if (!this.active || this.hp <= 0) return { dealt: 0, killed: false };
    let amount = packet.amount;
    if (packet.element && packet.source === 'player') this.lastHitElement = packet.element;
    this.refreshStatusDuration();

    /* Snapshot before anything is applied: a reaction is what two *existing*
       things make when a third arrives, never what the arriving hit brings. */
    const canReact = Boolean(packet.element) && !packet.noReaction && Boolean(this.context);
    const carried = canReact ? this.statuses.all.map((instance) => instance.id) : [];

    if (this.shield > 0) {
      const absorbed = Math.min(this.shield, amount);
      this.shield -= absorbed;
      amount -= absorbed;
      this.lastShieldHitAt = this.scene.time.now;
      if (absorbed > 0) {
        this.context?.fx.hitSpark(this.x, this.y, 0xb39df2, 0.5);
      }
    }

    if (amount > 0) {
      const armorBreak = this.statuses.armorMultiplier();
      const mitigated = mitigate(amount, this.armor, armorBreak);
      this.hp -= mitigated;
      amount = mitigated;
    }

    this.context?.fx.flash(this);

    /* Graded feedback: the frame answers in proportion to what happened, and a
       boss's huge health pool keeps ordinary hits at 'normal' so the screen does
       not rattle for no reason. */
    const ratios = COMBAT_CONFIG.tierRatios;
    const ratio = this.maxHp > 0 ? amount / this.maxHp : 0;
    const tier =
      packet.tier ??
      (ratio >= ratios.ultimate || (packet.isCrit && ratio >= ratios.crit)
        ? 'ultimate'
        : packet.isCrit
          ? 'crit'
          : ratio >= ratios.skill
            ? 'skill'
            : 'normal');
    this.context?.fx.impact({
      tier,
      x: this.x,
      y: this.y,
      amount: Math.max(1, Math.round(amount)),
      isCrit: packet.isCrit,
      color: packet.element ? ELEMENT_REGISTRY[packet.element].colorInt : this.def.colorInt,
      vfx: packet.vfx,
      family: packet.element ? ELEMENT_FAMILY[packet.element] : undefined,
      target: this,
      knockAngle: Math.atan2(this.y - packet.sourceY, this.x - packet.sourceX),
    });

    for (const status of packet.statuses) this.statuses.apply(status);

    if (canReact && this.context && packet.element) {
      resolveReaction({
        context: this.context,
        victim: this,
        amount,
        element: packet.element,
        sourceX: packet.sourceX,
        sourceY: packet.sourceY,
        carriedStatuses: carried,
      });
    }

    if (packet.knockback !== 0) {
      const body = this.body as Phaser.Physics.Arcade.Body;
      const angle = Math.atan2(this.y - packet.sourceY, this.x - packet.sourceX);
      const strength = (packet.knockback / (this.rank === 'boss' ? 8 : this.rank === 'miniboss' ? 4 : 1.4)) / (1 + this.armor * 2);
      body.velocity.x += Math.cos(angle) * strength;
      body.velocity.y += Math.sin(angle) * strength;
    }

    if (this.hp <= 0) {
      this.die(packet.source === 'player');
      return { dealt: amount, killed: true };
    }
    return { dealt: amount, killed: false };
  }

  private applyStatusDamage(amount: number, statusId: string): void {
    if (!this.active || this.hp <= 0) return;
    this.hp -= amount;
    if (Math.random() < 0.4) {
      const dominant = this.statuses.all.find((entry) => entry.id === statusId);
      const colorInt = dominant
        ? { burn: 0xff7a3c, poison: 0x9ce65a }[dominant.id as 'burn' | 'poison'] ?? 0xffffff
        : 0xffffff;
      this.context?.fx.damageNumber(
        this.x,
        this.y - 4,
        amount,
        false,
        colorInt === 0x9ce65a ? '#9CE65A' : '#FF9A5C',
      );
    }
    if (this.hp <= 0) this.die(true);
  }

  die(creditPlayer: boolean): void {
    const context = this.context;
    if (!context) {
      this.retire();
      return;
    }
    const color = this.boss ? this.boss.def.colorInt : this.def.colorInt;

    // Split on death.
    if (this.def.spawnsOnDeath && this.rank !== 'boss') {
      const { defId, count } = this.def.spawnsOnDeath;
      for (let i = 0; i < count; i += 1) {
        const angle = (i / count) * Math.PI * 2 + Math.random();
        context.spawnEnemy(defId, this.x + Math.cos(angle) * 14, this.y + Math.sin(angle) * 14, {
          portal: false,
        });
      }
    }

    // Volatile affix detonation.
    for (const affixId of this.affixes) {
      const affix = ENEMY_AFFIXES[affixId];
      if (affix?.onDeathExplode) {
        context.fx.ring(this.x, this.y, affix.color ? parseInt(affix.color.slice(1), 16) : 0xff7a3c, affix.onDeathExplode.radius, 0.4);
        context.damageArea({
          x: this.x,
          y: this.y,
          radius: affix.onDeathExplode.radius,
          damage: this.damage * affix.onDeathExplode.damageMult,
          element: this.def.element,
          vfx: 'spark',
          color: 0xff7a3c,
          friendly: false,
        });
      }
    }

    context.fx.deathBurst(this.x, this.y, color, this.rank === 'boss' ? 2.6 : this.rank === 'elite' ? 1.5 : 1);

    // Drops.
    const dropTableId = this.rank === 'normal' ? this.def.dropTableId : 'elite_drop';
    const table = getDropTable(dropTableId);
    if (table) context.rollDropTable(table, this.x, this.y, this.essenceBonus);

    context.onEnemyKilled(this);
    context.addEssence(Math.round(this.essenceValue * (this.rank === 'boss' ? 1 : this.rank === 'elite' ? 2 : 1)));
    sfx(this.rank === 'boss' ? 'boss_defeat' : 'enemy_death', { gain: this.rank === 'boss' ? 1 : 0.6 });

    void creditPlayer;
    this.retire();
  }

  retire(): void {
    this.setActive(false).setVisible(false);
    this.statuses.clear();
    const body = this.body as Phaser.Physics.Arcade.Body | null;
    if (body) {
      body.stop();
      body.velocity.setTo(0, 0);
      body.enable = false;
    }
  }

  get isBoss(): boolean {
    return this.rank === 'boss' || this.rank === 'miniboss';
  }
}

export function enemyRankColors(rank: EnemyRank): { ring: number; label: string } {
  switch (rank) {
    case 'boss':
      return { ring: 0xf2c96b, label: 'BOSS' };
    case 'miniboss':
      return { ring: 0xb39df2, label: 'MINI BOSS' };
    case 'elite':
      return { ring: 0xffe066, label: 'ELITE' };
    default:
      return { ring: 0x2a3850, label: '' };
  }
}

