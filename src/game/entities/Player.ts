import Phaser from 'phaser';
import { AUTO_CAST, COMBAT_CONFIG, DASH_CONFIG, ENERGY_CONFIG, PICKUP_CONFIG, PLAYER_CONFIG } from '@/config/gameConfig';
import { ELEMENT_REGISTRY } from '@/data/elements';
import { ELEMENT_FAMILY } from '@/data/elements/palette';
import { ensurePlayerTexture } from '@/game/textureFactory';
import type { CombatContext } from '@/game/combat/context';
import { mitigate, rollCrit } from '@/game/combat/damage';
import type { DamagePacket } from '@/game/combat/damage';
import { effectiveCooldown, effectiveCost, elementDamageMultiplier } from '@/game/systems/statEngine';
import type { PlayerStats } from '@/game/systems/statEngine';
import { StatusTracker } from '@/game/systems/statusSystem';
import { sfx } from '@/game/systems/audio';
import type { AutoCastTarget } from '@/game/systems/autoCast';
import type { AbilitySpec, AttackSpec, ElementId, StatusApplication } from '@/types';
import { pulse } from '@/utils/haptics';
import { clamp } from '@/utils/math';

export interface PlayerInputState {
  moveX: number;
  moveY: number;
  attack: boolean;
  skill: boolean;
  ultimate: boolean;
  dash: boolean;
  /** World-space aim target. */
  aimX: number;
  aimY: number;
  /** True when aim came from an explicit pointer rather than auto-aim. */
  aiming: boolean;
}

export interface PlayerEvents {
  onAttack?: (element: ElementId | null) => void;
  onSkill?: (element: ElementId | null) => void;
  onUltimate?: (element: ElementId | null) => void;
  onDash?: () => void;
  onDamageDealt?: (amount: number, isCrit: boolean, isBoss: boolean) => void;
  onDamageTaken?: (amount: number) => void;
  onDeath?: () => void;
  onHeal?: (amount: number) => void;
}

const ZERO_INPUT: PlayerInputState = {
  moveX: 0,
  moveY: 0,
  attack: false,
  skill: false,
  ultimate: false,
  dash: false,
  aimX: 0,
  aimY: 0,
  aiming: false,
};

export class Player extends Phaser.Physics.Arcade.Sprite {
  stats: PlayerStats;
  hp = 100;
  maxHp = 100;
  energy = 100;
  maxEnergy = 100;
  shield = 0;
  alive = true;

  slots: (ElementId | null)[] = [null, null, null, null, null, null];
  activeSlot = 0;

  statuses: StatusTracker;

  private context: CombatContext | null = null;
  private events: PlayerEvents = {};
  private playerInput: PlayerInputState = { ...ZERO_INPUT };

  private attackReadyAt = 0;
  private skillReadyAt = 0;
  private ultimateReadyAt = 0;
  private dashReadyAt = 0;
  private switchReadyAt = 0;
  private invulnUntil = 0;
  private lastHitAt = 0;
  private dashUntil = 0;
  private dashAngle = 0;
  private trailTimer = 0;
  private regenerationBoost = 0;
  private regenerationBoostUntil = 0;
  private attackHeldSince = 0;
  private contactCooldownAt = 0;

  /** Presentation state used by the HUD/aura. */
  auraSprite: Phaser.GameObjects.Image;

  constructor(scene: Phaser.Scene, x: number, y: number, stats: PlayerStats, element: ElementId | null) {
    super(
      scene,
      x,
      y,
      element ? ensurePlayerTexture(scene, element, ELEMENT_REGISTRY[element].colorInt) : 'player_fire',
    );
    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.setDepth(45);

    this.stats = stats;
    this.maxHp = stats.maxHp;
    this.hp = stats.maxHp;
    this.maxEnergy = stats.maxEnergy;
    this.energy = stats.maxEnergy;

    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setCircle(PLAYER_CONFIG.radius, 0, 1);
    body.setCollideWorldBounds(true);
    // The controller steers velocity directly (acceleration / deceleration
    // config), so arcade drag is disabled to avoid fighting it.
    body.setDrag(0, 0);
    body.setMaxVelocity(DASH_CONFIG.speed, DASH_CONFIG.speed);

    this.auraSprite = scene.add.image(x, y, 'fx_ring').setDepth(44).setAlpha(0.35).setScale(0.9).setVisible(false);

    this.statuses = new StatusTracker({
      isDead: () => !this.alive,
      onDotDamage: (amount, id) => this.applyStatusDamage(amount, id),
    });
  }

  setContext(context: CombatContext): void {
    this.context = context;
  }

  setEvents(events: PlayerEvents): void {
    this.events = events;
  }

  setLoadout(slots: (ElementId | null)[], activeSlot: number): void {
    this.slots = slots.slice(0, 6);
    while (this.slots.length < 6) this.slots.push(null);
    this.activeSlot = this.slots[activeSlot] ? activeSlot : Math.max(0, this.slots.findIndex(Boolean));
    this.refreshTexture();
  }

  get activeElement(): ElementId | null {
    return this.slots[this.activeSlot] ?? null;
  }

  get activeAttack(): AttackSpec | null {
    const element = this.activeElement;
    return element ? ELEMENT_REGISTRY[element].attack : null;
  }

  /**
   * Start the run wounded instead of full. SAVE & EXIT records the health the warden was
   * standing on and the scene that resumes the same run hands it back here. Clamped into the
   * current stat block, because relics or a loadout edit between the two can move `maxHp`.
   */
  beginAtHp(hp: number): void {
    if (!Number.isFinite(hp)) return;
    this.hp = clamp(Math.round(hp), 1, this.maxHp);
  }

  applyStats(stats: PlayerStats): void {
    const hpRatio = this.maxHp > 0 ? this.hp / this.maxHp : 1;
    const energyRatio = this.maxEnergy > 0 ? this.energy / this.maxEnergy : 1;
    this.stats = stats;
    this.maxHp = stats.maxHp;
    this.maxEnergy = stats.maxEnergy;
    this.hp = clamp(this.maxHp * hpRatio, 1, this.maxHp);
    this.energy = clamp(this.maxEnergy * energyRatio, 0, this.maxEnergy);
  }

  refreshTexture(): void {
    const element = this.activeElement;
    if (!element) return;
    const def = ELEMENT_REGISTRY[element];
    this.setTexture(ensurePlayerTexture(this.scene, element, def.colorInt));
    this.setTint(0xffffff);
    this.auraSprite.setTexture('fx_ring');
    this.auraSprite.setTint(def.colorInt);
    this.auraSprite.setVisible(true);
    this.auraSprite.setScale(1.1);
    this.auraSprite.setAlpha(0.32);
  }

  private now(): number {
    return this.scene.time.now;
  }

  /* ---------------------- combat timers ---------------------- */

  get dashCooldownRatio(): number {
    const remaining = this.dashReadyAt - this.now();
    return remaining <= 0 ? 1 : 1 - remaining / (DASH_CONFIG.cooldown * 1000);
  }

  get skillCooldownRatio(): number {
    const element = this.activeElement;
    if (!element) return 1;
    const spec = ELEMENT_REGISTRY[element].skill;
    const cooldown = effectiveCooldown(spec.cooldown, this.stats, element, 'skill') * 1000;
    const remaining = this.skillReadyAt - this.now();
    return remaining <= 0 ? 1 : 1 - remaining / cooldown;
  }

  get ultimateChargeRatio(): number {
    const element = this.activeElement;
    if (!element) return 0;
    const spec = ELEMENT_REGISTRY[element].ultimate;
    const cooldown = effectiveCooldown(spec.cooldown, this.stats, element, 'ultimate') * 1000;
    const remaining = this.ultimateReadyAt - this.now();
    const cooldownPart = remaining <= 0 ? 1 : 1 - remaining / cooldown;
    const cost = effectiveCost(spec.energyCost, this.stats, element, 'ultimate');
    const energyPart = cost <= 0 ? 1 : clamp(this.energy / cost, 0, 1);
    return Math.min(cooldownPart, energyPart);
  }

  /* ---------------------- main loop ---------------------- */

  setInput(input: PlayerInputState): void {
    this.playerInput = input;
  }

  tick(deltaMs: number): void {
    if (!this.alive) return;
    const dt = deltaMs / 1000;
    const now = this.now();
    const body = this.body as Phaser.Physics.Arcade.Body;

    // Statuses tick first: damage over time, movement gating and knockback.
    this.statuses.tick(deltaMs);
    if (this.statuses.pendingImpulse > 0) {
      const body = this.body as Phaser.Physics.Arcade.Body;
      const angle = Math.atan2(body.velocity.y, body.velocity.x);
      const impulse = this.statuses.pendingImpulse;
      this.statuses.pendingImpulse = 0;
      body.velocity.x += Math.cos(angle) * impulse * 0.5;
      body.velocity.y += Math.sin(angle) * impulse * 0.5;
    }
    if (this.statuses.attackDisabled()) {
      this.playerInput.attack = false;
      this.playerInput.skill = false;
      this.playerInput.ultimate = false;
    }
    const movementMultiplier = this.statuses.movementMultiplier();

    // Movement.
    const moving = Math.abs(this.playerInput.moveX) > 0.01 || Math.abs(this.playerInput.moveY) > 0.01;
    const targetSpeed = this.stats.speed * movementMultiplier;
    const dashing = now < this.dashUntil;

    if (dashing) {
      body.velocity.setTo(
        Math.cos(this.dashAngle) * DASH_CONFIG.speed,
        Math.sin(this.dashAngle) * DASH_CONFIG.speed,
      );
      this.spawnDashTrail(deltaMs);
    } else {
      const normalized = new Phaser.Math.Vector2(this.playerInput.moveX, this.playerInput.moveY);
      if (normalized.lengthSq() > 1) normalized.normalize();
      const desiredX = normalized.x * targetSpeed;
      const desiredY = normalized.y * targetSpeed;
      const factor = moving ? dt / PLAYER_CONFIG.acceleration : dt / PLAYER_CONFIG.deceleration;
      const blend = clamp(factor, 0, 1);
      body.velocity.x += (desiredX - body.velocity.x) * blend;
      body.velocity.y += (desiredY - body.velocity.y) * blend;
      if (!moving && body.velocity.lengthSq() < 1) body.velocity.setTo(0, 0);
    }

    // Facing + sprite flip.
    if (Math.abs(body.velocity.x) > 4) this.setFlipX(body.velocity.x < 0);

    // Aura follows the player.
    this.auraSprite.setPosition(Math.round(this.x), Math.round(this.y) + 1);
    if (this.activeElement) {
      const pulse = 1.05 + Math.sin(now / 220) * 0.08;
      this.auraSprite.setScale(pulse);
    }

    // Energy + health regeneration.
    const sinceHit = (now - this.lastHitAt) / 1000;
    this.energy = clamp(this.energy + this.stats.energyRegen * dt, 0, this.maxEnergy);
    if (sinceHit > PLAYER_CONFIG.regenDelay) {
      this.hp = clamp(this.hp + this.stats.regen * dt, 0, this.maxHp);
    }
    if (now < this.regenerationBoostUntil) {
      this.hp = clamp(this.hp + this.regenerationBoost * dt, 0, this.maxHp);
    }
    if (this.context?.fields.covers(this.x, this.y, true)) {
      this.hp = clamp(this.hp + 4 * dt, 0, this.maxHp);
    }

    // Actions.
    if (this.playerInput.dash && now >= this.dashReadyAt) this.performDash();

    if (this.playerInput.skill) this.useSkill();
    if (this.playerInput.ultimate) this.useUltimate();
    if (this.playerInput.attack) {
      if (this.attackHeldSince === 0) this.attackHeldSince = now;
      if (now - this.attackHeldSince > 60) this.tryAttack();
    } else {
      this.attackHeldSince = 0;
    }

    // Invulnerability flicker.
    if (now < this.invulnUntil) {
      const visible = Math.floor(now / 60) % 2 === 0;
      this.setAlpha(visible ? 0.45 : 0.9);
    } else if (this.alpha !== 1) {
      this.setAlpha(1);
    }

    if (this.hp <= 0) this.die();
  }

  private spawnDashTrail(deltaMs: number): void {
    this.trailTimer -= deltaMs;
    if (this.trailTimer > 0) return;
    this.trailTimer = DASH_CONFIG.trailIntervalMs;
    const element = this.activeElement;
    const color = element ? ELEMENT_REGISTRY[element].colorInt : 0xffffff;
    const context = this.context;
    if (!context) return;
    context.fx.hitSpark(this.x, this.y, color, 0.5, 'streak');
    const puff = this.scene.add
      .image(Math.round(this.x), Math.round(this.y), this.texture.key)
      .setDepth(43)
      .setTint(color)
      .setAlpha(0.5)
      .setFlipX(this.flipX);
    this.scene.tweens.add({
      targets: puff,
      alpha: 0,
      duration: 220,
      onComplete: () => puff.destroy(),
    });
  }

  performDash(): void {
    const now = this.now();
    const angle = Math.atan2(this.playerInput.moveY, this.playerInput.moveX);
    this.dashAngle = Math.abs(this.playerInput.moveX) + Math.abs(this.playerInput.moveY) > 0.05
      ? angle
      : Math.atan2(this.playerInput.aimY - this.y, this.playerInput.aimX - this.x);
    this.dashUntil = now + DASH_CONFIG.duration * 1000;
    this.dashReadyAt = now + DASH_CONFIG.cooldown * 1000;
    this.invulnUntil = Math.max(this.invulnUntil, now + DASH_CONFIG.invulnMs);
    this.statuses.pendingImpulse = 0;
    sfx('dash');
    this.events.onDash?.();
    this.context?.fx.ring(this.x, this.y, this.activeElement ? ELEMENT_REGISTRY[this.activeElement].colorInt : 0xffffff, 14, 0.25);
  }

  private currentAim(): { angle: number; x: number; y: number } {
    const useAuto = !this.playerInput.aiming;
    if (useAuto && this.context) {
      const nearest = this.findNearestEnemy(160);
      if (nearest) {
        return { angle: Math.atan2(nearest.y - this.y, nearest.x - this.x), x: nearest.x, y: nearest.y };
      }
      const body = this.body as Phaser.Physics.Arcade.Body;
      if (body.velocity.lengthSq() > 4) {
        return { angle: Math.atan2(body.velocity.y, body.velocity.x), x: this.x, y: this.y };
      }
    }
    const dx = this.playerInput.aimX - this.x;
    const dy = this.playerInput.aimY - this.y;
    const angle = Math.hypot(dx, dy) < 2 ? 0 : Math.atan2(dy, dx);
    return { angle, x: this.playerInput.aimX, y: this.playerInput.aimY };
  }

  private findNearestEnemy(range: number): Phaser.GameObjects.Sprite | null {
    if (!this.context) return null;
    let best: Phaser.GameObjects.Sprite | null = null;
    let bestDistance = range;
    for (const child of this.context.enemies.getChildren() as Phaser.GameObjects.Sprite[]) {
      if (!child.active) continue;
      const distance = Phaser.Math.Distance.Between(this.x, this.y, child.x, child.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = child;
      }
    }
    return best;
  }

  /** Basic attack — behaviour depends entirely on the active element. */
  tryAttack(): void {
    const context = this.context;
    const element = this.activeElement;
    if (!context || !element || !this.alive) return;
    if (this.statuses.attackDisabled()) return;
    const now = this.now();
    const def = ELEMENT_REGISTRY[element];
    const spec = def.attack;
    const cooldownMs = effectiveCooldown(spec.cooldown, this.stats, element, 'attack') * 1000;
    if (now < this.attackReadyAt) return;
    const cost = effectiveCost(spec.energyCost * ENERGY_CONFIG.basicAttackCostMultiplier, this.stats, element, 'attack');
    if (cost > this.energy) return;

    this.attackReadyAt = now + cooldownMs;
    this.energy = clamp(this.energy - cost, 0, this.maxEnergy);

    const aim = this.currentAim();
    /* One crit roll per cast, folded into the multiplier so every pellet of a volley
       carries it. Support casts roll separately (and never crit — see castSupport). */
    const crit = rollCrit(this.stats);
    const damageMult = elementDamageMultiplier(this.stats, element) * spec.damageMultiplier * crit.damageMult;

    this.executeAttack(spec, element, aim.angle, damageMult, context, crit.isCrit, false);
    sfx('attack', { rate: 1 + Math.random() * 0.15 });
    this.events.onAttack?.(element);
  }

  private executeAttack(
    spec: AttackSpec,
    element: ElementId,
    angle: number,
    damageMult: number,
    context: CombatContext,
    isCrit = false,
    auto = false,
  ): void {
    const def = ELEMENT_REGISTRY[element];
    const color = def.colorInt;
    const damage = this.stats.attack * damageMult;
    const statuses = spec.onHit;

    const projectile = spec.projectile;
    if (projectile) {
      const count = projectile.count ?? 1;
      const spread = Phaser.Math.DegToRad(projectile.spreadDeg ?? 0);
      for (let i = 0; i < count; i += 1) {
        const offset = count === 1 ? 0 : -spread / 2 + (spread / (count - 1)) * i;
        context.playerProjectiles.fire({
          x: this.x + Math.cos(angle) * 6,
          y: this.y + Math.sin(angle) * 6,
          angle: angle + offset + (Math.random() - 0.5) * 0.02,
          speed: projectile.speed,
          damage,
          isCrit,
          auto,
          owner: 'player',
          element,
          vfx: spec.vfx,
          color,
          radius: projectile.radius,
          lifetime: projectile.lifetime / 1000,
          pierce: projectile.pierce,
          chain: projectile.chain ?? 0,
          homing: projectile.homing ?? 0,
          knockback: spec.knockback,
          statuses,
          explodeRadius: projectile.explodeRadius ?? 0,
          explodeDamageMult: projectile.explodeDamageMult ?? 1,
          trailField: projectile.trailField,
          destroysEnemyProjectiles: projectile.destroysEnemyProjectiles ?? false,
          boomerang: projectile.boomerang ?? false,
        });
      }
    }

    if (spec.kind === 'melee' || spec.kind === 'aura' || spec.kind === 'shockwave') {
      const radius = spec.aoeRadius;
      context.damageArea({
        x: this.x + Math.cos(angle) * (spec.kind === 'melee' ? 16 : 0),
        y: this.y + Math.sin(angle) * (spec.kind === 'melee' ? 16 : 0),
        radius,
        damage,
        element,
        vfx: spec.vfx,
        color,
        statuses,
        knockback: spec.knockback,
        friendly: true,
        isCrit,
        auto,
      });
      context.fx.ring(this.x, this.y, color, radius, 0.22);
      if (spec.kind === 'melee') {
        const slash = this.scene.add
          .image(Math.round(this.x + Math.cos(angle) * 12), Math.round(this.y + Math.sin(angle) * 12), 'fx_ring')
          .setTint(color)
          .setDepth(46)
          .setAlpha(0.8)
          .setScale(1.4);
        this.scene.tweens.add({
          targets: slash,
          alpha: 0,
          scale: 2.4,
          duration: 180,
          onComplete: () => slash.destroy(),
        });
      }
    }

    if (spec.shieldOnCast) this.addShield(spec.shieldOnCast);
    if (spec.castImpulse) {
      const body = this.body as Phaser.Physics.Arcade.Body;
      body.velocity.x += Math.cos(angle) * spec.castImpulse;
      body.velocity.y += Math.sin(angle) * spec.castImpulse;
    }
    if (spec.healOnHit) {
      this.heal(spec.healOnHit * 3);
    }
  }

  /**
   * §: a support element, fired by the rig rather than by the player.
   *
   * Same attack definition, same reactions, same status applications — the only
   * differences are the damage fraction and the aim: `accuracy` 1 means the cast
   * is put on the target, 0.5 (the mastery-1 base) throws it off by up to half a
   * projectile arc. Energy is deliberately not spent, so five supporting
   * elements never tax the one the player is steering.
   */
  castSupport(element: ElementId, target: AutoCastTarget | null, accuracy: number): boolean {
    const context = this.context;
    if (!AUTO_CAST.enabled || !context || !this.alive) return false;
    if (this.statuses.attackDisabled()) return false;
    const def = ELEMENT_REGISTRY[element];
    const spec = def.attack;
    const aimed = target
      ? Math.atan2(target.y - this.y, target.x - this.x)
      : this.currentAim().angle;
    const confidence = Math.max(0, Math.min(1, accuracy));
    const sloppiness = (1 - confidence) * (spec.kind === 'projectile' ? 0.55 : 0.95);
    const spread = sloppiness === 0 ? 0 : (Math.random() * 2 - 1) * sloppiness;
    const damageMult =
      elementDamageMultiplier(this.stats, element) * spec.damageMultiplier * AUTO_CAST.damageFraction;
    // `auto: true` is what keeps the rig from paying itself: no energy on hit, no
    // lifesteal, no crit roll. It still reacts, still applies statuses, still counts.
    this.executeAttack(spec, element, aimed + spread, damageMult, context, false, true);
    sfx('attack', { rate: 1.18 });
    return true;
  }

  /* ---------------------- abilities ---------------------- */

  useSkill(): void {
    const context = this.context;
    const element = this.activeElement;
    if (!context || !element || !this.alive) return;
    const spec = ELEMENT_REGISTRY[element].skill;
    const now = this.now();
    if (now < this.skillReadyAt) return;
    const cost = effectiveCost(spec.energyCost, this.stats, element, 'skill');
    if (this.energy < cost) {
      sfx('ui_deny', { gain: 0.4 });
      return;
    }
    this.energy -= cost;
    this.skillReadyAt = now + effectiveCooldown(spec.cooldown, this.stats, element, 'skill') * 1000;
    this.castAbility(spec, element, context, false);
    sfx('skill');
    this.events.onSkill?.(element);
  }

  useUltimate(): void {
    const context = this.context;
    const element = this.activeElement;
    if (!context || !element || !this.alive) return;
    const spec = ELEMENT_REGISTRY[element].ultimate;
    const now = this.now();
    if (now < this.ultimateReadyAt) return;
    const cost = effectiveCost(spec.energyCost, this.stats, element, 'ultimate');
    if (this.energy < cost) {
      sfx('ui_deny', { gain: 0.4 });
      return;
    }
    this.energy -= cost;
    this.ultimateReadyAt = now + effectiveCooldown(spec.cooldown, this.stats, element, 'ultimate') * 1000;
    this.castAbility(spec, element, context, true);
    sfx('ultimate');
    context.fx.zoomPunch(0.09);
    context.fx.shake('heavy');
    this.events.onUltimate?.(element);
  }

  private castAbility(spec: AbilitySpec, element: ElementId, context: CombatContext, isUltimate: boolean): void {
    const def = ELEMENT_REGISTRY[element];
    const color = def.colorInt;
    const aim = this.currentAim();
    const damageMult = elementDamageMultiplier(this.stats, element) * spec.damageMultiplier;
    const crit = rollCrit(this.stats);
    const damage = this.stats.attack * damageMult * crit.damageMult;
    const count = spec.count ?? 1;

    switch (spec.kind) {
      case 'nova':
      case 'overload': {
        context.fx.ring(this.x, this.y, color, spec.radius, 0.45, isUltimate ? 2 : 1);
        context.fx.hitSpark(this.x, this.y, color, isUltimate ? 2.4 : 1.4, spec.vfx);
        context.damageArea({
          x: this.x,
          y: this.y,
          radius: spec.radius,
          damage,
          element,
          vfx: spec.vfx,
          color,
          statuses: spec.statuses,
          knockback: spec.knockback,
          friendly: true,
          isCrit: crit.isCrit,
        });
        break;
      }
      case 'field': {
        context.addField({
          x: this.x,
          y: this.y,
          radius: spec.radius,
          dps: (damage * (spec.dpsMultiplier ?? 0.6)) / Math.max(0.5, spec.duration),
          duration: spec.duration,
          element,
          vfx: spec.vfx,
          color,
          statuses: spec.statuses,
          friendly: true,
        });
        context.damageArea({
          x: this.x,
          y: this.y,
          radius: spec.radius,
          damage: damage * 0.6,
          element,
          vfx: spec.vfx,
          color,
          statuses: spec.statuses,
          knockback: 0,
          friendly: true,
          isCrit: crit.isCrit,
        });
        break;
      }
      case 'storm': {
        context.addField({
          x: this.x,
          y: this.y,
          radius: spec.radius,
          dps: (damage * (spec.dpsMultiplier ?? 1.2)) / Math.max(0.5, spec.duration),
          duration: spec.duration,
          element,
          vfx: spec.vfx,
          color,
          statuses: spec.statuses,
          friendly: true,
          followPlayer: !isUltimate,
          pull: spec.knockback < 0 ? spec.knockback : 0,
        });
        // Random bolts inside the storm for readability.
        for (let i = 0; i < Math.min(12, count); i += 1) {
          const angle = Math.random() * Math.PI * 2;
          const distance = Math.random() * spec.radius;
          const x = this.x + Math.cos(angle) * distance;
          const y = this.y + Math.sin(angle) * distance;
          this.scene.time.delayedCall(i * 90, () => {
            if (!this.alive) return;
            context.fx.ring(x, y, color, 16, 0.3);
            context.damageArea({
              x,
              y,
              radius: 26,
              damage: damage * 0.28,
              element,
              vfx: spec.vfx,
              color,
              statuses: spec.statuses,
              knockback: 0,
              friendly: true,
              maxTargets: 4,
              isCrit: crit.isCrit,
            });
          });
        }
        break;
      }
      case 'bolt': {
        const targets = this.nearestEnemies(count, spec.radius * 3);
        for (let i = 0; i < count; i += 1) {
          const target = targets[i];
          const tx = target ? target.x : this.x + Math.cos(aim.angle) * spec.radius;
          const ty = target ? target.y : this.y + Math.sin(aim.angle) * spec.radius;
          context.fx.ring(tx, ty, color, 20, 0.3);
          context.fx.hitSpark(tx, ty, color, 1.4, spec.vfx);
          context.damageArea({
            x: tx,
            y: ty,
            radius: 26,
            damage,
            element,
            vfx: spec.vfx,
            color,
            statuses: spec.statuses,
            knockback: spec.knockback,
            friendly: true,
            maxTargets: 4,
            isCrit: crit.isCrit,
          });
        }
        break;
      }
      case 'beam': {
        const spread = Phaser.Math.DegToRad(isUltimate ? 18 : 8);
        for (let i = 0; i < count; i += 1) {
          const offset = count === 1 ? 0 : -spread / 2 + (spread / (count - 1)) * i;
          context.playerProjectiles.fire({
            x: this.x + Math.cos(aim.angle) * 6,
            y: this.y + Math.sin(aim.angle) * 6,
            angle: aim.angle + offset,
            speed: 380,
            damage,
            owner: 'player',
            element,
            vfx: spec.vfx,
            color,
            radius: 5,
            lifetime: 1.1,
            pierce: 8,
            chain: 0,
            homing: 0,
            knockback: spec.knockback,
            statuses: spec.statuses,
            explodeRadius: 0,
            explodeDamageMult: 1,
            destroysEnemyProjectiles: true,
            boomerang: false,
            heavy: true,
            isCrit: crit.isCrit,
          });
        }
        break;
      }
      case 'shield': {
        this.addShield(spec.shield ?? 24);
        if (spec.heal) this.heal(spec.heal);
        context.fx.ring(this.x, this.y, color, spec.radius, 0.6, 2);
        context.damageArea({
          x: this.x,
          y: this.y,
          radius: spec.radius,
          damage,
          element,
          vfx: spec.vfx,
          color,
          statuses: spec.statuses,
          knockback: spec.knockback,
          friendly: true,
          isCrit: crit.isCrit,
        });
        break;
      }
      case 'healField': {
        this.heal(spec.heal ?? 30);
        this.regenerationBoost = 5;
        this.regenerationBoostUntil = this.now() + spec.duration * 1000;
        context.addField({
          x: this.x,
          y: this.y,
          radius: spec.radius,
          dps: (damage * (spec.dpsMultiplier ?? 1)) / Math.max(0.5, spec.duration),
          duration: spec.duration,
          element,
          vfx: spec.vfx,
          color,
          statuses: spec.statuses,
          friendly: true,
          followPlayer: !isUltimate,
        });
        context.fx.ring(this.x, this.y, color, spec.radius, 0.8, 2);
        break;
      }
      case 'dashStrike': {
        const body = this.body as Phaser.Physics.Arcade.Body;
        const angle = Math.abs(this.playerInput.moveX) + Math.abs(this.playerInput.moveY) > 0.05
          ? Math.atan2(this.playerInput.moveY, this.playerInput.moveX)
          : aim.angle;
        body.velocity.setTo(Math.cos(angle) * 300, Math.sin(angle) * 300);
        this.invulnUntil = Math.max(this.invulnUntil, this.now() + spec.duration * 1000);
        this.dashUntil = this.now() + spec.duration * 1000;
        this.dashAngle = angle;
        context.damageArea({
          x: this.x + Math.cos(angle) * 24,
          y: this.y + Math.sin(angle) * 24,
          radius: spec.radius,
          damage,
          element,
          vfx: spec.vfx,
          color,
          statuses: spec.statuses,
          knockback: spec.knockback,
          friendly: true,
          isCrit: crit.isCrit,
        });
        break;
      }
      case 'pull': {
        context.damageArea({
          x: this.x,
          y: this.y,
          radius: spec.radius,
          damage,
          element,
          vfx: spec.vfx,
          color,
          statuses: spec.statuses,
          knockback: 0,
          friendly: true,
          isCrit: crit.isCrit,
        });
        context.addField({
          x: this.x,
          y: this.y,
          radius: spec.radius,
          dps: 0.0001,
          duration: spec.duration,
          element,
          vfx: spec.vfx,
          color,
          friendly: true,
          pull: spec.knockback,
        });
        context.fx.ring(this.x, this.y, color, spec.radius, 0.7, 2);
        break;
      }
      case 'eruption':
        context.eruption({
          count,
          radius: spec.radius,
          spread: isUltimate ? 150 : 100,
          damage,
          element,
          vfx: spec.vfx,
          color,
          statuses: spec.statuses,
          knockback: spec.knockback,
          origin: { x: this.x, y: this.y },
          aimAngle: aim.angle,
          followPlayer: false,
        });
        break;
      default: {
        context.damageArea({
          x: this.x,
          y: this.y,
          radius: spec.radius,
          damage,
          element,
          vfx: spec.vfx,
          color,
          statuses: spec.statuses,
          knockback: spec.knockback,
          friendly: true,
          isCrit: crit.isCrit,
        });
        break;
      }
    }

    if (spec.shield) this.addShield(spec.shield);
  }

  private nearestEnemies(count: number, range: number): Phaser.GameObjects.Sprite[] {
    if (!this.context) return [];
    const list = (this.context.enemies.getChildren() as Phaser.GameObjects.Sprite[])
      .filter((child) => child.active)
      .map((child) => ({ child, distance: Phaser.Math.Distance.Between(this.x, this.y, child.x, child.y) }))
      .filter((entry) => entry.distance <= range)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, count)
      .map((entry) => entry.child);
    return list;
  }

  /* ---------------------- resource handling ---------------------- */

  addShield(amount: number): void {
    if (amount <= 0) return;
    this.shield = Math.min(this.maxHp * 0.6, this.shield + amount);
    const element = this.activeElement;
    this.context?.fx.callout(
      this.x,
      this.y - 12,
      'SHIELD',
      element ? ELEMENT_REGISTRY[element].color : '#E8EDF7',
      7,
    );
  }

  /** Heals and reports how much actually landed, so a full bar can say so. */
  heal(amount: number): number {
    if (amount <= 0 || !this.alive) return 0;
    const before = this.hp;
    this.hp = clamp(this.hp + amount, 0, this.maxHp);
    const healed = this.hp - before;
    if (healed > 0.5) {
      this.context?.fx.healNumber(this.x, this.y - 10, healed);
      this.events.onHeal?.(healed);
    }
    return healed;
  }

  /** Same contract as `heal`: the caller learns whether the bar had room. */
  addEnergy(amount: number): number {
    if (amount <= 0) return 0;
    const before = this.energy;
    this.energy = clamp(this.energy + amount, 0, this.maxEnergy);
    const gained = this.energy - before;
    if (gained > 1) this.context?.fx.energyNumber(this.x, this.y - 14, gained);
    return gained;
  }

  /**
   * Called by the combat system whenever this player deals damage.
   *
   * `auto` marks the support rig's casts. They still feed every counter and every
   * achievement, but they do not pay out energy or lifesteal: five free-firing
   * elements were worth +4 energy a second on a 7/s base, which turned the skill
   * budget into a formality and made the lifesteal ladder six times as loud as the
   * player's own shot.
   */
  onDealtDamage(amount: number, isCrit: boolean, isBoss: boolean, auto = false): void {
    if (!auto) {
      if (this.stats.lifesteal > 0) this.heal(amount * this.stats.lifesteal);
      this.energy = clamp(this.energy + PLAYER_CONFIG.energyOnHit, 0, this.maxEnergy);
    }
    this.events.onDamageDealt?.(amount, isCrit, isBoss);
  }

  /** Damage over time from statuses — bypasses i-frames so dots keep ticking. */
  applyStatusDamage(amount: number, statusId: string): void {
    if (!this.alive || amount <= 0) return;
    const color = statusId === 'poison' ? '#9CE65A' : '#FF9A5C';
    this.hp = clamp(this.hp - amount, 0, this.maxHp);
    this.context?.fx.damageNumber(this.x, this.y - 4, amount, false, color);
    if (this.hp <= 0) this.die();
  }

  /* ---------------------- damage + death ---------------------- */

  takeDamage(packet: DamagePacket): number {
    const now = this.now();
    if (!this.alive) return 0;
    if (now < this.invulnUntil) return 0;
    if (this.stats.evasion > 0 && Math.random() < this.stats.evasion) {
      this.context?.fx.callout(this.x, this.y - 12, 'EVADE', '#C9E7FF', 7);
      this.invulnUntil = now + 220;
      return 0;
    }

    const armorBroken = packet.pure ? 0 : this.stats.defense;
    const mitigated = packet.pure ? packet.amount : mitigate(packet.amount, armorBroken / (armorBroken + 26));
    let remaining = mitigated;

    if (this.shield > 0) {
      const absorbed = Math.min(this.shield, remaining);
      this.shield -= absorbed;
      remaining -= absorbed;
      if (absorbed > 0) this.context?.fx.callout(this.x, this.y - 12, 'BLOCK', '#B39DF2', 7);
    }

    this.hp = clamp(this.hp - remaining, 0, this.maxHp);
    this.lastHitAt = now;
    this.invulnUntil = now + PLAYER_CONFIG.invulnMs;

    // Thorns reflect.
    if (this.stats.thorns > 0 && packet.sourceX !== undefined) {
      this.context?.damageArea({
        x: this.x,
        y: this.y,
        radius: 30,
        damage: mitigated * this.stats.thorns,
        element: null,
        vfx: 'crystal',
        color: 0xb39df2,
        friendly: true,
        knockback: 0,
        maxTargets: 2,
      });
    }

    if (remaining > 0) {
      pulse('hurt');
      this.context?.fx.damageNumber(this.x, this.y - 8, remaining, false, '#FF5C6C');
      this.context?.fx.shake(remaining > 12 ? 'medium' : 'light');
      this.setTintFill(0xff5c6c);
      this.scene.time.delayedCall(90, () => {
        if (this.active) this.clearTint();
      });
      this.events.onDamageTaken?.(remaining);
      sfx('hit', { gain: 0.8 });
    }

    // Apply incoming statuses.
    for (const status of packet.statuses) this.statuses.apply(status);

    if (this.hp <= 0) this.die();
    return remaining;
  }

  die(): void {
    if (!this.alive) return;
    this.alive = false;
    this.hp = 0;
    const body = this.body as Phaser.Physics.Arcade.Body;
    body.stop();
    body.enable = false;
    this.auraSprite.setVisible(false);
    const color = this.activeElement ? ELEMENT_REGISTRY[this.activeElement].colorInt : 0xff5c6c;
    this.context?.fx.deathBurst(this.x, this.y, color, 1.4);
    this.setTint(0x555555);
    this.scene.tweens.add({
      targets: this,
      alpha: 0.25,
      angle: 90,
      duration: 420,
      ease: 'Quad.easeOut',
    });
    sfx('death');
    this.events.onDeath?.();
  }

  respawn(x: number, y: number): void {
    this.alive = true;
    this.hp = this.maxHp;
    this.energy = this.maxEnergy;
    this.shield = 0;
    this.statuses.clear();
    this.invulnUntil = this.now() + 1600;
    this.setAlpha(1).setAngle(0).clearTint();
    this.setPosition(x, y);
    const body = this.body as Phaser.Physics.Arcade.Body;
    body.enable = true;
    body.reset(x, y);
    this.auraSprite.setVisible(true);
    this.context?.fx.ring(x, y, 0xf2c96b, 40, 0.7, 2);
    this.refreshTexture();
  }

  switchElement(slot: number): boolean {
    const element = this.slots[slot];
    if (!element) return false;
    if (slot === this.activeSlot) return false;
    const now = this.now();
    if (now < this.switchReadyAt) return false;
    this.switchReadyAt = now + 320;
    this.activeSlot = slot;
    pulse('switch');
    const def = ELEMENT_REGISTRY[element];
    this.refreshTexture();
    this.context?.fx.ring(this.x, this.y, def.colorInt, 26, 0.4, 1.4);
    this.context?.fx.hitSpark(this.x, this.y, def.colorInt, 1.6, def.attack.vfx, ELEMENT_FAMILY[element]);
    // Colour wash + a one-frame camera push: the switch is felt, not read.
    this.context?.fx.elementShift(def.colorInt);
    // A vertical pop: the body visibly changes gear with the element.
    this.context?.fx.squash(this, 0.16, -Math.PI / 2);
    sfx('element_switch');
    // Shield on switch: its own stat, its own trigger, no discount. The number used
    // to be `shieldOnWave × 0.25`, which borrowed a resonance's name, halved it in
    // silence and paid out on a keypress (docs §B5a).
    if (this.stats.shieldOnSwitch > 0) this.addShield(this.stats.shieldOnSwitch);
    return true;
  }

  cycleElement(direction: 1 | -1): boolean {
    const filled = this.slots
      .map((element, index) => ({ element, index }))
      .filter((entry) => Boolean(entry.element));
    if (filled.length <= 1) return false;
    const currentPosition = filled.findIndex((entry) => entry.index === this.activeSlot);
    const nextPosition = (currentPosition + direction + filled.length) % filled.length;
    return this.switchElement(filled[nextPosition].index);
  }

  get pickupRadius(): number {
    /* Floor plus *bonus*, not max(): `Math.max(magnetRadius, stats.pickupRadius)` made
       every pickup-radius bonus up to +4 worth exactly nothing, while the stat screen
       still reported the unfloored number (docs §B10). */
    return PICKUP_CONFIG.magnetRadius + Math.max(0, this.stats.pickupRadius - PLAYER_CONFIG.pickupRadius);
  }

  get invulnerable(): boolean {
    return this.scene.time.now < this.invulnUntil;
  }

  get isDashing(): boolean {
    return this.scene.time.now < this.dashUntil;
  }

  /** Contact damage tick for enemies that touch the player. */
  contactDamage(amount: number, sourceX: number, sourceY: number, statuses: StatusApplication[]): void {
    const now = this.now();
    if (now < this.contactCooldownAt) return;
    this.contactCooldownAt = now + COMBAT_CONFIG.hitFlashMs * 6;
    const angle = Math.atan2(this.y - sourceY, this.x - sourceX);
    const body = this.body as Phaser.Physics.Arcade.Body;
    body.velocity.x += Math.cos(angle) * 70;
    body.velocity.y += Math.sin(angle) * 70;
    this.takeDamage({
      amount,
      isCrit: false,
      element: null,
      vfx: 'spark',
      damageType: 'physical',
      statuses,
      knockback: 0,
      source: 'enemy',
      sourceX,
      sourceY,
    });
  }
}

export const PLAYER_TEXTURE_PREFIX = 'player_';
