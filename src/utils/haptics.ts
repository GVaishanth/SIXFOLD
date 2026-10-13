/**
 * Haptics.
 *
 * The Vibration API is the only force-feedback channel a browser exposes, and it
 * is deliberately blunt: `navigator.vibrate(pattern)` in milliseconds, no
 * amplitude, no waveform. So the vocabulary here is small and mapped to the
 * graded impact tiers the combat system already computes — the point is that a
 * critical lands differently from a jab, not that every frame buzzes.
 *
 * Platform truth worth stating plainly: Chromium on Android implements this; iOS
 * Safari does not expose `navigator.vibrate` to web content at all, so on iPhone
 * every call here is a no-op and the game loses nothing else. Desktop Chrome
 * accepts the call but has no hardware, so fine pointers are skipped locally
 * rather than queued.
 *
 * Rate limiting matters more than it sounds: an ultimate can land a dozen
 * impacts in 200 ms, and thirteen buzzes read as a fault, not as feedback. The
 * strongest pattern within a window wins, and the window is short enough that a
 * deliberate sequence (a warden's phase change, an unlock) still plays in full.
 */

export type HapticPattern =
  | 'press'
  | 'switch'
  | 'skill'
  | 'crit'
  | 'ultimate'
  | 'bossPhase'
  | 'hurt'
  | 'death'
  | 'unlock'
  | 'deny';

/** Higher weight wins when two patterns collide inside the window. */
const PATTERNS: Record<HapticPattern, { weight: number; ms: number | number[] }> = {
  press: { weight: 1, ms: 8 },
  switch: { weight: 2, ms: 12 },
  skill: { weight: 3, ms: 16 },
  crit: { weight: 4, ms: [14, 24, 14] },
  hurt: { weight: 5, ms: [26, 40, 18] },
  ultimate: { weight: 6, ms: [22, 40, 34] },
  bossPhase: { weight: 7, ms: [30, 60, 22, 60, 40] },
  death: { weight: 8, ms: [60, 80, 120] },
  unlock: { weight: 6, ms: [12, 40, 24, 40, 60] },
  deny: { weight: 3, ms: [10, 30, 10] },
};

/** Patterns inside this window collapse to the strongest one. */
const WINDOW_MS = 90;

let enabled = true;
let lastAt = 0;
let lastWeight = 0;

/**
 * Presence of the API is the whole test, on purpose. A `(pointer: coarse)` check
 * looks more precise and is not: emulated and hybrid devices report it
 * inconsistently, and a mouse-only browser has no motor, so the call there
 * costs one no-op. A touch-capable laptop, conversely, *should* answer a heavy
 * hit — that is the device the media query would have wrongly excluded.
 */
function supported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

/** Driven by the settings store, so the util never imports React or the store. */
export function setHapticsEnabled(value: boolean): void {
  enabled = value;
}

export function hapticsSupported(): boolean {
  return supported();
}

/** One combat/menu beat. Safe to call from anywhere, including the render loop. */
export function pulse(pattern: HapticPattern): void {
  if (!enabled || !supported()) return;
  const spec = PATTERNS[pattern];
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (now - lastAt < WINDOW_MS && spec.weight <= lastWeight) return;
  lastAt = now;
  lastWeight = spec.weight;
  try {
    navigator.vibrate?.(spec.ms);
  } catch {
    // Some browsers throw when the document is not focused. Feedback is never
    // worth an exception path in a frame.
  }
}

/** Releases the motor (also clears a queued pattern). */
export function haltHaptics(): void {
  if (!supported()) return;
  try {
    navigator.vibrate?.(0);
  } catch {
    /* ignore */
  }
}
