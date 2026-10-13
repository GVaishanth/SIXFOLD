/**
 * SIXFOLD — central typed game configuration.
 *
 * Every tunable gameplay value lives here. Scenes, entities and systems read
 * from this object; components never hard-code gameplay numbers. Values are
 * expressed in *world pixels* and *seconds* unless documented otherwise.
 */

export const RESOLUTION = {
  /** Internal pixel-art render resolution. */
  width: 320,
  height: 180,
  /** Never upscale beyond this factor even on huge displays. */
  maxZoom: 8,
  /**
   * Frames with both dimensions at or below this are treated as handheld: they
   * get the narrow framing in `viewport.ts` (a smaller width demand, a zoom
   * floor of 2 and the shortened arena), in portrait and in landscape alike.
   */
  handheldLimit: 480,
  /** Least world width a handheld frame may show, in place of the authored 320. */
  narrowViewWidth: 190,
} as const;

/* sweep: vocabulary - the JS mirror of the CSS custom properties; declared complete so the
   two sides can be diffed by eye. */
export const COLORS = {
  bg: '#070A12',
  panel: '#121A2A',
  text: '#E8EDF7',
  muted: '#7E899E',
  border: '#2A3850',
  gold: '#F2C96B',
  danger: '#FF5C6C',
  success: '#6BE39A',
  energy: '#57C7FF',
} as const;

/* sweep: vocabulary - a palette is declared complete; JS reads what it needs. */
export const COLOR_INTS = {
  bg: 0x070a12,
  panel: 0x121a2a,
  text: 0xe8edf7,
  muted: 0x7e899e,
  border: 0x2a3850,
  gold: 0xf2c96b,
  danger: 0xff5c6c,
  success: 0x6be39a,
  energy: 0x57c7ff,
  white: 0xffffff,
  black: 0x000000,
  hp: 0xff5c6c,
} as const;

export const ARENA = {
  width: 880,
  height: 520,
  /** Thickness of the arena wall band. */
  wall: 10,
  /** Player cannot move closer than this to the wall centre line. */
  padding: 8,
  /**
   * A phone held upright cannot show 880 world pixels and still keep the
   * actors readable, so on a narrow frame the field is shortened until the view
   * covers this much of it again — the same proportion of arena a desktop sees,
   * at twice the pixel size. The height is never touched: the authored
   * vertical composition (hazards, props, light pool) stays valid.
   */
  narrowCoverage: 0.44,
  /** Never squeeze the field below this width, however narrow the window is. */
  minWidth: 400,
  /**
   * Same argument vertically: a landscape phone has 195 world pixels of height
   * in hand, so a 520-tall field means two thirds of the fight is off-screen and
   * the rest lands under the thumb pads. The height follows the view, floored so
   * the field never becomes a strip.
   */
  heightFromView: 1.6,
  minHeight: 300,
  /** Share of the frame the thumb pads claim; the field must not extend under them. */
  padFraction: 0.26,
  /**
   * World pixels of apron the camera is allowed to show past a wall, and how far
   * up the frame the warden is held. Sized against the pads: at zoom 2 they eat
   * roughly a fifth of the screen height, so the camera has to be able to leave
   * that much darkness at the bottom.
   */
  handheldOverscan: 46,
  handheldBias: 0.7,
} as const;

export const PLAYER_CONFIG = {
  radius: 5,
  baseHp: 100,
  baseEnergy: 100,
  baseAttack: 9,
  baseDefense: 4,
  /** World pixels per second. */
  baseSpeed: 82,
  /** Seconds to reach full speed — small values = responsive but not slippery. */
  acceleration: 0.075,
  /** Seconds to come to a complete stop when input is released. */
  deceleration: 0.055,
  critChance: 0.06,
  critDamage: 1.6,
  /** Percentage as a fraction (0.2 = 20%). */
  cooldownReduction: 0,
  /** Frames of invulnerability after being hit. */
  invulnMs: 550,
  /** Regeneration after not being hit for this many seconds. */
  regenDelay: 6,
  regenPerSecond: 1.2,
  energyRegenPerSecond: 7,
  /**
   * Energy returned by a hit that lands. Kills deliberately pay nothing: a kill
   * is a wave-clear event, not a resource tick, and paying both made holding down
   * the attack button strictly better than aiming.
   */
  energyOnHit: 1.2,
  /** Pickup magnetism radius. Relics can raise it; PICKUP_CONFIG.magnetRadius is the floor. */
  pickupRadius: 16,
} as const;

export const DASH_CONFIG = {
  speed: 340,
  duration: 0.16,
  cooldown: 1.35,
  invulnMs: 260,
  /** Trail sample interval in ms. */
  trailIntervalMs: 18,
  energyCost: 0,
} as const;

export const COMBAT_CONFIG = {
  hitFlashMs: 90,
  /** Cap on simultaneous damage numbers to keep the frame budget sane. */
  maxDamageNumbers: 28,
  /** Damage that triggers the slow-motion punch effect. */
  criticalPunchThreshold: 55,
  /** Ceiling on a status's duration multiplier, so amps cannot compound forever. */
  statusDurationCap: 2.5,
  /**
   * Graded impact tiers (§ feel pass). Everything that makes a hit land lives
   * here: how long the frame holds, how hard the camera moves, how many sparks,
   * whether a ring is drawn. A normal attack must never shake the screen; a
   * warden phase change must never be silent.
   */
  impacts: {
    normal: { holdMs: 0, shake: 'none', punch: 0, sparks: 1, ring: 0, squash: 0.05, damageScale: 1, audioRate: 1 },
    skill: { holdMs: 26, shake: 'light', punch: 0.006, sparks: 1.5, ring: 10, squash: 0.1, damageScale: 1.15, audioRate: 1.12 },
    crit: { holdMs: 48, shake: 'light', punch: 0.014, sparks: 2, ring: 14, squash: 0.16, damageScale: 1.45, audioRate: 1.3 },
    ultimate: { holdMs: 78, shake: 'medium', punch: 0.024, sparks: 2.8, ring: 22, squash: 0.2, damageScale: 1.7, audioRate: 0.86 },
    bossPhase: { holdMs: 120, shake: 'heavy', punch: 0.035, sparks: 3.4, ring: 34, squash: 0.24, damageScale: 1.9, audioRate: 0.7 },
  },
  /** Ratio of the target's max HP that promotes a hit to the next tier. */
  tierRatios: { skill: 0.045, crit: 0.075, ultimate: 0.12 },
} as const;

export const ENERGY_CONFIG = {
  /**
   * Multiplier on an element's authored `attack.energyCost`. Every element authors
   * 0, so basic attacks are free today; the knob exists so a future element can
   * charge for a shot without the engine growing a special case.
   */
  basicAttackCostMultiplier: 1,
} as const;

export const CAMERA_CONFIG = {
  followLerp: 0.14,
  shake: {
    light: 1.2,
    medium: 2.6,
    heavy: 4.6,
    duration: 130,
  },
  /** Impact zoom punch. */
  zoomPunch: 0.045,
  zoomPunchMs: 160,
} as const;

export const WAVE_CONFIG = {
  /** Seconds of "3 / 2 / 1" countdown before a wave goes live. */
  countdown: 3,
  /** Seconds of breathing room after the last enemy dies. */
  clearDelay: 2.1,
  /** Delay before the boss spawns once the boss wave starts. */
  bossIntroDelay: 2.2,
  /** Base essence per wave completion. */
  waveClearEssence: 6,
  /** Extra essence per wave index. */
  waveClearEssenceGrowth: 0.55,
  /** Maximum enemies alive at once regardless of wave size. */
  maxAliveEnemies: 42,
  /** Enemy count is clamped to this range. */
  minEnemies: 4,
  maxEnemiesPerWave: 34,
} as const;

export const SPAWN_CONFIG = {
  /** Minimum distance from the player when picking a spawn point. */
  minDistanceFromPlayer: 74,
  /** Distance from the arena wall for portal placement. */
  edgeInset: 26,
  /** How long a portal animates before releasing an enemy. */
  portalLeadTime: 0.55,
  /** Max simultaneous portals. */
  maxPortals: 9,
} as const;

/**
 * Dungeon mode — one generated cell per `worldFrame`, walked left to right.
 *
 * Every key here is read by the generator, the scene or the partner, because `npm run audit:config`
 * fails on a config key nothing consumes; the mode is small enough that the block should stay the
 * whole vocabulary rather than a place to park intentions.
 */
export const DUNGEON = {
  /** Cells in the strip. Six is ~5,280 world pixels — long enough to route, short enough to finish. */
  chunks: 6,
  /** Least distance from the wall band to a stone's centre, on top of `ARENA.wall`. */
  siteInset: 24,
  /**
   * How much of the map a frame has to show, measured in the map's own unit.
   *
   * The frame is not the browser window: `viewport.ts` holds every scene to 320 world pixels across at a
   * whole-number zoom, the same fit a wave run gets, so the dungeon's *tile* is what decides how much of it
   * is visible. Five tiles at 64px is the value that keeps the labyrinth legible in that shared frame; at
   * 160px the same frame showed 2.00 × 1.25 tiles and a run looked empty. Widening the buffer instead (a
   * per-scene frame demand) was tried and rejected: it cost 47 → 16 fps and shrank the warden to 1 CSS pixel
   * per world pixel, which made the dungeon look like a different game to the one it ships inside.
   */
  minTilesInView: 5,
  /** Two sites are never closer than this, in any direction, within or across a cell seam. */
  minSiteGap: 104,
  /** A single grove cannot wake more than this, however empty the cell is. */
  maxAwakePerGrove: 6,
  /** Σ of every grove's count in one cell — the cell's share of `WAVE_CONFIG.maxAliveEnemies`. */
  maxAwakePerChunk: 14,
  /** How many times one spring will pick the party up before it is spent. */
  springCharges: 2,
  /**
   * Roamers: hostiles the bands put in front of the party without a stone being woken.
   *
   * A bestiary that only exists after you touch something is honest to the ledger and lonely to play: with
   * the shared 320px frame and this map's density a stone is in view about a third of the time, so most of a
   * run was walking. So the mode places them ahead on the route instead — out of the corridor, not out of the
   * air — and the interval shortens with depth, which is the same "harder down there" rule the generator's site
   * ramp obeys. `roamCap` is a fairness limit as much as a frame-time one: a pack already on you is never
   * reinforced from off-screen, and a pursuer the camera has lost is retired rather than trailed.
   */
  roamCap: 3,
  roamIntervalMs: 3200,
  roamMinIntervalMs: 1500,
  /** Never while a fight is already on: the trickle fills quiet corridors, it does not reinforce a battle. */
  roamFightCeiling: 4,
  /** How far ahead of the warden a roamer has to be placed, in tiles — off the frame, on the route. */
  roamAheadTiles: 4,
  /** Beyond this many tiles from the warden and out of view, a roamer is done. */
  roamCullTiles: 10,
  /** Stagger between a grove's releases, so waking six is a scene and not a pop. */
  groveStepMs: 520,
  /**
   * How far a site's contents leave the stone: a cache's pile fans out this wide, and a grove releases
   * on the same ring. Nothing here is a physics push — drops are placed, so the ring is presentation.
   */
  dropRadius: 26,
  /** A field's mines sit further out than drops, so the band is stepped into rather than landed on. */
  fieldRingRadius: 64,
  /**
   * The labyrinth. Six cells become six circuits: a spine runs the strip's middle, one gap per cell
   * lets the walk cross it, and a tooth in the entering lane makes that crossing the only way on —
   * which is what separates a labyrinth (one path, no choices) from a maze (choices, dead ends).
   * `passage` is the width of both openings, so the corridor reads as built, not as a glitch.
   */
  passage: 76,
  /** The spine's band, as fractions of the cell height. Lanes take the rest, and the wall band. */
  spineBand: { fy0: 0.4, fy1: 0.6 },
  /** In the last cell the spine stops short, the lanes merge, and that merge is the centre. */
  spineEndFx: 0.84,
  /** How close you must be to the centre for the run to be over. */
  goalRadius: 46,
  /** The cell is 880×520, so a ring drawn as a circle reads as a squashed one: 0.7 of x, always. */
  ringSquash: 0.7,
  partner: {
    /** The partner is a second body, not a second tank: it trades, it does not outlast. */
    hpFraction: 0.42,
    speedFraction: 0.86,
    /** It only commits to something near the player, or clearly near itself. */
    engageRadius: 220,
    guardRadius: 140,
    /** The leash point sits this far behind the player along their own velocity. */
    leashDistance: 34,
    /**
     * How many tiles of detour the partner is allowed before it gives up and comes home. A tile count
     * rather than pixels, because the map's tile size is a knob: six leashes at 32px tiles was six tiles of
     * slack, and at 160px tiles the same 204px is one.
     */
    recallTiles: 6,
    /** Below this fraction of its max HP it breaks off, and for this long. */
    fleeFraction: 0.25,
    fleeMs: 1200,
    /** Its cast is a support hit, not the player's; the same rule `AUTO_CAST` uses for the rig. */
    damageFraction: 0.5,
    castIntervalMs: 900,
    /**
     * It fetches an orb within this distance of *the warden*, not of itself: a partner that is pinned
     * behind a wall or a beat late is still the courier, and loot next to the player is its errand.
     * Half a cell, so it sweeps the circuit it stands in and never goes wandering off the map.
     */
    orbRadius: 460,
    /** Hands, not a mule: two orbs and it wants to bring them in before it picks up a third. */
    carryCapacity: 2,
    /** It only unloads when it is actually at the warden, not when it is merely near. */
    deliverRadius: 26,
    /**
     * How far ahead of itself the partner looks when it walks the corridor, in pixels.
     *
     * There is no pathfinder in this mode and there does not need to be one: a labyrinth has a single
     * route, so following the corridor's polyline gets it anywhere it wants to go. The lookahead is what
     * makes it turn *into* a crossing instead of pressing along the spine — too short and it hugs the
     * wall, too long and it cuts corners it is not allowed to cut.
     */
    corridorLookahead: 52,
    /**
     * How far off the corridor a thing may be and still count as "on it" when the partner reads the map.
     * About half a lane: inside that, the point it is walking to is a real place on the route; outside
     * it, the target is in a pocket beside the corridor, and no amount of walking along it gets closer.
     */
    corridorTolerance: 96,
  },
  /**
   * The waystone's travel verb: intent, not contact.
   *
   * Stones sit on the corridor — that is what makes them findable — so every stride past one is an overlap, and
   * an overlap-only hop turned "walk to the centre" into "be teleported whenever the route touches its own
   * network". Measured before this rule existed: brushing a linked stone relocated the party 604-3,893px inside
   * 160ms, and two scripted walks stalled at 40% of the route because they kept re-touching the stone they had
   * just landed on. So a hop asks for a *pause*: arrive, stop, hold. Linking a stone stays instant, because the
   * first touch changes nothing about where the party is standing.
   */
  warp: {
    /** How long the warden must be stood still on a linked stone before it hops. */
    dwellMs: 380,
    /** Above this speed they are walking past, not standing on it. World px per second. */
    dwellSpeedPx: 26,
    /** Floor between hops, so a held stance cannot spin the network once per dwell. */
    hopFloorMs: 400,
    /** A warp lands the party *on* the destination stone; wait this long, clear of every stone, to re-arm. */
    rearmMs: 350,
  },
  camera: {
    /** The strip does not shrink the field for the thumb pads, so the view offset does. */
    padBandFraction: 0.5,
  },
  /**
   * Light on the floor, per authored cell — deliberately *drawn*, not simulated. A drifting emitter
   * keeps moving while the run is paused, and "an overlay open means the world is frozen" is not a rule
   * a decorative layer gets to break, so these are still motes and always will be.
   */
  ambient: {
    /** Motes per megapixel of field, so a small frame does not get a dense floor and a big one a bare one. */
    perMegaPixel: 260,
    max: 420,
  },
} as const;

export const DIFFICULTY = {
  /** Enemy HP multiplier at wave 1 — the friendly teaching floor. */
  baseHpMult: 0.85,
  /**
   * Enemy HP growth.
   *
   * Deliberately *saturating*: a small exponential term that stops compounding
   * after roughly wave 100, plus a linear term that keeps climbing. Enemy HP
   * therefore ends a full 200-wave story at ~12x the opening waves instead of
   * the thousands of x an unclamped exponential produces — difficulty after
   * that comes from counts, elites, affixes and hazards, never from pure HP
   * inflation (which would make the late game mathematically unwinnable,
   * because the player's own damage only grows through mastery, relics and
   * better elements — roughly 3-4x over the same span).
   */
  hpGrowth: 1.009,
  /** Hard ceiling on the exponential term above. */
  hpGrowthCap: 3,
  /** Additional linear term so late waves keep threatening. */
  hpLinear: 0.0025,
  /** Enemy damage growth (same saturating shape as HP). */
  damageGrowth: 1.006,
  damageGrowthCap: 1.4,
  damageLinear: 0.01,
  /** Enemy damage curve is raised to this power to keep late hits survivable. */
  damageSofteningExponent: 0.7,
  /**
   * Per-hit damage ceilings, as a fraction of `damageCapBaseHp`.
   *
   * The reference is the *base* warden, deliberately: measuring against the
   * player's live max HP meant every +HP reward raised the ceiling in lockstep, so
   * hits-to-die never changed and the game's biggest defensive stat bought nothing
   * (docs/STATS_GAMEPLAY_FAULTS.md §A4).
   */
  enemyDamageCapFraction: 0.14,
  bossDamageCapFraction: 0.22,
  /** HP the per-hit ceiling is measured against. Not the player's current pool. */
  damageCapBaseHp: 100,
  /**
   * Backstop, in share of the warden's *live* health: after the knee, no single
   * touch may exceed this. The scaling ceiling is what makes late waves threaten;
   * this is what keeps "a soft hit can never delete a health bar" true for a
   * lightly-initialised player who wanders into wave 200 with a base pool.
   */
  damageHardCapFraction: 0.45,
  /**
   * How much of a hit above the ceiling still lands. 0 is the old hard cap — from
   * wave ~100 onward it cut designed hits by 6-10x and left no way to lose a late
   * wave; 0.5 keeps a ceiling (no single touch deletes anyone) while letting the
   * curve keep climbing.
   */
  damageCapSoftKnee: 0.5,
  /** Enemy speed growth — deliberately gentle to keep the game fair. */
  speedGrowth: 1.006,
  speedCap: 1.85,
  /** Enemy count curve. */
  countBase: 5,
  countGrowth: 1.7,
  /** Elites never appear before this wave of the run. */
  eliteFromWave: 7,
  /**
   * The opening of a run teaches instead of testing.
   *
   * The first waves are softened by the factors below and ease back to normal
   * over `openTaperWaves` more waves, so the mid/late curve (and the audit
   * numbers that describe it) is untouched — only the floor you stand on in the
   * first two minutes changes. Keyed to the wave of the *run*, so a floor chosen
   * directly from Free Mode gets no grace.
   */
  openWaves: 6,
  openTaperWaves: 6,
  openHp: 0.72,
  openDamage: 0.62,
  openSpeed: 0.92,
  /** Enemy count is multiplied by this at wave 1 and by 1 once eased out. */
  openCount: 0.5,
  /** Hazards are a thing to learn about, not a tax to survive. */
  openHazard: 0.35,
  /** Per-hit damage ceiling during the opening, as a share of `damageCapBaseHp`. */
  openDamageCapFraction: 0.085,
  eliteChanceBase: 0.02,
  eliteChanceGrowth: 0.0045,
  eliteChanceCap: 0.3,
  /**
   * Ascension cycle scaling. Compounding stops after the tenth cycle and a
   * gentler linear term takes over, so even absurd wave numbers stay finite and
   * readable instead of overflowing into Infinity.
   */
  cycleHpMult: 1.5,
  cycleHealthCap: 10,
  cycleHealthLinear: 0.5,
  cycleDamageMult: 1.25,
  cycleSpeedMult: 1.07,
  cycleEliteBonus: 0.06,
  cycleAffixChance: 0.15,
  cycleAffixChanceCap: 0.85,
} as const;

export const MASTERY = {
  maxLevel: 10,
  /** XP needed for level N (index = level-1). */
  levelXp: [0, 120, 320, 640, 1100, 1750, 2650, 3850, 5400, 7400],
  /**
   * Damage bonus per mastery level, by tier. Rarer elements are worth more per level
   * because they cost more to reach; every element's `masteryMultiplier` is one of
   * these four numbers, so the tuning lives here rather than in a module-local table.
   */
  damagePerLevelByTier: {
    primordial: 0.036,
    branching: 0.04,
    advanced: 0.045,
    final: 0.05,
  } as const,
  /** Status duration bonus per mastery level. */
  statusDurationPerLevel: 0.02,
  /** Cooldown reduction per mastery level (fraction). */
  cooldownPerLevel: 0.008,
  /** Ultimate energy efficiency per mastery level (fraction cost reduction). */
  ultimateCostPerLevel: 0.01,
  /**
   * The XP channels that exist. Hits pay nothing on purpose — a 30-hit-per-second
   * element would cap a ladder in a fight otherwise — and ultimates ride
   * `xpPerSkillUse` because both are cooldown-gated casts.
   */
  xpPerKill: 1.5,
  xpPerEliteKill: 8,
  xpPerBossKill: 30,
  xpPerSkillUse: 6,
  /**
   * An ultimate costs a full cooldown window, so it pays more per cast than a skill —
   * this used to be a bare 16 in the scene, the last mastery rate the tuning file did
   * not own (docs/STATS_GAMEPLAY_FAULTS.md §B4).
   */
  xpPerUltimateUse: 16,
  /** The small drip for changing hands, so switching is never pure downside. */
  xpPerSwitch: 0.5,
} as const;

export const PROGRESSION = {
  /* Wave-milestone unlocks are declared on each element (`unlock: { kind: 'wave', value }`)
   * and read by `elementProgression` — there used to be a second copy of that list here,
   * which nothing read and which any retune of an element would have silently invalidated. */
  /**
   * Element shards required to focus-unlock a wave-milestone element early, priced by
   * the tier the element sits in. One flat price let a 6-shard purchase jump straight to
   * a `final` element (tempest, wave 195) as soon as its wave gate was read as a formality,
   * so the deep tiers now cost what they are worth and `elementProgression` refuses to
   * sell past the tier you have actually reached.
   */
  shardUnlockCostByTier: {
    primordial: 6,
    branching: 6,
    advanced: 12,
    final: 18,
  },
  /**
   * Relic cores are counted, not carried: `progression.relics` is a set, so the same
   * core cannot stack. The counter therefore buys a bounded slice of damage — one
   * step per `relicCoreStep` cores, `relicCoreDamageMult` each, up to `relicCoreCap`
   * cores in total.
   */
  relicCoreStep: 3,
  relicCoreDamageMult: 0.012,
  relicCoreCap: 60,
} as const;

export const PICKUP_CONFIG = {
  lifetime: 26,
  /** Player proximity that begins the magnet effect. */
  magnetRadius: 20,
  speed: 74,
  /**
   * How many timed buffs a warden can carry at once. A buff is a window, not a
   * stacking asset: past this the oldest falls off as the newest lands, so two
   * bosses' worth of drops cannot quietly rewrite the stat sheet for good.
   */
  maxBuffs: 6,
  /** ms a dropped pickup spends flying to the warden once the wave is cleared. */
  vacuumMs: 320,
  /** ms between two orbs in the same gather, so it reads as a pull, not a teleport. */
  vacuumStaggerMs: 34,
  /** The stagger shrinks so no gather, however huge, runs longer than this. */
  vacuumMaxSpanMs: 900,
} as const;

/**
 * Equipped-but-inactive elements fire themselves.
 *
 * The active slot is the player's element: their aim, their timing, their
 * energy. The other five are support — they pick their own target and cast on
 * their own clock at a fraction of the damage, with a base 50% accuracy that
 * mastery buys back up to `maxAccuracy`. The policy lives here so the tuning is
 * one block and `enabled: false` returns the game to switch-to-cast without
 * touching a system.
 */
export const AUTO_CAST = {
  enabled: true,
  /**
   * A support element keeps its own rhythm: the cycle is its attack cooldown
   * multiplied by this, clamped to the window below, and mastery shortens it as it
   * shortens the manual shot. A single fixed cycle for everybody (the old 1500 ms)
   * taxed fast elements hardest and rewarded slow ones, which quietly inverted what
   * each element is *for* (docs §B2).
   */
  intervalScale: 5,
  intervalMinMs: 420,
  intervalMaxMs: 2600,
  /** An auto cast hits for this fraction of a manual cast of the same attack. */
  damageFraction: 0.42,
  baseAccuracy: 0.5,
  accuracyPerLevel: 0.05,
  maxAccuracy: 0.95,
  /** A support element only fires at something it can actually reach. */
  range: 210,
  /** How long to wait before looking again when nothing is in reach. */
  retryMs: 260,
  /** Casts allowed per frame, so a loadout change never becomes a volley. */
  castsPerCycle: 2,
  /** Mastery shortens the cycle: interval / (1 + min(levelSpeedup * (level - 1), maxSpeedup)). */
  levelSpeedup: 0.04,
  maxSpeedup: 0.3,
} as const;

export const POOLS = {
  projectiles: 220,
  enemyProjectiles: 160,
  particles: 420,
  damageNumbers: 40,
  fields: 24,
  pickups: 96,
} as const;

export const AUDIO_CONFIG = {
  master: 0.7,
  sfx: 0.85,
  music: 0.35,
} as const;

export const UI_CONFIG = {
  /**
   * Accent colours the Phaser atmosphere wears per context. These mirror the CSS
   * tokens (they have to be numbers for Phaser), so a screen never picks an
   * arbitrary hex and the interface + world always agree on one colour.
   */
  atmosphere: {
    /** The neutral accent: what the backdrop returns to when a screen unmounts. */
    story: 0xf2c96b,
    /* …then exactly one entry per `AtmosphereMood`, so naming a mood is enough. */
    focus: 0x4edbff,
    danger: 0xff5c6c,
    triumph: 0x7ff0b5,
    calm: 0x8b96a9,
  },
} as const;

export const SAVE_CONFIG = {
  key: 'sixfold.save.v4',
  settingsKey: 'sixfold.settings.v4',
  legacyKeys: ['sixfold.save.v3', 'sixfold.save.v2', 'sixfold.save.v1'],
  /** localStorage safety: refuse to write payloads larger than this. */
  maxBytes: 900_000,
  autosaveDebounceMs: 400,
} as const;

export const DEBUG_CONFIG = {
  /** The panel is only ever mounted when this flag is true. */
  enabled:
    import.meta.env.DEV === true &&
    (import.meta.env.VITE_SIXFOLD_DEBUG as string | undefined) !== 'false',
  key: 'F2',
} as const;

export const PERFORMANCE = {
  /** HUD text refresh rate (Hz) independent of the render loop. */
  hudTextHz: 12,
  /** Ambient particle emission multiplier per quality tier. */
  qualityMult: { low: 0.35, medium: 0.7, high: 1 } as const,
} as const;

