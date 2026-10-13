import type Phaser from 'phaser';
import type { Enemy, EnemyRank } from '@/game/entities/Enemy';
import type { Player } from '@/game/entities/Player';
import type { ProjectileManager } from '@/game/entities/Projectile';
import type { FieldManager } from '@/game/entities/Field';
import type { FxSystem } from '@/game/systems/fx';
import type { DropTable, ElementId, EnemyAffixId, FloorDef, StatusApplication, VfxStyleId } from '@/types';
import type { ElementFamily } from '@/data/elements/palette';

/**
 * Shared runtime context handed to every entity.
 *
 * Keeping this explicit (instead of a global singleton) means a scene restart
 * produces a brand new context — no stale player references, no duplicated
 * listeners, no cross-scene leakage.
 */
export interface SpawnEnemyOptions {
  rank?: EnemyRank;
  elite?: boolean;
  affixes?: EnemyAffixId[];
  hpMult?: number;
  damageMult?: number;
  speedMult?: number;
  portal?: boolean;
  scaleOverride?: number;
}

export interface CombatContext {
  scene: Phaser.Scene;
  fx: FxSystem;
  camera: Phaser.Cameras.Scene2D.Camera;
  player: Player;
  enemies: Phaser.Physics.Arcade.Group;
  playerProjectiles: ProjectileManager;
  enemyProjectiles: ProjectileManager;
  fields: FieldManager;
  floor: FloorDef;
  /** Scaling from the active wave. */
  scaling: {
    hpMult: number;
    damageMult: number;
    speedMult: number;
    eliteChance: number;
    affixChance: number;
    affixes: EnemyAffixId[];
  };
  spawnEnemy: (defId: string, x: number, y: number, options?: SpawnEnemyOptions) => Enemy | null;
  spawnPortal: (x: number, y: number, color: number) => void;
  spawnPickup: (id: string, x: number, y: number, value?: number) => void;
  rollDropTable: (table: DropTable, x: number, y: number, bonus?: number) => void;
  addEssence: (amount: number) => void;
  addShards: (amount: number) => void;
  onEnemyKilled: (enemy: Enemy) => void;
  onBossPhase: (enemy: Enemy, phaseIndex: number, banner: string) => void;
  onBossTelegraph: (enemy: Enemy, pattern: string) => void;
  addField: (config: {
    x: number;
    y: number;
    radius: number;
    dps: number;
    duration: number;
    element: string;
    vfx: VfxStyleId;
    color: number;
    statuses?: StatusApplication[];
    friendly: boolean;
    pull?: number;
    followPlayer?: boolean;
  }) => void;
  /** Delayed, telegraphed ground eruptions (eruption abilities and hazards). */
  eruption: (config: {
    count: number;
    radius: number;
    spread: number;
    damage: number;
    element: string | null;
    vfx: VfxStyleId;
    color: number;
    statuses?: StatusApplication[];
    knockback?: number;
    origin: { x: number; y: number };
    aimAngle: number;
    followPlayer: boolean;
    telegraphMs?: number;
    delayMs?: number;
  }) => void;
  hitSparkAt: (
    x: number,
    y: number,
    color: number,
    power: number,
    vfx: VfxStyleId,
    family?: ElementFamily,
  ) => void;
  addHazardBurst: (
    x: number,
    y: number,
    radius: number,
    damage: number,
    color: number,
    element?: ElementId | null,
    statuses?: StatusApplication[],
  ) => void;
  /** Area damage. `friendly` decides whether it hurts enemies or the player. */
  damageArea: (config: {
    x: number;
    y: number;
    radius: number;
    damage: number;
    element: string | null;
    vfx: VfxStyleId;
    color: number;
    statuses?: StatusApplication[];
    knockback?: number;
    friendly: boolean;
    isCrit?: boolean;
    /** Support-rig cast: pays no energy, no lifesteal, no crit. */
    auto?: boolean;
    maxTargets?: number;
  }) => number;
  telegraph: (x: number, y: number, radius: number, color: number, durationMs: number) => void;
  audioEnabled: boolean;
}
