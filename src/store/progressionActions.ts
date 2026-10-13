import { MASTERY } from '@/config/gameConfig';
import { getBoss } from '@/data/bosses';
import { ELEMENT_REGISTRY } from '@/data/elements';
import { WAVES_PER_FLOOR, getFloor } from '@/data/floors';
import { gameBus } from '@/game/systems/eventBus';
import { masteryLevelFromXp, pendingUnlocks } from '@/game/systems/elementProgression';
import type { ElementId, SaveData } from '@/types';
import { pulse } from '@/utils/haptics';
import { clamp, roundTo } from '@/utils/math';
import { useUiStore } from '@/store/uiStore';
import type { SaveStoreState } from '@/store/saveStore';

/**
 * Pure-ish progression mutations.
 *
 * These functions receive the Zustand `get`/`set` pair rather than importing
 * the store at runtime, which keeps the dependency direction one-way:
 * saveStore → progressionActions → data.
 */

export type SaveGetter = () => SaveStoreState;
export type SaveSetter = (partial: Partial<SaveStoreState>) => void;

export interface WaveClearArgs {
  wave: number;
  floor: number;
  essence: number;
  shards: number;
  mode: 'story' | 'free' | 'ascension';
  elapsedMs: number;
}

export function grantElements(get: SaveGetter, ids: ElementId[], reason: string): void {
  if (ids.length === 0) return;
  get().mutate((draft) => {
    for (const id of ids) {
      if (!draft.unlockedElements.includes(id)) draft.unlockedElements.push(id);
      if (!draft.discoveredElements.includes(id)) draft.discoveredElements.push(id);
      if (!draft.mastery[id]) draft.mastery[id] = { level: 1, xp: 0 };
    }
  }, { immediate: true });

  const run = get().run;
  if (run) run.unlocked.push(...ids);

  // One notification per unlock: the claim is taken *before* the event goes out,
  // so the HUD listener can tell that the unlock moment is already carrying this
  // element and stay quiet. (The moment falls back to a toast itself when a wave
  // grants several elements at once.)
  for (const id of ids) {
    useUiStore.getState().claimUnlockMoment(id, reason);
    gameBus.emit('game:elementUnlocked', { element: id, reason });
  }
}

export function addMasteryXpToSave(draft: SaveData, element: ElementId, xp: number): void {
  const entry = draft.mastery[element] ?? { level: 1, xp: 0 };
  const nextXp = clamp(entry.xp + xp, 0, MASTERY.levelXp[MASTERY.maxLevel - 1]);
  const nextLevel = masteryLevelFromXp(nextXp);
  draft.mastery[element] = { level: nextLevel, xp: nextXp };
}

export function registerElementUsage(draft: SaveData, element: ElementId): void {
  draft.stats.elementUsage[element] = (draft.stats.elementUsage[element] ?? 0) + 1;
}

/** Wave completion — story progress, milestones, rewards and statistics. */
export function applyWaveClear(
  get: SaveGetter,
  set: SaveSetter,
  args: WaveClearArgs,
): void {
  const { wave, shards, mode } = args;
  void set;

  /* `essence` is *not* added here. The director hands the wave's bonus to
   * `context.addEssence`, which emits the same `game:loot` event a picked-up orb
   * does, and `saveStore.onLoot` is the single writer for the wallet. Crediting it
   * here as well paid the bonus twice and left the HUD's run tally permanently one
   * wave-bonus behind the save (see docs/STATS_GAMEPLAY_FAULTS.md §A2). */

  get().mutate((draft) => {
    draft.progression.shards += shards;
    draft.stats.shardsCollected += shards;

    if (mode === 'story') {
      draft.story.highestWave = Math.max(draft.story.highestWave, wave);
      if (!draft.story.clearedWaves.includes(wave)) draft.story.clearedWaves.push(wave);
      if (draft.story.clearedWaves.length > 220) {
        draft.story.clearedWaves = draft.story.clearedWaves.slice(-220);
      }
      draft.story.currentWave = clamp(wave + 1, 1, 200);
      draft.story.currentFloor = clamp(Math.ceil(draft.story.currentWave / WAVES_PER_FLOOR), 1, 10);
      draft.stats.highestStoryWave = Math.max(draft.stats.highestStoryWave, wave);
      draft.stats.wavesCompleted += 1;
      if (wave >= 200) {
        draft.story.completed = true;
        draft.freeModeUnlocked = true;
        draft.ascension.unlocked = true;
      }
    } else if (mode === 'ascension') {
      draft.ascension.highestWave = Math.max(draft.ascension.highestWave, wave);
      draft.ascension.cycle = Math.floor((wave - 1) / 200);
      draft.stats.highestAscensionWave = Math.max(draft.stats.highestAscensionWave, wave);
      draft.stats.wavesCompleted += 1;
    } else {
      // Free Mode never touches story completion state.
      draft.stats.wavesCompleted += 1;
    }

    const unlocks = pendingUnlocks({
      wave,
      alreadyUnlocked: draft.unlockedElements,
    });
    for (const id of unlocks.ids) {
      if (!draft.unlockedElements.includes(id)) draft.unlockedElements.push(id);
      if (!draft.discoveredElements.includes(id)) draft.discoveredElements.push(id);
      if (!draft.mastery[id]) draft.mastery[id] = { level: 1, xp: 0 };
    }
  }, { immediate: true });

  if (mode === 'story') {
    const unlocks = pendingUnlocks({ wave, alreadyUnlocked: get().data?.unlockedElements ?? [] });
    if (unlocks.ids.length > 0) {
      pulse('unlock');
      const run = get().run;
      if (run) run.unlocked.push(...unlocks.ids);
      for (const reason of unlocks.reasons) {
        const def = ELEMENT_REGISTRY[reason.element];
        useUiStore.getState().pushToast({
          title: 'ELEMENT DISCOVERED',
          body: `${def.name.toUpperCase()} — ${reason.reason}`,
          color: def.color,
          glyph: def.symbol,
        });
      }
    }
  }
}

export interface BossDefeatArgs {
  bossId: string;
  rank: 'major' | 'miniboss';
  essence: number;
  shards: number;
  relics: number;
  mode: 'story' | 'free' | 'ascension';
  drops: string[];
  wave: number;
}

/**
 * Boss defeat.
 *
 * Story mode enforces the one-time rule: a defeated story boss is recorded and
 * is never re-offered as a wall on a later respawn. Free Mode grants replay
 * rewards but explicitly leaves story state untouched.
 */
export function applyBossDefeat(
  get: SaveGetter,
  set: SaveSetter,
  args: BossDefeatArgs,
): void {
  const boss = getBoss(args.bossId);
  const { mode } = args;
  void set;

  let hallReward: HallUpgrade | null = null;
  get().mutate((draft) => {
    draft.stats.bossesDefeated += 1;
    draft.progression.essence += args.essence;
    draft.progression.shards += args.shards;
    draft.progression.relicCores += args.relics;
    draft.stats.essenceCollected += args.essence;
    draft.stats.shardsCollected += args.shards;
    draft.stats.relicsCollected += args.relics;

    if (!boss) return;
    const floor = boss.floor;

    if (mode === 'story') {
      // First-time story bosses award permanent hall upgrades. Without them the
      // player's power would stay flat while wave scaling climbs, and the later
      // floors would be mathematically unwinnable. The curve is deliberately
      // linear in the floor so it tracks the (saturating) enemy HP curve.
      if (!draft.story.storyBossesDefeated.includes(boss.id)) {
        draft.story.storyBossesDefeated.push(boss.id);
        const gained = hallUpgradeFor(floor);
        draft.progression.bonusHp += gained.hp;
        draft.progression.bonusAttack += gained.attack;
        draft.progression.bonusDefense += gained.defense;
        draft.progression.bonusCrit += gained.crit;
        hallReward = gained;
      }
      if (!draft.story.replayableBosses.includes(boss.id)) {
        draft.story.replayableBosses.push(boss.id);
      }
      // Checkpoint hall: resume after the boss, never before it.
      draft.checkpoint = {
        bossId: boss.id,
        bossName: boss.name,
        floor,
        wave: boss.wave,
        respawnWave: clamp(boss.wave + 1, 1, 200),
        createdAt: Date.now(),
      };
      draft.progression.hallLevel = Math.max(draft.progression.hallLevel, floor);
      draft.story.highestWave = Math.max(draft.story.highestWave, boss.wave);
      draft.story.currentWave = clamp(boss.wave + 1, 1, 200);
      draft.story.currentFloor = clamp(Math.ceil(draft.story.currentWave / WAVES_PER_FLOOR), 1, 10);
      draft.stats.highestStoryWave = Math.max(draft.stats.highestStoryWave, boss.wave);

      if (hallReward) {
        gameBus.emit('game:hallUpgrade', { floor, bossName: boss.name, ...hallReward });
      }

      if (boss.rank === 'major') {
        const nextFloor = getFloor(floor + 1);
        draft.story.currentFloor = clamp(floor + (floor < 10 ? 1 : 0), 1, 10);
        draft.progression.hallLevel = Math.max(draft.progression.hallLevel, Math.min(10, floor + 1));
        if (floor >= 10) {
          draft.story.completed = true;
          draft.freeModeUnlocked = true;
          draft.ascension.unlocked = true;
        }
        gameBus.emit('game:floorCleared', {
          floor,
          floorName: getFloor(floor).name,
          nextFloor: Math.min(10, floor + 1),
          nextFloorName: nextFloor.name,
        });
      }
    } else if (mode === 'ascension') {
      if (!draft.story.replayableBosses.includes(boss.id)) {
        draft.story.replayableBosses.push(boss.id);
      }
    } else if (!draft.story.replayableBosses.includes(boss.id)) {
      // Free Mode only unlocks replay entries for bosses defeated in story.
      // Replaying an already-known boss keeps the list consistent.
      draft.story.replayableBosses.push(boss.id);
    }
  }, { immediate: true });

  if (mode === 'story' && boss) {
    const unlocks = pendingUnlocks({
      wave: boss.wave,
      bossId: boss.id,
      alreadyUnlocked: get().data?.unlockedElements ?? [],
    });
    if (unlocks.ids.length > 0) {
      const run = get().run;
      if (run) run.unlocked.push(...unlocks.ids);
      for (const reason of unlocks.reasons) {
        const def = ELEMENT_REGISTRY[reason.element];
        useUiStore.getState().pushToast({
          title: 'ELEMENT DISCOVERED',
          body: `${def.name.toUpperCase()} — ${reason.reason}`,
          color: def.color,
          glyph: def.symbol,
        });
      }
    }
  }
}

export function markCheckpoint(
  get: SaveGetter,
  set: SaveSetter,
  bossId: string,
  floor: number,
  wave: number,
): void {
  const boss = getBoss(bossId);
  void set;
  get().mutate((draft) => {
    draft.checkpoint = {
      bossId,
      bossName: boss ? boss.name : 'Checkpoint Hall',
      floor,
      wave,
      respawnWave: clamp(wave + 1, 1, 200),
      createdAt: Date.now(),
    };
    draft.progression.hallLevel = Math.max(draft.progression.hallLevel, floor);
  }, { immediate: true });
}

/** Essence cost helper used by the hub when focusing mastery. */
export function masteryFocusCost(level: number): number {
  return Math.round(40 * Math.pow(1.35, Math.max(0, level - 1)));
}



export interface HallUpgrade {
  hp: number;
  attack: number;
  defense: number;
  crit: number;
}

/**
 * Permanent stat reward granted when a story boss falls for the first time.
 *
 * Ten floors hold twenty bosses, so a full story run ends around +200 max HP,
 * +20 attack, +12 defense and +7% crit — roughly a 3x damage and 3x health
 * increase, which is exactly the headroom the late-wave HP curve assumes.
 */
export function hallUpgradeFor(floor: number): HallUpgrade {
  const f = clamp(floor, 1, 10);
  return {
    hp: Math.round(4 + f * 1.2),
    attack: roundTo(0.35 + f * 0.12, 2),
    defense: roundTo(0.25 + f * 0.08, 2),
    crit: roundTo(0.0015 + f * 0.0006, 4),
  };
}
