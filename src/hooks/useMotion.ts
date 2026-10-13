import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { ELEMENT_REGISTRY } from '@/data/elements';
import { useSettingsStore } from '@/store/settingsStore';
import { useUiStore } from '@/store/uiStore';
import type { ElementId } from '@/types';
import { deny, enterScreen, hoverIn, hoverOut, isReducedMotion, press, release, setReducedMotion, success } from '@/utils/motion';

/**
 * Motion + interaction glue.
 *
 * These hooks are the only place React talks to GSAP: a screen mounts and
 * animates in, a control reports press and hover, a refused action shakes once.
 * Components stay declarative and no animation is re-implemented per screen.
 */

/** Keeps the motion engine in step with the accessibility setting. */
export function useMotionPreference(): boolean {
  const reducedMotion = useSettingsStore((s) => s.reducedMotion);
  const systemReduced = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
    [],
  );
  const reduced = reducedMotion || systemReduced;

  useEffect(() => {
    setReducedMotion(reduced);
    document.documentElement.dataset.reducedMotion = reduced ? 'true' : 'false';
  }, [reduced]);

  return reduced;
}

/**
 * Publishes every element colour as a CSS custom property (`--el-fire`,
 * `--el-fire-2`, …) so data stays the only source of truth for the 25
 * elemental gradients. Also mirrors the active element to `--el-active`.
 */
export function useElementTheme(activeElement: ElementId | null): void {
  useLayoutEffect(() => {
    const root = document.documentElement;
    for (const def of Object.values(ELEMENT_REGISTRY)) {
      root.style.setProperty(`--el-${def.id}`, def.color);
      root.style.setProperty(`--el-${def.id}-core`, def.colorCore);
    }
  }, []);

  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!activeElement) {
      root.style.removeProperty('--el-active');
      root.style.removeProperty('--el-active-2');
      return;
    }
    const def = ELEMENT_REGISTRY[activeElement as keyof typeof ELEMENT_REGISTRY];
    root.style.setProperty('--el-active', def?.color ?? 'var(--gold)');
    root.style.setProperty('--el-active-core', def?.colorCore ?? 'var(--gold)');
  }, [activeElement]);
}

/**
 * Screen entrance. `direction` comes from navigation itself, so going deeper
 * into the interface moves content up from below and backing out reverses it —
 * the one cue that makes a menu feel like a place instead of a page swap.
 */
export function useScreenMotion<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const direction = useUiStore((s) => s.navigationDirection);

  useEffect(() => {
    const cleanup = enterScreen(ref.current, direction);
    return cleanup;
  }, [direction]);

  return ref;
}

/**
 * Press/hover behaviour for anything clickable. Spread onto the element:
 * `{...usePressable()}`. Reduced motion collapses these to nothing.
 */
export function usePressable<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);

  const setRef = useCallback((node: T | null) => {
    ref.current = node;
  }, []);

  return {
    ref: setRef,
    onPointerEnter: () => {
      if (ref.current && !ref.current.matches(':disabled')) hoverIn(ref.current);
    },
    onPointerLeave: () => {
      if (ref.current) hoverOut(ref.current);
    },
    onPointerDown: (event: React.PointerEvent) => {
      if (!ref.current || event.button === 2) return;
      press(ref.current);
    },
    onPointerUp: () => {
      if (ref.current) release(ref.current);
    },
    onPointerCancel: () => {
      if (ref.current) release(ref.current);
    },
    onFocus: () => {
      if (ref.current && !isReducedMotion()) hoverIn(ref.current);
    },
    onBlur: () => {
      if (ref.current) hoverOut(ref.current);
    },
  };
}

/** Imperative feedback for a component that owns its own ref. */
export function useFeedback() {
  return useMemo(
    () => ({
      deny: (el: HTMLElement | null) => deny(el),
      success: (el: HTMLElement | null) => success(el),
    }),
    [],
  );
}
