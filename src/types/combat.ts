import type { ElementId, StatusApplication, StatusSpec, VfxStyleId } from './element';

/** Enemy behaviour archetypes. Exactly eight are supported. */
export const ENEMY_ARCHETYPES = [
  'chaser',
  'caster',
  'tank',
  'assassin',
  'charger',
  'splitter',
  'summoner',
  'shielded',
] as const;

export type EnemyArchetype = (typeof ENEMY_ARCHETYPES)[number];

export type EnemyRank = 'normal' | 'elite' | 'boss' | 'miniboss';

export interface DropEntry {
  /** Loot id from the loot registry. */
  id: string;
  weight: number;
  min: number;
  max: number;
  /** Rolled once per entry with this probability (0..1). 1 = always rolls. */
  chance?: number;
}

export interface DropTable {
  id: string;
  entries: DropEntry[];
  /** Guaranteed independent rolls (essence is usually guaranteed). */
  guaranteed?: DropEntry[];
}

export interface EnemyDef {
  id: string;
  name: string;
  archetype: EnemyArchetype;
  description: string;
  /** Base stats at difficulty tier 0. */
  hp: number;
  speed: number;
  damage: number;
  /** 0..1 physical mitigation before armor break. */
  armor: number;
  /** Collision + sprite radius in pixels. */
  radius: number;
  spriteKey: string;
  color: string;
  colorInt: number;
  attackRange: number;
  attackCooldown: number;
  /** Essence granted on death before multipliers. */
  essence: number;
  /** Archetype tuning block. */
  behavior: EnemyBehavior;
  dropTableId: string;
  /** Status effects this enemy applies to the player. */
  onHitStatuses: StatusApplication[];
  /** Element theme used for palette + VFX (never blocks gameplay). */
  element: ElementId;
  /** Ignores player collision when true (flying/floating). */
  flying?: boolean;
  /** Bosses/splitters reference the child archetype they spawn. */
  spawnsOnDeath?: { defId: string; count: number };
}

export interface EnemyBehavior {
  /** Preferred distance kept from the player. */
  preferredRange?: number;
  /** Telegraph wind-up before committing (seconds). */
  telegraph?: number;
  /** Dash speed for chargers/assassins. */
  chargeSpeed?: number;
  /** Seconds between projectile volleys for casters. */
  volleyInterval?: number;
  /** Projectiles per volley. */
  volleyCount?: number;
  /** Projectile speed. */
  projectileSpeed?: number;
  /** Stops moving while attacking. */
  stationaryWhileAttacking?: boolean;
  /** Shield HP regenerated out of combat (shielded archetype). */
  shieldHp?: number;
  shieldRegenDelay?: number;
  /** Orbit offset used by casters (kiting). */
  kite?: boolean;
  /** Number of children a splitter releases. */
  splitCount?: number;
  /** Summon cooldown for summoners. */
  summonCooldown?: number;
  summonDefId?: string;
  summonCount?: number;
  /** Elite affix pool this enemy can roll. */
  eliteAffixes?: EnemyAffixId[];
}

export const ENEMY_AFFIX_IDS = [
  'swift',
  'armored',
  'venomous',
  'volatile',
  'shocking',
  'regenerating',
  'frostbound',
  'warded',
  'giant',
  'eliteBlessed',
] as const;

export type EnemyAffixId = (typeof ENEMY_AFFIX_IDS)[number];

export interface EnemyAffix {
  id: EnemyAffixId;
  name: string;
  description: string;
  color: string;
  hpMult?: number;
  speedMult?: number;
  damageMult?: number;
  armorAdd?: number;
  scaleMult?: number;
  onHitStatuses?: StatusApplication[];
  onDeathExplode?: { radius: number; damageMult: number };
  regenPerSecond?: number;
  shieldHp?: number;
  dropsBonus?: number;
}

/** Spawn instructions produced by the wave generator. */
export interface SpawnGroup {
  defId: string;
  count: number;
  /** Delay between individual spawns, seconds. */
  interval: number;
  /** Delay before this group starts spawning, seconds. */
  delay: number;
  /** Chance each individual is an elite. */
  eliteChance: number;
  /** Fixed affixes (ascension mutations). */
  affixes?: EnemyAffixId[];
}

export interface WaveSpec {
  wave: number;
  floor: number;
  /** Local wave inside the current cycle (1..200). */
  localWave: number;
  cycle: number;
  isMiniBoss: boolean;
  isMajorBoss: boolean;
  bossId: string | null;
  groups: SpawnGroup[];
  /** Scaling multipliers applied to every spawned enemy. */
  hpMult: number;
  damageMult: number;
  speedMult: number;
  eliteChance: number;
  affixChance: number;
  /** Global spawn budget (total enemies in the wave). */
  total: number;
  /** Multiplies essence dropped this wave. */
  rewardMult: number;
  hazardIntensity: number;
  label: string;
  /** Affixes forced onto every enemy in this wave (Ascension mutations). */
  affixes: EnemyAffixId[];
}

export interface DamageInfo {
  amount: number;
  isCrit: boolean;
  damageType: 'physical' | 'elemental' | 'pure';
  element: ElementId | null;
  /** Source label for VFX selection. */
  vfx: VfxStyleId;
  source: 'player' | 'enemy' | 'hazard' | 'boss';
  knockback: number;
  statuses: StatusApplication[];
}

export interface StatusInstance {
  id: StatusSpec['id'];
  remaining: number;
  duration: number;
  intensity: number;
  stacks: number;
}

export interface AttackPatternStep {
  /** Pattern implementation id, resolved by BossController. */
  pattern:
    | 'radialBurst'
    | 'spiral'
    | 'chargeDash'
    | 'summonMinions'
    | 'beamSweep'
    | 'shockwaveRing'
    | 'teleportStrike'
    | 'eruptionField'
    | 'coneSpray'
    | 'orbitSweep'
    | 'shieldPulse';
  /** Weight for random selection inside a phase. */
  weight: number;
  /** Cooldown override for the pattern. */
  cooldown?: number;
  params: Record<string, number>;
}

export interface BossPhase {
  /** Phase begins below this fraction of max HP (0..1). Phase 0 uses 1. */
  hpThreshold: number;
  name: string;
  /** Banner text shown when the phase starts. */
  banner: string;
  damageMult: number;
  speedMult: number;
  attackSpeedMult: number;
  /** Patterns available during this phase. */
  patterns: AttackPatternStep[];
  /** Screen feedback when entering the phase. */
  shake: number;
  arenaRule?: BossArenaRule;
}

export interface BossArenaRule {
  /** Hazards activate below this HP fraction (or immediately at 1). */
  hazardsBelow: number;
  hazardPattern: 'eruptionField' | 'minefield' | 'walls' | 'vortex' | 'blizzard' | 'none';
  hazardIntensity: number;
}

export interface BossDef {
  id: string;
  name: string;
  title: string;
  description: string;
  floor: number;
  /** Major bosses guard floor transitions, mini bosses guard wave 10 of a floor. */
  rank: 'major' | 'miniboss';
  /** Trigger wave inside the story (e.g. 20, 10, 40, ...). */
  wave: number;
  element: ElementId;
  color: string;
  colorInt: number;
  spriteKey: string;
  radius: number;
  hp: number;
  speed: number;
  damage: number;
  armor: number;
  minionDefId: string | null;
  phases: BossPhase[];
  rewardTableId: string;
  /** Element unlocked (or shard-granted) on first story defeat. */
  rewardElement: ElementId | null;
  /** Essence granted. */
  essence: number;
}

export interface PickupDef {
  id: string;
  name: string;
  description: string;
  kind: 'health' | 'energy' | 'essence' | 'shard' | 'relic' | 'buff';
  color: string;
  colorInt: number;
  value: number;
  /** Buff applied on pickup. */
  buff?: { id: string; name: string; duration: number; magnitude: number; stat: string };
}

export interface LootDef {
  id: string;
  name: string;
  description: string;
  rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
  kind: 'essence' | 'shard' | 'relic' | 'consumable' | 'buff' | 'cosmetic';
  value: number;
  color: string;
  /** Cosmetic/temporary effects are session scoped only. */
  temporary?: boolean;
}
