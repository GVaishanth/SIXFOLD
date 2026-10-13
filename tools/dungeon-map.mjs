#!/usr/bin/env node
/**
 * Dungeon map gate — `npm run audit:dungeon`.
 *
 * Node only: no browser, no dev server, no running scene. It bundles the *shipped* generator with
 * esbuild and asserts its invariants against the same config the game reads, which is why this is the
 * first gameplay gate that can sit inside `npm run verify`. The rules it checks are the ones listed in
 * docs/plans/2026-10-11-dungeon-mode-design.md §6 — a site in a wall, two sites welded at a cell seam,
 * a cache naming a table that does not exist, or an awake budget over the ceiling are all invisible in
 * a single frame of play and trivial to assert here.
 *
 * It imports no copies of the logic. If `map.ts` changes, this gate changes with it, or it fails.
 */
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const esbuild = require('esbuild');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' || detail === undefined ? '' : ` — ${fmt(detail)}`}`);
};
const fmt = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

/* ----------------------------------------------------------------- build --- */
const outfile = path.join(mkdtempSync(path.join(tmpdir(), 'sixfold-dungeon-')), 'bundle.mjs');
await esbuild.build({
  stdin: {
    contents: `
      export * from '@/game/dungeon/map';
      export { DUNGEON, ARENA, WAVE_CONFIG, PLAYER_CONFIG } from '@/config/gameConfig';
      export { FLOOR_REGISTRY } from '@/data/floors/floors';
      export { DROP_TABLES, PICKUP_REGISTRY, rollTable } from '@/data/loot/loot';
      export { createRng } from '@/utils/math';
    `,
    resolveDir: ROOT,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  alias: { '@': path.join(ROOT, 'src') },
  // The config module reads `import.meta.env.DEV` for its debug switch; node has no `env` on
  // `import.meta`, and the gate wants the shipped shape anyway.
  define: {
    'import.meta.env.DEV': 'false',
    'import.meta.env.PROD': 'true',
    'import.meta.env.VITE_SIXFOLD_DEBUG': '"false"',
  },
  logLevel: 'silent',
});
const M = await import(pathToFileURL(outfile).href);
const { planChunk, planStrip, siteWorld, cellAt, liveCells, countSites, biomeForCell, cacheTableId, circuitFor, routeDistance } = M;
const { DUNGEON, ARENA, FLOOR_REGISTRY, DROP_TABLES, PICKUP_REGISTRY, rollTable, createRng, PLAYER_CONFIG } = M;

check('the bundle exposes the shipped generator', typeof planChunk === 'function' && typeof rollTable === 'function');

const CHUNKS = DUNGEON.chunks;
const CELL_W = ARENA.width;
const CELL_H = ARENA.height;
const plan = planStrip(20261011, { chunks: CHUNKS, cellWidth: CELL_W, cellHeight: CELL_H });

/* --------------------------------------------------------- determinism --- */
const a = planChunk(7, 3, { cellWidth: CELL_W, cellHeight: CELL_H });
const b = planChunk(7, 3, { cellWidth: CELL_W, cellHeight: CELL_H });
check('planChunk(seed, i) is pure', JSON.stringify(a) === JSON.stringify(b), `${a.sites.length} vs ${b.sites.length} sites`);

const stripAgain = planStrip(20261011, { chunks: CHUNKS, cellWidth: CELL_W, cellHeight: CELL_H });
check('planStrip agrees with planChunk cell by cell',
  JSON.stringify(stripAgain.cells) === JSON.stringify(plan.cells));

let differentSeedDiffers = false;
for (let seed = 1; seed <= 12 && !differentSeedDiffers; seed += 1) {
  const p1 = planStrip(seed, { chunks: CHUNKS, cellWidth: CELL_W, cellHeight: CELL_H });
  const p2 = planStrip(seed + 1, { chunks: CHUNKS, cellWidth: CELL_W, cellHeight: CELL_H });
  const f = (p) => p.cells.map((c) => c.sites.map((s) => `${s.kind}${s.fx.toFixed(3)}${s.fy.toFixed(3)}`).join(',')).join('|');
  if (f(p1) !== f(p2)) differentSeedDiffers = true;
}
check('a different seed is a different map', differentSeedDiffers);

const nearby = planChunk(8, 0, { cellWidth: CELL_W, cellHeight: CELL_H });
const nearby2 = planChunk(9, 0, { cellWidth: CELL_W, cellHeight: CELL_H });
check('cell 0 of neighbouring seeds is not the same cell',
  JSON.stringify(nearby.sites) !== JSON.stringify(nearby2.sites),
  `${nearby.sites.length} vs ${nearby2.sites.length} sites`);

/* -------------------------------------------------------------- geometry --- */
const pad = ARENA.wall + DUNGEON.siteInset;
let outsideWallBand = 0;
let budgetOver = 0;
let groveOver = 0;
let unresolvedTables = 0;
let gapViolations = 0;
let propsOnSites = 0;
let propsOffSpine = 0;
let propsOnCrossing = 0;
let propsOnTooth = 0;
let outsideStrip = 0;
const allSites = [];
for (const cell of plan.cells) {
  if (cell.awakeBudget > DUNGEON.maxAwakePerChunk) budgetOver += 1;
  let awake = 0;
  for (const site of cell.sites) {
    const world = siteWorld(site, plan);
    // The band is a property of the *cell* the site lives in, so the test is on the cell-relative
    // position; the strip's own edges are checked separately below. (Testing `world.x` against
    // `CELL_W - pad` flags every site past cell 0, which is a wrong gate, not a wrong map.)
    const localX = site.fx * CELL_W;
    const localY = site.fy * CELL_H;
    allSites.push({ ...site, world, localX, localY });
    if (localX < pad - 0.5 || localX > CELL_W - pad + 0.5 || localY < pad - 0.5 || localY > CELL_H - pad + 0.5) {
      outsideWallBand += 1;
    }
    if (world.x < 0 || world.x > plan.width) outsideStrip += 1;
    if (site.kind === 'grove') {
      awake += site.n;
      if (site.n > DUNGEON.maxAwakePerGrove) groveOver += 1;
    }
    if (site.kind === 'cache' && !DROP_TABLES[site.tableId]) unresolvedTables += 1;
  }
  if (awake > cell.awakeBudget + 0.001) budgetOver += 1;
  for (const prop of cell.props) {
    // Props live inside the spine, where nothing walks: relief on a wall cannot hide a stone or trip a
    // chase, and the crossing and the tooth are kept clear so the route still reads as built.
    const py = prop.fy * CELL_H;
    const px = prop.fx * CELL_W;
    const band = cell.circuit.spine;
    if (py < band.fy0 * CELL_H - 0.5 || py > band.fy1 * CELL_H + 0.5) propsOffSpine += 1;
    if (Math.abs(px - cell.circuit.gapFx * CELL_W) < DUNGEON.passage / 2) propsOnCrossing += 1;
    if (Math.abs(px - cell.circuit.toothFx * CELL_W) < DUNGEON.passage / 2) propsOnTooth += 1;
    if (cell.sites.some((s) => Math.abs(s.fx - prop.fx) * CELL_W < 8 && Math.abs(s.fy - prop.fy) * CELL_H < 8)) {
      propsOnSites += 1;
    }
  }
}
for (let i = 0; i < allSites.length; i += 1) {
  for (let j = i + 1; j < allSites.length; j += 1) {
    const dx = Math.abs(allSites[i].world.x - allSites[j].world.x);
    const dy = Math.abs(allSites[i].world.y - allSites[j].world.y);
    if (dx < DUNGEON.minSiteGap - 0.5 && dy < DUNGEON.minSiteGap - 0.5) gapViolations += 1;
  }
}
check('no site sits inside the wall band', outsideWallBand === 0, `${outsideWallBand} offenders, pad ${pad}px`);
check('no site falls outside the strip', outsideStrip === 0, outsideStrip);
check('two sites are never closer than minSiteGap', gapViolations === 0, `${gapViolations} pairs (across cell seams too)`);
check('props never stand on a stone', propsOnSites === 0, propsOnSites);
check('a cell never over-spends its awake budget', budgetOver === 0, budgetOver);
check('no grove wakes more than maxAwakePerGrove', groveOver === 0, groveOver);
check('every cache names a table that exists', unresolvedTables === 0, unresolvedTables);

/* -------------------------------------------------------------- labyrinth --- */
// Everything below is the claim the mode makes: one path, no choices, and a centre to arrive at.
let offRoute = 0;
let inWall = 0;
for (const cell of plan.cells) {
  const circuit = cell.circuit;
  for (const site of cell.sites) {
    if (routeDistance(circuit, site.fx, site.fy, CELL_W, CELL_H) > 1.5) offRoute += 1;
    // A site is either in a lane (clear of the spine) or in the crossing (inside the gap's x-span).
    const fy = site.fy * CELL_H;
    const fx = site.fx * CELL_W;
    const inBand = fy > circuit.spine.fy0 * CELL_H + 0.5 && fy < circuit.spine.fy1 * CELL_H - 0.5;
    const inGap = Math.abs(fx - circuit.gapFx * CELL_W) <= DUNGEON.passage / 2 + 0.5;
    const inTooth =
      Math.abs(fx - circuit.toothFx * CELL_W) <= DUNGEON.passage / 2 + 0.5 &&
      (circuit.entersTop ? fy < circuit.spine.fy0 * CELL_H : fy > circuit.spine.fy1 * CELL_H);
    if ((inBand && !inGap) || inTooth) inWall += 1;
  }
}
check('every site stands on the corridor, not in a wall', offRoute === 0, `${offRoute} off the route`);
check('no site is buried in the spine or the tooth', inWall === 0, inWall);
check('props are carved into the spine', propsOffSpine === 0 && propsOnSites === 0,
  `${propsOffSpine} off the band, ${propsOnSites} on a stone`);
check('props never sit in the crossing or on the tooth', propsOnCrossing === 0 && propsOnTooth === 0,
  `${propsOnCrossing}/${propsOnTooth}`);

let badTooth = 0;
let badAlternate = 0;
let tightPassage = 0;
let routeShort = 0;
let routeWalk = 0;
for (const cell of plan.cells) {
  const circuit = cell.circuit;
  // The tooth has to be far enough right of the gap that the crossing cannot be skipped, and far
  // enough left of the next cell that a lane still opens onto it.
  if (circuit.toothFx * CELL_W < circuit.gapFx * CELL_W + DUNGEON.passage) badTooth += 1;
  if (circuit.toothFx > 0.95) badTooth += 1;
  if (circuit.entersTop !== cell.index % 2 === 0) badAlternate += 1;
  if (DUNGEON.passage < PLAYER_CONFIG.radius * 2 + 12) tightPassage += 1;
  const pts = circuit.route;
  let len = 0;
  for (let i = 0; i < pts.length - 1; i += 1) {
    len += Math.hypot((pts[i + 1].fx - pts[i].fx) * CELL_W, (pts[i + 1].fy - pts[i].fy) * CELL_H);
  }
  routeWalk += len;
  // A circuit is worth the name only if walking it is longer than walking past it.
  if (len < CELL_W * 1.05) routeShort += 1;
}
check('the tooth always closes the lane before the crossing is behind you', badTooth === 0, badTooth);
check('the entering lane alternates, so every other cell forces the crossing', badAlternate === 0, badAlternate);
check('a passage is wide enough for the warden', tightPassage === 0,
  `passage ${DUNGEON.passage} vs body ${PLAYER_CONFIG.radius * 2}`);
check('each circuit is longer across than the cell is wide', routeShort === 0, routeShort);
check(`the walk is longer than the strip (${Math.round(routeWalk)} px vs ${plan.width})`, routeWalk > plan.width);

const lastCell = plan.cells[plan.cells.length - 1];
const goalCell = plan.cells.filter((c) => c.circuit.goal).length;
check('the centre belongs to the last circuit and to no other',
  goalCell === 1 && Boolean(lastCell.circuit.goal), `${goalCell} goals`);
const goalSpot = lastCell.circuit.goal;
check('the centre is past the spine’s end, where the lanes merge',
  Boolean(goalSpot) && goalSpot.fx > lastCell.circuit.spineEndFx &&
    goalSpot.fy > lastCell.circuit.spine.fy0 && goalSpot.fy < lastCell.circuit.spine.fy1,
  goalSpot ? `fx ${goalSpot.fx.toFixed(2)} vs end ${lastCell.circuit.spineEndFx.toFixed(2)}` : 'missing');
check('the plan’s goal is that spot, in world pixels',
  Math.abs(plan.goal.x - ((plan.chunkCount - 1) * CELL_W + goalSpot.fx * CELL_W)) < 0.5 &&
    Math.abs(plan.goal.y - goalSpot.fy * CELL_H) < 0.5,
  `${Math.round(plan.goal.x)},${Math.round(plan.goal.y)}`);
check('the spine stops short only in the last cell',
  plan.cells.slice(0, -1).every((c) => c.circuit.spineEndFx === 1) && lastCell.circuit.spineEndFx < 1,
  `${plan.cells.map((c) => c.circuit.spineEndFx.toFixed(2)).join(' ')}`);
check('no site sits in the centre, so the goal is empty floor',
  plan.cells.every((c) => c.sites.every((s) => !(c === lastCell && s.fx > lastCell.circuit.spineEndFx))),
  lastCell.sites.filter((s) => s.fx > lastCell.circuit.spineEndFx).length);
// Circuits are counted from the outside in, and the centre is a line of its own: 6 cells, 7 lines.
check('the labyrinth counts chunks + 1 lines', DUNGEON.chunks + 1 === CHUNKS + 1 && plan.chunkCount === CHUNKS,
  `${CHUNKS + 1} lines`);
check('a circuit is drawn from the same rng for the same seed and cell',
  JSON.stringify(circuitFor(2, CHUNKS, CELL_W, CELL_H, createRng(7))) ===
    JSON.stringify(circuitFor(2, CHUNKS, CELL_W, CELL_H, createRng(7))));

/* ----------------------------------------------------------------- entry --- */
const first = plan.cells[0];
const entry = first.sites[0];
check('cell 0 opens with a spring, so a run cannot start stranded', entry?.kind === 'spring', entry?.kind);
check('the entry spring has charges to spend', entry?.n === DUNGEON.springCharges, entry?.n);
const entrySite = allSites.find((s) => s.id === entry?.id);
check('the entry spring is in the lane the walk starts in',
  Boolean(entry) && Math.abs(entry.fy - first.circuit.laneTopFy) < 0.001,
  entry ? `fy ${entry.fy.toFixed(3)} vs lane ${first.circuit.laneTopFy.toFixed(3)}` : 'missing');
check('the entry is before the first crossing, so the run cannot start past its own walls',
  Boolean(entry) && entry.fx < first.circuit.gapFx, entry ? `fx ${entry.fx.toFixed(2)} < ${first.circuit.gapFx.toFixed(2)}` : 'missing');
check('the entry spring sits at the strip’s own edge, one seam-inset in',
  Boolean(entrySite) && entrySite.chunk === 0
    && Math.abs(entrySite.localX - (pad + DUNGEON.minSiteGap / 2)) < 1.5,
  // The x box is inset by half the minimum gap on both sides — that is what makes the seam rule hold
  // without a global pass — so the entry cannot be at `pad` itself, only `pad + gap/2` away from it.
  entrySite ? `localX ${Math.round(entrySite.localX)} vs ${pad}+${DUNGEON.minSiteGap / 2}` : 'missing');

/* -------------------------------------------------------------- contents --- */
const kinds = {};
for (const site of allSites) kinds[site.kind] = (kinds[site.kind] ?? 0) + 1;
check('the strip is not empty', allSites.length >= CHUNKS * 2, `${allSites.length} sites over ${CHUNKS} cells`);
check('it always offers a fight and a reward', (kinds.grove ?? 0) > 0 && (kinds.cache ?? 0) > 0, JSON.stringify(kinds));

let sparse = 0;
for (let seed = 0; seed < 40; seed += 1) {
  const p = planStrip(seed, { chunks: CHUNKS, cellWidth: CELL_W, cellHeight: CELL_H });
  const sites = p.cells.flatMap((c) => c.sites);
  const g = sites.filter((s) => s.kind === 'grove').length;
  const c = sites.filter((s) => s.kind === 'cache').length;
  if (g === 0 || c === 0) sparse += 1;
}
check('40 seeds never produce a strip with no groves or no caches', sparse === 0, `${sparse} degenerate strips`);

check('countSites agrees with the cells', countSites(plan, 'spring') === allSites.filter((s) => s.kind === 'spring').length,
  countSites(plan, 'spring'));
check('the strip is exactly chunks × one cell wide', plan.width === CELL_W * CHUNKS && plan.height === CELL_H,
  `${plan.width}×${plan.height}`);

/* ----------------------------------------------------------- streaming --- */
check('cellAt clamps at both ends', cellAt(plan, -9999) === 0 && cellAt(plan, 1e9) === CHUNKS - 1,
  `${cellAt(plan, -9999)}, ${cellAt(plan, 1e9)}`);
check('liveCells never reaches past the strip',
  liveCells(plan, 0).every((i) => i >= 0 && i < CHUNKS) && liveCells(plan, plan.width).every((i) => i >= 0 && i < CHUNKS),
  `${liveCells(plan, 0).join(',')} / ${liveCells(plan, plan.width).join(',')}`);
check('liveCells follows the camera', liveCells(plan, CELL_W * 2.5).join(',') === '1,2,3', liveCells(plan, CELL_W * 2.5).join(','));

/* --------------------------------------------------------------- walking --- */
// `corridorStep` is what the partner steers by. It is pure, so the three rules it has to get right are
// checked here rather than left to a browser probe that can only see one walk at a time.
const route = M.stripRoute(plan);
const lens = M.routeLengths(route);
const rects = plan.cells.map((cell) => {
  const c = cell.circuit;
  const x0 = cell.index * CELL_W;
  const bandTop = c.spine.fy0 * CELL_H;
  const bandBottom = c.spine.fy1 * CELL_H;
  const out = [
    { x: x0, y: bandTop, w: c.gapFx * CELL_W - (DUNGEON.passage / 2) - x0, h: bandBottom - bandTop },
    { x: x0 + c.gapFx * CELL_W + DUNGEON.passage / 2, y: bandTop, w: x0 + c.spineEndFx * CELL_W - (x0 + c.gapFx * CELL_W + DUNGEON.passage / 2), h: bandBottom - bandTop },
  ];
  const toothY = c.entersTop ? ARENA.wall : bandBottom;
  const toothH = c.entersTop ? bandTop - ARENA.wall : CELL_H - ARENA.wall - bandBottom;
  out.push({ x: x0 + c.toothFx * CELL_W - DUNGEON.passage / 2, y: toothY, w: DUNGEON.passage, h: toothH });
  return out.filter((r) => r.w > 0 && r.h > 0);
}).flat();
const blocked = (a, b) => rects.some((rect) => M.crossesRect(a.x, a.y, b.x, b.y, rect));
/** A point on a cell's own corridor, in world pixels — so the fixtures below are on the path by eye. */
const onRoute = (cellIndex, at) => {
  const spot = M.routePoint(plan.cells[cellIndex].circuit, at, CELL_W, CELL_H);
  return { x: cellIndex * CELL_W + spot.fx * CELL_W, y: spot.fy * CELL_H };
};

// 1. A clear line is walked straight, with no detour through the corridor. Both points are sampled off
// the same leg of the route, so nothing stands between them by construction.
const same = onRoute(2, 0.04);
const sameTarget = onRoute(2, 0.11);
const straight = M.corridorStep(route, lens, same, sameTarget, DUNGEON.partner.corridorLookahead, blocked);
check('a clear line is walked straight, not along the polyline',
  Boolean(straight) && Math.abs(straight.x - sameTarget.x) < 0.5 && Math.abs(straight.y - sameTarget.y) < 0.5
    && straight.committed === false,
  straight ? `step ${Math.round(straight.x)},${Math.round(straight.y)}` : 'null');

// 2. A target across the spine is not walked into the spine: the step points along the lane instead.
const start0 = onRoute(0, 0.05);
const across = M.corridorStep(route, lens, start0, onRoute(0, 0.75), DUNGEON.partner.corridorLookahead, blocked);
check('a target on the far side of the spine is never aimed straight at',
  Boolean(across) && M.crossesRect(start0.x, start0.y, across.x, across.y, {
    x: 0, y: plan.cells[0].circuit.spine.fy0 * CELL_H, w: plan.cells[0].circuit.gapFx * CELL_W - DUNGEON.passage / 2, h: 1,
  }) === false,
  across ? `step ${Math.round(across.x)},${Math.round(across.y)}` : 'null');

// 3. A pocket — floor the route passes beside — must not be read as "the target is underfoot".
const c0 = plan.cells[0].circuit;
const pocket = { x: (c0.toothFx + 0.14) * CELL_W, y: c0.laneTopFy * CELL_H };
const inLane = onRoute(1, 0.15);
const driven = M.corridorStep(route, lens, inLane, pocket, DUNGEON.partner.corridorLookahead, blocked, 1);
check('a pocket target is committed to, not jittered at',
  Boolean(driven) && driven.committed === true && driven.x > inLane.x,
  driven ? `step ${Math.round(driven.x)} from ${Math.round(inLane.x)}, heading east` : 'null');
const turned = M.corridorStep(route, lens, inLane, pocket, DUNGEON.partner.corridorLookahead, blocked, -1);
check('and the heading it was given is the heading it keeps',
  Boolean(turned) && turned.x < inLane.x, turned ? `step ${Math.round(turned.x)}` : 'null');

// 4. Off the path yourself: get back on it before doing anything clever.
const drifted = { x: (c0.gapFx + 0.02) * CELL_W, y: (c0.spine.fy0 + 0.04) * CELL_H };
void drifted;
const rejoin = M.corridorStep(route, lens, drifted, pocket, DUNGEON.partner.corridorLookahead, blocked, 1);
// (the drift is measured from the corridor's own distance, which is what the walker is told to fix)
check('a walker off the corridor is put back on it',
  Boolean(rejoin) && M.routeDistance(c0, rejoin.fx ?? rejoin.x / CELL_W, rejoin.y / CELL_H, CELL_W, CELL_H) < 2,
  rejoin ? `step ${Math.round(rejoin.x)},${Math.round(rejoin.y)}` : 'null');
check('and the strip has no corridor to follow past its own ends',
  M.corridorStep([], [], { x: 0, y: 0 }, { x: 1, y: 1 }, 52, blocked) === null);

// 5. The two things the mode places outside the site rules: the stone you read, and the charts you find.
const inRect = (point) => rects.some((r) => point.x > r.x && point.x < r.x + r.w && point.y > r.y && point.y < r.y + r.h);
const guide = M.guideSpot(plan);
const guideLocal = { fx: guide.x / CELL_W, fy: guide.y / CELL_H };
check('the guide stone stands on the way in, ahead of the spawn and clear of every wall',
  !inRect(guide) &&
    M.routeDistance(plan.cells[0].circuit, guideLocal.fx, guideLocal.fy, CELL_W, CELL_H) <= 2 &&
    guide.x > (ARENA.wall + ARENA.padding) * 2 &&
    guide.x < plan.cells[0].circuit.gapFx * CELL_W - DUNGEON.passage / 2,
  `at ${guide.x},${guide.y} — clear of the west wall, and before the first crossing at ${Math.round(plan.cells[0].circuit.gapFx * CELL_W - DUNGEON.passage / 2)}`);
const charts = M.chartSpots(plan);
const offCorridor = charts.filter((spot) => {
  const circuit = plan.cells[spot.cell].circuit;
  return M.routeDistance(circuit, (spot.x - spot.cell * CELL_W) / CELL_W, spot.y / CELL_H, CELL_W, CELL_H) > 1.5;
}).length;
check('every chart is on its cell\'s corridor, not buried in stone',
  charts.length === 3 && offCorridor === 0 && charts.every((spot) => !inRect(spot)),
  `${charts.length} charts in ${new Set(charts.map((s) => s.cell)).size} distinct cells, ${offCorridor} off the corridor`);
// A chart that lands on a stone would be paid out by the grove you were going to wake anyway.
const onStones = charts.filter((spot) =>
  plan.cells[spot.cell].sites.some(
    (site) => Math.hypot(spot.x - (site.fx * CELL_W + spot.cell * CELL_W), spot.y - site.fy * CELL_H) < 40,
  ),
).length;
check('and no chart is lying on a stone', onStones === 0, `${onStones} within 40px of a site`);
check('and the charts are the same charts next time',
  JSON.stringify(charts) === JSON.stringify(M.chartSpots(planStrip(20261011, { chunks: CHUNKS, cellWidth: CELL_W, cellHeight: CELL_H }))),
  charts.map((s) => `${s.cell}:${s.x},${s.y}`).join(' '));

/* ------------------------------------------------------------- biomes --- */
const run = [0, 1, 2, 3, 4, 5].map((i) => biomeForCell(99, i, { cellWidth: CELL_W, cellHeight: CELL_H }));
check('a biome lasts two cells, so the strip reads as regions',
  run[0] === run[1] && run[2] === run[3] && run[4] === run[5] && run[0] !== run[2], run.join(','));
check('every biome the strip names is in the registry',
  plan.cells.every((c) => Boolean(FLOOR_REGISTRY[c.biome]?.palette)),
  plan.cells.map((c) => c.biome).join(','));
check('every biome carries a prop family and a hazard kind',
  plan.cells.every((c) => Boolean(FLOOR_REGISTRY[c.biome]?.props) && Boolean(FLOOR_REGISTRY[c.biome]?.hazard?.kind)));
check('a cache falls back to a table that exists when the biome’s does not',
  Boolean(DROP_TABLES[cacheTableId(999)]), cacheTableId(999));

/* --------------------------------------------------------------- rolling --- */
let empty = 0;
let unknown = 0;
for (let i = 0; i < 400; i += 1) {
  const rolls = rollTable(DROP_TABLES.dungeon_cache, createRng(i + 1), 1);
  if (rolls.length === 0) empty += 1;
  for (const r of rolls) {
    if (!PICKUP_REGISTRY[r.id]) unknown += 1;
    if (r.count < 1) unknown += 1;
  }
}
check('a cache always pays out something', empty === 0, `${empty} empty rolls of 400`);
check('a cache never rolls a pickup id that does not exist', unknown === 0, unknown);

// `bonus` multiplies each entry's `chance`, so 0 must silence every *gated* entry while the
// ungated ones (chance omitted) keep rolling. `trash_low` deliberately has an ungated essence_orb in
// `entries` as well as in `guaranteed`, so the assertion is about the gated ids, not about length.
const gatedIds = [...(DROP_TABLES.trash_low.guaranteed ?? []), ...DROP_TABLES.trash_low.entries]
  .filter((e) => (e.chance ?? 1) < 1)
  .map((e) => e.id);
const ungated = [...new Set([...(DROP_TABLES.trash_low.guaranteed ?? []), ...DROP_TABLES.trash_low.entries]
  .filter((e) => (e.chance ?? 1) === 1)
  .map((e) => e.id))];
let leaked = 0;
let guaranteedSurvived = 0;
for (let i = 0; i < 300; i += 1) {
  const rolls = rollTable(DROP_TABLES.trash_low, createRng(i + 1), 0);
  if (rolls.some((r) => gatedIds.includes(r.id))) leaked += 1;
  if (rolls.some((r) => r.id === 'essence_orb')) guaranteedSurvived += 1;
  for (const r of rolls) if (!ungated.includes(r.id)) leaked += 1;
}
check('bonus 0 silences every gated entry and keeps the ungated ones',
  leaked === 0 && guaranteedSurvived === 300 && gatedIds.length > 0,
  `leaked ${leaked}, ungated rolls ${guaranteedSurvived}/300, gated ids ${gatedIds.join('/')}`);
const orbRange = new Set();
for (let i = 0; i < 300; i += 1) {
  const drop = rollTable(DROP_TABLES.trash_low, createRng(i + 1000), 1).find((d) => d.id === 'essence_orb');
  if (drop) orbRange.add(drop.count);
}
check('counts stay inside the table’s own bounds',
  [...orbRange].every((n) => n >= 1 && n <= 2), `essence_orb counts ${[...orbRange].sort().join(',')}`);

/* ------------------------------------------------------------- verdict --- */
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} dungeon-map checks passed`);
if (failed.length) {
  console.log(failed.map((f) => `  FAILED: ${f.name} — ${fmt(f.detail)}`).join('\n'));
}
process.exit(failed.length ? 1 : 0);
