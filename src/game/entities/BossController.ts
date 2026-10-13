import Phaser from 'phaser';
import { ELEMENT_REGISTRY } from '@/data/elements';
import type { CombatContext } from '@/game/combat/context';
import type { Enemy } from '@/game/entities/Enemy';
import type { AttackPatternStep, BossDef, BossPhase, VfxStyleId } from '@/types';
import { clamp } from '@/utils/math';

/**
 * BossController.
 *
 * Reusable boss architecture: phases are HP thresholds, each phase holds a
 * weighted pool of telegraphed attack patterns, and this module is the single
 * place that turns a chosen pattern into projectiles, fields and eruptions.
 *
 * Adding a boss = adding data. Adding a *new mechanic* = adding one case here,
 * which every boss can then use.
 */

export interface BossRuntimeState {
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

/** Weighted pattern selection for the current phase. */
export function selectPattern(phase: BossPhase): AttackPatternStep | null {
  if (phase.patterns.length === 0) return null;
  const total = phase.patterns.reduce((sum, step) => sum + Math.max(0, step.weight), 0);
  if (total <= 0) return phase.patterns[0];
  let roll = Math.random() * total;
  for (const step of phase.patterns) {
    roll -= Math.max(0, step.weight);
    if (roll <= 0) return step;
  }
  return phase.patterns[phase.patterns.length - 1];
}

export function executeBossPattern(
  enemy: Enemy,
  context: CombatContext,
  boss: BossRuntimeState,
  phase: BossPhase,
  aimAngle: number,
): void {
  const pending = boss.pendingPattern;
  if (!pending) return;
  const params = pending.params;
  const damage = enemy.damage * phase.damageMult * (params.damage ?? 1);
  const color = enemy.def.colorInt;
  const element = enemy.def.element;
  const vfx: VfxStyleId = ELEMENT_REGISTRY[element].attack.vfx;
  const targetAngle = Math.atan2(context.player.y - enemy.y, context.player.x - enemy.x);

  const fireEnemyShot = (angle: number, speed: number, shotDamage: number, radius = 4, lifetime = 3): void => {
    context.enemyProjectiles.fire({
      x: enemy.x,
      y: enemy.y,
      angle,
      speed,
      damage: shotDamage,
      owner: 'enemy',
      element,
      vfx,
      color,
      radius,
      lifetime,
      pierce: 0,
      chain: 0,
      homing: 0,
      knockback: 0,
      statuses: [],
      explodeRadius: 0,
      explodeDamageMult: 1,
      destroysEnemyProjectiles: false,
      boomerang: false,
    });
  };

  switch (pending.pattern) {
    case 'radialBurst': {
      const count = params.count ?? 12;
      const speed = params.speed ?? 100;
      for (let i = 0; i < count; i += 1) {
        fireEnemyShot((i / count) * Math.PI * 2, speed, damage * 0.7);
      }
      break;
    }
    case 'spiral': {
      const count = params.count ?? 16;
      const speed = params.speed ?? 96;
      const spin = params.spin ?? 40;
      for (let i = 0; i < count; i += 1) {
        fireEnemyShot(aimAngle + (i * (spin * Math.PI)) / 180, speed * (1 + i * 0.02), damage * 0.6, 3.5, 4);
      }
      break;
    }
    case 'chargeDash': {
      const speed = params.speed ?? 240;
      enemy.beginCharge(targetAngle, 520, speed);
      for (let i = 1; i <= 5; i += 1) {
        const px = enemy.x + Math.cos(targetAngle) * i * 22;
        const py = enemy.y + Math.sin(targetAngle) * i * 22;
        if (Phaser.Math.Distance.Between(px, py, context.player.x, context.player.y) < 24) {
          context.player.takeDamage({
            amount: damage,
            isCrit: false,
            element,
            vfx,
            damageType: 'elemental',
            statuses: [],
            knockback: 0,
            source: 'boss',
            sourceX: enemy.x,
            sourceY: enemy.y,
          });
          context.fx.hitSpark(px, py, color, 1.2, vfx);
          break;
        }
      }
      break;
    }
    case 'summonMinions': {
      const count = params.count ?? 3;
      const defId = boss.def.minionDefId ?? 'cinder_chaser';
      for (let i = 0; i < count; i += 1) {
        const angle = (i / count) * Math.PI * 2;
        context.spawnEnemy(defId, enemy.x + Math.cos(angle) * 36, enemy.y + Math.sin(angle) * 36, {
          portal: true,
        });
      }
      break;
    }
    case 'beamSweep': {
      const sweep = Phaser.Math.DegToRad(params.sweep ?? 80);
      const steps = 7;
      for (let i = 0; i < steps; i += 1) {
        const angle = targetAngle - sweep / 2 + (sweep / Math.max(1, steps - 1)) * i;
        context.scene.time.delayedCall(i * 90, () => {
          if (!enemy.active) return;
          for (let d = 24; d <= 200; d += 24) {
            context.fx.hitSpark(enemy.x + Math.cos(angle) * d, enemy.y + Math.sin(angle) * d, color, 0.45, vfx);
          }
          context.damageArea({
            x: enemy.x + Math.cos(angle) * 110,
            y: enemy.y + Math.sin(angle) * 110,
            radius: 42,
            damage: damage * 0.8,
            element,
            vfx,
            color,
            friendly: false,
          });
        });
      }
      break;
    }
    case 'shockwaveRing': {
      const radius = params.radius ?? 86;
      context.fx.ring(enemy.x, enemy.y, color, radius, 0.55, 2);
      context.damageArea({
        x: enemy.x,
        y: enemy.y,
        radius,
        damage,
        element,
        vfx,
        color,
        friendly: false,
      });
      break;
    }
    case 'teleportStrike': {
      const bounds = context.scene.physics.world.bounds;
      const angle = Math.random() * Math.PI * 2;
      const distance = 60 + Math.random() * 60;
      const nx = clamp(context.player.x + Math.cos(angle) * distance, bounds.x + 24, bounds.right - 24);
      const ny = clamp(context.player.y + Math.sin(angle) * distance, bounds.y + 24, bounds.bottom - 24);
      context.fx.deathBurst(enemy.x, enemy.y, color, 0.8);
      enemy.setPosition(nx, ny);
      (enemy.body as Phaser.Physics.Arcade.Body).reset(nx, ny);
      context.fx.deathBurst(nx, ny, color, 0.8);
      context.damageArea({
        x: nx,
        y: ny,
        radius: params.radius ?? 46,
        damage,
        element,
        vfx,
        color,
        friendly: false,
      });
      break;
    }
    case 'eruptionField': {
      context.eruption({
        count: params.count ?? 6,
        radius: params.radius ?? 34,
        spread: 360,
        damage: damage * 0.9,
        element,
        vfx,
        color,
        origin: { x: enemy.x, y: enemy.y },
        aimAngle: targetAngle,
        followPlayer: true,
        telegraphMs: 620,
        delayMs: 220,
      });
      break;
    }
    case 'coneSpray': {
      const count = params.count ?? 6;
      const spread = Phaser.Math.DegToRad(params.spread ?? 46);
      const speed = params.speed ?? 110;
      for (let i = 0; i < count; i += 1) {
        const angle = targetAngle - spread / 2 + (spread / Math.max(1, count - 1)) * i;
        fireEnemyShot(angle, speed, damage * 0.75, 4, 2.6);
      }
      break;
    }
    case 'orbitSweep': {
      const count = params.count ?? 10;
      const radius = params.radius ?? 70;
      const speed = params.speed ?? 120;
      for (let i = 0; i < count; i += 1) {
        const angle = (i / count) * Math.PI * 2;
        const x = enemy.x + Math.cos(angle) * radius;
        const y = enemy.y + Math.sin(angle) * radius;
        context.enemyProjectiles.fire({
          x,
          y,
          angle: Math.atan2(y - enemy.y, x - enemy.x),
          speed,
          damage: damage * 0.6,
          owner: 'enemy',
          element,
          vfx,
          color,
          radius: 4,
          lifetime: 2.2,
          pierce: 0,
          chain: 0,
          homing: 0,
          knockback: 0,
          statuses: [],
          explodeRadius: 0,
          explodeDamageMult: 1,
          destroysEnemyProjectiles: false,
          boomerang: false,
        });
      }
      break;
    }
    case 'shieldPulse': {
      const gain = params.shield ?? 60;
      enemy.maxShield = Math.max(enemy.maxShield, enemy.shield + gain);
      enemy.shield = Math.min(enemy.maxShield, enemy.shield + gain);
      context.fx.ring(enemy.x, enemy.y, color, 56, 0.6, 2);
      context.damageArea({
        x: enemy.x,
        y: enemy.y,
        radius: 56,
        damage: damage * 0.7,
        element,
        vfx,
        color,
        friendly: false,
      });
      break;
    }
    default:
      break;
  }

  boss.pendingPattern = null;
}

/** Arena rules activate when a boss drops below a phase threshold. */
export function arenaRuleFor(boss: BossDef, hpRatio: number) {
  for (let i = boss.phases.length - 1; i >= 0; i -= 1) {
    const rule = boss.phases[i].arenaRule;
    if (rule && hpRatio <= boss.phases[i].hpThreshold) return rule;
  }
  return null;
}
