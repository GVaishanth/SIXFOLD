import { DUNGEON } from '@/config/gameConfig';
import type { DungeonPlan, DungeonSite, SiteKind } from '@/types';

export interface StripHooks {
  /** One enemy out of a grove, released now. */
  release(site: DungeonSite, x: number, y: number, index: number): void;
  /** The centre was reached, or the party is finished. The scene shows the report and freezes. */
  finish(reason: 'end' | 'death'): void;
}

/** Where the walk stands, in the only two units a labyrinth counts. */
export interface StripStage {
  /** The authored cell index, for the minimap and the save's telemetry. */
  cell: number;
  /** 1 is the centre; the outermost line is `lines`. Counted inwards, as the classical ones are. */
  line: number;
  /** The last line is crossed once the centre is reached, and then nothing else is. */
  atCenter: boolean;
}

interface PendingWake {
  site: DungeonSite;
  x: number;
  y: number;
  left: number;
  nextIn: number;
}

/**
 * Dungeon mode's pacing, replacing `WaveDirector`.
 *
 * There is no wave here. What this owns instead is the three things a wave machine was actually for:
 * staging a release so waking six is a scene and not a pop, counting what is left so the HUD can say
 * so honestly, and deciding when the run is over. It never touches the save, the wallet or mastery —
 * that is the mode's whole premise (docs/plans/2026-10-11-dungeon-mode-design.md §1).
 */
export class DungeonDirector {
  private readonly pending: PendingWake[] = [];
  private readonly spent = new Set<string>();
  private ending: 'end' | 'death' | null = null;
  /** World x the party has reached; the far side of the strip is the goal. */
  private deepest = 0;
  /**
   * Waystones the party has touched, by site id.
   *
   * A link is never revoked and a waystone is never spent: a network that closes on itself mid-run would
   * strand the party somewhere they had already been, which is worse than no network at all.
   */
  private readonly linked = new Set<string>();
  private warps = 0;

  constructor(
    private readonly plan: DungeonPlan,
    private readonly hooks: StripHooks,
  ) {
    // The spawn stone is waypoint one. `entry` is a flag the generator sets, not a distance the director
    // guesses, so a map change cannot quietly leave the mouth unlinked.
    for (const site of this.allSites) {
      if (site.kind === 'waypoint' && site.entry) this.linked.add(site.id);
    }
  }

  get allSites(): DungeonSite[] {
    return this.plan.cells.flatMap((cell) => cell.sites);
  }

  get spentCount(): number {
    return this.spent.size;
  }

  get hasPendingWakes(): boolean {
    return this.pending.length > 0;
  }

  wake(site: DungeonSite, x: number, y: number): void {
    if (site.kind !== 'grove' && site.kind !== 'den') return;
    if (this.pending.some((entry) => entry.site.id === site.id)) return;
    const count = site.kind === 'den' ? 1 : Math.max(1, site.n);
    this.pending.push({ site, x, y, left: count, nextIn: 0 });
  }

  /** A stone that has given everything it has. Spent is a fact the map keeps, not a removal. */
  spend(id: string): void {
    this.spent.add(id);
  }

  isSpent(id: string): boolean {
    return this.spent.has(id);
  }

  sitesLeft(): Record<SiteKind, number> {
    const out: Record<SiteKind, number> = { grove: 0, cache: 0, spring: 0, field: 0, den: 0, waypoint: 0 };
    for (const site of this.allSites) {
      // A waystone counts as "left" until it is linked, which is the honest reading: it is still a thing
      // the run could do. It is excluded from the HUD's untouched sum, which is about what must be dealt
      // with, and a link is not a clearance.
      if (site.kind === 'waypoint') {
        if (!this.linked.has(site.id)) out.waypoint += 1;
        continue;
      }
      if (!this.spent.has(site.id)) out[site.kind] += 1;
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Waystones                                                           */
  /* ------------------------------------------------------------------ */

  /** Every waystone in the map's own order — bands first, then the order they were placed in one. */
  get waypoints(): DungeonSite[] {
    return this.allSites.filter((site) => site.kind === 'waypoint');
  }

  get linkedCount(): number {
    return this.linked.size;
  }

  /**
   * How many times the party has jumped. The run's report counts them, and `audit:dungeonrun` reads this
   * number rather than a screenshot, because "warping is free movement" and "warping is on the record"
   * are different games and only this counter can tell them apart.
   */
  get warpCount(): number {
    return this.warps;
  }

  isLinked(id: string): boolean {
    return this.linked.has(id);
  }

  /** True on the touch that links the stone, false on every touch after it. */
  link(site: DungeonSite): boolean {
    if (site.kind !== 'waypoint' || this.linked.has(site.id)) return false;
    this.linked.add(site.id);
    return true;
  }

  /**
   * The next linked waystone after `fromId`, wrapping at the end of the chain.
   *
   * Deliberately one-way and cyclic rather than a picker: the mode has no key prompts and no tooltips, so
   * the only verb available is walking into a stone, and a hop that always moves forward along the map's
   * order is legible from the callout. Two or more hops get you anywhere you have been.
   */
  nextLinked(fromId: string): DungeonSite | null {
    const ring = this.waypoints.filter((site) => this.linked.has(site.id));
    if (ring.length < 2) return null;
    const at = ring.findIndex((site) => site.id === fromId);
    return ring[(Math.max(0, at) + 1) % ring.length] ?? null;
  }

  noteWarp(): void {
    this.warps += 1;
  }

  /** How far into the strip the party has walked, by x: depth, not progress around the route. */
  /**
   * How far into the map the party is, 0 at the mouth and 1 at the goal.
   *
   * Down a strip that is a fraction of its length. In the brain it is *how deep you have gone*: the layers
   * are nested rings, so the honest progress is which of the seven you are standing in.
   */
  progress(x: number, y?: number): number {
    const layer = y !== undefined ? this.plan.layerAt?.(x, y) : undefined;
    if (layer !== undefined && layer >= 0) {
      return Math.max(0, Math.min(1, (layer + 1) / this.plan.chunkCount));
    }
    return Math.max(0, Math.min(1, x / Math.max(1, this.plan.width - this.plan.cellWidth * 0.25)));
  }

  cellOf(x: number, y?: number): number {
    const layer = y !== undefined ? this.plan.layerAt?.(x, y) : undefined;
    if (layer !== undefined && layer >= 0) return Math.max(0, Math.min(this.plan.chunkCount - 1, layer));
    return Math.max(0, Math.min(this.plan.chunkCount - 1, Math.floor(x / this.plan.cellWidth)));
  }

  update(dt: number): void {
    if (this.ending) return;
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      const entry = this.pending[i];
      entry.nextIn -= dt;
      while (entry.nextIn <= 0 && entry.left > 0) {
        const index = entry.site.n - entry.left;
        this.hooks.release(entry.site, entry.x, entry.y, index);
        entry.left -= 1;
        entry.nextIn += DUNGEON.groveStepMs;
      }
      if (entry.left <= 0) {
        this.spend(entry.site.id);
        this.pending.splice(i, 1);
      }
    }
  }

  /**
   * The run's one condition: touch the centre. Not the far wall, and not every stone — a labyrinth is
   * finished when you arrive, and what you collected on the way is the score.
   */
  reachedCenter(x: number, y: number): boolean {
    return Math.hypot(x - this.plan.goal.x, y - this.plan.goal.y) <= DUNGEON.goalRadius;
  }

  /**
   * Which circuit the party is on, counting from the outside in.
   *
   * `chunks + 1` lines for `chunks` cells, because the centre is a line of its own: six cells of
   * switchback plus the middle is the seven-line figure the reference drawing is.
   */
  stage(x: number, y: number): StripStage {
    // The strip's circuits are columns, so x alone says which one you are in. The brain's layers are nested
    // rings, so the honest answer is "whichever band this tile belongs to", and the plan knows that.
    const cell = this.cellOf(x, y);
    const atCenter = this.reachedCenter(x, y);
    return { cell, atCenter, line: atCenter ? 1 : this.plan.chunkCount + 1 - cell };
  }

  /** Lines in this strip's labyrinth, for the HUD's denominator. */
  get lines(): number {
    return this.plan.chunkCount + 1;
  }

  finish(reason: 'end' | 'death'): void {
    if (this.ending) return;
    this.ending = reason;
    this.hooks.finish(reason);
  }

  get endingReason(): 'end' | 'death' | null {
    return this.ending;
  }

  get furthestX(): number {
    return this.deepest;
  }

  noteDepth(x: number): void {
    this.deepest = Math.max(this.deepest, x);
  }
}
