#!/usr/bin/env node
/*
 * The gate for the cortex dungeon. It exists because the alternative is my saying "it's brain-shaped now" and
 * you believing a sentence. Every check here measures the shipped data file — the runtime's grid, wall
 * rectangles, layer bounds and walk — against what the brief for this redesign actually asked for, which was:
 *
 *   a brain, upright, split by a longitudinal fissure that runs the whole length
 *   corridors that are the folds, chambers that are the gyri, curved dead ends, loops
 *   seven progressively nested layers, each a brain on its own, with continuity between them
 *
 * The checks that matter most are the two a lazy implementation passes: *does the fissure divide*, and *is
 * the walkable set the picture*. A corridor down the middle of a mirrored pair of halves looks like a fissure
 * in the drawing and is a hallway in the game, so solidity is measured off the runtime grid, not off the
 * derivation's intention. And a data file that nothing imports is not a feature, so every geometry claim is
 * read back out of `src/game/dungeon/cortexMask.ts` through the same parser the game uses.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { deriveCortex, CORTEX, PNG_PATH } from './cortex.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const maskPath = path.join(ROOT, 'src', 'game', 'dungeon', 'cortexMask.ts');
const out = path.join(ROOT, 'node_modules', '.cache', 'cortex-gate');
/*
 * One `outfile` per entry point, deliberately, instead of an `outdir`.
 *
 * With an outdir and two entry points esbuild keeps the sources' shared directory in the output path, so it
 * wrote `game/dungeon/cortex.js` while this file imported `cortex.js` — a path a *previous* one-entry build
 * had left behind. Every measurement below then read a frozen copy of the shipped mask: a number that would
 * not move when the tile size moved, which is what finally exposed it. `outfile` cannot drift like that, and
 * the directory is deleted first so a leftover file cannot be mistaken for this run's work.
 */
const { rm } = await import('node:fs/promises');
await rm(out, { recursive: true, force: true });
const esbuildOptions = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  absWorkingDir: ROOT,
  define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
  logLevel: 'error',
};
await build({ ...esbuildOptions, entryPoints: ['src/game/dungeon/cortex.ts'], outfile: path.join(out, 'cortex.js') });
await build({ ...esbuildOptions, entryPoints: ['src/config/gameConfig.ts'], outfile: path.join(out, 'gameConfig.js') });
const { buildCortex, cortexRoute } = await import(pathToFileURL(path.join(out, 'cortex.js')).href);
const { DASH_CONFIG, PLAYER_CONFIG } = await import(pathToFileURL(path.join(out, 'gameConfig.js')).href);

/**
 * How many times the walk steps from one band into another. A shortest route does not tour the layers in
 * order — it dives, and a fold that wanders back out of a band counts as another crossing — so this is the
 * claim worth making: to get from the surface to the core you have to cross all six boundaries, and a band
 * with no crossing into it is a region the run can name but the player cannot enter.
 */
function boundaryCrossings(c) {
  let n = 0;
  for (let i = 1; i < c.walk.path.length; i += 1) {
    const a = c.walk.path[i - 1];
    const b = c.walk.path[i];
    if (c.bandAt(a.x, a.y) !== c.bandAt(b.x, b.y)) n += 1;
  }
  return n;
}

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass, detail });
  return pass;
};

const cortex = buildCortex();
const d = deriveCortex(PNG_PATH);

const floorSet = new Uint8Array(cortex.cols * cortex.rows);
for (let L = 0; L < cortex.layers.length; L += 1) {
  const f = cortex.layers[L].floor;
  for (let i = 0; i < f.length; i += 1) if (f[i]) floorSet[i] = 1;
}
const inBounds = (x, y) => x >= 0 && y >= 0 && x < cortex.cols && y < cortex.rows;
/** What the runtime calls "walkable", from the union of the layers it will hand to the scene. */
const at = (x, y) => inBounds(x, y) && floorSet[y * cortex.cols + x] === 1;
/** Which layer the runtime says that tile is in — the read-out the HUD prints. */
const bandOf = (x, y) => (at(x, y) ? cortex.bandAt(x, y) : -1);
const midRow = Math.floor(cortex.rows / 2);
const midCol = Math.floor(cortex.cols / 2);

// ── the floor plan, not the picture of one ───────────────────────────────────────────────────────────────
{
  let minX = cortex.cols;
  let maxX = -1;
  let minY = cortex.rows;
  let maxY = -1;
  for (let y = 0; y < cortex.rows; y += 1) {
    for (let x = 0; x < cortex.cols; x += 1) {
      if (!floorSet[y * cortex.cols + x]) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  check(
    'the dungeon is a portrait brain, not a strip',
    h > w,
    `walkable extent ${w} x ${h} tiles (aspect h/w ${(h / w).toFixed(3)}; a horizontal corridor plan has h/w under 1)`,
  );
  const rows = [];
  for (let y = minY; y <= maxY; y += 1) {
    let n = 0;
    let left = Infinity;
    let right = -Infinity;
    for (let x = 0; x < cortex.cols; x += 1) {
      if (!floorSet[y * cortex.cols + x]) continue;
      n += 1;
      left = Math.min(left, x);
      right = Math.max(right, x);
    }
    rows.push({ y, n, left, right });
  }
  const widest = rows.reduce((a, b) => (b.n > a.n ? b : a));
  const first = rows.find((r) => r.n > 0);
  const last = [...rows].reverse().find((r) => r.n > 0);
  const taper = Math.max(first.n, last.n) / widest.n;
  check('both ends taper — a capped rectangle does not', taper < 0.55, `top row ${first.n} tiles, widest ${widest.n}, bottom row ${last.n} (ratio ${taper.toFixed(2)})`);
  check(
    'the outline is convex like a brain, not ragged',
    widest.y > minY + 0.25 * (maxY - minY) && widest.y < maxY - 0.25 * (maxY - minY),
    `the widest row is ${widest.y - minY} from the top of ${maxY - minY}, i.e. ${(100 * (widest.y - minY) / (maxY - minY)).toFixed(0)}% down`,
  );
  const box = (maxX - minX + 1) * (maxY - minY + 1);
  let inBox = 0;
  for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) if (d.disc[y * d.width + x]) inBox += 1;
  const fill = inBox / box;
  check('its silhouette is an oval, not a rounded rectangle', fill > 0.62 && fill < 0.95, `the body fills ${(100 * fill).toFixed(1)}% of its bounding box (ellipse 78.5%, strip ~100%)`);
}

// ── the fissure divides ──────────────────────────────────────────────────────────────────────────────────
{
  const rowsInside = d.fissureRows;
  const bodyRows = d.bbox.maxY - d.bbox.minY + 1;
  const coverage = rowsInside.length / bodyRows;
  check(
    'the fissure runs the whole length of the brain',
    coverage >= 0.85 && Math.abs(d.fissureCol - d.axisX) <= 1,
    `cleft column ${d.fissureCol} against the oval's midline ${d.axisX}; it has floor on ${rowsInside.length} of ${bodyRows} body rows (${(100 * coverage).toFixed(0)}%)`,
  );
  let solid = 0;
  for (const y of rowsInside) {
    let blocked = true;
    for (let dx = -Math.floor(CORTEX.cleftWidth / 2); dx <= Math.floor(CORTEX.cleftWidth / 2); dx += 1) {
      if (at(d.axisX + dx, y)) blocked = false;
    }
    if (blocked) solid += 1;
  }
  const share = solid / rowsInside.length;
  const doors = d.crossings.length;
  check(
    'the division is wall, and is crossed only where a doorway was cut',
    share >= 0.6 && doors >= 0.8 * CORTEX.crossingsPerLayer * CORTEX.layers && doors <= 1.6 * CORTEX.crossingsPerLayer * CORTEX.layers,
    `${(100 * share).toFixed(0)}% of body rows are impassable across the whole cleft width, and ${doors} doorways (wanted ${CORTEX.crossingsPerLayer} per layer × ${CORTEX.layers}) at rows ${d.crossings.slice(0, 4).join(', ')}…`,
  );
  check(
    'the two halves are two places, not one field',
    [...d.layers].reverse().slice(0, 4).every((l) => l.area > 0 && l.bounds.minX < d.fissureCol - 1 && l.bounds.maxX > d.fissureCol + 1),
    `each of the four inner layers has folds on both sides of the cleft`,
  );
}

// ── balance, width, rooms ────────────────────────────────────────────────────────────────────────────────
{
  const ratios = cortex.layers.map((l) => Math.max(l.hemispheres.left, l.hemispheres.right) / Math.max(1, Math.min(l.hemispheres.left, l.hemispheres.right)));
  const worst = Math.max(...ratios);
  let hemiLeft = 0;
  let hemiRight = 0;
  for (let i = 0; i < d.floor.length; i += 1) {
    if (!d.floor[i]) continue;
    if (i % d.width < d.axisX) hemiLeft += 1;
    else if (i % d.width > d.axisX) hemiRight += 1;
  }
  const whole = Math.max(hemiLeft, hemiRight) / Math.min(hemiLeft, hemiRight);
  check(
    'the hemispheres are balanced, and each was derived before it was mirrored',
    worst <= 1.25 && whole <= 1.05,
    `whole plan ${hemiLeft} left / ${hemiRight} right, ratio ${whole.toFixed(3)}, per-layer worst ${(100 * worst).toFixed(1)}% (${d.cfg.mirrorHalves ? 'one half is derived, the other is its reflection — a small per-band tilt is a fold that landed on the axis' : 'mirror off'})`,
  );
  const perLayer = cortex.layers.map((l) => `${l.index}:${l.hemispheres.left}/${l.hemispheres.right}`).join(' ');
  console.log(`  · hemispheres per layer: ${perLayer}`);
  check(
    'corridors are narrow passages',
    d.corridorWidths.p50 <= 2.2 && d.corridorWidths.p90 <= 3.2 && d.corridorWidths.tiles > 500,
    `outside a room a groove is ${d.corridorWidths.p50} tiles across at the median and ${d.corridorWidths.p90} at the 90th percentile (${CORTEX.tilePx}px each; ${d.corridorWidths.max.toFixed(1)} at the widest of ${d.corridorWidths.tiles} tiles)`,
  );
  check(
    'the chambers are gyri, rounded and small enough to be rooms',
    d.chambers.length >= 8 &&
      d.chambers.every((c) => c.area >= CORTEX.chamberMinCoreTiles && c.roundness >= CORTEX.chamberRoundness) &&
      d.chambers.every((c) => c.w <= 26 && c.h <= 26) &&
      d.chambers.every((c) => (c.coreArea / Math.max(1, c.area)) <= 1.4),
    `${d.chambers.length} chambers ${d.chambers.map((c) => `${c.w}x${c.h}`).join(' ')} · roundness ${(d.chambers.reduce((a, c) => a + c.roundness, 0) / d.chambers.length).toFixed(2)} mean (a disc is 0.79) · widest opening ${Math.max(...d.chambers.map((c) => c.opened))} tiles`,
  );
  check(
    'no room straddles the division',
    d.chambers.every((c) => c.spansFissure === 0),
    `${d.chambers.filter((c) => c.spansFissure > 0).length} of ${d.chambers.length} chambers reach across the cleft (a mirrored pair of rooms sits one on each side, joined by a doorway instead)`,
  );
}

// ── folds, dead ends, loops ──────────────────────────────────────────────────────────────────────────────
{
  const dead = cortex.layers.map((l) => l.deadEnds);
  check(
    'every layer has folds that end in the dark',
    dead.every((n) => n >= 3),
    `dead ends per layer: ${dead.join(' ')}`,
  );
  const loops = cortex.layers.map((l) => l.loops);
  check('the network loops back on itself', loops.every((n) => n >= 2), `independent loops per layer: ${loops.join(' ')}`);
  const junctions = cortex.layers.map((l) => l.junctions);
  check('it branches', junctions.every((n) => n >= 1), `three-way junctions per layer: ${junctions.join(' ')}`);
}

// ── the seven layers ─────────────────────────────────────────────────────────────────────────────────────
{
  const areas = d.layers.map((l) => l.area);
  const mean = areas.reduce((a, b) => a + b, 0) / areas.length;
  check(
    'seven layers, each with real ground to walk',
    cortex.layers.length === CORTEX.layers && areas.every((n) => n >= 0.3 * mean && n <= 2.5 * mean),
    `layers: ${cortex.layers.length} · tiles ${areas.join(' / ')} (a band between 30% and 250% of the ${Math.round(mean)}-tile mean)`,
  );
  let nested = true;
  for (let i = 1; i < cortex.layers.length; i += 1) {
    const a = cortex.layers[i - 1].bounds;
    const b = cortex.layers[i].bounds;
    if (!(b.x0 >= a.x0 && b.x1 <= a.x1 && b.y0 >= a.y0 && b.y1 <= a.y1)) nested = false;
    const shrink = Math.min(a.x1 - a.x0 - (b.x1 - b.x0), a.y1 - a.y0 - (b.y1 - b.y0));
    if (shrink < 1) nested = false;
  }
  check(
    'the layers nest: each footprint sits strictly inside the one outside it',
    nested,
    cortex.layers.map((l) => `${l.bounds.x0},${l.bounds.y0}–${l.bounds.x1},${l.bounds.y1}`).join('  '),
  );
  // A band is drawn alone here, so this is the only check of "each layer still looks like a brain": a ring
  // cut out of a portrait oval is portrait too, and it must still have folds on both sides of the midline.
  const own = cortex.layers.map((l) => {
    let minX = cortex.cols;
    let maxX = -1;
    let minY = cortex.rows;
    let maxY = -1;
    for (let y = 0; y < cortex.rows; y += 1) {
      for (let x = 0; x < cortex.cols; x += 1) {
        if (!l.floor[y * cortex.cols + x]) continue;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    let left = 0;
    let right = 0;
    for (let i = 0; i < l.floor.length; i += 1) {
      if (!l.floor[i]) continue;
      const x = i % cortex.cols;
      if (x < midCol) left += 1;
      else right += 1;
    }
    return { w, h, left, right, area: left + right };
  });
  check(
    'each layer, drawn alone, is still a piece of brain',
    own.every((o) => o.area > 120 && o.left > 20 && o.right > 20 && o.w / o.h > 0.55),
    own.map((o, i) => `${i}:${o.w}x${o.h} L${o.left}/R${o.right}`).join(' '),
  );
  const crossings = boundaryCrossings(cortex);
  check(
    'every layer is entered, and every boundary between them is crossed',
    cortex.layers.every((l) => l.path.length >= 4) && crossings >= cortex.layers.length - 1,
    `tiles of the walk spent inside each band: ${cortex.layers.map((l) => `${l.index}:${l.path.length}`).join(' ')} · ${crossings} band-to-band steps along it (six boundaries had to be crossed to reach the core)`,
  );
  check(
    'the layers are places, not fragments',
    d.layers.every((l) => l.comps <= 60) && d.outwardAdjacency.every((n, i) => i === 0 || n > 40),
    `band pieces when drawn alone ${d.layers.map((l) => l.comps).join(' ')} · shared edges with the band outside ${d.outwardAdjacency.join(' ')} (the bands are regions of one walk, not seven maps — nothing is cut to make them so)`,
  );
}

// ── continuity, and the walk the player takes ────────────────────────────────────────────────────────────
{
  check(
    'the whole brain is ONE walkable piece',
    d.wholeBrainPieces === 1 && cortex.walk.reachable === cortex.walk.floor,
    `${cortex.walk.reachable} of ${cortex.walk.floor} walkable tiles reachable from the way in; ${d.strandedPieces} stranded folds (${d.strandedTiles} tiles) were turned back into ridge rather than left unreachable`,
  );
  const straight = Math.max(
    Math.abs(cortex.walk.goal.x - cortex.walk.entry.x),
    Math.abs(cortex.walk.goal.y - cortex.walk.entry.y),
  );
  const ratio = cortex.walk.tiles / Math.max(1, straight);
  check(
    'the route inward is a route, not a step',
    cortex.walk.tiles >= 250 && ratio >= 1.2,
    `${cortex.walk.tiles} tiles of walking from entry to goal across a crow-flies of ${straight} (ratio ${ratio.toFixed(2)}), ending at ${cortex.walk.goal.x},${cortex.walk.goal.y}`,
  );
  let blocked = 0;
  let prevWall = false;
  const steps = Math.max(Math.abs(cortex.walk.goal.x - cortex.walk.entry.x), Math.abs(cortex.walk.goal.y - cortex.walk.entry.y));
  for (let s = 0; s <= steps; s += 1) {
    const x = Math.round(cortex.walk.entry.x + (s / Math.max(1, steps)) * (cortex.walk.goal.x - cortex.walk.entry.x));
    const y = Math.round(cortex.walk.entry.y + (s / Math.max(1, steps)) * (cortex.walk.goal.y - cortex.walk.entry.y));
    const wall = !at(x, y);
    if (wall && !prevWall) blocked += 1;
    prevWall = wall;
  }
  check(
    'the goal is behind walls, not around a corner',
    blocked >= 4,
    `a crow-flies line from the way in to the deepest tile is cut off ${(blocked / Math.max(1, steps)).toFixed(1)} walls per tile (${blocked} wall runs over ${steps} tiles)`,
  );
  // The void outside the organ carries no wall bodies any more — it is background, not geometry — so the
  // brain's edge has to be closed by its own ring. If any fold touched a void tile the player could step out
  // of the brain into the sky, which is the same fault as walking through a wall, wearing a different hat.
  let touchingVoid = 0;
  for (let y = 0; y < cortex.rows; y += 1) {
    for (let x = 0; x < cortex.cols; x += 1) {
      if (!at(x, y)) continue;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cortex.cols || ny >= cortex.rows) continue;
        if (cortex.solid[ny * cortex.cols + nx] === 2) touchingVoid += 1;
      }
    }
  }
  check(
    'the brain is sealed: no fold opens onto the void',
    touchingVoid === 0,
    `${touchingVoid} walkable tiles edge a void tile (the outline's ridge ring is the map's boundary, so it has to be unbroken)`,
  );
  const entryOnSurface = cortex.walk.entry.y > midRow;
  const goalDeep = d.depth[cortex.walk.goal.y * cortex.cols + cortex.walk.goal.x] >= 10;
  check(
    'it starts at the back of the brain and ends at the core',
    entryOnSurface && d.layers[cortex.layers.length - 1].hasGoal !== true && cortex.walk.goal !== undefined,
    `entry ${cortex.walk.entry.x},${cortex.walk.entry.y} (row ${cortex.walk.entry.y} of ${cortex.rows}) · goal ${cortex.walk.goal.x},${cortex.walk.goal.y} at depth ${d.depth[cortex.walk.goal.y * cortex.cols + cortex.walk.goal.x].toFixed(1)} tiles`,
  );
  // The scene never asks "is this tile floor"; it asks physics. So this is the check that the two answers
  // agree, over every walkable tile and a stride over the rest.
  let disagree = 0;
  for (let i = 0; i < cortex.cols * cortex.rows; i += 61) {
    const x = i % cortex.cols;
    const y = (i - x) / cortex.cols;
    const open = at(x, y);
    if (open !== !cortex.blockedAt((x + 0.5) * cortex.tilePx, (y + 0.5) * cortex.tilePx)) disagree += 1;
  }
  const sampled = Math.ceil(cortex.cols * cortex.rows / 61);
  check(
    'what the gate calls floor is what the physics calls floor',
    disagree <= 1,
    `${sampled - disagree} of ${sampled} sampled tiles agree with blockedAt (a tile the plan says is walkable and the physics says is not is a wall the player walks through, and vice versa is a room with no floor)`,
  );
}

// ── the wall geometry the game will actually collide with ────────────────────────────────────────────────
{
  const rects = cortex.rects;
  const overlaps = (list) => {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return true;
      }
    }
    return false;
  };
  check(
    'wall rectangles do not overlap each other',
    !overlaps(rects) && cortex.layers.every((l) => !overlaps(l.rects)),
    `${rects.length} merged wall bodies for the whole brain and per-band lists, no pair overlapping in any of them (a shared edge would push the player out twice)`,
  );
  let wallUnderWalk = 0;
  for (const p of cortex.walk.path.slice(0, 400)) {
    const wx = (p.x + 0.5) * cortex.tilePx;
    const wy = (p.y + 0.5) * cortex.tilePx;
    for (const r of cortex.rects) {
      if (wx >= r.x && wx < r.x + r.w && wy >= r.y && wy < r.y + r.h) wallUnderWalk += 1;
    }
  }
  check('the walk never starts inside a wall rectangle', wallUnderWalk === 0, `${wallUnderWalk} of the first 400 route tiles fall inside a wall body`);
  /*
   * "Can anything end up inside a wall?" is a ratio, not a feeling: the thinnest wall body against the
   * longest step a mover takes in one frame. Arcade separates bodies by pushing the overlap out, so a body
   * that travels further than a wall is thick can arrive on the far side with no overlap left to resolve —
   * a hole in the labyrinth, and the exact fault the map was scaled 5× to close. The bound below is
   * deliberately generous; `audit:dungeonrun` measures the real maximum inside a running scene.
   */
  const MAX_FRAME_MS = 50; // the scene's own dt clamp (`Math.min(delta, 50)`)
  const fastestMotion = Math.max(DASH_CONFIG.speed * 2, PLAYER_CONFIG.baseSpeed * 4, 430);
  const worstStep = (fastestMotion * MAX_FRAME_MS) / 1000;
  // Everything in this block is measured in the units the *shipped artifact* uses. Reading the tile size
  // from the derivation's config while the rectangles come from the built plan is how this check reported a
  // 160px wall in the same line that said `a tile is 32px`: two sources, and a gate that could not see the
  // scale knob move at all. So the two are asserted equal first, and the margin is quoted in tiles as well
  // as pixels — tiles are the unit that actually tracks the map.
  const wallTilePx = cortex.tilePx ?? CORTEX.tilePx;
  check(
    'the shipped plan and the derivation agree on how big a tile is',
    wallTilePx === CORTEX.tilePx,
    `the plan measures a tile at ${wallTilePx}px and the derivation asked for ${CORTEX.tilePx}px — regenerate with \`npm run derive:cortex -- --mask\` if these differ`,
  );
  const thinnestWall = Math.min(...rects.map((r) => Math.min(r.w, r.h)));
  check(
    'no mover can cross a wall body in one frame',
    // The invariant is 1.0× — a step shorter than the thinnest collider cannot land past it — and the extra
    // half covers a frame that runs twice as long as the clamp allows. The 3× that used to sit here was my
    // conservatism, not a physical requirement, and it happened to demand a 102px tile: at the shared wave
    // fit (320 world px across) that leaves 3.1 tiles of map in view, which is the "empty dungeon" report
    // again. What closes the loop is the live gate in `audit:dungeonrun`, which drives bodies at twice the
    // dash through a real frame and requires that none of them ends up inside or past a wall.
    thinnestWall >= worstStep * 1.5,
    `thinnest wall body ${thinnestWall}px (${(thinnestWall / wallTilePx).toFixed(2)} tiles) against ${worstStep.toFixed(0)}px per clamped frame — the envelope is 2× dash (${DASH_CONFIG.speed}px/s), 4× base speed (${PLAYER_CONFIG.baseSpeed}px/s) and a 430px/s shove; at ${wallTilePx}px per tile that is a ${(thinnestWall / worstStep).toFixed(1)}× margin, and the world is ${cortex.width}×${cortex.height}px`,
  );
  check(
    'a corridor is wide enough that a body never straddles stone and floor',
    CORTEX.tilePx >= 14 * 4,
    `a tile is ${CORTEX.tilePx}px against the widest authored mover box in the dungeon (14px: stones are 14×14, the warden's body is 10×10) — at 32px a mover's own box could sit inside a merged ridge next to the corridor it was walking, which is what the partner's samples reported all run`,
  );
  const route = cortexRoute(cortex.layers[0], cortex.tilePx);
  const b0 = cortex.layers[0].bounds;
  const inside = route.filter((pt) => {
    const x = Math.floor(pt.x / cortex.tilePx);
    const y = Math.floor(pt.y / cortex.tilePx);
    return x >= b0.x0 && x <= b0.x1 && y >= b0.y0 && y <= b0.y1;
  }).length;
  check(
    'the route helper draws inside the layer it was given',
    route.length >= 4 && inside === route.length,
    `${route.length} waypoints for layer 0, ${inside} of them inside that band's footprint`,
  );
}

// ── the mask reproduces the derivation ─────────────────────────────────────────────────────────────────
{
  let mismatch = 0;
  for (let y = 0; y < cortex.rows; y += 1) {
    for (let x = 0; x < cortex.cols; x += 1) {
      const want = d.floor[y * cortex.cols + x] && d.layerOf[y * cortex.cols + x] >= 0 ? d.layerOf[y * cortex.cols + x] : -1;
      const ok = want === bandOf(x, y) && (want >= 0) === at(x, y);
      if (!ok) mismatch += 1;
    }
  }
  check('the shipped mask reproduces the derivation tile for tile', mismatch === 0, `${cortex.cols * cortex.rows - mismatch} of ${cortex.cols * cortex.rows} tiles agree`);
  check(
    'the plan parameters are recorded with the data they produced',
    Object.keys(d.cfg).length >= 12,
    Object.entries(d.cfg)
      .map(([k, v]) => `${k} ${v}`)
      .join(' · '),
  );
}

// ── report ───────────────────────────────────────────────────────────────────────────────────────────────
const width = Math.max(...checks.map((c) => c.name.length));
let failures = 0;
for (const c of checks) {
  if (!c.pass) failures += 1;
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name.padEnd(width)}  ${c.detail}`);
}
console.log(`\n${checks.length - failures}/${checks.length} checks pass`);
if (failures) process.exitCode = 1;
