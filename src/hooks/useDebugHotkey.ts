import { useEffect } from 'react';
import { DEBUG_CONFIG } from '@/config/gameConfig';
import { useUiStore } from '@/store/uiStore';

/**
 * Wires the developer hotkey (F2 by default) to the debug panel.
 *
 * The listener is only registered in builds where `DEBUG_CONFIG.enabled` is
 * true, so production bundles contain no reachable path to the panel and no
 * stray key handler.
 */
export function useDebugHotkey(): void {
  useEffect(() => {
    if (!DEBUG_CONFIG.enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== DEBUG_CONFIG.key) return;
      event.preventDefault();
      useUiStore.getState().toggleDebug();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
