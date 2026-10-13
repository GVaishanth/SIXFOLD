#!/usr/bin/env node
/**
 * Brain silhouette deriver — `npm run derive:brain`.
 *
 * The dungeon's final map is meant to read as the attached line drawing, so its cell layout is measured out
 * of the picture rather than typed by hand. This decodes `assets/brain-source.png`, thresholds the ink with
 * Otsu, and searches grid sizes for the one whose coarse mask best agrees with the ink *at the footprint a
 * dungeon cell actually occupies* — a cell is `ARENA.width` wide, but a stacked row sits at the lane pitch
 * (`laneSpan` in `src/game/dungeon/map.ts`), so the silhouette has to be sampled 880 wide by pitch tall or
 * the map will not look like the picture once it is walked.
 *
 * The answer is written to `src/game/dungeon/brainMask.ts` as a `#`/`.` mask so it is reviewable in a diff,
 * and `npm run audit:brain` re-runs this sampler and fails if the file and the image ever disagree.
 *
 *   node tools/derive-brain.mjs             rewrite src/game/dungeon/brainMask.ts
 *   node tools/derive-brain.mjs --report    print the search and the chosen mask, write nothing
 */
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PNG = path.join(ROOT, 'assets/brain-source.png');
const OUT = path.join(ROOT, 'src/game/dungeon/brainMask.ts');

/* ------------------------------------------------- the shipped geometry --- */
const esbuild = require('esbuild');
const bundle = path.join(mkdtempSync(path.join(tmpdir(), 'sixfold-brain-')), 'b.mjs');
await esbuild.build({
  stdin: {
    contents: `
      export { laneSpan } from '@/game/dungeon/map';
      export { ARENA } from '@/config/gameConfig';
    `,
    resolveDir: ROOT,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  alias: { '@': path.join(ROOT, 'src') },
  define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
  logLevel: 'silent',
});
const M = await import(pathToFileURL(bundle).href);
const CELL_W = M.ARENA.width;
const CELL_H = M.ARENA.height;
const PITCH = M.laneSpan(CELL_H).pitchFrac * CELL_H;

/* ------------------------------------------------------------------ png --- */
/** Decodes the subset of PNG this repository ships: 8-bit, non-interlaced, grey/grey-alpha/RGB/RGBA. */
function decodePng(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let pos = 8;
  let ihdr = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    } else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr) throw new Error('no IHDR');
  if (ihdr.depth !== 8 || ihdr.interlace !== 0) throw new Error(`unsupported png (depth ${ihdr.depth}, interlace ${ihdr.interlace})`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.color];
  if (!channels) throw new Error(`unsupported colour type ${ihdr.color}`);
  const { width, height } = ihdr;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      const v = line[x];
      let value;
      if (filter === 0) value = v;
      else if (filter === 1) value = v + a;
      else if (filter === 2) value = v + b;
      else if (filter === 3) value = v + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`unknown png filter ${filter}`);
      cur[x] = value & 0xff;
    }
    prev = cur;
  }
  const lum = new Float32Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    lum[i] = channels <= 2 ? out[i * channels] : (out[i * channels] * 299 + out[i * channels + 1] * 587 + out[i * channels + 2] * 114) / 1000;
  }
  return { width, height, lum };
}

const { width, height, lum } = decodePng(PNG);

/** A bright field with dark strokes, so "ink" is the *low* side of an Otsu threshold. */
function otsu(values) {
  const hist = new Array(256).fill(0);
  for (const v of values) hist[Math.max(0, Math.min(255, Math.round(v)))] += 1;
  const total = values.length;
  let sum = 0;
  for (let t = 0; t < 256; t += 1) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let threshold = 127;
  for (let t = 0; t < 256; t += 1) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

const inkThreshold = otsu(lum);
const ink = new Uint8Array(width * height);
let minX = width;
let minY = height;
let maxX = -1;
let maxY = -1;
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    if (lum[y * width + x] <= inkThreshold) {
      ink[y * width + x] = 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
if (maxX < 0) throw new Error('the source image has no ink');
const boxW = maxX - minX + 1;
const boxH = maxY - minY + 1;
const inkFraction = ink.reduce((a, b) => a + b, 0) / (width * height);

/*
 * The source is a line drawing, so ink is only the boundary: a box in the middle of a hemisphere has no
 * stroke in it at all. Sampling ink would put cells on the outline and leave the body of the brain empty,
 * which is the opposite of a map you can walk. So the boundary is closed first — the strokes are thickened by
 * a pixel, because an anti-aliased line leaves one-pixel holes a flood would leak through — and the interior
 * is everything the outside cannot reach. Cells are then boxes of *filled* brain, which is what the picture
 * is actually showing.
 */
/** The least dilation that still encloses the body, without closing the fissure. */
const MIN_BODY_FILL = Number(process.env.BRAIN_BODY_FILL ?? 0.62);

function floodOutside(thickMap) {
  const out = new Uint8Array(width * height);
  const stack = [];
  const seed = (x, y) => {
    const i = y * width + x;
    if (!thickMap[i] && !out[i]) {
      out[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < width; x += 1) {
    seed(x, 0);
    seed(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    seed(0, y);
    seed(width - 1, y);
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % width;
    const y = (i - x) / width;
    const push = (nx, ny) => {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;
      const j = ny * width + nx;
      if (thickMap[j] || out[j]) return;
      out[j] = 1;
      stack.push(j);
    };
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }
  return out;
}

/** Solid at a given dilation: everything in the ink bbox the outside cannot reach. */
function solidAt(grow) {
  const thick = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!ink[y * width + x]) continue;
      for (let dy = -grow; dy <= grow; dy += 1) {
        for (let dx = -grow; dx <= grow; dx += 1) {
          const ny = y + dy;
          const nx = x + dx;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          thick[ny * width + nx] = 1;
        }
      }
    }
  }
  const outside = floodOutside(thick);
  const solid = new Uint8Array(width * height);
  let filled = 0;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (outside[y * width + x]) continue;
      solid[y * width + x] = 1;
      filled += 1;
    }
  }
  return { solid, filled: filled / (boxW * boxH) };
}

/*
 * Dilation is a trade, so it is searched rather than assumed. The outline is anti-aliased and can leak at a
 * one-pixel gap, which would let the flood pour into the body of the brain; but the drawing's single most
 * important feature — the longitudinal fissure between the hemispheres — is itself only a few pixels wide, and
 * growing the ink by a pixel closes it, which is exactly how a brain map turns into a loaf. So: take the
 * least dilation that still fills the body, and report which one won. A shape that stays empty at every
 * dilation is not a leak but an open outline, and the tool says so instead of guessing.
 */
let picked = null;
const trace = [];
for (let grow = 0; grow <= 2; grow += 1) {
  const attempt = solidAt(grow);
  trace.push({ grow, fill: attempt.filled });
  if (attempt.filled >= MIN_BODY_FILL) {
    picked = attempt;
    break;
  }
  if (!picked || attempt.filled > picked.filled) picked = attempt;
}
if (picked.filled < 0.5) {
  throw new Error(`the outline does not enclose a body (best fill ${(picked.filled * 100).toFixed(1)}%) — the source has an open gap the flood can escape through`);
}
const solid = picked.solid;
const GROW = trace.findIndex((r) => r.fill === picked.filled);
const solidFraction = picked.filled;

/** How much of each box is filled brain. */
function sampleGrid(rows, cols, per = 8) {
  const grid = new Float32Array(rows * cols);
  const bw = boxW / cols;
  const bh = boxH / rows;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      let hit = 0;
      for (let sy = 0; sy < per; sy += 1) {
        for (let sx = 0; sx < per; sx += 1) {
          const px = minX + Math.floor((c + (sx + 0.5) / per) * bw);
          const py = minY + Math.floor((r + (sy + 0.5) / per) * bh);
          if (px <= maxX && py <= maxY) hit += solid[py * width + px];
        }
      }
      grid[r * cols + c] = hit / (per * per);
    }
  }
  return grid;
}

/**
 * Score one grid. `fill` decides how much filled brain makes a box a cell; `iou` is then the overlap between
 * the chosen cells rasterised back over the picture and the filled shape itself — it fails in both directions,
 * penalising a cell parked off the brain and a lobe of the brain no cell covers. That is the number the
 * ledger of this tool is judged by: the map has to *look like the drawing*, not merely be derived from it.
 */
function scoreGrid(rows, cols, fill) {
  const grid = sampleGrid(rows, cols);
  const mask = [];
  let cells = 0;
  for (let r = 0; r < rows; r += 1) {
    let line = '';
    for (let c = 0; c < cols; c += 1) {
      if (grid[r * cols + c] >= fill) {
        cells += 1;
        line += '#';
      } else line += '.';
    }
    mask.push(line);
  }
  const bw = boxW / cols;
  const bh = boxH / rows;
  let inter = 0;
  let union = 0;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const c = Math.min(cols - 1, Math.floor((x - minX) / bw));
      const r = Math.min(rows - 1, Math.floor((y - minY) / bh));
      const coarse = mask[r][c] === '#';
      const fine = solid[y * width + x] === 1;
      if (coarse && fine) inter += 1;
      if (coarse || fine) union += 1;
    }
  }
  return { rows, cols, cells, iou: inter / Math.max(1, union), mask };
}

/*
 * The grid is *not* sampled at the cell's own aspect ratio, and that is the whole point. A cell footprint is
 * 880×302, about 2.9:1, while the drawing is close to square: matching them exactly leaves a 40-cell map only
 * four columns wide, which is a rounded rectangle with the lobes, the central notch and the cerebellum all
 * averaged away. The map is made of cells, so what has to look like a brain is the *occupancy pattern* — the
 * picture is therefore resampled into whatever grid holds the budget, and each cell stands for a patch of the
 * drawing rather than for a patch of the drawing at world scale. The anisotropy is then visible in the walk
 * (a cell is wide) instead of in the silhouette (the shape is preserved), which is the right way round.
 */

const FILL = Number(process.env.BRAIN_FILL ?? 0.5);
const WANTED = Number(process.env.BRAIN_CELLS ?? 40);
const MIN_CELLS = Number(process.env.BRAIN_MIN_CELLS ?? 34);
const MAX_CELLS = Number(process.env.BRAIN_MAX_CELLS ?? 48);
// The rows range is a sampling constraint, not an aesthetic one: the ink box is ~115px tall, so past about 18
// rows a cell box is thinner than the stroke that bounds it and the coarse mask stops meaning anything —
// every grid looks like a filled rectangle, and IoU starts rewarding blur.
const MIN_ROWS = Number(process.env.BRAIN_MIN_ROWS ?? 7);
const MAX_ROWS = Number(process.env.BRAIN_MAX_ROWS ?? 13);
const MIN_COLS = Number(process.env.BRAIN_MIN_COLS ?? 7);
const MAX_COLS = Number(process.env.BRAIN_MAX_COLS ?? 13);
const ranked = [];
for (let rows = MIN_ROWS; rows <= MAX_ROWS; rows += 1) {
  for (let cols = MIN_COLS; cols <= MAX_COLS; cols += 1) {
    const row = scoreGrid(rows, cols, FILL);
    if (row.cells >= MIN_CELLS && row.cells <= MAX_CELLS) ranked.push(row);
  }
}
if (!ranked.length) throw new Error(`no grid in ${MIN_ROWS}..${MAX_ROWS} rows lands between ${MIN_CELLS} and ${MAX_CELLS} cells`);
// Most brain-like wins; the cell count breaks ties *within* a half-point of IoU, because at this resolution a
// 43-cell and a 48-cell mask are equally faithful and 43 is five fewer corridors to walk. A 200-cell mask that
// covers the picture is blur, and a blob that lost the outline is not the map the player asked for.
const IOU_TIE = 0.005;
ranked.sort((a, b) => {
  if (Math.abs(a.iou - b.iou) > IOU_TIE) return b.iou - a.iou;
  return Math.abs(a.cells - WANTED) - Math.abs(b.cells - WANTED) || b.iou - a.iou;
});
const chosen = ranked[0];

if (process.argv.includes('--report')) {
  console.log(`source ${width}×${height} · ink bbox ${minX},${minY}–${maxX},${maxY} (${boxW}×${boxH}) · ink ${(inkFraction * 100).toFixed(1)}% · otsu ${inkThreshold}`);
  console.log(`cell footprint ${CELL_W}×${PITCH.toFixed(1)} (from ARENA + laneSpan) · fill threshold ${FILL}`);
  console.log(`filled brain covers ${(solidFraction * 100).toFixed(1)}% of its ink bbox · dilation ${GROW}px (${trace.map((r) => `${r.grow}px ${(r.fill * 100).toFixed(1)}%`).join(', ')})\n`);
  console.log('search (sorted by silhouette IoU, then by |cells - target|):');
  for (const row of ranked.slice(0, 16)) {
    console.log(`  rows ${String(row.rows).padStart(2)} cols ${String(row.cols)} cells ${String(row.cells).padStart(3)} iou ${(row.iou * 100).toFixed(1)}%${row === chosen ? '   <-- chosen' : ''}`);
  }
  console.log('\nthe mask, as cells:');
  chosen.mask.forEach((line, i) => console.log(`  ${String(i).padStart(2)} ${line}`));
  console.log('\nand as the world would draw it (each cell 2.9 wide, so the walk is stretched sideways):');
  chosen.mask.forEach((line) => console.log(`  ${line.replace(/#/g, '███').replace(/\./g, '   ')}`));
  process.exit(0);
}

const body = `/**
 * GENERATED by \`node tools/derive-brain.mjs\` — do not hand-edit.
 *
 * The dungeon's cell layout, measured out of \`assets/brain-source.png\`: one \`#\` is one ${CELL_W}×${CELL_H}
 * cell, and rows stack at the lane pitch (\`laneSpan\` in \`map.ts\`, ${PITCH.toFixed(1)}px here) rather than at a
 * full cell height, so the silhouette holds in *world* space and not merely in picture space.
 * \`npm run audit:brain\` re-derives this mask from the image and fails if the two disagree, which is what keeps
 * a hand-tweak here from quietly becoming a different map than the one the picture describes.
 *
 * Chosen from a search over grid sizes: ${chosen.rows} rows × ${chosen.cols} columns, ${chosen.cells} cells,
 * silhouette IoU against the filled shape: ${(chosen.iou * 100).toFixed(1)}%, at a ${(FILL * 100).toFixed(0)}% fill threshold.
 */

/** Where the ink sits in the source, so the sampling can be re-derived and checked, not trusted. */
export const BRAIN_SOURCE_BOX = { x: ${minX}, y: ${minY}, w: ${boxW}, h: ${boxH}, imageW: ${width}, imageH: ${height} } as const;

/** \`#\` = a cell exists here, \`.\` = nothing. Row 0 is the top of the map. */
export const BRAIN_ROWS: readonly string[] = [
${chosen.mask.map((line) => `  '${line}',`).join('\n')}
] as const;

export const BRAIN_COLS = ${chosen.cols};
export const BRAIN_ROW_COUNT = ${chosen.rows};
export const BRAIN_CELL_COUNT = ${chosen.cells};
`;
writeFileSync(OUT, body, 'utf8');
const written = readFileSync(OUT, 'utf8');
if (!written.includes('BRAIN_ROWS')) throw new Error('the mask file was not written');
console.log(`wrote ${path.relative(ROOT, OUT)} — ${chosen.rows}×${chosen.cols}, ${chosen.cells} cells, silhouette IoU ${(chosen.iou * 100).toFixed(1)}%`);
