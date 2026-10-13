# The cortex dungeon: what was built, what it measures, what is still wrong

Written 2026-10-12, at the end of the "it still looks like a strip" redesign. This is the working note for
whoever picks it up next; the design brief lives in `2026-10-11-dungeon-mode-design.md` §7.

## The one-sentence version

The dungeon's layout is no longer authored as a corridor with rooms hung off it. It is measured out of
`assets/brain-source.png` — a top-down drawing of a human brain — by `tools/cortex.mjs`, gated by
`npm run audit:cortex`, written into `src/game/dungeon/cortexMask.ts`, read at runtime by
`src/game/dungeon/cortex.ts`, turned into the scene's own plan by `src/game/dungeon/cortexPlan.ts`, and drawn
and collided by `src/game/dungeon/ground.ts`. A strip plan is a strip no matter what the wallpaper says, so
the strip's `DungeonPlan` was replaced, not decorated.

## The rules the derivation obeys

| Picture fact | Dungeon fact |
| --- | --- |
| ink (the sulci, the drawn lines) | walkable corridors |
| white between the lines (the gyri) | solid ridge, and the *biggest, roundest* blobs of it open as chambers |
| the longitudinal fissure | **wall**, five tiles wide, running the whole body, crossed only at doorways |
| distance from the brain's own edge | the seven layers, as rank-slices of the depth field |
| outside the outline | void: not floor, not painted, not walkable |

Consequences that were learned the hard way (all of these are in `tools/cortex.mjs` as comments too):

* **The fissure has to be wall.** A walkable midline is a hallway both halves share, which is not a division.
  So the cleft is solid `cleftWidth` tiles with `crossingsPerLayer` doorways per band, and no chamber
  straddles it. This is also what makes "carefully placed connections between adjacent regions" literal.
* **Layers are regions of one walk, not seven maps.** Cutting each band into a connected island of its own
  needed ~900 carved doorway tiles per band — geometry I invented rather than measured — and still left 30
  fragments. Now the bands are labels on a single connected brain, the run's layer counter reads the band
  under the warden's feet, and the gate asserts the two things that matter: the brain is one walkable piece,
  and every boundary between bands is crossed.
* **Equal-count rank slices, not depth thresholds.** The chamfer distance over sparse 1-px grooves has huge
  tie groups; thresholds dumped 3.3k tiles into layer 0 and 200 into layer 2.
* **Mirror the ink, never the floor.** Union-ing both halves after dilation fattened the labyrinth (walkable
  58% → 74%, a white disc with holes). One half is derived, mirrored *before* the single dilation, skipping
  tiles within 2 columns of the axis so the cleft keeps its walls.
* **Chambers are gyri, not wide grooves.** At thin corridors a width rule finds one room; component-labelling
  the ridge set and filtering by area/span/aspect/roundness finds 14, mean roundness 0.77 (a disc is 0.79).
* **A tile is 160 world px.** Two constraints pull on this number and both are recorded, because they
  disagree. At 64 a three-stroke groove became a five-wardens-wide hall — a ballroom, not a sulcus — which
  argues for small. Tunneling argues for large: Arcade separates bodies by pushing the overlap out, so a
  mover that travels further in one frame than a wall is thick can arrive on the far side of it with nothing
  left to resolve, and a body 14px wide sitting on a 32px ridge reads as *inside the wall* while it stands
  in the corridor beside it. Fold **widths** are measured in tiles, so the map's shape is untouched by the
  choice; what it moves is the px extent, and therefore the framing: at zoom 1 a screen now shows 8 tiles
  where it showed 40. The dials are the camera's zoom (0.2 would restore the old view and render 8px sprites)
  or the multiplier itself. Neither is pulled here, because the map's approved look and the physics margin
  cannot both be bought with the same knob.
* **Nothing may be sized by the world.** A `tileSprite` over a canvas-backed texture makes Phaser allocate a
  source of the sprite's size, so the strip's per-cell floor — one TileSprite the width of a cell and the
  height of the plan — was quietly allocating a world-sized canvas: 23 megapixels at 32px tiles, and at
  160 **651**, which the browser answered with `getImageData: Out of memory` thrown out of `DungeonGround.build`
  mid-frame, taking the rest of `create()` and every later check with it. The brain plan now paints its floor
  as one viewport-sized field that follows the camera, with `tilePosition` holding the art still in world
  space. Any future art layer that wants "the whole map" must be indexed by the camera, not by the plan.
* **Void is background, not wall paint.** Merging the void into the wall list made the map a brown rectangle
  you could only recognise by walking its edge. `solid !== 0` became `solid === 1`, the ground paints the
  void's row-runs in the biome's `bg`, and the outline's own ridge ring is what stops the warden — which is
  only safe because the gate proves no fold touches the void.

## What it measures today

`npm run derive:cortex -- --mask` (all numbers below are from that run):

```
source box 105×117 px · aspect h/w 1.114 · body fill 83.3% of the box
walkable 4842 of 10228 brain tiles = 47.3%
14 chambers 13×19 … 7×9 · mean roundness 0.77 · 471 tiles opened
14 doorways across the cleft · cleft 106 rows of 117
corridor widths outside rooms: median 1.3 tiles · p90 2 · max 4.7
thinnest merged wall body: 160px = 1.00 tile, i.e. 4.7× the 34px a clamped frame can carry
hemispheres 2417 left / 2405 right · ratio 1.005 · 10 stranded folds (222 tiles) turned back into ridge
strata 685 / 647 / 801 / 587 / 639 / 888 / 595 tiles
world 27520×23680 px (172×148 tiles at 160), 1144 merged wall bodies, 52 sites, route 255 tiles
thinnest wall body 160px against 34px per clamped frame (4.7×), a corridor at the median fold width 208px
```

Gates: **`audit:cortex` 33/33** (and **31/33** when re-derived at 32px — the crossing margin drops to 0.9×),
`audit:dungeon` 59/59, `audit:achievements` 27/27, `audit:counter` 16/16, `audit:brain` 14/14 (superseded,
still green), typecheck and build clean, `audit:fit` 65 measured / 0 FAIL. `audit:dungeonrun` is
**103 passed, 0 failed, 0 info**, with four woken hostiles in the wall-stress sample.

## What the five partner faults turned out to be

All five were real, and three of the five were the gate lying. The account matters more than the fix, because
the wrong readings survived four plausible repairs.

1. **The gate's wall predicate did not exist in the page.** `buriedIn` is defined at Node scope in
   `tools/dungeon-run.mjs` and was called from inside `page.evaluate` — a `ReferenceError` in the browser,
   swallowed by the local `safe()` helper into `-1`, which every truthiness test in the file read as
   "standing inside a wall". That is the whole of `the partner walks the labyrinth instead of through it`
   (150 samples of 150, at any tile size, whatever the world did) and half of `comes back to the warden`.
   The predicate is now spelled out inside the evaluated function, and `safe` no longer answers a boolean
   question with a truthy sentinel.
2. **A leash point is arithmetic, and arithmetic does not know about stone.** `Ally.tick` aimed the partner at
   `player ± leashDistance (34px)` along the line home. On a map whose walls are 160px thick that point sits
   *inside a fold* more often than beside one, and the partner spent the run pressed against it. The scene now
   answers one more question — `standable(x, y, toward)` — from the same wall list the physics runs on, and
   the partner aims at the nearest ground it could occupy. The order matters: the route is asked first, so
   "go round" is never traded for "press against" (an earlier attempt projected *before* routing, which is
   how the partner went from slow to motionless — caught by measuring frames, not by reasoning).
3. **The recall bound was in pixels and the map's unit is the tile.** Past six leashes (204px) the partner
   abandons a detour; six leashes was written when a tile was 32px, so scaling the map shrank the rule from
   six tiles of slack to 1.3, and `fetching` could never start because the errand began outside the recall.
   `DUNGEON.partner.recallTiles` is the rule now (6, as before, in the unit the map is authored in).
4. **The courier test measured nothing until it was made to.** It counted the three `way_map` shards every
   run carries — `kind: 'shard'`, `placed: true`, which `nearestOrb` correctly refuses — as "9 orbs on the
   floor"; it popped its cache by *assigning a coordinate* instead of standing on the site for a frame; and
   it parked the warden on top of the pile, so the warden's own vacuum grew the ledger and the sample loop
   stopped on it. The park now scores every clear tile in sight of the pile and takes the one that puts the
   nearest orb beyond the warden's reach and inside the partner's (387px, measured), and a ledger entry only
   counts if a sample saw the partner carrying. Green, and green for the reason: `peak carry 1, ended
   carrying 0`, warden drifted 1px.
5. **One test-side constant was the strip's, not the brain's.** "Park in the other lane" uses
   `circuit.laneTopFy * plan.height`, which on a brain plan is the *world's* height: it flung the warden
   2284px from its partner and then blamed the partner for not arriving. Organic plans skip the lane step, and
   the "comes back" check sets the pair down a couple of tiles apart on ground chosen to be clear of stone,
   because that is the promise (31px after 5.0s, from 320px) rather than the residual of a teleport.

Also fixed on the way, each measured: `Ally.tick` always consults the corridor (a 40px target in a brain is
routinely behind a ridge); `corridorStep`'s recovery step follows the polyline instead of aiming through
walls; `pressOutOfWalls` iterates until a pass changes nothing (two passes ping-ponged a body in the seam of
two merged rows); the drops and a woken pack land on `groundNear(...)`, ground rather than ridge.

**The framing, settled by eye rather than by ratio.** At 160px per tile the shared 320-world-pixel fit left
2.00 × 1.25 tiles on screen, which reads as an empty dungeon; a per-scene wide frame (1280 × 800 buffer)
fixed the count and broke the *game* — 1 CSS px per world pixel made the dungeon look like something else, and
it cost 47 → 16 fps under software GL. Both are gone: the dungeon asks the viewport for nothing at all, and the
map's unit came down to **64px**, so one wave frame holds **5.00 × 3.13 tiles** of labyrinth with the warden
at the same 40 CSS px it has in a story wave. `DUNGEON.minTilesInView: 5` is the authored rule that keeps the
two in step; `tilePx` is the dial, and it now has a floor (64px = 1.9× the clamped-frame envelope) and a
ceiling (320 / 5 = 64px, the same number) that meet.

The margin the user asked for is now gated twice: `audit:cortex` compares the thinnest wall body against the
fastest motion the config permits (160px vs 34px per clamped frame), and `audit:dungeonrun` throws a body at a
wall at twice the dash speed inside a running scene and requires that it neither ends up inside a wall body
nor comes out the far side. Both are tile-relative, so the next time the scale moves they say so.

## Files

| File | Job |
| --- | --- |
| `tools/cortex.mjs` | the derivation and its knobs (`CORTEX`) |
| `tools/derive-cortex.mjs` | report, plan renderer, `--mask` emitter |
| `tools/cortex-audit.mjs` | the gate: 30 claims about the shipped data |
| `src/game/dungeon/cortexMask.ts` | generated mask, one char per tile |
| `src/game/dungeon/cortex.ts` | runtime: parse, wall rects, void runs, the walk, `layerAt`, `blockedAt` |
| `src/game/dungeon/cortexPlan.ts` | the brain in `DungeonPlan` shape: sites, spawn, route, fissure |
| `src/game/dungeon/ground.ts` | paints walls from `plan.walls`, cuts the void, skips the strip's frame |
| `tools/shot-dungeon.mjs` | starts the game, enters a run, writes `audit/cortex/in-game*.png` |

Superseded but kept: `src/game/dungeon/brainMask.ts`, `tools/derive-brain.mjs`, `tools/brain-audit.mjs` (the
first mask-plus-gate, no consumer). `map.ts`'s strip generator stays because `audit:dungeon` and the design
doc still speak of it; the scene no longer uses it.

### The counter-test, and the two holes it found in my own gate

A margin gate that cannot fail is worse than no gate, so the derivation was re-run at `tilePx: 32` to watch
`audit:cortex` object. It took two rounds and two separate bugs before it could.

**Hole one — mixed sources.** The crossing check read the tile *size* from the derivation config and the
rectangles from the built plan, so it printed `160px` beside a neighbour's `a tile is 32px`. Both numbers now
come from the plan (`cortex.tilePx`), and `the shipped plan and the derivation agree on how big a tile is`
guards the two against drifting apart — it failed on its very first run through, which is the only evidence a
drift guard can offer.

**Hole two — the bundle was never rebuilt.** `audit:cortex` bundles `cortex.ts` with esbuild. With one entry
point esbuild writes `cortex.js` into `outdir`; with a second it keeps the sources' shared directory and writes
`game/dungeon/cortex.js`. The import still asked for the flat path — a leftover from an older one-entry build.
Every plan-derived measurement read a *frozen* copy of the mask; a number that would not move when the knob
moved was not measuring the knob, and deleting the cache dir before each build (now done) is what exposed it:
the first run after the reset died with `ERR_MODULE_NOT_FOUND` on `cortex.js` instead of quietly reusing it.

With both fixed, the counter-test finally bites. Re-derived at 32px, `audit:cortex` comes back **31/33** and
the crossing check fails on its own terms:

> `FAIL no mover can cross a wall body in one frame — thinnest wall body 32px (1.00 tiles) against 34px per
> clamped frame … at 32px per tile that is a 0.9× margin`

One tile of stone was **0.9 frames** of a mover at the old scale — the collider's thickness was never what
stopped a dash. That is now a measurement, not an argument. At 160px the same line reads **4.7×** and passes.
The straddle check fails at 32 (`a tile is 32px against the widest authored mover box, 14px`) and passes at
160. Mask restored byte-identical; `audit:cortex` **33/33**.

### The live stress sample now contains enemies

`audit:cortex`'s crossing margin is a statement about the *map*. The user's ask — *no enemies glitch through
the wall* — needs live bodies, which is the `audit:dungeonrun` stress block's job: it picks a wall body with
clear floor on both sides, places every mover west of the face, shoves them east at 680 px/s for 90 frames,
and requires that none ends up inside a wall body or comes out the far side.

That block had been sampling **two movers with zero hostiles** — the player and the partner, in a scene where
nothing had been woken yet. The requirement was the one thing the sample could not speak to, and it would have
kept passing in exactly the state reported. It now wakes a wave deliberately before choosing the wall (sites
in order of the pack they release, until four hostiles are live), and the check requires `enemies > 0` so a
friendly-only sample fails instead of passing vacuously.

The first honest run reported `102px in the longest single frame against 160px of stone` — a 1.57× margin,
nowhere near the 4.7× the derivation measures. That was the harness, not the game: movers were placed 12px
apart, bodies are 14–16px wide, so they overlapped and Arcade snapped the pile apart in one step. Spaced a
body-width apart, the same run reports **23px against 160px of stone (7.0×), 0 mover-frames inside a wall
body, 0 of 4 hostiles through the face**. A stress rig's own placement is part of what it measures.

## Second pass: the waystone, and the cull that was eating the map

Same day, after the framing decision. `SiteKind` gained a sixth member, `waypoint`, and with it the mode's only
travel verb: touch to link, touch again to hop to the next linked stone in map order. 8 waystones over 7 bands,
the mouth's flagged `entry` and linked by the director's constructor. `tally: 111 passed, 0 failed, 1 info`
(`audit:dungeonrun`), `audit:cortex` 33/33, `verify` 59/59 + 27/27 + 16/16 + 14/14 and a clean build.

The site count rose 52 → 65 because the depth ramp replaced the flat per-band budget, and two things had to be
fixed for the ramp to be visible at all:

* `syncCells`'s cull retired every stone once the party passed band 1 (all sites are `chunk: 0` in a brain plan).
  `siteInWindow` replaced it; see `docs/STATS_GAMEPLAY_FAULTS.md` §N6 for the measurement, which is the one
  finding in this pass worth more than the feature that surfaced it.
* `field.intensity` was generated and ignored; the scene now multiplies its mines by it.

Two gates changed shape rather than number: the guide card's row count and its required names are now parsed out
of `GuideCard.tsx`, so the legend and the audit cannot drift apart.

---

## Third pass: the corridor has to be walked, and the bands answer back

The player's report was *"it is still empty — no enemies and no stones other than the start-point stone"*, plus
one demand about how it has to feel: **spawn enemies out of nowhere, and render it fast**. The first cut of the
waystone pass had put content in the *plan*; this pass put it in the *walk*, which turned out to be a different
claim. `docs/STATS_GAMEPLAY_FAULTS.md` §N7 holds the four faults and their measurements; what ships is:

* **One polyline.** Every band's sites are placed from `cortex.walk.path` cut by `bandAt`, at an **arc** stride
  shared by all kinds, so content recurs every `max(SITE_SPACING_TILES, len / wanted)` tiles *of corridor* rather
  than every so-many tiles *as the crow flies*. `SITE_SPACING_TILES` is 3 (a wave-sized frame is 5 × 3.13 tiles
  of corridor; at 5 the sampled frames were half empty). Waystones are placed **before** anything else spends the
  corridor, two per band at the band's stride, and the mouth's is still `entry`.
* **Hostiles that arrive.** `tickRoamers` in `DungeonScene` trickle-spawns a roamer while the party advances:
  never a site (so `LEAVE NOTHING` still counts only authored stones), never during a live fight
  (`countActive(true) >= DUNGEON.roamFightCeiling` = 4), cap `min(3, 1 + floor(band / 2.5))`, interval
  `max(1500, 3200 - band * 250)` ms, placed at least `roamAheadTiles` (4) up the walk and outside the camera's
  `worldView` when that is possible, retired beyond `roamCullTiles` (10) once it is also off-frame. Ground
  crossed, not velocity commanded, is what earns one; a warp earns nothing.
* **The frame is untouched by it.** `13 fps quiet, 8 with 1 roaming, 8 quiet again` on a page that shares a
  software GL with two other contexts; measured alone the same world runs 33 fps at that size and 45 at
  1280 × 800. The gate asserts the ratio against the slower of the two quiet samples around it, and no absolute
  floor, because an absolute floor measures the renderer.

Numbers at handover, all from one run of `npm run -s audit:dungeonrun`: **116 passed, 0 failed, 0 info**;
`audit:cortex` 33/33; `verify` clean (typecheck + 59/59 dungeon-map + 27/27 achievements + 16/16 counter +
14/14 brain + build); `audit:pages` 16/16. The lines that describe this pass:

```
PASS  and a walk along the corridor has something to walk to — 7/7 sampled route positions would show a site
      (94 sites over 104.3 megapixels, 7.03 × 5.47 tiles in frame)
PASS  a band keeps its stones while the party stands in it — live non-waypoint stones by band
      0:6/6 1:8/8 2:11/11 3:11/11 4:14/14 5:13/13 6:16/16
PASS  deeper you go, harder it gets — sites per walkable tile by band
      0.0131 0.0155 0.0162 0.0221 0.0250 0.0169 0.0303 · awake budget 14 26 41 52 69 50 95
PASS  the bands send hostiles without being woken, and they arrive from off the frame — 1 roamer(s) first seen
      over 44 polls in band 1, 1 of them outside the camera's view, closest approach 394px against 4 tiles of
      authored standoff · 0 sites spent · ground covered 107px against the ~77px a spawn costs
PASS  a roamer is never delivered inside a wall, and never outnumbers its cap — peak 1 against a cap of 3
PASS  touching a waystone links it, and touching it again moves the party — 7 hops, worst landing 0px off the
      destination stone · 13 on the counter · 8/8 linked
PASS  it brings the orbs in, and the warden never came near them — ledger 3 → 4, warden drifted 0px
```

The courier gates going green is the *real* signal of this pass: the partner delivers again because the errand it
was sent on is now on the line it walks. Screenshots of a walk (both in `~/shots/`): `dungeon-mouth.png` shows
the entry waystone and a grove beside the spawn at 0m03s; `dungeon-hunted.png` shows a roamer with its arrival
ring and a `7!` hit number with the partner on screen; `shots2` sampling found hostiles in frame on 40 of 80
looks along the first 30 seconds of the walk, at 45 fps.

Still open, deliberately:

* The trickle is a *presence*, not an AI overhaul. A roamer walks the corridor and attacks; it does not flank,
  and it will not follow the party through a warp (it stays where it was, then is culled).
* A roamer that dies goes through `onEnemyKilled` like any other hostile, so it **does** add to `kills` and to
  `ledger`. Both numbers therefore stopped being pure functions of the authored map: a run can now be felled-up
  and ledger-positive without spending a single site, which is what `LEAVE NOTHING — n SITES UNTOUCHED` is for,
  and why the objective counter and the ledger are printed side by side rather than one standing for the other.
* The guide card does not mention roamers at all. It lists what can be touched; a thing that arrives is a
  different kind of claim and probably needs its own line.

---

## What completing it costs (measured 2026-10-13, not estimated)

Content, read off a live run (`probes/site-n.mjs`, `probes/inventory.mjs`): 7 bands over 11008 × 9472 px; 94 sites —
34 groves holding **272** hostiles (sizes 4→11 by depth), 9 dens holding **46** minibosses (4→6), 16 caches, 13
fields with 118 mines, 7 springs, 15 waystones. Route: 255 points, 254 tiles, **16,256 px**; the crow-flight
distance from spawn to the centre is 2,771 px, so the labyrinth is 5.9× longer than the line you cannot take.

Stats do not scale with depth — `context.scaling` is `{hpMult: 1, damageMult: 1, speedMult: 1}` for the whole run,
so every band draws floor 1's roster (chaser 16hp/7dmg, hound 22/13, caster 14/8) and the only stat jump in the
mode is rank: a den's `ember_hound_alpha` is 350hp/12dmg with 0.1 armour and it summons. "Deeper is harder" is
therefore a claim about *numbers*, and it holds: awake budget 14 / 26 / 41 / 52 / 69 / 50 / 95.

- **To finish:** 16,256 px ÷ 82 px/s = **198 s** of uninterrupted walking (~156 s with dashes). Nothing gates it —
  no timer, no cost, no chart requirement; `atCenter` within `goalRadius` 46 ends the run. Waking anything requires
  *touching its stone*, so a run can be a sprint.
- **To clear:** 272 × 17.3 + 46 × 350 ≈ **20,800 HP** ÷ 26.5 dps (attack 9 per Firebolt at 0.34 s, energy cost 0,
  so no resource wall) = **786 s ≈ 13 min of continuous, well-aimed shooting**, plus 3.3 min of travel, plus 118
  mines and the trickle. Call it 15-20 minutes; the 90-body pool is what keeps that renderable.
- **Heal budget:** 7 springs × 2 charges × 28% = **392% of max HP**, if every spring is found and used.

Two bot runs over the same ground, with the warp verb suppressed so the walk is fair (`probes/dungeon-run2.mjs`):

| policy | 300 s / 150 s | hp (min) | damage taken | kills | sites spent |
|---|---|---|---|---|---|
| walk + shoot at the nearest thing | 300 s, 40% of route | 100 (83) | 24 over 29 hits | 59 | 8 |
| walk, never fire | died at 150 s, 41% | 0 | 145 over 79 hits | 5 (the partner's) | 8 |

The gap is the mode's actual difficulty curve, and its cause is arithmetic: `PLAYER_CONFIG.invulnMs` is a *global*
550ms, so a swarm cannot apply more than ~1.8 hits a second however many touch you, and `baseDefense` 4 eats most
of a 7-8 damage bite — engaging is cheap (≈5 hp/min), fleeing is expensive (≈58 hp/min) because the pursuers never
give up and the trickle keeps feeding them while you move. Difficulty is also opt-in the other way: standing still
earns no roamers at all (the trickle keys off ground crossed) and regenerates 1.2 hp/s after 6 s untouched, and
roamers killed count toward `felled` and `ledger` without a site being spent.

**Then fixed, and it moved the number.** The stalls were not geometry: `probes/sweep.mjs` placed the body on all
255 route points and found 0 inside a wall rect and 0 blocked segments — but 4 of 7 sampled *waystone* points
relocated the party 604-3,893 px within 160 ms, because the density rule puts waystones on the corridor and
touching one was the whole travel verb. Hopping is now deliberate: `DUNGEON.warp = { dwellMs: 380, dwellSpeedPx: 26,
hopFloorMs: 400, rearmMs: 350 }` — a first touch still links, a hop asks you to stand still on the stone. Same bot,
same policy, warps live: **40% → 58% of the route, hp 100 with 7 damage taken over 400 s**, and the hop gate went
from 7 hops to 14 (worst landing 0 px) because the probe now performs the verb a player performs instead of poking
`activate()` once. Sweep after the fix: `pushedOffByColliders: 0 · endToEndWalkable: true` — the traversal evidence
the suite had never required, now gated in both directions (`a waystone is stood on, not walked through`), because
a gate on one half would pass a build that switched the verb off entirely. `docs/STATS_GAMEPLAY_FAULTS.md` §N8.

Still not verified: a *finished* run by machine. The bot's remaining 42% is its own policy — it stops to shoot, and
at 26 px/s of net progress it spends the clock inside the fights it picks, not walking. Full tallies after the fix:
`audit:dungeonrun` **117 / 0 / 0** · `audit:cortex` 33/33 · `audit:dungeon` 59/59 · `audit:pages` 16/16 ·
typecheck 0 · build clean (dist 807 kB + phaser 1.2 MB).
