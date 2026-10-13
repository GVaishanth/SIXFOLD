import { DIFFICULTY, WAVE_CONFIG } from '@/config/gameConfig';
import { getBoss } from '@/data/bosses';
import { ENEMY_REGISTRY } from '@/data/enemies';
import { FLOOR_REGISTRY, STORY_WAVES, WAVES_PER_FLOOR, floorForWave } from '@/data/floors';
import { templateForLocalWave } from '@/data/waves/wavePatterns';
import type { EnemyAffixId, EnemyArchetype, GameMode, SpawnGroup, WaveSpec } from '@/types';
import { clamp, lerp } from '@/utils/math';

/**
 * Floor rosters: which concrete enemy definition fulfils each archetype on a
 * given floor. Keeping this explicit means a floor always feels like itself
 * while the wave generator stays generic.
 */
export const FLOOR_ROSTERS: Record<number, Partial<Record<EnemyArchetype, string[]>>> = {
  1: {
    chaser: ['cinder_chaser'],
    charger: ['ash_hound'],
    caster: ['ember_caster'],
    assassin: ['cinder_chaser'],
  },
  2: {
    chaser: ['tide_lurker'],
    tank: ['deep_maw'],
    caster: ['ember_caster'],
    charger: ['ash_hound'],
    assassin: ['tide_lurker'],
    shielded: ['shard_sentinel'],
  },
  3: {
    chaser: ['tide_lurker'],
    tank: ['deep_maw'],
    caster: ['galewisp'],
    assassin: ['sky_stalker'],
    charger: ['ash_hound'],
    shielded: ['shard_sentinel'],
  },
  4: {
    chaser: ['cinder_chaser'],
    tank: ['thorn_brute'],
    splitter: ['bloom_splitter'],
    caster: ['ember_caster'],
    assassin: ['sky_stalker'],
    summoner: ['forge_summoner'],
  },
  5: {
    shielded: ['shard_sentinel'],
    tank: ['thorn_brute'],
    summoner: ['forge_summoner'],
    caster: ['galewisp'],
    chaser: ['tide_lurker'],
    assassin: ['sky_stalker'],
  },
  6: {
    assassin: ['voltaic_hunter'],
    caster: ['arc_caster'],
    tank: ['slag_tank'],
    chaser: ['sky_stalker'],
    charger: ['ash_hound'],
    shielded: ['shard_sentinel'],
    splitter: ['bloom_splitter'],
  },
  7: {
    assassin: ['cinder_shade'],
    tank: ['slag_tank'],
    caster: ['arc_caster'],
    summoner: ['forge_summoner'],
    splitter: ['spore_splitter'],
    chaser: ['cinder_chaser'],
    shielded: ['shard_sentinel'],
  },
  8: {
    chaser: ['rime_stalker'],
    tank: ['glacier_tank'],
    shielded: ['glacier_tank'],
    caster: ['arc_caster'],
    assassin: ['cinder_shade'],
    summoner: ['forge_summoner'],
    splitter: ['bloom_splitter'],
  },
  9: {
    splitter: ['spore_splitter'],
    caster: ['blight_caster'],
    assassin: ['cinder_shade'],
    tank: ['thorn_brute'],
    chaser: ['rime_stalker'],
    summoner: ['aether_summoner'],
    shielded: ['glacier_tank'],
  },
  10: {
    shielded: ['core_sentinel'],
    summoner: ['aether_summoner'],
    caster: ['blight_caster'],
    assassin: ['voltaic_hunter'],
    tank: ['slag_tank'],
    chaser: ['rime_stalker'],
    splitter: ['spore_splitter'],
  },
};

export interface WaveGenerationOptions {
  wave: number;
  mode: GameMode;
  /** Free Mode overrides. */
  floorOverride?: number;
  difficultyScale?: number;
}

export function localWaveOf(wave: number): { localWave: number; cycle: number } {
  const safe = Math.max(1, Math.floor(wave));
  return {
    localWave: ((safe - 1) % STORY_WAVES) + 1,
    cycle: Math.floor((safe - 1) / STORY_WAVES),
  };
}

/**
 * Which enemy definition stands in for an archetype on a given floor.
 *
 * Exported because DungeonMode spawns from the same rosters: a strip's grove has to wake the things
 * that actually live in that biome, not a second list that can drift from the first.
 */
export function pickDef(floor: number, archetype: EnemyArchetype, variantSeed: number): string {
  const roster = FLOOR_ROSTERS[floor] ?? FLOOR_ROSTERS[1];
  const pool = roster[archetype];
  if (pool && pool.length > 0) return pool[variantSeed % pool.length];
  // Fall back to the nearest lower floor that supports the archetype.
  for (let f = floor - 1; f >= 1; f -= 1) {
    const fallback = FLOOR_ROSTERS[f]?.[archetype];
    if (fallback && fallback.length > 0) return fallback[variantSeed % fallback.length];
  }
  return 'cinder_chaser';
}

/** Enemy count for a regular wave, kept inside sane performance bounds. */
/**
 * 0 on wave 1 of a run, 1 once the opening has played out. Everything the grace
 * period touches reads this one number, so there is a single place to argue with
 * when the first minutes feel wrong.
 */
export function openingEase(runWave: number): number {
  return clamp((runWave - DIFFICULTY.openWaves) / Math.max(1, DIFFICULTY.openTaperWaves), 0, 1);
}

/** The run wave a (floor, localWave) pair belongs to. */
export function runWaveOf(floor: number, localWave: number): number {
  return (Math.max(1, floor) - 1) * WAVES_PER_FLOOR + localWave;
}

/**
 * Per-hit damage ceiling for the opening waves. A warden that can take 14% of
 * your health per touch on wave 2 is not a threat, it is a coin flip.
 */
export function openingDamageCapFraction(runWave: number): number {
  return lerp(DIFFICULTY.openDamageCapFraction, DIFFICULTY.enemyDamageCapFraction, openingEase(runWave));
}

export function enemyCountForWave(localWave: number, bonus: number, runWave = localWave): number {
  const curve = DIFFICULTY.countBase + localWave * DIFFICULTY.countGrowth;
  const eased = curve * lerp(DIFFICULTY.openCount, 1, openingEase(runWave));
  return clamp(Math.round(eased + bonus), WAVE_CONFIG.minEnemies, WAVE_CONFIG.maxEnemiesPerWave);
}

export interface WaveScaling {
  hpMult: number;
  damageMult: number;
  speedMult: number;
  eliteChance: number;
  affixChance: number;
  hazardIntensity: number;
  rewardMult: number;
  affixes: EnemyAffixId[];
}

/**
 * Difficulty curve.
 *
 * Growth is exponential-with-a-linear-tail rather than a flat +1 HP per wave,
 * so early waves teach, the mid game pressures and the late game demands a
 * considered loadout. Ascension cycles multiply on top of the story curve and
 * additionally mutate enemies with affixes instead of only inflating health.
 */
export function scalingFor(localWave: number, cycle: number, floor: number): WaveScaling {
  const floorDef = FLOOR_REGISTRY[floor] ?? FLOOR_REGISTRY[1];
  const waveIndex = Math.max(0, localWave - 1);
  const runWave = runWaveOf(floor, localWave);
  const ease = openingEase(runWave);

  // Both curves saturate: the exponential factor is clamped, the linear factor
  // never is. See DIFFICULTY for the reasoning.
  const hpExponential = Math.min(Math.pow(DIFFICULTY.hpGrowth, waveIndex), DIFFICULTY.hpGrowthCap);
  const damageExponential = Math.min(
    Math.pow(DIFFICULTY.damageGrowth, waveIndex),
    DIFFICULTY.damageGrowthCap,
  );
  const storyHp = DIFFICULTY.baseHpMult * hpExponential * (1 + DIFFICULTY.hpLinear * waveIndex);
  const storyDamage = damageExponential * (1 + DIFFICULTY.damageLinear * waveIndex);
  const storySpeed = Math.min(
    DIFFICULTY.speedCap,
    Math.pow(DIFFICULTY.speedGrowth, waveIndex) * floorDef.modifiers.speedMult,
  );

  const cycleHp =
    Math.pow(DIFFICULTY.cycleHpMult, Math.min(cycle, DIFFICULTY.cycleHealthCap)) *
    (1 + DIFFICULTY.cycleHealthLinear * Math.max(0, cycle - DIFFICULTY.cycleHealthCap));
  const cycleDamage =
    Math.pow(DIFFICULTY.cycleDamageMult, Math.min(cycle, DIFFICULTY.cycleHealthCap)) *
    (1 + 0.2 * Math.max(0, cycle - DIFFICULTY.cycleHealthCap));
  const cycleSpeed = Math.pow(DIFFICULTY.cycleSpeedMult, cycle);

  const eliteChance =
    runWave < DIFFICULTY.eliteFromWave && cycle === 0
      ? 0
      : clamp(
          DIFFICULTY.eliteChanceBase +
            waveIndex * DIFFICULTY.eliteChanceGrowth +
            floorDef.modifiers.eliteBonus +
            cycle * DIFFICULTY.cycleEliteBonus,
          0,
          DIFFICULTY.eliteChanceCap,
        );

  const affixChance = clamp(cycle * DIFFICULTY.cycleAffixChance, 0, DIFFICULTY.cycleAffixChanceCap);

  const affixes: EnemyAffixId[] = [];
  if (cycle >= 1) affixes.push(...floorDef.affixPool.slice(0, 1));
  if (cycle >= 2) affixes.push(...floorDef.affixPool.slice(1, 2));
  if (cycle >= 4) affixes.push('giant');
  if (cycle >= 6) affixes.push('eliteBlessed');

  return {
    hpMult: floorDef.modifiers.hpMult * storyHp * cycleHp * lerp(DIFFICULTY.openHp, 1, ease),
    damageMult:
      floorDef.modifiers.damageMult *
      Math.pow(storyDamage * cycleDamage, DIFFICULTY.damageSofteningExponent) *
      lerp(DIFFICULTY.openDamage, 1, ease),
    speedMult: clamp(
      storySpeed * cycleSpeed * lerp(DIFFICULTY.openSpeed, 1, ease),
      0.5,
      DIFFICULTY.speedCap * 1.35,
    ),
    eliteChance,
    affixChance,
    hazardIntensity:
      floorDef.hazard.intensity * (1 + cycle * 0.18) * lerp(DIFFICULTY.openHazard, 1, ease),
    rewardMult: 1 + localWave * 0.012 + cycle * 0.65,
    affixes,
  };
}

/** Build a full, deterministic wave specification. */
export function generateWave(options: WaveGenerationOptions): WaveSpec {
  const { wave, mode } = options;
  const { localWave, cycle } = localWaveOf(wave);
  const floor =
    mode === 'free' && options.floorOverride ? options.floorOverride : floorForWave(localWave);

  const floorDef = FLOOR_REGISTRY[floor] ?? FLOOR_REGISTRY[1];
  const scaling = scalingFor(localWave, mode === 'free' ? 0 : cycle, floor);
  const difficultyScale = options.difficultyScale ?? 1;

  const isMajorBoss = localWave % WAVES_PER_FLOOR === 0;
  const isMiniBoss = !isMajorBoss && localWave % 10 === 0;
  const bossDef = isMajorBoss
    ? getBoss(floorDef.majorBossId)
    : isMiniBoss
      ? getBoss(floorDef.miniBossId)
      : null;

  const template = templateForLocalWave(localWave);

  if (bossDef) {
    const groups: SpawnGroup[] = [
      {
        defId: bossDef.id,
        count: 1,
        interval: 0,
        delay: WAVE_CONFIG.bossIntroDelay,
        eliteChance: 0,
        affixes: scaling.affixes,
      },
    ];
    if (bossDef.minionDefId && localWave >= 20) {
      groups.push({
        defId: bossDef.minionDefId,
        count: isMajorBoss ? 4 + Math.min(8, cycle * 2) : 2,
        interval: 1.6,
        delay: WAVE_CONFIG.bossIntroDelay + 5,
        eliteChance: scaling.eliteChance * 0.8,
        affixes: scaling.affixes,
      });
    }
    return {
      wave,
      floor,
      localWave,
      cycle,
      isMiniBoss,
      isMajorBoss,
      bossId: bossDef.id,
      groups,
      hpMult: scaling.hpMult * difficultyScale,
      damageMult: scaling.damageMult * Math.sqrt(difficultyScale),
      speedMult: scaling.speedMult,
      eliteChance: 0,
      affixChance: scaling.affixChance,
      total: isMajorBoss ? 1 + (bossDef.minionDefId ? 4 + Math.min(8, cycle * 2) : 0) : 1,
      rewardMult: scaling.rewardMult * (isMajorBoss ? 3.2 : 2),
      hazardIntensity: scaling.hazardIntensity,
      label: bossDef.name,
      affixes: scaling.affixes,
    };
  }

  const total = Math.max(
    WAVE_CONFIG.minEnemies,
    enemyCountForWave(localWave, template.bonusCount, runWaveOf(floor, localWave)),
  );

  const groups: SpawnGroup[] = template.groups.map((group, index) => {
    const count = Math.max(1, Math.round(total * group.share));
    return {
      defId: pickDef(floor, group.archetype, index + localWave),
      count,
      interval: group.interval,
      delay: group.delay,
      eliteChance: clamp(
        scaling.eliteChance + template.eliteShare * 0.5,
        0,
        DIFFICULTY.eliteChanceCap + 0.2,
      ),
      affixes: scaling.affixes.length > 0 ? [...scaling.affixes] : undefined,
    };
  });

  return {
    wave,
    floor,
    localWave,
    cycle,
    isMiniBoss: false,
    isMajorBoss: false,
    bossId: null,
    groups,
    hpMult: scaling.hpMult * difficultyScale,
    damageMult: scaling.damageMult * Math.sqrt(difficultyScale),
    speedMult: scaling.speedMult,
    eliteChance: scaling.eliteChance,
    affixChance: scaling.affixChance,
    total,
    rewardMult: scaling.rewardMult,
    hazardIntensity: scaling.hazardIntensity,
    label: template.tag,
    affixes: scaling.affixes,
  };
}

/** Total enemy HP budget for a wave — used by the debug panel and balance tools. */
export function estimateWaveBudget(spec: WaveSpec): number {
  return spec.groups.reduce((sum, group) => {
    const def = ENEMY_REGISTRY[group.defId];
    const baseHp = def ? def.hp : 20;
    const elite = 1 + group.eliteChance * 0.6;
    return sum + baseHp * group.count * elite * spec.hpMult;
  }, 0);
}
