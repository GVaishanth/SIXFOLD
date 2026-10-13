# SIXFOLD — Experience Redesign Map (internal)

Working document for the polish pass. Not shipped to players; kept so the design
decisions stay auditable next to the code.

## 0. How this pass is scoped

The functional base build stays: React 19 + TS + Vite + Phaser 3 + Zustand,
25-element data registry, 200-wave story, ascension, save slots, procedural
art/audio. Nothing is removed to make the redesign easier. Every change below is
additive or a like-for-like replacement of a presentation layer, so
`tools/e2e.mjs` and `tools/audit.mjs` keep passing at every step.

Division of labour (perf rule): Phaser owns entities, projectiles, particles,
world FX and camera. React + GSAP own menus, HUD sections, overlays and
transitions. No per-frame React state.

## 1. Audit — what the current build actually looks like in play

Screenshots walked at 1366×768 and 844×390 (`/home/user/audit/shots`, sheets
A/B/C). Console: no page errors; only the two expected warnings (AudioContext
before first gesture, SwiftShader ReadPixels stalls in the screenshot path).

| Area | Finding | Severity |
| --- | --- | --- |
| Menu | `MainMenuScene` is a drifting grid + 18 floating sprites; content sits in a narrow centred column with ~40% dead space below. Reads as a web page with a canvas behind it. | high |
| Typography | One monospace stack for everything. Title and "PAUSED" have identical voice → no hierarchy, no display face. | high |
| Save slots | Three plain panels of identical weight; no sense of artefact, no reveal on hover. | med |
| New game | Name field + three chips. The permanent choice has no ceremony, no scene reaction, no sound beyond a click. | high |
| Hub | Four equal panels side by side = dashboard. No diegetic space, no "this is my base". | high |
| HUD | Everything is small and floats in corners; bars are thin rectangles; no status row, no objective/currency, resonance invisible. | high |
| Element switch | Data changes and a sound fires; the presentation does not acknowledge it at all. | high |
| Combat feedback | `FxSystem` has hit sparks, damage numbers, shake, zoom punch and a hit-stop primitive, but hit-stop only fires above `criticalPunchThreshold`, crits get one small shake, and every element uses the same spark burst → no impact ladder, no element grammar. | high |
| Boss intro | `bossIntro` state + `callout()` only; no name plate, no identity, no arena change (arena rules exist in data but nothing shows them). | med |
| Boss phases | Phases now advance (fixed this session) but nothing communicates that the boss changed beyond a small gold callout. | med |
| Wave transition | `WAVE X` banner + `Enemies Remaining` counter; the essence/shard tally is a toast in the corner, disconnected from the clear. | med |
| Floor transition | `FLOOR CLEARED` overlay with a `BEGIN FLOOR` button — a modal interrupt, not a chapter beat. | high |
| Skill tree | Radial SVG, correct data, zero atmosphere: no energy on edges, no open/close transition, node hover is a colour change. | high |
| Codex | Locked entries say `???` with nothing else; tabs are flat text; no archive feel. | med |
| Death | Instant card swap; player just stops. No collapse, no music duck, no slow. | med |
| Ascension | Correct numbers, identical look to story mode — nothing says "you left the normal rules". | med |
| Element unlock | A toast. The most exciting progression moment in the game is a notification. | high |
| Mobile | Touch buttons work after the pointer-events fix, but the stick is fixed, there is no press feedback, no haptics, cooldowns are invisible on the buttons, and the element rail was colliding with the stick (hidden, not integrated). | med |
| Motion | Zero transitions between screens; overlays pop in/out at 0 opacity. | high |
| Interaction states | Hover = border colour; no press compression, no error shake, no success feedback, `EmptyState` is a plain panel, locked buttons are `opacity: .4`. | med |
| Depth | Hazards exist for 6 of 10 floors and are pure damage/dps ticks (unavoidable-ish, no positioning value). Elemental resonances exist as passive stat bonuses only — attacking a Wet target with Fire does nothing. | med |
| Audio | Single `sfx` bus + music state machine; rewards, environment and boss layers all share one gain, so nothing can be mixed. | med |

## 2. Target language

* One display face (Silkscreen, OFL, self-hosted, subset to 5.4 kB) for titles,
  numbers, plaques and button labels; one readable UI stack for prose and
  settings; mono only for dense numeric tables.
* Palette per the brief: void/deep/panel/raised/border/text/muted/gold/danger,
  plus the 25 two-stop element gradients as CSS variables generated from
  `ELEMENT_REGISTRY` at runtime (no hand-maintained colour table).
* One accent per screen: story = gold, ascension = a corrupted violet, floor
  screens borrow the floor palette. Never more than two accents at once.
* Surfaces are *carved*: 1 px border + inner top highlight + a 2 px bottom
  shade, corner ticks instead of radius, no blur, no drop shadows except on
  modals. Pixel density comes from 1–2 px detail, not gradients.
* Motion: 90–260 ms, `power2.out` / `power3.inOut`, one stagger step of 26 ms.
  Overshoot only where something physically lands (plaques, pips, bars).

## 3. Interaction + transition contract (reused everywhere)

`src/utils/motion.ts` (GSAP) exports the whole vocabulary:
`enterScreen / exitScreen` (directional, 24 px, 200 ms, staggered children),
`press / release` (0.97 compression + 90 ms spring back), `hoverIn / hoverOut`
(1 px lift + accent bleed), `deny` (3 px directional shake + muted flash),
`success` (green bleed sweep once), `popIn` (scale overshoot), `revealStagger`,
`glowPulse` (finite repeats only), `barFill` (tweened width, not a CSS step).
Every helper is reduced-motion aware and registers its tweens so unmount kills
them (`gsap.context`).

Button/Panel/Tile primitives implement the seven required states: idle, hover,
press, success, error, locked, loading — driven by `data-state`, never by
ad-hoc CSS in screens.

## 4. Screen-by-screen map

| Screen | Redesign |
| --- | --- |
| Menu | `MainMenuScene` becomes a layered Ember-Ruin silhouette (parallax rock bands, drifting ash, ember glow, a rotating six-sigil ring that reacts to the hovered menu entry). React side: wordmark + engraved rule, primary Continue plaque with the warden's element, two supporting tiles, and a carved meta strip (`WAVE 86 / FLOOR V / 12 ELEMENTS / FLOOR NAME`). No dead column, no floating sprite soup. |
| Slots | Each slot = an elemental archive crystal (canvas-rendered from the slot's starter + progress), hover → glow, particle bloom, data reveal, empty slot → dormant crystal with a "begin here" invitation. |
| New game | `THE ELEMENTS AWAKEN`. Three plinths; hovering/selecting drives the scene (tint, particle family, sigil), a per-element ambient sting, description reveals line by line, selected plinth rises and stays lit. Confirm = "seal the origin" with a commit animation, then the hub. |
| Hub | Diegetic pseudo-hub, no scrolling dashboard: chamber backdrop (Phaser) with five interactive zones — portal (story), pedestal ring (loadout), altar (skill tree), archive (codex), crystal (save/statistics) — each a real focusable DOM button aligned to its zone; zone hover lights the geometry, focus draws a rune outline. Ascension/Free-Mode appear as extra gateways when unlocked, so no dead states. |
| HUD | Top-left HP/energy with segment ticks + status row; top-centre floor/wave plaque (ascension gets the cycle numeral + mutation line); top-right essence/shards + objective (`6 REMAINING` / `PHASE 2`); bottom element rail with mastery pips, resonance chip and switch-cooldown sweep; bottom-right ability cluster with radial cooldowns. Compact at short viewports instead of scaled. |
| Skill tree | Open = gameplay freezes → canvas dims → tree draws itself in (edges trace, cores ignite, node pop) → settle. Close = reverse. Energy travels along unlocked paths (dash-offset animation, finite and pause-aware); selected element becomes the focal core; hover lights the branch. |
| Codex | Archive pages: glyph plate, role line, ability cards, parent/child/resonance links, mastery bar, and for locked entries partial truth (`Origin: UNKNOWN · Resonance: Fire + Smoke · First discovered: —`) plus a silhouetted plate. |
| Boss | Intro = time dilation, arena band pulses, name plate slides in (name / element identity / epithet) then shatters into play. Phase change = banner + arena rule caption (`THE PACT CLOSES IN`), music intensity step, new particle colour, HUD bar tint shift. |
| Wave / floor | Wave clear = `WAVE 37 CLEARED` plaque with `+142 ESSENCE · +1 SHARD` flying into the top-right counters, then the next countdown melts in. Floor = chapter beat: floor band sweeps across, roman numeral, name, subtitle, palette cross-fade, control returns without a modal. |
| Unlock | Element unlock = brief dilation, glyph ignition, branch line from parent, identity, where it sits in the graph, and two choices (`EQUIP` / `CONTINUE`) — never a toast. |
| Death | 240 ms dilation, player dissolves into element motes, music ducks, then the fallen plaque with checkpoint line; RESPAWN is instant. |
| Ascension | Accent shift to corrupted violet, cycle numeral on the plaque, mutated spawn rings, "beyond the story" HUD rule, stronger enemy indicators. |

## 5. Feel pass (Phaser only)

* Impact ladder in `COMBAT_CONFIG.impacts`: light / medium / heavy / massive —
  hit-stop ms, shake px, zoom punch, particle count, knockback, flash frames,
  sfx gain. Normal attack = light, crit = medium, skill = medium-heavy,
  ultimate = massive, boss phase = cinematic. Data-driven, so tuning stays in
  config, not in `Player`.
* Anticipation + follow-through on attack (2-frame wind-up, recoil), squash &
  stretch on dash land, hurt flash + knockback on player, death disintegration.
* Per-element VFX grammar generated per element family: ember trails + heat
  shimmer (Fire), droplets + ripples (Water), curved streaks + dust (Air),
  branching bolts + white flash + chain ticks (Lightning), shard burst + frost
  ground (Ice), violet core + turbulence + pierce trail (Plasma), etc. Selected
  in data (`attack.vfx` / `skill.vfx`) and consumed by `FxSystem`.
* Element switch: never pauses; ≈0.12 s camera micro-punch, ring burst at the
  player, aura + trail + projectile texture recolour, rail flip, one sfx.
* Damage numbers: tiered size/colour/rise, crits pop larger with a 40 ms delay
  so the impact reads before the number; cap respected by the existing budget.

## 6. Systems added

* **Elemental reactions** — `src/data/elements/reactions.ts` + `src/game/systems/reactionSystem.ts`.
  Rules are keyed by (attacking element, target tag set) where tags come from
  statuses, fields and hazards; the resolver returns effects to apply
  (damage, status, field, control, VFX, sfx, HUD callout) and is called from the
  shared damage pipeline, so enemies and bosses trigger them too. Ships the six
  requested reactions (Steam, Electrified Water, Burning Vines, Frozen Surface,
  Firestorm, Conductive Crystal) with no per-enemy code paths.
* **Hazards as positioning puzzles** — every floor gets a hazard definition
  with telegraph, shape, safe corridor and an element interaction hook
  (currents conduct, vines burn, ash hides, ice reduces friction, pools react).
  Damage is avoidable and secondary to placement; nothing is a constant DPS tax.
* **Audio buses** — `ui / combat / element / boss / environment / reward` with
  per-bus gain from settings, plus ambience per floor and a boss intensity step.

### 6.1 What is actually wired now (measured, not planned)

| System | State | Evidence |
| --- | --- | --- |
| Impact tiers (§12) | **Live** | `COMBAT_CONFIG.impacts` drives `Enemy.takeDamage` → `fx.impact` (hold, shake key, ring, squash, spark count, audio rate). Promotion at 4.5 / 7.5 / 12 % of max HP, plus crit and ultimate promotion; boss pools keep ordinary hits at `normal`/`skill` so shake stays rare. |
| Element switching (§10) | **Live** | `Player.switchElement` → `fx.elementShift` (screen wash + zoom punch), a squash along the switch axis, a wider family-tinted spark burst, the slot ring and the switch sfx. No pause, no input lock. |
| Reactions (§26) | **Live** | `data/elements/reactions.ts` (six rules) + `combat/reactionSystem.ts`, called from `Enemy.takeDamage` with a *pre-hit* status snapshot so the incoming hit cannot self-trigger. `tools/audit.mjs` asserts the differential (fire on a slowed target: 6 → 11 damage, and the slow is consumed). |
| Hazards (§27) | **Live** | `game/world/hazards.ts`: ten floor behaviours, each a weighted list of steps (`burst / field / mine / wall / strike / wind / chill`) with telegraph time ≥ 420 ms, placement mode (`aroundPlayer / anchored / lane`), cost as a share of max HP, an element (so floors react with abilities), statuses, and a low-HP mercy factor. The scene's old damage-tax `switch` is gone; `HazardDirector` owns it and `FieldManager` caps live fields at 8. |
| Warden intro (§13) | **Live** | `WaveDirector` → `onBossSpawn` → arena threat mood + wash + rings + squash + hit-stop + zoom, and a React plate (name, epithet, element, HP, phase list, brief). The wave banner stands down on boss waves so the arena announces once. |
| Phase change (§14) | **Live** | Colour wash, hit-stop and a silent `bossPhase` impact on top of the existing shake and ring; the plate's phase list and `boss-plate` PHASE readout tell it in words too. |
| Wave transition (§15) | **Live** | `game:waveCleared` now carries the wave's real earnings (essence plus the shard roll that was actually granted) and the HUD strip counts them up, then leaves. |
| Chapter transition (§16) | **Live** | `TransitionContent.chapter` renders as a set piece (`ChapterCard`): wipe clip-in, floor numeral, display-face name, tagline, "LEAVING …", ground/wardens/signals columns with the floor's hazard brief, then control returns. |
| Viewport fit (§24) | **Live** | `game/systems/viewport.ts` replaces Phaser's `Scale.FIT`: the render buffer is sized from the host element at an *integer* zoom (largest that still shows 320 px across and 160 down), so 16:9 keeps the authored 320×180 framing and every other window shape widens or lengthens the view instead of bar-ring it. A `ResizeObserver` plus `orientationchange` keep it matched; the arena's vignette, light pool and backdrop re-fit on `scale:resize`. |
| Frame furniture | **Live** | The backdrop gradient continues past the arena walls (`BACKDROP_PAD`), the radial glow is kept inside them, and a shadow apron plus two mirrored floor-tile lips outside the walls make the extra frame read as a hall. Menus do the same through `Atmosphere.reframe()`, which lays the composition out against the **frame** rather than the authored band: the sky plate is regenerated at the frame's size (a stretched 320×180 plate banded and turned its one-pixel stars into blobs on a tall window), the tiled bands are widened to the painted extent and hung from the frame's floor, and the sigil and ground light are centred on the camera's view. The paint bleeds 4 px past every edge so the ±2 px pointer tilt can never peel it off a side. Measured by `npm run audit:fit`: zero unpainted edge on 5 shapes × 2 viewport states (before and after a live resize), and exactly one sky plate alive — the old centring left a flat black apron under the menu and a vertical seam down the right of the screen. |
| Page fit | **Live** | Full-screen pages were floored at `max-height: 46vh`, so content scrolled inside a short window while the bottom half of the frame sat empty. `.scroll-y` is now the flex child that takes whatever the header leaves (`flex: 1 1 auto; min-height: 0; overscroll-behavior: contain`), `.screen-inner > *` can no longer be crushed by the column (it was squeezing the skill tree's own canvas to a sliver between its panels), a page's top-level columns stop stretching to their tallest sibling, and on a wide frame the skill tree is a real layout: structure left, element and mastery cards beside it — measured to fit 1366×768 with no page scrollbar. `tools/page-fit.mjs` (`npm run audit:fit`) now walks 7 screens across 5 shapes in both orientations and compares rendered boxes with JS instead of by eye: **0 FAIL / 0 WARN**, `.screen-inner` at 91–97 % of the frame, `pageScroll 0`, `overflowX 0`, and landscape — the case that used to fill 17 % of its container — at 108 %. |
| Opening grace | **Live** | `DIFFICULTY.open*` + `waveGenerator.openingEase()` ease count, HP, damage, speed, hazard intensity, elite chance and the per-hit damage cap over the run's first six waves, tapering off by wave 12. Keyed to the *run* wave, so a Free Mode floor chosen directly gets no discount, and waves 12+ are numerically identical to before. |
| Mobile UI check (§23/§24) | **Live** | `tools/mobile-audit.mjs` walks five shapes (360×640, 390×844, 430×932, 844×390, 820×1180) × five screens and asserts overflow, document scrolling, 40 px touch floors, `touch-action`, sub-9.5 px text, control↔HUD and control↔control overlap, plus — through the dev scene handle — the world buffer, integer zoom, sprite size projected to CSS pixels and whether any live hostile sits under a thumb control. Current run: **0 FAIL**, 40 WARN (target and type floors only), `overflowX 0`, `bodyScrolls false`, `collide 0`, `underControls 0` with four hostiles in the arena. `docs/UPGRADE_AUDIT.md` holds the findings and ranked fixes; the same run after the pass is **0 FAIL / 0 WARN**, and it additionally requires the *player* never to sit under a control, requires no live hostile to be *hidden* by one (pads are 0.42–0.6 opaque, and the camera biases the warden into the clear band above them), and requires `navigator.vibrate` to have actually fired. |
| Handheld framing (§24) | **Live** | `world/worldFrame.ts` owns one derived world buffer (320×180 max, zoom 8, never under 160 world px tall, pixel-snapped, re-planned on every resize); `arena.planFrame` sizes the playfield from it and `clampToFrame` keeps the *camera* — not the arena — responsible for filling the screen, with a fixed overscan strip so the camera can hold the warden above the thumb band. Phones play 443×363 with 116 % vertical coverage instead of a 360×640 view of a tiny arena. |
| Touch & haptics (§23) | **Live** | `TouchControls` over `PointerController` on two extra pointer slots; a named-pattern haptic table called from 7 sites, silent on ordinary hits, suppressed while paused or dead, switchable in Settings alongside Interface scale (`--hud-scale`, 85–145 %). A `(pointer: coarse)` block floors interactive CSS at 40–46 px, raises the micro/label tokens, makes the pads translucent, and turns the skill tree into an explicit pan surface instead of a shrunk one. |
| Installable + Pages (§37) | **Live** | Manifest with relative `start_url`/`scope`, `orientation: any`, 4 procedurally generated PNG icons (`npm run icons`, nothing binary committed), `apple-touch-icon`, `color-scheme`, and the display font preloaded from the hashed build output by `transformIndexHtml`. `npm run audit:pages` builds with `VITE_BASE_PATH=/sixfold/` and asserts the served `dist`: 15 checks, 15 passed. |
| Unlock moment (§29) | **Live** | `components/hud/UnlockCelebration.tsx`. An unlock claims one slot in `uiStore` (`claimUnlockMoment`, taken before `game:elementUnlocked` goes out, so the HUD listener stays quiet instead of stacking a toast on top of the card); the card opens with `popIn`, the rule between glyph and copy is drawn with `drawLine`, the copy arrives with `staggerIn`, and the element's own colour is the accent. It offers EQUIP — which writes the real loadout through `setLoadout` *and* `command:setLoadout`, so it applies to the live run — and CONTINUE, closes on Escape without leaving a pause behind, and lets go of the screen by itself after 2.6 s. It never pauses the fight: the world half is a short `fx.hitStop` plus a ring and callout at the warden, and the card sits over the field with `pointer-events` only on itself, so the thumb sticks stay live. Measured by `/home/user/audit/unlock.mjs`: 17/17, including that the card names the element the save actually gained and that EQUIP changes `loadout.slots`. |
| Skill-tree structure | **Live** | The tree was a radial: nodes on a ring, edges across the middle, no reading order. `utils/treeLayout.ts` now layers it by *fusion depth* (an element sits one row below its deepest parent, cycle-guarded), orders each row by neighbour barycentre, then spreads it evenly and de-overlaps twice, so the picture is four labelled strata — PRIMORDIAL, BRANCHING, ADVANCED, FINAL — with a hairline rule between them. Edges are cubic paths with 23 px stubs leaving a node straight up and arriving straight down; a lit lineage runs one dashed `link-energy` animation and stops under `[data-reduced-motion]`. Locked nodes read as `?????` over what actually opens them (`STARTER`, `WAVE 15`, `BOSS`), because a silhouette with no rule attached is a riddle, not a gate. A stale `.node-link { stroke }` rule was painting every edge the same dark navy (CSS beats the presentation attribute), which is why the tree looked unconnected; the rule is gone and the attributes own colour and weight. Measured at 1366×768: 25 nodes in exactly 4 strata, `overflowX 0`. |
| Settings fit | **Live** | The page was 1205 px of content in a 732 px frame — it did not scroll badly, it simply ran off the bottom. Two causes: one column of thirteen rows, and a `.setting-row` template (`minmax(140px,220px) 1fr auto`) that did not match the component's two children, so the control drifted to a middle track and the label capped at 140 px and wrapped. Now `SettingsScreen` is a grid of panels (AUDIO / READABILITY / CONTROLS / PERFORMANCE), the row is `minmax(0,1fr) auto` with a right-aligned `.setting-control`, and the grid is two *wide* columns at ≥1080 px rather than three cramped ones — at 300 px per panel the three-button quality row wrapped and gave back all the height the split had saved. Note that `.grid.settings-grid` must repeat both classes: a single-class rule loses to `.grid.cols-2` and squeezed every panel to 262 px. Measured: **`innerScroll 732` in `innerH 732`** at 1366×768, 764/764 at 1280×800, 814/814 at 1512×850, `overflowX 0` everywhere, and no row taller than 41 px on desktop (390×844 stays one column and scrolls by design). The same controls render inside the pause overlay through `SettingsControls({ group })`, which is why the split is component-level, not copy-pasted. |
| Loadout placement | **Live** | Two bugs, one gesture. Tapping a slot while an element was picked called `place()` *and* set the slot's own picker, so the element landed and the popover opened over it; now the slot commits once. And the picker that replaces the 600 px drag is a **portalled** popover anchored to the slot's rect (`position: fixed`, width matched, flipped above when the viewport is short below, closed on Escape or click-away, and *repositioned* rather than dismissed on scroll and resize — inline, it grew the card, reflowed the grid and was clipped by the panel's overflow, which is exactly the "too far to reach" complaint in a different costume. Measured: the popover survives a 120 px wheel and moves with its slot (top 456 → 336, still open), and at 390×844 it flips above the slot at y=92 with its items hit-testable at their own centre — a `elementFromPoint` assertion, because a clipped popover has a bounding box and no pixels. Every element row carries AIM / REPLACE / EQUIP, an `ALL / NOT EQUIPPED` filter sits in the picker head, and a filter that would leave nothing to choose falls back to the full list with a line explaining that picking a placed element moves it. |
| AUTO-BEST | **Live** | `game/systems/loadoutAdvisor.ts`: `scoreElement` (tier + mastery + damage + current resonances) and `bestLoadout`, greedy and **re-scored after every pick** so the sixth choice sees the five already made; a brand-new resonance pair is worth +26, which is what makes it prefer a combo over a raw damage stat. The toast names each pick and *why*, so the recommendation is inspectable rather than magic. It can only use what the save has unlocked, so a starter-only save gets a one-element rig and says so. |
| Derived stats pager | **Live** | `components/ui/Pager.tsx`: a scroll-snap track (the scroll position is the single source of truth for the page), arrows, dots, `←`/`→`, and a `ResizeObserver` so a rotation re-reads the page width instead of stranding the track half-way. OFFENCE and SURVIVAL are two pages rather than one tall panel, because the ten stat cells only fit a phone one way at a time. Verified at 390×844: track 332 px inside a 390 px viewport, 2 pages, a touch on NEXT moves `scrollLeft` to exactly one page width. |
| Multi-element rig (§10) | **Live** | The complaint was that only one element could be used at a time. Now: the slot in hand is entirely the player's — aim, timing, energy, skills, ultimate. Every *other* equipped element is a support cast owned by `game/systems/autoCast.ts`: it finds its own target (bosses and elites weighted up so unattended fire is not wasted), keeps its own cycle (1500 ms at mastery 1, up to 30 % shorter at high mastery), spends **no energy** so it never taxes the player's own shot, and lands with a base **50 % accuracy** that mastery buys back to 95 % (+5 pp a level). A low-confidence cast is *aimed* wrong — the spread is real, the projectile still fires and can still start a reaction for the player to finish. `AUTO_CAST.enabled: false` returns the game to switch-to-cast without touching a system. The rail shows it: an unsupported slot is dashed, holds a hairline charge bar, and its accessible name reads "auto-casting at 65 % accuracy"; the loadout screen quotes the same number through `autoCastAccuracy`, so UI and sim cannot drift. Measured in a live run with three elements equipped: two support slots cycling (charge 0.41 → 0.83, 0.73 → 0.15 across 700 ms — a fired cycle restarts), and the accuracy badges `AUTO 65%` / `AUTO 85%` for a LV 4 and a LV 8 element. |
| Wave-end gather | **Live** | Drops that outlive their wave were a reward the player never saw: orbs sat on a field they were about to leave, and chasing them before the gateway opened is a chore, not a decision. `GameplayScene.vacuumPickups()` runs off `onWaveCleared` and flies every loose pickup to the warden through the *same* `collectPickup` path as walking over it — staggered 34 ms apart so it reads as a pull, bodies disabled for the flight so the magnet and drag do not fight the tween, and `if (pickup.active)` on arrival so nothing is credited twice. A boss is a special case in a bad way: the wave's clear fires the moment the arena is safe, which is *before* `onBossDefeated`'s staggered reward bursts have finished landing, so a boss's own loot used to sit on the floor until the next wave. The defeat path now queues a second gather after the last burst, and `Pickup.gathering` (cleared in `retire`) makes a double gather structurally impossible rather than order-dependent — an orb is credited once. Dev builds log how many each gather found, because a gather is otherwise invisible to an auditor. Measured on ordinary waves: 7–8 pickups gathered per clear, run essence 26 → 32 after the strip appeared (nothing else could have paid out). Measured on a real boss wave (`audit/boss-gather.mjs`, 7/7, walked there with the dev wave jump): gather #1 took 8 at +0 ms, gather #2 took **5 more** at +611 ms — the tail, which is exactly what used to be left behind. |
| Hub from the title | **Live** | THE HALL sits next to CONTINUE on the main menu for any save: `selectSlot(activeSlot); navigate('hub')`, the same slot link the vault performs, minus the run. Relics, pedestals, loadout and codex were reachable only by starting (or resuming) a fight, which turned "let me re-key my elements" into "let me commit to a run". It opens the hub with nothing advancing, and the gateway still has to be stepped through to play. |
| Motion surface | Guarded | React touches GSAP only through `utils/motion.ts`; this pass added `scheduleBeats`, `fadeOut`, `drawLine` (event furniture needs a *finite* schedule, and components must not import GSAP). |

Verified with `npm run build` clean, `node tools/audit.mjs` (9 checks) and
`node tools/e2e.mjs` (18 checks, twice back to back) green on the dev server,
zero uncaught page errors in either, and no horizontal overflow at 390×844 with
the touch layer mounted. The viewport claim is measured, not asserted:
`audit/viewport.mjs` compares the canvas rect with the viewport and samples the
rendered frame at 390×844, 1366×768 and 1024×768 (and after a live resize to
900×900), and `audit/mobile-hud.mjs` fails on any rectangle overlap between the
HUD quadrants, the event furniture and the thumb zone. `audit/pages.mjs`
walks every full-screen page at 1366×768 and 390×844, reporting how much of the
frame the page body uses (`unused`) and whether the page itself scrolls — that
is how the 46vh floor was found and how it stays fixed.

The structure/loadout/settings/gather round was walked by two purpose-built
probes rather than by eye: `/home/user/audit/round.mjs` (**22/22** at 1366×768 —
title→hub, the seeded rig's accuracy badges, the anchored picker *hit-tested* so
clipping cannot pass for painted, AUTO-BEST, the pager, settings fit, the tree's
strata, the rail's live support cycles, and the gather's payout) and
`/home/user/audit/phone-round.mjs` (**10/10** at 390×844). The whole chain was
re-run after: `npm run typecheck`, `node tools/audit.mjs`, `node tools/e2e.mjs`,
`audit:mobile` (25 screens, 0 problems), `audit:fit` (35 screens, 0 problems),
`npm run build` and `audit:pages` (15/15).

### 6.2 Still open in the redesign

* §13/§16 *music* steps (the intro stinger rides the `boss_enter` cue; there is
  no separate boss theme or intensity layer yet).
* §34 is closer than this map used to admit: `systems/audio.ts` already runs
  **three buses** (`masterGain`, `sfxBus`, `musicBus`) with per-bus volume ramps
  and a duck of the music bus while muted. What is left is music depth, not mix
  architecture.
* §31 ascension presentation beyond the violet accent
  (`:root[data-mode='ascension']`) and the `LOCAL n` cycle readout. The §17 structure pass itself shipped — see
  the tree row above, including mobile panning, which is now a pan surface with
  an explicit hint rather than a shrunk map.
* Payload: the tree/codex/rewards screens are still eagerly imported, and raw
  `px` literals outside the token sheet remain — both are listed in
  `docs/UPGRADE_AUDIT.md` §4 with counts.

### 6.3 Harness notes

`tools/audit.mjs` and `tools/e2e.mjs` drive the *current* labels (NEW WARDEN →
THE VAULT → CHOOSE YOUR FLAME → BIND AND BEGIN → CREATE WARDEN → STEP THROUGH),
read the wave from `.hud-tc .wave-number` and the objective from the `CLEAR n`
line, and the audit now walks live-scene assertions through the dev-only
`__sixfoldGame` handle. Playwright is not a project dependency: it is resolved
from the project, `SIXFOLD_PLAYWRIGHT`, or the `npx` cache.

Two harness traps worth remembering: an edit to `src/` immediately before a run
makes the dev server HMR-reload mid-test (the pause-menu clicks then time out —
re-run once, or run the harness after the build settles), and restarting a run
*onto* a boss wave cannot reach the chapter card by killing things, because the
card only fires off a cleared wave at a `localWave % 20` boundary. `audit/events.mjs`
accepts `SIZE` and `TOUCH=1` so the whole event suite can be re-walked at phone
size.

* `tools/mobile-audit.mjs` must wait for `director.state === 'fighting'` **and** an
  active child in `scene.enemies` before measuring the world: the opening countdown
  prints `CLEAR 4 HOSTILES` while the arena is empty, so waiting on the objective
  text measures nothing and reports a clean run (a `0` was our probe, not the game).
* `scene.player` *is* the `Phaser.Physics.Arcade.Sprite` (`entities/Player.ts:53`),
  so `player.sprite` is `undefined`, and arcade `getBounds()` returns a plain
  `{x,y,width,height}` — no `centerX()`.
* Playwright page-evals are module-less: constants must live inside the evaluated
  function, `.touch-*` is not a valid selector (`[class^="touch-"]`), `Game` has no
  `.cameras` (go through `scene.cameras.main`), and `report.json` is a top-level
  *array* per shape with `screens.<name>.world`, not a `{verdicts}` object.

## 7. Acceptance (all must hold at the end)

1. `npm install` + `npm run build` clean; `npm run typecheck` clean; no `any`.
2. `node tools/audit.mjs` and `node tools/e2e.mjs` pass on dev **and** on the
   built output (plus `tools/feel.mjs` for the new systems).
3. No screen scrolls horizontally at 360×800, 390×844, 412×915, 768×1024,
   1280×720, 1366×768, 1920×1080; touch layer usable at all three phone sizes.
4. Full loop playable end to end with keyboard *and* touch only.
5. Reduced motion removes all non-essential animation, including hit-stop.
6. No React state updates per frame; no leaked GSAP tweens/timers after
   unmount; particle/tween counts bounded under load (audited in `tools`).
7. Console clean apart from the documented autoplay + software-GL notices.
