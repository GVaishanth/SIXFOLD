import { SAVE_SLOT_COUNT, SAVE_VERSION } from '@/types';
import type {
  AchievementState,
  AscensionProgress,
  Checkpoint,
  ElementId,
  GameMode,
  LoadoutState,
  MasteryMap,
  RunSummary,
  SaveData,
  SaveSlotMeta,
  SettingsState,
  StatBlock,
  StoryProgress,
} from '@/types';
import { ELEMENT_REGISTRY, STARTER_ELEMENT_IDS } from '@/data/elements';
import { PICKUP_CONFIG, SAVE_CONFIG } from '@/config/gameConfig';
import { clamp, safeInt, safeNumber } from '@/utils/math';

/**
 * Save schema, validation and migration.
 *
 * `validateSaveData` is intentionally forgiving: it repairs what it can and
 * only discards a save entirely when the payload is not an object at all. The
 * game must never crash because localStorage contains something unexpected.
 */

export const DEFAULT_SETTINGS: SettingsState = {
  masterVolume: 0.7,
  sfxVolume: 0.85,
  musicVolume: 0.35,
  screenShake: true,
  damageNumbers: true,
  pixelEffects: true,
  reducedMotion: false,
  highContrast: false,
  autoAim: 0.65,
  graphicsQuality: 'high',
  showTouchControls: 'auto',
  showFps: false,
  hudScale: 1,
  haptics: true,
};

function isElementId(value: unknown): value is ElementId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ELEMENT_REGISTRY, value);
}

export function defaultStoryProgress(): StoryProgress {
  return {
    highestWave: 1,
    currentWave: 1,
    currentFloor: 1,
    completed: false,
    clearedWaves: [],
    storyBossesDefeated: [],
    replayableBosses: [],
  };
}

export function defaultAscension(): AscensionProgress {
  return { unlocked: false, highestWave: 0, cycle: 0, runs: 0 };
}

export function defaultStats(): StatBlock {
  return {
    wavesCompleted: 0,
    enemiesDefeated: 0,
    bossesDefeated: 0,
    totalDamage: 0,
    highestHit: 0,
    deaths: 0,
    essenceCollected: 0,
    shardsCollected: 0,
    relicsCollected: 0,
    projectilesCountered: 0,
    playtimeMs: 0,
    elementUsage: {},
    highestStoryWave: 1,
    highestAscensionWave: 0,
    runsStarted: 0,
    runEndings: [],
  };
}

export function defaultLoadout(starter: ElementId): LoadoutState {
  const slots: (ElementId | null)[] = [starter, null, null, null, null, null];
  return { slots, activeSlot: 0 };
}

export function defaultSaveData(slot: number, name: string, starter: ElementId): SaveData {
  const now = Date.now();
  return {
    version: SAVE_VERSION,
    slot,
    profile: {
      name: name.trim().slice(0, 16) || 'Wanderer',
      starter,
      createdAt: now,
      lastPlayed: now,
      playtime: 0,
    },
    unlockedElements: [starter],
    discoveredElements: [starter],
    mastery: { [starter]: { level: 1, xp: 0 } },
    loadout: defaultLoadout(starter),
    progression: {
      bonusHp: 0,
      bonusEnergy: 0,
      bonusAttack: 0,
      bonusDefense: 0,
      bonusCrit: 0,
      bonusMoveSpeed: 0,
      bonusCooldownReduction: 0,
      essence: 0,
      shards: 0,
      relicCores: 0,
      relics: [],
      hallLevel: 0,
    },
    story: defaultStoryProgress(),
    ascension: defaultAscension(),
    freeModeUnlocked: false,
    checkpoint: null,
    achievements: [],
    stats: defaultStats(),
    freeMode: { floor: 1, startWave: 1, bossId: null, difficulty: 'normal' },
    runBuffs: [],
    resumeRun: null,
  };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function validateMastery(raw: unknown): MasteryMap {
  const out: MasteryMap = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isElementId(key)) continue;
    const entry = (value ?? {}) as Record<string, unknown>;
    out[key] = {
      level: safeInt(entry.level, 1, 1, 10),
      xp: safeNumber(entry.xp, 0, 0, 10_000_000),
    };
  }
  return out;
}

function validateLoadout(raw: unknown, unlocked: ElementId[], starter: ElementId): LoadoutState {
  const source = (raw ?? {}) as Record<string, unknown>;
  const rawSlots = Array.isArray(source.slots) ? source.slots : [];
  const slots: (ElementId | null)[] = [];
  const seen = new Set<ElementId>();
  for (let i = 0; i < 6; i += 1) {
    const candidate = rawSlots[i];
    if (isElementId(candidate) && unlocked.includes(candidate) && !seen.has(candidate)) {
      slots.push(candidate);
      seen.add(candidate);
    } else {
      slots.push(null);
    }
  }
  if (!slots.some(Boolean)) slots[0] = starter;
  const activeSlot = safeInt(source.activeSlot, 0, 0, 5);
  return {
    slots,
    activeSlot: slots[activeSlot] ? activeSlot : Math.max(0, slots.findIndex(Boolean)),
  };
}

function validateCheckpoint(raw: unknown): Checkpoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  if (typeof source.bossId !== 'string' || !source.bossId) return null;
  return {
    bossId: source.bossId,
    bossName: typeof source.bossName === 'string' ? source.bossName : 'Unknown Warden',
    floor: safeInt(source.floor, 1, 1, 10),
    wave: safeInt(source.wave, 1, 1, 1_000_000),
    respawnWave: safeInt(source.respawnWave, 1, 1, 1_000_000),
    createdAt: safeInt(source.createdAt, Date.now(), 0),
  };
}

function validateAchievements(raw: unknown): AchievementState[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string')
    .map((entry) => {
      const source = entry as Record<string, unknown>;
      return {
        id: source.id as string,
        unlockedAt: typeof source.unlockedAt === 'number' ? source.unlockedAt : null,
        progress: safeNumber(source.progress, 0, 0, 1_000_000),
      };
    });
}

function validateRunEndings(raw: unknown): RunSummary[] {
  if (!Array.isArray(raw)) return [];
  const modes: GameMode[] = ['story', 'free', 'ascension'];
  return raw
    .filter((entry) => entry && typeof entry === 'object')
    .slice(-12)
    .map((entry) => {
      const source = entry as Record<string, unknown>;
      const cause = source.cause;
      return {
        mode: modes.includes(source.mode as GameMode) ? (source.mode as GameMode) : 'story',
        wave: safeInt(source.wave, 1, 1, 10_000_000),
        floor: safeInt(source.floor, 1, 1, 10),
        wavesCleared: safeInt(source.wavesCleared, 0, 0, 10_000_000),
        enemiesDefeated: safeInt(source.enemiesDefeated, 0, 0, 10_000_000),
        bossesDefeated: safeInt(source.bossesDefeated, 0, 0, 1_000_000),
        essenceGained: safeInt(source.essenceGained, 0, 0, 10_000_000),
        highestHit: safeNumber(source.highestHit, 0, 0),
        durationMs: safeNumber(source.durationMs, 0, 0),
        checkpoint: typeof source.checkpoint === 'string' ? source.checkpoint : null,
        unlocked: Array.isArray(source.unlocked)
          ? source.unlocked.filter((id): id is string => typeof id === 'string')
          : [],
        endedAt: safeNumber(source.endedAt, Date.now(), 0),
        cause: cause === 'exit' || cause === 'complete' || cause === 'death' ? cause : 'death',
      };
    });
}

function validateStats(raw: unknown): StatBlock {
  const base = defaultStats();
  if (!raw || typeof raw !== 'object') return base;
  const source = raw as Record<string, unknown>;
  const usage: Partial<Record<ElementId, number>> = {};
  if (source.elementUsage && typeof source.elementUsage === 'object') {
    for (const [key, value] of Object.entries(source.elementUsage as Record<string, unknown>)) {
      if (isElementId(key)) usage[key] = safeInt(value, 0, 0, 1_000_000_000);
    }
  }
  return {
    wavesCompleted: safeInt(source.wavesCompleted, base.wavesCompleted, 0),
    enemiesDefeated: safeInt(source.enemiesDefeated, base.enemiesDefeated, 0),
    bossesDefeated: safeInt(source.bossesDefeated, base.bossesDefeated, 0),
    totalDamage: safeNumber(source.totalDamage, 0, 0),
    highestHit: safeNumber(source.highestHit, 0, 0),
    deaths: safeInt(source.deaths, 0, 0),
    essenceCollected: safeInt(source.essenceCollected, 0, 0),
    shardsCollected: safeInt(source.shardsCollected, 0, 0),
    relicsCollected: safeInt(source.relicsCollected, 0, 0),
    projectilesCountered: safeInt(source.projectilesCountered, 0, 0),
    playtimeMs: safeNumber(source.playtimeMs, 0, 0),
    elementUsage: usage,
    highestStoryWave: safeInt(source.highestStoryWave, 1, 1, 10_000_000),
    highestAscensionWave: safeInt(source.highestAscensionWave, 0, 0, 10_000_000),
    runsStarted: safeInt(source.runsStarted, 0, 0),
    runEndings: validateRunEndings(source.runEndings),
  };
}

export interface ValidationResult {
  data: SaveData;
  repaired: boolean;
}

/** Coerce a raw localStorage payload into a valid SaveData object. */
/** The record SAVE & EXIT leaves behind; see `SaveData.resumeRun`. */
function validateResumeRun(raw: unknown): SaveData['resumeRun'] {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as { mode?: unknown; wave?: unknown; hp?: unknown };
  const mode = record.mode;
  if (mode !== 'story' && mode !== 'free' && mode !== 'ascension') return null;
  const wave = safeNumber(record.wave, 1, 1);
  const hp = safeNumber(record.hp, 0, 0);
  if (wave < 1 || hp <= 0) return null;
  return { mode, wave: Math.floor(wave), hp: Math.round(hp) };
}

export function validateSaveData(raw: unknown, slot: number, fallbackName = 'Wanderer'): ValidationResult {
  let repaired = false;
  if (!raw || typeof raw !== 'object') {
    return { data: defaultSaveData(slot, fallbackName, 'fire'), repaired: true };
  }
  const source = raw as Record<string, unknown>;

  const rawProfile = (source.profile ?? {}) as Record<string, unknown>;
  const starterCandidate = rawProfile.starter;
  const starter: ElementId = isElementId(starterCandidate) && STARTER_ELEMENT_IDS.includes(starterCandidate)
    ? starterCandidate
    : 'fire';
  if (starter !== starterCandidate) repaired = true;

  const unlockedRaw = Array.isArray(source.unlockedElements) ? source.unlockedElements : [];
  const unlocked = Array.from(
    new Set(
      unlockedRaw.filter(isElementId).concat(starter).concat(
        (Array.isArray(source.discoveredElements) ? source.discoveredElements : []).filter(
          (id): id is ElementId => isElementId(id) && STARTER_ELEMENT_IDS.includes(id),
        ),
      ),
    ),
  );
  if (unlocked.length !== unlockedRaw.length) repaired = true;

  const discoveredRaw = Array.isArray(source.discoveredElements)
    ? source.discoveredElements.filter(isElementId)
    : [];
  const discovered = Array.from(new Set([...discoveredRaw, ...unlocked, starter]));

  const rawProgression = (source.progression ?? {}) as Record<string, unknown>;
  const rawStory = (source.story ?? {}) as Record<string, unknown>;
  const rawAscension = (source.ascension ?? {}) as Record<string, unknown>;

  const story: StoryProgress = {
    highestWave: safeInt(rawStory.highestWave, 1, 1, 10_000_000),
    currentWave: safeInt(rawStory.currentWave, 1, 1, 10_000_000),
    currentFloor: safeInt(rawStory.currentFloor, 1, 1, 10),
    completed: rawStory.completed === true,
    clearedWaves: Array.isArray(rawStory.clearedWaves)
      ? rawStory.clearedWaves
          .map((w) => safeInt(w, 0, 0, 10_000_000))
          .filter((w) => w > 0)
          .slice(-220)
      : [],
    storyBossesDefeated: Array.isArray(rawStory.storyBossesDefeated)
      ? rawStory.storyBossesDefeated.filter((id): id is string => typeof id === 'string')
      : [],
    replayableBosses: Array.isArray(rawStory.replayableBosses)
      ? rawStory.replayableBosses.filter((id): id is string => typeof id === 'string')
      : [],
  };
  if (story.currentWave > story.highestWave + 1) {
    story.currentWave = story.highestWave;
    repaired = true;
  }
  story.currentFloor = clamp(Math.ceil(story.currentWave / 20), 1, 10);

  const ascension: AscensionProgress = {
    unlocked: rawAscension.unlocked === true || story.completed,
    highestWave: safeInt(rawAscension.highestWave, 0, 0, 10_000_000),
    cycle: safeInt(rawAscension.cycle, 0, 0, 50_000),
    runs: safeInt(rawAscension.runs, 0, 0, 1_000_000),
  };

  const freeModeRaw = (source.freeMode ?? {}) as Record<string, unknown>;
  const difficulty = freeModeRaw.difficulty;
  const freeMode = {
    floor: safeInt(freeModeRaw.floor, 1, 1, 10),
    startWave: safeInt(freeModeRaw.startWave, 1, 1, 200),
    bossId: typeof freeModeRaw.bossId === 'string' ? freeModeRaw.bossId : null,
    difficulty: (difficulty === 'veteran' || difficulty === 'nightmare'
      ? difficulty
      : 'normal') as 'normal' | 'veteran' | 'nightmare',
  };

  const data: SaveData = {
    version: SAVE_VERSION,
    slot,
    profile: {
      name:
        typeof rawProfile.name === 'string' && rawProfile.name.trim().length > 0
          ? rawProfile.name.trim().slice(0, 16)
          : fallbackName,
      starter,
      createdAt: safeNumber(rawProfile.createdAt, Date.now(), 0),
      lastPlayed: safeNumber(rawProfile.lastPlayed, Date.now(), 0),
      playtime: safeNumber(rawProfile.playtime, 0, 0),
    },
    unlockedElements: unlocked,
    discoveredElements: discovered,
    mastery: validateMastery(source.mastery),
    loadout: validateLoadout(source.loadout, unlocked, starter),
    progression: {
      bonusHp: safeNumber(rawProgression.bonusHp, 0, 0),
      bonusEnergy: safeNumber(rawProgression.bonusEnergy, 0, 0),
      bonusAttack: safeNumber(rawProgression.bonusAttack, 0, 0),
      bonusDefense: safeNumber(rawProgression.bonusDefense, 0, 0),
      bonusCrit: safeNumber(rawProgression.bonusCrit, 0, 0),
      bonusMoveSpeed: safeNumber(rawProgression.bonusMoveSpeed, 0, 0),
      bonusCooldownReduction: safeNumber(rawProgression.bonusCooldownReduction, 0, 0, 0.6),
      essence: safeInt(rawProgression.essence, 0, 0, 1_000_000_000),
      shards: safeInt(rawProgression.shards, 0, 0, 1_000_000),
      relicCores: safeInt(rawProgression.relicCores, 0, 0, 1_000_000),
      relics: Array.isArray(rawProgression.relics)
        ? rawProgression.relics.filter((id): id is string => typeof id === 'string')
        : [],
      hallLevel: safeInt(rawProgression.hallLevel, 0, 0, 20),
    },
    story,
    ascension,
    freeModeUnlocked: story.completed || source.freeModeUnlocked === true,
    checkpoint: validateCheckpoint(source.checkpoint),
    achievements: validateAchievements(source.achievements),
    stats: validateStats(source.stats),
    freeMode,
    /*
     * A staged resume has to survive a load to be worth having, so it is rebuilt from the
     * raw record rather than trusted: only the three modes, a wave that exists, and a
     * positive finite HP. Anything else is "no resume", which is the safe reading.
     */
    resumeRun: validateResumeRun(source.resumeRun),
    runBuffs: Array.isArray(source.runBuffs)
      ? source.runBuffs
          .filter(
            (buff): buff is Record<string, unknown> =>
              Boolean(buff) && typeof buff === 'object' && typeof (buff as { id?: unknown }).id === 'string',
          )
          .map((buff) => {
            const id = String(buff.id);
            return {
              id,
              name: typeof buff.name === 'string' ? buff.name : id,
              remaining: safeNumber(buff.remaining, 0, 0),
              expiresAt: safeNumber(buff.expiresAt, 0, 0),
              magnitude: safeNumber(buff.magnitude, 0, 0),
              stat: typeof buff.stat === 'string' ? buff.stat : '',
            };
          })
          /* A buff without an expiry is a permanent stat, and that is what let the old
             run buffs leak across runs and saves (docs/STATS_GAMEPLAY_FAULTS.md §A3).
             Anything that cannot expire is dropped rather than trusted, and the stack
             is capped the same way the scene caps it on pickup. */
          .filter((buff) => buff.expiresAt > 0)
          .slice(0, PICKUP_CONFIG.maxBuffs)
      : [],
  };

  if (typeof source.version !== 'number' || source.version !== SAVE_VERSION) repaired = true;
  return { data, repaired };
}

/* ------------------------------------------------------------------ */
/* Migration                                                           */
/* ------------------------------------------------------------------ */

type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;

/**
 * Version migrations. Each key N transforms a version-N payload into version
 * N+1. Older saves are stepped forward one version at a time, then validated.
 */
export const MIGRATIONS: Record<number, Migration> = {
  1: (raw) => ({
    ...raw,
    unlockedElements: Array.isArray(raw.unlockedElements) ? raw.unlockedElements : [],
    discoveredElements: Array.isArray(raw.discoveredElements) ? raw.discoveredElements : [],
    resumeRun: null,
    version: 2,
  }),
  2: (raw) => ({
    ...raw,
    mastery: raw.mastery ?? {},
    runBuffs: [],
    resumeRun: null,
    version: 3,
  }),
  3: (raw) => {
    const story = (raw.story ?? {}) as Record<string, unknown>;
    return {
      ...raw,
      story: { ...story, replayableBosses: story.replayableBosses ?? [] },
      stats: raw.stats ?? defaultStats(),
      version: 4,
    };
  },
};

export function migrateSave(raw: Record<string, unknown>): { data: Record<string, unknown>; migrated: boolean } {
  let current = raw;
  let version = safeInt(current.version, 1, 1, SAVE_VERSION);
  let migrated = false;
  while (version < SAVE_VERSION) {
    const migration = MIGRATIONS[version];
    if (!migration) break;
    current = migration(current);
    version = safeInt(current.version, version + 1, 1, SAVE_VERSION);
    migrated = true;
  }
  return { data: current, migrated };
}

/* ------------------------------------------------------------------ */
/* Slot metadata + file helpers                                        */
/* ------------------------------------------------------------------ */

export function slotMeta(slot: number, data: SaveData | null, corrupted = false): SaveSlotMeta {
  if (!data) {
    return {
      slot,
      empty: true,
      name: 'Empty Slot',
      starter: null,
      highestWave: 0,
      floor: 1,
      unlockedCount: 0,
      highestAscensionWave: 0,
      playtime: 0,
      lastPlayed: 0,
      corrupted,
    };
  }
  return {
    slot,
    empty: false,
    name: data.profile.name,
    starter: data.profile.starter,
    highestWave: data.story.highestWave,
    floor: data.story.currentFloor,
    unlockedCount: data.unlockedElements.length,
    highestAscensionWave: data.ascension.highestWave,
    playtime: data.profile.playtime,
    lastPlayed: data.profile.lastPlayed,
    corrupted,
  };
}

export interface SaveFileShape {
  version: number;
  slots: (SaveData | null)[];
  lastSlot: number;
  globalAchievements: Record<string, number>;
}

export function emptySaveFile(): SaveFileShape {
  return {
    version: SAVE_VERSION,
    slots: Array.from({ length: SAVE_SLOT_COUNT }, () => null),
    lastSlot: 0,
    globalAchievements: {},
  };
}

/** Repair an entire save file object, filling in anything missing. */
export function validateSaveFile(raw: unknown): { file: SaveFileShape; repaired: boolean } {
  if (!raw || typeof raw !== 'object') {
    return { file: emptySaveFile(), repaired: true };
  }
  const source = raw as Record<string, unknown>;
  let repaired = false;
  let payload: Record<string, unknown> = source;

  const version = safeInt(source.version, SAVE_VERSION, 1, SAVE_VERSION);
  if (version < SAVE_VERSION) {
    const result = migrateSave(source);
    payload = result.data;
    repaired = repaired || result.migrated;
  }

  const rawSlots = Array.isArray(payload.slots) ? payload.slots : [];
  const slots: (SaveData | null)[] = [];
  for (let i = 0; i < SAVE_SLOT_COUNT; i += 1) {
    const entry = rawSlots[i];
    if (!entry || typeof entry !== 'object') {
      slots.push(null);
      continue;
    }
    const { data, repaired: slotRepaired } = validateSaveData(entry, i);
    slots.push(data);
    if (slotRepaired) repaired = true;
  }

  const globalAchievements: Record<string, number> = {};
  if (payload.globalAchievements && typeof payload.globalAchievements === 'object') {
    for (const [key, value] of Object.entries(payload.globalAchievements as Record<string, unknown>)) {
      globalAchievements[key] = safeNumber(value, 0, 0);
    }
  }

  return {
    file: {
      version: SAVE_VERSION,
      slots,
      lastSlot: safeInt(payload.lastSlot, 0, 0, SAVE_SLOT_COUNT - 1),
      globalAchievements,
    },
    repaired,
  };
}

export function validateSettings(raw: unknown): SettingsState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS };
  const source = raw as Record<string, unknown>;
  const quality = source.graphicsQuality;
  const touch = source.showTouchControls;
  return {
    masterVolume: safeNumber(source.masterVolume, DEFAULT_SETTINGS.masterVolume, 0, 1),
    sfxVolume: safeNumber(source.sfxVolume, DEFAULT_SETTINGS.sfxVolume, 0, 1),
    musicVolume: safeNumber(source.musicVolume, DEFAULT_SETTINGS.musicVolume, 0, 1),
    screenShake: source.screenShake !== false,
    damageNumbers: source.damageNumbers !== false,
    pixelEffects: source.pixelEffects !== false,
    reducedMotion: source.reducedMotion === true,
    highContrast: source.highContrast === true,
    autoAim: safeNumber(source.autoAim, DEFAULT_SETTINGS.autoAim, 0, 1),
    graphicsQuality: quality === 'low' || quality === 'medium' ? quality : 'high',
    showTouchControls: touch === 'always' || touch === 'never' ? touch : 'auto',
    showFps: source.showFps === true,
    // An old save has no key here at all, and a hand-edited one could have any
    // number in it: clamp rather than trust.
    hudScale: safeNumber(source.hudScale, DEFAULT_SETTINGS.hudScale, 0.85, 1.45),
    haptics: source.haptics !== false,
  };
}

export const SAVE_STORAGE_KEY = SAVE_CONFIG.key;
export const SETTINGS_STORAGE_KEY = SAVE_CONFIG.settingsKey;
