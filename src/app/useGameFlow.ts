import { useCallback } from 'react';
import { floorForWave } from '@/data/floors';
import { gameBus } from '@/game/systems/eventBus';
import { phaserHost } from '@/game/PhaserHost';
import { setRunRequest, type RunRequest } from '@/game/runRequest';
import { audioEngine } from '@/game/systems/audio';
import { useSaveStore, type RunTracker } from '@/store/saveStore';
import { useUiStore } from '@/store/uiStore';
import { useRunStore } from '@/store/runStore';
import type { GameMode } from '@/types';

/**
 * Single place that decides how a run begins, resumes or ends.
 *
 * Every entry point (hub, free mode, ascension, respawn, floor transition)
 * funnels through `beginRun`, which records the request, updates the save file
 * and swaps the Phaser scene. That guarantees the interface and the simulation
 * always agree about which wave is being played.
 */
/**
 * Leaving mid-run is not a free heal: the health the warden was standing on is staged into the
 * save so CONTINUE re-enters the same wave at the same wound. `finishRun` drops the record for
 * every other cause, and the scene that consumes it clears it, so it is spent exactly once.
 */
function stageWalkAway(run: RunTracker): void {
  const vitals = useRunStore.getState();
  if (!Number.isFinite(vitals.hp) || vitals.hp <= 0) return;
  useSaveStore.getState().stageResumeRun({ mode: run.mode, wave: run.startWave, hp: vitals.hp });
}

export function useGameFlow() {
  const beginRun = useCallback((request: RunRequest) => {
    const save = useSaveStore.getState();
    const ui = useUiStore.getState();
    audioEngine.unlock();
    audioEngine.play('ui_click');
    save.beginRun(request.mode, request.startWave);
    setRunRequest(request);
    ui.setTransition(null);
    ui.setDeathOpen(false);
    ui.setSummary(null);
    ui.setPaused(false);
    ui.startRun();
    phaserHost.startGameplay(true);
  }, []);

  const startStory = useCallback(() => {
    const data = useSaveStore.getState().data;
    const checkpoint = data?.checkpoint;
    const startWave = data ? Math.max(1, data.story.currentWave) : 1;
    beginRun({
      mode: 'story',
      startWave,
      floorOverride: floorForWave(startWave),
      checkpointWave: checkpoint?.respawnWave,
      reason: 'continue',
    });
  }, [beginRun]);

  const startFromCheckpoint = useCallback(() => {
    const data = useSaveStore.getState().data;
    const checkpoint = data?.checkpoint;
    const wave = checkpoint ? checkpoint.respawnWave : 1;
    beginRun({
      mode: 'story',
      startWave: wave,
      floorOverride: floorForWave(wave),
      reason: 'checkpoint',
    });
  }, [beginRun]);

  const startFreeMode = useCallback(
    (options: { floor: number; startWave: number; bossId?: string | null; difficulty?: 'normal' | 'veteran' | 'nightmare' }) => {
      const save = useSaveStore.getState();
      save.setFreeModeConfig({
        floor: options.floor,
        startWave: options.startWave,
        bossId: options.bossId ?? null,
        difficulty: options.difficulty ?? 'normal',
      });
      // Tuned down from 1.8 / 1.35: the extra layers of health made a hard run
      // a chore instead of a test. Damage still rises with it (square rooted).
      const difficultyScale =
        options.difficulty === 'nightmare' ? 1.5 : options.difficulty === 'veteran' ? 1.2 : 1;
      beginRun({
        mode: 'free',
        startWave: options.startWave,
        floorOverride: options.floor,
        bossId: options.bossId ?? null,
        difficultyScale,
        reason: 'free',
      });
      useUiStore.getState().pushToast({
        title: 'FREE MODE',
        body: `Floor ${options.floor} · Wave ${options.startWave}${options.difficulty && options.difficulty !== 'normal' ? ` · ${options.difficulty.toUpperCase()}` : ''}`,
        color: '#F2C96B',
      });
    },
    [beginRun],
  );

  const startAscension = useCallback(
    (wave?: number) => {
      const data = useSaveStore.getState().data;
      const targetWave = wave ?? Math.max(201, (data?.ascension.highestWave ?? 200) + 1);
      beginRun({
        mode: 'ascension',
        startWave: targetWave,
        floorOverride: floorForWave(((targetWave - 1) % 200) + 1),
        reason: 'ascension',
      });
      useRunStore.getState().publish({ mode: 'ascension' as GameMode });
    },
    [beginRun],
  );

  /**
   * Open a generated strip.
   *
   * This deliberately does not go through `beginRun`: that call is where story progress, run
   * statistics, the resume record and the playtime clock are opened, and the mode's bargain is that a
   * strip changes none of them. The seed rides on the request so a report card can be replayed
   * (design §3); leaving it out uses the generator's default, which is what the map gate asserts.
   */
  const startDungeon = useCallback((seed?: number) => {
    audioEngine.unlock();
    audioEngine.play('ui_click');
    setRunRequest({
      mode: 'story',
      startWave: 1,
      kind: 'strip',
      seed: seed ?? null,
      reason: 'new',
    });
    const ui = useUiStore.getState();
    ui.setTransition(null);
    ui.setDeathOpen(false);
    ui.setSummary(null);
    ui.setPaused(false);
    ui.startRun();
    phaserHost.startDungeon();
  }, []);

  const returnToHub = useCallback((cause: 'death' | 'exit' = 'exit') => {
    const save = useSaveStore.getState();
    const ui = useUiStore.getState();
    const data = save.data;
    if (save.run && cause === 'exit') stageWalkAway(save.run);
    // finishRun() credits playtime and writes the slot immediately.
    if (save.run) save.finishRun(cause, { wave: data?.story.currentWave ?? 1, floor: data?.story.currentFloor ?? 1 });
    ui.setPaused(false);
    ui.setDeathOpen(false);
    ui.setSummary(null);
    ui.setTransition(null);
    audioEngine.play('ui_back');
    phaserHost.stopGameplay();
    ui.resetTo('hub');
  }, []);

  const returnToMainMenu = useCallback(() => {
    const ui = useUiStore.getState();
    phaserHost.showMainMenu();
    ui.setPaused(false);
    ui.setDeathOpen(false);
    ui.setSummary(null);
    ui.setTransition(null);
    ui.resetTo('mainmenu');
  }, []);

  const resumeFromTransition = useCallback(() => {
    useUiStore.getState().setTransition(null);
    useUiStore.getState().setDeathOpen(false);
    audioEngine.play('ui_click');
    phaserHost.startGameplay(true);
  }, []);

  const respawn = useCallback(() => {
    useUiStore.getState().setDeathOpen(false);
    useUiStore.getState().setSummary(null);
    gameBus.emit('command:respawn', undefined);
  }, []);

  const saveAndExit = useCallback(() => {
    const save = useSaveStore.getState();
    if (save.run) {
      const data = save.data;
      stageWalkAway(save.run);
      save.finishRun('exit', { wave: data?.story.currentWave ?? 1, floor: data?.story.currentFloor ?? 1 });
    }
    save.flush();
    useUiStore.getState().pushToast({
      title: 'SAVED',
      body: 'Progress stored locally.',
      color: '#6BE39A',
    });
    returnToMainMenu();
  }, [returnToMainMenu]);

  return {
    beginRun,
    startStory,
    startFromCheckpoint,
    startFreeMode,
    startAscension,
    startDungeon,
    returnToHub,
    returnToMainMenu,
    resumeFromTransition,
    respawn,
    saveAndExit,
  };
}
