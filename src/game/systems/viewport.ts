import type Phaser from 'phaser';
import { RESOLUTION } from '@/config/gameConfig';
import { planWorldFor } from '@/game/world/worldFrame';
import { clamp } from '@/utils/math';

/**
 * Viewport fitting.
 *
 * The game does not letterbox. Phaser is left in `Scale.NONE` and this module
 * sizes the render buffer to the host element, so every pixel of the window is
 * game — on a 390×844 phone the world simply sees more of the arena vertically
 * instead of getting black bars.
 *
 * The zoom is always a whole number of CSS pixels per world pixel, because
 * nearest-neighbour art goes soft and wobbly when one row of pixels is 4 CSS px
 * wide and the next is 5. Two plans are available:
 *
 *  - **authored** (any window with room in it): the largest integer zoom that
 *    still shows 320 world pixels across and `MIN_VIEW_HEIGHT` down, so 16:9
 *    keeps exactly the framing the art was authored for and every other shape
 *    widens or lengthens the view instead of cropping it.
 *  - **handheld** (both dimensions ≤ `RESOLUTION.handheldLimit`, portrait or
 *    landscape): the width demand drops to 190 world pixels and the zoom is
 *    floored at 2, which doubles every actor — an 8 CSS px warden becomes 16.
 *    So that the bigger pixels do not cost you the field, the arena rect is
 *    re-planned in the same step (`world/worldFrame`), and the view keeps
 *    seeing ~44 % of the width with less for the camera to chase.
 */
export const BASE_VIEW = { width: RESOLUTION.width, height: RESOLUTION.height } as const;

/** Shortest world-space span a frame may show before we stop zooming in. */
export const MIN_VIEW_HEIGHT = 160;

export interface ViewFit {
  /** CSS pixels per world pixel — always an integer, for crisp nearest-neighbour. */
  zoom: number;
  /** Render buffer size, in world pixels. */
  width: number;
  height: number;
  /** True when the handheld plan is in use (it also drives the arena re-plan). */
  handheld: boolean;
}

/**
 * A frame is handheld when neither axis has room in it. A touch laptop at
 * 1920×1080 is not, because it is read from a metre away; a 400-px-wide desktop
 * window is, because it has the same physical problem.
 */
export function isHandheldFrame(parentWidth: number, parentHeight: number): boolean {
  return Math.min(parentWidth, parentHeight) <= RESOLUTION.handheldLimit;
}

/** Pure measurement: which plan a frame gets, and what buffer that needs. */
export function fitFor(parentWidth: number, parentHeight: number): ViewFit {
  const width = Math.max(1, parentWidth);
  const height = Math.max(1, parentHeight);
  const handheld = isHandheldFrame(width, height);
  const viewWidthDemand = handheld ? RESOLUTION.narrowViewWidth : BASE_VIEW.width;
  const minZoom = handheld ? 2 : 1;
  const raw = Math.min(width / viewWidthDemand, height / MIN_VIEW_HEIGHT);
  // Rounding, not flooring: a 360×640 phone lands on 1.89, and flooring would
  // strand the device at zoom 1 — 8 CSS px sprites — for want of one pixel.
  const zoom = clamp(handheld ? Math.round(raw) : Math.floor(raw), minZoom, RESOLUTION.maxZoom);
  return {
    zoom,
    // Ceil, not round: the buffer may cover a couple of extra world pixels that
    // the window clips off, but it must never leave a strip of page showing.
    width: Math.max(96, Math.ceil(width / zoom)),
    height: Math.max(96, Math.ceil(height / zoom)),
    handheld,
  };
}

/**
 * Keeps the buffer matched to the host element.
 *
 * Returns the teardown. The observer, the orientation listener and the resize
 * listener all have to go when the host unmounts, or a remount would fight the
 * previous owner for the canvas.
 */
export function attachViewport(game: Phaser.Game, parent: HTMLElement): () => void {
  const apply = (): void => {
    const fit = fitFor(parent.clientWidth, parent.clientHeight);
    // The arena moves with the view. Its height is never resized: hazards, props
    // and the light pool are composed against the authored vertical span. A
    // changed field has to broadcast even when the buffer did not move, so the
    // arena re-lays its walls inside the same frame.
    const arenaChanged = planWorldFor(fit.width, fit.height, fit.handheld);
    if (!arenaChanged && game.scale.width === fit.width && game.scale.height === fit.height) return;
    game.scale.resize(fit.width, fit.height);
  };

  apply();

  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(apply);
    observer.observe(parent);
  }
  // Mobile browsers fold and unfold their own chrome without firing a window
  // resize, and an orientation flip lands both events within a frame of each
  // other, so the work is coalesced into the next animation frame.
  let queued = 0;
  const request = (): void => {
    if (queued) return;
    queued = window.requestAnimationFrame(() => {
      queued = 0;
      apply();
    });
  };
  const visual = window.visualViewport;
  window.addEventListener('resize', request);
  window.addEventListener('orientationchange', request);
  visual?.addEventListener('resize', request);

  return () => {
    if (queued) window.cancelAnimationFrame(queued);
    observer?.disconnect();
    window.removeEventListener('resize', request);
    window.removeEventListener('orientationchange', request);
    visual?.removeEventListener('resize', request);
  };
}
