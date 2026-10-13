# Dungeon mode — design (brainstorm outcome, 2026-10-11)

Status: **design validated section by section, not implemented.** Brainstormed with
`.claude/skills/brainstorming` — context survey → four direction questions → three approaches →
six design sections, each confirmed. No git repository exists in this workspace, so the skill's
"commit the design document" step is not applicable; the file is the artifact.

## The four decisions this is built on

| Question | Answer | What it rules out |
| --- | --- | --- |
| What is the mode for | A **systems showcase / lab**: partner AI, loot, hazards, biome mixing, no story pacing | meta-economy, ranking, unlock ladder, leaderboard |
| How vast | **Open strip** — one continuous band of ground, no rooms or doors | interior wall topology, per-room transitions, "which door" choices |
| What the partner is | **A real body** with its own aggro, HP and a kit derived from the support loadout | aura/ward abstractions, "a second active element" |
| Do stakes reach the game | **Self-contained.** Nothing carries out; loot is spent in-run | save-schema world state, carry-out wallet writes, persistence |

The strip being roomless is a scope decision, not a simplification of the interesting part: with no
walls to path around, partner aggro, the loot magnet and hazard tuning are the only things standing
between you and the end, which is exactly what a lab wants to be about. It also means the mode needs
no pathfinding, and that `audit/` can assert its invariants in one dimension.

## §1 Architecture and ownership

Three new files, two small shared-code edits, nothing inside the wave machine.

- `src/game/dungeon/map.ts` — **pure generator**, no Phaser import. Only `createRng`
  (`src/utils/math.ts:24`, Mulberry32, already documented as existing "so seeded runs are
  reproducible") and `FLOOR_REGISTRY`. Gate-checkable from plain node.
- `src/game/dungeon/director.ts` — replaces the wave state machine: distance travelled, what is
  awake, when the run ends. **Never touches `progressionActions`.**
- `src/game/scenes/DungeonScene.ts` — composes what already exists: `Player`, `Enemy`, `Pickup`,
  `Ally`, `HazardDirector`, `statusSystem`, `statEngine`, `fx`, `objectPool`, `audio`, `atmosphere`.
  Using `fx` from day one means the pause/zoom fix (`docs/STATS_GAMEPLAY_FAULTS.md` §H4) applies
  here rather than having to be rediscovered.

Registration is `scene: [Boot, MainMenu, Gameplay, Dungeon, Pause]` at
`src/game/gameConfig.ts:68`, plus `PhaserHost.startDungeon(seed)` modelled on `startGameplay`
(stop `PauseScene`, start the scene) so the pause card remains the same overlay scene and the run
request stays the only input channel (`src/game/runRequest.ts`).

Ownership, once:

- the **run request** carries the seed and the loadout; the **scene** owns the world;
- **`worldFrame` keeps meaning "one cell"** and is never re-planned during the mode;
  `resetWorldFrame()` runs on shutdown, as gameplay already does;
- the **camera** is the only thing that learns the strip is wider than a cell:
  `setBounds(0, -overscan, mapRect.width, worldFrame.height + overscan * 2)`, with base zoom still
  fitted from the **view**, not the world (`fx.setBaseZoom`).

Two measured facts shaped this:

1. **The frame must not simply be widened.** `hazards.ts:481-482` places fields as a fraction of
   `worldFrame.width`, and `:553` chooses the crystal-wall axis by distance from
   `worldFrame.width / 2`. A 4-cell-wide frame would drop hazards in the middle of nowhere and make
   that axis test meaningless. Hence `mapRect` as a separate extent, and the two hazard expressions
   becoming arguments.
2. **The resize opt-out is not in the scene.** `viewport.ts:3` imports `planWorldFor` — the viewport
   triggers the re-plan, so this mode passes `plan: false` there. `GameplayScene` keeps its behaviour
   byte-for-byte, and the only bounds call sites that need the map extent are
   `GameplayScene.ts:274` and `:292`.

## §2 Generation

A chunk is exactly `worldFrame.width` wide and `worldFrame.height` tall. Whole cells keep tiles
aligned at the fitted zoom (pixel-art integrity: no half-pixel grout) and reduce "which chunks are
live" to a division. The strip is `DUNGEON.chunks` cells, default 6 (≈5,300 world px of ground).

`planChunk(seed, index, opts)` returns plain data:

```ts
type ChunkData = {
  biome: number;              // key into FLOOR_REGISTRY
  groundVariant: number;      // which authored floor texture row
  sites: Site[];              // see below, positioned as fractions of THIS chunk
  hazardFields: { kind: FloorDef['hazard']['kind']; cx: number; cy: number; r: number }[];
  props: { anchor: number; sprite: number }[];
};
type Site = { kind: 'grove' | 'cache' | 'spring' | 'field' | 'den'; fx: number; fy: number; n: number };
```

Site positions are authored as fractions **of the chunk** and converted to world space by the scene.
That rule exists because of finding 1 above; it goes in the module's header comment, and `hazards.ts`
receives `fieldCentre` / `fieldWidth` arguments defaulting to its current expressions so the story
numbers are identical.

Biome comes from `FLOOR_REGISTRY`, consumed as-is: `palette`, `props`, `hazard.kind`, `hazard.intensity`,
`enemyPool`, `affixPool`, `music`, `rewardTableId`. Ten art-correct environments, zero new textures.

Between sites: ground variant, props, and nothing to fight. Walking is never dead work, and never a
reward either — the strip's only incentive mechanism is what sits at the next site.

## §3 Stones, loot, hazard fields

One entity, `Stone`, with `kind: 'grove' | 'cache' | 'spring'` and
`state: 'dormant' | 'active' | 'spent'`. It is the map's only interactive vocabulary: a lit thing on
the ground always means the same three things. Overlap is the only input — no key prompt, because a
thumb pad cannot reliably aim at a 20 px object.

- `grove` wakes `n` enemies over staged `releaseAt` steps, the same field the wave portals already
  use (`waveDirector.ts:51`), then goes `spent`. A spent grove is scenery, not an obstacle.
- `cache` calls `rollDropTable(getDropTable(biome.rewardTableId))` and spawns `Pickup`s in a ring, so
  the shipped drop physics, magnet radius and buff-stack cap apply with no new code.
- `spring` has `DUNGEON.springCharges` (2) and does the two things worth doing: heal the player, and
  lift the partner out of `downed`.

In-run spending reuses the shape of `GameplayScene.ts:72` (`essenceRun` — a scene-local number granted
at one seam, `:189` / `:766`). Nothing calls `progressionActions`, so the single-writer-per-source
property established in §B12 is untouched and `audit:config`'s unreachable-key check keeps its meaning.

Hazards: `HazardDirector` (`hazards.ts:411`, `update(deltaMs, intensity)` at `:448`, `destroy()` at
`:611`) is reused verbatim once the two frame expressions become arguments. The strip modulates
*intensity inside `field` site bands* rather than on a timer — data, not a new hazard kind.

Anything outside camera ± 1 chunk retires to `objectPool` (`PhysicsSpritePool.releaseAll`,
`ImageParticlePool.killAll`), so memory is three cells wide regardless of strip length. The ambient
particle budget is currently a fixed count wrapped around the world rect, so it becomes per-area:
without that the strip reads empty, and the loop must stay inside the visible frame.

## §4 The partner

`Ally` is `autoCast`'s decision logic given a body. Its kit **is** the support loadout — the exact set
`RunSnapshot.auto` already publishes (`{ slot, element, level, accuracy, charge }[]`,
`src/store/runStore.ts`), whose docstring already describes it as "everything equipped that is not in
hand". The data contract and the rail UI exist before the mode does, and the loadout screen gains a
second consumer that changes something visible rather than a timer.

Four states, at most one decision per frame, no allocation in the loop:

| State | Rule |
| --- | --- |
| `following` | seek a leash point behind the player along its velocity vector |
| `engaging` | nearest enemy within 220 px that is also within 140 px of the player |
| `fleeing` | below 25 % hp, moves away for 1.2 s, then re-evaluates |
| `downed` | inert, desaturated (`setTint` + alpha steps only — no filters), until a `spring` |

Damage enters through the one door all damage uses — `Enemy.damage`, with its caps and its
once-per-crit rule — tagged `source: 'ally'`, and ally hits earn **no** mastery XP, matching the
precedent where support casts earn none (`GameplayScene.ts:1396`). HP is a fraction of the player's
(`DUNGEON.partner.hpFraction`), re-derived by `statEngine` so relic and buff math stays in one place.

The only genuinely new plumbing is aggro: enemies pursue the player, so `Enemy` needs a target choice
— nearest of the two, weighted — roughly 15 lines, behind `if (ally)`. That is the single place story
mode could regress, so it ships with a gate: story behaviour asserted with no ally present, before and
after the edit.

`downed` has no timer and no auto-revive. If the player dies while the partner is down, the run ends.
A partner you can lose for the rest of the run is what makes its health bar mean something, and it
costs no additional systems.

## §5 HUD, camera and the small-screen rule

The mode's plates are the shipped plates with different words in them, so the mobile gate that caught
this session's HUD faults covers the dungeon for free:

- **DEPTH** replaces the wave plate — distance travelled in cells — and uses the same
  `.floor-plate` markup, including the `is-counting` convention (nothing may sit on top of the
  numbers; the wave-countdown overlap is fault §H5).
- **SITES** counts what is left: groves, caches, springs not yet used.
- **PARTNER** is a bar plus a state word, fed from the same snapshot publish.
- **Minimap**: one plate, `DUNGEON.chunks` cells of squares, inline SVG, no anti-aliasing, colours
  from the biome palette. On `@media (max-height: 520px)` it collapses to the progress line under
  DEPTH, using the existing short-frame idiom rather than a new breakpoint.

Nothing new reaches React per frame: the snapshot (`PERFORMANCE` HUD text rate, not every frame)
gains `depth`, `sitesRemaining`, `partnerHp`, `partnerState`, and the minimap reads the same object.
No text below 10 px anywhere — the legibility floor `audit:mobile` enforces (it rejects under 9.5 px)
is the same one that raised the skill tree's captions this session.

The pad band needs one explicit decision because the mode opts out of frame re-planning: `worldFrame`
reserves the bottom `ARENA.padFraction` of the view for the thumb pads by shrinking the field, and the
strip will not. So the camera keeps the band instead: `centerOn(x, y + viewHeight * ARENA.padFraction
* 0.5)`. Measured at 360×640 and 844×390 before shipping, same as the HUD work this session.

`MENU` behaves identically (pause card over a frozen sim), which is what makes the pause card's
`EDIT LOADOUT` route — shipped alongside this design — the same interaction in the dungeon as in story
mode: `isRunSubscreen(ui.screen)` is what freezes the run while a full-screen menu is up, so the
mechanism is shared, not re-implemented.

## §6 Failure handling and gates

Generation invariants, asserted in the pure gate (`audit:dungeon`, node only — the first generator
gate this project can afford to put inside `verify`, because it needs no browser):

1. `planChunk(seed, i)` deep-equals itself when called twice; `planChunk(seed ^ 1, i)` differs.
2. No site inside the wall band (`ARENA.wall + DUNGEON.siteInset`).
3. No two sites closer than `DUNGEON.minSiteGap`.
4. Chunk 0 always carries a `spring` at the entry, so a spawn can never be stranded.
5. Every `grove.n` ≤ `DUNGEON.maxAwakePerGrove`, and Σ awake ≤ `SPAWN_CONFIG` ceiling.
6. Every `cache` names a table `getDropTable()` resolves; an unresolved id is a failure, not a silent
   empty pile (the class of fault §B11 found in the relic table).

In-engine robustness: unknown biome id falls back to floor 1 with a dev-only warn; a chunk index past
the strip's end returns ground-only data rather than wrapping; a `Pickup` that cannot be pooled grants
its value directly, the same shape as the "orb at a full bar used to vanish" fix
(`GameplayScene.ts:753`).

Scene hygiene: `fx.settle()` and `fx.clearHitStop()` on both edges of every freeze and in
`onFrameResize`, `resetWorldFrame()` on shutdown, and the viewport `plan: false` flag restored for the
next scene. These are the faults this session proved are easy to introduce and invisible to
stat-and-config audits.

Gates: `audit:dungeon` (pure), `audit:mobile` gains a dungeon entry so the geometry checks apply to
the new plates, `audit:camera` extended to run its punch/pause checks inside `DungeonScene`, and
`audit/dungeon-round.mjs` (browser): walk the strip → wake a grove → collect a cache → lose the partner
→ revive at a spring → save & exit with nothing written to the save file.

Story-mode safety: the only shared-code edits are `hazards.ts` (optional args defaulting to today's
expressions) and `Enemy`'s target choice (no ally ⇒ unchanged). Proven by `npm run audit`,
`audit:e2e`, `audit:progression`, `audit:config` and the round probes all running green with the ally
absent.

## Out of scope, deliberately

Rooms and doors; carry-out economy; meta unlocks and any read of `save.progression`; seed-sharing UI;
fog of war; obstacle pathfinding; co-op; procedurally generated art; a second wallet. The last three
are the ones most likely to be proposed later — each is refused here because the mode's stated job is
to make four systems legible, and every one of them adds a consumer that has to be kept honest.

## Deferred questions

- Does `depth` replace `wave` in `RunSnapshot` or sit beside it? (Beside: the HUD and `audit:pages`
  read `wave` and the mode has none; a `waveLabel` string already exists and could carry "CELL 3 / 6".)
- Extract the portal staging from `waveDirector` for reuse, or imitate it in `DungeonDirector`?
  Imitate first, extract when both consumers exist — which is now — but the extraction is its own
  change and should not be smuggled into the mode's first landing.
- Whether `den` (elite/mini-boss site) is in the first cut. It is the only site kind that needs boss
  framing (intro, health plate, phase labels), so it is the natural thing to drop if the slice gets long.

## Landed — what the build actually changed against this design (2026-10-11)

Implemented and green: `audit:dungeon` 31/31 (generator), `audit:dungeonrun` 57/57 (scene, browser, phone
shapes), and every pre-existing gate still passing: `audit`, `audit:e2e` (twice, after hardening its
pause step), `audit:mobile` 0 FAIL/0 WARN across five shapes, `audit:pages` 15/15, `audit:fit` 0 FAIL,
`audit:camera` 12/12, `audit:progression` 20/20, `audit:pausemenu` 24/24, `audit:config` 0 unreachable. Fault-by-fault detail is §I of
`docs/STATS_GAMEPLAY_FAULTS.md`; this section is only about where the design was wrong.

**The sentence "the only shared-code edits are `hazards.ts` and `Enemy`'s target choice" was false, in
both directions.** Those two edits did not happen at all, and six others did:

1. **Visibility, not duplication.** 61 members of `GameplayScene` moved from `private` to `protected`,
   and `setupMusic` joined them, so `DungeonScene : GameplayScene` reuses spawn/damage/pickup/hazard/
   teardown glue instead of forking ~800 lines. Cost to the story file: keywords and a doc block, no
   behaviour. This is the deviation I accepted in conversation before starting, written down so nobody
   has to infer it from a diff.
2. **`worldFrame` was not widened, and did not need to be.** `setWorldFramePlanning(false)` keeps
   `worldFrame` meaning *one cell* for the whole run, so `hazards.ts:481/:553` never see a lie. The strip
   carries its own extent (`plan.width`) in the three places that legitimately need it: physics bounds,
   camera bounds, and the resize clamp — clamping to the cell there would have dragged the player across
   the map on every rotation.
3. **Hazard fields use the scene's own mine path, not the biome `HazardDirector`.** The strip therefore
   has no lava/geyser *flavour* per biome, only seeded danger; `DungeonScene` never constructs a
   `HazardDirector`, so `updateHazards` returns early and `hazards.ts` stays untouched. If the fields
   want biome-specific behaviour later, the optional `fieldCentre`/`fieldWidth` args in `hazards.ts` are
   still the right shape — deferred, not abandoned.
4. **Progression got a seam instead of four overrides.** `GameplayScene.creditCastProgress(kind, element)`
   is now the only door mastery/element-usage/achievement ticking walks through, and the dungeon overrides
   that one method to do nothing. The design assumed overriding `onEnemyKilled`/`onPlayerDamageDealt`
   would be enough; a probe that diffs the *entire* save record found mastery, `stats.elementUsage`,
   twelve achievement entries and `profile.lastPlayed` moving from the *cast* handlers and from
   `switchElement` instead.
5. **The shared combat code had to survive a scene with no director.** `spawnEnemy`'s damage cap read
   `this.director.currentSpec?.localWave` — safe `currentSpec`, undefined `director` — and threw inside
   `update`, discarding the rest of every frame. Nine reads are now `this.director?.…`. The alternative,
   handing the dungeon a fabricated `WaveDirector`, would have hidden the fault and left an object in the
   scene that lies about the mode.
6. **Floors speak archetypes; spawns need definition ids.** `pickDef` is exported from `waveGenerator` and
   the strip calls it, so groves wake the enemies that actually live in a biome. `floor.enemyPool` passed
   straight to `spawnEnemy` returned `null` and spent the site doing nothing.
7. **Two config keys the design specified and the build had not earned** — `dropRadius` and the ambient
   count — were reported by `audit:config` as unreachable, and are now the cache pile's ring and the
   floor's motes (§I11). A mode's knobs are only as real as the frame that reads them.

**Answers to the deferred questions.** `depth` sits beside `wave` on `RunSnapshot`, with `runKind`,
`sitesLeft`, `partner` and `stripCells` alongside it and `wave` repurposed as the cell index — the HUD and
`audit:pages` keep reading a wave number and nothing had to be special-cased. Portal staging is *imitated*,
not extracted: `DungeonDirector` owns a release cadence (`groveStepMs`) and nothing else. `den` is in the
first cut and is cheap, because it reuses the boss path `spawnEnemy` already has; what it does **not** get
is boss framing — no intro, no health plate, no phase labels.

**Scope the design underspecified, now settled.** The partner has a body, aggro-relevant position, hazard
and proximity damage, and can be put down; enemies still choose the warden, so "draws aggro" is true of
the partner's body and not of enemy decisions. The strip ends in a toast and the pause menu rather than a
summary card, which is what keeps `deathOpen`/`summary` — and the story's respawn lane — out of the mode
entirely. Music is per-cell via the inherited `setupMusic`. The hall's entry is a seventh station
(`.station-deep`, a full-width plinth) and the *only* entry point: no key binding, no menu item, no
unlock requirement, because the mode must not need permission to be walked.

## Labyrinth — the second landing (2026-10-11), and the courier that walks it

The strip as built above was a **corridor with rooms off it**. The reference for this mode is a Chartres
labyrinth, and a labyrinth is not a corridor: it is *one* path, folded in circuits around a centre, walked
entrance → line ends → centre, with no branch to take anywhere along it. This landing rebuilds the geometry
to that definition, changes what the partner does (§4's `following` row is superseded), and replaces §5's
square-per-cell minimap with the route itself. Everything below is what shipped; the gates at the end are
the ones that say so. `docs/STATS_GAMEPLAY_FAULTS.md` §J is the fault-by-fault record, including four
revisions of one steering rule and two gate assertions that were measuring the wrong thing.

### Geometry: what a cell's circuit is

A cell is still exactly `worldFrame` — authored size, streaming ±1, never widened (see §Landed 2). The
labyrinth is *six of them folded*, not one big frame. Inside a cell, in fractions of that cell:

| piece | value | what it does |
| --- | --- | --- |
| `wallFy` | `ARENA.wall / cellHeight` | the outer band, unchanged |
| `laneTopFy` / `laneBottomFy` | ≈ 0.21 / 0.79 | the two lanes the circuit walks |
| `spine` | `{ fy0: 0.40, fy1: 0.60 }` | the wall across the middle, with one gap |
| `gapFx` | 0.28 + rng·0.10 | where the spine may be crossed |
| `toothFx` | ≤ 0.92, ≥ `gapFx + passage/cellW + 0.12` | a stub from the *entering* lane to the outer wall |
| `entersTop` | `index % 2 === 0` | which lane the cell is entered on, alternating |
| `spineEndFx` | 0.84 in the last cell, else 1 | the last cell closes its spine |
| `goal` | `min(0.965, spineEndFx + 0.09)`, last cell only | the centre, past that closure |

**The invariant, and the only thing that makes this a labyrinth rather than a hallway:** the tooth is
always east of the gap and always in the lane the walker enters on. Passing a cell therefore *requires*
exactly one spine crossing, and there is no island of floor for a path to end on. `audit:dungeon` asserts
the invariant per cell across seeds rather than trusting the arithmetic; measured at seed 20261011 the
route is 6648 px inside a 5280 px strip (1.26× the strip's width), 18 static bodies, cell 0 crossing at
x≈317 with its tooth at 482–558, cell 1 crossing at x≈1209 with its tooth 1431–1507 in the other lane.

`circuit.route` — 5 points per cell, `(0, enter lane) → (gapFx, enter lane) → (gapFx + δ, 0.5) →
(gapFx + 2δ, other lane) → (1, other lane)` — is the walk. `stripRoute(plan)` concatenates it and
`routeLengths` measures it; the ground's wall rectangles (`circuitRects`) and `buildColliders` come from the
same numbers, so art, physics and the corridor rule cannot disagree. Pockets of floor beside the route are
deliberate — that is what a fold *is* — and J5 in §J is what they cost the partner's steering.

### The partner is a courier, not a tail

`following` is gone. The support loadout's body now works the strip's loot:

- essence orbs **stay on the floor** where a cache spilled them. The warden's own magnet
  (`max(PICKUP_CONFIG.magnetRadius, player.pickupRadius)`, 20 px before relics) takes what it walks onto,
  which is exactly what an orb tucked in a pocket across the spine is not;
- every `castIntervalMs`, `Ally.think()` picks the first applicable of
  **flee → deliver → fetch → engage → leash** (the old four states of §4 are the same priorities minus
  `following`, plus two for the cargo);
- `fetch` takes `nearestOrb(view.player.x, view.player.y, orbRadius 460)` — measured from the **warden**,
  not from the ally, so it goes after what *you* cannot reach;
- `carryCapacity: 2`, and a full pair means it delivers before it looks at another orb
  (`it carries what its hands hold and no more`);
- `deliver` re-spawns the cargo at the warden's feet (`dropRadius·0.7`), credits the ledger through the
  warden's own pickup door, and calls out `BROUGHT n TO YOU` — the orbs come to the ledger, not the other
  way round;
- `down()` delivers where the body fell, so a courier killed mid-run costs the trip and not the loot;
- movement is continuous (no waypoint machinery, no stall timer) and steered by `corridorStep` below.

### `corridorStep`: the corridor rule, and why it is four rules

No pathfinder, on purpose — the substitute is a sight test (`wallBetween`) plus the polyline. The shipped
rule, in order, returning `{x, y, committed}`:

1. nothing crosses the segment to the target → go straight at it;
2. the walker is more than `0.6 × corridorLookahead` off the route → step to **its own** projection,
   committed: get back on the path before being clever;
3. the target is more than `corridorTolerance` (96 px) off the route → it is in a pocket, so its projection
   sits under the walker's feet and is a lie — ignore it and step `lookahead` along the arc in the walker's
   current heading, committed;
4. otherwise → toward the projection, clamped to `min(lookahead, |delta|)`.

A `want` that falls past either end of the polyline reverses and returns `committed: false`, so a turn at
the end of a line is not fought. `Ally.drive` (−1/0/1) is updated only on uncommitted steps and zeroed by
`revive()`/`restore()`: hysteresis that does not survive a death or a save-restore.
`corridorLookahead: 52` + `corridorTolerance: 96` replace the deleted `stallMs`/`stallEpsilon`.

Three earlier versions of this rule each fixed its predecessor and created a new failure — jitter, a limit
cycle, then a walker stranded pressing into a wall — and the numbers are in §J4 so the next reader does not
repeat them. The short version: a labyrinth's floor is a *thickened* line, so "nearest point on the route"
is only meaningful against a tolerance, and hysteresis needs a stride shorter than its threshold.

### HUD: the plate counts lines, the plan draws them

`LINE n / 7` on the `.floor-plate` (`lines = chunkCount + 1`; the centre is the last line), and the depth
bar is unchanged. §5's minimap of one square per cell is replaced by **the route, folded**: each cell
publishes its `circuit.route` as `[fx, fy]` fractions plus the warden's position inside that cell, and the
plate draws one row per circuit with every second row mirrored, so rows join at their ends the way the walk
turns; joints between rows; the centre as a pip past the last line's exit; a dot at the warden on its own
row. `is-done` (every site in the cell spent) dims a row, `is-here` lights it, `is-goal` marks the last.

It is drawn from the same data the walls are built from, so the plan cannot drift from the level. Why it
exists at all: at the shipped framing the camera window is 394×260 world px inside an 880×520 authored cell,
so a circuit is about two screens of walking and the *figure* is never visible from inside it. Short frames
still hide the plan (`@media (max-height: 520px)`) and keep the DEPTH line, per §5.

### Config, as shipped

```
DUNGEON:         chunks 6 · passage 76 · spineBand {fy0 .40, fy1 .60} · spineEndFx .84 · goalRadius 46
DUNGEON.partner: hpFraction .42 · speedFraction .86 · engageRadius 220 · guardRadius 140
                 leashDistance 34 · fleeFraction .25 · fleeMs 1200 · damageFraction .5
                 castIntervalMs 900 · orbRadius 460 · carryCapacity 2 · deliverRadius 26
                 corridorLookahead 52 · corridorTolerance 96
```

The circuit numbers sit at the top level of `DUNGEON`, next to `passage`, because they are geometry rather
than a personality: `planChunk` reads them and the ground reads `plan`, so no second source of truth exists.

Deleted: `stallMs`, `stallEpsilon`. `audit:config` sweeps 202 keys, 0 unreachable.

### Gates that came out of this landing

`audit:dungeon` 55/55 — up from 31: the circuit invariants across seeds, and five headless cases for the
corridor rule (straight line, across the spine, pocket committed to, heading kept, rejoin when off-path,
nothing to follow past the strip's ends). `audit:dungeonrun` 74/0/1 — new or rewritten: the partner walks
the labyrinth instead of through it (every sample of a fetch leg tested against the spine band, measured
`0 of 114 inside a wall`); the ledger's growth credited to the courier and not to luck (warden
`drifted 0px` while `ledger 4 → 5`); the far wall is *not* the goal, then the centre is, as a behavioural
pair; carry capacity and return-to-post; the plan's 6 lines / 6 joints / 1 centre / 1 dot; both wall-group
crashes (enter, leave, re-enter).

**Refusues, restated.** `worldFrame` is one authored cell; cells stream; nothing is carried out of the run;
`Ally` and `Pickup` are reused by visibility, not forked; no pathfinder, no new art, no filters.

## The mouth, the walls and the maps — a third landing (2026-10-11)

Four changes, all of them from playing the mode rather than reading it: the wave announcement landed on top
of the countdown; a warden could be shoved through a circuit wall; nothing at the entrance said what any
object was for; and the way to the end of the strip was not findable by anyone who had not read this file.

**The announcement is a plate, and it is above the count.** `.hud-centre` now holds one `.centre-stack` —
row 1 the wave banner, row 2 the countdown — instead of two absolutely-positioned overlays each guessing
where the other is. The banner wears `--gold` with `--panel-sunk` ink and a hard edge, because a translucent
band over a dark arena is the same colour as the thing it sits on. `npm run audit:dungeonrun` raises both
overlays on purpose (a `grantCheat` into the countdown, then a synthetic `game:waveStarted`) and measures the
pair at the shipped frame and at 844×390: `gap 12px / overlap 0` and `gap 6px / overlap 0`, contrast
**11.9:1** on the title and **13.3:1** on the sub-line. `audit:mobile` measures the same pair at all five
device shapes, during the countdown it used to wait past. The unreachable `tone: 'boss'` branch went with it:
the hook clears the banner on a warden wave on purpose, and CSS no state can reach is a claim nobody keeps.

**Walls hold, per frame.** `DungeonScene.pressOutOfWalls()` runs after `super.update()`: nothing may end a
frame inside a circuit rect, and the velocity component along the wall survives so the scrape is not a trap.
Proved by pressing rather than nudging — a lone player failing to pass a wall proves nothing. Squeeze probe:
90/90 frames inside stone before, 0/90 after (`dash + shove 0/90`, partner `0/90`); in the gate, a brute
driving a mob into the tooth for 60 frames measures 0 inside for both bodies, and being *dropped* inside a
wall resolves in 1 frame against a rule of three.

**The entrance has a guide stone, and it is read the only way this mode knows.** `GuideStone` (18×18
immovable, depth 6, its own `physics.add.overlap`, deliberately not in `stonesGroup()`, whose shared handler
calls `activate(stone)` and reads a `site` the guide does not have). Walking into it emits
`game:guideOpened` and `GuideCard` renders eight lines — GROVE, CACHE, SPRING, FIELD, DEN, WAYSTONE, CHART, CENTRE —
in the order they are met. No key prompt anywhere (`E` is Flame Wave, Escape is pause, and `Stone.ts` records
why a 20 px target and a thumb pad do not mix), no freeze (`isRunSubscreen` would stop a run whose whole
danger is the walk: measured `frozen=false` and +733 ms of run clock while the card is up), 6 s before it can
be raised again, tap anywhere to put it away, auto-dismiss at 20 s, and it clears on `game:runStarted` and
`game:playerDied` like the banner does. `guideSpot(plan)` puts it *on* the corridor at 22 % of the first
circuit — x 243 for a walk that starts at 141, before the first crossing at 279 — because in a mode whose
verb is walking into things, a legend you can walk past is a legend that does not exist. On the two phone
shapes it is placed inside the only free band there is (measured: 122 px between the tool row and the action
buttons at 360×640), with the kicker and foot hidden and the content scrolled — 3 of 7 lines visible, the
last reachable by flicking, the bottom edge faded so the clipping says *more below*.

**Three charts mark the way, and are not loot.** `chartSpots(plan, every = 2)` walks one cell in two and takes
the first of five candidate fractions on that cell's corridor that sits ≥ 48 px from every site in it —
candidates rather than an RNG rejection loop, so `audit:dungeon` can hold that "the charts are the same charts
next time". `way_map` joins the pickup registry and is placed with `spawnPickup(…, placed = true)`, so it is
never scattered, never expired, and — the part that would have broken a run — never fetched: the partner's
`nearestOrb` selects by `kind`, and a chart is `kind: 'shard'` for its art, so without `Pickup.placed` a
courier would have carried a treasure map off the corridor and dropped it wherever the warden stood, possibly
inside a wall and therefore unreachable. The first two pips, `and no chart is lying on a stone`, exist
because the fault was real on the first seed tested.
What a chart buys is in the world, not on the HUD, and it is why no new plate was added: `goalMark` is created
hidden and lights on the first chart (so the end of the strip is *earned*, not authored in plain sight), two
charts put a jade pip and a short underline above the first unspent site of every cell ahead, three lay eight
route crumbs 44 px apart along `stripRoute` — drawn on one `Graphics` at depth -7, the polyline cached in
`this.routePx ??= …` rather than rebuilt every frame. Finding one credits nothing: `collectPickup` retires
early on `way_map`, and the gate reports `ledger 3 → 3, shards 0 → 0, save paths unchanged`.

**Config, unchanged:** no new keys (the beacons read `DUNGEON.passage`, `minSiteGap` and the plan's own
geometry), so `audit:config` still sweeps 202 keys with 0 unreachable. `audit:dungeon` is **59/59** — the
guide spot's three invariants and four chart ones included — `audit:dungeon` grew from 55 to
**59/59** and `audit:dungeonrun` from 74 to **98 checks, 0 failed** around the stone, the charts, the beacons,
the walls and the two phone shapes; `audit:mobile` gained a `wavestart` screen for every device shape.

**Refusues, kept.** No pathfinder (the beacons are hints; nothing draws a line around the wall between you and
a pip, and that gap is the mode), no new art (the chart is the shard's gem in `--wayfinder`, the stone is the
site sprite in the same jade), no HUD plate for the maps, no minimap of the beacons, and `worldFrame` still
one authored cell.

## 7. The brain: what the picture allows, measured

The last ask is that the map expand outwards and end up looking like the drawing. The layout is therefore
*derived*, not drawn: `tools/derive-brain.mjs` decodes `assets/brain-source.png` (8-bit PNG, Otsu threshold on
luminance, flood fill from the border to get the body the strokes enclose) and searches grid sizes for the
coarsest mask that still overlaps the filled shape, scoring by IoU against that shape. `npm run audit:brain`
re-runs the sampler and demands byte equality with `src/game/dungeon/brainMask.ts`, so the shipped map cannot
drift away from the picture it came from.

**What came out.** A 7×7 mask, 43 cells, silhouette IoU **90.1%**, sampled at the footprint a cell actually
occupies: 880 px wide but `laneSpan().pitchFrac` — measured **0.5808 of 520 px, i.e. 302.0 px** — tall, because
a stacked row is only walkable when the lane a cell exits on *is* the lane the cell below enters on. That
coincidence is the whole trick and it is now asserted, in pixels, by `audit:brain`. `DUNGEON.chunks` is 6, so
43 cells is the "bigger" the ask meant: ~38 000 px of corridor against today's 6 648.

**Three findings that bind the next step.**

1. **The fissure cannot be a cell gap.** The drawing's defining feature — the longitudinal cleft between the
   hemispheres — is about 4 px of a 103 px-wide body: 4% of the width. At 7 columns a box is 14 px across, so
   the cleft is inside a box, not between boxes, and any threshold that removes it leaves the outline behind.
   Dilation was tried and rejected for the same reason (`grow 0px` already encloses the body at 82.4% fill; 1 px
   closes the cleft entirely, which is how a brain map becomes a loaf). So the *shape* is the outline, and the
   cleft belongs to the art: Stage D's reveal should draw the fissure as a seam in the plate, where a pixel is
   a pixel, instead of pretending a 880 px room is thin.
2. **Route parity, not routing, is the hard part.** Because `entersTop` alternates per cell (`index % 2`) and a
   stacked row is entered from the lane the row above exited, a vertical drop is only legal while
   `entersTop === true`, and a rise only while it is `false`; horizontal steps flip it. So the walk is not a
   free serpentine: down-steps and up-steps must *alternate*, and between any two of them the path must take an
   odd number of horizontal steps. The mask's row lengths are 5,5,7,7,7,7,5 — all odd — which is why every row
   can start and end in the same phase, and why the middle rows' extra columns (0 and 6) must be entered from
   the row below rather than appended to a pass. `brain.ts` therefore needs a small deterministic search over the
   mask honouring those three rules, not a `for (row)` loop; if no path exists for a future mask, the fallback is
   to widen the mask to the enclosing rectangle, which is always solvable, and the gate is where that would be
   caught.
3. **Sizing the run is a pacing decision that the mask forces.** 43 cells means 43 cells' worth of sites,
   enemies and essence: the strip's ~2 min becomes ~11 min of corridor before fighting. `DUNGEON.chunks` is the
   only knob today, so the honest sequence is: route search first (a pure module, gateable in node), then
   `planChunk` accepting an explicit `entersTop` (defaulting to the parity rule, so the strip is untouched and
   `audit:dungeon` keeps its 59), then per-cell origin in the plan and `siteWorld`, then the scene's streaming
   (`cellAt` divides by `cellWidth`, which is a 1-D assumption), then the reveal. Each of those is checkable;
   none of them is a reason to fake the shape.

**Refusues, kept.** No hand-placed cells, no second mask file "for looks", no diagonal joins (the lane
coincidence does not exist on a diagonal, and a walk that clips a corner is a walk through a wall), and no
shrinking a cell to make the silhouette finer — the cell size is the arena, and the arena is everything else's
input.

---

## The cortex replaces §7, and the tile size becomes a physics decision (2026-10-12)

**§7 is superseded.** A 7×7 mask could not carry the ask: at seven boxes across, the drawing's defining
feature — the longitudinal cleft — is *inside a box*, and the "expand outwards and look like the drawing"
requirement needs a mask fine enough to resolve strokes. The shipped plan is derived from the same source
image at **172 × 148 tiles** by `tools/cortex.mjs`, with `npm run audit:cortex` (32 checks) demanding the
shipped `src/game/dungeon/cortexMask.ts` reproduce the derivation tile for tile. `brainMask.ts` /
`derive-brain.mjs` remain as the arena's half-brain art, not as the map. Read the working record in
`docs/plans/2026-10-12-cortex-dungeon-notes.md`; the fault history is `docs/STATS_GAMEPLAY_FAULTS.md` §M.

Two rules from that pass bind anything done here next, and both are gated rather than asserted:

1. **Nothing may be sized by the world.** A `tileSprite` over a canvas-backed texture makes Phaser allocate a
   source the size of the *sprite*, so per-cell ground art sized `cellWidth × plan.height` becomes a
   world-sized canvas — 23 megapixels at 32px tiles, 651 at 160, where the browser answered
   `getImageData: Out of memory` out of `DungeonGround.build`. Index by the camera or by the cell.
2. **Wall thickness is a ratio, and the map's unit is the tile.** The thinnest merged collider is exactly one
   tile, so `tilePx` sets the margin directly — **shipped at 64px**, which is 1.9× the 34px a clamped frame can
   carry (measured live: 23px in the longest single frame with the player, the partner and four woken hostiles
   pressed against a one-tile face — 2.8×), against the bar `thinnest ≥ 1.5 × worstStep`. The value was chosen
   from both ends: the shared fit is 320 world px across and `minTilesInView: 5` caps the tile at 64px, while
   the crossing rule floors it at 51px, so 64 is where "reads like a wave run" and "cannot be crossed in a
   frame" meet. 160px satisfied the second and broke the first; 48px was measured and fails the second (31/33,
   a 1.4× margin); 32px is what the tunneling was reported against (0.9×).
   The old scale is not argued here any more, it is read off a failing gate: re-derived at `tilePx: 32`,
   `audit:cortex` returns **31/33** with `no mover can cross a wall body in one frame` reporting **32px of
   stone against 34px per clamped frame — a 0.9× margin**. Three rules follow for whoever touches this next:
   * a check must take both sides of a ratio from one source: reading the tile size from the config and the
     rectangles from the built plan let it certify a scale the plan did not have;
   * any generated or bundled input a gate imports by path must be provably *this run's* output. `audit:cortex`
     bundles with esbuild, and adding a second entry point silently moved the output to `game/dungeon/cortex.js`
     while the import kept reading a stale flat `cortex.js`; the gate now deletes that cache directory before
     building and gives each entry an explicit `outfile`, so a leftover file cannot stand in for the map;
   * `the shipped plan and the derivation agree on how big a tile is` is the drift guard for the first rule —
     do not soften it, and treat any gate number that refuses to move when the knob moves as a broken gate.
   A rule written in pixels also stops meaning the same thing when the map is rescaled — the partner's recall
   moved from `leashDistance × 6` to `DUNGEON.partner.recallTiles: 6` for exactly that reason.

**The cost of rule 2 is measured, and it is larger than first written.** The frame is a viewport rule, not a
window one: `viewport.ts` holds the view to 320 world px across at a whole-number zoom, so at `tilePx: 160` a
desktop screen framed **2.00 × 1.25 tiles** where it framed 10 × 6.25 at 32px — at the shipped 64px it frames
5.00 × 3.13, at the same CSS-px-per-world-px as a wave run, which is the property the playtest asked for — and a handheld frame cannot see
more than ~2.6 tiles at that unit without breaking the integer-zoom law. (An earlier draft here said 9 × 5,
computed from the CSS size rather than the render frame: wrong by 4×, and the reason the change reached a
playtest reading "the dungeon is empty".) Camera zoom and a smaller multiplier are the two
other dials. Pulling a *third* — rescaling sprites and bodies alongside the world — would restore the
proportions and cancel the margin, which is what the change was asked for, so it stays unpulled; the choice of
dial is a call for the player-facing side, and `npm run audit:dungeonrun`'s two stress checks — which sample the player, the partner and four woken hostiles, and fail outright if no hostile is in the sample — are what any
answer has to keep green.

---

## The sixth stone: the waystone (2026-10-12)

A playtest verdict — *"dungeon is empty, add chests, stone, enemies … introduce waypoint stones so players can
spawn from that point or teleport between points"* — landed on three things that already existed in weaker form
(`cache` was already a chest, `GuideStone` was already a details stone, `grove`/`den` already woke hostiles) and
one that did not. All of it is authored in the generator and gated offline, because a mechanic that only exists
in the browser cannot be audited.

**The rule.** A waystone links on the first touch and never spends: `strip.link(site)` returns true once, the
stone lights, and the site stays in the world for the rest of the run. Every touch after that asks it for a
hop, and a hop goes to **the next linked waystone in the map's own order, wrapping at the end**. That is the
whole interaction, and it is deliberately not a menu: the mode has no key prompts and no tooltips because a 20
px target and a thumb pad do not mix, so the verb for travelling is the verb for everything else here — walk
into the stone. Two or more touches of other stones reach any node you have been to, and the callout names the
line you are about to arrive on, so "which way does this go" is answerable before you commit.

**The mouth's waystone is waypoint one.** `DungeonSite.entry` is set by the generator on the stone that sits on
the plan's own `spawn` tile, and the director links it *in its constructor* — a flag, not a nearest-site search,
because "closest site to the spawn" is a fact a generator change can invalidate silently while a flag cannot.
So a run that links nothing else still has somewhere to come back to, and "spawn from that point" is answered
by having a network whose root is where you start.

**Warps are counted, not forgiven.** `strip.warpCount` rides out in `game:dungeonEnded` as `warps` and prints in
the run's closing card (`8/8 waystones linked, 4 warped`). Reaching the centre by warping is a legitimate way
to play and it is on the record, which is the only place this mode keeps any record.

**Two guards, both learned elsewhere in this file.**
* A hop lands the party *on* the destination stone, so the overlap that produced it is still true on the next
  frame. `warpArmed` closes on warping and re-arms in `update` only once the warden is 30 px clear of every
  waystone, with a 400 ms floor under it: standing on a stone and mashing into it must not become a roulette
  wheel. The probe walks that rule (step off, step on) rather than poking the fields, so the gate fails if the
  guard is removed.
* The partner comes with them. The mode already has a gate about the ally being left somewhere; a transport
  that strands the courier three lines away is that fault with better manners. A downed partner is left down
  rather than resurrected by a taxi.

**"Deeper you go, harder it gets" is one number: the band's index.** In `planCortex`, `depth = index / (layers - 1)`
spends itself on everything a band holds — groves wake `4 → 11`, a band's site spread goes `2 → 6`, dens go from
one to one-per-round-room with `3 → 6` guards, caches appear `1 → 3` and fields `1 → 2` from band 4, `intensity`
on a field rises to 1.8× (which `DungeonScene` now honours when it seeds mines — previously the field's authored
intensity was generated and then ignored). The gate reads the claim as density, not count, because a band with
more tiles would otherwise pass for having more content: `sites per walkable tile by band 0.0102 0.0124 0.0112
0.0153 0.0203 0.0180 0.0185`, awake budget `10 21 28 35 59 79 49`.

The legend grew to eight lines — `WAYSTONE` sits between `DEN` and `CHART` — and the two gates that check the
card now **read their rule from `GuideCard.tsx`** instead of hardcoding `7`: a legend that gains a row is a
legend that should not have to remember to update a string in a tool file.
