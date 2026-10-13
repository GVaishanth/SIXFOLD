import type { DamageType, ElementId, StatusApplication, VfxStyleId } from '@/types';
import type { PlayerStats } from '@/game/systems/statEngine';

/**
 * One hit's worth of intent, from whoever dealt it.
 *
 * `isCrit` is rolled once per player cast in `Player` (`rollCrit`) and travels with the
 * projectile so a five-pellet shotgun crits as a volley rather than per pellet. `auto`
 * marks a support cast: its damage still counts for achievements, stats and reactions,
 * but it spends no energy and steals no lifesteal — see `Player.onDealtDamage`.
 */
export interface DamagePacket {
  amount: number;
  isCrit: boolean;
  /** True for the six-element rig's auto casts, false for anything the player fired. */
  auto?: boolean;
  element: ElementId | null;
  vfx: VfxStyleId;
  damageType: DamageType;
  statuses: StatusApplication[];
  knockback: number;
  source: 'player' | 'enemy' | 'hazard' | 'boss';
  sourceX: number;
  sourceY: number;
  /** Skips mitigation entirely (used by true-damage and hazards). */
  pure?: boolean;
  /**
   * Forces the feedback tier (reactions, ultimates, story beats). Left unset the
   * damage maths decides, so an ordinary big number still lands hard.
   */
  tier?: 'normal' | 'skill' | 'crit' | 'ultimate' | 'bossPhase';
  /** Set by the reaction resolver so a reaction can never chain itself. */
  noReaction?: boolean;
}

/**
 * The per-hit ceiling, with a soft knee.
 *
 * A cap exists so no single touch deletes a warden. A *hard* cap also deletes the
 * difficulty curve: once `raw` is past it, every later wave lands identically. Past
 * the ceiling this keeps `knee` of the excess, so the ceiling still bites and the
 * curve still means something.
 */
export function capHitDamage(raw: number, cap: number | undefined, knee = 0): number {
  if (!cap || cap <= 0 || raw <= cap) return raw;
  return cap + (raw - cap) * Math.max(0, Math.min(1, knee));
}

/** Armour mitigation with diminishing returns, then armour-break scaling. */
export function mitigate(amount: number, armor: number, armorBreakMultiplier = 1): number {
  const effectiveArmor = Math.max(0, Math.min(0.85, armor * armorBreakMultiplier));
  return Math.max(1, amount * (1 - effectiveArmor));
}

/** Roll result: whether it crits and what that does to the number. */
export interface CritRoll {
  isCrit: boolean;
  damageMult: number;
}

/**
 * The crit roll for one player cast. `critChance` and `critDamage` are the numbers
 * the stat engine already clamps (0.75 ceiling, relics and hall rewards included);
 * this is the only place they are read, so an attack either rolls here or cannot
 * crit at all.
 */
export function rollCrit(stats: PlayerStats): CritRoll {
  const isCrit = Math.random() < stats.critChance;
  return { isCrit, damageMult: isCrit ? stats.critDamage : 1 };
}

/** Knockback direction helper — unit vector scaled by strength. */
export function knockbackVector(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  strength: number,
): { x: number; y: number } {
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const length = Math.hypot(dx, dy) || 1;
  return { x: (dx / length) * strength, y: (dy / length) * strength };
}
