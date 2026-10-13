import { useEffect, useState } from 'react';

/**
 * True when the browser reports a coarse pointer or touch support.
 *
 * Used to decide whether the on-screen stick and action buttons should be
 * offered by default. It is *not* treated as a hard switch: the settings screen
 * can force touch controls on or off, and a keyboard or mouse plugged into a
 * tablet still works.
 */
export function useTouchDevice(): boolean {
  const [touchDevice, setTouchDevice] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(pointer: coarse)');
    const detect = () => setTouchDevice(query.matches || 'ontouchstart' in window);
    detect();
    const listener = (event: MediaQueryListEvent) => setTouchDevice(event.matches);
    query.addEventListener?.('change', listener);
    return () => query.removeEventListener?.('change', listener);
  }, []);

  return touchDevice;
}
