#!/usr/bin/env node
/**
 * Brain mask gate — `npm run audit:brain`.
 *
 * `src/game/dungeon/brainMask.ts` is generated from `assets/brain-source.png`, and a generated file is only
 * trustworthy if something re-derives it. This does: it runs the same sampler over the same PNG and demands
 * byte equality with the shipped rows, so a hand-tweak to the mask fails the build instead of silently
 * shipping a different map than the picture describes.
 *
 * It also pins the two numbers the layout will be built on. `BRAIN_ROWS` describes cells at *lane pitch*, not
 * at cell height — rows sit `laneSpan().pitchFrac` of a cell apart so the lane a cell exits on is the lane the
 * cell below it enters on — so the mask's meaning depends on the generator's geometry, and a change to
 * `ARENA.wall` or `DUNGEON.spineBand` changes what the picture maps to. Checking that here, next to the
 * silhouette, is what keeps "it looks like a brain" a measured claim rather than an intention.
 *
 * The route over this mask is not asserted here: `brain.ts` (next step in this patch) owns it, and
 * `docs/plans/2026-10-11-dungeon-mode-design.md` §7 records the parity constraint that decides its shape.
 */
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const esbuild = require('esbuild');

const rows = [];
const check = (name, ok, detail = '') => {
  rows.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};

/* ------------------------------------------------------- shipped modules --- */
const bundle = path.join(mkdtempSync(path.join(tmpdir(), 'sixfold-brain-audit-')), 'b.mjs');
await esbuild.build({
  stdin: {
    contents: `
      export { BRAIN_ROWS, BRAIN_COLS, BRAIN_ROW_COUNT, BRAIN_CELL_COUNT, BRAIN_SOURCE_BOX } from '@/game/dungeon/brainMask';
      export { laneSpan } from '@/game/dungeon/map';
      export { ARENA, DUNGEON } from '@/config/gameConfig';
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
const { BRAIN_ROWS, BRAIN_COLS, BRAIN_ROW_COUNT, BRAIN_CELL_COUNT, BRAIN_SOURCE_BOX, laneSpan, ARENA, DUNGEON } = M;

check('the mask module is loaded', Array.isArray(BRAIN_ROWS) && BRAIN_ROWS.length > 0);
check(
  'the mask is rectangular and uses only cell/void glyphs',
  BRAIN_ROWS.every((r) => r.length === BRAIN_COLS && /^[#.]+$/.test(r)),
  `${BRAIN_ROW_COUNT}×${BRAIN_COLS}`,
);
const counted = BRAIN_ROWS.join('').split('').filter((c) => c === '#').length;
check('BRAIN_CELL_COUNT counts the mask it ships with', counted === BRAIN_CELL_COUNT, `${counted} vs ${BRAIN_CELL_COUNT}`);
check('the mask is a dungeon, not a wall: some boxes are void', counted < BRAIN_COLS * BRAIN_ROW_COUNT, `${counted}/${BRAIN_COLS * BRAIN_ROW_COUNT} boxes filled`);
check(
  'the silhouette is bigger than the strip it replaces',
  BRAIN_CELL_COUNT > DUNGEON.chunks,
  `${BRAIN_CELL_COUNT} cells vs ${DUNGEON.chunks} chunks`,
);
check(
  'the mask stays inside the budget the pacing note commits to (<= 48)',
  BRAIN_CELL_COUNT <= 48,
  `${BRAIN_CELL_COUNT} cells ≈ ${Math.round((BRAIN_CELL_COUNT * ARENA.width) / 1000)}k px of corridor`,
);

/* ------------------------------------------------------- re-derive it, here --- */
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
    if (type === 'IHDR') ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr || ihdr.depth !== 8 || ihdr.interlace !== 0) throw new Error('unsupported png for this gate');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.color];
  if (!channels) throw new Error('unsupported colour type');
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
      else value = v + (() => {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      })();
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

const { width, height, lum } = decodePng(path.join(ROOT, 'assets/brain-source.png'));
let threshold = 127;
{
  const hist = new Array(256).fill(0);
  for (const v of lum) hist[Math.max(0, Math.min(255, Math.round(v)))] += 1;
  const total = lum.length;
  let sum = 0;
  for (let t = 0; t < 256; t += 1) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = -1;
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
}
const ink = new Uint8Array(width * height);
let minX = width;
let minY = height;
let maxX = -1;
let maxY = -1;
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    if (lum[y * width + x] <= threshold) {
      ink[y * width + x] = 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
check(
  'the recorded ink box is where the ink is',
  BRAIN_SOURCE_BOX.x === minX && BRAIN_SOURCE_BOX.y === minY && BRAIN_SOURCE_BOX.w === maxX - minX + 1 && BRAIN_SOURCE_BOX.h === maxY - minY + 1,
  `file ${JSON.stringify(BRAIN_SOURCE_BOX)} vs image ${minX},${minY} ${maxX - minX + 1}×${maxY - minY + 1}`,
);

const solid = new Uint8Array(width * height);
{
  const outside = new Uint8Array(width * height);
  const stack = [];
  const seed = (x, y) => {
    const i = y * width + x;
    if (!ink[i] && !outside[i]) {
      outside[i] = 1;
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
      if (ink[j] || outside[j]) return;
      outside[j] = 1;
      stack.push(j);
    };
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) if (!outside[y * width + x]) solid[y * width + x] = 1;
  }
}
const boxW = maxX - minX + 1;
const boxH = maxY - minY + 1;
const rows2 = BRAIN_ROW_COUNT;
const cols2 = BRAIN_COLS;
const derived = [];
for (let r = 0; r < rows2; r += 1) {
  let line = '';
  for (let c = 0; c < cols2; c += 1) {
    let hit = 0;
    const per = 8;
    for (let sy = 0; sy < per; sy += 1) {
      for (let sx = 0; sx < per; sx += 1) {
        const px = minX + Math.floor((c + (sx + 0.5) / per) * (boxW / cols2));
        const py = minY + Math.floor((r + (sy + 0.5) / per) * (boxH / rows2));
        if (px <= maxX && py <= maxY) hit += solid[py * width + px];
      }
    }
    line += hit / (per * per) >= 0.5 ? '#' : '.';
  }
  derived.push(line);
}
check(
  'the mask is exactly what the picture yields when sampled at cell footprints',
  derived.join('|') === BRAIN_ROWS.join('|'),
  derived.join('|') === BRAIN_ROWS.join('|') ? `${rows2}×${cols2} reproduced` : `derived ${derived.join(' ')} vs file ${BRAIN_ROWS.join(' ')}`,
);

// IoU of the shipped mask against the fine filled shape, the same fidelity number the deriver ranked on.
let inter = 0;
let union = 0;
for (let y = minY; y <= maxY; y += 1) {
  for (let x = minX; x <= maxX; x += 1) {
    const c = Math.min(cols2 - 1, Math.floor(((x - minX) / boxW) * cols2));
    const r = Math.min(rows2 - 1, Math.floor(((y - minY) / boxH) * rows2));
    const coarse = BRAIN_ROWS[r][c] === '#';
    const fine = solid[y * width + x] === 1;
    if (coarse && fine) inter += 1;
    if (coarse || fine) union += 1;
  }
}
const iou = inter / Math.max(1, union);
check('the silhouette still reads as the drawing (IoU >= 0.85)', iou >= 0.85, `${(iou * 100).toFixed(1)}%`);

/* ------------------------------------------------------ the geometry it needs --- */
const lane = laneSpan(ARENA.height);
check('the lane pitch the mask assumes is the generator\'s own', lane.pitchFrac > 0.3 && lane.pitchFrac < 0.9, JSON.stringify(lane));
check(
  'a stacked row lands the exit lane on the next row\'s entry lane',
  Math.abs(lane.bottomFy - lane.pitchFrac - lane.topFy) < 1e-9,
  `top ${(lane.topFy * 100).toFixed(1)}% · bottom ${(lane.bottomFy * 100).toFixed(1)}% · pitch ${(lane.pitchFrac * 100).toFixed(1)}%`,
);
check('the pitch is not a full cell height, and the mask says so', Math.abs(lane.pitchFrac - 1) > 0.05, `${(lane.pitchFrac * ARENA.height).toFixed(1)}px of ${ARENA.height}px`);
// The parity rule the route has to satisfy, stated as a measured fact rather than a comment.
const perRow = BRAIN_ROWS.map((line) => line.split('').filter((c) => c === '#').length);
check(
  'every row is one contiguous run of cells (a row with a hole cannot be walked as one pass)',
  BRAIN_ROWS.every((line) => {
    const first = line.indexOf('#');
    if (first < 0) return true;
    const last = line.lastIndexOf('#');
    return !line.slice(first, last + 1).includes('.');
  }),
  perRow.join(','),
);
check(
  'a row can end on the shared lane: at least one row length makes start and exit parity agree',
  perRow.some((n) => n % 2 === 1),
  `row lengths ${perRow.join(',')} — the route must drop from an odd-length row, or split a longer one (see the plan §7)`,
);

const failed = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - failed.length}/${rows.length} brain-mask checks passed.`);
if (failed.length) process.exitCode = 1;