# SIXFOLD — mobile / UI / code audit and possible upgrades

Date: 2026-10-10 · branch state after the P8 "complete experience redesign" pass.
Everything below is measured, not inferred: numbers come from `tools/mobile-audit.mjs`,
`tools/audit.mjs`, `tools/e2e.mjs`, `npm run build`, and the probes in `/home/user/audit/`.

> **Re-measured after the mobile pass that followed this audit — the three P0 items are closed.**
>
> | item | was | now (same harness, `npm run audit:mobile` / `audit:fit` / `audit:pages`) |
> |---|---|---|
> | 2.1 actor size | 8×8 CSS px warden, 10 hostile | **16 px warden, 20 px hostile**; arena 443×363 on 390×844, vertical coverage 116 %; `overflowX 0` |
> | 2.2 touch floors | 100+ sub-40 px controls, 15 of them 25–36 | **0 sub-40 px controls on any measured screen**; `.btn` 44 / `.btn.small` 40 / rail + element slots 44–46 / `.switch` 68×40 / `.slider` 40 / `.wall-cell` 42; pads translucent (alpha 0.42–0.6) so they hide nothing, and the player is never under one |
> | 2.3 haptics | no `vibrate` call in the repo | `src/utils/haptics.ts`, 7 call sites, strongest-wins 90 ms window, silent on ordinary hits, switchable in Settings; the audit asserts **`navigator.vibrate` actually fired** (3–5 pulses in a short fight) |
> | mobile audit | 0 FAIL / 40 WARN | **0 FAIL / 0 WARN**, 5 shapes × 5 screens |
> | page fit | 1366×768 spot check | **0 FAIL / 0 WARN**, 7 screens × 5 shapes, `.screen-inner` 91–97 % of frame, landscape 108 % (was 17 %) |
> | unlock presentation (§29) | toast + a number change | `UnlockCelebration` card (glyph reveal, drawn rule, Equip/Continue, self-dismissing, never pauses the fight) + a world-side `hitStop`/ring at the warden; `/home/user/audit/unlock.mjs` **17/17** |
> | Pages / PWA | not checked | `npm run audit:pages` → **15/15** against a real `/sixfold/` build; manifest + 4 procedural icons; the production build plays at the handheld plan |

## 0. How to run the check yourself

```bash
node tools/mobile-audit.mjs          # 5 phone/tablet shapes × 5 screens, ~4 min
node tools/audit.mjs                 # 9 gameplay/save/animation rules
node tools/e2e.mjs                   # 18 interaction + accessibility rules
npm run build                        # tsc -b + vite build
```

`mobile-audit.mjs` writes `audit/mobile-audit/report.json` plus 25 screenshots (one per
shape × screen) and prints `verdicts`: `FAIL` = something is broken, `WARN` = a heuristic
floor was missed. `SIXFOLD_URL=http://localhost:4173/` audits the production build.
There are no `npm run` aliases for these yet (upgrade §4.1).

One trap for whoever extends it: a wave opens on a **countdown**, so the objective line reads
`CLEAR 4 HOSTILES` while the arena is still empty. A scan that only waits for that text (or
for a sprite handle) measures nothing and reports a clean run. `scene.player` *is* the
`Phaser.Physics.Arcade.Sprite` (`entities/Player.ts:53`), so there is no `player.sprite`, and
arcade `getBounds()` returns `{x,y,width,height}` without `centerX()`.

## 1. Verdict

The mobile build is **correct** and **not yet comfortable**.

Correct: zero horizontal overflow, zero document scrolling, zero control↔HUD and
control↔control overlaps on 25 screen/shape combinations, and **zero live hostiles under a
thumb control** — the scan waits for `director.state === 'fighting'` with active bodies
(`alive: 4` on every shape), projects each sprite's world rect into CSS pixels and then tests
it against the control boxes, on 360×640, 390×844, 430×932, 844×390 and 820×1180. Safe-area padding,
`overscroll-behavior: none`, `touch-action: manipulation` on controls, `touch-action: none`
on the canvas and touch layer, suppressed tap highlight, `focus-visible` rings and
`aria-live` HUD/toast regions are all in place (upgrade map §6.1).

Not comfortable: on a portrait phone the **world renders at zoom 1**, so the player is
**8×8 CSS px** and a normal hostile **10×10 CSS px** (≈1 % of screen height), against
~32 px and ~40 px on desktop. Every other finding below is smaller than that one.

## 2. P0 — fix before shipping to a phone

### 2.1 Actors are 4× smaller on a phone than on a desktop · **CLOSED**
| shape | zoom | view (world px) | player on screen | hostile on screen |
|---|---|---|---|---|
| 360×640 | 1 | 360×640 | **8×8 CSS px** | **10×10** |
| 390×844 | 1 | 390×844 | **8×8** | **10×10** |
| 430×932 | 1 | 430×932 | **8×8** | **10×10** |
| 844×390 | 2 | 422×195 | 16×16 | 20×20 |
| 820×1180 | 2 | 410×590 | 16×16 | 20×20 |
| 1366×768 | 4 | 342×192 | 32×32 | 40×40 |

(`report.json` → `screens.playing.world`, player/hostile bounds projected world→CSS.) The
desktop row is the one derived figure: its buffer and zoom are measured by
`audit/viewport.mjs`, multiplied by the world sprite sizes measured above — the audit itself
only walks phone and tablet shapes.

* **What is *not* wrong** — the phone sees *more* of the field than a desktop, not less:
  390 of the 880-wide arena (44 %) against 342 of 880 (39 %). Hostiles sampled outside the
  view (e.g. `x = -110`, `-197`) are normal: `GameplayScene.ts:239-242` bounds the camera to
  the arena and follows the player, so the field scrolls. The defect is purely actor size.
* **Cause** — `src/game/systems/viewport.ts` demands at least `BASE_VIEW.width` (320 world px)
  in the view and only integer zoom, so every frame under 640 CSS px lands on zoom 1.
* **Why "just allow zoom 2" is not enough** — a 390-px phone at zoom 2 sees 195 of 880 world
  px (22 %): actors double but you stop seeing incoming waves, which is the opposite of §27's
  positioning decisions. Both knobs have to move together.
* **Recommended fix** — scale the *arena* with the frame. Give `ARENA` a coarse-pointer
  variant (≈440×520) resolved where the frame is already known (`viewport.ts`), so zoom 2
  keeps the desktop's relative framing (195/440 ≈ 44 %) with 16–20 px actors and a shorter
  run from thumb to thumb. 22 `ARENA.width/height` reads live in three files —
  `world/hazards.ts` (10), `world/arena.ts` (9), `scenes/GameplayScene.ts` (3) — so the change
  is "one resolver + swap those reads for `scene.arenaDims`", plus re-`setBounds` in the
  existing `resize` handler (`arena.reframe()` is already called there). Keep
  `MIN_VIEW_HEIGHT` for landscape.
* **Cost** — ~120 lines, config + three files. Re-run `audit/viewport.mjs`,
  `tools/mobile-audit.mjs` (its sprite-size WARN should disappear) and `tools/audit.mjs`
  (wave layouts/hazards must still clear). Verify the atmosphere and ground lips still cover
  the buffer — the backdrop padding (`BACKDROP_PAD 420`) is sized against the old arena.

### 2.2 Touch targets miss the floor on every shape · **CLOSED**
* **Evidence** — measured control heights: pause `.btn` **36 px** at all five shapes
  (`RESUME / ELEMENTS / SKILL TREE / SETTINGS / ELEMENT CODEX / SAVE & EXIT`, 290–514 px
  wide); hub secondary actions `.btn.small` **28 px** (`ARRANGE LOADOUT`, `SKILL TREE`,
  `OPEN CODEX`, `FREE MODE`, `ASCENSION I`); the element rail slot **30–34 px**; settings
  `Slider` input **130×6** and `Toggle` **46×22**; difficulty chips `LOW/MEDIUM` 28 px.
* **Fix** — one `@media (pointer: coarse)` block in `global.css`: `.btn { min-height: 44px }`,
  `.btn.small { min-height: 40px; padding: 10px 12px }`, `.rail-slot { width: 44px; height: 44px }`,
  `.hud-bl { gap: 7px }` (the rail is the tightest cluster), `input[type='range'] { height: 30px }`
  with a taller thumb, and `Toggle` `min-height: 34px` with a larger `::before`. Do not touch
  desktop sizes — the media query is the whole change.
* **Cost** — ~30 lines of CSS. Re-measure with `node tools/mobile-audit.mjs`; the WARN list
  for `targets` should go to zero.

### 2.3 No haptics (P8 §23 asked for them explicitly) · **CLOSED**
* **Evidence** — `grep -rn "vibrate" src` → nothing.
* **Fix** — `src/utils/haptics.ts`: a small named-pattern table (`tap 8 ms`, `hit 12`,
  `kill 18`, `hurt 30`, `dash 10`, `bossPhase [24, 40, 24]`, `unlock [12, 30, 60]`), a
  `pulse(name)` that no-ops when `!navigator.vibrate`, when `pointer: fine`, or when the
  settings toggle is off, plus a `Settings` row. Call it from three places only:
  `CombatFX` impact tier promotion, `Player` damage/death/dash, and `useTouchControls`
  press — never per frame.
* **Cost** — ~70 lines total. iOS Safari ignores `navigator.vibrate`, so this is a
  Chromium/Android win and a no-op elsewhere; say so in the code comment rather than
  pretending it works everywhere.

## 3. P1 — legibility and presentation

| # | Finding | Evidence | Fix |
|---|---|---|---|
| 3.1 | 8–9 px chrome text on every phone shape | measured live in all three play screens: `.objective-label` **8 px**, `.floor-name` **8.5 px**, `.wave-of` **9 px**; hub adds the gate-rail labels at 8.5 and `.plaque-label` / `.tag` at 9 (`report.json` → `screens.*.tinyText`) | raise these to a 9.5–10 px floor inside `@media (pointer: coarse)` — see 3.2 for why this wants a token first |
| 3.2 | there is no type scale to raise | `global.css` holds **94 literal `font-size: …px` declarations**, 39 of them ≤10 px, and **zero `--fs-*` tokens** (`--text*` are colours); 32 of the 94 already read `calc(Npx * var(--hud-scale))`, so 62 rules ignore the one scaling knob that exists | introduce `--fs-1…--fs-7` in the `:root` token block, rewrite the literals (mechanical, `grep -c` before/after is the check), then the mobile floor is one `--fs-1: 10px` override instead of 39 edits |
| 3.3 | the skill tree needs hidden horizontal scrolling on a phone | `.skill-tree-svg { min-width: 900px }` (`global.css:1056`), relaxed only to **780 px** at small frames (`:1521`), while `.skill-tree-wrap` is ~366 px wide at a 390 frame → the 1000-unit structure renders at 0.78 user-unit→CSS px in a 780-px box, so over half the tree sits outside the window with no affordance. Labels themselves measure **9–14 CSS px** (measured via `getScreenCTM`), so they are *not* the problem — the crop is | scale-to-fit is the wrong instinct (0.366 would put labels at ~4 px). Instead: keep a pannable map, drop the small-frame `min-width` to ~600 px, add an edge fade + `DRAG TO PAN` tag when `scrollWidth > clientWidth`, and `touch-action: pan-x pan-y; cursor: grab` on the wrap. A dedicated one-column mobile branch layout is the larger, nicer version |
| 3.4 | `--hud-scale` is a dormant knob | `:root { --hud-scale: 1 }` and 32 font rules multiply by it, but no code ever writes it (no `hudScale` in `settingsStore` / `SettingsScreen`) | expose it as a Settings slider (0.9–1.4); this is also the honest answer to `user-scalable=no` in the viewport tag, which is a deliberate no-zoom trade for touch fidelity. Wire it through `settingsStore` → `document.documentElement.style.setProperty` in one effect |
| 3.5 | Installable-PWA meta is missing | `index.html` has `viewport-fit=cover` + `theme-color` but no manifest link and no `apple-mobile-web-app-capable` | add `public/manifest.webmanifest` (`display: standalone`, `orientation: any`, theme `#06080F`) and the `apple-mobile-web-app-*` pair; icons stay procedural — `scripts/gen-icons.mjs` with builtin `zlib` writes 192/512 PNGs at build time, no new dependency |
| 3.6 | First paint waits on the pixel face | `@font-face` is `font-display: block`, so a slow font fetch means up to 3 s of invisible Silkscreen; the file is only 5.45 kB | `font-display: swap` + `<link rel="preload" as="font" crossorigin>` in `index.html`; keeps the no-jump intent (the metrics are already `size-adjust`ed) |
| 3.7 | §29 unlock celebration is still unbuilt | no `unlockCelebration`/`UnlockReveal` module; a new element currently surfaces as one `.toast` plus a `Tag` number change | a single `UnlockMoment` overlay reusing `motion.wipe` + `popIn` + `drawLine`/`flowAlong` on the tree edge that unlocked it, ≤1.2 s, `Equip / Continue` actions only — no new animation engine |

## 4. P2 — housekeeping that pays

1. **No `npm run` entry points** for the harnesses: add `"audit"`, `"e2e"`, `"mobile"`,
   `"verify": "npm run typecheck && npm run audit && npm run e2e && npm run build"`.
2. **Graduate the throwaway probes.** `audit/pages.mjs` (page-fit walk), `audit/viewport.mjs`
   (buffer edges + live resize) and `audit/events.mjs` (HUD furniture + console capture) have
   each caught a real bug; move them to `tools/` and let them emit the same `verdicts`
   array as `mobile-audit.mjs`.
3. **Longest files** — `GameplayScene.ts` 1445, `global.css` 4396, `elements.ts` 1795,
   `bosses.ts` 1254, `Player.ts` 1029. The scene splits cleanly into spawn/wave-lifecycle and
   reaction/loot handlers; `global.css` into `styles/` partials with `@layer base|shell|hud|
   screens|fx` (Vite inlines `@import`, no tooling change) — the class names are already a
   stable contract, so the split is mechanical.
4. **Payload** — `dist`: `index` 679 kB / **207 kB gz** + `phaser` 1208 kB / **332 kB gz** +
   `css` 68 kB / 13.5 kB. React is a 4.2 kB-gz vendor chunk; the floor is Phaser. Cheap wins:
   `modulepreload` for the two chunks, `content-visibility: auto` on the collapsed panels, and
   `React.lazy` for the five meta screens (statistics, achievements, codex, free mode,
   ascension) so the first payload is the shell plus gameplay.
5. **Music depth (§14/§34 remainder)** — `audio.ts` already has **three buses**
   (`masterGain → sfxBus/musicBus`, per-bus `setTargetAtTime` volume, `musicBus` ducked while
   muted; `setVolume` takes a per-bus 0-1 value, so "one master gain" is stale). What's still
   missing is intensity layering: `startAmbient()` runs one bed at `0.3`, so a boss phase
   change changes SFX and VFX but not the music. Two extra layers armed from
   `onBossPhase`/`onWaveCleared` with a 1.5 s crossfade is enough; keep the layer gain table
   in `AUDIO_CONFIG`.
6. **Frame pacing on real hardware is unmeasured.** Everything here ran in headless software
   GL (`--use-gl=swiftshader`), where 13 fps is the rasteriser, not the game. Adding a
   `?perf` mode that records frame-time p50/p95 into `report.json` costs ~30 lines and turns
   §34/§25 claims into data instead of vibes.

## 5. Already done — do not re-spend time here

* **Audio**: master + sfx + music buses, per-bus volume, mute duck, `visibilitychange` suspend,
  audio unlocked on the first real interaction (`game/systems/audio.ts:292-352`).
* **Touch hygiene**: `touch-action: none` on canvas/touch layer, `manipulation` on controls,
  double-tap zoom blocked, rubber-band scrolling off, `tap-highlight-color: transparent`,
  `user-select: none` with `.save-name` opting back in, `viewport-fit=cover` + `env()` safe
  padding consumed by `.hud` and `.overlay` (`global.css:143-160`, `:112-115`).
* **Layout**: no page renders as a half-height panel with a scrollbar — `.scroll-y` scrolls
  itself (`flex: 1 1 auto; min-height: 0`), `pageScroll: 0` on every meta page at desktop and
  phone width, and the skill tree fills the frame at ≥1180 px (`docs/REDESIGN_MAP.md` §6.1).
* **Framing**: no letterbox — `Scale.NONE` + manual buffer, arena bleeds to all four edges
  (pixel samples at the frame border are game pixels, not `#05070d`).
* **Interaction feedback**: `focus-visible` on 12 rule groups, press/hover/deny/success/locked
  through `utils/motion.ts` only, `prefers-reduced-motion` and a Reduced-motion setting,
  `aria-live` on the HUD and toast stack, `aria-label`s on the element rail (`Switch to Fire`).
* **Save**: versioned `sixfold.save.v4` with per-field migration, corrupt data quarantined to a
  `.broken` key instead of destroying the run, autosave only on meaningful events.
* **Ascension identity**: `:root[data-mode='ascension']` swaps the accent and the HUD prints
  `LOCAL n` next to the run wave (`HudOverlay.tsx:116-123`).

## 6. Suggested order

2.1 (arena/actor scale) → 2.2 (touch floors) → 2.3 (haptics) → 3.2 (type tokens) →
3.1 (small-text floor) → 3.3 (tree panning) → 3.4 (HUD scale setting) → 3.5/3.6 (install +
font) → 3.7 (unlock moment) → §4 items as they come up. Each step ends with `node tools/mobile-audit.mjs` back to zero FAIL and a shrinking
WARN list, plus `tools/audit.mjs` 9/9 and `tools/e2e.mjs` 18/18 so gameplay never regresses.
