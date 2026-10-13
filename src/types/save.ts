import type { ElementId } from './element';

export const SAVE_VERSION = 4;
export const SAVE_SLOT_COUNT = 3;

export type GameMode = 'story' | 'free' | 'ascension';

export interface SaveProfile {
  name: string;
  /** Starter chosen at new game — attached to the save forever. */
  starter: ElementId;
  createdAt: number;
  lastPlayed: number;
  /** Accumulated playtime in seconds. */
  playtime: number;
}

export interface LoadoutState {
  /** Exactly six slots; `null` renders as an empty socket. */
  slots: (ElementId | null)[];
  activeSlot: number;
}

export type MasteryMap = Partial<Record<ElementId, { level: number; xp: number }>>;

export interface Checkpoint {
  bossId: string;
  bossName: string;
  floor: number;
  wave: number;
  /** Wave the player resumes at. */
  respawnWave: number;
  createdAt: number;
}

export interface StoryProgress {
  highestWave: number;
  currentWave: number;
  currentFloor: number;
  completed: boolean;
  /** Tracks every wave cleared at least once — used for Free Mode. */
  clearedWaves: number[];
  /** Bosses beaten at least once in story mode (one-time rule). */
  storyBossesDefeated: string[];
  /** Bosses unlocked for Free Mode replay. */
  replayableBosses: string[];
}

export interface AscensionProgress {
  unlocked: boolean;
  highestWave: number;
  cycle: number;
  runs: number;
}

export interface RelicState {
  id: string;
  acquiredAt: number;
}

export interface StatBlock {
  wavesCompleted: number;
  enemiesDefeated: number;
  bossesDefeated: number;
  totalDamage: number;
  highestHit: number;
  deaths: number;
  essenceCollected: number;
  shardsCollected: number;
  relicsCollected: number;
  /**
   * Times a shot of the player's knocked a hostile bolt out of the air, lifetime. Written by the scene's
   * counter rule, read by one achievement — the only new stat this round, and the reason it exists is that
   * "the counter is a mechanic now, not an element's side effect" needs a number somewhere to be true.
   */
  projectilesCountered: number;
  /** Milliseconds of playtime. */
  playtimeMs: number;
  elementUsage: Partial<Record<ElementId, number>>;
  highestStoryWave: number;
  highestAscensionWave: number;
  runsStarted: number;
  runEndings: RunSummary[];
}

export interface RunSummary {
  mode: GameMode;
  wave: number;
  floor: number;
  wavesCleared: number;
  enemiesDefeated: number;
  bossesDefeated: number;
  essenceGained: number;
  highestHit: number;
  durationMs: number;
  checkpoint: string | null;
  unlocked: string[];
  endedAt: number;
  cause: 'death' | 'exit' | 'complete';
}

export interface AchievementState {
  id: string;
  unlockedAt: number | null;
  progress: number;
}

export interface SettingsState {
  masterVolume: number;
  sfxVolume: number;
  musicVolume: number;
  screenShake: boolean;
  damageNumbers: boolean;
  pixelEffects: boolean;
  reducedMotion: boolean;
  highContrast: boolean;
  autoAim: number;
  graphicsQuality: 'low' | 'medium' | 'high';
  showTouchControls: 'auto' | 'always' | 'never';
  showFps: boolean;
  /**
   * Multiplies HUD and menu text/controls. `user-scalable=no` is deliberate in
   * the viewport tag (a pinch during a fight is a dropped input), so this is
   * the supported way to make the chrome bigger on a small phone.
   */
  hudScale: number;
  /** Vibration on impact, damage and unlocks. Ignored where unsupported. */
  haptics: boolean;
}

export interface SaveData {
  version: number;
  slot: number;
  profile: SaveProfile;
  /** Starter is permanent, this is the live unlocked set. */
  unlockedElements: ElementId[];
  /** Elements that have ever been discovered (codex reveal). */
  discoveredElements: ElementId[];
  mastery: MasteryMap;
  loadout: LoadoutState;
  /** Permanent stat bonuses from relics and milestones. */
  progression: {
    bonusHp: number;
    bonusEnergy: number;
    bonusAttack: number;
    bonusDefense: number;
    bonusCrit: number;
    bonusMoveSpeed: number;
    bonusCooldownReduction: number;
    essence: number;
    shards: number;
    relicCores: number;
    /** Relic ids held. */
    relics: string[];
    /** Highest boss hall unlocked. */
    hallLevel: number;
  };
  story: StoryProgress;
  ascension: AscensionProgress;
  freeModeUnlocked: boolean;
  checkpoint: Checkpoint | null;
  achievements: AchievementState[];
  stats: StatBlock;
  /** Free-mode-only preferences (never affects story). */
  freeMode: {
    floor: number;
    startWave: number;
    bossId: string | null;
    difficulty: 'normal' | 'veteran' | 'nightmare';
  };
  /**
   * Buffs collected in the run in progress. A buff is a window inside a run: the save
   * carries them so a restart or a mid-run loadout edit sees the same clock, and the run
   * end empties the list (`finishRun`) — they were never meant to be shown in the hub.
   */
  runBuffs: {
    id: string;
    name: string;
    /** Seconds left, for the HUD. Counted down by the scene, not by a frame loop. */
    remaining: number;
    /** Scene clock (ms) at which this buff stops being applied. 0 means "already over". */
    expiresAt: number;
    magnitude: number;
    stat: string;
  }[];
  /**
   * The run that SAVE & EXIT stepped out of. The warden's health is the one part of a live
   * run the save used not to carry, so quitting to the hub and coming back handed back a
   * full bar — a free heal for the price of closing the menu, and enough to rewrite the
   * pacing of any fight worth leaving. Written only by an exit, dropped by everything else
   * (a death or a checkpoint start is meant to begin whole), and consumed once by the scene
   * that starts at the same wave.
   */
  resumeRun: {
    mode: GameMode;
    /** The wave the run was *started* at — what CONTINUE asks for to match. */
    wave: number;
    /** Hit points the warden was standing on when the frame was left. */
    hp: number;
  } | null;
}

export interface SaveSlotMeta {
  slot: number;
  empty: boolean;
  name: string;
  starter: ElementId | null;
  highestWave: number;
  floor: number;
  unlockedCount: number;
  highestAscensionWave: number;
  playtime: number;
  lastPlayed: number;
  /** Set when the save file failed validation and was replaced by a default. */
  corrupted: boolean;
}

export interface SaveFile {
  version: number;
  slots: (SaveData | null)[];
  lastSlot: number;
  globalAchievements: Record<string, number>;
}
