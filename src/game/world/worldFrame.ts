import { ARENA } from '@/config/gameConfig';
import { clamp } from '@/utils/math';

/**
 * The live arena rectangle.
 *
 * `ARENA` in the config is the *authored* field: what a desktop window frames.
 * A phone held upright cannot show 880 world pixels across and still keep an
 * 8-pixel sprite readable, so on a handheld frame the field is shortened until
 * the same proportion of it is visible again — bigger actors, identical
 * composition, no extra scrolling. Both orientations go through the same rule,
 * which is why nothing here assumes portrait.
 *
 * Everything that needs the field's size (walls, physics bounds, hazards,
 * camera bounds, spawn placement) reads this object, so one plan change moves
 * the whole world with it. Positions stay authored in fractions of the rect, so
 * a narrower field compresses the layout instead of breaking it.
 */
export const worldFrame: { width: number; height: number; handheld: boolean } = {
  width: ARENA.width,
  height: ARENA.height,
  /** True while the frame is using the handheld plan rather than the authored one. */
  handheld: false,
};

/** Changes the field to fit a view of `viewWidth` world pixels; true if it moved. */
/**
 * Sizes the field for a view of `viewWidth` × `viewHeight` world pixels.
 *
 * Handheld frames get both axes planned: the width so actors stay legible at
 * 16-20 CSS px, and the height so the thumb pads at the bottom of the screen sit
 * over the arena's apron rather than over the floor the player is reading. Wide
 * frames get the authored rectangle, unchanged.
 */
export function planWorldFor(viewWidth: number, viewHeight: number, handheld: boolean): boolean {
  // A strip run owns its own world: the field is the authored cell and never follows the window, so
  // the buffer can change size under it without the map re-laying itself. Everything that needs the
  // field (walls, bounds, hazards, clamps) keeps reading `worldFrame`, which stays authored.
  if (!framePlanning) return false;
  const next = handheld
    ? clamp(Math.round(viewWidth / ARENA.narrowCoverage), ARENA.minWidth, ARENA.width)
    : ARENA.width;
  // The field may be taller than the frame by a little (the camera scrolls) but
  // never so tall that live ground ends up under the thumb pads: those claim the
  // bottom `padFraction` of the frame, so the clear band above them is the real
  // budget, and the authored height is the ceiling.
  const clearBand = Math.round(viewHeight * (1 - ARENA.padFraction));
  const nextHeight = handheld
    ? clamp(
        Math.min(Math.round(viewHeight * ARENA.heightFromView), clearBand + Math.round(viewHeight * 0.12)),
        ARENA.minHeight,
        ARENA.height,
      )
    : ARENA.height;
  if (worldFrame.width === next && worldFrame.height === nextHeight && worldFrame.handheld === handheld) {
    return false;
  }
  worldFrame.width = next;
  worldFrame.height = nextHeight;
  worldFrame.handheld = handheld;
  return true;
}

/**
 * How far the camera may look past a wall on a handheld frame. The pad row at
 * the bottom of the screen belongs to the touch controls; letting the camera
 * scroll `ARENA.handheldOverscan` past the field puts that darkness under the
 * pads instead of putting live hostiles there.
 */
/**
 * Turn the frame-follows-window rule off while a scene owns its world size (dungeon strips), and back
 * on at its shutdown. Restoring it is not optional: leaving it off would strand the next run in the
 * field the previous mode chose, which is the same class of leak as a captured `timeScale`.
 */
export function setWorldFramePlanning(enabled: boolean): void {
  framePlanning = enabled;
}

let framePlanning = true;

export function cameraOverscan(): number {
  return worldFrame.handheld ? ARENA.handheldOverscan : 0;
}

/** Back to the authored field, e.g. when a run's scene is torn down. */
export function resetWorldFrame(): void {
  worldFrame.width = ARENA.width;
  worldFrame.height = ARENA.height;
  worldFrame.handheld = false;
}


/** The playable interior: the field inside the wall band. */
export function innerBounds(wallThickness: number): { x: number; y: number; width: number; height: number } {
  return {
    x: wallThickness,
    y: wallThickness,
    width: worldFrame.width - wallThickness * 2,
    height: worldFrame.height - wallThickness * 2,
  };
}

/** Keeps a world position inside the field (used when the frame shrinks mid-run). */
export function clampToFrame(x: number, y: number, inset: number): { x: number; y: number } {
  return {
    x: Math.min(Math.max(x, inset), worldFrame.width - inset),
    y: Math.min(Math.max(y, inset), worldFrame.height - inset),
  };
}
