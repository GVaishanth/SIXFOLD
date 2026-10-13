import { MASTERY, PROGRESSION } from '@/config/gameConfig';
import { getBoss } from '@/data/bosses';
import { ALL_ELEMENTS, ELEMENT_REGISTRY, STARTER_ELEMENT_IDS } from '@/data/elements';
import type { ElementId, ElementTier } from '@/types';
import { clamp } from '@/utils/math';

/** Pure element progression rules — the single source of truth for unlocks. */

export function defaultUnlockedElements(starter: ElementId): ElementId[] {
  return [starter];
}

/** Elements whose unlock threshold is met by reaching `wave`. */
export function milestoneElementsForWave(wave: number): ElementId[] {
  return ALL_ELEMENTS.filter(
    (element) => element.unlock.kind === 'wave' && (element.unlock.value ?? Infinity) <= wave,
  ).map((element) => element.id);
}

/** Element dropped by defeating a boss in story mode. */
export function elementForBoss(bossId: string): ElementId | null {
  const boss = getBoss(bossId);
  return boss?.rewardElement ?? null;
}

export interface UnlockCheck {
  ids: ElementId[];
  reasons: { element: ElementId; reason: string }[];
}

/**
 * Returns every element newly unlocked by a progress event. `bossId` is only
 * passed on first story defeat so elements are never re-granted.
 */
export function pendingUnlocks(params: {
  wave: number;
  bossId?: string | null;
  alreadyUnlocked: ElementId[];
}): UnlockCheck {
  const unlocked = new Set(params.alreadyUnlocked);
  const ids: ElementId[] = [];
  const reasons: { element: ElementId; reason: string }[] = [];

  for (const id of milestoneElementsForWave(params.wave)) {
    if (!unlocked.has(id)) {
      unlocked.add(id);
      ids.push(id);
      const def = ELEMENT_REGISTRY[id];
      reasons.push({ element: id, reason: `Wave ${def.unlock.value} milestone cleared` });
    }
  }

  if (params.bossId) {
    const reward = elementForBoss(params.bossId);
    if (reward && !unlocked.has(reward)) {
      unlocked.add(reward);
      ids.push(reward);
      const boss = getBoss(params.bossId);
      reasons.push({
        element: reward,
        reason: `Defeated ${boss ? boss.name : 'a boss'}`,
      });
    }
  }

  return { ids, reasons };
}

/**
 * The tree's depth order. A focus purchase can only reach the tier directly below the
 * deepest one the save already holds, so `advanced`/`final` elements stop being a shop
 * item on a wave-1 save. Kept here rather than in the registry because it is a rule about
 * the ladder, not a property of any one element.
 */
const TIER_LADDER: readonly ElementTier[] = ['primordial', 'branching', 'advanced', 'final'];

export function tierDepth(tier: ElementTier): number {
  return TIER_LADDER.indexOf(tier);
}

/** What the tree charges to focus this element into existence, in element shards. */
export function shardUnlockCostFor(tier: ElementTier): number {
  return PROGRESSION.shardUnlockCostByTier[tier];
}

/** Deepest tier present in an unlocked set (a save with only primordials sits at 0). */
export function deepestTierDepth(unlocked: ElementId[]): number {
  let deepest = 0;
  for (const id of unlocked) {
    const def = ELEMENT_REGISTRY[id];
    if (!def) continue;
    deepest = Math.max(deepest, tierDepth(def.tier));
  }
  return deepest;
}

/** Can the player spend shards to focus-unlock this element early? */
export function shardUnlockEligible(
  elementId: ElementId,
  unlocked: ElementId[],
  shards: number,
): { ok: boolean; cost: number; reason: string } {
  const def = ELEMENT_REGISTRY[elementId];
  const cost = shardUnlockCostFor(def.tier);
  if (unlocked.includes(elementId)) return { ok: false, cost, reason: 'Already unlocked.' };
  if (def.unlock.kind === 'starter') {
    return { ok: false, cost, reason: 'Starter elements are chosen at new game.' };
  }
  if (def.unlock.kind !== 'wave') {
    return {
      ok: false,
      cost,
      reason: `Not in the focus shop — ${def.unlock.note.toLowerCase()}`,
    };
  }
  /*
   * Two tree gates, in this order: the lineage must be able to reach the element, and the
   * tier must be the next one down. Without them a single 6-shard purchase bought any
   * wave-milestone element on the save — the `final` tier included — because only the wave
   * number was ever consulted.
   */
  const held = new Set(unlocked);
  if (def.parents.length > 0 && !def.parents.some((parent) => held.has(parent))) {
    const names = def.parents.map((parent) => ELEMENT_REGISTRY[parent]?.name ?? parent).join(' or ');
    return { ok: false, cost, reason: `Needs ${names} unlocked first — focus follows the lineage.` };
  }
  const depth = tierDepth(def.tier);
  const deepest = deepestTierDepth(unlocked);
  if (depth > deepest + 1) {
    const needed = TIER_LADDER[Math.max(0, Math.min(depth - 1, TIER_LADDER.length - 1))];
    return { ok: false, cost, reason: `Locked behind the ${needed} tier — unlock deeper in the tree first.` };
  }
  return shards >= cost
    ? { ok: true, cost, reason: `Focus ${cost} essence shards into this element.` }
    : { ok: false, cost, reason: `Requires ${cost} element shards.` };
}

/* ------------------------------------------------------------------ */
/* Mastery                                                            */
/* ------------------------------------------------------------------ */

export function masteryLevelFromXp(xp: number): number {
  const safe = Math.max(0, xp);
  let level = 1;
  for (let i = 0; i < MASTERY.levelXp.length; i += 1) {
    if (safe >= MASTERY.levelXp[i]) level = i + 1;
  }
  return clamp(level, 1, MASTERY.maxLevel);
}

export function xpForNextLevel(xp: number): { current: number; next: number; progress: number } {
  const level = masteryLevelFromXp(xp);
  if (level >= MASTERY.maxLevel) return { current: xp, next: xp, progress: 1 };
  const currentFloor = MASTERY.levelXp[level - 1];
  const nextFloor = MASTERY.levelXp[level];
  const span = Math.max(1, nextFloor - currentFloor);
  return {
    current: xp - currentFloor,
    next: span,
    progress: clamp((xp - currentFloor) / span, 0, 1),
  };
}

export interface MasteryBonuses {
  damageMult: number;
  statusDurationMult: number;
  cooldownMult: number;
  ultimateCostMult: number;
}

/** Mastery bonuses for a single element at a given level. */
export function masteryBonuses(elementId: ElementId, xp: number): MasteryBonuses {
  const def = ELEMENT_REGISTRY[elementId];
  const level = masteryLevelFromXp(xp);
  const levels = level - 1;
  return {
    damageMult: 1 + levels * def.masteryMultiplier,
    statusDurationMult: 1 + levels * MASTERY.statusDurationPerLevel,
    cooldownMult: Math.max(0.6, 1 - levels * MASTERY.cooldownPerLevel),
    ultimateCostMult: Math.max(0.75, 1 - levels * MASTERY.ultimateCostPerLevel),
  };
}

/** Aggregate mastery across a loadout, used by the statistics screen. */
export function totalMasteryLevels(mastery: Partial<Record<ElementId, { level: number; xp: number }>>): number {
  return Object.values(mastery).reduce((sum, entry) => sum + (entry?.level ?? 0), 0);
}

export function isStarter(id: ElementId): boolean {
  return STARTER_ELEMENT_IDS.includes(id);
}
