import { useEffect } from 'react';
import { gameBus } from '@/game/systems/eventBus';
import { audioEngine } from '@/game/systems/audio';
import { useSaveStore } from '@/store/saveStore';
import { useUiStore } from '@/store/uiStore';

/**
 * Bridges gameplay events into the save store.
 *
 * The scene owns simulation events and writes the save directly for wave
 * clears, boss defeats, checkpoints and deaths. Only the events that need
 * interface-side bookkeeping travel over the bus: loot, autosave flushes,
 * readiness and error reporting. Anything added here must not already be
 * handled by the scene, or progress would be counted twice.
 */
export function useSaveBridge(): void {
  useEffect(() => {
    const disposers = [
      gameBus.on('game:loot', (payload) => {
        useSaveStore.getState().onLoot({ id: payload.id, amount: payload.amount, kind: payload.kind });
      }),
      gameBus.on('game:requestAutosave', () => {
        useSaveStore.getState().flush();
      }),
      gameBus.on('game:ready', () => {
        audioEngine.unlock();
      }),
      gameBus.on('game:hallUpgrade', (payload) => {
        useUiStore.getState().pushToast({
          title: `HALL UPGRADE — FLOOR ${payload.floor}`,
          body: `+${payload.hp} HP · +${payload.attack.toFixed(2)} ATK · +${payload.defense.toFixed(
            2,
          )} DEF · +${(payload.crit * 100).toFixed(2)}% CRIT`,
          color: '#F2C96B',
        });
      }),
      gameBus.on('game:error', (payload) => {
        useUiStore.getState().pushToast({
          title: 'RECOVERED FROM AN ERROR',
          body: payload.message,
          color: '#FF5C6C',
        });
        console.error('[sixfold]', payload.where, payload.message);
      }),
    ];
    return () => disposers.forEach((dispose) => dispose());
  }, []);
}
