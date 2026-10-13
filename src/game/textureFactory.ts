import Phaser from 'phaser';
import type { ElementId, VfxStyleId } from '@/types';
import { hexToInt, intToHex } from '@/utils/color';

/**
 * Procedural pixel-art factory.
 *
 * Every texture in SIXFOLD is drawn at runtime on a canvas — no external asset
 * packs, nothing to license, and the art style stays consistent because the
 * same palette helpers are used everywhere. Textures are generated once at
 * boot and cached by key, so repeated lookups are free.
 */

type Ctx = CanvasRenderingContext2D;

const REGISTRY = new Set<string>();

export function canvasFor(scene: Phaser.Scene, key: string, w: number, h: number): Ctx | null {
  if (REGISTRY.has(key) && scene.textures.exists(key)) return null;
  const canvasTexture = scene.textures.createCanvas(key, w, h);
  if (!canvasTexture) return null;
  REGISTRY.add(key);
  const ctx = canvasTexture.getContext();
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

export function commit(scene: Phaser.Scene, key: string): void {
  const texture = scene.textures.get(key);
  if (texture instanceof Phaser.Textures.CanvasTexture) texture.refresh();
}

export function px(ctx: Ctx, x: number, y: number, color: number, alpha = 1): void {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = intToHex(color);
  ctx.fillRect(x, y, 1, 1);
  ctx.globalAlpha = 1;
}

export function rect(ctx: Ctx, x: number, y: number, w: number, h: number, color: number, alpha = 1): void {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = intToHex(color);
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 1;
}

export function outlineRect(ctx: Ctx, x: number, y: number, w: number, h: number, color: number): void {
  rect(ctx, x, y, w, 1, color);
  rect(ctx, x, y + h - 1, w, 1, color);
  rect(ctx, x, y, 1, h, color);
  rect(ctx, x + w - 1, y, 1, h, color);
}

/** Draw a shape from a compact string map for recognisable silhouettes. */
function fromMap(
  ctx: Ctx,
  map: string[],
  palette: Record<string, number>,
  offsetX = 0,
  offsetY = 0,
): void {
  for (let y = 0; y < map.length; y += 1) {
    const row = map[y];
    for (let x = 0; x < row.length; x += 1) {
      const symbol = row[x];
      if (symbol === '.' || symbol === ' ') continue;
      const color = palette[symbol];
      if (color === undefined) continue;
      px(ctx, x + offsetX, y + offsetY, color);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Palette helpers                                                     */
/* ------------------------------------------------------------------ */

export function basePalette(color: number): Record<string, number> {
  const dark = Phaser.Display.Color.IntegerToColor(color).darken(45).color;
  const light = Phaser.Display.Color.IntegerToColor(color).lighten(28).color;
  return {
    a: 0x0b0e16, // outline
    b: dark,
    c: color,
    d: light,
    e: 0xffffff,
    s: 0x9aa6bd, // steel / eye glow
  };
}

/* ------------------------------------------------------------------ */
/* Silhouettes                                                         */
/* ------------------------------------------------------------------ */

const SILHOUETTES = {
  chaser: [
    '..aa..aa..',
    '.abcaaca..',
    'abcccdcca.',
    'abcsccsca.',
    'abcccccca.',
    '.acccccca.',
    '..abcccba.',
    '..abc.cba.',
    '.aba...aba',
    '.aa.....aa',
  ],
  caster: [
    '...aaaa...',
    '..acccca..',
    '.accddcca.',
    '.accsscca.',
    '.acddddca.',
    '..acccca..',
    '...acbca..',
    '..acbcbca.',
    '.acb...bca',
    '.aa.....aa',
  ],
  tank: [
    '.aaaaaaa..',
    'abcccccca.',
    'acccddccca',
    'accsssscca',
    'acddddddca',
    'acccddccca',
    'abccccccba',
    '.abccccba.',
    'aba.aa.aba',
    'aa......aa',
  ],
  assassin: [
    '...aa.....',
    '..acba....',
    '.acccba...',
    '.acsccca..',
    '..acccbca.',
    '...acccba.',
    '..abcbbca.',
    '.aba..aba.',
    'aa......aa',
    '..........',
  ],
  charger: [
    '..aaa.....',
    '.accca....',
    'acccdcca..',
    'acsscccaaa',
    'accccccbba',
    'accccccba.',
    '.abc.ccba.',
    'ab..aaa...',
    'a.........',
    '..........',
  ],
  splitter: [
    '...cc.....',
    '..cccc....',
    '.ccddcc...',
    'ccsssscc..',
    'ccddddcc..',
    '.cccccc...',
    '..cccc....',
    '.ac..ca...',
    'a.......a.',
    '..........',
  ],
  summoner: [
    '...aaaa...',
    '..acccca..',
    '.accddcca.',
    '.acsccsca.',
    '..acccca..',
    '.acbccbca.',
    'acb.ac.ab.',
    'a...a...a.',
    '..........',
    '..........',
  ],
  shielded: [
    '..aaaaaa..',
    '.acccccca.',
    'acdddddcca',
    'acsddddscc',
    'acdddddcca',
    'acccccccca',
    '.abcccccba',
    '..accbbca.',
    '..ab..ba..',
    '..........',
  ],
} as const;

export type SilhouetteKey = keyof typeof SILHOUETTES;

function drawSilhouette(scene: Phaser.Scene, key: string, shape: SilhouetteKey, color: number): void {
  const map = SILHOUETTES[shape];
  const w = Math.max(...map.map((row) => row.length));
  const h = map.length;
  const ctx = canvasFor(scene, key, w, h);
  if (!ctx) return;
  fromMap(ctx, map as unknown as string[], basePalette(color));
  commit(scene, key);
}

/* ------------------------------------------------------------------ */
/* Player                                                              */
/* ------------------------------------------------------------------ */

const PLAYER_MAP = [
  '..aaaa..',
  '.acccca.',
  'acsccsca',
  '.acddca.',
  '.accdca.',
  '.acccba.',
  'ab..ba..',
  'a....a..',
];

/** Player texture per element so the active element is always visible. */
export function ensurePlayerTexture(scene: Phaser.Scene, element: ElementId, color: number): string {
  const key = `player_${element}`;
  if (scene.textures.exists(key)) return key;
  const ctx = canvasFor(scene, key, 8, 8);
  if (!ctx) return key;
  fromMap(ctx, PLAYER_MAP, basePalette(color));
  // Cloak/outline accent matches the element.
  px(ctx, 0, 1, 0x0b0e16);
  px(ctx, 7, 1, 0x0b0e16);
  px(ctx, 1, 6, color);
  px(ctx, 6, 6, color);
  commit(scene, key);
  return key;
}

/* ------------------------------------------------------------------ */
/* Projectiles + VFX sprites                                           */
/* ------------------------------------------------------------------ */

interface VfxShape {
  w: number;
  h: number;
  draw: (ctx: Ctx, palette: Record<string, number>) => void;
}

const VFX_SHAPES: Record<VfxStyleId, VfxShape> = {
  spark: {
    w: 5,
    h: 5,
    draw: (ctx, p) => {
      px(ctx, 2, 0, p.d);
      px(ctx, 1, 1, p.c);
      rect(ctx, 0, 2, 5, 1, p.d);
      px(ctx, 2, 2, p.e);
      px(ctx, 3, 3, p.c);
      px(ctx, 2, 4, p.b);
    },
  },
  splash: {
    w: 6,
    h: 5,
    draw: (ctx, p) => {
      px(ctx, 1, 1, p.d);
      px(ctx, 4, 1, p.d);
      rect(ctx, 0, 2, 6, 2, p.c);
      rect(ctx, 1, 4, 4, 1, p.b);
      px(ctx, 2, 2, p.e);
      px(ctx, 3, 2, p.e);
    },
  },
  streak: {
    w: 7,
    h: 3,
    draw: (ctx, p) => {
      rect(ctx, 0, 1, 7, 1, p.c);
      px(ctx, 5, 1, p.e);
      px(ctx, 1, 0, p.b);
      px(ctx, 2, 2, p.b);
      px(ctx, 6, 0, p.d);
      px(ctx, 6, 2, p.d);
    },
  },
  shard: {
    w: 5,
    h: 6,
    draw: (ctx, p) => {
      px(ctx, 2, 0, p.e);
      rect(ctx, 1, 1, 3, 2, p.d);
      rect(ctx, 0, 3, 5, 1, p.c);
      rect(ctx, 1, 4, 3, 1, p.b);
      px(ctx, 2, 5, p.b);
    },
  },
  bolt: {
    w: 5,
    h: 7,
    draw: (ctx, p) => {
      px(ctx, 2, 0, p.e);
      px(ctx, 2, 1, p.d);
      px(ctx, 1, 2, p.c);
      px(ctx, 2, 3, p.e);
      px(ctx, 3, 4, p.c);
      px(ctx, 2, 5, p.d);
      px(ctx, 2, 6, p.b);
    },
  },
  rock: {
    w: 6,
    h: 6,
    draw: (ctx, p) => {
      rect(ctx, 1, 0, 4, 1, p.b);
      rect(ctx, 0, 1, 6, 3, p.c);
      rect(ctx, 1, 4, 4, 1, p.b);
      px(ctx, 1, 1, p.d);
      px(ctx, 4, 1, p.b);
      px(ctx, 0, 2, p.a);
      px(ctx, 5, 2, p.a);
    },
  },
  steam: {
    w: 6,
    h: 6,
    draw: (ctx, p) => {
      rect(ctx, 1, 1, 3, 3, p.c, 0.9);
      px(ctx, 4, 0, p.d);
      px(ctx, 0, 3, p.d);
      px(ctx, 2, 4, p.b);
      px(ctx, 3, 2, p.e);
    },
  },
  mist: {
    w: 7,
    h: 5,
    draw: (ctx, p) => {
      rect(ctx, 0, 1, 7, 3, p.c, 0.8);
      rect(ctx, 1, 0, 5, 1, p.d, 0.7);
      px(ctx, 2, 2, p.e);
    },
  },
  smoke: {
    w: 6,
    h: 6,
    draw: (ctx, p) => {
      rect(ctx, 1, 1, 4, 4, p.b, 0.85);
      px(ctx, 2, 2, p.c);
      px(ctx, 3, 3, p.c);
      px(ctx, 0, 4, p.a);
    },
  },
  lava: {
    w: 6,
    h: 6,
    draw: (ctx, p) => {
      rect(ctx, 1, 0, 4, 4, p.c);
      rect(ctx, 0, 4, 6, 1, p.b);
      px(ctx, 2, 1, p.e);
      px(ctx, 3, 2, p.d);
      px(ctx, 1, 5, p.b);
    },
  },
  crystal: {
    w: 6,
    h: 6,
    draw: (ctx, p) => {
      px(ctx, 3, 0, p.e);
      rect(ctx, 2, 1, 2, 2, p.d);
      rect(ctx, 1, 3, 4, 1, p.c);
      rect(ctx, 0, 4, 6, 1, p.b);
      px(ctx, 2, 2, p.e);
    },
  },
  storm: {
    w: 7,
    h: 6,
    draw: (ctx, p) => {
      rect(ctx, 0, 2, 7, 2, p.c);
      px(ctx, 2, 0, p.d);
      px(ctx, 4, 1, p.e);
      px(ctx, 3, 4, p.d);
      px(ctx, 5, 5, p.b);
    },
  },
  sand: {
    w: 5,
    h: 5,
    draw: (ctx, p) => {
      px(ctx, 1, 1, p.c);
      px(ctx, 3, 2, p.d);
      px(ctx, 0, 3, p.b);
      px(ctx, 2, 3, p.c);
      px(ctx, 4, 4, p.b);
    },
  },
  frost: {
    w: 6,
    h: 6,
    draw: (ctx, p) => {
      rect(ctx, 2, 0, 2, 6, p.c);
      rect(ctx, 0, 2, 6, 2, p.d);
      px(ctx, 1, 1, p.e);
      px(ctx, 4, 4, p.e);
    },
  },
  ash: {
    w: 5,
    h: 5,
    draw: (ctx, p) => {
      rect(ctx, 1, 1, 3, 3, p.b, 0.9);
      px(ctx, 2, 2, p.c);
      px(ctx, 0, 3, p.a);
      px(ctx, 4, 1, p.c);
    },
  },
  vine: {
    w: 6,
    h: 6,
    draw: (ctx, p) => {
      rect(ctx, 2, 0, 2, 6, p.c);
      px(ctx, 1, 1, p.d);
      px(ctx, 4, 2, p.d);
      px(ctx, 1, 4, p.b);
      px(ctx, 3, 2, p.e);
    },
  },
  metal: {
    w: 7,
    h: 4,
    draw: (ctx, p) => {
      rect(ctx, 0, 1, 7, 2, p.c);
      px(ctx, 6, 1, p.e);
      px(ctx, 1, 0, p.d);
      px(ctx, 2, 3, p.b);
    },
  },
  sound: {
    w: 7,
    h: 7,
    draw: (ctx, p) => {
      px(ctx, 3, 3, p.e);
      rect(ctx, 1, 2, 1, 3, p.c);
      rect(ctx, 5, 2, 1, 3, p.c);
      rect(ctx, 0, 1, 1, 5, p.b);
      rect(ctx, 6, 1, 1, 5, p.b);
    },
  },
  eruption: {
    w: 8,
    h: 8,
    draw: (ctx, p) => {
      rect(ctx, 2, 2, 4, 4, p.d);
      rect(ctx, 3, 0, 2, 8, p.c);
      rect(ctx, 0, 3, 8, 2, p.c);
      px(ctx, 3, 3, p.e);
      px(ctx, 4, 4, p.e);
      px(ctx, 1, 1, p.b);
      px(ctx, 6, 6, p.b);
    },
  },
  blizzard: {
    w: 8,
    h: 8,
    draw: (ctx, p) => {
      rect(ctx, 3, 0, 2, 8, p.c);
      rect(ctx, 0, 3, 8, 2, p.c);
      px(ctx, 2, 2, p.d);
      px(ctx, 5, 5, p.d);
      px(ctx, 2, 5, p.e);
      px(ctx, 5, 2, p.e);
    },
  },
  tempest: {
    w: 8,
    h: 8,
    draw: (ctx, p) => {
      rect(ctx, 2, 1, 4, 1, p.c);
      rect(ctx, 1, 3, 6, 1, p.d);
      rect(ctx, 2, 5, 4, 1, p.c);
      px(ctx, 4, 2, p.e);
      px(ctx, 3, 6, p.b);
      px(ctx, 6, 2, p.b);
    },
  },
  oasis: {
    w: 7,
    h: 7,
    draw: (ctx, p) => {
      rect(ctx, 2, 1, 3, 5, p.c);
      px(ctx, 1, 2, p.d);
      px(ctx, 5, 4, p.d);
      px(ctx, 3, 2, p.e);
      px(ctx, 3, 5, p.b);
    },
  },
  toxic: {
    w: 6,
    h: 6,
    draw: (ctx, p) => {
      rect(ctx, 2, 0, 2, 3, p.c);
      rect(ctx, 1, 3, 4, 2, p.d);
      px(ctx, 3, 1, p.e);
      px(ctx, 2, 5, p.b);
    },
  },
  solar: {
    w: 7,
    h: 7,
    draw: (ctx, p) => {
      rect(ctx, 2, 2, 3, 3, p.e);
      rect(ctx, 3, 0, 1, 7, p.d);
      rect(ctx, 0, 3, 7, 1, p.d);
      px(ctx, 1, 1, p.c);
      px(ctx, 5, 5, p.c);
    },
  },
  plasma: {
    w: 7,
    h: 7,
    draw: (ctx, p) => {
      rect(ctx, 3, 0, 1, 7, p.e);
      rect(ctx, 2, 2, 3, 3, p.d);
      rect(ctx, 0, 3, 7, 1, p.c);
      px(ctx, 1, 1, p.c);
      px(ctx, 5, 5, p.c);
      px(ctx, 3, 3, 0xffffff);
    },
  },
};

export function ensureVfxTexture(scene: Phaser.Scene, style: VfxStyleId, color: number): string {
  const key = `vfx_${style}_${color.toString(16)}`;
  if (scene.textures.exists(key)) return key;
  const shape = VFX_SHAPES[style];
  const ctx = canvasFor(scene, key, shape.w, shape.h);
  if (!ctx) return key;
  shape.draw(ctx, basePalette(color));
  commit(scene, key);
  return key;
}

/** Circle texture used by particles and portals (tinted at runtime). */
export function ensureDotTexture(scene: Phaser.Scene): string {
  const key = 'fx_dot';
  if (scene.textures.exists(key)) return key;
  const ctx = canvasFor(scene, key, 4, 4);
  if (!ctx) return key;
  rect(ctx, 1, 0, 2, 4, 0xffffff);
  rect(ctx, 0, 1, 4, 2, 0xffffff);
  commit(scene, key);
  return key;
}

export function ensureSquareParticle(scene: Phaser.Scene): string {
  const key = 'fx_square';
  if (scene.textures.exists(key)) return key;
  const ctx = canvasFor(scene, key, 2, 2);
  if (!ctx) return key;
  rect(ctx, 0, 0, 2, 2, 0xffffff);
  commit(scene, key);
  return key;
}

export function ensureRingTexture(scene: Phaser.Scene): string {
  const key = 'fx_ring';
  if (scene.textures.exists(key)) return key;
  const size = 16;
  const ctx = canvasFor(scene, key, size, size);
  if (!ctx) return key;
  const r = size / 2 - 1;
  for (let a = 0; a < 360; a += 3) {
    const rad = (a * Math.PI) / 180;
    px(ctx, Math.round(size / 2 + Math.cos(rad) * r), Math.round(size / 2 + Math.sin(rad) * r), 0xffffff);
  }
  commit(scene, key);
  return key;
}

export function ensurePortalTexture(scene: Phaser.Scene): string {
  const key = 'fx_portal';
  if (scene.textures.exists(key)) return key;
  const size = 24;
  const ctx = canvasFor(scene, key, size, size);
  if (!ctx) return key;
  const c = size / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - c + 0.5;
      const dy = y - c + 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 10.5) continue;
      const alpha = 0.25 + (1 - dist / 10.5) * 0.65;
      px(ctx, x, y, 0xffffff, Math.min(1, alpha));
    }
  }
  commit(scene, key);
  return key;
}

/* ------------------------------------------------------------------ */
/* Enemies + bosses                                                    */
/* ------------------------------------------------------------------ */

export function ensureEnemyTexture(scene: Phaser.Scene, spriteKey: string, color: number): string {
  // Base silhouettes are generated once in white so runtime tinting can
  // produce any elemental palette without extra textures.
  if (scene.textures.exists(spriteKey)) return spriteKey;
  const shape: SilhouetteKey =
    spriteKey === 'enemy_chaser'
      ? 'chaser'
      : spriteKey === 'enemy_caster'
        ? 'caster'
        : spriteKey === 'enemy_tank'
          ? 'tank'
          : spriteKey === 'enemy_assassin'
            ? 'assassin'
            : spriteKey === 'enemy_charger'
              ? 'charger'
              : spriteKey === 'enemy_splitter'
                ? 'splitter'
                : spriteKey === 'enemy_summoner'
                  ? 'summoner'
                  : 'shielded';
  drawSilhouette(scene, spriteKey, shape, color);
  return spriteKey;
}

const BOSS_SHAPES: Record<string, SilhouetteKey> = {
  boss_hound: 'charger',
  boss_tyrant: 'tank',
  boss_warden: 'tank',
  boss_leviathan: 'splitter',
  boss_serpent: 'assassin',
  boss_skywarden: 'caster',
  boss_thornmaw: 'tank',
  boss_behemoth: 'tank',
  boss_golem: 'shielded',
  boss_sovereign: 'shielded',
  boss_herald: 'caster',
  boss_herald_frost: 'caster',
  boss_stormtyrant: 'summoner',
  boss_revenant: 'assassin',
  boss_colossus: 'tank',
  boss_regent: 'caster',
  boss_matron: 'splitter',
  boss_hydra: 'splitter',
  boss_avatar: 'summoner',
  boss_core: 'shielded',
};

export function ensureBossTexture(scene: Phaser.Scene, spriteKey: string, color: number): string {
  if (scene.textures.exists(spriteKey)) return spriteKey;
  const shape = BOSS_SHAPES[spriteKey] ?? 'tank';
  const map = SILHOUETTES[shape];
  const w = Math.max(...map.map((row) => row.length));
  const h = map.length;
  const ctx = canvasFor(scene, spriteKey, w, h);
  if (!ctx) return spriteKey;
  fromMap(ctx, map as unknown as string[], basePalette(color));
  // Crown/marker so bosses read as boss-scale even at a glance.
  rect(ctx, Math.floor(w / 2) - 2, 0, 4, 1, 0xf2c96b);
  px(ctx, Math.floor(w / 2) - 3, 1, 0xf2c96b);
  px(ctx, Math.floor(w / 2) + 2, 1, 0xf2c96b);
  commit(scene, spriteKey);
  return spriteKey;
}

/* ------------------------------------------------------------------ */
/* Pickups, props, tiles                                               */
/* ------------------------------------------------------------------ */

export function ensurePickupTexture(scene: Phaser.Scene, kind: string, color: number): string {
  const key = `pickup_${kind}_${color.toString(16)}`;
  if (scene.textures.exists(key)) return key;
  const ctx = canvasFor(scene, key, 7, 7);
  if (!ctx) return key;
  const palette = basePalette(color);
  const isShard = kind === 'shard';
  const isRelic = kind === 'relic';
  if (isShard) {
    px(ctx, 3, 0, palette.e);
    rect(ctx, 2, 1, 3, 2, palette.d);
    rect(ctx, 1, 3, 5, 2, palette.c);
    px(ctx, 3, 5, palette.b);
  } else if (isRelic) {
    rect(ctx, 1, 1, 5, 5, palette.c);
    rect(ctx, 2, 0, 3, 7, palette.d);
    px(ctx, 3, 3, palette.e);
    outlineRect(ctx, 1, 1, 5, 5, palette.a);
  } else {
    rect(ctx, 2, 1, 3, 5, palette.c);
    rect(ctx, 1, 2, 5, 3, palette.d);
    px(ctx, 3, 2, palette.e);
    px(ctx, 2, 4, palette.b);
  }
  commit(scene, key);
  return key;
}

export function ensureTileTextures(scene: Phaser.Scene, floorPalette: { floor: string; grout: string; wall: string }): void {
  const tileKey = `tile_${floorPalette.floor}`;
  if (!scene.textures.exists(tileKey)) {
    const ctx = canvasFor(scene, tileKey, 16, 16);
    if (ctx) {
      const floor = hexToInt(floorPalette.floor);
      const grout = hexToInt(floorPalette.grout);
      rect(ctx, 0, 0, 16, 16, floor);
      rect(ctx, 0, 15, 16, 1, grout);
      rect(ctx, 15, 0, 1, 16, grout);
      // Subtle speckle for texture without noise overload.
      px(ctx, 3, 4, grout);
      px(ctx, 11, 3, grout);
      px(ctx, 7, 10, grout);
      px(ctx, 13, 12, grout);
      px(ctx, 5, 13, grout);
      commit(scene, tileKey);
    }
  }

  const wallKey = `wall_${floorPalette.wall}`;
  if (!scene.textures.exists(wallKey)) {
    const ctx = canvasFor(scene, wallKey, 8, 8);
    if (ctx) {
      const wall = hexToInt(floorPalette.wall);
      const dark = Phaser.Display.Color.IntegerToColor(wall).darken(35).color;
      rect(ctx, 0, 0, 8, 8, wall);
      rect(ctx, 0, 7, 8, 1, dark);
      rect(ctx, 7, 0, 1, 8, dark);
      px(ctx, 2, 3, dark);
      px(ctx, 5, 5, dark);
      commit(scene, wallKey);
    }
  }
}

export function ensurePropTexture(scene: Phaser.Scene, family: string, color: number): string {
  const key = `prop_${family}_${color.toString(16)}`;
  if (scene.textures.exists(key)) return key;
  const ctx = canvasFor(scene, key, 12, 14);
  if (!ctx) return key;
  const palette = basePalette(color);
  switch (family) {
    case 'ruins':
      rect(ctx, 1, 6, 4, 8, palette.b);
      rect(ctx, 7, 3, 4, 11, palette.c);
      px(ctx, 2, 4, palette.c);
      break;
    case 'vault':
      rect(ctx, 0, 9, 12, 5, palette.b);
      rect(ctx, 3, 4, 6, 5, palette.c);
      px(ctx, 5, 6, palette.e);
      break;
    case 'spires':
      rect(ctx, 5, 0, 2, 14, palette.d);
      rect(ctx, 2, 8, 8, 6, palette.b);
      break;
    case 'labyrinth':
      rect(ctx, 2, 2, 2, 12, palette.c);
      rect(ctx, 8, 0, 2, 10, palette.b);
      rect(ctx, 2, 0, 8, 2, palette.d);
      break;
    case 'foundry':
      rect(ctx, 1, 4, 10, 10, palette.b);
      px(ctx, 6, 0, palette.e);
      px(ctx, 3, 7, palette.d);
      px(ctx, 8, 9, palette.d);
      break;
    case 'citadel':
      rect(ctx, 0, 6, 12, 8, palette.b);
      rect(ctx, 4, 0, 4, 8, palette.c);
      px(ctx, 5, 3, palette.e);
      break;
    case 'wastes':
      rect(ctx, 0, 10, 12, 4, palette.b);
      px(ctx, 3, 7, palette.c);
      px(ctx, 8, 5, palette.d);
      break;
    case 'crown':
      rect(ctx, 2, 8, 2, 6, palette.c);
      rect(ctx, 8, 8, 2, 6, palette.c);
      rect(ctx, 2, 4, 8, 4, palette.d);
      break;
    case 'mire':
      rect(ctx, 0, 11, 12, 3, palette.b);
      px(ctx, 4, 6, palette.d);
      px(ctx, 7, 4, palette.c);
      px(ctx, 5, 3, palette.e);
      break;
    default:
      rect(ctx, 3, 3, 6, 8, palette.c);
      px(ctx, 5, 5, palette.e);
      px(ctx, 6, 7, palette.e);
      break;
  }
  commit(scene, key);
  return key;
}

/**
 * A dungeon stone: 10×13, drawn in the prop idiom (hard-edged rects on the biome's palette), with a
 * lit cap only while it is awake. The three states the mode cares about are carried by tint and alpha in
 * the scene, so one texture serves dormant / active / spent and the pixel grid never moves.
 */
export function ensureStoneTexture(scene: Phaser.Scene, color: number, variant = 0): string {
  const key = `stone_${color.toString(16)}_${variant}`;
  if (scene.textures.exists(key)) return key;
  const ctx = canvasFor(scene, key, 10, 13);
  if (!ctx) return key;
  const palette = basePalette(color);
  if (variant === 1) {
    // A low, wide cache: a lid on something buried.
    rect(ctx, 1, 6, 8, 7, palette.b);
    rect(ctx, 2, 5, 6, 2, palette.c);
    px(ctx, 4, 9, palette.d);
    px(ctx, 5, 9, palette.e);
  } else if (variant === 2) {
    // A split spring: water finds the seam.
    rect(ctx, 2, 2, 6, 11, palette.b);
    rect(ctx, 4, 0, 2, 13, palette.a);
    rect(ctx, 4, 6, 2, 5, palette.d);
    px(ctx, 4, 4, palette.e);
  } else {
    // The default grove / den monolith.
    rect(ctx, 3, 1, 4, 12, palette.b);
    rect(ctx, 2, 3, 6, 9, palette.c);
    px(ctx, 4, 5, palette.d);
    px(ctx, 5, 7, palette.e);
    px(ctx, 4, 9, palette.a);
  }
  commit(scene, key);
  return key;
}

/** Explosion/death puff texture, tinted per use. */
/**
 * Soft radial blob used for light pools and contact shadows. Filtered smoothly
 * because it stands in for light, not for pixel detail.
 */
export function ensureSoftGlowKey(scene: Phaser.Scene): string {
  const key = 'fx_soft_glow';
  if (scene.textures.exists(key)) return key;
  const size = 48;
  const ctx = canvasFor(scene, key, size, size);
  if (!ctx) return key;
  const c = size / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x + 0.5 - c) / c;
      const dy = (y + 0.5 - c) / c;
      const d = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      px(ctx, x, y, 0xffffff, Math.pow(1 - d, 1.6));
    }
  }
  commit(scene, key);
  scene.textures.get(key)?.setFilter(Phaser.Textures.FilterMode.LINEAR);
  return key;
}

/**
 * Screen-fixed vignette for gameplay: darkened corners and a slightly lifted
 * centre, which is what makes a flat tile field read as a lit pit.
 * Drawn at half resolution and filtered smoothly — it is light, not detail.
 */
export function ensureVignetteTexture(scene: Phaser.Scene): string {
  const key = 'fx_vignette';
  if (scene.textures.exists(key)) return key;
  const width = 160;
  const height = 90;
  const ctx = canvasFor(scene, key, width, height);
  if (!ctx) return key;
  const cx = width / 2;
  const cy = height / 2;
  /* A superellipse, not a circle: the frame is stretched to whatever shape the
     window has, and round isolines turn into a visible arc across the middle of
     a tall phone. Straight edges with soft corners survive any aspect ratio. */
  const p = 3.4;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = Math.abs((x + 0.5 - cx) / cx);
      const dy = Math.abs((y + 0.5 - cy) / cy);
      const d = Math.pow(Math.pow(dx, p) + Math.pow(dy, p), 1 / p);
      if (d < 0.74) continue;
      const a = Math.min(1, (d - 0.74) / 0.34);
      px(ctx, x, y, 0x000000, Math.pow(a, 1.35) * 0.72);
    }
  }
  commit(scene, key);
  scene.textures.get(key)?.setFilter(Phaser.Textures.FilterMode.LINEAR);
  return key;
}

export function ensurePuffTexture(scene: Phaser.Scene): string {
  const key = 'fx_puff';
  if (scene.textures.exists(key)) return key;
  const ctx = canvasFor(scene, key, 10, 10);
  if (!ctx) return key;
  const c = 5;
  for (let y = 0; y < 10; y += 1) {
    for (let x = 0; x < 10; x += 1) {
      const dist = Math.hypot(x - c + 0.5, y - c + 0.5);
      if (dist > 5) continue;
      px(ctx, x, y, 0xffffff, Math.max(0, 1 - dist / 5) * 0.85);
    }
  }
  commit(scene, key);
  return key;
}
