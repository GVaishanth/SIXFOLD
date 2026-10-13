/**
 * Dungeon mode — the generator.
 *
 * Pure on purpose: no Phaser import, no scene state, no `window`. That is what makes the mode's
 * invariants checkable from node (`npm run audit:dungeon`) instead of only inside a running frame,
 * and it is the reason this file returns plain data rather than game objects.
 *
 * ## The one rule that keeps a strip from breaking the arena
 *
 * Every position is a fraction **of one cell**, never of the whole strip. `worldFrame` keeps meaning
 * "one cell" — walls, physics bounds, hazard placement and `clampToFrame` all read it — so a scene
 * can move the cell around inside a wider world without those systems disagreeing about what the
 * frame is. The alternative (widening `worldFrame.width` to the strip) silently corrupts
 * `hazards.ts`, which places fields as a fraction of the frame width and picks its crystal-wall axis
 * by distance from the frame's centre. Convert fractions to world pixels at the last moment, in the
 * scene: `site.x = chunk.index * cellWidth + fx * cellWidth`.
 *
 * ## Why the gaps hold without a global pass
 *
 * Nothing is placed in a field any more; it is placed on a *corridor*. Each cell is one circuit of a
 * labyrinth — a spine across the middle, one gap to cross it at, and a tooth in the entering lane that
 * makes that gap the only way on — so every position is sampled along the corridor's polyline, which
 * cannot be inside a wall, cannot be inside the spine, and cannot be in the wall band. The x-edges are
 * still inset by `minSiteGap / 2`, so the worst case across a cell boundary is exactly the minimum gap:
 * "two stones welded together at a seam" stays impossible by construction rather than by a retry that
 * happens to notice.
 *
 * Six cells are six circuits, counted the way the classical labyrinth counts them — outer line first,
 * centre last — so the walk reads as LINE 7 inwards, and the last cell's spine stops short so the two
 * lanes merge into the centre. The goal is that merge, not the far wall.
 */

import { ARENA, DUNGEON } from '@/config/gameConfig';
import { FLOOR_REGISTRY } from '@/data/floors/floors';
import { DROP_TABLES } from '@/data/loot/loot';
import { createRng } from '@/utils/math';
import type { DungeonChunk, DungeonCircuit, DungeonPlan, DungeonProp, DungeonSite, SiteKind } from '@/types';

const FLOOR_IDS = Object.keys(FLOOR_REGISTRY)
  .map((key) => Number(key))
  .filter((id) => Number.isFinite(id))
  .sort((a, b) => a - b);

/** Fallback that always exists, so a cache can never be generated pointing at nothing. */
const LAST_RESORT_TABLE = 'trash_low';

export interface DungeonSplitOptions {
  /** How many cells the strip is. */
  chunks?: number;
  /** One cell's size: pass `worldFrame` at runtime, the authored field otherwise. */
  cellWidth?: number;
  cellHeight?: number;
  /** Which `FLOOR_REGISTRY` ids the strip may draw from. Defaults to all ten. */
  biomes?: number[];
  /** Cells per biome run, so a strip reads as regions rather than a raffle. */
  biomeRun?: number;
}

/** The biome for one cell: a run of `biomeRun` cells each, walking the registry from a seeded start. */
export function biomeForCell(seed: number, index: number, opts: DungeonSplitOptions = {}): number {
  const biomes = opts.biomes?.length ? opts.biomes : FLOOR_IDS;
  const run = Math.max(1, opts.biomeRun ?? 2);
  const start = Math.abs(Math.trunc(seed)) % biomes.length;
  return biomes[(start + Math.floor(index / run)) % biomes.length];
}

/**
 * A cache's table, proven to resolve before it is ever written down.
 *
 * An id that does not exist used to be a silent empty pile, which is how §B11 found the relic-core
 * table mis-keyed; the generator refuses to emit one instead.
 */
export function cacheTableId(biome: number): string {
  const preferred = ['dungeon_cache', FLOOR_REGISTRY[biome]?.rewardTableId, LAST_RESORT_TABLE];
  for (const id of preferred) {
    if (id && DROP_TABLES[id]) return id;
  }
  return LAST_RESORT_TABLE;
}

/**
 * The two lanes a cell is walked along, and the row pitch they imply.
 *
 * A cell is 880×520, but a *stacked* row of cells is not 520 apart: the world only reads as one corridor if
 * the lane a cell exits on is the lane the cell below it enters on, which puts rows `laneBottomFy - laneTopFy`
 * of a cell height apart. Both the generator and `tools/derive-brain.mjs` read this from here, so the picture
 * is sampled at the geometry the game actually uses rather than at a number somebody typed twice.
 */
export function laneSpan(cellHeight: number): { topFy: number; bottomFy: number; pitchFrac: number } {
  const wallFy = ARENA.wall / cellHeight;
  const topFy = (wallFy + DUNGEON.spineBand.fy0) / 2;
  const bottomFy = (DUNGEON.spineBand.fy1 + (1 - wallFy)) / 2;
  return { topFy, bottomFy, pitchFrac: bottomFy - topFy };
}

/**
 * One circuit's walls and route, derived from the same rng stream as the cell's contents.
 *
 * The tooth always sits *right* of the gap and in the lane the walk enters, which is the whole
 * construction: you cannot pass it, so you must cross at the gap, and after crossing the lane you
 * left is behind you. That is what makes this a path rather than a choice — a labyrinth, not a maze —
 * and it is why nothing here needs pathfinding: every actor can only ever be pushed along the route.
 */
export function circuitFor(
  index: number,
  chunkCount: number,
  cellWidth: number,
  cellHeight: number,
  rng: () => number,
): DungeonCircuit {
  const isLast = index >= chunkCount - 1;
  const spine = { fy0: DUNGEON.spineBand.fy0, fy1: DUNGEON.spineBand.fy1 };
  const lane = laneSpan(cellHeight);
  const laneTopFy = lane.topFy;
  const laneBottomFy = lane.bottomFy;
  const gapFx = 0.28 + rng() * 0.1;
  const toothFx = Math.min(0.92, gapFx + DUNGEON.passage / cellWidth + 0.12 + rng() * 0.1);
  const entersTop = index % 2 === 0;
  const spineEndFx = isLast ? DUNGEON.spineEndFx : 1;
  const goal = isLast ? { fx: Math.min(0.965, spineEndFx + 0.09), fy: (spine.fy0 + spine.fy1) / 2 } : null;
  const enterY = entersTop ? laneTopFy : laneBottomFy;
  const exitY = entersTop ? laneBottomFy : laneTopFy;
  const half = DUNGEON.passage / cellWidth / 2;
  const route: { fx: number; fy: number }[] = [
    { fx: 0, fy: enterY },
    { fx: Math.max(half + 0.02, gapFx - half), fy: enterY },
    { fx: gapFx, fy: (spine.fy0 + spine.fy1) / 2 },
    { fx: Math.min(spineEndFx, gapFx + half + 0.02), fy: exitY },
    { fx: spineEndFx, fy: exitY },
  ];
  if (goal) route.push({ fx: goal.fx, fy: goal.fy });
  return { entersTop, gapFx, toothFx, spine, laneTopFy, laneBottomFy, spineEndFx, goal, route };
}

/**
 * A point on the corridor's polyline, by arc length in cell pixels.
 *
 * Length is measured in pixels, not in fractions, because the cell is 880×520: an equal-fraction step
 * would put six times too much of the walk on the horizontal legs.
 */
export function routePoint(circuit: DungeonCircuit, at: number, cellWidth: number, cellHeight: number) {
  const pts = circuit.route.map((spot) => ({ x: spot.fx * cellWidth, y: spot.fy * cellHeight }));
  const legs: { from: { x: number; y: number }; to: { x: number; y: number }; len: number }[] = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    legs.push({ from: pts[i], to: pts[i + 1], len });
    total += len;
  }
  let want = Math.max(0, Math.min(1, at)) * total;
  for (const leg of legs) {
    if (want > leg.len) {
      want -= leg.len;
      continue;
    }
    const t = leg.len > 0 ? want / leg.len : 0;
    return {
      fx: (leg.from.x + (leg.to.x - leg.from.x) * t) / cellWidth,
      fy: (leg.from.y + (leg.to.y - leg.from.y) * t) / cellHeight,
    };
  }
  const last = pts[pts.length - 1];
  return { fx: last.x / cellWidth, fy: last.y / cellHeight };
}

/**
 * The whole strip's corridor, one polyline in world pixels: every cell's route end to end.
 *
 * This is what the partner walks. A labyrinth has exactly one route between any two points on it, so
 * "follow the corridor" needs no search, no cost function and no obstacles list — project both ends
 * onto the polyline, walk along it, and you have taken the only path there is. That is also why the
 * mode can have solid walls and no pathfinder: here the route *is* the pathfinding.
 */
export function stripRoute(plan: DungeonPlan): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  for (const cell of plan.cells) {
    for (const spot of cell.circuit.route) {
      points.push({
        x: cell.index * plan.cellWidth + spot.fx * plan.cellWidth,
        y: spot.fy * plan.height,
      });
    }
  }
  return points;
}

/**
 * Where a point projects onto the corridor: its arc distance along the polyline, the perpendicular
 * distance to it, and the foot itself. The scene's steering and the HUD's beacons both read this, so it
 * is one function rather than two shapes that could drift.
 */
export function routeProjection(
  points: { x: number; y: number }[],
  lengths: number[],
  at: { x: number; y: number },
): { at: number; distance: number; x: number; y: number } {
  let best = { at: 0, distance: Number.POSITIVE_INFINITY, x: at.x, y: at.y };
  for (let i = 0; i < points.length - 1; i += 1) {
    const ax = points[i].x;
    const ay = points[i].y;
    const dx = points[i + 1].x - ax;
    const dy = points[i + 1].y - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq <= 0) continue;
    const t = Math.max(0, Math.min(1, ((at.x - ax) * dx + (at.y - ay) * dy) / lenSq));
    const cx = ax + dx * t;
    const cy = ay + dy * t;
    const distance = Math.hypot(at.x - cx, at.y - cy);
    if (distance < best.distance) {
      best = { at: lengths[i] + Math.sqrt(lenSq) * t, distance, x: cx, y: cy };
    }
  }
  return best;
}

/** The point a given arc distance along the corridor, clamped to its ends. */
export function routeAtDistance(
  points: { x: number; y: number }[],
  lengths: number[],
  want: number,
): { x: number; y: number } {
  if (points.length === 0) return { x: 0, y: 0 };
  const total = lengths[lengths.length - 1] ?? 0;
  const d = Math.max(0, Math.min(total, want));
  for (let i = 0; i < points.length - 1; i += 1) {
    if (d > lengths[i + 1] && i + 2 < points.length) continue;
    const span = lengths[i + 1] - lengths[i];
    const t = span > 0 ? (d - lengths[i]) / span : 0;
    return { x: points[i].x + (points[i + 1].x - points[i].x) * t, y: points[i].y + (points[i + 1].y - points[i].y) * t };
  }
  const last = points[points.length - 1];
  return { x: last.x, y: last.y };
}

/**
 * Where the guide stone stands: on the corridor, a few strides in front of where the walk begins. It is
 * placed *in* the lane rather than beside it because the mode has one verb — you walk into a stone to use
 * it, there are no key prompts and no tooltips, a 20 px target and a thumb pad do not mix — and the stone
 * is a `GuideStone`, not a collider, so reading it never blocks the way.
 */
export function guideSpot(plan: DungeonPlan): { x: number; y: number } {
  const circuit = plan.cells[0].circuit;
  const spot = routePoint(circuit, 0.22, plan.cellWidth, plan.height);
  return { x: Math.round(spot.fx * plan.cellWidth), y: Math.round(spot.fy * plan.height) };
}

/**
 * The charts. One per every other cell, on the corridor itself just past that cell's crossing, so finding
 * one is a step of the walk rather than a search of the map: they are the difference between wandering a
 * labyrinth and reading one.
 */
export function chartSpots(plan: DungeonPlan, every = 2): { x: number; y: number; cell: number }[] {
  const out: { x: number; y: number; cell: number }[] = [];
  // Tried in order, and deterministic rather than rolled: a chart that happens to sit on a stone would be
  // paid out by the grove you were going to wake anyway, which is a free thing where a found thing should
  // be. Mid-corridor is the nicest read, so it is the first candidate rather than the only one.
  const candidates = [0.5, 0.34, 0.66, 0.2, 0.8];
  for (const cell of plan.cells) {
    if ((cell.index + 1) % Math.max(1, every) !== 0) continue;
    let chosen = routePoint(cell.circuit, candidates[0], plan.cellWidth, plan.height);
    for (const at of candidates) {
      const spot = routePoint(cell.circuit, at, plan.cellWidth, plan.height);
      const clear = cell.sites.every(
        (site) =>
          Math.hypot(
            (spot.fx - site.fx) * plan.cellWidth,
            (spot.fy - site.fy) * plan.height,
          ) >= 48,
      );
      if (clear) {
        chosen = spot;
        break;
      }
    }
    out.push({
      x: Math.round(cell.index * plan.cellWidth + chosen.fx * plan.cellWidth),
      y: Math.round(chosen.fy * plan.height),
      cell: cell.index,
    });
  }
  return out;
}

/** The cumulative length of each polyline vertex, for projecting a point onto the route. */
export function routeLengths(points: { x: number; y: number }[]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i += 1) {
    out.push(out[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  return out;
}

/** One corridor step, and whether the walker's own heading decided its direction. */
export interface CorridorStep {
  x: number;
  y: number;
  committed: boolean;
}

/**
 * A step along the corridor from `from` toward `to`, or null when there is no corridor to follow.
 *
 * `lookahead` is how far ahead of itself the walker looks: a point on the polyline that distance along
 * the route, which is what makes it turn into a crossing instead of grinding along the spine.
 */
export function corridorStep(
  points: { x: number; y: number }[],
  lengths: number[],
  from: { x: number; y: number },
  to: { x: number; y: number },
  lookahead: number,
  blocked?: (a: { x: number; y: number }, b: { x: number; y: number }) => boolean,
  heading = 0,
): CorridorStep | null {
  if (points.length < 2) return null;
  // Anything you can walk to in a straight line, you walk to. The corridor is only for what a wall is
  // between, and a partner that detours around open ground is a partner that looks lost.
  if (blocked && !blocked(from, to)) return { x: to.x, y: to.y, committed: false };
  const project = (p: { x: number; y: number }) => routeProjection(points, lengths, p);
  const mine = project(from);
  const theirs = project(to);
  const total = lengths[lengths.length - 1];
  // Step one when the walker itself is off the path — which is where a labyrinth leaves you the moment
  // you step aside to look at a stone: get back onto the corridor. Aiming at the projection is also
  // the right first move, because from a pocket the nearest route point is the crossing beside it.
  if (mine.distance > lookahead * 0.6) {
    /*
     * Getting back onto the corridor — but never through stone. A strip's pockets are thin, so aiming
     * straight at the projection was safe there; the brain's gyri are ridges ten tiles thick, and a partner
     * 200px from the route on the far side of one walked into it and stayed: measured at 150 of 150 samples
     * with its body box inside a wall, holding a 30px leash it could never shorten. So when something is
     * actually between, the walker takes the corridor instead — whichever way along the polyline is shorter
     * to the target's own place on it, which is the only direction the map is offering.
     */
    if (!blocked || !blocked(from, mine)) return { x: mine.x, y: mine.y, committed: true };
    const toward = Math.sign(theirs.at - mine.at) || 1;
    const want = Math.max(0, Math.min(total, mine.at + toward * lookahead));
    const step = routeAtDistance(points, lengths, want);
    return { x: step.x, y: step.y, committed: true };
  }
  // The target's corridor point can be *underneath* the walker — that is what a pocket is: a patch of
  // walkable floor the route passes beside but never enters. Then there is no progress to be made by
  // heading for it, and the only way on is further along the corridor, so it keeps its heading and
  // trusts the switchback to come round. That is the whole of the partner's map sense, and in a
  // labyrinth it is enough: there is exactly one way round, and forward is it.
  const delta = theirs.at - mine.at;
  // Two cases, and the difference between a partner that works and one that dances on the spot.
  //
  // A target *on* the corridor is walked to: toward its projection, never past it. A target in a pocket
  // — walkable floor the route passes beside but never enters — has its projection anywhere along the
  // leg below it, which carries no direction at all: walking toward it means jittering over one point
  // with nothing to arrive at. So for those, the projection is ignored and the walker commits to its
  // heading and drives the corridor until a clear line opens — and the switchback always comes round,
  // because there is exactly one way round in a labyrinth. `blocked` above is what ends the drive.
  const pocketed = theirs.distance > DUNGEON.partner.corridorTolerance;
  const drive = pocketed ? heading || 1 : Math.sign(delta) || 1;
  const stride = pocketed ? lookahead : Math.min(lookahead, Math.abs(delta));
  let committed = pocketed;
  let want = mine.at + drive * stride;
  // Past either end of the strip there is nothing to commit to. Turn round, and let the turn stick.
  if (want <= 0 || want >= total) {
    want = mine.at - drive * stride;
    committed = false;
  }
  want = Math.max(0, Math.min(total, want));
  let i = 0;
  while (i < lengths.length - 2 && lengths[i + 1] < want) i += 1;
  const span = lengths[i + 1] - lengths[i] || 1;
  const t = Math.max(0, Math.min(1, (want - lengths[i]) / span));
  return {
    x: points[i].x + (points[i + 1].x - points[i].x) * t,
    y: points[i].y + (points[i + 1].y - points[i].y) * t,
    // `committed` says "the heading you gave me is what this step is made of", so the walker keeps it
    // until the map gives it a reason to change its mind.
    committed,
  };
}

/**
 * Does the segment `a`→`b` cross the rectangle? Slab test, no allocation, called at most a handful of
 * times per frame by the partner's sight check — and by nothing else, because the mode has no other
 * obstacle queries: the labyrinth is the whole of the collision model.
 */
export function crossesRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  rect: { x: number; y: number; w: number; h: number },
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [
    [-dx, ax - rect.x],
    [dx, rect.x + rect.w - ax],
    [-dy, ay - rect.y],
    [dy, rect.y + rect.h - ay],
  ] as [number, number][]) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  return t0 < t1;
}

/** Shortest distance from a point to the corridor, in pixels — the gate's yardstick for "on the route". */
export function routeDistance(circuit: DungeonCircuit, fx: number, fy: number, cellWidth: number, cellHeight: number) {
  const px = fx * cellWidth;
  const py = fy * cellHeight;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < circuit.route.length - 1; i += 1) {
    const ax = circuit.route[i].fx * cellWidth;
    const ay = circuit.route[i].fy * cellHeight;
    const bx = circuit.route[i + 1].fx * cellWidth;
    const by = circuit.route[i + 1].fy * cellHeight;
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq)) : 0;
    best = Math.min(best, Math.hypot(px - (ax + dx * t), py - (ay + dy * t)));
  }
  return best;
}

/** The box a site may occupy inside a cell, in fractions of the cell. */
function placementBox(cellWidth: number, cellHeight: number) {
  const pad = ARENA.wall + DUNGEON.siteInset;
  const seam = DUNGEON.minSiteGap / 2;
  const x0 = Math.min(pad + seam, cellWidth / 2);
  const x1 = Math.max(cellWidth - pad - seam, cellWidth / 2);
  const y0 = Math.min(pad, cellHeight / 2);
  const y1 = Math.max(cellHeight - pad, cellHeight / 2);
  return {
    fx0: x0 / cellWidth,
    fx1: x1 / cellWidth,
    fy0: y0 / cellHeight,
    fy1: y1 / cellHeight,
    /** Minimum separation, in fractions of the cell, for the rejection test. */
    gapFx: DUNGEON.minSiteGap / cellWidth,
    gapFy: DUNGEON.minSiteGap / cellHeight,
  };
}

function tooClose(a: { fx: number; fy: number }, b: { fx: number; fy: number }, box: ReturnType<typeof placementBox>) {
  const dx = Math.abs(a.fx - b.fx);
  const dy = Math.abs(a.fy - b.fy);
  // Chebyshev-style on purpose: a vertical neighbour is as much of a collision as a horizontal one,
  // and a site is a thing the player walks up to, not a point.
  return dx < box.gapFx && dy < box.gapFy;
}

/**
 * One site position, on the corridor, rejecting only what would weld two stones together.
 *
 * The x-clamp is the seam rule: the corridor continues across a cell boundary, so without it the last
 * stone of one cell and the first of the next could land on the same pixel. Nothing else is needed —
 * the corridor is already clear of the spine, the tooth and the wall band.
 */
function placeSite(
  rng: () => number,
  placed: { fx: number; fy: number }[],
  box: ReturnType<typeof placementBox>,
  circuit: DungeonCircuit,
  cellWidth: number,
  cellHeight: number,
): { fx: number; fy: number } {
  const clampFx = (fx: number) => Math.min(box.fx1, Math.max(box.fx0, fx));
  const sample = () => {
    const spot = routePoint(circuit, rng(), cellWidth, cellHeight);
    return { fx: clampFx(spot.fx), fy: spot.fy };
  };
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const candidate = sample();
    if (!placed.some((seen) => tooClose(candidate, seen, box))) return candidate;
  }
  // A cell can legitimately be full. The last position is still on the corridor and inside the safe
  // box, so the worst outcome is a pair that reads as one cluster — never a stone inside a wall.
  return sample();
}

const KIND_WEIGHTS: { kind: SiteKind; weight: number }[] = [
  { kind: 'grove', weight: 34 },
  { kind: 'cache', weight: 26 },
  { kind: 'field', weight: 18 },
  { kind: 'spring', weight: 12 },
  { kind: 'den', weight: 10 },
];

/** Weighted pick over `KIND_WEIGHTS`, on the seeded rng (never `Math.random`, which is unrepeatable). */
function pickKind(rng: () => number): SiteKind {
  const total = KIND_WEIGHTS.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = rng() * total;
  for (const entry of KIND_WEIGHTS) {
    roll -= entry.weight;
    if (roll <= 0) return entry.kind;
  }
  return 'grove';
}

/**
 * The generator's whole contract: `(seed, index)` decides a cell, and nothing else does.
 *
 * `index 0` always opens with a spring at the entry so a run can never start stranded, and the
 * awake budget is spent as it goes, so `Σ grove.n ≤ maxAwakePerChunk` holds per cell instead of
 * being repaired later.
 */
export function planChunk(seed: number, index: number, opts: DungeonSplitOptions = {}): DungeonChunk {
  const cellWidth = opts.cellWidth ?? ARENA.width;
  const cellHeight = opts.cellHeight ?? ARENA.height;
  const biome = biomeForCell(seed, index, opts);
  const floor = FLOOR_REGISTRY[biome] ?? FLOOR_REGISTRY[FLOOR_IDS[0]];
  const rng = createRng(mixSeed(seed, index));
  const box = placementBox(cellWidth, cellHeight);
  const circuit = circuitFor(index, opts.chunks ?? DUNGEON.chunks, cellWidth, cellHeight, rng);

  const sites: DungeonSite[] = [];
  const placed: { fx: number; fy: number }[] = [];
  let awake = 0;

  const push = (kind: SiteKind, spot: { fx: number; fy: number }, n: number, extra: Partial<DungeonSite> = {}) => {
    placed.push(spot);
    sites.push({
      id: `c${index}s${sites.length}-${kind}`,
      kind,
      chunk: index,
      fx: spot.fx,
      fy: spot.fy,
      n,
      ...extra,
    });
  };

  if (index === 0) {
    // The entry spring sits on the corridor at the strip's opening, in the lane the walk starts in.
    push('spring', { fx: box.fx0, fy: circuit.laneTopFy }, DUNGEON.springCharges);
  }

  const siteCount = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < siteCount; i += 1) {
    const kind = pickKind(rng);
    const spot = placeSite(rng, placed, box, circuit, cellWidth, cellHeight);
    if (kind === 'grove') {
      const room = Math.max(0, DUNGEON.maxAwakePerChunk - awake);
      const n = Math.min(DUNGEON.maxAwakePerGrove, 2 + Math.floor(rng() * 4), room);
      if (n <= 0) continue;
      awake += n;
      push('grove', spot, n);
    } else if (kind === 'cache') {
      push('cache', spot, 1, { tableId: cacheTableId(biome) });
    } else if (kind === 'spring') {
      push('spring', spot, DUNGEON.springCharges);
    } else if (kind === 'field') {
      push('field', spot, 1, { hazard: floor.hazard.kind, intensity: 1.4 });
    } else {
      const bossId = rng() < 0.5 ? floor.miniBossId : floor.majorBossId;
      push('den', spot, 1, { bossId });
    }
  }

  const props: DungeonProp[] = [];
  const propCount = 4 + Math.floor(rng() * 6);
  for (let i = 0; i < propCount; i += 1) {
    // Props go *on* the spine, not on the floor: carved relief on the wall that cannot hide a stone
    // or trip a chase. The crossing and the tooth are left clear, because those two places are where
    // the player reads the route, and a prop there would be a lie about which way is open.
    const fx = 0.04 + rng() * 0.92;
    if (Math.abs(fx - circuit.gapFx) < DUNGEON.passage / cellWidth || Math.abs(fx - circuit.toothFx) < DUNGEON.passage / cellWidth) continue;
    props.push({
      fx,
      fy: circuit.spine.fy0 + 0.06 + rng() * Math.max(0.01, circuit.spine.fy1 - circuit.spine.fy0 - 0.12),
      variant: Math.floor(rng() * 3),
    });
  }

  return {
    index,
    circuit,
    biome,
    groundVariant: Math.floor(rng() * 3),
    awakeBudget: awake,
    sites,
    props,
  };
}

/** The whole strip. Calls `planChunk` per cell, so both views agree by construction. */
export function planStrip(seed: number, opts: DungeonSplitOptions = {}): DungeonPlan {
  const cellWidth = opts.cellWidth ?? ARENA.width;
  const cellHeight = opts.cellHeight ?? ARENA.height;
  const chunks = Math.max(1, Math.trunc(opts.chunks ?? DUNGEON.chunks));
  const cells: DungeonChunk[] = [];
  for (let index = 0; index < chunks; index += 1) cells.push(planChunk(seed, index, { ...opts, chunks }));
  const last = cells[cells.length - 1];
  const goalSpot = last?.circuit.goal ?? { fx: 0.93, fy: 0.5 };
  return {
    seed,
    chunkCount: chunks,
    cellWidth,
    cellHeight,
    width: cellWidth * chunks,
    height: cellHeight,
    goal: {
      x: (chunks - 1) * cellWidth + goalSpot.fx * cellWidth,
      y: goalSpot.fy * cellHeight,
    },
    cells,
  };
}

/** World position of a site, converted once, at the edge of the pure layer. */
export function siteWorld(site: DungeonSite, plan: DungeonPlan): { x: number; y: number } {
  return {
    x: site.chunk * plan.cellWidth + site.fx * plan.cellWidth,
    y: site.fy * plan.cellHeight,
  };
}

/** Which cell a world x falls in — the streaming decision, kept out of the scene. */
export function cellAt(plan: DungeonPlan, x: number): number {
  return Math.min(plan.chunkCount - 1, Math.max(0, Math.floor(x / plan.cellWidth)));
}

/** Cells that must exist for the camera to cover `centerX`. */
export function liveCells(plan: DungeonPlan, centerX: number, reach = 1): number[] {
  const here = cellAt(plan, centerX);
  const out: number[] = [];
  for (let i = here - reach; i <= here + reach; i += 1) {
    if (i >= 0 && i < plan.chunkCount) out.push(i);
  }
  return out;
}

/** Site totals across the strip, for the HUD's "what is left" plate. */
export function countSites(plan: DungeonPlan, kind: SiteKind): number {
  return plan.cells.reduce((sum, cell) => sum + cell.sites.filter((site) => site.kind === kind).length, 0);
}

/**
 * `createRng` is Mulberry32, which decorrelates on *sequential* calls but not on nearby seeds, so
 * cell 0 of seed 7 and cell 0 of seed 8 would otherwise be near-identical strips. A mix step per cell
 * is what makes "different seed, different map" an observable property rather than a hope.
 */
function mixSeed(seed: number, index: number): number {
  let h = (Math.trunc(seed) ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (index + 0x165667b1), 2246822519) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return h >>> 0;
}
