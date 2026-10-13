import type { EnemyAffixId, EnemyArchetype } from './combat';
import type { ElementId } from './element';

export type HazardKind =
  | 'none'
  | 'lavaCracks'
  | 'current'
  | 'windZone'
  | 'overgrowth'
  | 'walls'
  | 'lightningStrikes'
  | 'ashCloud'
  | 'iceSheet'
  | 'toxicPools'
  | 'instability';

export interface FloorPalette {
  /** Deep background. */
  bg: string;
  /** Secondary background band. */
  bgAlt: string;
  /** Floor tile colour. */
  floor: string;
  /** Tile grout / border. */
  grout: string;
  /** Arena wall colour. */
  wall: string;
  /** Ambient accent used for props and particles. */
  accent: string;
  /** Portal tint for enemy spawns. */
  portal: string;
  /** HUD accent for the floor label. */
  ui: string;
}

export interface FloorDef {
  id: number;
  name: string;
  subtitle: string;
  /** 1..10 story floor; 0 is used by Free Mode training arena. */
  storyIndex: number;
  palette: FloorPalette;
  ambientParticle: 'ember' | 'bubble' | 'gust' | 'spore' | 'glint' | 'spark' | 'ash' | 'snow' | 'miasma' | 'aether';
  ambientDensity: number;
  hazard: { kind: HazardKind; intensity: number; description: string };
  /** Enemy archetypes unlocked at this floor. */
  enemyPool: EnemyArchetype[];
  /** Scaling modifiers applied to enemies spawned on this floor. */
  modifiers: {
    hpMult: number;
    damageMult: number;
    speedMult: number;
    eliteBonus: number;
  };
  /** Extra affixes that can appear from this floor onwards. */
  affixPool: EnemyAffixId[];
  miniBossId: string;
  majorBossId: string;
  /** Elements that can be discovered while clearing this floor. */
  elementDiscoveries: ElementId[];
  rewardTableId: string;
  music: { key: string; bpm: number; scale: number[]; root: number };
  /** Prop sprite family drawn around the arena. */
  props: 'ruins' | 'vault' | 'spires' | 'labyrinth' | 'foundry' | 'citadel' | 'wastes' | 'crown' | 'mire' | 'core';
}
