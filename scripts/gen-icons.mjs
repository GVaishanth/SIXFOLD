/**
 * The SIXFOLD mark, and everything derived from it.
 *
 * One grid, four PNGs and the tab icon. The mark is authored as pixel art on an 8×8 grid because a favicon is
 * only ever asked to be one of two things: legible at 16px, or crisp at 512px. On an 8-cell grid one cell is 2px
 * at the small end — the smallest unit a browser still draws as a block rather than as a grey smear — and 22px
 * at the big end, which is what makes it read as tile art in the game's own idiom instead of as a logo that was
 * scaled down. The mark is a hex-cut seal with an ember core: a closed silhouette, because an open one loses its
 * shape the moment the tab shrinks it (measured, not assumed — a 32-unit viewBox drawn with 1.6px strokes, the
 * previous mark, rendered as an indistinct speck at 16px, and four fill-the-tile candidates were compared at
 * 16/32/48/180 on light and dark before this one was kept).
 *
 * SIXFOLD ships no binary art it did not generate, and an installable web app needs real PNGs (iOS ignores an
 * SVG `apple-touch-icon`, and a manifest icon cannot be a data: URI in every browser we care about). So the
 * mark is drawn here, per pixel, and encoded with nothing but Node's built-in zlib. `public/favicon.svg` is
 * written from the same grid, which is the only reason the tab icon and the installed-app icon still agree —
 * hand-maintaining two copies of a logo is how that drift starts.
 *
 * Run with `npm run icons`; the output in `public/` is committed, so the Pages workflow never has to run this
 * to build. `npm run audit:pages` checks the generated files are present, referenced and served.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public/icons');

const VOID = [7, 10, 18];
const DEEP = [11, 16, 27];
const GOLD = [242, 201, 107];
const EMBER = [255, 92, 108];

/** '.' void, 'X' gold, 'E' ember. Eight rows of eight, no exceptions. */
export const MARK = ['.XXXXXX.', 'XX....XX', 'X..XX..X', 'X.XEEX.X', 'X.XEEX.X', 'X..XX..X', 'XX....XX', '.XXXXXX.'];
const N = MARK.length;
const INK = { X: GOLD, E: EMBER };
if (MARK.some((row) => row.length !== N)) throw new Error(`the mark must be ${N}x${N}`);

/**
 * How much of the tile the mark fills.
 *
 * `padded` is the maskable / apple-touch variant: those get clipped to a circle or a squircle by the OS, so the
 * mark has to retreat inside the safe zone or the seal loses its left and right faces. The plain variant uses
 * nearly the whole tile, which is what a 16px tab favours.
 */
const SPAN = { plain: 0.94, padded: 0.72 };

function sample(x, y, size, { padded }) {
  // Void field with a faint vertical lift, so the icon is not a flat disc.
  let [r, g, b] = lerp3(DEEP, VOID, Math.min(1, (y / size) * 1.35));

  const cell = (size * (padded ? SPAN.padded : SPAN.plain)) / N;
  const offset = (size - cell * N) / 2;
  const cx = Math.floor((x - offset) / cell);
  const cy = Math.floor((y - offset) / cell);
  if (cx >= 0 && cx < N && cy >= 0 && cy < N) {
    const ink = INK[MARK[cy][cx]];
    if (ink) {
      [r, g, b] = ink;
      // One cell of self-shading down the mark's own bottom-right, kept proportional so it is exactly one
      // pixel at 192 and still only a few at 512. Without it the gold reads as a sticker at large sizes.
      const inside = (x - offset) / cell - cx;
      const insideY = (y - offset) / cell - cy;
      const bevel = Math.max(1, size / (N * 22));
      if (inside > 1 - bevel / cell || insideY > 1 - bevel / cell) {
        r = lerp(r, VOID[0], 0.34);
        g = lerp(g, VOID[1], 0.34);
        b = lerp(b, VOID[2], 0.34);
      }
    }
  }

  return [Math.round(clamp(r)), Math.round(clamp(g)), Math.round(clamp(b)), 255];
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}
function lerp3(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}
function clamp(v) {
  return Math.max(0, Math.min(255, v));
}

function crc(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc(body), 0);
  return Buffer.concat([len, body, crcBuf]);
}

function encodePng(size, pixels) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let o = 0;
  for (let y = 0; y < size; y += 1) {
    raw[o] = 0; // filter: none
    o += 1;
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      // Premultiply against the void background so the halo cannot show a seam
      // on a light home screen.
      const a = pixels[i + 3] / 255;
      raw[o] = Math.round(pixels[i] * a + VOID[0] * (1 - a));
      raw[o + 1] = Math.round(pixels[i + 1] * a + VOID[1] * (1 - a));
      raw[o + 2] = Math.round(pixels[i + 2] * a + VOID[2] * (1 - a));
      o += 3;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function render(size, opts) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = sample(x, y, size, opts);
      const i = (y * size + x) * 4;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = a;
    }
  }
  return encodePng(size, pixels);
}

const HEX = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/**
 * `public/favicon.svg` — the same grid, as rectangles, at 32 units.
 *
 * `shape-rendering="crispEdges"` is not decoration: without it the browser antialiases the block edges at 16px
 * and the seal's faces turn grey, which is the whole thing the mark exists to avoid. The rounded plate is sized
 * so the corner cells survive it, since a browser shows a favicon as drawn and does not mask it.
 */
function faviconSvg(cell = 4) {
  const size = cell * N;
  const rects = MARK.flatMap((row, y) =>
    [...row].flatMap((ch, x) =>
      INK[ch] ? [`    <rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="${HEX(INK[ch])}"/>`] : [],
    ),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="SIXFOLD">
  <rect width="${size}" height="${size}" rx="${Math.round(size * 0.19)}" fill="${HEX(VOID)}"/>
  <g shape-rendering="crispEdges">
${rects.join('\n')}
  </g>
</svg>
`;
}

mkdirSync(OUT, { recursive: true });
const jobs = [
  ['icon-192.png', 192, { padded: false }],
  ['icon-512.png', 512, { padded: false }],
  ['icon-maskable-512.png', 512, { padded: true }],
  ['apple-touch-icon.png', 180, { padded: true }],
];
for (const [name, size, opts] of jobs) {
  const buf = render(size, opts);
  writeFileSync(resolve(OUT, name), buf);
  console.log(`${name.padEnd(24)} ${size}×${size}  ${(buf.length / 1024).toFixed(1)} kB`);
}
const svg = faviconSvg();
writeFileSync(resolve(ROOT, 'public', 'favicon.svg'), svg);
console.log(`${'favicon.svg'.padEnd(24)} ${32}×${32}  ${(Buffer.byteLength(svg) / 1024).toFixed(1)} kB`);
