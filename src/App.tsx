import { Suspense, lazy, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { GameCanvas } from '@/components/game/GameCanvas';
import { AchievementToasts } from '@/components/hud/Toasts';
import { UnlockCelebration } from '@/components/hud/UnlockCelebration';
import { HudOverlay } from '@/components/hud/HudOverlay';
import { GameOverlays, ToastStack } from '@/components/hud/Overlays';
import { TouchControls } from '@/components/hud/TouchControls';
import { AchievementsScreen } from '@/components/screens/AchievementsScreen';
import { BootScreen } from '@/components/screens/BootScreen';
import { CodexScreen } from '@/components/screens/CodexScreen';
import { FreeModeScreen } from '@/components/screens/FreeModeScreen';
import { HubScreen } from '@/components/screens/HubScreen';
import { LoadoutScreen } from '@/components/screens/LoadoutScreen';
import { MainMenuScreen } from '@/components/screens/MainMenuScreen';
import { NewGameScreen } from '@/components/screens/NewGameScreen';
import { SettingsScreen } from '@/components/screens/SettingsScreen';
import { SkillTreeScreen } from '@/components/screens/SkillTreeScreen';
import { SlotSelectScreen } from '@/components/screens/SlotSelectScreen';
import { StatisticsScreen } from '@/components/screens/StatisticsScreen';
import { DEBUG_CONFIG } from '@/config/gameConfig';
import { useAccessibilityDocument } from '@/hooks/useAccessibilityDocument';
import { useElementTheme, useMotionPreference } from '@/hooks/useMotion';
import { useDebugHotkey } from '@/hooks/useDebugHotkey';
import { useSaveBridge } from '@/hooks/useSaveBridge';
import { useShowTouchControls } from '@/hooks/useShowTouchControls';
import { useRunStore } from '@/store/runStore';
import { useSaveStore } from '@/store/saveStore';
import { useSettingsStore } from '@/store/settingsStore';
import { RUN_SUBSCREENS, useUiStore, type Screen } from '@/store/uiStore';

/**
 * Application shell.
 *
 * Responsibilities, in order of importance:
 *  1. hydrate settings and the save file once, before anything else renders;
 *  2. keep the save file in step with gameplay events coming off the bus;
 *  3. decide which screen is visible and hold the single Phaser canvas.
 *
 * The debug panel is only ever pulled into the bundle in development builds.
 */
const DebugPanel = import.meta.env.DEV
  ? lazy(() => import('@/components/debug/DebugPanel').then((module) => ({ default: module.DebugPanel })))
  : null;

/* The canvas keeps its scene alive across the run's own menus; the list lives in
 * the store so the freeze rule and Escape read the same one. */
const GAMEPLAY_SCREENS: Screen[] = ['playing', ...RUN_SUBSCREENS];

export function App() {
  const screen = useUiStore((s) => s.screen);
  const highContrast = useSettingsStore((s) => s.highContrast);
  const pixelEffects = useSettingsStore((s) => s.pixelEffects);
  const hydrateSave = useSaveStore((s) => s.hydrate);
  const hydrateSettings = useSettingsStore((s) => s.hydrate);
  const data = useSaveStore(useShallow((s) => s.data));
  const hasRun = useUiStore((s) => s.runToken > 0);
  /* Primitives only, so the shell does not re-render on every HUD publish. */
  const runMode = useRunStore((s) => s.mode);
  const activeElement = useRunStore((s) => s.activeElement);

  /* Motion + element colours are published from the shell so every screen
     inherits the same easing contract and the same 25 palettes. */
  useMotionPreference();
  useElementTheme(activeElement ?? data?.loadout.slots[data.loadout.activeSlot] ?? null);

  /* ------------------------------------------------------------------ */
  /* One-time hydration                                                  */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    hydrateSettings();
    hydrateSave();
  }, [hydrateSave, hydrateSettings]);

  useSaveBridge();

  useAccessibilityDocument();
  useDebugHotkey();

  const showTouchControls = useShowTouchControls(screen);

  /* ------------------------------------------------------------------ */
  /* Screen routing                                                      */
  /* ------------------------------------------------------------------ */
  const renderScreen = () => {
    switch (screen) {
      case 'boot':
        return <BootScreen />;
      case 'mainmenu':
        return <MainMenuScreen />;
      case 'slotselect':
        return <SlotSelectScreen />;
      case 'newgame':
        return <NewGameScreen />;
      case 'hub':
        return <HubScreen />;
      case 'loadout':
        return <LoadoutScreen />;
      case 'codex':
        return <CodexScreen />;
      case 'skilltree':
        return <SkillTreeScreen />;
      case 'freemode':
        return <FreeModeScreen />;
      case 'statistics':
        return <StatisticsScreen />;
      case 'achievements':
        return <AchievementsScreen />;
      case 'settings':
        return <SettingsScreen />;
      case 'playing':
        return null;
      default:
        return null;
    }
  };

  const inGameplay = GAMEPLAY_SCREENS.includes(screen);

  return (
    <div
      className={`app ${highContrast ? 'high-contrast' : ''} ${pixelEffects ? '' : 'no-pixel-fx'}`}
      data-mode={runMode === 'story' ? 'story' : runMode}
    >
      <div className={`game-layer ${screen === 'playing' ? 'playing' : ''} ${showTouchControls ? 'touch-active' : ''}`}>
        {/* The canvas lives for the whole session so scene switches stay instant. */}
        <GameCanvas />
        {screen === 'playing' ? <HudOverlay /> : null}
        {showTouchControls ? <TouchControls /> : null}
      </div>

      {renderScreen()}

      <GameOverlays />
      <ToastStack />
      <AchievementToasts data={data} />
      <UnlockCelebration />
      {DebugPanel && DEBUG_CONFIG.enabled && hasRun ? (
        <Suspense fallback={null}>
          <DebugPanel />
        </Suspense>
      ) : null}

      {/* The overlay stack is closed any time the player leaves a run. */}
      {!inGameplay ? <ExitGuard /> : null}
    </div>
  );
}

/** Closes gameplay overlays when navigation moves away from the run. */
function ExitGuard() {
  const paused = useUiStore((s) => s.paused);
  const deathOpen = useUiStore((s) => s.deathOpen);
  const summary = useUiStore((s) => s.summary);
  const transition = useUiStore((s) => s.transition);
  useEffect(() => {
    if (paused || deathOpen || summary || transition) {
      useUiStore.getState().closeAllOverlays();
    }
  }, [paused, deathOpen, summary, transition]);
  return null;
}
