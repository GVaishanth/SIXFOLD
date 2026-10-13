import { STATUS_REGISTRY } from '@/data/elements';
import type { StatusApplication, StatusId, StatusInstance, StatusSpec } from '@/types';

/**
 * Generic status-effect system.
 *
 * Entities own a `StatusTracker`; nothing about burns, roots or stuns is
 * implemented inside an enemy or a boss — they only apply status applications
 * and the tracker resolves the behaviour from the registry.
 */

export interface StatusTarget {
  onStatusApplied?: (id: StatusId, instance: StatusInstance) => void;
  onStatusExpired?: (id: StatusId) => void;
  /** Called each tick with the damage the status inflicts. */
  onDotDamage?: (amount: number, id: StatusId) => void;
  isDead?: () => boolean;
}

export class StatusTracker {
  private instances = new Map<StatusId, StatusInstance>();
  private target: StatusTarget;
  /** Global multiplier applied to applied durations (mastery, elites, cycles). */
  durationMultiplier = 1;
  /** Global multiplier applied to damage over time. */
  potencyMultiplier = 1;
  /** Resistances — bosses set these to keep stuns from trivialising fights. */
  immunity = new Set<StatusId>();

  constructor(target: StatusTarget = {}) {
    this.target = target;
  }

  get all(): StatusInstance[] {
    return Array.from(this.instances.values());
  }

  has(id: StatusId): boolean {
    return this.instances.has(id);
  }

  stacks(id: StatusId): number {
    return this.instances.get(id)?.stacks ?? 0;
  }

  intensity(id: StatusId): number {
    return this.instances.get(id)?.intensity ?? 0;
  }

  clear(): void {
    this.instances.clear();
  }

  /** Removes one status outright — reactions consume what they react to. */
  remove(id: StatusId): boolean {
    if (!this.instances.has(id)) return false;
    this.instances.delete(id);
    this.target.onStatusExpired?.(id);
    return true;
  }

  apply(application: StatusApplication, sourceMultiplier = 1): boolean {
    if (this.target.isDead?.()) return false;
    const spec = STATUS_REGISTRY[application.id];
    if (!spec) return false;
    if (this.immunity.has(application.id)) return false;

    const chance = application.chance ?? 1;
    if (chance < 1 && Math.random() > chance) return false;

    const intensity = application.intensity ?? 1;
    /* Stronger applications last longer only when the status says so — the flag was
       authored on 20+ statuses and multiplied by a literal 1 (docs §B5). Clamped so a
       stacked intensity cannot become a permanent lock. */
    const intensityMult = spec.scalesWithIntensity ? Math.min(2, 1 + 0.2 * Math.max(0, intensity - 1)) : 1;
    const duration = Math.max(
      0.1,
      application.duration * this.durationMultiplier * sourceMultiplier * intensityMult,
    );
    const existing = this.instances.get(application.id);

    if (existing) {
      switch (spec.stackMode) {
        case 'stack':
          existing.stacks = Math.min(spec.maxStacks, existing.stacks + 1);
          existing.remaining = Math.max(existing.remaining, duration);
          existing.duration = Math.max(existing.duration, duration);
          existing.intensity = Math.max(existing.intensity, intensity);
          break;
        case 'strongest':
          existing.remaining = Math.max(existing.remaining, duration);
          existing.duration = existing.remaining;
          existing.intensity = Math.max(existing.intensity, intensity);
          break;
        case 'ignore':
          return false;
        default:
          existing.remaining = duration;
          existing.duration = duration;
          existing.intensity = Math.max(existing.intensity, intensity);
          break;
      }
    } else {
      const instance: StatusInstance = {
        id: application.id,
        remaining: duration,
        duration,
        intensity,
        stacks: 1,
      };
      this.instances.set(application.id, instance);
      this.target.onStatusApplied?.(application.id, instance);

      if (spec.impulse) {
        this.consumeImpulse(
          (spec.impulse + Math.max(0, intensity - 1) * 30) * sourceMultiplier,
        );
      }
    }
    return true;
  }

  /**
   * Knockback impulses queued by status application. Entities read this each
   * frame and translate it into velocity, so forces flow through physics
   * instead of teleporting the target.
   */
  pendingImpulse = 0;

  consumeImpulse(amount: number): void {
    this.pendingImpulse += amount;
  }

  /* -------- derived modifiers -------- */

  movementMultiplier(): number {
    let value = 1;
    for (const instance of this.instances.values()) {
      const spec = STATUS_REGISTRY[instance.id];
      if (spec.moveMultiplier !== undefined) value = Math.min(value, spec.moveMultiplier);
      if (instance.id === 'freeze' && instance.stacks >= 3) value = 0;
    }
    return value;
  }

  attackDisabled(): boolean {
    for (const instance of this.instances.values()) {
      if (STATUS_REGISTRY[instance.id].disablesAttack) return true;
    }
    return false;
  }

  damageTakenMultiplier(): number {
    let value = 1;
    for (const instance of this.instances.values()) {
      const spec = STATUS_REGISTRY[instance.id];
      if (spec.damageTakenMultiplier) value *= spec.damageTakenMultiplier;
      // Armour break also reduces flat mitigation, handled by the caller.
    }
    return value;
  }

  damageDealtMultiplier(): number {
    let value = 1;
    for (const instance of this.instances.values()) {
      const spec = STATUS_REGISTRY[instance.id];
      if (spec.damageDealtMultiplier) value *= spec.damageDealtMultiplier;
    }
    return value;
  }

  armorMultiplier(): number {
    return this.has('armorBreak') ? 0.6 : 1;
  }

  /** Advance all statuses. Returns damage-over-time dealt this step. */
  tick(deltaMs: number): number {
    const dt = deltaMs / 1000;
    let dotDamage = 0;
    const expired: StatusId[] = [];

    for (const [id, instance] of this.instances) {
      const spec: StatusSpec = STATUS_REGISTRY[id];
      instance.remaining -= dt;

      if (spec.dotPerSecond) {
        const stacks = spec.stackMode === 'stack' ? Math.max(1, instance.stacks) : 1;
        dotDamage += spec.dotPerSecond * instance.intensity * stacks * dt * this.potencyMultiplier;
      }

      if (instance.remaining <= 0) expired.push(id);
    }

    for (const id of expired) {
      this.instances.delete(id);
      this.target.onStatusExpired?.(id);
    }

    if (dotDamage > 0) {
      // Attribute the tick to a single dominant status for VFX readability.
      const dominant = this.all.find((entry) => STATUS_REGISTRY[entry.id].dotPerSecond);
      if (dominant) this.target.onDotDamage?.(dotDamage, dominant.id);
    }

    return dotDamage;
  }

  /** Copy status information for HUD/indicator rendering. */
  indicators(): { id: StatusId; stacks: number; ratio: number; color: number }[] {
    return this.all.map((instance) => ({
      id: instance.id,
      stacks: instance.stacks,
      ratio: instance.duration > 0 ? Math.max(0, instance.remaining / instance.duration) : 0,
      color: STATUS_REGISTRY[instance.id].color,
    }));
  }
}
