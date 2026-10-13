import { create } from 'zustand';
import type { ElementId, RunSummary } from '@/types';

/** Every navigable state in the interface. */
export type Screen =
  | 'boot'
  | 'mainmenu'
  | 'slotselect'
  | 'newgame'
  | 'hub'
  | 'playing'
  | 'loadout'
  | 'codex'
  | 'skilltree'
  | 'freemode'
  | 'statistics'
  | 'achievements'
  | 'settings';

export type PauseTab = 'root' | 'elements' | 'skilltree' | 'settings';

/**
 * The full-screen menus a live run can open from its pause card.
 *
 * One list, three consumers: the shell keeps the canvas mounted across exactly
 * these screens, the gameplay scene freezes the simulation while one of them is
 * up, and Escape closes them instead of toggling the pause flag. The list used to
 * be spelled out twice — once in `App.tsx`, once in the scene — which is how a
 * screen could be added that un-froze the run underneath it.
 */
export const RUN_SUBSCREENS: readonly Screen[] = ['loadout', 'codex', 'skilltree', 'statistics', 'achievements'];

/** True while `screen` is one of the run's full-screen menus. */
export function isRunSubscreen(screen: Screen): boolean {
  return RUN_SUBSCREENS.includes(screen);
}

export interface TransitionContent {
  kind: 'floor' | 'boss' | 'checkpoint' | 'victory' | 'ascension';
  title: string;
  subtitle?: string;
  lines: { label: string; value: string }[];
  accent: string;
  /** Continue button label. */
  action: string;
  /**
   * Present when the beat is a chapter change: the interface then renders it as
   * an event (display typography, environment brief) instead of a dialog.
   */
  chapter?: ChapterTransitionData;
}

export interface ChapterTransitionData {
  floorNumber: number;
  name: string;
  tagline: string;
  hazardLabel: string;
  hazardBrief: string;
  wardens: string[];
  signals: string[];
  previous: string;
  wave: number;
  ascensionCycle: number;
}

export interface Toast {
  id: number;
  title: string;
  body?: string;
  color: string;
  glyph?: string;
}

/**
 * The §29 unlock moment: one element gets the celebration at a time, so a wave
 * that hands out two elements shows the first properly and toasts the second.
 */
export interface UnlockMoment {
  element: ElementId;
  reason: string;
  /** Claimed at — the card times its own dismissal from this, no per-frame tick. */
  at: number;
}

interface UiState {
  screen: Screen;
  /** Navigation stack — `back()` pops the previous screen. */
  history: Screen[];
  previousScreen: Screen;
  /**
   * 1 when navigation went deeper, -1 when it came back. Screens read this to
   * choose the direction of their enter animation, which is what makes a menu
   * hierarchy feel like a place rather than a stack of pages.
   */
  navigationDirection: 1 | -1;
  paused: boolean;
  pauseTab: PauseTab;
  deathOpen: boolean;
  summary: RunSummary | null;
  transition: TransitionContent | null;
  toasts: Toast[];
  /** Active unlock celebration, or null. */
  unlockMoment: UnlockMoment | null;
  fps: number;
  debugOpen: boolean;
  /** Id of the save slot the interface is currently working with. */
  workingSlot: number;
  /** Bumped whenever a new run is requested so the scene can hot-restart. */
  runToken: number;

  navigate: (screen: Screen) => void;
  back: () => void;
  /** Clears the navigation stack and jumps straight to a screen. */
  resetTo: (screen: Screen) => void;
  setPaused: (paused: boolean, tab?: PauseTab) => void;
  setPauseTab: (tab: PauseTab) => void;
  setDeathOpen: (open: boolean) => void;
  setSummary: (summary: RunSummary | null) => void;
  setTransition: (transition: TransitionContent | null) => void;
  pushToast: (toast: Omit<Toast, 'id'>) => void;
  /** Takes the unlock slot for this element; false when another moment holds it. */
  claimUnlockMoment: (element: ElementId, reason: string) => boolean;
  clearUnlockMoment: () => void;
  dismissToast: (id: number) => void;
  setFps: (fps: number) => void;
  toggleDebug: () => void;
  setWorkingSlot: (slot: number) => void;
  startRun: () => void;
  closeAllOverlays: () => void;
}

let toastId = 0;

export const useUiStore = create<UiState>((set, get) => ({
  screen: 'boot',
  history: [],
  previousScreen: 'mainmenu',
  paused: false,
  pauseTab: 'root',
  deathOpen: false,
  summary: null,
  transition: null,
  toasts: [],
  unlockMoment: null,
  fps: 60,
  debugOpen: false,
  workingSlot: 0,
  runToken: 0,
  navigationDirection: 1,

  navigate: (screen) =>
    set((state) => ({
      screen,
      previousScreen: state.screen,
      navigationDirection: 1,
      history: state.screen === screen ? state.history : [...state.history, state.screen].slice(-16),
    })),

  back: () =>
    set((state) => {
      if (state.history.length === 0) return { screen: 'mainmenu', previousScreen: 'mainmenu', navigationDirection: -1 };
      const history = state.history.slice(0, -1);
      return {
        screen: state.history[state.history.length - 1],
        history,
        previousScreen: history[history.length - 1] ?? 'mainmenu',
        navigationDirection: -1,
      };
    }),

  resetTo: (screen) => set({ screen, history: [], previousScreen: 'mainmenu', navigationDirection: 1 }),

  setPaused: (paused, tab) =>
    set({ paused, pauseTab: tab ?? (paused ? 'root' : get().pauseTab) }),

  setPauseTab: (pauseTab) => set({ pauseTab }),

  setDeathOpen: (deathOpen) => set({ deathOpen }),

  setSummary: (summary) => set({ summary }),

  setTransition: (transition) => set({ transition }),

  claimUnlockMoment: (element, reason) => {
    if (get().unlockMoment) return false;
    set({ unlockMoment: { element, reason, at: Date.now() } });
    return true;
  },
  clearUnlockMoment: () => set({ unlockMoment: null }),

  pushToast: (toast) => {
    toastId += 1;
    const entry: Toast = { ...toast, id: toastId };
    const toasts = [...get().toasts, entry].slice(-4);
    set({ toasts });
    window.setTimeout(() => {
      const current = get().toasts;
      if (current.some((t) => t.id === entry.id)) {
        set({ toasts: current.filter((t) => t.id !== entry.id) });
      }
    }, 5200);
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  setFps: (fps) => set({ fps }),

  toggleDebug: () => set({ debugOpen: !get().debugOpen }),

  setWorkingSlot: (workingSlot) => set({ workingSlot }),

  startRun: () =>
    set((state) => ({
      runToken: state.runToken + 1,
      screen: 'playing',
      previousScreen: state.screen,
      history: [...state.history, state.screen].slice(-16),
      paused: false,
      deathOpen: false,
      summary: null,
      transition: null,
    })),

  closeAllOverlays: () =>
    set({ paused: false, deathOpen: false, summary: null, transition: null, unlockMoment: null }),
}));

/* Narrow selectors — avoids re-rendering components for unrelated changes. */
export const selectScreen = (s: UiState) => s.screen;
export const selectToasts = (s: UiState) => s.toasts;
export const selectPaused = (s: UiState) => s.paused;
export const selectTransition = (s: UiState) => s.transition;
export const selectSummary = (s: UiState) => s.summary;
export const selectUnlockMoment = (s: UiState) => s.unlockMoment;
export const selectDeathOpen = (s: UiState) => s.deathOpen;
