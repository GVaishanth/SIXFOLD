/**
 * The brain the dungeon is walked in — runtime view of the derived mask.
 *
 * `tools/derive-cortex.mjs` measures the layout out of `assets/brain-source.png` and writes
 * `cortexMask.ts`: one character per tile, floor tagged with the layer band it belongs to. This file turns
 * that grid into the things a scene and a gate need, and nothing else — no Phaser import, no scene state, no
 * `window`, so `npm run audit:cortex` can read the same numbers the game plays with.
 *
 * ## What a layer is
 *
 * The brain's own depth field cuts it into seven nested bands: layer 0 is the surface, layer 6 the deep core.
 * Each band keeps the grooves and the chambers that fall inside it, so a layer is a smaller brain with its own
 * boundary rather than a slice of one. Chambers are assigned whole to a band at derivation time, so a room is
 * never cut in half by a boundary.
 *
 * ## Why walls are rectangles and not a tilemap
 *
 * The strip's walls are static bodies built from rectangles (`DungeonGround.buildColliders`), and the unstick
 * pass that keeps a warden from being shoved through stone reads the same rectangle list. A tilemap would
 * make collision right and the unstick pass blind, which is the bug the brief already forbids: walls are solid
 * or the labyrinth is a drawing. So each layer's wall tiles are merged into maximal runs, and that one list
 * feeds bodies, the unstick test, and the gate's "a straight line misses a wall" check.
 */

import {
  CORTEX_CHAMBERS,
  CORTEX_COLS,
  CORTEX_FISSURE,
  CORTEX_LAYERS,
  CORTEX_ROW_COUNT,
  CORTEX_ROWS,
  CORTEX_TILE_PX,
} from './cortexMask';

export interface CortexTile {
  x: number;
  y: number;
}

export interface CortexRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CortexLayer {
  index: number;
  /** Walkable tiles of this band, one per grid cell. */
  floor: Uint8Array;
  /** Wall rectangles in world pixels: what a body, a shove and a shot all have to respect. */
  rects: CortexRect[];
  bounds: { x0: number; y0: number; x1: number; y1: number };
  area: number;
  entry: CortexTile;
  goal: CortexTile;
  /** The tile in the next band that continues the inward walk, or null for the core. */
  descent: CortexTile | null;
  path: CortexTile[];
  chambers: { x0: number; y0: number; x1: number; y1: number; cx: number; cy: number; roundness: number }[];
  deadEnds: number;
  junctions: number;
  loops: number;
  hemispheres: { left: number; right: number };
  fissureWalked: number;
}

export interface Cortex {
  cols: number;
  /** The one route through the brain: back of the head in, deepest tile out. */
  walk: {
    entry: CortexTile;
    goal: CortexTile;
    tiles: number;
    reachable: number;
    floor: number;
    path: CortexTile[];
  };
  rows: number;
  tilePx: number;
  width: number;
  height: number;
  layers: CortexLayer[];
  /** 1 where the drawing has a fold or a ridge inside the brain, 2 where it is void, 0 where it is floor. */
  solid: Uint8Array;
  bandAt(x: number, y: number): number;
  isFloor(layer: number, x: number, y: number): boolean;
  /** World pixels → tile coords, clamped to the grid. */
  tileOf(px: number, py: number): CortexTile;
  /** Whether a world point is stone. The brain is one place, so this asks about a spot, not a layer. */
  blockedAt(px: number, py: number): boolean;
  /** Which of the seven bands a world point stands in, or -1 outside the brain. */
  layerAt(px: number, py: number): number;
  /** The gyri opened as rooms inside one band, in tile coordinates: a den wants a wall to have. */
  chambersIn(band: number): { cx: number; cy: number; roundness: number }[];
  /** The whole brain's wall bodies, merged: what one physics group is built from. */
  rects: CortexRect[];
  /**
   * The space outside the organ, as maximal row runs in world pixels. The ground paints these in the scene's
   * background colour over the floor sheet: the floor keeps its texture inside the folds, and outside there
   * is nothing to see, which is what makes a brain-shaped map read as a brain.
   */
  voidRuns: CortexRect[];
}

const VOID = 2;

function parse(): { cols: number; rows: number; solid: Uint8Array; band: Int8Array } {
  const cols = CORTEX_COLS;
  const rows = CORTEX_ROW_COUNT;
  const solid = new Uint8Array(cols * rows);
  const band = new Int8Array(cols * rows).fill(-1);
  for (let y = 0; y < rows; y += 1) {
    const line = CORTEX_ROWS[y] ?? '';
    for (let x = 0; x < cols; x += 1) {
      const ch = line[x] ?? '_';
      const i = y * cols + x;
      if (ch === '_') solid[i] = VOID;
      else if (ch === '#') solid[i] = 1;
      else {
        solid[i] = 0;
        band[i] = Number(ch);
      }
    }
  }
  return { cols, rows, solid, band };
}

const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** BFS over a walkable set: distances from `start`, as a flat array (-1 where unreachable). */
function bfs(floor: Uint8Array, cols: number, rows: number, start: number): Int32Array {
  const dist = new Int32Array(cols * rows).fill(-1);
  dist[start] = 0;
  const queue = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const i = queue[head];
    const x = i % cols;
    const y = (i - x) / cols;
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const j = ny * cols + nx;
      if (!floor[j] || dist[j] >= 0) continue;
      dist[j] = dist[i] + 1;
      queue.push(j);
    }
  }
  return dist;
}

function walkBack(floor: Uint8Array, cols: number, rows: number, dist: Int32Array, from: number): CortexTile[] {
  const out: CortexTile[] = [];
  let i = from;
  let guard = 0;
  while (i >= 0 && guard++ < cols * rows) {
    const x = i % cols;
    out.push({ x, y: (i - x) / cols });
    if (dist[i] === 0) break;
    let best = -1;
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = x + dx;
      const ny = (i - x) / cols + dy;
      if (nx < 0 || ny < 0 || nx >= cols) continue;
      const j = ny * cols + nx;
      if (!floor[j]) continue;
      if (dist[j] >= 0 && dist[j] === dist[i] - 1) {
        best = j;
        break;
      }
    }
    if (best < 0) break;
    i = best;
  }
  return out.reverse();
}

/**
 * Wall tiles merged into maximal rectangles: runs along each row, then runs extended downward while the span
 * matches. This is the list physics, the unstick pass and the gate all read, so it is built once, here.
 */
function mergeWallRects(
  floor: Uint8Array,
  solid: Uint8Array,
  cols: number,
  bounds: { x0: number; y0: number; x1: number; y1: number },
  tilePx: number,
): CortexRect[] {
  const runs: { x0: number; x1: number; y: number }[] = [];
  for (let y = bounds.y0; y <= bounds.y1; y += 1) {
    let start = -1;
    for (let x = bounds.x0; x <= bounds.x1 + 1; x += 1) {
      const i = y * cols + x;
      // Stone is the ridge between folds, and nothing else. The void outside the brain was merged in here
      // for a while, which made the map a brown rectangle you could only recognise by walking its edge; it is
      // sealed off instead, because the outline's own ring is wall and `audit:cortex` proves no fold touches
      // the void. It also used to include
      // "floor belonging to another band", which was right when each band was its own map and wrong now that
      // the brain is one place — it made every walkable tile a wall body in the merged list.
      const inside = x <= bounds.x1 && solid[i] === 1;
      if (inside && start < 0) start = x;
      else if (!inside && start >= 0) {
        runs.push({ x0: start, x1: x - 1, y });
        start = -1;
      }
    }
  }
  const used = new Uint8Array(runs.length);
  const rects: CortexRect[] = [];
  for (let a = 0; a < runs.length; a += 1) {
    if (used[a]) continue;
    used[a] = 1;
    const run = runs[a];
    let y1 = run.y;
    for (let b = a + 1; b < runs.length; b += 1) {
      if (used[b]) continue;
      if (runs[b].y !== y1 + 1 || runs[b].x0 !== run.x0 || runs[b].x1 !== run.x1) continue;
      used[b] = 1;
      y1 += 1;
    }
    void floor;
    rects.push({
      x: run.x0 * tilePx,
      y: run.y * tilePx,
      w: (run.x1 - run.x0 + 1) * tilePx,
      h: (y1 - run.y + 1) * tilePx,
    });
  }
  return rects;
}

let built: Cortex | null = null;

/** The parsed brain, built once per page. The mask is a constant, so there is nothing to invalidate. */
export function buildCortex(): Cortex {
  if (built) return built;
  const { cols, rows, solid, band } = parse();
  const tilePx = CORTEX_TILE_PX;
  const layers: CortexLayer[] = [];

  for (let index = 0; index < CORTEX_LAYERS; index += 1) {
    const floor = new Uint8Array(cols * rows);
    let area = 0;
    let x0 = cols;
    let x1 = -1;
    let y0 = rows;
    let y1 = -1;
    let hemiLeft = 0;
    let hemiRight = 0;
    let fissureWalked = 0;
    for (let i = 0; i < cols * rows; i += 1) {
      if (band[i] !== index) continue;
      floor[i] = 1;
      area += 1;
      const x = i % cols;
      const y = (i - x) / cols;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      if (x < CORTEX_FISSURE.col) hemiLeft += 1;
      else if (x > CORTEX_FISSURE.col) hemiRight += 1;
      else fissureWalked += 1;
    }
    if (x1 < 0) {
      layers.push({
        index,
        floor,
        rects: [],
        bounds: { x0: 0, y0: 0, x1: -1, y1: -1 },
        area: 0,
        entry: { x: 0, y: 0 },
        goal: { x: 0, y: 0 },
        descent: null,
        path: [],
        chambers: [],
        deadEnds: 0,
        junctions: 0,
        loops: 0,
        hemispheres: { left: 0, right: 0 },
        fissureWalked: 0,
      });
      continue;
    }

    // Each band is a region of one walk, not a map of its own: it keeps its footprint, its two halves and its
    // own wall bodies, and the route is measured over the whole brain below.
    /*
     * What a band looks like on its own: the folds that end inside it, the loops it forms, how many pieces it
     * falls into when drawn alone. A layer read-out in the HUD is only worth printing if a band is a place,
     * and these are the numbers that say so.
     */
    let deadEnds = 0;
    let junctions = 0;
    let edges = 0;
    let pieces = 0;
    const seen = new Uint8Array(cols * rows);
    for (let i = 0; i < cols * rows; i += 1) {
      if (!floor[i]) continue;
      const x = i % cols;
      const y = (i - x) / cols;
      let deg = 0;
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        if (floor[ny * cols + nx]) deg += 1;
      }
      if (deg === 1) deadEnds += 1;
      if (deg >= 3) junctions += 1;
      edges += deg;
      if (!seen[i]) {
        pieces += 1;
        const stack = [i];
        seen[i] = 1;
        while (stack.length) {
          const j = stack.pop() as number;
          const jx = j % cols;
          const jy = (j - jx) / cols;
          for (const [dx, dy] of NEIGHBOURS) {
            const nx = jx + dx;
            const ny = jy + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            const k = ny * cols + nx;
            if (!floor[k] || seen[k]) continue;
            seen[k] = 1;
            stack.push(k);
          }
        }
      }
    }

    const chambers = CORTEX_CHAMBERS.filter((c) => c.layer === index).map((c) => ({
      x0: c.x0,
      y0: c.y0,
      x1: c.x1,
      y1: c.y1,
      cx: (c.x0 + c.x1) / 2,
      cy: (c.y0 + c.y1) / 2,
      roundness: c.roundness,
    }));

    layers.push({
      index,
      floor,
      rects: mergeWallRects(floor, solid, cols, { x0, y0, x1, y1 }, tilePx),
      bounds: { x0, y0, x1, y1 },
      area,
      entry: { x: 0, y: 0 },
      goal: { x: 0, y: 0 },
      descent: null,
      path: [],
      chambers,
      deadEnds,
      junctions,
      loops: Math.max(0, edges / 2 - area + pieces),
      hemispheres: { left: hemiLeft, right: hemiRight },
      fissureWalked,
    });
  }

  /*
   * One walk through the brain, measured where the player actually is: from the back of the brain — the
   * posterior end of the cleft, the natural way in — to the deepest tile the network has, following grooves
   * only. The band a tile belongs to is the layer the walk is *in* at that moment, so "seven layers" and "one
   * connected brain" are the same fact read two ways, and the run can report the layer it reached by looking
   * at where the warden is standing.
   */
  const allFloor = new Uint8Array(cols * rows);
  for (let i = 0; i < cols * rows; i += 1) if (band[i] >= 0) allFloor[i] = 1;
  let entry = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < cols * rows; i += 1) {
    if (!allFloor[i]) continue;
    const x = i % cols;
    const y = (i - x) / cols;
    const score = y * 6 - Math.abs(x - CORTEX_FISSURE.col);
    if (score > bestScore) {
      bestScore = score;
      entry = i;
    }
  }
  const walkDist = bfs(allFloor, cols, rows, entry);
  // The way out is the deepest place the walk can reach — a tile in the innermost band — and the farthest of
  // those by walking distance, so the route winds inward through every layer rather than stepping into the
  // next ring over. Taking "the farthest tile anywhere" instead ends at the front of the brain, which is a
  // walk across it, not down into it.
  let goal = entry;
  let deepest = 0;
  for (let i = 0; i < cols * rows; i += 1) if (band[i] > deepest) deepest = band[i];
  for (let i = 0; i < cols * rows; i += 1) {
    if (band[i] !== deepest || walkDist[i] < 0) continue;
    if (walkDist[i] > walkDist[goal]) goal = i;
  }
  if (walkDist[goal] < 0) {
    goal = entry;
    for (let i = 0; i < cols * rows; i += 1) if (walkDist[i] > walkDist[goal]) goal = i;
  }
  const walk = {
    entry: { x: entry % cols, y: (entry - (entry % cols)) / cols },
    goal: { x: goal % cols, y: (goal - (goal % cols)) / cols },
    tiles: walkDist[goal],
    reachable: walkDist.filter((d) => d >= 0).length,
    floor: allFloor.reduce((a: number, b: number) => a + b, 0),
    path: walkBack(allFloor, cols, rows, walkDist, goal),
  };
  // Where the walk crosses from one band into the next, the layer counter moves: that is all a layer is here.
  for (let index = 0; index < layers.length; index += 1) {
    const here = layers[index];
    const onBand = walk.path.filter((p) => band[p.y * cols + p.x] === index);
    if (onBand.length) {
      here.entry = onBand[0];
      here.goal = onBand[onBand.length - 1];
      here.path = onBand;
      if (index + 1 < layers.length) {
        const next = walk.path[walk.path.indexOf(onBand[onBand.length - 1]) + 1];
        here.descent = next ?? null;
      }
    }
  }

  const cortex: Cortex = {
    cols,
    rows,
    tilePx,
    width: cols * tilePx,
    height: rows * tilePx,
    layers,
    walk,
    solid,
    bandAt: (x, y) => (x < 0 || y < 0 || x >= cols || y >= rows ? -1 : band[y * cols + x]),
    isFloor: (layer, x, y) => layers[layer]?.floor[y * cols + x] === 1,
    tileOf: (px, py) => ({
      x: Math.max(0, Math.min(cols - 1, Math.floor(px / tilePx))),
      y: Math.max(0, Math.min(rows - 1, Math.floor(py / tilePx))),
    }),
    blockedAt: (px, py) => {
      const t = cortex.tileOf(px, py);
      const i = t.y * cols + t.x;
      return band[i] < 0;
    },
    /** Which of the seven layers a world point stands in — the run's layer counter reads this. */
    chambersIn: (bandIndex) =>
      CORTEX_CHAMBERS.filter((c) => c.layer === bandIndex).map((c) => ({
        cx: Math.round((c.x0 + c.x1) / 2),
        cy: Math.round((c.y0 + c.y1) / 2),
        roundness: c.roundness,
      })),
    layerAt: (px, py) => {
      const t = cortex.tileOf(px, py);
      return band[t.y * cols + t.x];
    },
    /** Every wall body in the brain, merged across bands: the physics group is built from this once. */
    rects: mergeWallRects(allFloor, solid, cols, { x0: 0, y0: 0, x1: cols - 1, y1: rows - 1 }, tilePx),
    voidRuns: (() => {
      const runs: CortexRect[] = [];
      for (let y = 0; y < rows; y += 1) {
        let start = -1;
        for (let x = 0; x <= cols; x += 1) {
          const outHere = x < cols && solid[y * cols + x] === VOID;
          if (outHere && start < 0) start = x;
          else if (!outHere && start >= 0) {
            runs.push({ x: start * tilePx, y: y * tilePx, w: (x - start) * tilePx, h: tilePx });
            start = -1;
          }
        }
      }
      return runs;
    })(),
  };
  built = cortex;
  return cortex;
}

/** The corridor a run walks, in world pixels: this band's path, then the way inward. */
export function cortexRoute(layer: CortexLayer, tilePx: number): { x: number; y: number }[] {
  const pts = layer.path.map((t) => ({ x: (t.x + 0.5) * tilePx, y: (t.y + 0.5) * tilePx }));
  if (layer.descent) pts.push({ x: (layer.descent.x + 0.5) * tilePx, y: (layer.descent.y + 0.5) * tilePx });
  return pts;
}
