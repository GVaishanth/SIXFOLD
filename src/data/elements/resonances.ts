import type { ElementId, ResonanceDef, ResonanceEffect } from '@/types';
import { hexToInt } from '@/utils/color';

/**
 * Element resonance — data-driven loadout synergies.
 *
 * Add a new entry here and it immediately appears in the loadout screen, the
 * codex and in the live stat calculation. No code changes are required.
 */
export const RESONANCES: ResonanceDef[] = [
  {
    id: 'cinder',
    name: 'Cinder Resonance',
    description: 'Fire and smoke feed each other — burning enemies take more damage.',
    requires: ['fire', 'smoke'],
    color: '#FF9550',
    effects: [{ kind: 'damageMult', value: 1.1 }],
  },
  {
    id: 'frozenCore',
    name: 'Frozen Core',
    description: 'Water and ice lock together, extending every chill you inflict.',
    requires: ['water', 'ice'],
    color: '#8FD8EF',
    effects: [
      { kind: 'statusDurationMult', value: 1.25 },
      { kind: 'armorAdd', value: 4 },
    ],
  },
  {
    id: 'stormResonance',
    name: 'Storm Resonance',
    description: 'Air and lightning answer each other — attacks come faster and crit harder.',
    requires: ['air', 'lightning'],
    color: '#FFE066',
    effects: [
      { kind: 'attackSpeedMult', value: 1.12 },
      { kind: 'critAdd', value: 0.06 },
    ],
  },
  {
    id: 'fortress',
    name: 'Fortress Resonance',
    description: 'Earth, metal and crystal form an unbreakable guard.',
    requires: ['earth', 'metal', 'crystal'],
    color: '#93A4BD',
    effects: [
      { kind: 'armorAdd', value: 12 },
      { kind: 'shieldOnWave', value: 14 },
    ],
  },
  {
    id: 'pressure',
    name: 'Pressure Resonance',
    description: 'Fire, water and steam build impossible pressure behind every cast.',
    requires: ['fire', 'water', 'steam'],
    color: '#D8D2C8',
    effects: [
      { kind: 'damageMult', value: 1.12 },
      { kind: 'cooldownMult', value: 0.92 },
    ],
  },
  {
    id: 'verdant',
    name: 'Verdant Resonance',
    description: 'Vine and water entwine, pouring life back into you as enemies fall.',
    requires: ['vine', 'water'],
    color: '#6FCB6F',
    effects: [
      { kind: 'lifestealAdd', value: 0.03 },
      { kind: 'armorAdd', value: 3 },
    ],
  },
  {
    id: 'pyroclasm',
    name: 'Pyroclasm Resonance',
    description: 'Magma and ash burn as one, and the ground never stops burning.',
    requires: ['magma', 'ash'],
    color: '#F05A28',
    effects: [{ kind: 'damageMult', value: 1.15 }],
  },
  {
    id: 'whiteout',
    name: 'Whiteout Resonance',
    description: 'Frost and storm freeze the arena into a single killing field.',
    requires: ['frost', 'storm'],
    color: '#DCF2FF',
    effects: [
      { kind: 'statusDurationMult', value: 1.3 },
      { kind: 'damageMult', value: 1.08 },
    ],
  },
  {
    id: 'mirage',
    name: 'Mirage Resonance',
    description: 'Sand and mist hide you from everything that wants you dead.',
    requires: ['sand', 'mist'],
    color: '#E0C088',
    effects: [
      { kind: 'moveSpeedAdd', value: 0.08 },
      { kind: 'cooldownMult', value: 0.94 },
    ],
  },
  {
    id: 'radiance',
    name: 'Radiance Resonance',
    description: 'Solar and plasma overload everything they touch.',
    requires: ['solar', 'plasma'],
    color: '#FFD24A',
    effects: [
      { kind: 'damageMult', value: 1.18 },
      { kind: 'critAdd', value: 0.04 },
    ],
  },
  {
    id: 'sixfold',
    name: 'SIXFOLD Resonance',
    description: 'All six slots filled with distinct elements — the game names itself.',
    requires: ['fire', 'water', 'air', 'ice', 'lightning', 'crystal'],
    color: '#F2C96B',
    effects: [
      { kind: 'damageMult', value: 1.2 },
      { kind: 'cooldownMult', value: 0.9 },
      { kind: 'energyRegenAdd', value: 2 },
    ],
  },
  {
    id: 'ascendantSix',
    name: 'Ascendant Sixfold',
    description: 'Any six elements of the final tier resonate into raw power.',
    requires: ['volcano', 'blizzard', 'tempest', 'oasis', 'toxic', 'plasma'],
    color: '#C87BFF',
    effects: [
      { kind: 'damageMult', value: 1.3 },
      { kind: 'armorAdd', value: 10 },
      { kind: 'lifestealAdd', value: 0.04 },
    ],
  },
];

export interface ComputedResonance {
  def: ResonanceDef;
  colorInt: number;
}

/** Returns every resonance currently satisfied by an equipped loadout. */
export function computeResonances(equipped: (ElementId | null)[]): ComputedResonance[] {
  const present = new Set(equipped.filter((id): id is ElementId => Boolean(id)));
  return RESONANCES.filter((resonance) => resonance.requires.every((id) => present.has(id))).map(
    (def) => ({ def, colorInt: hexToInt(def.color) }),
  );
}

/** Combined resonance effects, with multiplicative values multiplied together. */
export function aggregateResonanceEffects(resonances: ComputedResonance[]): ResonanceEffect[] {
  return resonances.flatMap((r) => r.def.effects);
}
