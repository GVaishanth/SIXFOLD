import type { DungeonChunk, DungeonPlan, DungeonProp, DungeonSite, SiteKind } from '@/types';
import { cacheTableId } from './map';
import { CORTEX_FISSURE } from './cortexMask';
import { buildCortex, type Cortex } from './cortex';

/**
 * The brain, in the shape the dungeon scene already speaks.
 *
 * `planStrip` lays a strip out: N cells side by side, a spine through the middle, a circuit per cell. That
 * is why the dungeon read as a horizontal corridor no matter how careful the mask was — the *plan* was a
 * strip, and the scene draws what the plan says. This module hands the same scene a different plan: the
 * whole organ as one cell, its walls as the merged rectangles the derivation measured, and the seven
 * layers as seven `cells` whose only job is to hold the sites and the route of their band.
 *
 * Two rules keep the two plans honest with each other:
 *
 *   1. **Nothing here invents geometry.** Every wall, spawn, route point and site is read out of
 *      `buildCortex()`, which is generated from `assets/brain-source.png` and gated by `audit:cortex`. The
 *      scene asking "is this tile stone" and the gate asking it get the same answer because they read the
 *      same array.
 *   2. **Positions are fractions of the world, not of a cell.** `cellWidth` is the world's width and every
 *      site's `chunk` is 0, so the scene's `site.fx * cellWidth + chunk * cellWidth` arithmetic — used in
 *      about a dozen places — lands on the right tile without a single one of them needing to know the map
 *      stopped being a strip.
 */

/**
 * Two sites are never this close, measured along the map rather than across it.
 *
 * Three tiles is the floor the frame sets: a wave-sized view is 5 × 3.13 tiles of corridor, and at the five
 * this started on a sample of route positions put a stone in about half the frames — "the dungeon is empty"
 * with better manners. Three keeps a sight of anything in every frame while leaving the gap the wall and drop
 * rules need (`DUNGEON.minSiteGap` is 104px, and three tiles at 64px is 192px of clearance).
 */
const SITE_SPACING_TILES = 3;

/** The kinds a band gets, in the order the rng spends them: dens want chambers, groves want dead ends. */
const GROVE: SiteKind = 'grove';
const DEN: SiteKind = 'den';
const SPRING: SiteKind = 'spring';
const CACHE: SiteKind = 'cache';
const FIELD: SiteKind = 'field';
const WAYPOINT: SiteKind = 'waypoint';

export interface CortexPlanOptions {
  /** Kept for call-site symmetry with `planStrip`; the brain is derived, so a seed only scatters sites. */
  seed?: number;
  biome?: number;
}

/** A tiny xorshift, because the strip's rng lives in map.ts and this file must not depend on its stream. */
function rng(seed: number): () => number {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
}

function farthest(points: { x: number; y: number }[], from: { x: number; y: number }) {
  let best = points[0];
  let bestD = -1;
  for (const p of points) {
    const d = (p.x - from.x) ** 2 + (p.y - from.y) ** 2;
    if (d > bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/**
 * Pick `want` tiles from `pool` at least `minGap` apart, greedily keeping the most spread-out candidate at
 * each step. This is the same farthest-point idea `placeSite` uses for the strip, and it is what stops a
 * band's four groves from landing on one another inside a single fold.
 */
function spread(pool: { x: number; y: number }[], want: number, minGap: number): { x: number; y: number }[] {
  const chosen: { x: number; y: number }[] = [];
  let remaining = pool;
  for (let k = 0; k < want && remaining.length; k += 1) {
    const next =
      chosen.length === 0
        ? remaining[Math.floor(remaining.length / 2)]
        : farthest(
            remaining.filter((p) => chosen.every((c) => Math.abs(c.x - p.x) + Math.abs(c.y - p.y) >= minGap)),
            chosen[chosen.length - 1],
          ) ?? remaining[0];
    if (!next) break;
    chosen.push(next);
    remaining = remaining.filter((p) => p !== next && chosen.every((c) => Math.abs(c.x - p.x) + Math.abs(c.y - p.y) >= minGap));
  }
  return chosen;
}

/** Every walkable tile of a band, in tile coordinates. */
function bandTiles(cortex: Cortex, band: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const floor = cortex.layers[band]?.floor;
  if (!floor) return out;
  for (let i = 0; i < floor.length; i += 1) {
    if (!floor[i]) continue;
    const x = i % cortex.cols;
    out.push({ x, y: (i - x) / cortex.cols });
  }
  return out;
}

export function planCortex(seed = 20261012, options: CortexPlanOptions = {}): DungeonPlan {
  const cortex = buildCortex();
  const { cols, rows, tilePx } = cortex;
  const width = cols * tilePx;
  const height = rows * tilePx;
  const random = rng(seed);
  const biome = options.biome ?? 1;

  const cells: DungeonChunk[] = [];
  for (let index = 0; index < cortex.layers.length; index += 1) {
    const layer = cortex.layers[index];
    const tiles = bandTiles(cortex, index);
    if (!tiles.length) {
      continue;
    }
    // A chamber is a room, so a chamber gets something to fight for. Bands with no chamber of their own
    // still get groves: the folds they hold are where the run spends its time.
    const chambers = cortex.chambersIn?.(index) ?? [];
    const sites: DungeonSite[] = [];
    const used: { x: number; y: number }[] = [];
    const take = (kind: SiteKind, at: { x: number; y: number }, n: number) => {
      used.push(at);
      sites.push({
        id: `b${index}s${sites.length}-${kind}`,
        kind,
        chunk: 0,
        fx: (at.x + 0.5) / cols,
        fy: (at.y + 0.5) / rows,
        n,
      });
    };
    const nearestUnused = (pool: { x: number; y: number }[]) =>
      pool.find((p) => used.every((u) => Math.abs(u.x - p.x) + Math.abs(u.y - p.y) >= SITE_SPACING_TILES));

    // "Deeper you go, harder it gets" is one number: the band's index, spent on everything the band holds.
    // How many stones stand in a fold, how many a grove wakes, how many dens a band is allowed, how many
    // caches are worth the walk and how hard a field bites are all functions of it — so the sixth line of
    // the labyrinth is not the first line repainted. The gate (`audit:cortex`) requires the totals to be
    // monotonic in `index`, which is the only way this sentence stays true after someone edits a constant.
    const depth = cortex.layers.length > 1 ? index / (cortex.layers.length - 1) : 0;
    const grovesWanted = 3 + Math.round(depth * 5);
    const groveSize = 4 + Math.round(depth * 7);
    const denSize = 3 + Math.round(depth * 3);
    const densWanted = chambers.length > 1 ? 1 + Math.round(depth * (chambers.length - 1)) : 1;
    const cachesWanted = 1 + (index >= 2 ? 1 : 0) + (index >= 4 ? 1 : 0) + (index >= 6 ? 1 : 0);
    const fieldsWanted = 1 + (index >= 3 ? 1 : 0) + (index >= 5 ? 1 : 0);
    const fieldIntensity = +(1 + depth * 0.8).toFixed(2);

    const freeTiles = () =>
      tiles.filter((p) => used.every((u) => Math.abs(u.x - p.x) + Math.abs(u.y - p.y) >= SITE_SPACING_TILES));
    /**
     * Stones belong where the walk goes.
     *
     * Scattering sites over a band's floor is geometrically honest and experientially empty: at the frame
     * every scene shares — 320 world pixels across — a grove four tiles off the corridor is not content you
     * might find, it is content you will never see. So the pools below are the band's own route polyline, and
     * the band's floor is only the overflow. A den keeps its room: a room is a place you walk to on purpose,
     * and a den in a fold is a fight you cannot see coming or prepare for.
     */
    // One polyline for three readers. `plan.route` is the walk the run takes, the corridor the partner's
    // `corridorStep` follows, and the line the renderer draws — so a band's sites are cut from *that* path.
    // Snapping them to the band's own `layer.path` instead is the mistake this comment exists to prevent: a
    // grove on the band's path but off the walk is content the warden never passes, and an errand the courier
    // cannot finish, which is how the delivery gate came to watch the partner stand still against a wall for
    // nine seconds with an orb rotting 203px away. A band too thin for the walk to spend time in falls back.
    const walkTiles = (cortex.walk?.path ?? []).filter((p) => cortex.bandAt(p.x, p.y) === index);
    const routeTiles: { x: number; y: number }[] =
      walkTiles.length >= 12 ? walkTiles : layer.path.length ? layer.path : tiles;
    /**
     * Pull a spot onto the corridor if it drifted off it, and off the spawn tile if it landed there.
     *
     * Two faults in one. A site three tiles sideways is invisible at the shared frame, which is the whole
     * complaint this placement rule exists to answer. And a site *on* the warden's own tile starts the run
     * with their body inside a 14px immovable stone: the first eastward step pushes them off it, which reads
     * as the wall sliding under them and once cost a physics gate its pass. A stone you spawn inside is also
     * a stone you cannot look at, which is a poor way to introduce the one object the run can teleport on.
     */
    const onCorridor = (p: { x: number; y: number }) => {
      let best = p;
      let bestD = Number.POSITIVE_INFINITY;
      for (const q of routeTiles) {
        const d = Math.abs(q.x - p.x) + Math.abs(q.y - p.y);
        if (d < bestD) {
          bestD = d;
          best = q;
        }
      }
      let out = bestD > 2 ? best : p;
      if (index === 0 && out.x === cortex.walk?.entry?.x && out.y === cortex.walk?.entry?.y) {
        const nxt = layer.path[Math.min(1, layer.path.length - 1)] ?? out;
        out = nxt === out ? { x: out.x + 1, y: out.y } : nxt;
      }
      return out;
    };
    /** A spot on the corridor if the corridor has room for one, anywhere on the floor if it does not. */
    const spotNear = () => nearestUnused(routeTiles) ?? nearestUnused(tiles);
    /**
     * The corridor's content, in walking order.
     *
     * Spreading sites by straight-line distance is the mistake that made this whole pass necessary: two stones
     * six tiles apart across a fold are forty apart *along the walk*, and the run only ever sees the walk, so a
     * band can be geometrically crowded and experientially empty. `routeTiles` is this band's slice of
     * `plan.route` in the order the walk takes it, so consuming it at a fixed stride puts something in front of
     * the warden every `stride` tiles of ground — which is the answer to "the dungeon is empty", and the one the
     * audit measures. The cursor is shared by every kind, so caches and groves alternate instead of queueing up
     * at the band's mouth, and it starts a stride in rather than at zero, so the first site of a band is not
     * always the first tile of its walk.
     */
    const stride = Math.max(
      SITE_SPACING_TILES,
      Math.floor(routeTiles.length / Math.max(1, grovesWanted + cachesWanted + fieldsWanted + 3)),
    );
    let arcCursor = Math.floor(routeTiles.length / 8);
    const nextAlong = () => {
      for (let k = 0; k < routeTiles.length; k += 1) {
        arcCursor = (arcCursor + stride) % routeTiles.length;
        const p = routeTiles[arcCursor];
        if (!p) continue;
        if (used.some((u) => Math.abs(u.x - p.x) + Math.abs(u.y - p.y) < SITE_SPACING_TILES)) continue;
        if (index === 0 && p.x === cortex.walk?.entry?.x && p.y === cortex.walk?.entry?.y) continue;
        return p;
      }
      return null;
    };
    /** `take` with the per-kind extras, because sites are built in one place and the fields differ. */
    const takeAt = (kind: SiteKind, at: { x: number; y: number }, n: number, extra: Partial<DungeonSite> = {}) => {
      take(kind, at, n);
      if (Object.keys(extra).length) Object.assign(sites[sites.length - 1], extra);
    };

    // The network first, before anything else spends the corridor: a band whose walk is crowded is a band
    // where the waystone loses the spacing race and simply is not placed, and a line of the labyrinth with no
    // stone on it is a hole in the one thing the run uses to come back.
    if (index === 0) {
      // One tile in from the mouth, not on it: see `onCorridor`. The warden starts *beside* the stone that owns
      // their network, which is also how a player learns it is a different kind of object.
      const spawnTile = cortex.walk?.entry;
      const at =
        routeTiles.find((q) => !spawnTile || q.x !== spawnTile.x || q.y !== spawnTile.y) ??
        cortex.walk?.entry ??
        layer.entry ??
        tiles[0];
      if (at) takeAt(WAYPOINT, at, 0, { entry: true });
    }
    // Two more per line, up the walk at the band's own stride: a network whose stones are all bunched at one
    // end is a network you still have to walk.
    for (let k = 0; k < 2; k += 1) {
      const p = nextAlong();
      if (p) takeAt(WAYPOINT, p, 0);
    }

    if (chambers.length) {
      // Roundness first: a square room reads as a den at a glance, and a deep band with three chambers is a
      // deep band that has more than one thing guarding it.
      const rooms = chambers.slice().sort((a, b) => b.roundness - a.roundness).slice(0, densWanted);
      for (const room of rooms) {
        const pool = freeTiles();
        if (!pool.length) break;
        // A mirrored pair of rooms carries the bounds of both halves, so its centre can fall in the sealed
        // cleft. A den inside a wall is a den nobody can reach, so the site walks to the nearest floor tile.
        const centre = { x: Math.round(room.cx), y: Math.round(room.cy) };
        const near = (p: { x: number; y: number }) => Math.abs(p.x - centre.x) + Math.abs(p.y - centre.y);
        takeAt(DEN, pool.reduce((best, p) => (near(p) < near(best) ? p : best), pool[0]), denSize);
      }
    }
    for (let k = 0; k < grovesWanted; k += 1) {
      const p = nextAlong();
      if (!p) break;
      take(GROVE, p, groveSize);
    }
    const spring = nextAlong() ?? spotNear();
    if (spring) take(SPRING, onCorridor(spring), 0);
    // A band with no cache is a band the ledger never hears about, and a band with no field is a band with
    // nothing to clear: the run's own bookkeeping counts these, so they have to be derived too.
    for (let k = 0; k < cachesWanted; k += 1) {
      const spot = nextAlong() ?? spotNear();
      if (!spot) break;
      takeAt(CACHE, onCorridor(spot), 1, { tableId: cacheTableId(biome) });
    }
    for (let k = 0; k < fieldsWanted; k += 1) {
      const spot = nextAlong() ?? spotNear();
      if (!spot) break;
      takeAt(FIELD, onCorridor(spot), 1, { intensity: fieldIntensity });
    }
    // (The waystones for this band were placed above, before the rest of the corridor was spent.)

    const props: DungeonProp[] = [];
    for (const p of spread(tiles, 6, 7)) {
      props.push({ fx: (p.x + 0.5) / cols, fy: (p.y + 0.5) / rows, variant: Math.floor(random() * 4) });
    }

    cells.push({
      index,
      // Inert for the brain: the strip's renderer reads these fractions to paint its spine, and the cortex
      // plan paints walls from `plan.walls` instead. It stays on the type because the gate and the ground
      // both touch `cells[i].circuit`, and a plan that is missing half its shape is a plan that lies.
      circuit: {
        spine: { fy0: 0.5, fy1: 0.5 },
        gapFx: 0.5,
        spineEndFx: 1,
        toothFx: 0.5,
        laneTopFy: 0.25,
        laneBottomFy: 0.75,
        entersTop: index % 2 === 0,
        goal: layer.goal ? { fx: (layer.goal.x + 0.5) / cols, fy: (layer.goal.y + 0.5) / rows } : null,
        route: layer.path.map((p) => ({ fx: (p.x + 0.5) / cols, fy: (p.y + 0.5) / rows })),
      },
      biome,
      groundVariant: index % 3,
      awakeBudget: sites.reduce((sum, s) => sum + s.n, 0),
      sites,
      props,
    });
  }

  return {
    seed,
    chunkCount: cells.length,
    // One cell across the whole brain: see rule 2 above.
    cellWidth: width,
    cellHeight: height,
    width,
    height,
    goal: { x: (cortex.walk.goal.x + 0.5) * tilePx, y: (cortex.walk.goal.y + 0.5) * tilePx },
    cells,
    walls: cortex.rects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })),
    voidRuns: cortex.voidRuns.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })),
    // The division, in world pixels, with the rows its doorways sit on: the plan carries it so that a check
    // can park the warden beside the cleft instead of trusting a comment about it.
    fissure: {
      x: (CORTEX_FISSURE.col + 0.5) * tilePx,
      halfWidth: 2.5 * tilePx,
      tilePx,
      // The seam between the two bridge rows, not the centre of the first: the doorway is `bridgeRows` tiles
      // deep, and a test parked on the wrong row measures the wall next to it.
      doorRows: CORTEX_FISSURE.crossings.map((row) => (row + 1) * tilePx),
    },
    spawn: { x: (cortex.walk.entry.x + 0.5) * tilePx, y: (cortex.walk.entry.y + 0.5) * tilePx },
    route: cortex.walk.path.map((p) => ({ x: (p.x + 0.5) * tilePx, y: (p.y + 0.5) * tilePx })),
    layerAt: (x, y) => cortex.layerAt(x, y),
  };
}

/** Where the guide stands: the middle of the deep end, so the player walks *into* the brain to follow it. */
export function cortexGuide(plan: DungeonPlan): { x: number; y: number } {
  return plan.route?.[Math.floor(plan.route.length * 0.72)] ?? plan.goal;
}

/**
 * The charts: three of them, lying on the walk inward, one in each third of it.
 *
 * Not one per site — the strip's `chartSpots` plants one per other cell for the same reason. A chart is the
 * thing that turns a labyrinth into a place you can finish, so it has to be *found*: three is a promise that a
 * run that explores is rewarded, and thirty-seven is a HUD switched on before anything was done.
 */
export function cortexCharts(plan: DungeonPlan): { x: number; y: number; cell: number }[] {
  const route = plan.route ?? [];
  if (!route.length) return [];
  const out: { x: number; y: number; cell: number }[] = [];
  for (const fraction of [0.2, 0.55, 0.85]) {
    const p = route[Math.min(route.length - 1, Math.floor(route.length * fraction))];
    out.push({ x: p.x, y: p.y, cell: plan.layerAt ? plan.layerAt(p.x, p.y) : 0 });
  }
  return out;
}
