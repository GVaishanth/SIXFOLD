import { create } from 'zustand';
import type { ElementId, GameMode } from '@/types';

/**
 * Live run snapshot.
 *
 * Phaser publishes this at a low fixed rate (see `PERFORMANCE.hudTextHz`), so
 * the React HUD re-renders a handful of times per second instead of every
 * frame. Nothing gameplay-critical lives here — the Phaser world owns truth.
 */
export interface RunSnapshot {
  mode: GameMode;
  wave: number;
  localWave: number;
  cycle: number;
  floor: number;
  floorName: string;
  waveLabel: string;
  enemiesRemaining: number;
  waveTotal: number;
  isBossWave: boolean;
  isCountdown: boolean;
  countdown: number;
  bossId: string | null;
  bossName: string;
  bossTitle: string;
  bossHp: number;
  bossMaxHp: number;
  bossPhase: string;
  hp: number;
  maxHp: number;
  energy: number;
  maxEnergy: number;
  shield: number;
  dashReady: number;
  skillReady: number;
  ultimateReady: number;
  slots: (ElementId | null)[];
  activeSlot: number;
  /**
   * The support elements — everything equipped that is not in hand — with their
   * charge and accuracy, so the rail can show what the player is not steering.
   */
  auto: { slot: number; element: ElementId; level: number; accuracy: number; charge: number }[];
  activeElement: ElementId | null;
  essenceRun: number;
  shardsRun: number;
  enemyCount: number;
  /** Active statuses on the player, for the HUD chip row (TL quadrant). */
  statuses: { id: string; stacks: number; ratio: number; color: string }[];
  /** Milliseconds since the run started — the TR timer. */
  elapsedMs: number;
  playerAlive: boolean;
  respawnAvailable: boolean;
  fps: number;
  /** Which world this run is. `strip` means the generated dungeon, which owns no wave ladder. */
  runKind: 'waves' | 'strip';
  /** 0..1 walked, for the strip's depth plate; wave runs leave it at 0. */
  depth: number;
  /** Sites still untouched, by kind. The strip's only honest "what is left". */
  sitesLeft: { grove: number; cache: number; spring: number; field: number; den: number; waypoint: number } | null;
  /** The partner's readout, or null when there is nobody beside the player. */
  partner: { hp: number; maxHp: number; state: string; carrying: number } | null;
  /** One entry per strip cell, for the minimap: biome accent, sites there, sites already used. */
  /**
   * One entry per circuit cell, for the plan the HUD folds out of it: the cell's own corridor as flat
   * [fx, fy] fractions of that cell, where the party is, and what is still standing in it.
   */
  stripCells: {
    accent: string;
    sites: number;
    cleared: number;
    here: boolean;
    goal: boolean;
    route: number[];
    you: { fx: number; fy: number } | null;
  }[] | null;
  /** True once the walk is in the centre of the labyrinth, which is the strip's one winning square. */
  stripAtCenter: boolean;
}

export const EMPTY_SNAPSHOT: RunSnapshot = {
  mode: 'story',
  wave: 1,
  localWave: 1,
  cycle: 0,
  floor: 1,
  floorName: 'Ember Ruins',
  waveLabel: 'First Contact',
  enemiesRemaining: 0,
  waveTotal: 0,
  isBossWave: false,
  isCountdown: false,
  countdown: 0,
  bossId: null,
  bossName: '',
  bossTitle: '',
  bossHp: 0,
  bossMaxHp: 0,
  bossPhase: '',
  hp: 100,
  maxHp: 100,
  energy: 100,
  maxEnergy: 100,
  shield: 0,
  dashReady: 1,
  skillReady: 1,
  ultimateReady: 0,
  slots: [null, null, null, null, null, null],
  activeSlot: 0,
  auto: [],
  activeElement: null,
  essenceRun: 0,
  shardsRun: 0,
  enemyCount: 0,
  statuses: [],
  elapsedMs: 0,
  playerAlive: true,
  respawnAvailable: false,
  fps: 60,
  runKind: 'waves',
  depth: 0,
  sitesLeft: null,
  partner: null,
  stripCells: null,
  stripAtCenter: false,
};

interface RunStore extends RunSnapshot {
  publish: (snapshot: Partial<RunSnapshot>) => void;
  reset: () => void;
}

export const useRunStore = create<RunStore>((set) => ({
  ...EMPTY_SNAPSHOT,
  publish: (snapshot) => set(snapshot),
  reset: () => set({ ...EMPTY_SNAPSHOT }),
}));

/* Fine-grained selectors so the HUD splits into cheap subtrees. */
export const selectVitals = (s: RunStore) => ({
  hp: s.hp,
  maxHp: s.maxHp,
  energy: s.energy,
  maxEnergy: s.maxEnergy,
  shield: s.shield,
  playerAlive: s.playerAlive,
});
export const selectWaveInfo = (s: RunStore) => ({
  wave: s.wave,
  localWave: s.localWave,
  cycle: s.cycle,
  floor: s.floor,
  floorName: s.floorName,
  waveLabel: s.waveLabel,
  enemiesRemaining: s.enemiesRemaining,
  waveTotal: s.waveTotal,
  isBossWave: s.isBossWave,
  countdown: s.countdown,
  isCountdown: s.isCountdown,
  mode: s.mode,
});
export const selectDebug = (s: RunStore) => ({
  fps: s.fps,
  enemyCount: s.enemyCount,
  wave: s.wave,
  localWave: s.localWave,
  cycle: s.cycle,
  hp: s.hp,
  maxHp: s.maxHp,
  energy: s.energy,
  maxEnergy: s.maxEnergy,
  activeElement: s.activeElement,
  floor: s.floor,
  essenceRun: s.essenceRun,
  shardsRun: s.shardsRun,
});
export const selectBoss = (s: RunStore) => ({
  bossId: s.bossId,
  bossName: s.bossName,
  bossTitle: s.bossTitle,
  bossHp: s.bossHp,
  bossMaxHp: s.bossMaxHp,
  bossPhase: s.bossPhase,
});
export const selectStatuses = (s: RunStore) => ({
  statuses: s.statuses,
  elapsedMs: s.elapsedMs,
  essenceRun: s.essenceRun,
  shardsRun: s.shardsRun,
});
export const selectCooldowns = (s: RunStore) => ({
  dashReady: s.dashReady,
  skillReady: s.skillReady,
  ultimateReady: s.ultimateReady,
});
/**
 * The registers a strip run owns: how far, what is left, who is beside you.
 *
 * A wave run reads `{ kind: 'waves' }` with the rest null, so the HUD can stand the plates down
 * without a second component tree.
 */
export const selectStrip = (s: RunStore) => ({
  kind: s.runKind,
  depth: s.depth,
  sitesLeft: s.sitesLeft,
  partner: s.partner,
  cells: s.stripCells,
  atCenter: s.stripAtCenter,
});
export const selectLoadout = (s: RunStore) => ({
  slots: s.slots,
  activeSlot: s.activeSlot,
  activeElement: s.activeElement,
  auto: s.auto,
});
