/**
 * A 24-bit PNG writer, so the plan renders without a browser in the loop.
 *
 * The gates already need Playwright, but "look at the map" should not: the derivation is pure node and so is
 * this. 8-bit truecolour, no interlace, one filter byte per scanline, and that is the whole format.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** `rgb` is width*height*3 bytes, row major, top to bottom. */
export function writePng(file, width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

/** A tiny painter: fill a whole canvas, then stamp tiles, then read the buffer back for the encoder. */
export function canvas(width, height, colour = [0, 0, 0]) {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    rgb[i * 3] = colour[0];
    rgb[i * 3 + 1] = colour[1];
    rgb[i * 3 + 2] = colour[2];
  }
  return {
    rgb,
    width,
    height,
    /** Tile (x, y) painted as `scale`×`scale` pixels. */
    tile(x, y, colour, scale = 1) {
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const px = x * scale + dx;
          const py = y * scale + dy;
          if (px < 0 || py < 0 || px >= width || py >= height) continue;
          const i = (py * width + px) * 3;
          rgb[i] = colour[0];
          rgb[i + 1] = colour[1];
          rgb[i + 2] = colour[2];
        }
      }
    },
    rect(x0, y0, x1, y1, colour, scale = 1) {
      for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) this.tile(x, y, colour, scale);
    },
  };
}
