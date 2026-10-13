import { ELEMENT_REGISTRY } from '@/data/elements';
import { computeResonances } from '@/data/elements/resonances';
import { masteryLevelFromXp } from '@/game/systems/elementProgression';
import type { ElementId } from '@/types';

/** How much a tier is worth on its own — later elements carry heavier attacks. */
const TIER_WEIGHT: Record<string, number> = {
  primordial: 0,
  branching: 5,
  advanced: 9,
  final: 13,
};

/** Points per mastery level: a trained element beats an untrained one of the same tier. */
const MASTERY_WEIGHT = 9;

/**
 * Points per multiplier-hit per second, i.e. `damageMultiplier × projectiles /
 * cooldown`. Per-projectile multiplier alone (the old `× 60` on `damageMultiplier`)
 * divided every shotgun's output by its pellet count and ignored cooldown entirely,
 * which ranked the three strongest attacks in the game last (docs §B7).
 */
const DPS_WEIGHT = 19;

/** Bonus per resonance a pick completes — synergy is the reason to carry six at all. */
const RESONANCE_BONUS = 26;

export interface ElementAdvice {
  element: ElementId;
  score: number;
  level: number;
  resonances: number;
  why: string;
}

export interface LoadoutAdvice {
  slots: (ElementId | null)[];
  activeSlot: number;
  picks: ElementAdvice[];
}

/**
 * Rank one element for the AUTO-BEST picker.
 *
 * Score is mastery level, tier and attack *throughput* — the three things the combat
 * system already cares about; `resonances` counts what the element would
 * complete *with the elements chosen so far*, so the ranking changes with context
 * instead of always producing the same six.
 */
export function scoreElement(element: ElementId, xp: number, equipped: (ElementId | null)[] = []): ElementAdvice {
  const def = ELEMENT_REGISTRY[element];
  const level = masteryLevelFromXp(xp);
  const withElement = [...equipped, element];
  const resonances = computeResonances(withElement).length;
  const before = computeResonances(equipped).length;
  const gained = Math.max(0, resonances - before);
  /* Throughput, per volley: every pellet counts, and a slower trigger costs.
     Range-dependent (a shotgun at arm's length is not a shotgun across the arena),
     which is why this is advice about *what to carry*, not a damage meter. */
  const spec = def.attack;
  const volley = spec.damageMultiplier * (spec.projectile?.count ?? 1);
  const perSecond = volley / Math.max(0.08, spec.cooldown);
  const score =
    (TIER_WEIGHT[def.tier] ?? 0) +
    level * MASTERY_WEIGHT +
    perSecond * DPS_WEIGHT +
    gained * RESONANCE_BONUS;
  return {
    element,
    score: Math.round(score * 10) / 10,
    level,
    resonances: gained,
    why: `LV ${level} · ${def.tier.toUpperCase()}${gained > 0 ? ` · +${gained} RESONANCE${gained > 1 ? 'S' : ''}` : ''}`,
  };
}

/**
 * Fill `slotCount` slots with the strongest available combination.
 *
 * Greedy, in score order, re-scoring after every pick so a synergy that only
 * becomes possible after the third element still gets taken. It never invents an
 * element: the candidate list is the save's own unlocked set, and a loadout with
 * fewer unlocked elements than slots simply leaves the rest empty.
 */
export function bestLoadout(
  unlocked: ElementId[],
  xpOf: (element: ElementId) => number,
  slotCount = 6,
): LoadoutAdvice {
  const slots: (ElementId | null)[] = [];
  const picks: ElementAdvice[] = [];
  const remaining = [...unlocked];

  while (slots.length < slotCount && remaining.length > 0) {
    const ranked = remaining
      .map((element) => scoreElement(element, xpOf(element), slots))
      .sort((a, b) => b.score - a.score || ELEMENT_REGISTRY[a.element].index - ELEMENT_REGISTRY[b.element].index);
    const best = ranked[0];
    if (!best) break;
    picks.push(best);
    slots.push(best.element);
    remaining.splice(remaining.indexOf(best.element), 1);
  }

  while (slots.length < slotCount) slots.push(null);

  return { slots, activeSlot: 0, picks };
}
