import { useEffect, useRef } from 'react';
import { phaserHost } from '@/game/PhaserHost';
import { audioEngine } from '@/game/systems/audio';

/**
 * Host element for the single Phaser instance.
 *
 * The canvas is created once and kept alive for the whole session: switching
 * between the menu, the hub and a run only swaps scenes, which is what keeps
 * cold starts instant. Window blur, tab switches and lost visibility pause the
 * game through the same switch the overlays use.
 */
export function GameCanvas() {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = hostRef.current;
    if (!element) return;
    try {
      phaserHost.mount(element);
    } catch (error) {
      console.error('[sixfold] failed to start the renderer', error);
    }

    const onVisibility = () => {
      if (document.hidden) phaserHost.pauseForFocusLoss();
    };
    const onBlur = () => phaserHost.pauseForFocusLoss();
    const unlockAudio = () => audioEngine.unlock();

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('pointerdown', unlockAudio, { once: true });
    window.addEventListener('keydown', unlockAudio, { once: true });

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };
  }, []);

  return <div className="app-canvas-host" ref={hostRef} aria-hidden />;
}
