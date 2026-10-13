import type { EnemyArchetype, SpawnGroup } from '@/types';

/**
 * Composition templates used by the wave generator.
 *
 * A template describes the *shape* of a wave (how many groups, which
 * archetypes and how they are staggered) and the generator layers difficulty,
 * floor modifiers and Ascension scaling on top. This keeps 200+ waves varied
 * without hand-authoring each one.
 */

export interface WaveTemplate {
  id: string;
  /** Local wave range (1..200) this template covers. */
  from: number;
  to: number;
  /** Groups expressed as (archetype, share, interval, delay). */
  groups: {
    archetype: EnemyArchetype;
    share: number;
    interval: number;
    delay: number;
    /** Force a specific enemy definition (used for signature enemies). */
    forceDefId?: string;
  }[];
  eliteShare: number;
  /** Extra enemies added on top of the difficulty curve. */
  bonusCount: number;
  /** Wave label flavour shown in the banner. */
  tag: string;
}

export const WAVE_TEMPLATES: WaveTemplate[] = [
  {
    id: 'first_steps',
    from: 1,
    to: 2,
    groups: [{ archetype: 'chaser', share: 1, interval: 0.9, delay: 0 }],
    eliteShare: 0,
    bonusCount: -2,
    tag: 'First Contact',
  },
  {
    id: 'swarm',
    from: 1,
    to: 6,
    groups: [
      { archetype: 'chaser', share: 0.75, interval: 0.75, delay: 0 },
      { archetype: 'charger', share: 0.25, interval: 1.1, delay: 1.6 },
    ],
    eliteShare: 0,
    bonusCount: 0,
    tag: 'Swarm',
  },
  {
    id: 'shooters',
    from: 5,
    to: 9,
    groups: [
      { archetype: 'chaser', share: 0.6, interval: 0.8, delay: 0 },
      { archetype: 'caster', share: 0.4, interval: 1.4, delay: 1.2 },
    ],
    eliteShare: 0,
    bonusCount: 1,
    tag: 'Ranged Contact',
  },
  {
    id: 'mixed_pressure',
    from: 8,
    to: 14,
    groups: [
      { archetype: 'chaser', share: 0.5, interval: 0.7, delay: 0 },
      { archetype: 'caster', share: 0.3, interval: 1.3, delay: 1 },
      { archetype: 'tank', share: 0.2, interval: 2.2, delay: 2.4 },
    ],
    eliteShare: 0.05,
    bonusCount: 2,
    tag: 'Pressure',
  },
  {
    id: 'elite_vanguard',
    from: 12,
    to: 18,
    groups: [
      { archetype: 'chaser', share: 0.4, interval: 0.65, delay: 0 },
      { archetype: 'assassin', share: 0.3, interval: 1.2, delay: 1.4 },
      { archetype: 'caster', share: 0.3, interval: 1.4, delay: 0.6 },
    ],
    eliteShare: 0.09,
    bonusCount: 2,
    tag: 'Elite Vanguard',
  },
  {
    id: 'shield_wall',
    from: 16,
    to: 26,
    groups: [
      { archetype: 'shielded', share: 0.3, interval: 2, delay: 0.8 },
      { archetype: 'tank', share: 0.3, interval: 2.2, delay: 0 },
      { archetype: 'caster', share: 0.4, interval: 1.3, delay: 1.8 },
    ],
    eliteShare: 0.1,
    bonusCount: 3,
    tag: 'Shield Wall',
  },
  {
    id: 'split_swarm',
    from: 24,
    to: 38,
    groups: [
      { archetype: 'splitter', share: 0.4, interval: 1.6, delay: 0.4 },
      { archetype: 'chaser', share: 0.35, interval: 0.7, delay: 0 },
      { archetype: 'charger', share: 0.25, interval: 1.5, delay: 2 },
    ],
    eliteShare: 0.11,
    bonusCount: 3,
    tag: 'Splitting Horde',
  },
  {
    id: 'summoner_host',
    from: 34,
    to: 50,
    groups: [
      { archetype: 'summoner', share: 0.25, interval: 2.6, delay: 1.2 },
      { archetype: 'chaser', share: 0.4, interval: 0.7, delay: 0 },
      { archetype: 'caster', share: 0.35, interval: 1.3, delay: 2 },
    ],
    eliteShare: 0.12,
    bonusCount: 4,
    tag: 'Summoner Host',
  },
  {
    id: 'assassin_rush',
    from: 44,
    to: 62,
    groups: [
      { archetype: 'assassin', share: 0.4, interval: 1.1, delay: 0.6 },
      { archetype: 'charger', share: 0.3, interval: 1.4, delay: 1.8 },
      { archetype: 'chaser', share: 0.3, interval: 0.65, delay: 0 },
    ],
    eliteShare: 0.13,
    bonusCount: 4,
    tag: 'Assassin Rush',
  },
  {
    id: 'heavy_line',
    from: 56,
    to: 76,
    groups: [
      { archetype: 'tank', share: 0.35, interval: 2.1, delay: 0 },
      { archetype: 'shielded', share: 0.35, interval: 2, delay: 1.2 },
      { archetype: 'caster', share: 0.3, interval: 1.4, delay: 2.4 },
    ],
    eliteShare: 0.15,
    bonusCount: 4,
    tag: 'Heavy Line',
  },
  {
    id: 'combined_arms',
    from: 70,
    to: 96,
    groups: [
      { archetype: 'chaser', share: 0.3, interval: 0.6, delay: 0 },
      { archetype: 'caster', share: 0.25, interval: 1.3, delay: 1 },
      { archetype: 'tank', share: 0.2, interval: 2, delay: 2 },
      { archetype: 'assassin', share: 0.25, interval: 1.1, delay: 1.4 },
    ],
    eliteShare: 0.16,
    bonusCount: 5,
    tag: 'Combined Arms',
  },
  {
    id: 'core_defense',
    from: 90,
    to: 120,
    groups: [
      { archetype: 'shielded', share: 0.25, interval: 2, delay: 0.6 },
      { archetype: 'summoner', share: 0.2, interval: 2.6, delay: 2 },
      { archetype: 'splitter', share: 0.25, interval: 1.5, delay: 1.2 },
      { archetype: 'caster', share: 0.3, interval: 1.3, delay: 0 },
    ],
    eliteShare: 0.18,
    bonusCount: 5,
    tag: 'Core Defence',
  },
  {
    id: 'onslaught',
    from: 110,
    to: 150,
    groups: [
      { archetype: 'assassin', share: 0.3, interval: 1, delay: 0.4 },
      { archetype: 'charger', share: 0.25, interval: 1.2, delay: 1.6 },
      { archetype: 'tank', share: 0.2, interval: 1.9, delay: 0 },
      { archetype: 'caster', share: 0.25, interval: 1.2, delay: 2.2 },
    ],
    eliteShare: 0.2,
    bonusCount: 6,
    tag: 'Onslaught',
  },
  {
    id: 'elemental_siege',
    from: 140,
    to: 175,
    groups: [
      { archetype: 'summoner', share: 0.2, interval: 2.4, delay: 1 },
      { archetype: 'shielded', share: 0.25, interval: 1.8, delay: 0 },
      { archetype: 'assassin', share: 0.25, interval: 1, delay: 1.8 },
      { archetype: 'splitter', share: 0.3, interval: 1.4, delay: 2.4 },
    ],
    eliteShare: 0.22,
    bonusCount: 6,
    tag: 'Elemental Siege',
  },
  {
    id: 'annihilation',
    from: 170,
    to: 200,
    groups: [
      { archetype: 'chaser', share: 0.25, interval: 0.55, delay: 0 },
      { archetype: 'assassin', share: 0.25, interval: 1, delay: 1.2 },
      { archetype: 'tank', share: 0.2, interval: 1.8, delay: 0.6 },
      { archetype: 'caster', share: 0.15, interval: 1.2, delay: 2 },
      { archetype: 'shielded', share: 0.15, interval: 1.9, delay: 2.6 },
    ],
    eliteShare: 0.25,
    bonusCount: 7,
    tag: 'Annihilation',
  },
];

export function templateForLocalWave(localWave: number): WaveTemplate {
  const candidates = WAVE_TEMPLATES.filter((t) => localWave >= t.from && localWave <= t.to);
  if (candidates.length === 0) {
    // Ascension uses localWave 1..200 so this only guards malformed input.
    return WAVE_TEMPLATES[WAVE_TEMPLATES.length - 1];
  }
  // Prefer the most specific (narrowest) matching template for flavour.
  return candidates.reduce((best, t) =>
    t.to - t.from < best.to - best.from ? t : best,
  );
}

/** Convert a template + budget into concrete spawn groups. */
export function templateToGroups(
  template: WaveTemplate,
  total: number,
  eliteChance: number,
  affixes: SpawnGroup['affixes'],
): SpawnGroup[] {
  return template.groups.map((group) => {
    const count = Math.max(1, Math.round(total * group.share));
    return {
      defId: group.forceDefId ?? '',
      count,
      interval: group.interval,
      delay: group.delay,
      eliteChance: Math.min(0.85, eliteChance + template.eliteShare),
      affixes: affixes ? [...affixes] : undefined,
    };
  });
}
