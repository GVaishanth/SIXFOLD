import { create } from 'zustand';
import { SAVE_CONFIG } from '@/config/gameConfig';
import { ACHIEVEMENTS, achievementProgress } from '@/data/achievements';
import { ELEMENT_REGISTRY } from '@/data/elements';
import {
  addMasteryXpToSave,
  applyBossDefeat,
  applyWaveClear,
  markCheckpoint,
  registerElementUsage,
  type BossDefeatArgs,
  type WaveClearArgs,
} from '@/store/progressionActions';
import {
  createSaveSlot,
  deleteSaveSlot,
  loadSaveFile,
  persistSaveFile,
  writeSlot,
} from '@/app/saveService';
import { gameBus } from '@/game/systems/eventBus';
import { useUiStore } from '@/store/uiStore';
import { shardUnlockEligible } from '@/game/systems/elementProgression';
import type { AchievementState, ElementId, RunSummary, SaveData, SaveFile, SaveSlotMeta } from '@/types';
import { emptySaveFile, slotMeta } from '@/utils/saveSchema';
import { clamp } from '@/utils/math';

/** Non-persistent tracking for the run currently in progress. */
export interface RunTracker {
  startedAt: number;
  mode: 'story' | 'free' | 'ascension';
  startWave: number;
  wavesCleared: number;
  enemiesDefeated: number;
  bossesDefeated: number;
  /** Ranged attacks swatted out of the air by a shot of your own. A trade: your bolt is spent too. */
  shotsCountered: number;
  essenceGained: number;
  shardsGained: number;
  relicsGained: number;
  highestHit: number;
  unlocked: string[];
  totalDamage: number;
}

export interface SaveStoreState {
  hydrated: boolean;
  file: SaveFile;
  activeSlot: number;
  data: SaveData | null;
  loadError: string | null;
  run: RunTracker | null;
  /** Bumped after every persisted change so React panels can refresh cheaply. */
  revision: number;

  hydrate: () => void;
  getMetas: () => SaveSlotMeta[];
  createSave: (slot: number, name: string, starter: ElementId) => SaveData | null;
  deleteSave: (slot: number) => void;
  selectSlot: (slot: number) => void;
  clearActive: () => void;

  mutate: (mutator: (draft: SaveData) => void, options?: { immediate?: boolean; silent?: boolean }) => void;
  /** Writes the active slot to storage immediately (autosave, exit-to-menu). */
  flush: () => void;

  beginRun: (mode: 'story' | 'free' | 'ascension', startWave: number) => void;
  /** Re-express the saved run-buff expiries against a freshly started scene clock. */
  rebaseRunBuffs: (now: number) => void;
  /** Record the health a SAVE & EXIT left behind, for the run that resumes it. */
  stageResumeRun: (record: { mode: 'story' | 'free' | 'ascension'; wave: number; hp: number }) => void;
  /** Drop a staged resume. The scene that takes it does this, so it is spent exactly once. */
  clearResumeRun: () => void;
  onWaveCleared: (args: Omit<WaveClearArgs, 'runBuffs'>) => void;
  onBossDefeated: (args: BossDefeatArgs) => void;
  onPlayerDeath: () => void;
  onCheckpoint: (bossId: string, floor: number, wave: number) => void;
  onLoot: (drop: { id: string; amount: number; kind: string }) => void;

  addMastery: (element: ElementId, xp: number) => void;
  registerAttackUse: (element: ElementId) => void;
  setLoadout: (slots: (ElementId | null)[], activeSlot: number) => { ok: boolean; reason?: string };
  setActiveSlotIndex: (index: number) => void;
  focusUnlockElement: (element: ElementId) => { ok: boolean; reason: string };
  completeStory: () => void;
  recordAscensionWave: (wave: number) => void;
  setFreeModeConfig: (config: Partial<SaveData['freeMode']>) => void;
  setStoryWave: (wave: number) => void;
  addPlaytime: (ms: number) => void;
  finishRun: (cause: 'death' | 'exit' | 'complete', extra?: Partial<RunSummary>) => RunSummary | null;
  markHallLevel: (level: number) => void;
  resetProgress: () => void;
}

let flushTimer: number | null = null;

function clone<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* fall through to JSON copy */
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function scheduleFlush(get: () => SaveStoreState): void {
  if (flushTimer !== null) window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    const { data, file } = get();
    if (data) writeSlot(file, data);
  }, SAVE_CONFIG.autosaveDebounceMs);
}

function evaluateAchievements(data: SaveData): { achievements: AchievementState[]; unlocked: string[] } {
  const existing = new Map(data.achievements.map((entry) => [entry.id, entry]));
  const unlocked: string[] = [];
  const next: AchievementState[] = data.achievements.map((entry) => ({ ...entry }));

  for (const def of ACHIEVEMENTS) {
    // The bar and the requirement come from the same two numbers, so a locked entry can never show a
    // percentage that disagrees with the "6 of 25" the ledger prints.
    const progress = clamp(achievementProgress(def, data), 0, 1);
    const current = existing.get(def.id);
    if (!current) {
      next.push({ id: def.id, unlockedAt: progress >= 1 ? Date.now() : null, progress });
      if (progress >= 1) unlocked.push(def.id);
    } else {
      const record = next.find((entry) => entry.id === def.id);
      if (!record) continue;
      record.progress = Math.max(record.progress, progress);
      if (!record.unlockedAt && progress >= 1) {
        record.unlockedAt = Date.now();
        unlocked.push(def.id);
      }
    }
  }
  return { achievements: next, unlocked };
}

export const useSaveStore = create<SaveStoreState>((set, get) => ({
  hydrated: false,
  file: emptySaveFile(),
  activeSlot: 0,
  data: null,
  loadError: null,
  run: null,
  revision: 0,

  hydrate: () => {
    const report = loadSaveFile();
    const activeSlot = report.file.lastSlot;
    set({
      hydrated: true,
      file: report.file,
      activeSlot,
      data: report.file.slots[activeSlot] ?? null,
      loadError: report.error ?? (report.repaired ? 'Save data was repaired.' : null),
      revision: get().revision + 1,
    });
    if (report.repaired) {
      console.warn('[sixfold] save file required repair');
    }
  },

  getMetas: () => {
    const { file } = get();
    return file.slots.map((slot, index) => slotMeta(index, slot ?? null));
  },

  createSave: (slot, name, starter) => {
    const { file, data } = get();
    if (data && data.slot === slot) {
      // Overwriting: drop the tracker so nothing leaks between saves.
      set({ run: null });
    }
    const result = createSaveSlot(file, slot, name, starter);
    set({
      file: result.file,
      activeSlot: slot,
      data: result.data,
      revision: get().revision + 1,
    });
    return result.data;
  },

  deleteSave: (slot) => {
    const nextFile = deleteSaveSlot(get().file, slot);
    const isActive = get().activeSlot === slot;
    set({
      file: nextFile,
      data: isActive ? null : get().data,
      revision: get().revision + 1,
      run: isActive ? null : get().run,
    });
  },

  selectSlot: (slot) => {
    const { file } = get();
    const data = file.slots[slot] ?? null;
    const nextFile: SaveFile = { ...file, lastSlot: slot };
    persistSaveFile(nextFile);
    set({ file: nextFile, activeSlot: slot, data, revision: get().revision + 1 });
  },

  clearActive: () => set({ data: null, run: null }),

  flush: () => {
    const { data, file } = get();
    if (!data) return;
    if (flushTimer !== null) {
      window.clearTimeout(flushTimer);
      flushTimer = null;
    }
    writeSlot(file, data);
  },

  mutate: (mutator, options) => {
    const current = get().data;
    if (!current) return;
    const draft = clone(current);
    try {
      mutator(draft);
    } catch (error) {
      console.error('[sixfold] save mutation failed — save left untouched', error);
      return;
    }
    draft.profile.lastPlayed = Date.now();

    // `unlocked` is deliberately not read here: achievements are announced by
    // `AchievementToasts`, which diffs the list, so this store never pushes UI.
    const { achievements } = evaluateAchievements(draft);
    draft.achievements = achievements;

    const { file } = get();
    const nextFile = { ...file, slots: file.slots.map((slot, i) => (i === draft.slot ? draft : slot)) };
    set({
      data: draft,
      file: nextFile,
      revision: get().revision + 1,
    });

    if (!options?.silent) {
      if (options?.immediate) {
        writeSlot(nextFile, draft);
      } else {
        scheduleFlush(get);
      }
    }

    // No toast here on purpose: `AchievementToasts` derives the notification by
    // diffing the achievement list, so every unlock is announced exactly once and
    // a bulk unlock (several in one mutation) is not silently truncated to the
    // first. The store stays out of the interface.
  },

  clearResumeRun: () => {
    if (!get().data?.resumeRun) return;
    get().mutate((draft) => {
      draft.resumeRun = null;
    }, { immediate: true });
  },

  stageResumeRun: (record) => {
    if (!get().data) return;
    get().mutate(
      (draft) => {
        draft.resumeRun = { mode: record.mode, wave: Math.floor(record.wave), hp: Math.round(record.hp) };
      },
      { immediate: true },
    );
  },

  beginRun: (mode, startWave) => {
    /* A run owns its buffs. Clearing here is what keeps a pickup from one run (or
       one *save* of a run) riding into the next — the array used to survive every
       start because nothing but a fresh save emptied it. */
    const existing = get().data;
    /* A start that is not the run the exit walked out of must not inherit its wounds:
       restarting at a different wave, or a different mode, drops the record here so the
       scene never sees a stale number. (An exact match is consumed and cleared by the
       scene that takes it.) */
    if (existing?.resumeRun && (existing.resumeRun.mode !== mode || existing.resumeRun.wave !== startWave)) {
      get().mutate((draft) => {
        draft.resumeRun = null;
      }, { immediate: true });
    }
    if (existing && existing.runBuffs.length > 0) {
      get().mutate((draft) => {
        draft.runBuffs = [];
      }, { immediate: true });
    }
    set({
      run: {
        startedAt: Date.now(),
        mode,
        startWave,
        wavesCleared: 0,
        enemiesDefeated: 0,
        bossesDefeated: 0,
        shotsCountered: 0,
        essenceGained: 0,
        shardsGained: 0,
        relicsGained: 0,
        highestHit: 0,
        unlocked: [],
        totalDamage: 0,
      },
    });
    get().mutate((draft) => {
      draft.stats.runsStarted += 1;
    });
  },

  onWaveCleared: (args) => {
    const run = get().run;
    if (run) {
      run.wavesCleared += 1;
      // Essence lands through `onLoot` (one writer); this one stays out of it.
      run.shardsGained += args.shards ?? 0;
    }
    applyWaveClear(get, set, args);
  },

  onBossDefeated: (args) => {
    const run = get().run;
    if (run) {
      run.bossesDefeated += 1;
      run.essenceGained += args.essence;
    }
    applyBossDefeat(get, set, args);
  },

  onPlayerDeath: () => {
    get().mutate((draft) => {
      draft.stats.deaths += 1;
    }, { immediate: true });
  },

  onCheckpoint: (bossId, floor, wave) => {
    markCheckpoint(get, set, bossId, floor, wave);
  },

  onLoot: (drop) => {
    const run = get().run;
    if (run) {
      if (drop.kind === 'essence') run.essenceGained += drop.amount;
      if (drop.kind === 'shard') run.shardsGained += drop.amount;
      if (drop.kind === 'relic') run.relicsGained += drop.amount;
    }
    get().mutate((draft) => {
      if (drop.kind === 'essence') {
        draft.progression.essence += drop.amount;
        draft.stats.essenceCollected += drop.amount;
      } else if (drop.kind === 'shard') {
        draft.progression.shards += drop.amount;
        draft.stats.shardsCollected += drop.amount;
      } else if (drop.kind === 'relic') {
        draft.progression.relicCores += drop.amount;
        draft.stats.relicsCollected += drop.amount;
        if (!draft.progression.relics.includes(drop.id)) draft.progression.relics.push(drop.id);
      }
    });
  },

  addMastery: (element, xp) => {
    if (xp <= 0) return;
    get().mutate((draft) => {
      addMasteryXpToSave(draft, element, xp);
    });
  },

  registerAttackUse: (element) => {
    get().mutate((draft) => {
      registerElementUsage(draft, element);
    }, { silent: false });
  },

  setLoadout: (slots, activeSlot) => {
    const current = get().data;
    if (!current) return { ok: false, reason: 'No active save.' };
    const filled = slots.filter(Boolean) as ElementId[];
    const unique = new Set(filled);
    if (filled.length === 0) return { ok: false, reason: 'At least one element must stay equipped.' };
    if (unique.size !== filled.length) return { ok: false, reason: 'Duplicate elements are not allowed.' };
    for (const id of filled) {
      if (!current.unlockedElements.includes(id)) {
        return { ok: false, reason: `${ELEMENT_REGISTRY[id].name} is not unlocked yet.` };
      }
    }
    get().mutate((draft) => {
      draft.loadout.slots = slots.slice(0, 6);
      while (draft.loadout.slots.length < 6) draft.loadout.slots.push(null);
      draft.loadout.activeSlot = slots[activeSlot] ? activeSlot : Math.max(0, slots.findIndex(Boolean));
    }, { immediate: true });
    return { ok: true };
  },

  setActiveSlotIndex: (index) => {
    const current = get().data;
    if (!current) return;
    if (!current.loadout.slots[index]) return;
    get().mutate((draft) => {
      draft.loadout.activeSlot = index;
    }, { immediate: true });
  },

  focusUnlockElement: (element) => {
    const current = get().data;
    if (!current) return { ok: false, reason: 'No active save.' };
    const eligibility = shardUnlockEligible(element, current.unlockedElements, current.progression.shards);
    if (!eligibility.ok) return { ok: false, reason: eligibility.reason };
    get().mutate((draft) => {
      draft.progression.shards -= eligibility.cost;
      draft.unlockedElements.push(element);
      if (!draft.discoveredElements.includes(element)) draft.discoveredElements.push(element);
      if (!draft.mastery[element]) draft.mastery[element] = { level: 1, xp: 0 };
    }, { immediate: true });
    const reason = `Focused with ${eligibility.cost} shards`;
    useUiStore.getState().claimUnlockMoment(element, reason);
    gameBus.emit('game:elementUnlocked', { element, reason });
    return { ok: true, reason: `${ELEMENT_REGISTRY[element].name} unlocked.` };
  },

  completeStory: () => {
    get().mutate((draft) => {
      draft.story.completed = true;
      draft.freeModeUnlocked = true;
      draft.ascension.unlocked = true;
      draft.story.highestWave = Math.max(draft.story.highestWave, 200);
      draft.progression.hallLevel = Math.max(draft.progression.hallLevel, 10);
    }, { immediate: true });
  },

  recordAscensionWave: (wave) => {
    get().mutate((draft) => {
      if (wave > draft.ascension.highestWave) draft.ascension.highestWave = wave;
      draft.ascension.cycle = Math.floor((wave - 1) / 200);
      draft.stats.highestAscensionWave = Math.max(draft.stats.highestAscensionWave, wave);
    });
  },

  setFreeModeConfig: (config) => {
    get().mutate((draft) => {
      draft.freeMode = { ...draft.freeMode, ...config };
    }, { immediate: true });
  },

  setStoryWave: (wave) => {
    get().mutate((draft) => {
      draft.story.currentWave = clamp(Math.round(wave), 1, 200);
      draft.story.currentFloor = clamp(Math.ceil(draft.story.currentWave / 20), 1, 10);
    });
  },

  addPlaytime: (ms) => {
    if (ms <= 0) return;
    get().mutate((draft) => {
      draft.profile.playtime += ms / 1000;
      draft.stats.playtimeMs += ms;
    }, { immediate: true });
  },

  rebaseRunBuffs: (now) => {
    /* A buff's `expiresAt` is a *scene clock* value, and `startGameplay(true)` — the
       checkpoint/resume path — hands the new scene a clock that starts at 0. Rebased
       against that clock, `remaining` (which the scene keeps in step, once a second)
       is the only thing that survives a restart honestly; anything already spent is
       dropped instead of being revived for the length of the previous run. */
    const data = get().data;
    if (!data || data.runBuffs.length === 0) return;
    const rebased = data.runBuffs
      /* Both gates, in the same order `liveRunBuffs` applies them: an entry that never had
         an expiry (a save written before buffs were timed) is already over, and a new lease
         must not be granted to it here — that would resurrect exactly what the loader drops. */
      .filter((buff) => buff.expiresAt > 0 && buff.remaining > 0)
      .map((buff) => ({ ...buff, expiresAt: now + Math.round(buff.remaining * 1000) }));
    const unchanged =
      rebased.length === data.runBuffs.length &&
      rebased.every((buff, i) => buff.expiresAt === data.runBuffs[i].expiresAt);
    if (unchanged) return;
    get().mutate((draft) => {
      draft.runBuffs = rebased;
    });
  },

  finishRun: (cause, extra) => {
    const { data, run } = get();
    if (!data) return null;
    const tracker: RunTracker =
      run ?? {
        startedAt: Date.now(),
        mode: 'story',
        startWave: data.story.currentWave,
        wavesCleared: 0,
        enemiesDefeated: 0,
        bossesDefeated: 0,
        shotsCountered: 0,
        essenceGained: 0,
        shardsGained: 0,
        relicsGained: 0,
        highestHit: 0,
        unlocked: [],
        totalDamage: 0,
      };

    const summary: RunSummary = {
      mode: tracker.mode,
      wave: extra?.wave ?? data.story.currentWave,
      floor: extra?.floor ?? data.story.currentFloor,
      wavesCleared: tracker.wavesCleared,
      enemiesDefeated: tracker.enemiesDefeated,
      bossesDefeated: tracker.bossesDefeated,
      essenceGained: tracker.essenceGained,
      highestHit: tracker.highestHit,
      durationMs: Date.now() - tracker.startedAt,
      checkpoint: data.checkpoint
        ? `${data.checkpoint.bossName} — Wave ${data.checkpoint.wave}`
        : extra?.checkpoint ?? null,
      unlocked: tracker.unlocked.map((id) => ELEMENT_REGISTRY[id as ElementId]?.name ?? id),
      endedAt: Date.now(),
      cause,
      ...extra,
    };

    get().mutate((draft) => {
      draft.stats.runEndings = [...draft.stats.runEndings, summary].slice(-12);
      /* The run owned these. Left in the save they read as live on every hub screen
         that derives stats (their clock is meaningless out here), which is how a
         30-second buff used to become the number a purchase was made against. */
      draft.runBuffs = [];
      /* Only a walk-away is resumable. A death or a completed story has to start the next
         attempt whole, and clearing here is what makes that true without every caller
         having to remember to do it. */
      if (cause !== 'exit') draft.resumeRun = null;
      // The run is over: credit the time it lasted exactly once, here, so every
      // ending (death, exit, completion) contributes to playtime.
      if (run) {
        draft.profile.playtime += Math.max(0, summary.durationMs) / 1000;
        draft.stats.playtimeMs += Math.max(0, summary.durationMs);
      }
    }, { immediate: true });

    set({ run: null });
    return summary;
  },

  markHallLevel: (level) => {
    get().mutate((draft) => {
      draft.progression.hallLevel = Math.max(draft.progression.hallLevel, level);
    }, { immediate: true });
  },

  resetProgress: () => {
    const current = get().data;
    if (!current) return;
    get().mutate((draft) => {
      draft.story = {
        highestWave: 1,
        currentWave: 1,
        currentFloor: 1,
        completed: false,
        clearedWaves: [],
        storyBossesDefeated: [],
        replayableBosses: [],
      };
      draft.checkpoint = null;
      draft.ascension = { unlocked: false, highestWave: 0, cycle: 0, runs: 0 };
      draft.freeModeUnlocked = false;
      draft.stats = {
        ...draft.stats,
        wavesCompleted: 0,
        highestStoryWave: 1,
        highestAscensionWave: 0,
        runEndings: [],
      };
      draft.achievements = [];
    }, { immediate: true });
  },
}));
