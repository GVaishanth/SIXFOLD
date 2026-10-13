import { useMemo } from 'react';
import type { Screen } from '@/store/uiStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useTouchDevice } from '@/hooks/useTouchDevice';

/**
 * Decides whether the touch layer is visible: only during gameplay, and only
 * when the player asked for it (`always` / `never`) or the device looks like a
 * touch device (`auto`, the default).
 */
export function useShowTouchControls(screen: Screen): boolean {
  const touchDevice = useTouchDevice();
  const mode = useSettingsStore((s) => s.showTouchControls);

  return useMemo(() => {
    if (screen !== 'playing') return false;
    if (mode === 'always') return true;
    if (mode === 'never') return false;
    return touchDevice;
  }, [screen, mode, touchDevice]);
}
