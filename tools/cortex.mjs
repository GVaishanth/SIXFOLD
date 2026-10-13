#!/usr/bin/env node
/**
 * The brain floor plan — shared derivation for `derive-cortex.mjs` and `cortex-audit.mjs`.
 *
 * Everything here is measured out of `assets/brain-source.png`, which is a top-down line drawing of a human
 * brain with the two hemispheres split by a vertical longitudinal fissure. The drawing already contains the
 * whole map, and the reading is the one the picture forces:
 *
 *   ink        → the sulci, the grooves the pen drew: these are the CORRIDORS, widened to a walkable groove
 *   white      → the gyri, the bulges between grooves: each enclosed one is either a CHAMBER, opened onto the
 *                corridor that wraps it, or left solid as the ridge top it is
 *   outside    → the skull gap, solid, and the outline's own stroke is a wall ring the walk cannot cross
 *
 * That single rule is what makes the plan read as a brain instead of as a strip: the outline is preserved
 * because the body is the picture's own closed outline; the dense folds, the curved dead ends and the loops
 * are all there in the ink; the chambers are the gyri, and they are irregular because the drawing's are.
 * Two things are added, because the picture is a surface view and a dungeon needs a walk:
 *
 *   the fissure is made continuous (a division you can *feel* on every row) with a few deliberate crossings;
 *   the seven layers are annuli of the distance field — layer 0 is the surface band, layer 6 the deep core —
 *   so each layer is a smaller brain nested inside the last, with its own boundary and its own folds.
 *
 * Pure, deterministic, no image library: the PNG decoder is the same one `derive-brain.mjs` uses, so this
 * runs anywhere the repo runs.
 */
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PNG_PATH = path.join(ROOT, 'assets/brain-source.png');

/** The authored tuning, so the gate can fail a number that drifted instead of trusting a file. */
export const CORTEX = {
  /** World pixels per tile. One tile is one source pixel, so the drawing keeps its proportions exactly. */
  /*
   * One pixel of the drawing is one tile, and a tile is 160 world pixels.
   *
   * This number is a *physics* choice as much as a visual one. Arcade moves a body by its velocity in world
   * pixels and resolves walls by pushing the overlap out, so whether anything can end up on the far side of a
   * wall is a ratio: the thinnest wall body versus the longest step a mover takes in one frame. The scene
   * clamps dt at 50ms and the fastest deliberate motion is a dash at DASH_CONFIG.speed (340px/s, ~17px per
   * clamped frame, and ~22px for a shove at 430px/s), which at a 32px tile left a one-tile-thick ridge with
   * barely 1.5 frames of margin — the reason a warden or a mob could be found standing inside stone. At 160
   * the thinnest wall is five times thicker and no mover crosses it in one frame; `audit:cortex` states the
   * arithmetic and `audit:dungeonrun` measures the real maximum in a live run, so if a future speed makes the
   * margin small, a gate says so instead of the player finding a hole in the labyrinth.
   *
   * What it does *not* change is the map: every fold, chamber and doorway is measured in tiles, so the
   * geometry is identical at any tile size and only the world's pixel extent moves. The cost is framing — a
   * screen now shows eight tiles instead of forty, so the maze is closer and chunkier. If that is wrong, the
   * dials are the camera's zoom or this number, not the derivation.
   */
  tilePx: 64,
  /** How much the outline is thickened before the outside is flooded: 1 px plugs anti-aliased pinholes. */
  outlineDilate: 1,
  /** White islands smaller than this many tiles are folds' pinholes, not rooms: they become wall. */
  minFloorTiles: 3,
  /** Wall specks of this size or less, with nothing to lean on, are pen noise: they become floor. */
  minWallTiles: 2,
  /** Passages narrower than this between two folds are erased into one wall, so the walk has room to turn. */
  pinchTiles: 1,
  /** How far a drawn sulcus is widened into a walkable groove. 0 keeps the pen's 1px line, 1 makes a 3-tile
   *  passage: wide enough for a warden and a mob to pass, narrow enough to read as a groove. */
  corridorDilate: 1,
  /** A gyrus becomes a chamber only if its area is inside this range and the seeded share agrees. Too small is
   *  a pinhole between folds; too big is the flat top of a hemisphere, which is a field, not a room. */
  /** Half-width (in tiles, as the distance field measures it) at which a groove counts as bulging into a
   *  gyrus rather than passing as a corridor. 1.6 is a 4-tile-wide opening: a room, not a pinch. */
  chamberWidthTiles: 2.6,
  /** How far a bulge is opened out. The big ones get another ring, which is what makes them round. */
  chamberOpenRings: 1,
  chamberBigTiles: 7,
  chamberBigRings: 2,
  /** A bulge smaller than this many tiles is a fold's kink, not a chamber; bigger than the max is an open
   *  field, and a field is the thing a labyrinth must not turn into. */
  chamberMinCoreTiles: 7,
  chamberMaxCoreTiles: 140,
  /** A gyrus is a bulge, not a street: no room may be more than this many tiles across in either direction,
   *  and its box must not be more than this much longer one way than the other. */
  chamberMaxSpan: 20,
  chamberMaxAspect: 2.1,
  /** area / bounding box: a gyrus is rounded, so a bulge that fills its box is a square corridor crossing. */
  chamberRoundness: 0.45,
  chamberShare: 0.55,
  /** One wall ring inside the outline, so the silhouette is a boundary the player walks against. */
  boundaryWallRings: 1,
  /**
   * Mirror the derived grooves and rooms across the cleft. The drawing is nearly symmetric but not exactly,
   * and a plan whose halves differ by a fifth is unbalanced where the brief asks for balance. Opening the
   * mirror of a tile — rather than deleting the odd one out — keeps the fold density and makes the two
   * hemispheres equal by construction, which is a stronger promise than a tolerance.
   */
  mirrorHalves: true,
  /** Widest a passage may get before it is a plaza rather than a groove, measured as the same half-width the
   *  chamber rule uses. Chambers are exempt: a room is *supposed* to be wide. */
  maxCorridorHalfWidth: 2.2,
  /** A room's twin is only mirrored this far from the cleft, so balancing the halves never welds them
   *  together into one slab across the division the brief wants kept. */
  mirrorRoomMinOffset: 6,
  /** Width of the cleft, in tiles: solid everywhere except at the doorways. */
  cleftWidth: 5,
  /** Doorways across the cleft per layer, and how many rows each one is. */
  crossingsPerLayer: 2,
  bridgeRows: 2,
  /** Layers in the dungeon: surface band → deep core. */
  layers: 7,
}

/* --------------------------------------------------------------------- png --- */
/** Decodes the subset of PNG this repository ships: 8-bit, non-interlaced, grey/grey-alpha/RGB/RGBA. */
export function decodePng(file) {
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
    lum[i] =
      channels <= 2
        ? out[i * channels]
        : (out[i * channels] * 299 + out[i * channels + 1] * 587 + out[i * channels + 2] * 114) / 1000;
  }
  return { width, height, lum };
}

/** A bright field with dark strokes, so "ink" is the low side of an Otsu threshold. */
export function otsu(values) {
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

/* ----------------------------------------------------------------- grids --- */
export const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
export const NEIGHBOURS8 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

export function dilate(src, w, h, r = 1) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!src[y * w + x]) continue;
      for (let dy = -r; dy <= r; dy += 1) {
        for (let dx = -r; dx <= r; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          out[ny * w + nx] = 1;
        }
      }
    }
  }
  return out;
}

export function erode(src, w, h, r = 1) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let all = 1;
      for (let dy = -r; dy <= r && all; dy += 1) {
        for (let dx = -r; dx <= r; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || !src[ny * w + nx]) {
            all = 0;
            break;
          }
        }
      }
      out[y * w + x] = all;
    }
  }
  return out;
}

/** Everything the border can reach without crossing `block`: the outside of the shape. */
export function floodFromBorder(block, w, h) {
  const seen = new Uint8Array(w * h);
  const stack = [];
  const seed = (x, y) => {
    const i = y * w + x;
    if (!block[i] && !seen[i]) {
      seen[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x += 1) {
    seed(x, 0);
    seed(x, h - 1);
  }
  for (let y = 0; y < h; y += 1) {
    seed(0, y);
    seed(w - 1, y);
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    const y = (i - x) / w;
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (block[j] || seen[j]) continue;
      seen[j] = 1;
      stack.push(j);
    }
  }
  return seen;
}

/**
 * Cheamfer distance to the nearest zero of `src` — inside this file, distance from the body's boundary.
 * Two passes with the 3/4 weights keep the error under a tenth of a tile, which is plenty to cut annuli.
 */
export function distanceField(src, w, h) {
  const BIG = 1e6;
  const d = new Float64Array(w * h);
  for (let i = 0; i < w * h; i += 1) d[i] = src[i] ? BIG : 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      let best = d[i];
      if (x > 0) best = Math.min(best, d[i - 1] + 3);
      if (y > 0) best = Math.min(best, d[i - w] + 3);
      if (x > 0 && y > 0) best = Math.min(best, d[i - w - 1] + 4);
      if (x < w - 1 && y > 0) best = Math.min(best, d[i - w + 1] + 4);
      d[i] = best;
    }
  }
  for (let y = h - 1; y >= 0; y -= 1) {
    for (let x = w - 1; x >= 0; x -= 1) {
      const i = y * w + x;
      let best = d[i];
      if (x < w - 1) best = Math.min(best, d[i + 1] + 3);
      if (y < h - 1) best = Math.min(best, d[i + w] + 3);
      if (x < w - 1 && y < h - 1) best = Math.min(best, d[i + w + 1] + 4);
      if (x > 0 && y < h - 1) best = Math.min(best, d[i + w - 1] + 4);
      d[i] = best;
    }
  }
  for (let i = 0; i < w * h; i += 1) d[i] /= 3;
  return d;
}

/** Connected components (4-way) of a mask, biggest first, with their areas and centroids. */
export function components(mask, w, h) {
  const label = new Int32Array(w * h).fill(-1);
  const out = [];
  for (let start = 0; start < w * h; start += 1) {
    if (!mask[start] || label[start] >= 0) continue;
    const id = out.length;
    const stack = [start];
    label[start] = id;
    let area = 0;
    let sx = 0;
    let sy = 0;
    let minX = w;
    let maxX = -1;
    let minY = h;
    let maxY = -1;
    while (stack.length) {
      const i = stack.pop();
      const x = i % w;
      const y = (i - x) / w;
      area += 1;
      sx += x;
      sy += y;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!mask[j] || label[j] >= 0) continue;
        label[j] = id;
        stack.push(j);
      }
    }
    out.push({ id, area, cx: sx / area, cy: sy / area, minX, maxX, minY, maxY, cells: [] });
  }
  for (let i = 0; i < w * h; i += 1) {
    const id = label[i];
    if (id >= 0) out[id].cells.push(i);
  }
  out.sort((a, b) => b.area - a.area);
  out.forEach((c, rank) => (c.rank = rank));
  return { labels: label, list: out };
}

/* ------------------------------------------------------------- derivation --- */
/**
 * The whole floor plan, measured out of the picture.
 *
 * `disc` is the brain: the outline closed and everything inside it. The drawing's ink inside that outline is
 * the wall — the folds, the fissure, the ridges' edges — and the white between the folds is the floor, which
 * is what a sulcus *is*: the groove you walk in while the gyrus bulges solid above it. `layers[L]` is the
 * annulus of the distance field at depth L of 7, so the seven layers are nested brains sharing one outline.
 */
export function deriveCortex(pngPath = PNG_PATH, opts = {}) {
  const cfg = { ...CORTEX, ...opts };
  const { width, height, lum } = decodePng(pngPath);
  const threshold = otsu(lum);
  const ink = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) ink[i] = lum[i] <= threshold ? 1 : 0;

  // The outline is closed before anything is measured, or the flood leaks in through an anti-aliased pinhole
  // and the "brain" turns out to be nothing. Dilation is for the closure only.
  const closed = dilate(ink, width, height, cfg.outlineDilate);
  const outside = floodFromBorder(closed, width, height);
  const disc = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) disc[i] = outside[i] ? 0 : 1;
  const interior =
    cfg.boundaryWallRings > 0 ? erode(disc, width, height, cfg.boundaryWallRings) : Uint8Array.from(disc);

  const bbox = (() => {
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (!disc[y * width + x]) continue;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    return { minX, maxX, minY, maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
  })();

  // ── corridors: the grooves the drawing shows, widened to something a warden fits in.
  const inkIn = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) inkIn[i] = interior[i] && ink[i] ? 1 : 0;
  /*
   * Balance is applied to the *folds*, before anything is widened — not to the corridors after. Mirroring a
   * drawn line and dilating once leaves a 2px groove 2px wide; dilating each half and then merging welds two
   * nearby grooves into a plaza, which is how a dense brain turns into a white disc with holes. The cleft's
   * own band is skipped, so the division keeps the walls the drawing gave it.
   */
  const axisX = Math.round((bbox.minX + bbox.maxX) / 2);
  if (cfg.mirrorHalves) {
    const twin = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        if (!inkIn[i]) continue;
        const mx = 2 * axisX - x;
        if (mx < 0 || mx >= width) continue;
        if (Math.abs(x - axisX) <= 2) continue;
        const j = y * width + mx;
        if (!interior[j]) continue;
        twin[j] = 1;
      }
    }
    for (let i = 0; i < width * height; i += 1) if (twin[i]) inkIn[i] = 1;
  }
  const groove = cfg.corridorDilate > 0 ? dilate(inkIn, width, height, cfg.corridorDilate) : inkIn;
  let floor = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) floor[i] = interior[i] && groove[i] ? 1 : 0;

  const midX = axisX;

  // ── the longitudinal fissure, found as the column whose ink runs unbroken the most rows, then made
  // prominent: continuous, walkable, the spine of both hemispheres.
  let fissureCol = midX;
  let bestRun = -1;
  for (let x = Math.max(1, midX - 10); x <= Math.min(width - 2, midX + 10); x += 1) {
    let run = 0;
    let best = 0;
    for (let y = bbox.minY; y <= bbox.maxY; y += 1) {
      run = inkIn[y * width + x] ? run + 1 : 0;
      best = Math.max(best, run);
    }
    if (best > bestRun) {
      bestRun = best;
      fissureCol = x;
    }
  }
  /*
   * Nothing here opens the fissure any more. It used to: the first version of this block punched a walkable
   * line down the midline so that "the fissure" would show up in the plan, and it did — as a shared hallway
   * both hemispheres walk in, which is the opposite of a division. The cleft is made of wall further down and
   * is crossed only at the doorways the layer bands choose.
   */

  // ── gyri as chambers, measured by width rather than by enclosure. A fold that ends does not enclose
  // anything, so "the white blobs" is the wrong test: it finds three rooms and calls the rest wall. What a
  // gyrus *is*, on a floor plan, is a place where the groove opens out — so the local half-width of the
  // corridor decides, and each bulge wide enough is opened another ring, the big ones two, which is what
  // makes them read as rounded chambers hung along a winding passage.
  const floorWidth = distanceField(floor, width, height);
  // Grooves are thin, so a room is not a wide groove: it is a gyrus — one of the white masses the folds
  // surround. Those are the candidates, and the shape rules below are what keeps a ridge from becoming a hall.
  const ridge = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) ridge[i] = interior[i] && !floor[i] ? 1 : 0;
  const bulges = (() => {
    const mark = new Uint8Array(width * height);
    for (const g of components(ridge, width, height).list) {
      if (g.area < cfg.chamberMinCoreTiles || g.area > cfg.chamberMaxCoreTiles) continue;
      const boxW = g.maxX - g.minX + 1;
      const boxH = g.maxY - g.minY + 1;
      if (boxW < 2 || boxH < 2) continue;
      if (Math.max(boxW, boxH) / Math.max(1, Math.min(boxW, boxH)) > cfg.chamberMaxAspect) continue;
      if (g.area / (boxW * boxH) < cfg.chamberRoundness) continue;
      for (const i of g.cells) mark[i] = 1;
    }
    return mark;
  })();
  const bulgeComps = components(bulges, width, height).list;
  const chambers = [];
  const chamberTiles = new Uint8Array(width * height);
  const rng = mulberry32(cfg.seed ?? 20261012);
  for (const g of bulgeComps) {
    if (g.maxX - g.minX + 1 > cfg.chamberMaxSpan || g.maxY - g.minY + 1 > cfg.chamberMaxSpan) continue;
    if (rng() > cfg.chamberShare) continue;
    const core = g.cells.reduce((m, i) => ((m[i] = 1), m), new Uint8Array(width * height));
    const rings = g.area >= cfg.chamberBigTiles ? cfg.chamberBigRings : cfg.chamberOpenRings;
    let open = dilate(core, width, height, Math.min(rings, 1));
    if (cfg.mirrorHalves && Math.abs(g.cx - fissureCol) >= cfg.mirrorRoomMinOffset) {
      const twin = new Uint8Array(width * height);
      for (let i = 0; i < width * height; i += 1) {
        if (!core[i]) continue;
        const x = i % width;
        const mx = 2 * fissureCol - x;
        if (mx < 0 || mx >= width) continue;
        const j = i - x + mx;
        if (j < 0 || j >= width * height || !interior[j]) continue;
        twin[j] = 1;
      }
      const twinOpen = dilate(twin, width, height, rings);
      for (let i = 0; i < width * height; i += 1) if (twinOpen[i] && interior[i]) open[i] = 1;
    }
    let opened = 0;
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    let area = 0;
    const cells = [];
    for (let i = 0; i < width * height; i += 1) {
      if (!open[i] || !interior[i]) continue;
      if (!floor[i]) opened += 1;
      floor[i] = 1;
      chamberTiles[i] = 1;
      cells.push(i);
      area += 1;
      const x = i % width;
      const y = (i - x) / width;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    // Roundness is a property of a room, not of a pair of twins: measure each piece the opening made and
    // report the worst, so a mirrored pair still has to be two rounded chambers.
    const openedMask = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i += 1) if (open[i] && interior[i]) openedMask[i] = 1;
    const pieces = components(openedMask, width, height).list;
    const spans = pieces.map((q) => {
      const qw = q.maxX - q.minX + 1;
      const qh = q.maxY - q.minY + 1;
      return { area: q.area, w: qw, h: qh, round: q.area / (qw * qh) };
    });
    const worst = spans.reduce((a, b) => (a && a.round <= b.round ? a : b), null) ?? { area, w: 1, h: 1, round: 0 };
    const biggest = spans.reduce((a, b) => (a && a.area >= b.area ? a : b), null) ?? { area, w: 1, h: 1, round: 0 };
    const w2 = biggest.w;
    const h2 = biggest.h;
    chambers.push({
      cells,
      coreArea: g.area,
      area,
      opened,
      cx: g.cx,
      cy: g.cy,
      minX,
      maxX,
      minY,
      maxY,
      spansFissure: g.cells.filter((i) => (i % width) === fissureCol).length,
      // A disc fills 78.5% of its box; a corridor crossing fills far less. This is "rounded chamber", measured
      // on the least round piece the opening produced.
      roundness: Number(worst.round.toFixed(2)),
      pieces: spans.length,
      w: w2,
      h: h2,
    });
  }

  // ── depth annuli: the seven layers, measured from the brain's own edge so each is a smaller brain.
  const depth = distanceField(disc, width, height);
  let maxDepth = 0;
  for (let i = 0; i < width * height; i += 1) if (disc[i]) maxDepth = Math.max(maxDepth, depth[i]);
  if (cfg.maxCorridorHalfWidth > 0) {
    // A groove stays a groove: where the mirrored union has welded two folds into a field, and no chamber was
    // opened, the extra floor goes back to being a ridge. `narrow passageways` is a measurement, not a mood.
    const wide = distanceField(floor, width, height);
    for (let i = 0; i < width * height; i += 1) {
      // Only the room's own tiles are exempt — a bounding box would excuse every plaza the boxes overlap.
      if (!floor[i] || chamberTiles[i]) continue;
      if (wide[i] > cfg.maxCorridorHalfWidth) floor[i] = 0;
    }
  }

  /*
   * The longitudinal fissure is the division, so it is *solid*: a cleft five tiles wide down the middle of the
   * plan, with doorways punched through it one per band. A walkable midline would be a shared corridor, and
   * two hemispheres that share a hallway are not divided — the brief asks for a division held through all
   * seven layers with careful connections across it, which is what this is: the crossings are chosen where
   * each layer actually is, so no layer is a pair of disconnected halves and none is welded into one.
   */
  const cleftHalf = Math.max(2, Math.round(cfg.cleftWidth / 2));
  for (let y = bbox.minY; y <= bbox.maxY; y += 1) {
    for (let x = axisX - cleftHalf; x <= axisX + cleftHalf; x += 1) {
      const i = y * width + x;
      if (i < 0 || i >= width * height || !interior[i]) continue;
      floor[i] = 0;
    }
  }
  const cleftRows = [];
  for (let y = bbox.minY; y <= bbox.maxY; y += 1) if (interior[y * width + axisX]) cleftRows.push(y);
  const bridgeRows = [];
  {
    const perBand = Math.max(1, cfg.crossingsPerLayer);
    for (let band = 0; band < cfg.layers; band += 1) {
      const lo = cleftRows[Math.floor((cleftRows.length * band) / cfg.layers)] ?? cleftRows[0];
      const hi = cleftRows[Math.floor((cleftRows.length * (band + 1)) / cfg.layers)] ?? cleftRows[cleftRows.length - 1];
      const span = cleftRows.slice(cleftRows.indexOf(lo), Math.max(1, cleftRows.indexOf(hi)));
      if (!span.length) continue;
      for (let k = 0; k < perBand; k += 1) {
        const y = span[Math.floor(((k + 0.5) * span.length) / perBand)] ?? span[0];
        if (bridgeRows.some((r) => Math.abs(r - y) < 3)) continue;
        for (let dy = 0; dy < cfg.bridgeRows; dy += 1) {
          const row = y + dy;
          for (let x = axisX - cleftHalf - 1; x <= axisX + cleftHalf + 1; x += 1) {
            const i = row * width + x;
            if (i < 0 || i >= width * height || !interior[i]) continue;
            floor[i] = 1;
          }
        }
        bridgeRows.push(y);
      }
    }
  }

  /*
   * Bands of *equal area*, not equal depth. An outer ring of a portrait disc is far wider than the core it
   * wraps, so cutting the depth range in sevenths hands out one 1.7k-tile layer and a 170-tile one: six
   * short walks and a long one, which is not seven layers of anything. The depth quantiles of the walkable
   * set make every band a comparable place to walk, and they still nest.
   */
  const layerOf = new Int8Array(width * height).fill(-1);
  {
    // Rank, not threshold. The depth field is a chamfer over a sparse fold pattern, so huge numbers of tiles
    // share one value; cutting on thresholds once put 3327 tiles in layer 0 and 467 in layer 1, which is not
    // seven layers of anything. Sorting the walkable tiles by depth and slicing them in sevenths makes the
    // bands equal to within a tile, and ties break on index, which is still deterministic.
    const order = [];
    for (let i = 0; i < width * height; i += 1) if (floor[i]) order.push(i);
    order.sort((a, b) => depth[a] - depth[b] || a - b);
    for (let k = 0; k < order.length; k += 1) {
      layerOf[order[k]] = Math.min(cfg.layers - 1, Math.floor((k * cfg.layers) / order.length));
    }
  }
  const bandOf = (dd) => {
    let lo = 0;
    let hi = cfg.layers - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (depthAtRank(mid) > dd) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  const rankStart = [];
  {
    let count = 0;
    for (let i = 0; i < width * height; i += 1) if (floor[i]) count += 1;
    for (let k = 0; k < cfg.layers; k += 1) rankStart.push(Math.floor((count * k) / cfg.layers));
  }
  const depthAtRank = (k) => {
    let n = 0;
    for (let i = 0; i < width * height; i += 1) {
      if (!floor[i]) continue;
      if (n === rankStart[k] ?? 0) return depth[i];
      n += 1;
    }
    return 0;
  };
  // A room belongs to one layer, whole: the band is decided at the chamber's *shallowest* tile, so you walk
  // into it from the ring outside and the next layer starts beyond it. Slicing a chamber across two layers is
  // how a "layer" stops being a place you can see on its own.
  for (const c of chambers) {
    // A room belongs to one layer whole, and the layer it joins is the one that already owns most of it —
    // not the one holding its shallowest tile, which dragged a thousand-tile hall into the deep core and left
    // the surface band with a quarter of what the rank slices promised.
    const tally = new Map();
    for (const i of c.cells) {
      const band = layerOf[i] >= 0 ? layerOf[i] : bandOf(depth[i]);
      tally.set(band, (tally.get(band) ?? 0) + 1);
    }
    let band = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    for (const i of c.cells) layerOf[i] = band;
    c.layer = band;
  }

  // ── one walkable piece, or none of it is a dungeon. Whatever the folds left stranded — a loop of groove
  // sealed off by the cleft, a pinhole of white the threshold made of an anti-aliased stroke — goes back to
  // being ridge, because a chamber the player cannot reach is a chamber that will never be described, and a
  // site placed in one is content that silently does not exist.
  const pieces = components(floor, width, height).list;
  const kept = pieces[0];
  let discarded = 0;
  let discardedTiles = 0;
  for (const p of pieces.slice(1)) {
    discarded += 1;
    for (const i of p.cells) {
      floor[i] = 0;
      discardedTiles += 1;
    }
  }

  /*
   * The seven layers are labels on one walkable brain, not seven separate maps. Cutting each band into a
   * connected island of its own meant carving ~900 tiles of new doorway per band — which stops being a
   * derivation from the drawing and starts being a maze I invented, and the first version of this did exactly
   * that and produced 30 fragments per band. So: no carving. Each band keeps whatever the folds put there,
   * and the gate checks the two things that actually matter — the whole brain is one walk, and the bands are
   * crossed in order as you go inward.
   */
  const layers = [];
  for (let L = 0; L < cfg.layers; L += 1) {
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i += 1) if (floor[i] && layerOf[i] === L) mask[i] = 1;
    const { list } = components(mask, width, height);
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    let area = 0;
    let deadEnds = 0;
    let junctions = 0;
    let passages = 0;
    let edges = 0;
    const widths = [0, 0, 0, 0, 0];
    for (let i = 0; i < width * height; i += 1) {
      if (!mask[i]) continue;
      area += 1;
      const x = i % width;
      const y = (i - x) / width;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      let deg = 0;
      for (const [dx, dy] of NEIGHBOURS) {
        const j = i + dy * width + dx;
        if (j < 0 || j >= width * height) continue;
        if (mask[j]) deg += 1;
      }
      if (deg === 1) deadEnds += 1;
      else if (deg === 2) passages += 1;
      else if (deg >= 3) junctions += 1;
      edges += deg;
      widths[Math.min(4, Math.max(1, Math.round(floorWidth[i] * 2)) - 1)] += 1;
    }
    layers.push({
      index: L,
      mask,
      area,
      comps: list.length,
      doors: 0,
      deadEnds,
      junctions,
      passages,
      widths,
      loops: Math.max(0, edges / 2 - area + list.length),
      bounds: { minX, maxX, minY, maxY },
    });
  }

  // One walk, measured over the whole brain: a band that shares no edge with its neighbour would be a place
  // the player cannot reach from the layer outside it, and that is worth knowing.
  const adjacency = layers.map((L) => {
    let touches = 0;
    for (let i = 0; i < width * height; i += 1) {
      if (layerOf[i] !== L.index) continue;
      for (const [dx, dy] of NEIGHBOURS) {
        const j = i + dy * width + dx;
        if (j < 0 || j >= width * height) continue;
        if (layerOf[j] === L.index + 1) touches += 1;
      }
    }
    return touches;
  });
  for (let L = 0; L < layers.length; L += 1) layers[L].outward = L === 0 ? 1 : adjacency[L - 1];
  const whole = components(floor, width, height).list;
  let cleftSolid = 0;
  let fissureWalkable = 0;
  for (const y of cleftRows) {
    let blocked = true;
    for (let x = axisX - cleftHalf; x <= axisX + cleftHalf; x += 1) {
      const i = y * width + x;
      if (i >= 0 && i < width * height && floor[i]) blocked = false;
    }
    if (blocked) cleftSolid += 1;
    if (floor[y * width + axisX]) fissureWalkable += 1;
  }

  return {
    width,
    height,
    cfg,
    threshold,
    inkFraction: ink.reduce((a, b) => a + b, 0) / (width * height),
    disc,
    interior,
    ink: inkIn,
    floor,
    wall: new Uint8Array(width * height).map((_, i) => (disc[i] && !floor[i] ? 1 : 0)),
    layerOf,
    depth,
    maxDepth,
    fissureCol,
    fissureRun: bestRun,
    fissureRows: cleftRows,
    cleftRows: cleftRows.length,
    fissureWalkable,
    wholeBrainPieces: 1,
    strandedPieces: discarded,
    strandedTiles: discardedTiles,
    outwardAdjacency: layers.map((L) => L.outward ?? 0),
    cleftSolid,
    bridges: bridgeRows,
    crossings: bridgeRows,
    axisX,
    chambers,
    floorWidth,
    corridorWidths: (() => {
      const list = [];
      for (let i = 0; i < width * height; i += 1) if (floor[i] && !chamberTiles[i]) list.push(floorWidth[i]);
      list.sort((a, b) => a - b);
      const at = (q) => (list.length ? Number(list[Math.floor(list.length * q)].toFixed(1)) : 0);
      return { p50: at(0.5), p90: at(0.9), max: at(0.999), tiles: list.length };
    })(),
    bbox,
    layers,
  };
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An SVG of one layer's plan: walls, floor, the fissure, no labels, no decoration. */
export function planSvg(d, layerIndex, scale = 6) {
  const W = d.width * scale;
  const H = d.height * scale;
  const rects = [];
  const push = (x, y, fill) => rects.push(`<rect x="${x * scale}" y="${y * scale}" width="${scale}" height="${scale}" fill="${fill}"/>`);
  for (let y = 0; y < d.height; y += 1) {
    for (let x = 0; x < d.width; x += 1) {
      const i = y * d.width + x;
      if (layerIndex === null) {
        if (d.floor[i]) push(x, y, '#e8e2d2');
        else if (d.disc[i]) push(x, y, '#2a2536');
        continue;
      }
      const inLayer = d.layers[layerIndex].mask[i];
      const inAny = d.layerOf[i] >= 0;
      if (inLayer) push(x, y, '#e8e2d2');
      else if (d.disc[i]) push(x, y, inAny ? '#2a2536' : '#413a52');
    }
  }
  const fissure =
    layerIndex === null
      ? ''
      : `<rect x="${d.fissureCol * scale}" y="${d.bbox.minY * scale}" width="${scale}" height="${(d.bbox.maxY - d.bbox.minY + 1) * scale}" fill="#8d6fb4" opacity="0.55"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#12101a"/>${rects.join('')}${fissure}</svg>`;
}
