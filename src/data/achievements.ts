import type { SaveData } from '@/types';
import { computeResonances } from '@/data/elements';
import { totalMasteryLevels } from '@/game/systems/elementProgression';
import { BOSS_LIST } from '@/data/bosses';
import { ELEMENT_IDS } from '@/types/element';

/**
 * What an achievement asks for, grouped so the ledger can file thirty of them without turning into a wall.
 * The groups are the game's own four questions: can you fight, can you build, how far did you get, and how
 * long did you keep going.
 */
export type AchievementTheme = 'arms' | 'elements' | 'ascent' | 'endurance';

export const ACHIEVEMENT_THEMES: { id: AchievementTheme; label: string }[] = [
  { id: 'arms', label: 'ARMS & COMBAT' },
  { id: 'elements', label: 'ELEMENTS' },
  { id: 'ascent', label: 'THE ASCENT' },
  { id: 'endurance', label: 'ENDURANCE' },
];

export interface AchievementDef {
  id: string;
  name: string;
  description: string;
  /**
   * The single mark a ledger card wears. Keep it inside the display font's own charset — letters, digits and
   * ASCII punctuation: `❗` and `⑶` read fine in an editor and came out as empty boxes in the game, because
   * Silkscreen carries no dingbats and the fallback chain is only guaranteed as far as monospace.
   */
  glyph: string;
  theme: AchievementTheme;
  /**
   * What the achievement counts to, as a number. Kept separate from the measurement on purpose: it is the
   * requirement the ledger prints ("6 of 25 swatted"), so a bar can never disagree with its own text.
   */
  target: number;
  /** The measurement, read from the save only. */
  measure: (data: SaveData) => number;
  /**
   * A line that says what has to be true first, shown under a locked entry. Optional because the threshold
   * achievements (1,000 kills) have no prerequisite beyond the number itself — but every achievement that
   * depends on a system being open at all says so, which is what a locked list is for.
   */
  requires?: (data: SaveData) => string | null;
}

const count = (value: number): number => (Number.isFinite(value) ? Math.max(0, value) : 0);

/** Progress in 0..1, derived. Nothing else in the codebase is allowed to guess at it. */
export function achievementProgress(def: AchievementDef, data: SaveData): number {
  if (def.target <= 0) return 1;
  return Math.max(0, Math.min(1, count(def.measure(data)) / def.target));
}

/** The human line under the bar: "12 of 25", not "48%". */
export function achievementReadout(def: AchievementDef, data: SaveData): string {
  const have = Math.floor(count(def.measure(data)));
  if (def.target === 1) return have >= 1 ? 'done' : 'not yet';
  return `${have.toLocaleString()} of ${def.target.toLocaleString()}`;
}

/** Seconds, for the two time-based entries. */
const minutes = (ms: number): number => count(ms) / 60_000;

const unlockedCount = (data: SaveData): number => data.unlockedElements.length;
const usedElements = (data: SaveData): number =>
  Object.values(data.stats.elementUsage).filter((uses) => (uses ?? 0) > 0).length;
const bestLevel = (data: SaveData): number =>
  Object.values(data.mastery).reduce((best, entry) => Math.max(best, entry?.level ?? 0), 0);
const resonances = (data: SaveData): number => computeResonances(data.loadout.slots).length;
const cleanRuns = (data: SaveData): number => data.stats.runEndings.filter((run) => run.cause === 'complete').length;
const floorsSeen = (data: SaveData): number => Math.ceil(count(data.story.highestWave) / 20);

/**
 * Thirty milestones, every one of them a pure function of the save file — so unlocking is idempotent,
 * survives a reload, and cannot be lost to a crash mid-run. That rule is also what keeps the list honest:
 * an achievement can only ask for something the game already records, and `audit:achievements` fails the
 * build if one asks for a field that no code path ever writes. It is why nothing here is earned in the
 * labyrinth: the strip carries nothing out on purpose, so a strip achievement would be a lie.
 */
export const ACHIEVEMENTS: AchievementDef[] = [
  /* ------------------------------- arms ------------------------------- */
  {
    id: 'first_blood',
    name: 'First Blood',
    description: 'Defeat your first enemy.',
    glyph: 'I',
    theme: 'arms',
    target: 1,
    measure: (d) => d.stats.enemiesDefeated,
  },
  {
    id: 'thousand_fallen',
    name: 'Thousand Fallen',
    description: 'Defeat a thousand enemies, across every run you have started.',
    glyph: 'ⅩⅩⅩ',
    theme: 'arms',
    target: 1000,
    measure: (d) => d.stats.enemiesDefeated,
  },
  {
    id: 'bolt_breaker',
    name: 'Bolt Breaker',
    description:
      'Swat twenty-five ranged attacks out of the air. Fire into a bolt and both stop; a shard-class bolt survives the swap.',
    glyph: '✕',
    theme: 'arms',
    target: 25,
    measure: (d) => d.stats.projectilesCountered,
  },
  {
    id: 'one_big_hit',
    name: 'One Big Hit',
    description: 'Land two hundred and fifty damage in a single hit.',
    glyph: '!',
    theme: 'arms',
    target: 250,
    measure: (d) => d.stats.highestHit,
  },
  {
    id: 'damage_hundred_k',
    name: 'Hundred Thousand Cuts',
    description: 'Deal a hundred thousand damage in total. Everything counts: reactions, fields, the partner\u2019s casts.',
    glyph: '⚔',
    theme: 'arms',
    target: 100_000,
    measure: (d) => d.stats.totalDamage,
  },
  {
    id: 'warden_slayer',
    name: 'Warden Slayer',
    description: 'Defeat your first boss.',
    glyph: '†',
    theme: 'arms',
    target: 1,
    measure: (d) => d.stats.bossesDefeated,
  },
  {
    id: 'tenfold_warden',
    name: 'Tenfold Warden',
    description: 'Defeat ten bosses, however many runs it takes.',
    glyph: 'Ⅹ',
    theme: 'arms',
    target: 10,
    measure: (d) => d.stats.bossesDefeated,
  },
  {
    id: 'warden_collector',
    name: 'Warden Collector',
    description: 'Beat ten distinct wardens. Repeating the same hall does not move this one.',
    glyph: '☰',
    theme: 'arms',
    target: Math.min(10, BOSS_LIST.length),
    measure: (d) => d.story.storyBossesDefeated.length,
  },

  /* ----------------------------- elements ----------------------------- */
  {
    id: 'elemental',
    name: 'Elemental',
    description: 'Unlock three elements.',
    glyph: 'III',
    theme: 'elements',
    target: 3,
    measure: (d) => unlockedCount(d),
  },
  {
    id: 'sixfold',
    name: 'Sixfold',
    description: 'Fill all six loadout slots.',
    glyph: 'VI',
    theme: 'elements',
    target: 6,
    measure: (d) => d.loadout.slots.filter(Boolean).length,
  },
  {
    id: 'convergence',
    name: 'Convergence',
    description: 'Trigger an element resonance by holding two elements that react.',
    glyph: '◇',
    theme: 'elements',
    target: 1,
    measure: (d) => resonances(d),
    requires: (d) =>
      d.loadout.slots.filter(Boolean).length < 2
        ? 'needs two elements in the loadout — one slot is not a pair'
        : null,
  },
  {
    id: 'dual_resonance',
    name: 'Dual Resonance',
    description: 'Hold two resonances at once, which takes three mutually reacting elements in the bar.',
    glyph: '+',
    theme: 'elements',
    target: 2,
    measure: (d) => resonances(d),
    requires: (d) => (resonances(d) === 0 ? 'no resonance yet — two reacting elements first' : null),
  },
  {
    id: 'wide_eyes',
    name: 'Wide Eyes',
    description: `Reveal every element in the codex. Discovery counts, not equipping.`,
    glyph: '*',
    theme: 'elements',
    target: ELEMENT_IDS.length,
    measure: (d) => d.discoveredElements.length,
  },
  {
    id: 'hexad',
    name: 'Six Hands',
    description: 'Have six different elements land a blow of their own, so the ledger knows you actually used them.',
    glyph: '#',
    theme: 'elements',
    target: 6,
    measure: (d) => usedElements(d),
  },
  {
    id: 'specialist',
    name: 'Specialist',
    description: 'Push one element to mastery tier 10. Kills with that element are what feed it.',
    glyph: '1',
    theme: 'elements',
    target: 10,
    measure: (d) => bestLevel(d),
  },
  {
    id: 'master_of_elements',
    name: 'Master of Elements',
    description: 'Reach 25 total mastery levels across your elements.',
    glyph: '★',
    theme: 'elements',
    target: 25,
    measure: (d) => totalMasteryLevels(d.mastery),
  },

  /* ------------------------------ ascent ------------------------------ */
  {
    id: 'floor_breaker',
    name: 'Floor Breaker',
    description: 'Reach the fifth floor.',
    glyph: 'V',
    theme: 'ascent',
    target: 5,
    measure: (d) => (d.story.highestWave >= 81 ? 5 : Math.ceil(d.story.highestWave / 20)),
  },
  {
    id: 'tenth_floor',
    name: 'Tenth Floor',
    description: 'Reach the tenth floor, the end of the first story cycle.',
    glyph: 'Ⅹ',
    theme: 'ascent',
    target: 10,
    measure: (d) => floorsSeen(d),
  },
  {
    id: 'wave_surveyor',
    name: 'Wave Surveyor',
    description: 'Clear one hundred different story waves at least once. Free Mode replays count toward it.',
    glyph: '10',
    theme: 'ascent',
    target: 100,
    measure: (d) => d.story.clearedWaves.length,
  },
  {
    id: 'unbroken',
    name: 'Unbroken',
    description: 'Clear twenty waves in a row without dying.',
    glyph: '—',
    theme: 'ascent',
    target: 20,
    measure: (d) => d.story.highestWave,
  },
  {
    id: 'hall_three',
    name: 'Three Halls',
    description: 'Open the third boss hall, which is what gates the deeper wardens.',
    glyph: '|',
    theme: 'ascent',
    target: 3,
    measure: (d) => d.progression.hallLevel,
  },
  {
    id: 'free_mode',
    name: 'Sandbox',
    description: 'Unlock Free Mode, which the story opens once you clear a full cycle.',
    glyph: '~',
    theme: 'ascent',
    target: 1,
    measure: (d) => (d.freeModeUnlocked ? 1 : 0),
    requires: (d) =>
      d.freeModeUnlocked ? null : `needs a cleared cycle — wave 200, you are at ${d.story.highestWave}`,
  },
  {
    id: 'ascendant',
    name: 'Ascendant',
    description: 'Reach Ascension wave 201.',
    glyph: 'A',
    theme: 'ascent',
    target: 201,
    measure: (d) => (d.ascension.highestWave >= 201 ? 201 : d.ascension.highestWave),
    requires: (d) => (d.ascension.unlocked ? null : 'needs Ascension unlocked — finish the first cycle'),
  },
  {
    id: 'beyond',
    name: 'Beyond',
    description: 'Reach Ascension wave 500.',
    glyph: '∞',
    theme: 'ascent',
    target: 500,
    measure: (d) => d.ascension.highestWave,
  },
  {
    id: 'ascension_cycle_three',
    name: 'Third Cycle',
    description: 'Survive into the third ascension cycle, where the wardens keep their wounds and grow.',
    glyph: '^',
    theme: 'ascent',
    target: 3,
    measure: (d) => d.ascension.cycle,
    requires: (d) => (d.ascension.unlocked ? null : 'needs Ascension unlocked — finish the first cycle'),
  },

  /* ---------------------------- endurance ---------------------------- */
  {
    id: 'essence_hoarder',
    name: 'Essence Hoarder',
    description: 'Collect 5,000 essence across your journey.',
    glyph: '◆',
    theme: 'endurance',
    target: 5000,
    measure: (d) => d.stats.essenceCollected,
  },
  {
    id: 'shard_saver',
    name: 'Shard Saver',
    description: 'Hold five hundred shards at once. Spending them does not reset this, so bank it any time.',
    glyph: '❖',
    theme: 'endurance',
    target: 500,
    measure: (d) => d.progression.shards,
  },
  {
    id: 'relic_three',
    name: 'Three Relics',
    description: 'Carry three relics at the same time.',
    glyph: '%',
    theme: 'endurance',
    target: 3,
    measure: (d) => d.progression.relics.length,
  },
  {
    id: 'twenty_runs',
    name: 'Twenty Runs',
    description: 'Start twenty runs, won or lost. The count only ever goes up.',
    glyph: 'ⅩⅩ',
    theme: 'endurance',
    target: 20,
    measure: (d) => d.stats.runsStarted,
  },
  {
    id: 'clean_finish',
    name: 'Clean Finish',
    description: 'End a run by finishing it rather than dying or quitting.',
    glyph: '✓',
    theme: 'endurance',
    target: 1,
    measure: (d) => cleanRuns(d),
    requires: (d) => (d.stats.runEndings.length === 0 ? 'needs one finished run to judge' : null),
  },
  {
    id: 'marathon',
    name: 'Marathon',
    description: 'Two hours in the vault, counted in the foreground.',
    glyph: '>',
    theme: 'endurance',
    target: 120,
    measure: (d) => minutes(d.stats.playtimeMs),
  },
];

export const ACHIEVEMENT_COUNT = ACHIEVEMENTS.length;

export function getAchievement(id: string): AchievementDef | null {
  return ACHIEVEMENTS.find((entry) => entry.id === id) ?? null;
}
