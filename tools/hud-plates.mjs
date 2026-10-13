/**
 * The HUD's readable plates, shared by every gate that measures them.
 *
 * `mobile-audit` and `dungeon-run` used to keep their own lists, which meant a new plate had to be
 * added twice before it was actually audited — and a strip run's plates (partner bar, depth tally)
 * exist only in the scene the mobile gate never entered. One list, one yardstick.
 *
 * Only plates that exist in both modes are shared; `.partner-line` and `.strip-tally` are additions on
 * the strip side, and they can only ever *add* coverage. The top-right cluster is deliberately not on
 * this list as `.objective`: putting it there would change what the shipped story-mode verdict means,
 * and that gate is the one thing this mode must not disturb.
 */
export const HUD_PLATE_SELECTORS = [
  '.vitals',
  '.partner-line',
  '.floor-plate',
  '.strip-tally',
  '.boss-plate',
  '.countdown-plate',
  '.guide-card',
  '.element-rail',
  '.ability-cluster',
  '.tr-tools',
  '.touch-actions',
  '.touch-elements',
  '.joystick',
];

/** The legibility floor the shipped audit enforces, in CSS pixels. */
export const MIN_FONT = 9.5;
