import Phaser from 'phaser';
import { findReaction, type ReactionDef } from '@/data/elements/reactions';
import { sfx } from '@/game/systems/audio';
import type { CombatContext } from '@/game/combat/context';
import type { Enemy } from '@/game/entities/Enemy';
import type { ElementId, StatusId } from '@/types';
import { hexToInt } from '@/utils/color';

/**
 * Reaction resolution.
 *
 * One entry point, called from the damage path of every entity. It reads the
 * element of the incoming hit and the statuses the victim already carried, asks
 * the data table what that combination means, and then performs it: consume the
 * inputs, apply the output, pay the burst, draw the feedback, spawn whatever
 * field or chain the rule defines.
 *
 * Because both the trigger and the result are data, an enemy bolt that shocks a
 * wet target sets off the same Electrified Water as the player's lightning would
 * — the world has rules, the player just knows them.
 */

export interface ReactionArgs {
  context: CombatContext;
  victim: Enemy;
  /** Damage the triggering hit actually dealt, after mitigation. */
  amount: number;
  element: ElementId | null;
  sourceX: number;
  sourceY: number;
  /**
   * Statuses the victim carried *before* this hit landed. The resolver must not
   * read the live list, or an attack that applies Burn would set off every
   * Burn-based reaction on its own impact.
   */
  carriedStatuses: StatusId[];
}

export function resolveReaction(args: ReactionArgs): ReactionDef | null {
  const { context, victim, amount, element } = args;
  if (!victim.active || victim.hp <= 0) return null;

  const reaction = findReaction(element, args.carriedStatuses);
  if (!reaction) return null;

  const color = hexToInt(reaction.color);
  const x = victim.x;
  const y = victim.y;

  /* 1. The inputs are spent. */
  reaction.consumes.forEach((status) => victim.statuses.remove(status));

  /* 2. The outputs are applied. */
  reaction.applies.forEach((application) => victim.statuses.apply(application));

  /* 3. The burst goes through the normal damage path so armour, death, drops
     and achievements all keep working. `noReaction` stops a chain of reactions
     from feeding itself. */
  const burst = Math.max(1, Math.round(amount * reaction.burstMultiplier));
  victim.takeDamage({
    amount: burst,
    isCrit: true,
    element,
    vfx: reaction.vfx,
    damageType: reaction.damageType,
    statuses: [],
    knockback: reaction.knockback ?? 0,
    source: 'player',
    sourceX: args.sourceX,
    sourceY: args.sourceY,
    pure: true,
    tier: reaction.shake ? 'ultimate' : 'skill',
    noReaction: true,
  });

  /* 4. The frame says what happened, in the vocabulary everything else uses. */
  context.fx.impact({
    tier: reaction.shake ? 'ultimate' : 'skill',
    x,
    y,
    amount: burst,
    isCrit: true,
    color,
    vfx: reaction.vfx,
    family: reaction.family,
    target: victim,
    knockAngle: Math.atan2(y - args.sourceY, x - args.sourceX),
    silent: true,
  });
  context.fx.screenWash(color, 0.12, 260);
  context.fx.label(x, y - 14, reaction.name.toUpperCase(), reaction.color);
  sfx(reaction.sfx, { gain: 0.55, rate: reaction.shake ? 0.92 : 1.1 });

  if (reaction.field) {
    context.addField({
      x,
      y,
      radius: reaction.field.radius,
      dps: (amount * reaction.field.dpsMultiplier) / Math.max(0.6, reaction.field.duration),
      duration: reaction.field.duration,
      element: reaction.elements[0] ?? 'fire',
      vfx: reaction.vfx,
      color,
      statuses: reaction.field.statuses,
      friendly: true,
      pull: reaction.field.pull,
    });
  }

  if (reaction.chain) {
    chainArcs(context, victim, reaction, amount);
  }

  return reaction;
}

/**
 * Chained conduction: the charge walks outward to the nearest bodies it can
 * reach, each hop weaker than the last. Bounded by `jumps`, never by how many
 * enemies happen to be alive.
 */
function chainArcs(context: CombatContext, from: Enemy, reaction: ReactionDef, amount: number): void {
  const spec = reaction.chain;
  if (!spec) return;
  const color = hexToInt(reaction.color);
  const candidates: { enemy: Enemy; distance: number }[] = [];

  for (const child of context.enemies.getChildren() as Enemy[]) {
    if (child === from || !child.active || child.hp <= 0) continue;
    const distance = Phaser.Math.Distance.Between(from.x, from.y, child.x, child.y);
    if (distance <= spec.radius) candidates.push({ enemy: child, distance });
  }
  candidates.sort((a, b) => a.distance - b.distance);

  let originX = from.x;
  let originY = from.y;
  candidates.slice(0, spec.jumps).forEach(({ enemy }, index) => {
    const power = Math.max(1, Math.round(amount * spec.damageMultiplier * (1 - index * 0.15)));
    enemy.statuses.apply({ id: spec.status, duration: spec.duration, chance: 1 });
    enemy.takeDamage({
      amount: power,
      isCrit: false,
      element: reaction.elements[0] ?? null,
      vfx: reaction.vfx,
      damageType: reaction.damageType,
      statuses: [],
      knockback: 18,
      source: 'player',
      sourceX: originX,
      sourceY: originY,
      pure: true,
      tier: 'skill',
      noReaction: true,
    });
    // The arc itself: a short line of sparks between the two bodies.
    const steps = 4;
    for (let s = 1; s < steps; s += 1) {
      const t = s / steps;
      context.hitSparkAt(
        originX + (enemy.x - originX) * t + (Math.random() - 0.5) * 3,
        originY + (enemy.y - originY) * t + (Math.random() - 0.5) * 3,
        color,
        0.5,
        reaction.vfx,
        reaction.family,
      );
    }
    context.fx.ring(enemy.x, enemy.y, color, 9, 0.2, 0.6);
    originX = enemy.x;
    originY = enemy.y;
  });
}
