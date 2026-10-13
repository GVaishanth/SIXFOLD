# SIXFOLD: ELEMENTAL ASCENSION

A top-down 2D pixel-action roguelite that runs entirely in the browser. Twenty-five
elemental disciplines, a 200-wave story across ten floors, twenty hand-tuned bosses,
and an endless Ascension mode that begins where the story ends.

Everything is client-side: no backend, no accounts, no database, no telemetry.
Art and audio are generated procedurally at runtime, so the repository ships zero
binary assets and the built game is a handful of static files.

---

## Table of contents

- [Features](#features)
- [Controls](#controls)
- [The element system](#the-element-system)
- [Story mode](#story-mode)
- [Ascension mode](#ascension-mode)
- [Free mode](#free-mode)
- [Progression and balance](#progression-and-balance)
- [Save system](#save-system)
- [Accessibility and presentation](#accessibility-and-presentation)
- [Technology](#technology)
- [Project structure](#project-structure)
- [Local development](#local-development)
- [Building](#building)
- [Deploying to GitHub Pages](#deploying-to-github-pages)
- [Architecture](#architecture)
- [Developer tools](#developer-tools)
- [Performance](#performance)
- [Future expansion](#future-expansion)
- [Licence](#licence)

---

## Features

**Combat**

- Acceleration/deceleration movement with normalised diagonals, hold-to-attack,
  cursor aiming on desktop and nearest-target auto-aim on touch (with a strength
  slider rather than a hard on/off switch).
- Dash with invulnerability frames, afterimage trail and a real cooldown.
- Energy pool with regeneration, spent by skills and ultimates.
- Hit feedback stack: pooled impact sparks, hit flash, floating damage numbers,
  knockback impulses, procedural sound effects, camera shake and impact zoom.
- A generic status system — burn, freeze, shock, slow, root, poison, blind, stun,
  knockback, armour break — resolved from a single data registry. Enemies never
  hard-code their own elemental rules.
- Eight enemy archetypes (chaser, caster, tank, assassin, charger, splitter,
  summoner, shielded) sharing one entity class and one data-driven behaviour block.
- Ten enemy affixes (swift, volatile, giant, regenerating, shielded, elite and
  more) used for elite, mutation and Ascension variety.

**Structure**

- Exactly three save slots with name, starter element, highest wave, floor,
  unlocked element count, highest Ascension wave, playtime and last-played stamp.
- Autosave on meaningful events only (wave cleared, boss defeated, checkpoint,
  death, manual save) — never per frame.
- Pause menu with Resume, Elements, Skill Tree, Settings and Save & Exit.
- Twelve achievements tracked against the save file, plus full career statistics.
- Free Mode that replays any unlocked boss or floor without touching story state.

**Presentation**

- 320×180 internal resolution, nearest-neighbour scaling, pixel-snapped particles.
- Per-element player sprites and projectile visuals; readable enemy silhouettes
  tinted per definition; distinct palette, tiles, ambient particles, hazards and
  spawn portals per floor.
- Scanline/vignette/noise layer, restrained neon, bloom reserved for large
  elemental casts.
- Procedural Web Audio: ~20 sound events plus a per-floor ambient music pad that
  starts after the first user gesture, honouring browser autoplay rules.
- Mobile-first touch layer: landscape layout, safe-area insets, virtual stick
  bottom-left, attack/skill/ultimate/dash bottom-right, tap-tap loadout editing.

---

## Controls

### Desktop

| Action | Binding |
| --- | --- |
| Move | `W` `A` `S` `D` or arrow keys |
| Attack | Hold left mouse button (fires toward the cursor) |
| Skill | `E` |
| Ultimate | `Q` |
| Dash | `Space` |
| Switch element slot | `1` – `6` |
| Cycle element | Mouse wheel or `Tab` |
| Pause / resume | `Esc` |
| Debug panel | `F2` (development builds only) |

### Touch

| Action | Control |
| --- | --- |
| Move | Virtual stick, bottom-left (press anywhere in its zone) |
| Attack | Attack button, bottom-right (auto-aims the nearest target) |
| Skill / Ultimate / Dash | Buttons beside the attack button |
| Switch element | Slot strip along the top of the HUD, or the pause menu |
| Pause | Pause button in the HUD |

Touch controls can be forced on or off in **Settings → Touch controls**, which is
useful for tablets with a keyboard and for desktop players who want pointer-move.

---

## The element system

Twenty-five elements, each a full combat identity built from data:
`attack` (basic projectile), `skill` (cooldown + energy), `ultimate` (big, expensive,
often with screen-wide effects), plus passive modifiers, status applications,
knockback, area and VFX style.

```
Fire · Water · Air · Earth · Ice · Lightning · Steam · Mist · Smoke · Magma
Crystal · Storm · Sand · Frost · Ash · Vine · Metal · Sound · Volcano
Blizzard · Tempest · Oasis · Toxic · Solar · Plasma
```

- **Starters.** A new save picks exactly one of **Fire**, **Water** or **Air**.
- **Unlocks.** The rest arrive through wave milestones (Earth at wave 15, Mist at
  25, Smoke at 35, … Tempest at 195), boss-gated discoveries, or by spending
  6 element shards to focus-unlock a milestone element early.
- **Loadout.** Six slots, no duplicates, never empty. Loadout changes are saved
  and applied to the live run through the event bus.
- **Mastery.** Fighting with an element earns XP (per hit, per kill, per skill and
  ultimate use, bonus for boss damage). Levels 0–10 raise its damage, status
  duration, cooldown recovery and ultimate efficiency independently per element.
- **Resonances.** Twelve data-driven combinations activate when their pieces are
  equipped together and grant extra passive effects, for example
  Fire + Smoke → **Cinder**, Water + Ice → **Frozen Core**, Air + Lightning →
  **Storm**, Earth + Metal → **Crystal Fortress**, Fire + Water + Steam →
  **Pressure**.
- **Codex.** Every element, resonance, enemy, boss, floor and status is documented
  in-game; locked entries are shown as silhouettes with their unlock hint.

The skill tree is a radial view of all twenty-five nodes with tier rings, unlock
state, mastery level and a detail panel. Opening it (or the pause menu, codex,
loadout, statistics or achievements screens) fully freezes the simulation —
enemies, projectiles, statuses, timers and tweens.

---

## Story mode

200 waves, ten floors, twenty waves each. Every floor supplies its own palette,
tiles, ambient particles, hazard, enemy roster, modifiers, reward table, music
theme, mini-boss and major boss.

| # | Floor | Mini-boss (wave 10) | Major boss (wave 20) |
| --- | --- | --- | --- |
| 1 | Ember Ruins | Alpha Ash Hound | Ember Tyrant |
| 2 | Drowned Vault | Drowned Warden | Abyssal Leviathan |
| 3 | Sky Spires | Wind Serpent | Skywarden |
| 4 | Verdant Labyrinth | Thornmaw | Verdant Behemoth |
| 5 | Crystal Foundry | Shard Golem | Crystal Sovereign |
| 6 | Storm Citadel | Arc Herald | Storm Tyrant |
| 7 | Ashen Wastes | Ash Revenant | Ashen Colossus |
| 8 | Frozen Crown | Rime Herald | Frost Regent |
| 9 | Toxic Mire | Spore Matron | Toxic Hydra |
| 10 | Elemental Core | Radiant Avatar | The Elemental Core |

Wave flow: a 3-2-1 countdown, then enemies arrive through visible portals placed
away from the player, never on top of them. The HUD shows the wave banner, the
floor, "enemies remaining", a boss health bar with its current phase name, and the
dash/skill/ultimate cooldowns.

Bosses run through one reusable controller: phases are HP thresholds, each phase
holds a weighted pool of telegraphed patterns (charges, cone sprays, ring bursts,
summoning, spiral volleys, arena rules), and phase changes announce themselves with
a banner. Defeating a story boss for the first time records a **checkpoint** — the
next story run resumes *after* the boss, never before it, and story bosses are
never replayed as walls. Dying offers **RESPAWN** (at the last checkpoint, or wave 1)
or **RETURN TO HUB** with a run summary.

Clearing wave 20 of a floor plays the **FLOOR CLEARED** card, which continues into
the next floor's palette, hazard and music.

---

## Ascension mode

Finishing wave 200 unlocks Ascension, an endless continuation of the same curve:

- `cycle = floor((wave - 1) / 200)` and `localWave = ((wave - 1) % 200) + 1`, so
  wave 201 is cycle 1, local wave 1, and the floor pattern repeats with new stakes.
- Each cycle multiplies enemy HP, damage and speed, and additionally mutates the
  roster: floor affixes are applied to whole waves, giants and elite-blessed
  variants appear, more elites roll in, hazards intensify and healing is reduced.
- The hub always displays the current cycle, the local wave, which floor pattern is
  active and your best Ascension wave.
- Both curves are saturating (see [Progression and balance](#progression-and-balance)),
  so wave 603 or 2001 is still a readable, winnable fight rather than a wall of
  numbers.

---

## Free mode

Unlocked when the story is completed. Pick a floor, a starting wave, an optional
boss to replay and a difficulty (normal / veteran / nightmare). Free mode is an
isolated sandbox: it can award its own rewards, but it never modifies story
completion, checkpoints or first-time boss records.

---

## Progression and balance

Player growth and enemy scaling are two deliberately matched curves:

- **Permanent hall upgrades.** The first time each story boss falls, the save gains
  a permanent stat reward that grows with the floor (`+HP`, `+ATK`, `+DEF`, `+CRIT`).
  Across twenty bosses this is roughly 3× health and 3–4× damage by wave 200, which
  is exactly the headroom the late-wave curve assumes.
- **Saturating enemy scaling.** Enemy HP uses a small exponential term that stops
  compounding around wave 100 plus a linear term that keeps climbing, and bosses
  take the square root of that multiplier because their base pools are already
  large. A full 200-wave story ends near 12× trash HP rather than the thousands of
  times an unclamped exponential produces.
- **Capped incoming damage.** Any single enemy hit is capped as a fraction of the
  player's max HP (14% for trash, 22% for bosses), so a bad moment can never delete
  a full health bar regardless of wave.
- **Difficulty beyond numbers.** Later waves and Ascension cycles get harder
  primarily through elite chance, affixes, hazard intensity, enemy counts and
  tighter arenas — not health inflation alone.

These constants live in `src/config/gameConfig.ts` (`DIFFICULTY`, `PROGRESSION`,
`MASTERY`, `WAVE_CONFIG`), so balance passes never require touching entity code.

---

## Save system

Three slots, all local. Nothing leaves the machine.

- Keys: `sixfold.save.v4` (progress, all slots), `sixfold.settings.v4`
  (volumes, shake, damage numbers, pixel effects, reduced motion, high contrast,
  auto-aim, touch controls, graphics quality, FPS counter).
- Loading is defensive: the payload is validated field by field, repaired where
  possible, and a corrupt blob is copied to `sixfold.save.v4.broken` before
  defaults are written — the game never crashes because of bad localStorage.
- Legacy keys (`sixfold.save.v1`…`v3`) are migrated forward automatically on first
  load.
- Writes are debounced autosaves triggered by meaningful events, plus immediate
  flushes for checkpoints, boss defeats, deaths and manual "Save & Exit".
- Occupied slots always require explicit confirmation before they are overwritten.

---

## Accessibility and presentation

- High contrast palette toggle and a visible focus ring for keyboard navigation
  (`:focus-visible`), reachable in every menu; no trapped overlays or duplicate
  modals.
- Reduced motion (fewer shakes, no zoom punches, calmer ambience), screen shake
  toggle, damage-number toggle, pixel-effect toggle.
- Auto-aim strength slider (off below 0.4), touch-control mode, per-channel volume,
  fullscreen toggle, FPS counter and a control-reset action.
- Responsive from 360×800 phones up to 1920×1080 desktops, with safe-area insets,
  no page scrolling, and large touch targets in landscape.

---

## Technology

| Layer | Choice |
| --- | --- |
| Interface | React 19 + TypeScript 5.9 |
| Game engine | Phaser 3.90 (Arcade physics) |
| State | Zustand 5 (small stores, narrow selectors) |
| Build | Vite 7 |
| Audio | Web Audio API, generated tones and noise |
| Art | Canvas-drawn pixel textures generated at boot |
| Persistence | `localStorage` only |
| Deployment | GitHub Pages via GitHub Actions |

No paid or third-party assets are used. There is no backend, authentication,
database or analytics.

---

## Project structure

```
sixfold/
├─ .github/workflows/deploy.yml   Pages build + deploy workflow
├─ public/                        favicon.svg + icons/ (from `npm run icons`), manifest, .nojekyll
├─ src/
│  ├─ app/            save service, run-flow orchestration
│  ├─ assets/         procedural texture manifest (no binary files)
│  ├─ components/     screens/, hud/, ui/, game/, debug/
│  ├─ config/         typed central config (all gameplay constants)
│  ├─ data/           elements/, enemies/, bosses/, floors/, loot/, waves/, achievements
│  ├─ game/
│  │  ├─ combat/      damage model and combat context
│  │  ├─ entities/    Player, Enemy, BossController, Projectile, Pickup, Field
│  │  ├─ input/       keyboard, mouse, wheel and touch input manager
│  │  ├─ scenes/      BootScene, MainMenuScene, GameplayScene, PauseScene
│  │  ├─ systems/     wave director/generator, statuses, stats, pools, fx, audio, bus
│  │  ├─ world/       arena construction and bounds
│  │  └─ textureFactory.ts
│  ├─ hooks/          useSaveBridge, useTouchDevice, useDebugHotkey, accessibility
│  ├─ store/          Zustand stores: save, run, settings, ui + progression actions
│  ├─ styles/         single design-system stylesheet
│  ├─ types/          shared domain types
│  └─ utils/          math, colour, storage, id, save schema/validation
├─ docs/            design notes, the measured fault log
├─ scripts/           gen-icons.mjs — the brand mark, drawn from one pixel grid
├─ assets/            the one source PNG a derive script reads (brain art)
└─ tools/             optional Playwright audits (not shipped, not required to build)
```

---

## Local development

Requirements: **Node 20 or newer** (see `engines` in `package.json`).

```bash
npm install
npm run dev        # http://localhost:5173
```

Other scripts:

```bash
npm run typecheck  # tsc --noEmit over the app project
npm run build      # typecheck + production build into dist/
npm run preview    # serve the production build on http://localhost:4173
npm run verify     # typecheck + the four fast gates + a production build
npm run icons      # regenerate public/favicon.svg and the PWA PNGs from one grid
```

There is no `clean` script: the build output is disposable, `rm -rf dist node_modules/.vite`.

The dev server binds to `0.0.0.0`, so a phone on the same network can open the
LAN address to test the touch layout.

---

## Building

```bash
npm run build
```

Output goes to `dist/` as static files (HTML, CSS, JS chunks, favicon). The build
splits Phaser and React into separate chunks so the interface starts painting
before the engine finishes parsing.

Set the base path when the app will not be served from a domain root:

```bash
VITE_BASE_PATH=/my-repo/ npm run build
```

---

## Deploying to GitHub Pages

The repository ships `.github/workflows/deploy.yml`, which uses the modern Pages
Actions flow (`configure-pages` → `upload-pages-artifact` → `deploy-pages`) with
the OIDC token GitHub provides. There is no `gh-pages` branch, no committed build
output and **no environment secrets to configure**.

1. Push the repository to GitHub with `main` as the default branch.
2. In **Settings → Pages**, set **Source** to *GitHub Actions*.
3. Push to `main` (or run the workflow manually). The workflow installs with
   `npm ci`, typechecks and builds, then publishes `dist/`.

The workflow derives `VITE_BASE_PATH` from the repository name, so a project page
(`https://<user>.github.io/<repo>/`) works out of the box, and renaming the repo to
`<user>.github.io` switches it to the domain root automatically. Any other host
(Netlify, S3, a static server) only needs the same `dist/` directory.

---

## Architecture

Four layers, one direction of dependency:

1. **Data** (`src/data`) — plain typed objects: elements, enemies, bosses, floors,
   loot tables, wave patterns, achievements. Adding content means adding data.
2. **Simulation** (`src/game`) — Phaser scenes and systems. The scene owns the run:
   it drives the wave director, resolves damage, spawns pools and writes the save
   for wave clears, boss defeats, checkpoints and deaths.
3. **State** (`src/store`) — Zustand stores. `saveStore` holds the validated save
   file, `runStore` the live run snapshot the HUD reads, `settingsStore` the
   preferences, `uiStore` the screen stack and overlays.
4. **Interface** (`src/components`, `src/App.tsx`) — React screens and HUD. It never
   touches Phaser directly; it sends commands and receives snapshots over the typed
   event bus (`src/game/systems/eventBus.ts`).

Consequences worth knowing:

- The React layer owns navigation and menus; Phaser owns the arena. They are
  connected only by the event bus, so either can be tested in isolation.
- The pause rule is enforced in the scene: when `uiStore` reports a pause or a
  full-screen menu, physics, tweens, scene time and music are all suspended.
- Saves have exactly one writer per event class (scene for run progress, React
  bridge for loot and autosave), which prevents double-counting.
- All gameplay numbers live in `src/config/gameConfig.ts`; components read from
  data structures, never from magic constants.

---

## Developer tools

- **Debug panel** — `F2`, available only when `DEBUG_CONFIG.enabled` is true, which
  is `import.meta.env.DEV && VITE_SIXFOLD_DEBUG !== 'false'`. The panel is lazily
  imported inside a dev-only branch, so it cannot appear in a production bundle.
- **Console handles (dev only)** — `window.__sixfoldGame` (the Phaser game) and
  `window.__sixfoldBus` (the event bus) are attached in development builds only.
  From the console you can, for example, inspect the live run:

  ```js
  const scene = __sixfoldGame.scene.getScene('GameplayScene');
  scene.director.currentSpec;        // current wave definition + scaling
  scene.player.stats;                // fully resolved player stats
  __sixfoldBus.emit('command:grantCheat', { hp: 999, energy: 999 });
  ```

- **Brand mark** — `scripts/gen-icons.mjs` owns the logo as an 8×8 pixel grid and writes
  everything derived from it: `public/favicon.svg`, `icon-192.png`, `icon-512.png`,
  `icon-maskable-512.png` and `apple-touch-icon.png`, PNG-encoded with nothing but Node's
  zlib. The grid, not a design tool, is the source of truth, so the tab icon and the
  installed-app icon cannot drift apart. It is authored at 8 cells because a cell is 2px
  in a 16px tab — the smallest unit a browser still draws as a block — and 22px at 512,
  which keeps it tile art rather than a logo that was scaled down. `npm run audit:pages`
  checks the generated files are present, referenced by the manifest, and served.
- **Audit scripts (`tools/`, optional)** — `tools/audit.mjs` checks wave scaling at
  1 / 201 / 402 / 603 / 1000 / 2001 / 5000, corrupt-save recovery, legacy `v1`–`v3`
  migration and interface/simulation state sync; `tools/e2e.mjs` plays the real flow
  in a browser (menu → new game → slot → warden → hub → story wave → combat → pause →
  skill tree freeze → resume → save & exit → reload → continue).

  They use Playwright, which is a dev dependency (`npm ci` installs it; the
  browser binary is not — `npx playwright install chromium`, add `--with-deps`
  on a bare Linux box, which needs sudo). They import the game's own modules, so
  most of them run against the dev server:

  ```bash
  npm run dev &                 # serve the game on :5173
  node tools/audit.mjs          # scaling, save safety, state sync
  node tools/e2e.mjs            # play-through of the core flow
  SIXFOLD_URL=http://localhost:4173/ node tools/e2e.mjs   # against a build + preview
  ```

  The rest are named by script, and each is a gate on a subsystem rather than a
  smoke test: `audit:dungeon` (map rules), `audit:cortex` (the brain-shaped
  derivation, including the wall-thickness margin in tiles), `audit:dungeonrun`
  (a full run in the browser: partner, courier, stress against a live wall),
  `audit:counter`, `audit:achievements`, `audit:brain`, `audit:config` (every
  config key reachable), `audit:camera`, `audit:progression`, `audit:pausemenu`,
  `audit:fit` and `audit:mobile` (layout, contrast, touch targets), and
  `audit:pages`, which builds with the Pages base path, serves `dist` under that
  prefix and boots it — run that one before you push, because it is the only
  check that looks at the *repository* too: a file `public/` needs but
  `.gitignore` hides builds fine locally and 404s once deployed.

  Both exit non-zero on failure, so they can be wired into CI later. If Playwright
  only exists inside the `npx` cache, point `SIXFOLD_PLAYWRIGHT` at that install
  directory. End-to-end runs write `e2e-final.png` into the working directory.

- **Asset manifest** — `src/assets/textures.ts` generates every texture in the game
  at boot and reports what it created (also stored on the game registry as
  `assetManifest`), which makes it obvious when a new element or boss is missing art.

---

## Performance

- Object pooling for projectiles, enemy projectiles, particles and pickups, with
  hard caps per pool.
- Textures are generated once per session and reused; enemies share silhouettes and
  are tinted per definition instead of holding unique bitmaps.
- Particle counts scale with the graphics-quality setting
  (`PERFORMANCE.qualityMult`), and emitters have a per-emitter ceiling.
- HUD text updates at a fixed lower rate than the render loop, and components
  subscribe through narrow Zustand selectors so a wave change does not re-render
  the whole interface.
- Damage numbers are capped, camera shake is pooled and status ticks are batched.
- Measured under load in a software-rendered browser (SwiftShader, no GPU): with the
  arena flooded past the alive-enemy ceiling and fire held down, the loop averaged
  ~45 FPS with 64 active enemies, and a 20-second combat run left the physics body
  count and JS heap unchanged (75 bodies, 45 MB), i.e. pools are genuinely reused.

---

## Future expansion

The data layer is built to absorb content without engine changes:

- **Elements** — one `element({...})` entry adds an attack, skill, ultimate,
  mastery curve, codex page, skill-tree node and player art.
- **Enemies** — a new archetype entry (or a new behaviour block on an existing
  archetype) plus a sprite key; affixes can be mixed onto any of them.
- **Bosses** — a `BossDef` is phases plus weighted patterns, so new fights are
  authored entirely in data.
- **Floors** — palette, hazard, ambient, roster, modifiers, music and reward table
  are all fields on a `FloorDef`; adding an eleventh floor extends the story.
- **Modes** — the wave director takes a mode and a starting wave, which is how
  Ascension and Free Mode reuse the same pipeline; a daily-run or drafted-rules
  mode would be another entry point rather than a new system.

---

## Licence

MIT. The code, the generated textures and the synthesized audio are all original
to this project; no third-party game assets are included.
