import Phaser from 'phaser';
import { SPAWN_CONFIG, WAVE_CONFIG } from '@/config/gameConfig';
import { getBoss } from '@/data/bosses';
import { FLOOR_REGISTRY, WAVES_PER_FLOOR } from '@/data/floors';
import { generateWave } from '@/game/systems/waveGenerator';
import { gameBus } from '@/game/systems/eventBus';
import type { CombatContext } from '@/game/combat/context';
import type { Enemy } from '@/game/entities/Enemy';
import type { GameMode, WaveSpec } from '@/types';
import { clamp } from '@/utils/math';
import { sfx } from '@/game/systems/audio';

export type WaveState = 'idle' | 'countdown' | 'spawning' | 'fighting' | 'cleared' | 'bossIntro' | 'boss' | 'complete';

export interface WaveDirectorHooks {
  onStateChange?: (state: WaveState, wave: number) => void;
  onWaveStart?: (spec: WaveSpec) => void;
  onWaveCleared?: (spec: WaveSpec, essence: number) => void;
  onBossSpawn?: (enemy: Enemy) => void;
  onBossDefeated?: (enemy: Enemy) => void;
  onFloorCleared?: (floor: number) => void;
  onStoryComplete?: () => void;
}

interface PendingSpawn {
  defId: string;
  at: number;
  eliteChance: number;
  affixes: string[];
}

/**
 * Wave director.
 *
 * Owns the wave state machine, the portal spawn manager and the transition
 * timing. It never touches the DOM or React — it publishes bus events and the
 * interface reacts. Enemies always arrive through visible portals placed away
 * from the player, never on top of them.
 */
export class WaveDirector {
  private context: CombatContext;
  private hooks: WaveDirectorHooks;
  private state: WaveState = 'idle';
  private spec: WaveSpec | null = null;
  private mode: GameMode = 'story';
  private elapsed = 0;
  private countdownLeft = 0;
  private clearTimer = 0;
  private queue: PendingSpawn[] = [];
  private queueCursor = 0;
  private portals: { sprite: Phaser.GameObjects.Image; defId: string; eliteChance: number; affixes: string[]; releaseAt: number }[] = [];
  private aliveCheckTimer = 0;
  private bossEnemy: Enemy | null = null;
  private bossIntroTimer = 0;
  private waveKillCount = 0;
  /** Guards the one-shot 'idle' hand-off so the scene advances exactly once. */
  private idleEmitted = false;
  private waveEssence = 0;

  constructor(context: CombatContext, hooks: WaveDirectorHooks = {}) {
    this.context = context;
    this.hooks = hooks;
  }

  get currentState(): WaveState {
    return this.state;
  }

  get currentSpec(): WaveSpec | null {
    return this.spec;
  }

  get boss(): Enemy | null {
    return this.bossEnemy;
  }

  get remainingEnemies(): number {
    const alive = this.context.enemies.countActive(true);
    const queued = Math.max(0, this.queue.length - this.queueCursor) + this.portals.length;
    return alive + queued + (this.bossEnemy && this.bossEnemy.active ? 1 : 0);
  }

  begin(wave: number, mode: GameMode, floorOverride?: number, difficultyScale = 1): WaveSpec {
    const spec = generateWave({ wave, mode, floorOverride, difficultyScale });
    this.mode = mode;
    this.spec = spec;
    this.elapsed = 0;
    this.queue = [];
    this.queueCursor = 0;
    this.portals = [];
    this.waveKillCount = 0;
    this.waveEssence = 0;
    this.idleEmitted = false;
    this.bossEnemy = null;

    context_scaling(this.context, spec);

    if (spec.isMajorBoss || spec.isMiniBoss) {
      this.state = 'bossIntro';
      this.bossIntroTimer = WAVE_CONFIG.bossIntroDelay;
      const bossDef = getBoss(spec.bossId);
      if (bossDef) {
        gameBus.emit('game:bossSpawned', {
          bossId: bossDef.id,
          name: bossDef.name,
          title: bossDef.title,
          description: bossDef.description,
          element: bossDef.element,
          color: bossDef.color,
          rank: bossDef.rank === 'major' ? 'major' : 'miniboss',
          wave: spec.wave,
          floor: spec.floor,
          floorName: this.context.floor.name,
          hp: Math.round(bossDef.hp * spec.hpMult),
          phases: bossDef.phases.map((entry) => ({ name: entry.name, banner: entry.banner })),
        });
      }
      sfx('boss_enter');
    } else {
      this.state = 'countdown';
      this.countdownLeft = WAVE_CONFIG.countdown;
    }

    this.buildQueue(spec);
    gameBus.emit('game:waveStarted', {
      wave: spec.wave,
      floor: spec.floor,
      isBoss: spec.isMiniBoss || spec.isMajorBoss,
      label: spec.label,
      total: spec.total,
    });
    this.hooks.onStateChange?.(this.state, spec.wave);
    this.hooks.onWaveStart?.(spec);
    return spec;
  }

  private buildQueue(spec: WaveSpec): void {
    const queue: PendingSpawn[] = [];
    for (const group of spec.groups) {
      const isBossGroup = group.defId.startsWith('boss_');
      for (let i = 0; i < group.count; i += 1) {
        queue.push({
          defId: group.defId,
          at: group.delay + i * group.interval,
          eliteChance: isBossGroup ? 0 : group.eliteChance,
          affixes: group.affixes ?? [],
        });
      }
    }
    queue.sort((a, b) => a.at - b.at);
    this.queue = queue;
    this.queueCursor = 0;
  }

  update(deltaMs: number): void {
    if (!this.spec) return;
    const dt = deltaMs / 1000;
    this.elapsed += dt;

    switch (this.state) {
      case 'countdown': {
        this.countdownLeft -= dt;
        if (this.countdownLeft <= 0) {
          this.state = 'spawning';
          this.hooks.onStateChange?.(this.state, this.spec.wave);
        }
        break;
      }
      case 'bossIntro': {
        this.bossIntroTimer -= dt;
        if (this.bossIntroTimer <= 0) {
          const bossDef = getBoss(this.spec.bossId);
          if (bossDef) {
            const positions = this.bossSpawnPoint();
            const enemy = this.context.spawnEnemy(bossDef.id, positions.x, positions.y, {
              rank: bossDef.rank === 'major' ? 'boss' : 'miniboss',
              affixes: this.spec.affixChance > 0.5 ? this.spec.affixes : [],
              portal: true,
            });
            if (enemy) {
              this.bossEnemy = enemy;
              this.context.fx.shake('heavy');
              this.hooks.onBossSpawn?.(enemy);
            }
          }
          this.state = 'spawning';
        }
        break;
      }
      default:
        break;
    }

    // The queue is drained continuously: staggered spawn delays mean later
    // entries only become due after the phase has already become 'fighting',
    // so the spawner must keep running for the whole wave.
    if (this.state === 'spawning') this.state = 'fighting';
    if (this.state === 'fighting' || this.state === 'boss') this.processQueue();

    this.updatePortals();
    this.checkWaveProgress(deltaMs);
  }

  private processQueue(): void {
    if (!this.spec) return;
    if (this.context.enemies.countActive(true) >= WAVE_CONFIG.maxAliveEnemies) return;
    if (this.portals.length >= SPAWN_CONFIG.maxPortals) return;
    while (this.queueCursor < this.queue.length && this.queue[this.queueCursor].at <= this.elapsed) {
      const entry = this.queue[this.queueCursor];
      this.queueCursor += 1;
      this.openPortal(entry);
      if (this.portals.length >= SPAWN_CONFIG.maxPortals) break;
    }
  }

  private bossSpawnPoint(): { x: number; y: number } {
    const bounds = this.context.scene.physics.world.bounds;
    const angle = Math.random() * Math.PI * 2;
    const distance = 120;
    return {
      x: clamp(this.context.player.x + Math.cos(angle) * distance, bounds.x + 30, bounds.right - 30),
      y: clamp(this.context.player.y + Math.sin(angle) * distance, bounds.y + 30, bounds.bottom - 30),
    };
  }

  private openPortal(entry: PendingSpawn): void {
    const point = this.spawnPositionAwayFromPlayer();
    const color = this.context.floor.palette.portal;
    const sprite = this.context.scene.add.image(Math.round(point.x), Math.round(point.y), 'fx_portal');
    sprite.setDepth(18);
    sprite.setTint(parseInt(color.replace('#', ''), 16));
    sprite.setAlpha(0.15);
    sprite.setScale(1.6);
    sprite.setBlendMode(Phaser.BlendModes.ADD);
    this.context.scene.tweens.add({
      targets: sprite,
      alpha: 0.95,
      scale: 1.1,
      duration: SPAWN_CONFIG.portalLeadTime * 1000,
      ease: 'Quad.easeOut',
    });
    this.portals.push({
      sprite,
      defId: entry.defId,
      eliteChance: entry.eliteChance,
      affixes: entry.affixes,
      releaseAt: this.context.scene.time.now + SPAWN_CONFIG.portalLeadTime * 1000,
    });
  }

  /** Placement rule: never on top of the player, prefer arena edges. */
  private spawnPositionAwayFromPlayer(): { x: number; y: number } {
    const bounds = this.context.scene.physics.world.bounds;
    const player = this.context.player;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const edge = Math.floor(Math.random() * 4);
      const inset = SPAWN_CONFIG.edgeInset;
      let x = 0;
      let y = 0;
      switch (edge) {
        case 0:
          x = Phaser.Math.Between(bounds.x + inset, bounds.right - inset);
          y = bounds.y + inset;
          break;
        case 1:
          x = bounds.right - inset;
          y = Phaser.Math.Between(bounds.y + inset, bounds.bottom - inset);
          break;
        case 2:
          x = Phaser.Math.Between(bounds.x + inset, bounds.right - inset);
          y = bounds.bottom - inset;
          break;
        default:
          x = bounds.x + inset;
          y = Phaser.Math.Between(bounds.y + inset, bounds.bottom - inset);
          break;
      }
      const distance = Phaser.Math.Distance.Between(x, y, player.x, player.y);
      if (distance >= SPAWN_CONFIG.minDistanceFromPlayer) return { x, y };
    }
    // Fallback: furthest corner from the player.
    const corners = [
      { x: bounds.x + SPAWN_CONFIG.edgeInset, y: bounds.y + SPAWN_CONFIG.edgeInset },
      { x: bounds.right - SPAWN_CONFIG.edgeInset, y: bounds.y + SPAWN_CONFIG.edgeInset },
      { x: bounds.x + SPAWN_CONFIG.edgeInset, y: bounds.bottom - SPAWN_CONFIG.edgeInset },
      { x: bounds.right - SPAWN_CONFIG.edgeInset, y: bounds.bottom - SPAWN_CONFIG.edgeInset },
    ];
    return corners.reduce((best, corner) => {
      const bestDistance = Phaser.Math.Distance.Between(best.x, best.y, player.x, player.y);
      const distance = Phaser.Math.Distance.Between(corner.x, corner.y, player.x, player.y);
      return distance > bestDistance ? corner : best;
    });
  }

  private updatePortals(): void {
    const now = this.context.scene.time.now;
    for (let i = this.portals.length - 1; i >= 0; i -= 1) {
      const portal = this.portals[i];
      if (portal.sprite.active) {
        portal.sprite.setScale(1.1 + Math.sin(now / 120) * 0.12);
      }
      if (now >= portal.releaseAt) {
        const enemy = this.context.spawnEnemy(portal.defId, portal.sprite.x, portal.sprite.y, {
          portal: false,
          elite: Math.random() < portal.eliteChance,
          affixes: portal.affixes as never,
        });
        if (enemy) {
          this.context.fx.deathBurst(portal.sprite.x, portal.sprite.y, parseInt(this.context.floor.palette.portal.replace('#', ''), 16), 0.9);
        }
        this.context.scene.tweens.add({
          targets: portal.sprite,
          alpha: 0,
          duration: 200,
          onComplete: () => portal.sprite.destroy(),
        });
        this.portals.splice(i, 1);
      }
    }
  }

  /** Track completion of the wave. */
  private checkWaveProgress(deltaMs: number): void {
    if (!this.spec) return;
    if (this.state === 'countdown' || this.state === 'bossIntro') return;

    const queueEmpty = this.queueCursor >= this.queue.length;
    const alive = this.context.enemies.countActive(true);
    const bossAlive = this.bossEnemy ? this.bossEnemy.active : false;
    const waveComplete = queueEmpty && this.portals.length === 0 && alive === 0 && !bossAlive;

    // Post-clear hold: the "WAVE CLEARED" banner owns the screen, then the
    // director hands control back to the scene, which starts the next wave.
    if (this.state === 'cleared') {
      this.clearTimer -= deltaMs / 1000;
      if (this.clearTimer <= 0 && !this.idleEmitted) {
        this.idleEmitted = true;
        this.hooks.onStateChange?.('idle', this.spec.wave);
      }
      return;
    }
    if (this.state === 'complete') return;

    this.aliveCheckTimer -= deltaMs;
    if (this.aliveCheckTimer > 0 || !waveComplete) return;
    this.aliveCheckTimer = 180;

    this.state = 'cleared';
    this.clearTimer = WAVE_CONFIG.clearDelay;
    const essence = Math.round(
      (WAVE_CONFIG.waveClearEssence + this.spec.wave * WAVE_CONFIG.waveClearEssenceGrowth) *
        this.spec.rewardMult,
    );
    this.waveEssence += essence;
    this.context.addEssence(essence);
    sfx('wave_clear');
    this.hooks.onWaveCleared?.(this.spec, essence);
    // The scene re-publishes this event with the shard tally from the run store:
    // only it knows what the player actually collected during the wave.
    this.hooks.onStateChange?.(this.state, this.spec.wave);
  }

  /** Called by the scene when an enemy dies. */
  notifyKilled(enemy: Enemy): void {
    this.waveKillCount += 1;
    if (this.bossEnemy === enemy) {
      const spec = this.spec;
      this.bossEnemy = null;
      this.context.fx.shake('heavy');
      this.hooks.onBossDefeated?.(enemy);
      if (spec) {
        gameBus.emit('game:bossDefeated', {
          bossId: enemy.boss ? enemy.boss.def.id : 'unknown',
          rank: enemy.rank === 'boss' ? 'major' : 'miniboss',
          essence: Math.round(enemy.essenceValue * spec.rewardMult),
          drops: [],
        });
        const bossDef = enemy.boss?.def;
        if (bossDef && bossDef.rank === 'major') {
          this.hooks.onFloorCleared?.(spec.floor);
          if (spec.floor >= 10 && this.mode === 'story') {
            this.hooks.onStoryComplete?.();
          }
        }
      }
    }
  }

  /** True when the arena is safe for the next wave to begin. */
  /** Seconds left on the pre-wave countdown (0 when not counting down). */
  get countdownRemaining(): number {
    return Math.max(0, this.countdownLeft);
  }

  get canAdvance(): boolean {
    return this.state === 'cleared';
  }

  get killsThisWave(): number {
    return this.waveKillCount;
  }

  get essenceThisWave(): number {
    return this.waveEssence;
  }

  /** Debug helper used by the development panel. */
  killAll(): number {
    let killed = 0;
    for (const child of this.context.enemies.getChildren() as Enemy[]) {
      if (child.active) {
        child.die(true);
        killed += 1;
      }
    }
    return killed;
  }

  destroy(): void {
    for (const portal of this.portals) portal.sprite.destroy();
    this.portals = [];
    this.queue = [];
    this.spec = null;
    this.bossEnemy = null;
    this.state = 'idle';
  }
}

function context_scaling(context: CombatContext, spec: WaveSpec): void {
  context.scaling = {
    hpMult: spec.hpMult,
    damageMult: spec.damageMult,
    speedMult: spec.speedMult,
    eliteChance: spec.eliteChance,
    affixChance: spec.affixChance,
    affixes: spec.affixes,
  };
  context.floor = FLOOR_REGISTRY[spec.floor] ?? context.floor;
}

export const WAVE_CONSTANTS = {
  wavesPerFloor: WAVES_PER_FLOOR,
} as const;

export function waveForFloor(floor: number): { from: number; to: number } {
  return { from: (floor - 1) * WAVES_PER_FLOOR + 1, to: floor * WAVES_PER_FLOOR };
}

export function ascensionLabel(cycle: number): string {
  const numerals = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
  if (cycle < numerals.length) return numerals[cycle];
  return `${cycle + 1}`;
}

export { clamp };
