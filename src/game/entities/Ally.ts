import Phaser from 'phaser';
import { DUNGEON } from '@/config/gameConfig';
import type { Enemy } from '@/game/entities/Enemy';
import type { AllyState } from '@/types';

/** An orb on the floor that nobody has claimed yet. `id` is the sprite's spawn tag. */
export interface OrbTarget {
  id: number;
  x: number;
  y: number;
}

/** What the ally is allowed to ask the world. Kept to a handful of questions so the entity stays testable. */
export interface AllyView {
  player: { x: number; y: number };
  /** Nearest live enemy to a point, or null. The scene answers with its own group. */
  nearestEnemy(x: number, y: number, radius: number): Enemy | null;
  /** The closest unclaimed orb, or null. This is the courier's whole reason to leave your side. */
  nearestOrb(x: number, y: number, radius: number): OrbTarget | null;
  /** Pick it up. False means someone else got there first, and the ally forgets it. */
  takeOrb(orb: OrbTarget): boolean;
  /** Put them down at the warden's feet; the scene respawns each tag there, so the ledger runs as usual. */
  deliver(ids: number[], x: number, y: number): void;
  /**
   * The next step along the corridor toward a place. The scene owns the map's geometry; the ally never
   * guesses at walls, it asks where the route goes and walks that.
   */
  corridorStep(
    x: number,
    y: number,
    to: { x: number; y: number },
    heading: number,
  ): { x: number; y: number; committed: boolean } | null;
  /**
   * Ground it could actually stand on, as near `toward` as the stone allows — or the way out, if it is
   * already inside a wall. A leash point is arithmetic, and arithmetic does not know that 34px on the far
   * side of a fold is the middle of a wall; aiming at that presses the partner into the stone and leaves it
   * there, which is the difference between a partner and a decoration. `null` means the aim needs no
   * correction, which is the common case and also the case where the route's own answer stands.
   */
  standable?(x: number, y: number, toward: { x: number; y: number }): { x: number; y: number } | null;
  /**
   * How far from the warden the partner is allowed to wander before coming home. The scene owns it, because
   * it is a distance in the world and the world's unit is the tile: the config's six leashes were written
   * when a tile was 32px, and on a map whose tiles are 160px that bound is barely one tile — a partner held
   * to it abandons every detour the labyrinth is made of.
   */
  recallDistance?: number;
  /** One cast, landed. The scene routes this through `damageArea` so the caps and the crit rules stay shared. */
  strike(enemy: Enemy): void;
  /** Anything the ally walks into that is not an enemy — hazard fields, mines. */
  hazardAt(x: number, y: number): number;
  onDowned(ally: Ally): void;
}

/**
 * The partner: `autoCast`'s decision logic, given a body.
 *
 * Four states, one decision per `DUNGEON.partner.castIntervalMs` rather than one per frame, and no
 * allocation inside `tick` — the same two rules the arena has always followed, because a second
 * autonomous entity is exactly the kind of thing that quietly doubles the frame cost.
 *
 * Its kit *is* the player's support loadout: the scene hands it the element the rig would have cast, so
 * the loadout screen finally drives something with a position and a health bar instead of only a timer.
 */
export class Ally extends Phaser.Physics.Arcade.Sprite {
  hp = 1;
  maxHp = 1;
  /**
   * Not called `state`: `Phaser.GameObjects.Sprite` already has a `state` object (the playable-video
   * bookkeeping), and shadowing it with a string is the kind of collision that only shows up when
   * something else in the engine touches it.
   */
  allyState: AllyState = 'following';
  /**
   * Orb ids held in hand. They are *not* in the ledger yet: an orb the partner is carrying is still
   * lying on the strip's floor as far as every rule is concerned, which is why delivering it is a
   * respawn at the warden's feet and not a second implementation of picking things up.
   */
  carried: number[] = [];
  /** 0..1, for the HUD bar. */
  get hpRatio(): number {
    return this.maxHp > 0 ? Math.max(0, Math.min(1, this.hp / this.maxHp)) : 0;
  }

  private thinkMs = 0;
  private fleeUntil = 0;
  private clock = 0;
  private downedFired = false;

  constructor(scene: Phaser.Scene, x: number, y: number, textureKey: string, color: number) {
    super(scene, x, y, textureKey);
    scene.add.existing(this);
    scene.physics.add.existing(this);
    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setCollideWorldBounds(true);
    this.setDepth(9);
    this.setTint(color);
  }

  /**
   * Stats-derived sizing.
   *
   * Resizing keeps the ratio, so a loadout edit that raises max HP does not top the partner up and a
   * defensive one does not silently kill it — the same rule the player's `applyStats` follows (§H5).
   */
  applyStats(stats: { maxHp: number; speed: number; attack: number; damageMult: number }): void {
    const ratio = this.maxHp > 0 ? this.hp / this.maxHp : 1;
    this.maxHp = Math.max(1, Math.round(stats.maxHp * DUNGEON.partner.hpFraction));
    this.hp = Math.max(1, Math.round(this.maxHp * ratio));
    this.speed = stats.speed * DUNGEON.partner.speedFraction;
    this.power = stats.attack * stats.damageMult * DUNGEON.partner.damageFraction;
  }

  speed = 90;
  power = 6;

  tick(dt: number, view: AllyView): void {
    if (this.allyState === 'downed') {
      this.setVelocity(0, 0);
      return;
    }
    this.clock += dt;
    this.thinkMs -= dt;

    const body = this.body as Phaser.Physics.Arcade.Body;
    const dx = this.x - view.player.x;
    const dy = this.y - view.player.y;
    const distanceToPlayer = Math.hypot(dx, dy);

    // The recall: past six leashes, an orb in hand or a fight in reach no longer justifies the detour. In
    // a strip the partner could lose the warden for a moment and find it down a lane; in a brain the folds
    // are long enough that "a moment behind" becomes "gone", and a partner who is gone is furniture.
    const recall = view.recallDistance ?? DUNGEON.partner.leashDistance * 6;
    if (distanceToPlayer > recall) {
      this.allyState = 'following';
      this.target = null;
      this.orb = null;
    }

    if (this.thinkMs <= 0) {
      this.thinkMs = DUNGEON.partner.castIntervalMs;
      this.think(view);
    }

    // Movement is continuous; only the *decision* is throttled, or the partner stutters.
    let tx = view.player.x;
    let ty = view.player.y;
    if (this.fleeing) {
      // Away from the player is the one direction that cannot pull it into what it is fleeing.
      tx = this.x + (this.x - view.player.x || 1);
      ty = this.y + (this.y - view.player.y || 1);
    } else if (this.allyState === 'fetching' && this.orb) {
      tx = this.orb.x;
      ty = this.orb.y;
      if (Math.hypot(this.orb.x - this.x, this.orb.y - this.y) <= DUNGEON.partner.deliverRadius) {
        this.pickUp(view);
        body.setVelocity(0, 0);
        return;
      }
    } else if (this.allyState === 'fetching') {
      // Hands full: bring them in. The warden's pickup radius does the rest, which is the point of
      // putting them down at their feet instead of crediting the ledger from here.
      tx = view.player.x;
      ty = view.player.y;
      if (distanceToPlayer <= DUNGEON.partner.deliverRadius) {
        view.deliver(this.carried.slice(), view.player.x, view.player.y);
        this.carried.length = 0;
        this.allyState = 'following';
        body.setVelocity(0, 0);
        return;
      }
    } else if (this.allyState === 'engaging' && this.target) {
      tx = this.target.x;
      ty = this.target.y;
    } else {
      // The leash point sits on the line back to the player, `leashDistance` short of them, so
      // following never shoves the warden out of their own firing line.
      const back = DUNGEON.partner.leashDistance;
      const ux = dx / (distanceToPlayer || 1);
      const uy = dy / (distanceToPlayer || 1);
      tx = view.player.x + ux * back;
      ty = view.player.y + uy * back;
      if (distanceToPlayer < back) {
        body.setVelocity(0, 0);
        return;
      }
    }

    /*
     * One question to the map before every move: where does the corridor go from here?
     *
     * This used to be asked only when the target was far, on the reasoning that a nearby target is close
     * enough to walk straight at. On a strip that held — nothing is 40px away and behind a wall at the same
     * time. In a brain it is the common case, and the partner spent the run nose-down in a fold, pressing a
     * wall because its leash point happened to be 34px on the other side of one. `corridorStep` already
     * answers "walk straight at it" whenever nothing is between, so asking always costs nothing and the
     * partner stops being a decoration that arrives when the geometry happens to allow it.
     */
    const step = view.corridorStep(this.x, this.y, { x: tx, y: ty }, this.drive);
    if (step) {
      tx = step.x;
      ty = step.y;
      // Only an unambiguous read of where the target lies is allowed to steer; inside that, the heading
      // stands, which is what stops it oscillating at the mouth of a dead end.
      if (!step.committed) this.drive = Math.sign(step.x - this.x) || this.drive;
    }

    // Ground gets the last word on where the step points. The route is asked first because it knows the way
    // round; what it cannot know is that the *destination* it was handed — a leash point 34px on the far
    // side of a fold — is stone. Correcting that before routing instead of after turns "go round" into
    // "press against", which is how the partner ended a run nose-down in a wall.
    if (view.standable) {
      const spot = view.standable(this.x, this.y, { x: tx, y: ty });
      if (spot) {
        tx = spot.x;
        ty = spot.y;
      }
    }

    const vx = tx - this.x;
    const vy = ty - this.y;
    const len = Math.hypot(vx, vy) || 1;
    body.setVelocity((vx / len) * this.speed, (vy / len) * this.speed);

    const danger = view.hazardAt(this.x, this.y);
    if (danger > 0) {
      this.hp = Math.max(0, this.hp - danger * dt * 0.001);
      if (this.hp <= 0) this.down(view);
    }
  }

  /**
   * One decision, in the order the mode's premise asks for: stay alive, then do the job the player
   * gave you, then fight. Fetching outranks fighting on purpose — the partner is the reason a
   * one-path labyrinth is worth walking instead of a corridor you sprint down.
   */
  private think(view: AllyView): void {
    this.view = view;
    const hurt = this.hp / this.maxHp <= DUNGEON.partner.fleeFraction;
    if (hurt) {
      this.allyState = 'fleeing';
      this.fleeUntil = this.clock + DUNGEON.partner.fleeMs;
      return;
    }
    if (this.carried.length > 0) {
      this.allyState = 'fetching';
      this.orb = null;
      return;
    }
    const orb = view.nearestOrb(view.player.x, view.player.y, DUNGEON.partner.orbRadius);
    if (orb) {
      this.orb = orb;
      this.allyState = 'fetching';
      return;
    }
    this.orb = null;
    const close = view.nearestEnemy(this.x, this.y, DUNGEON.partner.engageRadius);
    const engaged =
      close &&
      (Math.hypot(close.x - view.player.x, close.y - view.player.y) < DUNGEON.partner.guardRadius ||
        Math.hypot(close.x - this.x, close.y - this.y) < DUNGEON.partner.engageRadius * 0.55);
    this.target = engaged ? close : null;
    if (this.target) {
      this.allyState = 'engaging';
      view.strike(this.target);
      return;
    }
    this.allyState = 'following';
  }

  /** The hands close: the scene retires the pickup, and the id rides until it is put down. */
  private pickUp(view: AllyView): void {
    const orb = this.orb;
    this.orb = null;
    if (!orb) return;
    if (this.carried.length >= DUNGEON.partner.carryCapacity) return;
    if (view.takeOrb(orb)) this.carried.push(orb.id);
    if (this.carried.length === 0) this.allyState = 'following';
  }

  private orb: OrbTarget | null = null;
  private view: AllyView | null = null;
  /** -1 | 0 | 1: the way it committed to along the current lane. */
  private drive = 0;

  /** The partner is carrying these, for the HUD's count and for nothing else. */
  get carrying(): number {
    return this.carried.length;
  }
  private target: Enemy | null = null;
  /** Break-off is timed, not HP-gated, so a heal mid-flight cannot snap it back into the fight. */
  private get fleeing(): boolean {
    return this.fleeUntil > this.clock;
  }

  hurt(amount: number): void {
    if (this.allyState === 'downed' || !(amount > 0)) return;
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp <= 0) this.down();
  }

  /**
   * No timer and no auto-revive: downed means "walk to a spring or finish the run short".
   *
   * What it was carrying goes on the ground where it fell — the orbs are never destroyed, because a
   * partner losing consciousness cannot be a reason to lose loot the player had already earned.
   */
  private down(view?: AllyView): void {
    this.allyState = 'downed';
    this.orb = null;
    const hands = view ?? this.view;
    if (this.carried.length > 0 && hands) {
      hands.deliver(this.carried.slice(), this.x, this.y);
      this.carried.length = 0;
    }
    this.setVelocity(0, 0);
    this.setTint(0x7e899e);
    this.setAlpha(0.55);
    if (!this.downedFired) {
      this.downedFired = true;
      view?.onDowned(this);
    }
  }

  revive(): void {
    this.drive = 0;
    if (this.allyState !== 'downed') return;
    this.allyState = 'following';
    this.orb = null;
    this.hp = Math.max(1, Math.round(this.maxHp * 0.5));
    this.fleeUntil = 0;
    this.setAlpha(1);
  }

  heal(amount: number): void {
    if (this.allyState === 'downed' || !(amount > 0)) return;
    this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  /** A spring's other half: the partner is picked up at full-ish health, not topped up forever. */
  restore(): void {
    this.allyState = 'following';
    this.orb = null;
    this.drive = 0;
    this.downedFired = false;
    this.fleeUntil = 0;
    this.hp = this.maxHp;
    this.setAlpha(1);
  }
}
