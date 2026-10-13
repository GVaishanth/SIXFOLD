/**
 * Element domain types.
 *
 * There are exactly 25 gameplay elements. The union below is the single
 * source of truth: every registry entry, every save file and every piece of
 * UI is typed against it.
 */

export const ELEMENT_IDS = [
  // Primordial (3)
  'fire',
  'water',
  'air',
  // Branching (6)
  'earth',
  'ice',
  'lightning',
  'steam',
  'mist',
  'smoke',
  // Advanced (9)
  'magma',
  'crystal',
  'storm',
  'sand',
  'frost',
  'ash',
  'vine',
  'metal',
  'sound',
  // Final (7)
  'volcano',
  'blizzard',
  'tempest',
  'oasis',
  'toxic',
  'solar',
  'plasma',
] as const;

export type ElementId = (typeof ELEMENT_IDS)[number];

export const ELEMENT_COUNT = ELEMENT_IDS.length; // 25

export type ElementTier = 'primordial' | 'branching' | 'advanced' | 'final';

export type DamageType = 'physical' | 'elemental' | 'pure';

/** Status effects supported by the generic status system. */
export const STATUS_IDS = [
  'burn',
  'freeze',
  'shock',
  'slow',
  'root',
  'poison',
  'blind',
  'stun',
  'knockback',
  'armorBreak',
] as const;

export type StatusId = (typeof STATUS_IDS)[number];

export type StatusStackMode = 'refresh' | 'stack' | 'strongest' | 'ignore';

export interface StatusSpec {
  id: StatusId;
  name: string;
  description: string;
  /** Visual colour of the status pip drawn above enemies. */
  color: number;
  /** Heartbeat damage/heal per second, scaled by intensity. */
  dotPerSecond?: number;
  /** Movement multiplier while active (0 = fully rooted). */
  moveMultiplier?: number;
  /** Damage multiplier applied to the victim while active. */
  damageTakenMultiplier?: number;
  /** Outgoing damage multiplier while active. */
  damageDealtMultiplier?: number;
  /** Attacks disabled while active. */
  disablesAttack?: boolean;
  /** Instant impulse applied once on application (pixels/second). */
  impulse?: number;
  stackMode: StatusStackMode;
  maxStacks: number;
  /** Default duration in seconds, modified by intensity. */
  duration: number;
  /** Mastery/ascension scaling of duration & potency. */
  scalesWithIntensity: boolean;
}

export interface StatusApplication {
  id: StatusId;
  duration: number;
  intensity?: number;
  chance?: number;
}

/** How the basic attack resolves in the arena. */
export type AttackKind =
  | 'projectile'
  | 'shotgun'
  | 'beam'
  | 'melee'
  | 'orb'
  | 'chain'
  | 'aura'
  | 'shockwave';

export interface ProjectileSpec {
  speed: number;
  /** Texture key suffix used by the VFX factory. */
  visual: string;
  radius: number;
  /** ms */
  lifetime: number;
  pierce: number;
  /** Number of extra hops to nearby enemies (lightning/storm). */
  chain?: number;
  /** Homing strength 0..1. */
  homing?: number;
  /** Projectile count fired in a spread. */
  count?: number;
  /** Spread arc in degrees. */
  spreadDeg?: number;
  /** Explode on impact for area damage. */
  explodeRadius?: number;
  explodeDamageMult?: number;
  /** Projectiles that boomerang back to the caster. */
  boomerang?: boolean;
  /** Leaves a lingering damage field. */
  trailField?: { radius: number; dpsMult: number; lifetime: number };
  /** Reflects incoming enemy projectiles. */
  destroysEnemyProjectiles?: boolean;
}

export interface AttackSpec {
  kind: AttackKind;
  label: string;
  description: string;
  /** Damage multiplier against player attack power. */
  damageMultiplier: number;
  /** Seconds between attacks. */
  cooldown: number;
  energyCost: number;
  knockback: number;
  projectile: ProjectileSpec | null;
  /** AoE radius for melee/shockwave/aura attacks. */
  aoeRadius: number;
  onHit: StatusApplication[];
  /** Flat heal granted to the player per enemy hit (Water/Mist/Oasis). */
  healOnHit?: number;
  /** Grants a temporary damage-absorbing shield (Crystal/Metal/Earth). */
  shieldOnCast?: number;
  /** Player velocity impulse on cast (Air/Storm mobility). */
  castImpulse?: number;
  vfx: VfxStyleId;
}

export type AbilityKind =
  | 'nova'
  | 'field'
  | 'bolt'
  | 'beam'
  | 'storm'
  | 'shield'
  | 'healField'
  | 'dashStrike'
  | 'summonAdds'
  | 'timeRift'
  | 'pull'
  | 'overload'
  | 'eruption';

export interface AbilitySpec {
  id: string;
  name: string;
  description: string;
  kind: AbilityKind;
  energyCost: number;
  cooldown: number;
  radius: number;
  damageMultiplier: number;
  duration: number;
  knockback: number;
  statuses: StatusApplication[];
  vfx: VfxStyleId;
  heal?: number;
  shield?: number;
  /** Number of projectiles / bolts / waves produced. */
  count?: number;
  /** Damage per second for field-type abilities, as a multiplier. */
  dpsMultiplier?: number;
  /** Ultimate abilities are shown differently in the HUD. */
  ultimate?: boolean;
}

export type PassiveKind =
  | 'damageAmp'
  | 'critChance'
  | 'critDamage'
  | 'moveSpeed'
  | 'cooldownReduction'
  | 'lifesteal'
  | 'evasion'
  | 'regen'
  | 'thorns'
  | 'statusAmp'
  | 'pickupRadius'
  | 'shieldOnSwitch'
  | 'energyRegen'
  | 'armor'
  | 'attackSpeed';

export interface PassiveSpec {
  kind: PassiveKind;
  value: number;
  description: string;
}

export interface UnlockRequirement {
  /** `starter` = pickable at new game, otherwise discovered through play. */
  kind: 'starter' | 'shard' | 'boss' | 'wave';
  /** Wave milestone or shard cost. */
  value?: number;
  /** Boss id that drops the element. */
  bossId?: string;
  note: string;
}

export interface ElementDef {
  id: ElementId;
  /** Stable display index 1..25, used by the codex and skill tree. */
  index: number;
  name: string;
  tier: ElementTier;
  description: string;
  /** Short combat identity line shown in the codex / skill tree. */
  identity: string;
  /** Primary colour (#RRGGBB) used by UI + VFX. */
  color: string;
  /** Numeric colour for Phaser. */
  colorInt: number;
  /**
   * The deep end of the element's two-stop palette (the red inside an orange
   * flame, the indigo inside a cyan bolt). VFX use it for particle cores and
   * screen washes so an element reads as a *volume*, not a flat tint.
   */
  colorCore: string;
  /** Numeric core colour for Phaser. */
  colorCoreInt: number;
  /** Two-stop gradient used for panels: identity colour → panel shade. */
  gradient: [string, string];
  /** Elemental glyph rendered by the pixel font. */
  symbol: string;
  parents: ElementId[];
  children: ElementId[];
  damageType: DamageType;
  attack: AttackSpec;
  skill: AbilitySpec;
  ultimate: AbilitySpec;
  passive: PassiveSpec;
  /** Additional passives stacked on top of the headline passive. */
  extraPassives?: PassiveSpec[];
  /** Mastery bonus multiplier per mastery level (applied to damage). */
  masteryMultiplier: number;
  unlock: UnlockRequirement;
}

export type VfxStyleId =
  | 'spark'
  | 'splash'
  | 'streak'
  | 'shard'
  | 'bolt'
  | 'rock'
  | 'steam'
  | 'mist'
  | 'smoke'
  | 'lava'
  | 'crystal'
  | 'storm'
  | 'sand'
  | 'frost'
  | 'ash'
  | 'vine'
  | 'metal'
  | 'sound'
  | 'eruption'
  | 'blizzard'
  | 'tempest'
  | 'oasis'
  | 'toxic'
  | 'solar'
  | 'plasma';

export interface ResonanceDef {
  id: string;
  name: string;
  description: string;
  /** Elements that must all be present in the loadout. */
  requires: ElementId[];
  color: string;
  effects: ResonanceEffect[];
}

export type ResonanceEffect =
  | { kind: 'damageMult'; value: number }
  | { kind: 'critAdd'; value: number }
  | { kind: 'cooldownMult'; value: number }
  | { kind: 'statusDurationMult'; value: number }
  | { kind: 'armorAdd'; value: number }
  | { kind: 'moveSpeedAdd'; value: number }
  | { kind: 'energyRegenAdd'; value: number }
  | { kind: 'lifestealAdd'; value: number }
  | { kind: 'attackSpeedMult'; value: number }
  | { kind: 'shieldOnWave'; value: number };

export interface ActiveResonance {
  def: ResonanceDef;
  effects: ResonanceEffect[];
}
