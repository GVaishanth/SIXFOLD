import { create } from 'zustand';
import type { SettingsState } from '@/types';
import { DEFAULT_SETTINGS, loadSettings, persistSettings } from '@/app/saveService';
import { audioEngine } from '@/game/systems/audio';

interface SettingsStore extends SettingsState {
  hydrate: () => void;
  set: <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => void;
  toggle: (
    key: 'screenShake' | 'damageNumbers' | 'pixelEffects' | 'reducedMotion' | 'highContrast' | 'showFps' | 'haptics',
  ) => void;
  reset: () => void;
}

function applyToAudio(state: SettingsState): void {
  audioEngine.setVolumes({
    master: state.masterVolume,
    sfx: state.sfxVolume,
    music: state.musicVolume,
  });
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  ...DEFAULT_SETTINGS,

  hydrate: () => {
    const settings = loadSettings();
    set({ ...settings });
    applyToAudio(settings);
  },

  set: (key, value) => {
    set({ [key]: value } as Pick<SettingsState, typeof key>);
    const next = get();
    const snapshot: SettingsState = {
      masterVolume: next.masterVolume,
      sfxVolume: next.sfxVolume,
      musicVolume: next.musicVolume,
      screenShake: next.screenShake,
      damageNumbers: next.damageNumbers,
      pixelEffects: next.pixelEffects,
      reducedMotion: next.reducedMotion,
      highContrast: next.highContrast,
      autoAim: next.autoAim,
      graphicsQuality: next.graphicsQuality,
      showTouchControls: next.showTouchControls,
      showFps: next.showFps,
      hudScale: next.hudScale,
      haptics: next.haptics,
    };
    persistSettings(snapshot);
    applyToAudio(snapshot);
  },

  toggle: (key) => {
    set({ [key]: !get()[key] } as Pick<SettingsState, typeof key>);
    const next = get();
    persistSettings({
      masterVolume: next.masterVolume,
      sfxVolume: next.sfxVolume,
      musicVolume: next.musicVolume,
      screenShake: next.screenShake,
      damageNumbers: next.damageNumbers,
      pixelEffects: next.pixelEffects,
      reducedMotion: next.reducedMotion,
      highContrast: next.highContrast,
      autoAim: next.autoAim,
      graphicsQuality: next.graphicsQuality,
      showTouchControls: next.showTouchControls,
      showFps: next.showFps,
      hudScale: next.hudScale,
      haptics: next.haptics,
    });
  },

  reset: () => {
    set({ ...DEFAULT_SETTINGS });
    persistSettings(DEFAULT_SETTINGS);
    applyToAudio(DEFAULT_SETTINGS);
  },
}));

/* Selectors kept narrow so components re-render only for what they read. */
export const selectVolumes = (s: SettingsStore) => ({
  masterVolume: s.masterVolume,
  sfxVolume: s.sfxVolume,
  musicVolume: s.musicVolume,
});
export const selectScreenShake = (s: SettingsStore) => s.screenShake;
export const selectReducedMotion = (s: SettingsStore) => s.reducedMotion;
export const selectHighContrast = (s: SettingsStore) => s.highContrast;
export const selectHudScale = (s: SettingsStore) => s.hudScale;
export const selectHaptics = (s: SettingsStore) => s.haptics;
