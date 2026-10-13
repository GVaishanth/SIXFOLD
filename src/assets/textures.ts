import Phaser from 'phaser';
import { ELEMENT_REGISTRY } from '@/data/elements';
import { ENEMY_LIST } from '@/data/enemies';
import { BOSS_LIST } from '@/data/bosses';
import { FLOOR_LIST } from '@/data/floors';
import {
  ensureBossTexture,
  ensureDotTexture,
  ensureEnemyTexture,
  ensurePlayerTexture,
  ensurePortalTexture,
  ensurePuffTexture,
  ensureRingTexture,
  ensureSquareParticle,
  ensureTileTextures,
  ensureVfxTexture,
} from '@/game/textureFactory';

/**
 * Procedural asset registry.
 *
 * SIXFOLD ships no image or audio files. Every sprite in the game is a canvas
 * texture drawn at boot time by `game/textureFactory`, which keeps the build
 * tiny, the licence surface empty, and lets palette changes propagate through
 * the whole art set automatically. This module owns the *manifest* — the list
 * of textures a session needs before gameplay can start — while the factory
 * owns the drawing.
 *
 * Adding a new element, enemy, boss or floor automatically adds its textures
 * here, because every loop below walks the data registries rather than a
 * hand-maintained list.
 */

export interface AssetManifest {
  /** Number of distinct texture keys generated for this session. */
  textureCount: number;
  /** Keys grouped by family, useful for debug output and the performance HUD. */
  families: Record<string, number>;
}

/** Generates every texture the game needs. Safe to call more than once. */
export function generateCoreTextures(scene: Phaser.Scene): AssetManifest {
  const families: Record<string, number> = {};

  // 1. Utility textures shared by particles, rings and teleports.
  ensureDotTexture(scene);
  ensureSquareParticle(scene);
  ensureRingTexture(scene);
  ensurePuffTexture(scene);
  ensurePortalTexture(scene);
  families.utility = 5;

  // 2. Player silhouettes and the attack/skill/ultimate projectiles, one set
  //    per element, so switching elements is instantly readable.
  let elementTextures = 0;
  for (const element of Object.values(ELEMENT_REGISTRY)) {
    ensurePlayerTexture(scene, element.id, element.colorInt);
    ensureVfxTexture(scene, element.attack.vfx, element.colorInt);
    ensureVfxTexture(scene, element.skill.vfx, element.colorInt);
    ensureVfxTexture(scene, element.ultimate.vfx, element.colorInt);
    elementTextures += 4;
  }
  families.elements = elementTextures;

  // 3. Enemy and boss silhouettes (tinted per definition at spawn time).
  for (const def of ENEMY_LIST) ensureEnemyTexture(scene, def.spriteKey, def.colorInt);
  for (const boss of BOSS_LIST) ensureBossTexture(scene, boss.spriteKey, boss.colorInt);
  families.enemies = ENEMY_LIST.length + BOSS_LIST.length;

  // 4. Per-floor ground tiles, grout and wall sets.
  for (const floor of FLOOR_LIST) {
    ensureTileTextures(scene, {
      floor: floor.palette.floor,
      grout: floor.palette.grout,
      wall: floor.palette.wall,
    });
  }
  families.floors = FLOOR_LIST.length;

  const textureCount = Object.values(families).reduce((sum, value) => sum + value, 0);
  return { textureCount, families };
}
