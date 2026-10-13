import { useEffect } from 'react';
import { useSettingsStore } from '@/store/settingsStore';
import { setHapticsEnabled } from '@/utils/haptics';

/**
 * Mirrors the accessibility preferences onto the document element.
 *
 * CSS owns the actual behaviour (`.high-contrast`, `.reduced-motion`, the
 * `data-quality` attribute and `--hud-scale`), which keeps the settings screen
 * declarative and means the effects survive React re-renders without extra state.
 * Device capabilities (vibration) are pushed into their util here for the same
 * reason: the store stays free of platform code and the platform module stays
 * free of the store.
 */
export function useAccessibilityDocument(): void {
  const highContrast = useSettingsStore((s) => s.highContrast);
  const reducedMotion = useSettingsStore((s) => s.reducedMotion);
  const graphicsQuality = useSettingsStore((s) => s.graphicsQuality);
  const hudScale = useSettingsStore((s) => s.hudScale);
  const haptics = useSettingsStore((s) => s.haptics);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('high-contrast', highContrast);
    root.classList.toggle('reduced-motion', reducedMotion);
  }, [highContrast, reducedMotion]);

  useEffect(() => {
    document.documentElement.dataset.quality = graphicsQuality;
  }, [graphicsQuality]);

  useEffect(() => {
    // One write, consumed by every calc(... * var(--hud-scale)) rule in the HUD
    // and by the coarse-pointer control sizes.
    document.documentElement.style.setProperty('--hud-scale', String(hudScale));
  }, [hudScale]);

  useEffect(() => {
    setHapticsEnabled(haptics);
  }, [haptics]);
}
