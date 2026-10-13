import Phaser from 'phaser';
import { ARENA } from '@/config/gameConfig';
import { worldFrame } from '@/game/world/worldFrame';
import type { CombatContext } from '@/game/combat/context';
import type { ElementId, HazardKind, StatusApplication } from '@/types';
import { hexToInt } from '@/utils/color';

/**
 * Environmental hazards.
 *
 * A hazard exists to make the floor part of the fight: it should create a
 * decision (stand here, not there; ride the current instead of fighting it;
 * bait a warden into a pool) and it must never be unavoidable damage. So every
 * hazard here is declared as data — interval, telegraph length, radius, cost as
 * a share of the player's health, the element it carries, the statuses it leaves
 * behind — and every one of them announces itself before it lands.
 *
 * Floors choose a behaviour by id; nothing about a specific floor is hard-coded
 * in this file, and nothing about hazards lives in the player. Because fields
 * and bursts go back through the combat context, hazards feed the same reaction
 * and status systems as abilities do: a lava crack into a pool of water is a
 * steam burst, and the floor did it as much as you did.
 */

export type HazardShape = 'burst' | 'field' | 'mine' | 'wall' | 'strike' | 'wind' | 'chill';

export interface HazardStep {
  /** What actually gets deployed. */
  shape: HazardShape;
  /** Seconds between deployments of this step (randomised inside the range). */
  interval: [number, number];
  /** Warning time before it lands. Never below 420 ms: that is dodgeable. */
  telegraphMs: number;
  radius: number;
  /** Damage as a share of the player's max HP — hazards scale with you, not with the wave. */
  damagePct: number;
  /** Placement: near the player (they must move) or on fixed anchors (they must read the room). */
  placement: 'aroundPlayer' | 'anchored' | 'lane';
  /** Reach of the "around player" placement, in world pixels. */
  offset: number;
  /** The element this hazard carries, so floors can react with abilities. */
  element: ElementId;
  statuses?: StatusApplication[];
  /** Positive pushes away from the band, negative pulls into it (impulse, px/s). */
  push?: number;
  knockback?: number;
  /** Weight of this step inside the floor's rotation. */
  weight: number;
  /** Overrides the floor accent colour for this step only. */
  color?: string;
}

export interface HazardBehaviour {
  label: string;
  brief: string;
  steps: HazardStep[];
}

const step = (partial: Partial<HazardStep> & { shape: HazardStep['shape']; element: ElementId }): HazardStep => ({
  interval: [4, 6],
  telegraphMs: 620,
  radius: 26,
  damagePct: 0.05,
  placement: 'aroundPlayer',
  offset: 84,
  weight: 1,
  ...partial,
});

export const HAZARD_BEHAVIOURS: Record<Exclude<HazardKind, 'none'>, HazardBehaviour> = {
  lavaCracks: {
    label: 'Lava cracks',
    brief:
      'The ruins bleed. Cracks open where you have been standing — keep moving, and herd enemies across them instead.',
    steps: [
      step({
        shape: 'burst',
        element: 'fire',
        interval: [3.4, 5.2],
        radius: 24,
        damagePct: 0.06,
        telegraphMs: 700,
        offset: 78,
        statuses: [{ id: 'burn', duration: 2.4, chance: 0.6 }],
      }),
      step({
        shape: 'field',
        element: 'fire',
        interval: [7, 10],
        radius: 30,
        damagePct: 0.02,
        telegraphMs: 900,
        placement: 'anchored',
        statuses: [{ id: 'burn', duration: 3.2, chance: 0.8 }],
      }),
    ],
  },
  current: {
    label: 'Drowned current',
    brief:
      'The vault floods in pulls. Ride one and you cross the room fast; fight it and you are the thing that stops moving.',
    steps: [
      step({
        shape: 'wind',
        element: 'water',
        interval: [3, 4.6],
        radius: 46,
        damagePct: 0.012,
        telegraphMs: 560,
        placement: 'lane',
        push: 130,
        weight: 1.4,
        statuses: [{ id: 'slow', duration: 1.4, chance: 0.5 }],
      }),
      step({
        shape: 'field',
        element: 'water',
        interval: [8, 11],
        radius: 34,
        damagePct: 0.02,
        telegraphMs: 800,
        placement: 'anchored',
        push: -60,
        statuses: [{ id: 'slow', duration: 2, chance: 0.75 }],
      }),
    ],
  },
  windZone: {
    label: 'Wind shear',
    brief:
      'Gusts cross the spires in bands. They will throw you off a line or onto one — and they carry your embers further than they would go alone.',
    steps: [
      step({
        shape: 'wind',
        element: 'air',
        interval: [2.6, 4.2],
        radius: 52,
        damagePct: 0,
        telegraphMs: 520,
        placement: 'lane',
        push: 150,
        weight: 1.6,
      }),
      step({
        shape: 'burst',
        element: 'air',
        interval: [6, 9],
        radius: 20,
        damagePct: 0.035,
        telegraphMs: 620,
        knockback: 130,
      }),
    ],
  },
  overgrowth: {
    label: 'Living labyrinth',
    brief:
      'Vines answer noise. They root what stands still, so the maze punishes camping far more than it punishes pushing through.',
    steps: [
      step({
        shape: 'field',
        element: 'vine',
        interval: [5.5, 8],
        radius: 32,
        damagePct: 0.01,
        telegraphMs: 700,
        offset: 92,
        statuses: [
          { id: 'root', duration: 1.4, chance: 0.7 },
          { id: 'poison', duration: 3.4, chance: 0.8 },
        ],
      }),
      step({
        shape: 'burst',
        element: 'vine',
        interval: [7, 10],
        radius: 18,
        damagePct: 0.03,
        telegraphMs: 640,
        placement: 'anchored',
        statuses: [{ id: 'slow', duration: 2.2, chance: 0.9 }],
      }),
    ],
  },
  walls: {
    label: 'Crystal foundry',
    brief:
      'The foundry extrudes crystal along its seams. Walls arrive slowly enough to avoid and are worth breaking line of sight with.',
    steps: [
      step({
        shape: 'wall',
        element: 'crystal',
        interval: [6, 8.5],
        radius: 22,
        damagePct: 0.05,
        telegraphMs: 900,
        placement: 'anchored',
        weight: 1.5,
      }),
      step({
        shape: 'strike',
        element: 'crystal',
        interval: [8, 12],
        radius: 16,
        damagePct: 0.04,
        telegraphMs: 520,
        color: '#DA8CFF',
      }),
    ],
  },
  lightningStrikes: {
    label: 'Storm strikes',
    brief:
      'The citadel is a lightning rod. Strikes telegraph a hair early and leave charge in the ground — stunning a warden into a strike is a real tactic.',
    steps: [
      step({
        shape: 'strike',
        element: 'lightning',
        interval: [2.8, 4.4],
        radius: 16,
        damagePct: 0.055,
        telegraphMs: 540,
        offset: 74,
        weight: 1.7,
        statuses: [{ id: 'shock', duration: 2.2, chance: 0.6 }],
        color: '#E7D8FF',
      }),
      step({
        shape: 'field',
        element: 'lightning',
        interval: [9, 13],
        radius: 30,
        damagePct: 0.015,
        telegraphMs: 780,
        placement: 'lane',
        statuses: [{ id: 'slow', duration: 2.4, chance: 0.8 }],
      }),
    ],
  },
  ashCloud: {
    label: 'Ash fall',
    brief:
      'Ash smothers sight and lungs. A cloud costs you accuracy for as long as you stand in it: it is cover, not a tax.',
    steps: [
      step({
        shape: 'chill',
        element: 'ash',
        interval: [4.5, 7],
        radius: 40,
        damagePct: 0.012,
        telegraphMs: 720,
        placement: 'anchored',
        statuses: [
          { id: 'blind', duration: 3, chance: 0.85 },
          { id: 'poison', duration: 3.6, chance: 0.7 },
        ],
        color: '#E17B45',
      }),
      step({
        shape: 'burst',
        element: 'ash',
        interval: [8, 11],
        radius: 22,
        damagePct: 0.04,
        telegraphMs: 660,
      }),
    ],
  },
  iceSheet: {
    label: 'Frozen crown',
    brief:
      'Sheets of ice form underfoot: everything on them keeps its momentum a moment too long, including the things chasing you.',
    steps: [
      step({
        shape: 'field',
        element: 'ice',
        interval: [4.5, 6.5],
        radius: 38,
        damagePct: 0.01,
        telegraphMs: 760,
        placement: 'anchored',
        statuses: [{ id: 'slow', duration: 2.6, chance: 0.9 }],
        color: '#DDF8FF',
        weight: 1.8,
      }),
      step({
        shape: 'chill',
        element: 'ice',
        interval: [7, 10],
        radius: 44,
        damagePct: 0.02,
        telegraphMs: 900,
        placement: 'lane',
        statuses: [{ id: 'freeze', duration: 1.4, chance: 0.5 }],
        color: '#72D8FF',
      }),
    ],
  },
  toxicPools: {
    label: 'Toxic mire',
    brief:
      'Pools bloom where the mire is disturbed. Damage over time, never burst: the floor asks you to route fights around it.',
    steps: [
      step({
        shape: 'field',
        element: 'toxic',
        interval: [4, 6],
        radius: 30,
        damagePct: 0.014,
        telegraphMs: 700,
        offset: 96,
        statuses: [{ id: 'poison', duration: 4.4, chance: 0.95 }],
        color: '#C771FF',
        weight: 2,
      }),
      step({
        shape: 'mine',
        element: 'toxic',
        interval: [8, 11],
        radius: 22,
        damagePct: 0.035,
        telegraphMs: 900,
        placement: 'anchored',
        statuses: [{ id: 'poison', duration: 3, chance: 0.9 }],
      }),
    ],
  },
  instability: {
    label: 'Unstable ground',
    brief:
      'The Core has forgotten which element it is. Cracks, arcs and pools arrive in no order — read the floor colour, not the pattern.',
    steps: [
      step({
        shape: 'burst',
        element: 'plasma',
        interval: [3.6, 5.4],
        radius: 22,
        damagePct: 0.045,
        telegraphMs: 620,
        weight: 1.2,
        color: '#B385FF',
      }),
      step({
        shape: 'strike',
        element: 'lightning',
        interval: [5, 8],
        radius: 18,
        damagePct: 0.05,
        telegraphMs: 560,
        placement: 'lane',
        statuses: [{ id: 'shock', duration: 2, chance: 0.6 }],
        color: '#E7D8FF',
      }),
      step({
        shape: 'field',
        element: 'storm',
        interval: [7, 10],
        radius: 32,
        damagePct: 0.016,
        telegraphMs: 820,
        placement: 'anchored',
        statuses: [{ id: 'armorBreak', duration: 3.2, chance: 0.7 }],
        color: '#6E3FCB',
      }),
      step({
        shape: 'mine',
        element: 'solar',
        interval: [9, 12],
        radius: 22,
        damagePct: 0.04,
        telegraphMs: 900,
        placement: 'aroundPlayer',
        offset: 110,
      }),
    ],
  },
};

//** Short name of a floor's hazard, safe for the `none` floor. */
export function hazardLabel(kind: HazardKind): string {
  return kind === 'none' ? 'Stable ground' : HAZARD_BEHAVIOURS[kind].label;
}

/** What the player is told when the floor begins. */
export function hazardBrief(kind: HazardKind): string {
  if (kind === 'none') return 'This ground is honest: nothing here will hurt you that you did not bring on yourself.';
  return HAZARD_BEHAVIOURS[kind].brief;
}

/** Fixed spots for anchored placement — positions a player can learn and use. */
const ANCHORS: [number, number][] = [
  [0.24, 0.28],
  [0.76, 0.28],
  [0.2, 0.72],
  [0.8, 0.72],
  [0.5, 0.2],
  [0.5, 0.8],
];

export interface HazardDirectorOptions {
  /** Mines and walls are persistent bodies; the scene builds them, the director decides when. */
  spawnMine: (x: number, y: number, damage: number, color: number) => void;
  spawnWall: (color: number, damage: number) => void;
  onDeploy?: (shape: HazardShape, x: number, y: number) => void;
}

/**
 * Runs one floor's hazard behaviour. It owns nothing but timers — damage,
 * fields, telegraphs and pushes all go back through the combat context.
 */
export class HazardDirector {
  private readonly context: CombatContext;
  private readonly kind: Exclude<HazardKind, 'none'> | 'none';
  private readonly timers: number[];
  private readonly color: number;
  private readonly options: HazardDirectorOptions;
  private elapsed = 0;

  constructor(
    context: CombatContext,
    kind: HazardKind,
    options: HazardDirectorOptions,
  ) {
    this.context = context;
    this.kind = kind === 'none' ? 'none' : kind;
    this.color = hexToInt(context.floor.palette.accent);
    this.options = options;
    this.timers = this.steps.map((_, index) => 2.4 + index * 1.1);
  }

  private get steps(): HazardStep[] {
    return this.kind === 'none' ? [] : HAZARD_BEHAVIOURS[this.kind].steps;
  }

  get active(): boolean {
    return this.kind !== 'none';
  }

  get label(): string {
    return this.kind === 'none' ? 'None' : HAZARD_BEHAVIOURS[this.kind].label;
  }

  /**
   * `intensity` comes from the wave director: quiet between waves, honest during
   * a fight, dialled back against a warden so the arena never competes with the
   * boss's own patterns.
   */
  update(deltaMs: number, intensity: number): void {
    if (!this.active) return;
    const dt = deltaMs / 1000;
    this.elapsed += dt;
    const steps = this.steps;
    const totalWeight = steps.reduce((sum, entry) => sum + entry.weight, 0);

    for (let index = 0; index < steps.length; index += 1) {
      const spec = steps[index];
      // A hard ceiling on live fields keeps the room readable and the frame
      // budget intact, whatever the floor's rotation is doing.
      if ((spec.shape === 'field' || spec.shape === 'chill') && this.context.fields.activeCount >= 8) {
        continue;
      }
      // At low health the floor calms down instead of finishing the run: hazards
      // are a positioning problem, never a death sentence.
      const hpRatio = this.context.player.maxHp > 0 ? this.context.player.hp / this.context.player.maxHp : 1;
      const mercy = hpRatio < 0.25 ? 0.45 : 1;
      this.timers[index] -= dt * intensity * (spec.weight / Math.max(1, totalWeight)) * 3 * mercy;
      if (this.timers[index] > 0) continue;
      const [minGap, maxGap] = spec.interval;
      this.timers[index] = Phaser.Math.FloatBetween(minGap, maxGap);
      this.deploy(spec);
    }
  }

  private deploy(spec: HazardStep): void {
    const player = this.context.player;
    let x = player.x;
    let y = player.y;

    if (spec.placement === 'anchored') {
      const [ax, ay] = ANCHORS[Math.floor(this.elapsed * 7) % ANCHORS.length];
      x = ARENA.wall + ax * (worldFrame.width - ARENA.wall * 2) + Phaser.Math.Between(-16, 16);
      y = ARENA.wall + ay * (worldFrame.height - ARENA.wall * 2) + Phaser.Math.Between(-16, 16);
    } else if (spec.placement === 'lane') {
      // A band across the room, snapped to the player's row or column so it can
      // be read and stepped out of.
      const horizontal = Math.random() > 0.5;
      x = horizontal
        ? worldFrame.width / 2
        : Phaser.Math.Clamp(player.x + Phaser.Math.Between(-70, 70), 40, worldFrame.width - 40);
      y = horizontal
        ? Phaser.Math.Clamp(player.y + Phaser.Math.Between(-70, 70), 40, worldFrame.height - 40)
        : worldFrame.height / 2;
    } else {
      const angle = Math.random() * Math.PI * 2;
      const distance = Phaser.Math.FloatBetween(spec.offset * 0.35, spec.offset);
      x = Phaser.Math.Clamp(player.x + Math.cos(angle) * distance, ARENA.wall + 12, worldFrame.width - ARENA.wall - 12);
      y = Phaser.Math.Clamp(
        player.y + Math.sin(angle) * distance * 0.7,
        ARENA.wall + 12,
        worldFrame.height - ARENA.wall - 12,
      );
    }

    x = Math.round(x);
    y = Math.round(y);

    const color = spec.color ? hexToInt(spec.color) : this.color;
    const damage = Math.max(1, Math.round(player.maxHp * spec.damagePct));
    const delay = spec.telegraphMs;
    this.options.onDeploy?.(spec.shape, x, y);

    switch (spec.shape) {
      case 'burst':
        this.context.telegraph(x, y, spec.radius, color, delay);
        this.context.scene.time.delayedCall(delay, () => {
          this.context.addHazardBurst(x, y, spec.radius, damage, color, spec.element, spec.statuses);
          this.applyPush(spec, x, y);
        });
        break;
      case 'field':
      case 'chill':
        this.context.telegraph(x, y, spec.radius, color, delay);
        this.context.scene.time.delayedCall(delay, () => {
          this.context.addField({
            x,
            y,
            radius: spec.radius,
            dps: damage * 2,
            duration: spec.shape === 'chill' ? 6.5 : 4.5,
            element: spec.element,
            vfx: spec.shape === 'chill' ? 'mist' : 'steam',
            color,
            statuses: spec.statuses,
            friendly: false,
            pull: spec.push ? -spec.push * 0.2 : undefined,
          });
        });
        break;
      case 'strike':
        this.context.telegraph(x, y, spec.radius * 0.8, color, delay);
        this.context.scene.time.delayedCall(delay, () => {
          this.context.addHazardBurst(x, y, spec.radius, damage, color, spec.element, spec.statuses);
          this.context.fx.ring(x, y, color, spec.radius * 1.6, 0.24, 1.1);
          this.context.fx.hitSpark(x, y, color, 1.4, 'bolt', 'current');
          if (spec.statuses && Phaser.Math.Distance.Between(x, y, player.x, player.y) <= spec.radius) {
            player.statuses.apply(spec.statuses[0]);
          }
        });
        break;
      case 'wind': {
        // A band that moves you. It only grazes: the cost of being in it is
        // where it put you, not what it took off your bar.
        const horizontal = Math.abs(x - worldFrame.width / 2) < Math.abs(y - worldFrame.height / 2);
        const angle = horizontal
          ? Math.random() > 0.5
            ? 0
            : Math.PI
          : Math.random() > 0.5
            ? Math.PI / 2
            : -Math.PI / 2;
        this.context.telegraph(x, y, spec.radius, color, delay);
        this.context.scene.time.delayedCall(delay, () => {
          const distance = Phaser.Math.Distance.Between(x, y, player.x, player.y);
          const strength = spec.push ?? 120;
          if (distance < spec.radius * 1.6) {
            const falloff = 1 - distance / (spec.radius * 1.6);
            const body = player.body as Phaser.Physics.Arcade.Body;
            body.velocity.x += Math.cos(angle) * strength * falloff;
            body.velocity.y += Math.sin(angle) * strength * falloff;
          }
          for (const enemy of this.context.enemies.getChildren() as Phaser.GameObjects.Sprite[]) {
            if (!enemy.active || enemy.y < 0) continue;
            const enemyBody = enemy.body as Phaser.Physics.Arcade.Body | null;
            if (!enemyBody) continue;
            if (Phaser.Math.Distance.Between(x, y, enemy.x, enemy.y) > spec.radius * 1.6) continue;
            enemyBody.velocity.x += Math.cos(angle) * strength * 0.6;
            enemyBody.velocity.y += Math.sin(angle) * strength * 0.6;
          }
          for (let i = 0; i < 6; i += 1) {
            this.context.hitSparkAt(
              x + Phaser.Math.Between(-spec.radius, spec.radius),
              y + Phaser.Math.Between(-10, 10),
              color,
              0.6,
              'streak',
              'gas',
            );
          }
        });
        break;
      }
      case 'mine':
        this.options.spawnMine(x, y, damage, color);
        break;
      case 'wall':
        this.options.spawnWall(color, damage);
        break;
    }
  }

  private applyPush(spec: HazardStep, x: number, y: number): void {
    if (!spec.knockback) return;
    const player = this.context.player;
    if (Phaser.Math.Distance.Between(x, y, player.x, player.y) > spec.radius) return;
    const angle = Math.atan2(player.y - y, player.x - x);
    const body = player.body as Phaser.Physics.Arcade.Body;
    body.velocity.x += Math.cos(angle) * spec.knockback;
    body.velocity.y += Math.sin(angle) * spec.knockback;
  }

  destroy(): void {
    this.timers.length = 0;
  }
}
