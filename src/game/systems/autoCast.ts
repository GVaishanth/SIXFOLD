import { AUTO_CAST } from '@/config/gameConfig';
import { ELEMENT_REGISTRY } from '@/data/elements';
import { masteryLevelFromXp } from '@/game/systems/elementProgression';
import type { ElementId } from '@/types';

export interface AutoCastTarget {
  x: number;
  y: number;
}

export interface AutoCastHooks {
  /** The closest living thing this element could shoot, or null when the arena is empty. */
  pickTarget(from: AutoCastTarget, radius: number): AutoCastTarget | null;
  /** XP banked in that element, so accuracy follows the same mastery curve as everything else. */
  xpOf(element: ElementId): number;
  /** Ask the warden to fire this element. Returns false when it refused (frozen, dead, silenced). */
  cast(element: ElementId, target: AutoCastTarget | null, accuracy: number): boolean;
}

/** One support slot as the HUD sees it. */
export interface AutoCastSlot {
  slot: number;
  element: ElementId;
  level: number;
  accuracy: number;
  /** 0 just fired, 1 ready to fire again. */
  charge: number;
}

interface Cycle {
  /** The element this slot is currently supporting; a change here resets the timer. */
  element: ElementId;
  startedAt: number;
  readyAt: number;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * Accuracy of a support cast at a given mastery level. Exported so the loadout
 * screen and the rig quote the same number instead of two files agreeing by luck.
 */
export function autoCastAccuracy(level: number): number {
  return Math.min(
    AUTO_CAST.maxAccuracy,
    AUTO_CAST.baseAccuracy + AUTO_CAST.accuracyPerLevel * Math.max(0, level - 1),
  );
}

/**
 * Milliseconds between support casts of one element at one mastery level: the
 * element's own attack cooldown, stretched by `intervalScale`, clamped to the
 * configured window, then shortened by mastery like the manual shot is.
 */
export function autoCastInterval(cooldownSeconds: number, level: number): number {
  const base = Math.max(
    AUTO_CAST.intervalMinMs,
    Math.min(AUTO_CAST.intervalMaxMs, Math.max(0.08, cooldownSeconds) * 1000 * AUTO_CAST.intervalScale),
  );
  const speedup = Math.min(AUTO_CAST.maxSpeedup, AUTO_CAST.levelSpeedup * Math.max(0, level - 1));
  return base / (1 + speedup);
}

/**
 * The support half of a six-element loadout.
 *
 * The player drives the active element entirely. Every other equipped element is
 * cast here: it finds its own target, keeps its own cooldown, and spends no
 * energy — so the extra weapons never compete with the player's own shot for
 * resources, and the loadout screen's "AUTO" marker is the whole contract.
 *
 * Accuracy is a real roll, not a label: the cast always happens (the element
 * still reacts, still applies its status when it connects) but a low-confidence
 * cast is aimed with a spread the player can see miss. Mastery narrows that
 * spread and shortens the cycle, which is what makes the 50% base worth buying
 * XP for.
 */
export class AutoCastDirector {
  /** One cycle per support slot; a slot the player drives has no entry at all. */
  private cycles = new Map<number, Cycle>();
  private clock = 0;
  private report: AutoCastSlot[] = [];

  /**
   * Re-wire the rig. Called on loadout changes and on every manual element
   * switch, because switching hands moves which elements are support. Cycles are
   * staggered by slot so equipping five elements at once cannot put every cast
   * on the same frame.
   */
  setLoadout(slots: (ElementId | null)[], activeSlot: number, xpOf?: (element: ElementId) => number): void {
    if (!AUTO_CAST.enabled) {
      this.cycles.clear();
      this.report = [];
      return;
    }
    slots.forEach((element, index) => {
      const existing = this.cycles.get(index);
      if (!element || index === activeSlot) {
        this.cycles.delete(index);
        return;
      }
      if (existing && existing.element === element) return;
      const interval = this.intervalFor(element, this.levelOf(element, xpOf));
      const start = this.clock + (index * interval) / Math.max(2, slots.length);
      this.cycles.set(index, { element, startedAt: start, readyAt: start + interval });
    });
  }

  private levelOf(element: ElementId, xpOf?: (element: ElementId) => number): number {
    return xpOf ? masteryLevelFromXp(xpOf(element)) : 1;
  }

  private intervalFor(element: ElementId, level: number): number {
    return autoCastInterval(ELEMENT_REGISTRY[element]?.attack.cooldown ?? 0.5, level);
  }

  private accuracyFor(level: number): number {
    return autoCastAccuracy(level);
  }

  /**
   * The element the player is driving is never auto-cast; everything equipped
   * beside it is. Slot index travels with the element because the same element
   * can legitimately sit in two slots and each keeps its own cycle.
   */
  private candidates(): { slot: number; element: ElementId; cycle: Cycle }[] {
    const out: { slot: number; element: ElementId; cycle: Cycle }[] = [];
    for (const [slot, cycle] of this.cycles) out.push({ slot, element: cycle.element, cycle });
    return out.sort((a, b) => a.slot - b.slot);
  }

  update(deltaMs: number, origin: AutoCastTarget, hooks: AutoCastHooks): void {
    if (!AUTO_CAST.enabled) return;
    this.clock += deltaMs;
    let budget = AUTO_CAST.castsPerCycle;
    const xpOf = hooks.xpOf;

    for (const { element, cycle } of this.candidates()) {
      const level = this.levelOf(element, xpOf);
      const interval = this.intervalFor(element, level);
      if (budget <= 0) {
        // A frame where the rig was busy: the cycle continues, it does not restart.
        continue;
      }
      if (this.clock < cycle.readyAt) continue;

      const target = hooks.pickTarget(origin, AUTO_CAST.range);
      if (!target) {
        cycle.startedAt = this.clock;
        cycle.readyAt = this.clock + AUTO_CAST.retryMs;
        continue;
      }

      const accuracy = this.accuracyFor(level);
      if (!hooks.cast(element, target, accuracy)) {
        // Refused (silenced, dead, mid-death): try again soon rather than dumping the cycle.
        cycle.startedAt = this.clock;
        cycle.readyAt = this.clock + 360;
        continue;
      }
      budget -= 1;
      cycle.startedAt = this.clock;
      cycle.readyAt = this.clock + interval;
    }

    this.report = this.candidates().map(({ slot, element, cycle }) => {
      const interval = Math.max(1, cycle.readyAt - cycle.startedAt);
      return {
        slot,
        element,
        level: this.levelOf(element, xpOf),
        accuracy: this.accuracyFor(this.levelOf(element, xpOf)),
        charge: clamp01((this.clock - cycle.startedAt) / interval),
      };
    });
  }

  /** Snapshot for the HUD rail. Fresh objects, published on the 12 Hz beat. */
  summary(): AutoCastSlot[] {
    return this.report.map((entry) => ({ ...entry }));
  }

}
