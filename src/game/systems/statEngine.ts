import { COMBAT_CONFIG, MASTERY, PLAYER_CONFIG, PROGRESSION } from '@/config/gameConfig';
import { ELEMENT_REGISTRY, computeResonances } from '@/data/elements';
import { masteryBonuses } from '@/game/systems/elementProgression';
import type { ElementId, SaveData } from '@/types';

/** Ceiling on a single shield trigger, so stacked sources cannot mint a second health bar. */
const MAX_SHIELD_TRIGGER = 40;

/**
 * Stat engine.
 *
 * One place converts persistent progression (relics, mastery, loadout,
 * resonance) into the concrete numbers combat uses. Enemies, the HUD and the
 * loadout screen all read the same derived values, so the interface can never
 * disagree with the simulation.
 */

export interface PlayerStats {
  maxHp: number;
  maxEnergy: number;
  attack: number;
  defense: number;
  speed: number;
  critChance: number;
  critDamage: number;
  cooldownReduction: number;
  energyRegen: number;
  lifesteal: number;
  evasion: number;
  regen: number;
  thorns: number;
  pickupRadius: number;
  damageMult: number;
  attackSpeedMult: number;
  statusDurationMult: number;
  /** Shield granted when a wave is cleared (resonances). */
  shieldOnWave: number;
  /** Shield granted on a manual element switch (element passives). */
  shieldOnSwitch: number;
  /** Per-element mastery multipliers for the equipped loadout. */
  masteryDamage: Partial<Record<ElementId, number>>;
  masteryCooldown: Partial<Record<ElementId, number>>;
  masteryStatus: Partial<Record<ElementId, number>>;
  masteryUltimateCost: Partial<Record<ElementId, number>>;
  resonances: { id: string; name: string; color: string }[];
}

export interface RunBuff {
  id: string;
  name: string;
  magnitude: number;
  stat: string;
}

/**
 * The run buffs that are still in effect, normalised for the stat engine.
 *
 * `now` is the scene clock in ms (the same clock `expiresAt` was written against).
 * Screens have no scene clock: pass `null` and the countdown the scene maintains
 * (`remaining`, refreshed once a second) decides instead. Both paths reject entries
 * without a positive expiry, which is what let a buff outlive its run and its save.
 */
export function liveRunBuffs(
  data: { runBuffs?: { id: string; name: string; remaining: number; expiresAt: number; magnitude: number; stat: string }[] } | null,
  now: number | null,
): RunBuff[] {
  if (!data?.runBuffs) return [];
  return data.runBuffs
    .filter((buff) => Boolean(buff.stat) && buff.expiresAt > 0)
    .filter((buff) => (now === null ? buff.remaining > 0 : buff.expiresAt > now))
    .map((buff) => ({ id: buff.id, name: buff.name, magnitude: buff.magnitude, stat: buff.stat }));
}

/**
 * Relic bonuses, keyed by the id of the *pickup* that grants them.
 *
 * The table used to be keyed `relic_core_one`, while every drop table spawns the
 * pickup `relic_core` — so the loop below looked the id up, found nothing, and every
 * relic the game ever handed out granted exactly nothing. The two named entries are
 * reserved for boss relics that no table drops yet; they stay listed so the ids are
 * ready when a source exists (docs §B11).
 */
const RELIC_BONUSES: Record<string, { hp?: number; attack?: number; defense?: number; crit?: number; cd?: number }> = {
  relic_core: { hp: 8, attack: 1.5, defense: 1 },
  ember_crown: { attack: 3, crit: 0.02 },
  frost_halo: { defense: 3, hp: 12 },
};

export function computePlayerStats(
  data: SaveData | null,
  activeElement: ElementId | null,
  runBuffs: RunBuff[] = [],
): PlayerStats {
  const progression = data?.progression;
  const loadoutSlots = data?.loadout.slots ?? [activeElement];

  const stats: PlayerStats = {
    maxHp: PLAYER_CONFIG.baseHp + (progression?.bonusHp ?? 0),
    maxEnergy: PLAYER_CONFIG.baseEnergy + (progression?.bonusEnergy ?? 0),
    attack: PLAYER_CONFIG.baseAttack + (progression?.bonusAttack ?? 0),
    defense: PLAYER_CONFIG.baseDefense + (progression?.bonusDefense ?? 0),
    speed: PLAYER_CONFIG.baseSpeed * (1 + (progression?.bonusMoveSpeed ?? 0)),
    critChance: PLAYER_CONFIG.critChance + (progression?.bonusCrit ?? 0),
    critDamage: PLAYER_CONFIG.critDamage,
    cooldownReduction: progression?.bonusCooldownReduction ?? 0,
    energyRegen: PLAYER_CONFIG.energyRegenPerSecond,
    lifesteal: 0,
    evasion: 0,
    regen: PLAYER_CONFIG.regenPerSecond,
    thorns: 0,
    pickupRadius: PLAYER_CONFIG.pickupRadius,
    damageMult: 1,
    attackSpeedMult: 1,
    statusDurationMult: 1,
    shieldOnWave: 0,
    shieldOnSwitch: 0,
    masteryDamage: {},
    masteryCooldown: {},
    masteryStatus: {},
    masteryUltimateCost: {},
    resonances: [],
  };

  /* Relic cores: the count is the currency, so it buys a small, capped edge. A full
     story run turns up ~13 (measured from the real tables), i.e. about +5 % damage —
     deliberately modest, because `progression.relics` is a *set* and cannot stack the
     one-time relic bonus above. */
  const cores = Math.min(PROGRESSION.relicCoreCap, progression?.relicCores ?? 0);
  if (cores > 0) {
    const steps = Math.floor(cores / PROGRESSION.relicCoreStep);
    stats.damageMult *= 1 + steps * PROGRESSION.relicCoreDamageMult;
  }

  // Relic bonuses.
  for (const relicId of progression?.relics ?? []) {
    const relic = RELIC_BONUSES[relicId];
    if (!relic) continue;
    stats.maxHp += relic.hp ?? 0;
    stats.attack += relic.attack ?? 0;
    stats.defense += relic.defense ?? 0;
    stats.critChance += relic.crit ?? 0;
    stats.cooldownReduction += relic.cd ?? 0;
  }

  // Element passives from the whole loadout (not only the active slot), so
  // building a loadout has consequences beyond the element you are holding.
  const uniqueElements = new Set(loadoutSlots.filter((id): id is ElementId => Boolean(id)));
  if (activeElement) uniqueElements.add(activeElement);

  for (const id of uniqueElements) {
    const def = ELEMENT_REGISTRY[id];
    if (!def) continue;
    const passives = [def.passive, ...(def.extraPassives ?? [])];
    for (const passive of passives) {
      const weight = id === activeElement ? 1 : 0.5;
      switch (passive.kind) {
        case 'damageAmp':
          if (id === activeElement) stats.damageMult += passive.value;
          break;
        case 'critChance':
          stats.critChance += passive.value * weight;
          break;
        case 'critDamage':
          stats.critDamage += passive.value * weight;
          break;
        case 'moveSpeed':
          if (id === activeElement) stats.speed *= 1 + passive.value;
          else stats.speed *= 1 + passive.value * 0.5;
          break;
        case 'cooldownReduction':
          stats.cooldownReduction += passive.value * weight;
          break;
        case 'lifesteal':
          stats.lifesteal += passive.value * weight;
          break;
        case 'evasion':
          stats.evasion += passive.value * weight;
          break;
        case 'regen':
          stats.regen += passive.value * weight;
          break;
        case 'thorns':
          stats.thorns += passive.value * weight;
          break;
        case 'statusAmp':
          stats.statusDurationMult += passive.value * weight;
          break;
        case 'pickupRadius':
          stats.pickupRadius += passive.value * weight;
          break;
        case 'armor':
          stats.defense += passive.value * weight;
          break;
        case 'attackSpeed':
          stats.attackSpeedMult += passive.value * weight;
          break;
        case 'energyRegen':
          stats.energyRegen += passive.value * weight;
          break;
        case 'shieldOnSwitch':
          stats.shieldOnSwitch += passive.value * weight;
          break;
        default:
          break;
      }
    }
  }

  // Resonance.
  const resonances = computeResonances(loadoutSlots);
  stats.resonances = resonances.map((entry) => ({
    id: entry.def.id,
    name: entry.def.name,
    color: entry.def.color,
  }));
  for (const resonance of resonances) {
    for (const effect of resonance.def.effects) {
      switch (effect.kind) {
        case 'damageMult':
          stats.damageMult *= effect.value;
          break;
        case 'critAdd':
          stats.critChance += effect.value;
          break;
        case 'cooldownMult':
          stats.cooldownReduction = 1 - (1 - stats.cooldownReduction) * effect.value;
          break;
        case 'statusDurationMult':
          stats.statusDurationMult *= effect.value;
          break;
        case 'armorAdd':
          stats.defense += effect.value;
          break;
        case 'moveSpeedAdd':
          stats.speed *= 1 + effect.value;
          break;
        case 'energyRegenAdd':
          stats.energyRegen += effect.value;
          break;
        case 'lifestealAdd':
          stats.lifesteal += effect.value;
          break;
        case 'attackSpeedMult':
          stats.attackSpeedMult *= effect.value;
          break;
        case 'shieldOnWave':
          stats.shieldOnWave = Math.min(MAX_SHIELD_TRIGGER, stats.shieldOnWave + effect.value);
          break;
        default:
          break;
      }
    }
  }

  // Run buffs (temporary pickups).
  for (const buff of runBuffs) {
    switch (buff.stat) {
      case 'damage':
        stats.damageMult *= 1 + buff.magnitude;
        break;
      case 'attackSpeed':
        stats.attackSpeedMult *= 1 + buff.magnitude;
        break;
      case 'maxHp':
        stats.maxHp += buff.magnitude;
        break;
      default:
        break;
    }
  }

  // Mastery per element in the loadout.
  if (data) {
    for (const id of uniqueElements) {
      const xp = data.mastery[id]?.xp ?? 0;
      const bonuses = masteryBonuses(id, xp);
      stats.masteryDamage[id] = bonuses.damageMult;
      stats.masteryCooldown[id] = bonuses.cooldownMult;
      stats.masteryStatus[id] = bonuses.statusDurationMult;
      // The active element's mastery buys status uptime for real: folded into the
      // single multiplier the enemy tracker actually consumes (docs §B5).
      if (id === activeElement) {
        stats.statusDurationMult = Math.min(
          COMBAT_CONFIG.statusDurationCap,
          stats.statusDurationMult * bonuses.statusDurationMult,
        );
      }
      stats.masteryUltimateCost[id] = bonuses.ultimateCostMult;
    }
  }

  stats.critChance = Math.min(0.75, stats.critChance);
  stats.cooldownReduction = Math.min(0.6, Math.max(0, stats.cooldownReduction));
  stats.evasion = Math.min(0.5, stats.evasion);
  return stats;
}

/** Effective attack cooldown for an element with all modifiers applied. */
export function effectiveCooldown(
  base: number,
  stats: PlayerStats,
  element: ElementId | null,
  kind: 'attack' | 'skill' | 'ultimate',
): number {
  const masteryMult = element && kind !== 'attack' ? (stats.masteryCooldown[element] ?? 1) : 1;
  const reduction = 1 - stats.cooldownReduction;
  const speed = kind === 'attack' ? 1 / stats.attackSpeedMult : 1;
  return Math.max(0.08, base * reduction * masteryMult * speed);
}

/** Damage multiplier for an element (mastery + run buffs + resonance). */
export function elementDamageMultiplier(stats: PlayerStats, element: ElementId | null): number {
  const mastery = element ? (stats.masteryDamage[element] ?? 1) : 1;
  return stats.damageMult * mastery;
}

/** Effective energy cost, honouring mastery ultimate efficiency. */
export function effectiveCost(
  base: number,
  stats: PlayerStats,
  element: ElementId | null,
  kind: 'attack' | 'skill' | 'ultimate',
): number {
  if (kind === 'attack') return base;
  const mastery = element ? (stats.masteryUltimateCost[element] ?? 1) : 1;
  // Only ultimates benefit from mastery energy efficiency.
  return kind === 'ultimate' ? base * mastery : base;
}

export const MASTERY_RULES = MASTERY;
