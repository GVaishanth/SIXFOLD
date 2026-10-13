import { useEffect, useRef } from 'react';
import { ACHIEVEMENTS } from '@/data/achievements';
import { ELEMENT_REGISTRY } from '@/data/elements';
import { gameBus } from '@/game/systems/eventBus';
import { useUiStore } from '@/store/uiStore';
import type { SaveData } from '@/types';

/**
 * Reactive notifications driven by save state and gameplay events.
 *
 * Achievement toasts are derived by diffing the achievement list rather than
 * trusting an event, so a toast can never fire twice for the same achievement
 * even if the save is written several times in a row.
 */
export function AchievementToasts({ data }: { data: SaveData | null }) {
  const pushToast = useUiStore((s) => s.pushToast);
  const seen = useRef<Set<string>>(new Set());
  const firstRun = useRef(true);

  useEffect(() => {
    if (!data) return;
    const unlockedNow = data.achievements.filter((entry) => entry.unlockedAt).map((entry) => entry.id);
    if (firstRun.current) {
      unlockedNow.forEach((id) => seen.current.add(id));
      firstRun.current = false;
      return;
    }
    for (const id of unlockedNow) {
      if (seen.current.has(id)) continue;
      seen.current.add(id);
      const def = ACHIEVEMENTS.find((entry) => entry.id === id);
      if (def) {
        pushToast({
          title: 'ACHIEVEMENT UNLOCKED',
          body: `${def.name} — ${def.description}`,
          color: '#F2C96B',
          glyph: def.glyph,
        });
      }
    }
  }, [data, pushToast]);

  useEffect(() => {
    const disposers = [
      gameBus.on('game:elementUnlocked', (payload) => {
        const def = ELEMENT_REGISTRY[payload.element as keyof typeof ELEMENT_REGISTRY];
        if (!def) return;
        // The unlock moment already names this element, its tier and its reason;
        // a toast underneath it repeats the same line in worse type.
        if (useUiStore.getState().unlockMoment?.element === payload.element) return;
        pushToast({
          title: 'ELEMENT DISCOVERED',
          body: `${def.name} — ${def.identity}`,
          color: def.color,
          glyph: def.symbol,
        });
      }),
      gameBus.on('game:bossPhase', (payload) => {
        if (!payload.banner) return;
        pushToast({
          title: payload.banner,
          body: 'The warden changes its pattern.',
          color: '#FF5C6C',
        });
      }),
      gameBus.on('game:ascensionUnlocked', () => {
        pushToast({
          title: 'ASCENSION UNLOCKED',
          body: 'The story is complete. Cycle 1 begins beyond wave 200.',
          color: '#C87BFF',
          glyph: '∞',
        });
      }),
      gameBus.on('game:error', (payload) => {
        console.error('[sixfold]', payload.where, payload.message);
      }),
    ];
    return () => disposers.forEach((dispose) => dispose());
  }, [pushToast]);

  return null;
}
