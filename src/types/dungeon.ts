/**
 * Dungeon mode — the data contract for a generated strip.
 *
 * Everything here is plain data on purpose: the generator (`game/dungeon/map.ts`) is pure, so a node
 * script can assert the map's invariants without a browser, and the scene is the only place that turns
 * fractions into world pixels.
 */
import type { HazardKind } from './world';

/** What can stand on a chunk. One prop, three jobs — see docs §H design. */
/**
 * `waypoint` is the sixth: a waystone, which holds nothing and wakes nothing. It links on the first touch
 * and hops the party to the next linked one after that, so it is the only kind that is never `spent` —
 * the network has to stay open for the whole run or the walk back is a lie.
 */
export type SiteKind = 'grove' | 'cache' | 'spring' | 'field' | 'den' | 'waypoint';

/** A stone's life: nothing yet, waking something, and spent (which is scenery, not an obstacle). */
export type StoneState = 'dormant' | 'active' | 'spent';

/**
 * The partner's states, one decision per thinking tick at most.
 *
 * `fetching` is the courier job: it has an orb in hand and wants to put it at the warden's feet,
 * which in a one-path labyrinth is a real choice rather than a sprite that trails you.
 */
export type AllyState = 'following' | 'engaging' | 'fleeing' | 'fetching' | 'downed';

/** One circuit of the labyrinth: the walls that make the walk bend, and the route that bends. */
export interface DungeonCircuit {
  /** Which lane the walk enters this cell in. It alternates, so every other cell forces a crossing. */
  entersTop: boolean;
  /** Where the spine lets you cross, and the tooth in the entering lane that makes you use it. */
  gapFx: number;
  toothFx: number;
  /** The spine's band, as fractions of the cell height; the lanes are the gaps above and below it. */
  spine: { fy0: number; fy1: number };
  laneTopFy: number;
  laneBottomFy: number;
  /** Where the spine stops. Less than 1 only in the last cell, and the merge is the centre. */
  spineEndFx: number;
  /** The centre of the labyrinth, in the last cell only. Reaching it is the run's goal. */
  goal: { fx: number; fy: number } | null;
  /** The corridor's polyline, cell fractions: the only place stones and drops may go. */
  route: { fx: number; fy: number }[];
}

export interface DungeonSite {
  /** Stable across a run, derived from seed + chunk + slot, so the scene can key bodies by it. */
  id: string;
  kind: SiteKind;
  chunk: number;
  /** Fraction of the cell, never of the strip — see the note in `game/dungeon/map.ts`. */
  fx: number;
  fy: number;
  /** Grove: how many enemies it wakes. Den: 1 elite or the floor's mini-boss. Spring: charges. */
  n: number;
  /**
   * Waypoint only, and only once per map: the stone the run spawns beside.
   *
   * The director links it before the first step, which is what makes the mouth's waystone waypoint one — a
   * flag rather than a position match, because "nearest site to `plan.spawn`" is a fact that a generator
   * change can silently invalidate and a flag cannot.
   */
  entry?: boolean;
  /** Cache only: a `DROP_TABLES` id the generator has already proven resolves. */
  tableId?: string;
  /** Den only: the biome's mini-boss, when the den is meant to hold one. */
  bossId?: string;
  /** Field only: multiplier on the biome's authored hazard intensity. */
  intensity?: number;
  /** Field only: the biome's hazard kind, at raised intensity for a band of ground. */
  hazard?: HazardKind;
}

export interface DungeonProp {
  fx: number;
  fy: number;
  /** Index into the biome's prop family variants. */
  variant: number;
}

export interface DungeonChunk {
  index: number;
  /** The circuit's walls and route — one source of truth for the renderer, the physics and the gate. */
  circuit: DungeonCircuit;
  /** `FLOOR_REGISTRY` key, i.e. the biome this cell is drawn and populated from. */
  biome: number;
  groundVariant: number;
  /** Σ of every grove's `n`, so the scene can trust the awake budget without re-adding. */
  awakeBudget: number;
  sites: DungeonSite[];
  props: DungeonProp[];
}

export interface DungeonPlan {
  seed: number;
  chunkCount: number;
  /** One cell: `worldFrame`'s size at the moment the run began. */
  cellWidth: number;
  cellHeight: number;
  /** The strip's extent, which is what the camera bounds and the clamps use instead of the frame. */
  width: number;
  height: number;
  /** The labyrinth's centre in world pixels — the run's goal, not the far wall. */
  goal: { x: number; y: number };
  cells: DungeonChunk[];
  /**
   * Brain plan only: the walls, already merged into rectangles in world pixels. When this is present the
   * ground paints and collides *these* and ignores the per-cell circuit geometry, because the brain's walls
   * are the folds themselves rather than a spine somebody drew over them.
   */
  walls?: { x: number; y: number; w: number; h: number }[];
  /** Brain plan only: the space outside the organ, as row runs. Painted as background, not tiled. */
  voidRuns?: { x: number; y: number; w: number; h: number }[];
  /** Brain plan only: the division, in world pixels, and the rows its doorways sit on. */
  fissure?: { x: number; halfWidth: number; tilePx: number; doorRows: number[] };
  /** Brain plan only: the first tile of the walk, in world pixels. */
  spawn?: { x: number; y: number };
  /** Brain plan only: the route through the organ, in world pixels. */
  route?: { x: number; y: number }[];
  /** Brain plan only: which of the seven layers a world point stands in, or -1 in stone. */
  layerAt?(x: number, y: number): number;
}
