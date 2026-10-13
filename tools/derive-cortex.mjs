#!/usr/bin/env node
/**
 * Writes the derived brain floor plan out for a human to look at — `npm run derive:cortex`.
 *
 * A layout that is only numbers in a file is a layout nobody can judge, and the whole complaint this answers
 * is that the dungeon *looked* like a strip. So this prints the measurements and draws the plans: the base
 * silhouette with its folds, then one picture per layer, then all seven superimposed so the nesting is a
 * thing you can see rather than a claim.
 *
 *   node tools/derive-cortex.mjs              report + /home/user/audit/cortex/*.svg
 *   node tools/derive-cortex.mjs --mask       also rewrite src/game/dungeon/cortexMask.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CORTEX, ROOT, deriveCortex, planSvg } from './cortex.mjs';
import { canvas, writePng } from './png-write.mjs';

const OUT_DIR = path.join(ROOT, '..', 'audit', 'cortex');
const wantMask = process.argv.includes('--mask');
const SCALE = Number(process.env.CORTEX_SCALE ?? 4);
const FLOOR = [232, 226, 210];
const WALL = [42, 37, 54];
const VOID = [18, 16, 26];
const SHADES = [
  [43, 39, 64],
  [58, 51, 85],
  [77, 67, 112],
  [97, 83, 141],
  [122, 103, 170],
  [156, 134, 198],
  [232, 226, 210],
];

/** The plan as a picture: no labels, no legend, no decoration — the geometry is the drawing. */
function paint(file, layerIndex) {
  const c = canvas(d.width * SCALE, d.height * SCALE, VOID);
  for (let y = 0; y < d.height; y += 1) {
    for (let x = 0; x < d.width; x += 1) {
      const i = y * d.width + x;
      if (layerIndex === null) {
        if (d.floor[i]) c.tile(x, y, FLOOR, SCALE);
        else if (d.disc[i]) c.tile(x, y, WALL, SCALE);
        continue;
      }
      if (d.layers[layerIndex].mask[i]) c.tile(x, y, FLOOR, SCALE);
      else if (d.disc[i]) c.tile(x, y, WALL, SCALE);
    }
  }
  if (layerIndex !== null) {
    for (const y of d.crossings) c.rect(d.fissureCol - 2, y, d.fissureCol + 3, y + 1, [141, 111, 180], SCALE);
  }
  writePng(file, d.width * SCALE, d.height * SCALE, c.rgb);
}

const d = deriveCortex();
const { width, height, disc, floor, bbox, layers, cfg } = d;
const bodyArea = disc.reduce((a, b) => a + b, 0);
const floorArea = floor.reduce((a, b) => a + b, 0);

const log = [];
const say = (s) => {
  log.push(s);
  console.log(s);
};

say(`source box ${bbox.w}×${bbox.h} px  ·  aspect h/w ${(bbox.h / bbox.w).toFixed(3)}  (portrait means > 1)`);
say(`body fill ${((bodyArea / (bbox.w * bbox.h)) * 100).toFixed(1)}% of the box  (an oval is ~78.5%, a strip ~100%)`);
say(`walkable ${floorArea} tiles of ${bodyArea} brain tiles = ${((floorArea / bodyArea) * 100).toFixed(1)}%  (ridge tops and the outline ring are the rest)`);
const round = d.chambers.map((c) => c.roundness);
const meanRound = round.reduce((a, b) => a + b, 0) / (round.length || 1);
say(
  `chambers ${d.chambers.length}  ·  ${d.chambers.length ? d.chambers.map((c) => `${c.w}×${c.h}`).join(' ') : 'none'}` +
    `  ·  mean roundness ${meanRound.toFixed(2)} (a disc is 0.79)  ·  ${d.chambers.reduce((a, c) => a + c.opened, 0)} tiles opened`,
);
say(`  doorways across the cleft at rows ${d.bridges.join(', ') || 'none'}`);
say(
  `corridor widths outside rooms: median ${d.corridorWidths.p50} tiles · p90 ${d.corridorWidths.p90} · widest ${d.corridorWidths.max}` +
    ` (a tile is ${d.cfg.tilePx}px, so a median passage is ${Math.round(d.corridorWidths.p50 * 2 * d.cfg.tilePx)}px across)`,
);
say(`stranded pieces discarded: ${d.strandedPieces} (${d.strandedTiles} tiles) — the walk is one piece`);
say(`cleft: column ${d.fissureCol}, ${d.fissureRows.length} rows inside the brain, solid on ${d.cleftSolid} of them, ${d.bridges.length} doorways punched through it`);
const leftRight = [0, 0];
for (let y = 0; y < d.height; y += 1) {
  for (let x = 0; x < d.width; x += 1) {
    if (!d.floor[y * d.width + x]) continue;
    leftRight[x > d.fissureCol ? 1 : 0] += 1;
  }
}
const spread = Math.max(...leftRight) / Math.min(1, Math.min(...leftRight));
say(`hemisphere balance: ${leftRight[0]} tiles left, ${leftRight[1]} right  ·  ratio ${(Math.max(leftRight[0], leftRight[1]) / Math.min(leftRight[0], leftRight[1])).toFixed(3)}`);
void spread;
say(`fissure column ${d.fissureCol} (midline would be ${Math.round((bbox.minX + bbox.maxX) / 2)}), longest run ${d.fissureRun} rows`);
say(`crossings at rows ${d.crossings.join(', ')}  ·  max depth ${d.maxDepth.toFixed(1)} tiles`);
const rowWidths = [];
for (let y = bbox.minY; y <= bbox.maxY; y += 1) {
  let run = 0;
  for (let x = bbox.minX; x <= bbox.maxX; x += 1) if (disc[y * width + x]) run += 1;
  rowWidths.push(run);
}
const midRow = rowWidths[Math.floor(rowWidths.length / 2)];
say(`outline taper: first row ${rowWidths[0]} tiles, middle ${midRow}, last ${rowWidths[rowWidths.length - 1]}`);
layers.forEach((L) => {
  say(
    `  layer ${L.index}: ${String(L.area).padStart(4)} tiles  ·  ${String(L.comps).padStart(2)} piece(s) after joining` +
      `  ·  ${String(L.doors).padStart(3)} doorway tiles cut  ·  ${L.passages} passage / ${L.junctions} open` +
      `  ·  ${L.deadEnds} dead ends  ·  ${L.loops.toFixed(0)} loops`,
  );
});

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(path.join(OUT_DIR, '00-source-plan.svg'), planSvg(d, null, 6));
layers.forEach((L) => writeFileSync(path.join(OUT_DIR, `layer-${L.index}.svg`), planSvg(d, L.index, 6)));

// All seven at once: outermost at full strength, the core the only bright thing.
const stack = [];
for (let L = layers.length - 1; L >= 0; L -= 1) {
  const shade = ['#2b2740', '#3a3355', '#4d4370', '#61538d', '#7a67aa', '#9c86c6', '#e8e2d2'][L];
  for (let i = 0; i < width * height; i += 1) {
    if (!layers[L].mask[i]) continue;
    const x = i % width;
    const y = (i - x) / width;
    stack.push(`<rect x="${x * 6}" y="${y * 6}" width="6" height="6" fill="${shade}"/>`);
  }
}
for (let i = 0; i < width * height; i += 1) {
  if (!disc[i] || floor[i]) continue;
  const x = i % width;
  const y = (i - x) / width;
  stack.push(`<rect x="${x * 6}" y="${y * 6}" width="6" height="6" fill="#0d0b14"/>`);
}
writeFileSync(
  path.join(OUT_DIR, '00-seven-layers.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width * 6}" height="${height * 6}" viewBox="0 0 ${width * 6} ${height * 6}"><rect width="100%" height="100%" fill="#12101a"/>${stack.join('')}</svg>`,
);
paint(path.join(OUT_DIR, 'plan.png'), null);
layers.forEach((L) => paint(path.join(OUT_DIR, `layer-${L.index}.png`), L.index));
{
  // All seven in one plate, outer band darkest and the core brightest: the nesting has to be a thing you see.
  const c = canvas(d.width * SCALE, d.height * SCALE, VOID);
  for (let y = 0; y < d.height; y += 1) {
    for (let x = 0; x < d.width; x += 1) {
      const i = y * d.width + x;
      if (!d.disc[i]) continue;
      const L = d.layerOf[i];
      c.tile(x, y, L < 0 ? WALL : SHADES[L], SCALE);
    }
  }
  writePng(path.join(OUT_DIR, '00-seven-layers.png'), d.width * SCALE, d.height * SCALE, c.rgb);
}
say(`plans written to ${OUT_DIR} at ${SCALE}px per tile`);
say(`tile ${cfg.tilePx}px → world ${width * cfg.tilePx}×${height * cfg.tilePx}px (the grid, not just the drawn body: ${bbox.w}×${bbox.h} of it is brain), ${CORTEX.layers} layers`);

if (wantMask) {
  /*
   * The shipped mask: one character per tile, so the game carries the *picture* rather than a re-derivation of
   * it. `0`-`6` is floor in that layer's band, `#` is a wall inside the brain (a fold, a ridge top, the
   * outline's own ring), `_` is the void outside the brain. The band digit is stored instead of recomputed at
   * runtime because chambers are assigned whole to a band — arithmetic on the depth field alone would slice a
   * room in two — and `npm run audit:cortex` re-derives the digits from the PNG and fails on any drift.
   */
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    let line = '';
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!d.disc[i]) line += '_';
      else if (!d.floor[i]) line += '#';
      else line += String(Math.max(0, d.layerOf[i]));
    }
    rows.push(line);
  }
  const chambers = d.chambers
    .map(
      (c) =>
        `  { x0: ${c.minX}, y0: ${c.minY}, x1: ${c.maxX}, y1: ${c.maxY}, layer: ${c.layer}, roundness: ${c.roundness},` +
        `    spansFissure: ${c.spansFissure > 0 ? 'true' : 'false'} },`,
    )
    .join('\n');
  const file = `/**
 * GENERATED by \`node tools/derive-cortex.mjs --mask\` — do not hand-edit.
 *
 * The brain the dungeon is built on, measured out of \`assets/brain-source.png\`: a top-down drawing of two
 * hemispheres split by a longitudinal fissure, its ink the sulci and the white between them the gyri. The
 * grooves became corridors, the bulges became chambers, the ridges stayed solid, and the seven layers are
 * nested bands of the distance field — layer 0 is the surface, layer ${d.cfg.layers - 1} the deep core.
 *
 * Legend, one character per tile of ${width}×${height} (a tile is ${d.cfg.tilePx} world pixels, so the map is
 * ${d.width * d.cfg.tilePx}×${d.height * d.cfg.tilePx}, of which the drawn body is ${d.bbox.w}×${d.bbox.h} tiles):
 * \`0\`-\`${d.cfg.layers - 1}\` floor in that layer's
 * band, \`#\` wall (fold, ridge, or the outline's own ring), \`_\` void outside the brain. Row 0 is the top of
 * the picture, which is the front of the brain: the walk runs posterior → anterior and inward.
 *
 * Derived ${new Date().toISOString().slice(0, 10)} from Otsu threshold ${d.threshold} with
 * ${JSON.stringify({ ...CORTEX })}.
 */

/** Where the ink sits in the source, so the sampling can be re-derived and checked, not trusted. */
export const CORTEX_SOURCE_BOX = { x: ${d.bbox.minX}, y: ${d.bbox.minY}, w: ${d.bbox.w}, h: ${d.bbox.h}, imageW: ${d.width}, imageH: ${d.height} } as const;

/** World pixels per tile: one tile is one pixel of the drawing, so the proportions are the picture's own. */
export const CORTEX_TILE_PX = ${d.cfg.tilePx};

/** The longitudinal fissure: the column whose ink runs unbroken the most rows, and the rows that cross it. */
export const CORTEX_FISSURE = {
  col: ${d.fissureCol},
  rowsInsideBrain: ${d.cleftRows},
  walkable: ${d.fissureWalkable},
  crossings: [${d.bridges.join(', ')}],
} as const;

export const CORTEX_LAYERS = ${d.cfg.layers};

/** Gyri opened as rooms: their bounds, the band they belong to whole, and how round they measured. */
export const CORTEX_CHAMBERS = [
${chambers}
] as const;

/** The plan. \`_\` void · \`#\` wall · \`0\`-\`${d.cfg.layers - 1}\` floor, by layer. */
export const CORTEX_ROWS: readonly string[] = [
${rows.map((r) => `  '${r}',`).join('\n')}
] as const;

export const CORTEX_COLS = ${width};
export const CORTEX_ROW_COUNT = ${height};
`;
  const outFile = path.join(ROOT, 'src/game/dungeon/cortexMask.ts');
  writeFileSync(outFile, file);
  say(`mask written: ${rows.length} rows × ${width} cols, ${d.chambers.length} chambers, ${bytesOf(file)} KB`);
}

function bytesOf(s) {
  return (s.length / 1024).toFixed(1);
}
