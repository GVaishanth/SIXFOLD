import Phaser from 'phaser';
import type { ElementId } from '@/types';
import { ELEMENT_REGISTRY } from '@/data/elements';
import { canvasFor, commit, px, rect } from '@/game/textureFactory';
import { hexToInt, intToHex } from '@/utils/color';

/**
 * Menu + transition atmosphere art.
 *
 * The home screen used to be a black page with a logo, which is the single
 * biggest reason the product read as a web app. Everything here exists to give
 * that screen (and the interstitial states layered over gameplay) depth: a
 * dithered sky, ridgelines that parallax, ruins with lit windows, drifting fog
 * and a sigil that answers the accent colour of whatever the player is looking
 * at.
 *
 * Textures are generated once at boot and cached by key, so a menu revisit
 * costs nothing.
 */

/** Small deterministic PRNG so every player sees the same ridgelines. */
function rng(seed: number): () => number {
  let state = (seed * 2654435761) >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

/** 4×4 Bayer matrix — used to dither the sky so gradients read as pixel art. */
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

function mix(a: number, b: number, t: number): number {
  const ai = Phaser.Display.Color.IntegerToColor(a);
  const bi = Phaser.Display.Color.IntegerToColor(b);
  return Phaser.Display.Color.GetColor(
    Math.round(ai.red + (bi.red - ai.red) * t),
    Math.round(ai.green + (bi.green - ai.green) * t),
    Math.round(ai.blue + (bi.blue - ai.blue) * t),
  );
}

/**
 * Sky plate: one vertical column of dithered colour, stretched to full width.
 * The horizon carries the accent so the dominant colour of the screen is set by
 * context (story = gold, ascension = violet) without repainting anything.
 *
 * It is generated at the *frame's* size, not a fixed 320×180, because a buffer
 * that is 3.9× taller than the plate would stretch every dither row into a bar
 * and blow each single-pixel star into a blob. The defaults keep the authored
 * 16:9 plate byte-identical.
 */
export function ensureMenuSky(scene: Phaser.Scene, accent: number, width = 320, height = 180): string {
  const key = `menu_sky_${accent.toString(16)}_${width}x${height}`;
  const ctx = canvasFor(scene, key, width, height);
  if (!ctx) return key;

  const stops = [
    { at: 0, color: 0x04060c },
    { at: 0.4, color: 0x070c16 },
    { at: 0.62, color: mix(0x0b101b, accent, 0.12) },
    { at: 0.78, color: mix(0x121d30, accent, 0.24) },
    { at: 0.9, color: mix(0x0a1120, accent, 0.08) },
    { at: 1, color: 0x05080f },
  ];

  const random = rng(91);
  for (let y = 0; y < height; y += 1) {
    const t = y / (height - 1);
    let i = 0;
    while (i < stops.length - 2 && t > stops[i + 1].at) i += 1;
    const a = stops[i];
    const b = stops[i + 1];
    const local = Math.max(0, Math.min(1, (t - a.at) / (b.at - a.at)));
    const c = Phaser.Display.Color.IntegerToColor(mix(a.color, b.color, local));
    for (let x = 0; x < width; x += 1) {
      /* One luminance-domain offset shared by all three channels. Quantising
         each channel separately looked fantastic on paper and terrible at
         4x upscale: dark reds and greens popped out of the void as confetti. */
      const jitter = Math.round((BAYER[y % 4][x % 4] / 16 - 0.5) * 6 + (random() - 0.5) * 3);
      const adjust = (v: number) => Math.max(0, Math.min(255, v + jitter));
      px(ctx, x, y, Phaser.Display.Color.GetColor(adjust(c.red), adjust(c.green), adjust(c.blue)));
      // Sparse stars in the upper half: enough that the void is not empty.
      if (y < height * 0.36 && random() > 0.9985) px(ctx, x, y, 0xc9d6ee, 0.14 + random() * 0.22);
    }
  }
  commit(scene, key);
  return key;
}

/** A ridgeline strip: 320 wide, jagged silhouette with a rim-lit top edge. */
export function ensureMenuRidge(scene: Phaser.Scene, seed: number, height: number, base: number, rim: number): string {
  const key = `menu_ridge_${seed}_${height}_${base.toString(16)}`;
  const width = 320;
  const ctx = canvasFor(scene, key, width, height);
  if (!ctx) return key;

  const random = rng(seed);
  const columnHeight: number[] = [];
  let h = height * (0.35 + random() * 0.3);
  for (let x = 0; x < width; x += 1) {
    // Random walk with occasional steps keeps it looking tectonic, not noisy.
    h += (random() - 0.5) * 2.4;
    if (random() > 0.94) h += (random() - 0.5) * 7;
    h = Math.max(4, Math.min(height - 3, h));
    columnHeight.push(Math.round(h));
  }

  for (let x = 0; x < width; x += 1) {
    const top = height - columnHeight[x];
    rect(ctx, x, top, 1, height - top, base);
    px(ctx, x, top, rim);
    if (x > 0 && columnHeight[x] > columnHeight[x - 1]) px(ctx, x, top + 1, mix(base, rim, 0.4));
    // Sparse texture inside the mass so it isn't a flat silhouette.
    if (random() > 0.86) rect(ctx, x, top + 3 + Math.floor(random() * 4), 1, 2, mix(base, 0x000000, 0.35));
  }
  commit(scene, key);
  return key;
}

/**
 * Ruin band: broken pillars, arches and a few lit windows, sitting in front of
 * the ridgelines. Windows are the only warm pixels on the layer, which is what
 * makes the place feel inhabited rather than decorated.
 */
export function ensureMenuRuins(scene: Phaser.Scene, seed: number, mass: number, lit: number): string {
  const key = `menu_ruins_${seed}_${mass.toString(16)}`;
  const width = 320;
  const height = 46;
  const ctx = canvasFor(scene, key, width, height);
  if (!ctx) return key;

  const random = rng(seed);
  const dark = mix(mass, 0x000000, 0.45);
  const light = mix(mass, 0xe8edf7, 0.16);

  let x = -6;
  while (x < width) {
    const gap = 4 + Math.floor(random() * 10);
    x += gap;
    const kind = random();
    if (kind < 0.42) {
      // Column: shaft, rim light on the left, broken cap.
      const w = 4 + Math.floor(random() * 3);
      const h = 10 + Math.floor(random() * 26);
      const top = height - h;
      rect(ctx, x, top, w, h, mass);
      rect(ctx, x, top, 1, h, light);
      rect(ctx, x + w - 1, top, 1, h, dark);
      const chip = Math.floor(random() * 3);
      rect(ctx, x + w - 1, top, 1, 1 + chip, mass);
      if (random() > 0.5) rect(ctx, x - 1, top - 2, w + 2, 2, light);
      if (random() > 0.55) px(ctx, x + 1 + Math.floor(random() * Math.max(1, w - 2)), top + 3 + Math.floor(random() * 5), lit);
    } else if (kind < 0.7) {
      // Arch: two piers plus a span with a missing block.
      const span = 12 + Math.floor(random() * 12);
      const h = 14 + Math.floor(random() * 12);
      const top = height - h;
      rect(ctx, x, top, 3, h, mass);
      rect(ctx, x + span - 3, top, 3, h, mass);
      rect(ctx, x, top, span, 3, mass);
      rect(ctx, x, top, span, 1, light);
      const broken = Math.floor(x + span * (0.35 + random() * 0.4));
      rect(ctx, broken, top + 1, 2, 2, 0x000000);
      for (let i = 0; i < 2; i += 1) {
        px(ctx, x + 1, top + 5 + i * 6, lit);
        px(ctx, x + span - 2, top + 7 + i * 5, lit);
      }
      x += span;
    } else {
      // Rubble mound.
      const w = 6 + Math.floor(random() * 10);
      const h = 3 + Math.floor(random() * 6);
      for (let i = 0; i < h; i += 1) {
        rect(ctx, x + i, height - h + i, Math.max(1, w - i * 2), 1, mass);
      }
      px(ctx, x + 1, height - h, light);
      px(ctx, x + w - 2, height - h + 1, dark);
    }
  }
  commit(scene, key);
  return key;
}

/** Fog band: soft horizontal blobs with alpha, tiled and scrolled. */
export function ensureMenuFog(scene: Phaser.Scene): string {
  const key = 'menu_fog';
  const ctx = canvasFor(scene, key, 64, 18);
  if (!ctx) return key;
  const random = rng(7);
  for (let blob = 0; blob < 26; blob += 1) {
    const cx = random() * 64;
    const cy = 4 + random() * 12;
    const rx = 6 + random() * 12;
    const ry = 1.5 + random() * 3;
    for (let y = Math.floor(cy - ry); y <= cy + ry; y += 1) {
      for (let x = Math.floor(cx - rx); x <= cx + rx; x += 1) {
        if (x < 0 || x > 63 || y < 17 || y < 0) continue;
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        const d = dx * dx + dy * dy;
        if (d > 1) continue;
        px(ctx, ((x % 64) + 64) % 64, y, 0xc8d6ee, (1 - d) * 0.2);
      }
    }
  }
  commit(scene, key);
  return key;
}

/**
 * Soft radial light. Kept on its own key so it can be filtered smoothly —
 * gameplay VFX stay on nearest-neighbour pixels.
 */
export function ensureSoftGlow(scene: Phaser.Scene): string {
  const key = 'menu_glow';
  const size = 64;
  const ctx = canvasFor(scene, key, size, size);
  if (!ctx) return key;
  const c = size / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - c + 0.5) / c;
      const dy = (y - c + 0.5) / c;
      const d = Math.sqrt(dx * dx + dy * dy * 2.6);
      if (d > 1) continue;
      px(ctx, x, y, 0xffffff, Math.pow(1 - d, 1.7));
    }
  }
  commit(scene, key);
  const texture = scene.textures.get(key);
  if (texture) texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
  return key;
}

/**
 * Sigil: the ritual mark behind the title. Six notches for the six loadout
 * slots, one inner ring per elemental tier, and a hollow core so text stays
 * readable on top of it.
 */
export function ensureMenuSigil(scene: Phaser.Scene): string {
  const key = 'menu_sigil';
  const size = 96;
  const ctx = canvasFor(scene, key, size, size);
  if (!ctx) return key;
  const c = size / 2;

  const ring = (radius: number, alpha: number, color = 0xffffff) => {
    for (let a = 0; a < 360; a += 0.6) {
      const rad = (a * Math.PI) / 180;
      px(ctx, Math.round(c + Math.cos(rad) * radius), Math.round(c + Math.sin(rad) * radius), color, alpha);
    }
  };

  ring(44, 0.5);
  ring(38, 0.24);
  ring(26, 0.4);
  ring(13, 0.18);

  // Six slot markers with a bar out to the rim.
  for (let i = 0; i < 6; i += 1) {
    const rad = (i / 6) * Math.PI * 2 - Math.PI / 2;
    for (let r = 30; r <= 46; r += 1) {
      px(ctx, Math.round(c + Math.cos(rad) * r), Math.round(c + Math.sin(rad) * r), 0xffffff, 0.55);
    }
    for (let d = -2; d <= 2; d += 1) {
      px(ctx, Math.round(c + Math.cos(rad) * 48) + d, Math.round(c + Math.sin(rad) * 48), 0xffffff, 0.85);
      px(ctx, Math.round(c + Math.cos(rad) * 48), Math.round(c + Math.sin(rad) * 48) + d, 0xffffff, 0.85);
    }
  }

  // Tick marks around the outer rim, skipped where the notches sit.
  for (let a = 0; a < 360; a += 6) {
    if (a % 60 < 6) continue;
    const rad = (a * Math.PI) / 180;
    px(ctx, Math.round(c + Math.cos(rad) * 52), Math.round(c + Math.sin(rad) * 52), 0xffffff, 0.3);
  }

  // Hollow the centre so the wordmark never sits on noise.
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = intToHex(0x000000);
  ctx.beginPath();
  ctx.arc(c, c, 22, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  commit(scene, key);
  return key;
}

/** Floor shelf the ruins stand on: slab, top highlight, ember cracks. */
export function ensureMenuShelf(scene: Phaser.Scene, accent: number): string {
  const key = `menu_shelf_${accent.toString(16)}`;
  const ctx = canvasFor(scene, key, 320, 34);
  if (!ctx) return key;
  const random = rng(21);
  const slab = 0x0a1120;
  rect(ctx, 0, 0, 320, 34, slab);
  rect(ctx, 0, 0, 320, 1, mix(slab, 0xe8edf7, 0.3));
  rect(ctx, 0, 1, 320, 1, mix(slab, 0xe8edf7, 0.12));

  // Flagstones.
  for (let x = 0; x < 320; x += 16) {
    rect(ctx, x, 0, 1, 10, mix(slab, 0x000000, 0.5));
    if (random() > 0.6) rect(ctx, x + 4, 5 + Math.floor(random() * 3), 8, 1, mix(slab, 0x000000, 0.35));
  }

  // Cracks that glow with the accent — the only "alive" part of the ground.
  for (let i = 0; i < 7; i += 1) {
    let x = Math.floor(random() * 300);
    let y = 2 + Math.floor(random() * 8);
    for (let step = 0; step < 22; step += 1) {
      px(ctx, x, y, accent, 0.5);
      x += 1 + (random() > 0.7 ? 1 : 0);
      y += random() > 0.55 ? 1 : 0;
      if (y > 30) break;
    }
  }
  for (let y = 12; y < 34; y += 1) {
    for (let x = 0; x < 320; x += 1) {
      if (random() > 0.985) px(ctx, x, y, mix(slab, 0xe8edf7, 0.08));
    }
  }
  commit(scene, key);
  return key;
}

/**
 * Element glyph plate: the runic mark for one element, drawn at three
 * intensities so a screen can hold it, glow it, or barely show it.
 */
export function ensureElementGlyph(scene: Phaser.Scene, element: ElementId): string {
  const def = ELEMENT_REGISTRY[element];
  const key = `glyph_${element}`;
  const size = 16;
  const ctx = canvasFor(scene, key, size, size);
  if (!ctx) return key;
  const color = hexToInt(def.color);
  const glyph = def.symbol;

  // Draw the rune character itself into the texture: crisp, cached per element,
  // and identical to whatever the interface shows for the same element.
  ctx.imageSmoothingEnabled = false;
  ctx.font = '11px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = intToHex(color);
  ctx.fillText(glyph, size / 2, size / 2 + 1);
  commit(scene, key);
  return key;
}
