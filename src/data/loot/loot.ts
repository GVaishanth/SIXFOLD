import type { DropTable, LootDef, PickupDef } from '@/types';
import { hexToInt } from '@/utils/color';
import { weightedPick } from '@/utils/math';

/** Physical pickups that drop into the arena and can be walked into. */
export const PICKUP_REGISTRY: Record<string, PickupDef> = {
  health_small: {
    id: 'health_small',
    name: 'Health Orb',
    description: 'Restores 12 health.',
    kind: 'health',
    color: '#FF5C6C',
    colorInt: hexToInt('#FF5C6C'),
    value: 12,
  },
  health_large: {
    id: 'health_large',
    name: 'Greater Health Orb',
    description: 'Restores 32 health.',
    kind: 'health',
    color: '#FF2D44',
    colorInt: hexToInt('#FF2D44'),
    value: 32,
  },
  energy_small: {
    id: 'energy_small',
    name: 'Energy Orb',
    description: 'Restores 16 energy.',
    kind: 'energy',
    color: '#57C7FF',
    colorInt: hexToInt('#57C7FF'),
    value: 16,
  },
  energy_large: {
    id: 'energy_large',
    name: 'Greater Energy Orb',
    description: 'Restores 40 energy.',
    kind: 'energy',
    color: '#2F9BFF',
    colorInt: hexToInt('#2F9BFF'),
    value: 40,
  },
  essence_orb: {
    id: 'essence_orb',
    name: 'Essence',
    description: 'Raw elemental essence, used to focus your mastery.',
    kind: 'essence',
    color: '#F2C96B',
    colorInt: hexToInt('#F2C96B'),
    value: 1,
  },
  /**
   * Not loot, and never in a table. The strip's charts are placed on the corridor by the generator, and the
   * dungeon scene collects them itself — this entry exists so a chart is a pickup with a name in the one
   * registry rather than a private object kind the mode has to invent art for.
   */
  way_map: {
    id: 'way_map',
    name: 'Folded Chart',
    description: 'A keeper’s sketch of the circuits. Each one marks the way further in.',
    kind: 'shard',
    color: '#7FE0C0',
    colorInt: hexToInt('#7FE0C0'),
    value: 1,
  },
  essence_shard_big: {
    id: 'essence_shard_big',
    name: 'Essence Cluster',
    description: 'A dense cluster worth 5 essence.',
    kind: 'essence',
    color: '#FFE066',
    colorInt: hexToInt('#FFE066'),
    value: 5,
  },
  element_shard: {
    id: 'element_shard',
    name: 'Element Shard',
    description: 'A fragment of pure element. Gather six to focus-unlock a new element.',
    kind: 'shard',
    color: '#C87BFF',
    colorInt: hexToInt('#C87BFF'),
    value: 1,
  },
  relic_core: {
    id: 'relic_core',
    name: 'Relic Core',
    description: 'A crystallised core that permanently empowers your hero.',
    kind: 'relic',
    color: '#B39DF2',
    colorInt: hexToInt('#B39DF2'),
    value: 1,
  },
  run_buff_might: {
    id: 'run_buff_might',
    name: 'Might Ember',
    description: 'Temporary: +25% damage for 18 s.',
    kind: 'buff',
    color: '#F05A28',
    colorInt: hexToInt('#F05A28'),
    value: 1,
    buff: { id: 'might', name: 'Might', duration: 18, magnitude: 0.25, stat: 'damage' },
  },
  run_buff_haste: {
    id: 'run_buff_haste',
    name: 'Haste Spark',
    description: 'Temporary: +20% attack speed for 15 s.',
    kind: 'buff',
    color: '#FFE066',
    colorInt: hexToInt('#FFE066'),
    value: 1,
    buff: { id: 'haste', name: 'Haste', duration: 15, magnitude: 0.2, stat: 'attackSpeed' },
  },
  run_buff_vitality: {
    id: 'run_buff_vitality',
    name: 'Vital Seed',
    description: 'Temporary: +30 max health for 24 s.',
    kind: 'buff',
    color: '#6BE39A',
    colorInt: hexToInt('#6BE39A'),
    value: 1,
    buff: { id: 'vitality', name: 'Vitality', duration: 24, magnitude: 30, stat: 'maxHp' },
  },
};

export function getPickupDef(id: string): PickupDef | null {
  return PICKUP_REGISTRY[id] ?? null;
}

/** Long-form loot definitions used by boss and floor reward tables. */
export const LOOT_REGISTRY: Record<string, LootDef> = {
  essence_small: {
    id: 'essence_small',
    name: 'Essence Bundle',
    description: 'A small bundle of raw essence.',
    rarity: 'common',
    kind: 'essence',
    value: 8,
    color: '#F2C96B',
  },
  essence_medium: {
    id: 'essence_medium',
    name: 'Essence Cache',
    description: 'A dense cache of essence.',
    rarity: 'uncommon',
    kind: 'essence',
    value: 24,
    color: '#F2C96B',
  },
  essence_large: {
    id: 'essence_large',
    name: 'Essence Vault',
    description: 'A fortune in raw essence.',
    rarity: 'rare',
    kind: 'essence',
    value: 70,
    color: '#FFE066',
  },
  shard_one: {
    id: 'shard_one',
    name: 'Element Shard',
    description: 'One shard of pure element.',
    rarity: 'uncommon',
    kind: 'shard',
    value: 1,
    color: '#C87BFF',
  },
  shard_three: {
    id: 'shard_three',
    name: 'Shard Cluster',
    description: 'Three element shards fused together.',
    rarity: 'rare',
    kind: 'shard',
    value: 3,
    color: '#C87BFF',
  },
  relic_core_one: {
    id: 'relic_core_one',
    name: 'Relic Core',
    description: 'A core that permanently strengthens your hero.',
    rarity: 'epic',
    kind: 'relic',
    value: 1,
    color: '#B39DF2',
  },
  consumable_health: {
    id: 'consumable_health',
    name: 'Greater Health Orb',
    description: 'A dense orb of life.',
    rarity: 'common',
    kind: 'consumable',
    value: 1,
    color: '#FF2D44',
  },
  consumable_energy: {
    id: 'consumable_energy',
    name: 'Greater Energy Orb',
    description: 'A dense orb of energy.',
    rarity: 'common',
    kind: 'consumable',
    value: 1,
    color: '#2F9BFF',
  },
  buff_might: {
    id: 'buff_might',
    name: 'Might Ember',
    description: 'Temporary +25% damage for this run.',
    rarity: 'uncommon',
    kind: 'buff',
    value: 1,
    color: '#F05A28',
    temporary: true,
  },
  buff_haste: {
    id: 'buff_haste',
    name: 'Haste Spark',
    description: 'Temporary +20% attack speed for this run.',
    rarity: 'uncommon',
    kind: 'buff',
    value: 1,
    color: '#FFE066',
    temporary: true,
  },
  cosmetic_ember_crown: {
    id: 'cosmetic_ember_crown',
    name: 'Ember Crown',
    description: 'A rare cosmetic trail of embers.',
    rarity: 'legendary',
    kind: 'cosmetic',
    value: 1,
    color: '#FF7A3C',
    temporary: true,
  },
  cosmetic_frost_aura: {
    id: 'cosmetic_frost_aura',
    name: 'Frost Halo',
    description: 'A rare cosmetic frost halo.',
    rarity: 'legendary',
    kind: 'cosmetic',
    value: 1,
    color: '#BEEBFF',
    temporary: true,
  },
};

/** Weighted drop tables. Weights are deterministic and easy to retune. */
export const DROP_TABLES: Record<string, DropTable> = {
  trash_low: {
    id: 'trash_low',
    guaranteed: [{ id: 'essence_orb', weight: 1, min: 1, max: 2 }],
    entries: [
      { id: 'health_small', weight: 8, min: 1, max: 1, chance: 0.14 },
      { id: 'energy_small', weight: 10, min: 1, max: 1, chance: 0.18 },
      { id: 'essence_orb', weight: 16, min: 1, max: 1 },
      { id: 'element_shard', weight: 1, min: 1, max: 1, chance: 0.03 },
    ],
  },
  trash_mid: {
    id: 'trash_mid',
    guaranteed: [{ id: 'essence_orb', weight: 1, min: 1, max: 3 }],
    entries: [
      { id: 'health_small', weight: 9, min: 1, max: 1, chance: 0.16 },
      { id: 'energy_small', weight: 11, min: 1, max: 1, chance: 0.2 },
      { id: 'essence_orb', weight: 18, min: 1, max: 2 },
      { id: 'element_shard', weight: 2, min: 1, max: 1, chance: 0.05 },
    ],
  },
  trash_high: {
    id: 'trash_high',
    guaranteed: [{ id: 'essence_orb', weight: 1, min: 1, max: 4 }],
    entries: [
      { id: 'health_small', weight: 10, min: 1, max: 1, chance: 0.18 },
      { id: 'energy_small', weight: 12, min: 1, max: 1, chance: 0.22 },
      { id: 'health_large', weight: 3, min: 1, max: 1, chance: 0.05 },
      { id: 'essence_shard_big', weight: 6, min: 1, max: 1, chance: 0.1 },
      { id: 'element_shard', weight: 3, min: 1, max: 1, chance: 0.07 },
    ],
  },
  trash_core: {
    id: 'trash_core',
    guaranteed: [{ id: 'essence_orb', weight: 1, min: 2, max: 5 }],
    entries: [
      { id: 'health_large', weight: 8, min: 1, max: 1, chance: 0.12 },
      { id: 'energy_large', weight: 8, min: 1, max: 1, chance: 0.12 },
      { id: 'essence_shard_big', weight: 10, min: 1, max: 2, chance: 0.2 },
      { id: 'element_shard', weight: 4, min: 1, max: 1, chance: 0.1 },
    ],
  },
  /**
   * A dungeon cache: one guaranteed lane of currency plus a bonus roll, deliberately *not* generous.
   * The mode is self-contained (nothing is written to the wallet), so this table only has to make the
   * strip's in-run ledger move — see docs/plans/2026-10-11-dungeon-mode-design.md §3.
   */
  dungeon_cache: {
    id: 'dungeon_cache',
    guaranteed: [{ id: 'essence_orb', weight: 1, min: 2, max: 5 }],
    entries: [
      { id: 'health_small', weight: 9, min: 1, max: 1, chance: 0.3 },
      { id: 'energy_small', weight: 10, min: 1, max: 1, chance: 0.3 },
      { id: 'essence_shard_big', weight: 5, min: 1, max: 2, chance: 0.18 },
      { id: 'element_shard', weight: 3, min: 1, max: 1, chance: 0.12 },
      { id: 'run_buff_might', weight: 3, min: 1, max: 1, chance: 0.14 },
    ],
  },
  elite_drop: {
    id: 'elite_drop',
    guaranteed: [
      { id: 'essence_shard_big', weight: 1, min: 1, max: 2 },
      { id: 'element_shard', weight: 1, min: 1, max: 1, chance: 0.45 },
    ],
    entries: [
      { id: 'health_large', weight: 10, min: 1, max: 1, chance: 0.35 },
      { id: 'energy_large', weight: 10, min: 1, max: 1, chance: 0.35 },
      { id: 'relic_core', weight: 1, min: 1, max: 1, chance: 0.03 },
    ],
  },
  /**
   * Boss tables deliberately carry **no** currency in `guaranteed`: the scripted bounty in
   * `applyBossDefeat` (`boss.essence`, the shard/relic grant) is the payment for killing a
   * boss, and it is the number the HUD quotes and `spec.rewardMult` scales. These entries
   * used to pay essence, shards and a relic core *on top*, through the loot event, so every
   * boss kill credited the same currencies twice (docs/STATS_GAMEPLAY_FAULTS.md §B12). What
   * is left here is the bonus lane: the pile the vacuum sweeps after the bursts.
   */
  boss_minor: {
    id: 'boss_minor',
    guaranteed: [],
    entries: [
      { id: 'relic_core', weight: 5, min: 1, max: 1, chance: 0.22 },
      { id: 'health_large', weight: 10, min: 1, max: 2, chance: 0.6 },
      { id: 'energy_large', weight: 10, min: 1, max: 2, chance: 0.6 },
      { id: 'run_buff_might', weight: 4, min: 1, max: 1, chance: 0.25 },
      { id: 'run_buff_haste', weight: 4, min: 1, max: 1, chance: 0.25 },
    ],
  },
  boss_major: {
    id: 'boss_major',
    guaranteed: [],
    entries: [
      { id: 'health_large', weight: 12, min: 1, max: 3, chance: 0.8 },
      { id: 'energy_large', weight: 12, min: 1, max: 3, chance: 0.8 },
      /* The "sometimes a second core" line; the guaranteed one is the scripted grant. */
      { id: 'relic_core', weight: 6, min: 1, max: 2, chance: 0.35 },
      { id: 'run_buff_might', weight: 5, min: 1, max: 1, chance: 0.35 },
      { id: 'run_buff_haste', weight: 5, min: 1, max: 1, chance: 0.35 },
      { id: 'run_buff_vitality', weight: 5, min: 1, max: 1, chance: 0.35 },
      { id: 'cosmetic_ember_crown', weight: 1, min: 1, max: 1, chance: 0.06 },
      { id: 'cosmetic_frost_aura', weight: 1, min: 1, max: 1, chance: 0.06 },
    ],
  },
  floor_clear: {
    id: 'floor_clear',
    guaranteed: [
      { id: 'essence_shard_big', weight: 1, min: 3, max: 6 },
      { id: 'element_shard', weight: 1, min: 1, max: 2 },
    ],
    entries: [
      { id: 'relic_core', weight: 8, min: 1, max: 1, chance: 0.4 },
      { id: 'health_large', weight: 10, min: 1, max: 2, chance: 0.7 },
      { id: 'energy_large', weight: 10, min: 1, max: 2, chance: 0.7 },
    ],
  },
  ascension_cache: {
    id: 'ascension_cache',
    guaranteed: [
      { id: 'essence_shard_big', weight: 1, min: 5, max: 12 },
      { id: 'element_shard', weight: 1, min: 2, max: 5 },
    ],
    entries: [
      { id: 'relic_core', weight: 10, min: 1, max: 2, chance: 0.45 },
      { id: 'cosmetic_ember_crown', weight: 1, min: 1, max: 1, chance: 0.08 },
      { id: 'cosmetic_frost_aura', weight: 1, min: 1, max: 1, chance: 0.08 },
    ],
  },
  free_mode_boss: {
    id: 'free_mode_boss',
    guaranteed: [
      { id: 'essence_shard_big', weight: 1, min: 2, max: 5 },
      { id: 'element_shard', weight: 1, min: 1, max: 2 },
    ],
    entries: [
      { id: 'relic_core', weight: 4, min: 1, max: 1, chance: 0.2 },
      { id: 'run_buff_might', weight: 5, min: 1, max: 1, chance: 0.3 },
      { id: 'run_buff_haste', weight: 5, min: 1, max: 1, chance: 0.3 },
    ],
  },
};

export function getDropTable(id: string): DropTable | null {
  return DROP_TABLES[id] ?? null;
}

/**
 * The rules of a roll, with no scene in sight.
 *
 * This used to live inside `GameplayScene.rollDropTable`, which meant the only way to exercise a drop
 * table was to run the game — the reason §B11 (a relic table keyed to a pickup id nothing dropped) and
 * §B12 (boss tables paying twice) both needed a 200-wave play-through to find. The shape is exactly the
 * old one: every `guaranteed` entry rolls on its own, then a single weighted entry from `entries`, each
 * gated by `chance × bonus`, counts inclusive of both bounds.
 */
export function rollTable(
  table: DropTable,
  rng: () => number,
  bonus = 1,
): { id: string; count: number }[] {
  const out: { id: string; count: number }[] = [];
  const between = (min: number, max: number) => min + Math.floor(rng() * (max - min + 1));
  for (const entry of table.guaranteed ?? []) {
    const chance = entry.chance ?? 1;
    if (chance < 1 && rng() > chance * bonus) continue;
    out.push({ id: entry.id, count: between(entry.min, entry.max) });
  }
  const picked = weightedPick(table.entries, rng);
  if (picked) {
    const chance = picked.chance ?? 1;
    if (!(chance < 1 && rng() > chance * bonus)) {
      out.push({ id: picked.id, count: between(picked.min, picked.max) });
    }
  }
  return out;
}
