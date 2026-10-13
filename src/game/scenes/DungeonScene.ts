import Phaser from 'phaser';
import { AUTO_CAST, CAMERA_CONFIG, DUNGEON, POOLS } from '@/config/gameConfig';
import { FLOOR_REGISTRY } from '@/data/floors';
import { pickDef } from '@/game/systems/waveGenerator';
import { getDropTable, rollTable } from '@/data/loot';
import { ELEMENT_REGISTRY } from '@/data/elements';
import { DungeonDirector } from '@/game/dungeon/director';
import { DungeonGround } from '@/game/dungeon/ground';
import { GuideStone } from '@/game/dungeon/GuideStone';
import {
  chartSpots,
  corridorStep,
  crossesRect,
  guideSpot,
  routeAtDistance,
  routeLengths,
  routeProjection,
  stripRoute,
} from '@/game/dungeon/map';
import { cortexCharts, cortexGuide, planCortex } from '@/game/dungeon/cortexPlan';
import { Ally, type AllyView } from '@/game/entities/Ally';
import { Enemy } from '@/game/entities/Enemy';
import { Player } from '@/game/entities/Player';
import { Stone } from '@/game/entities/Stone';
import { Pickup } from '@/game/entities/Pickup';
import { FieldManager } from '@/game/entities/Field';
import { ProjectileManager } from '@/game/entities/Projectile';
import { FxSystem } from '@/game/systems/fx';
import { InputManager } from '@/game/input/inputManager';
import { audioEngine } from '@/game/systems/audio';
import { gameBus } from '@/game/systems/eventBus';
import { computePlayerStats, liveRunBuffs } from '@/game/systems/statEngine';
import { cameraOverscan, setWorldFramePlanning } from '@/game/world/worldFrame';
import {
  ensureDotTexture,
  ensurePlayerTexture,
  ensurePortalTexture,
  ensureRingTexture,
  ensureSquareParticle,
  ensureStoneTexture,
} from '@/game/textureFactory';
import { takeRunRequest } from '@/game/runRequest';
import { GameplayScene } from '@/game/scenes/GameplayScene';
import { EMPTY_SNAPSHOT, useRunStore } from '@/store/runStore';
import { useSaveStore } from '@/store/saveStore';
import { useSettingsStore } from '@/store/settingsStore';
import { isRunSubscreen, useUiStore } from '@/store/uiStore';
import { getPickupDef } from '@/data/loot';
import { pulse } from '@/utils/haptics';
import { intToHex } from '@/utils/color';
import { clamp, createRng } from '@/utils/math';
import type { DungeonPlan, DungeonSite, DropTable, ElementId, FloorDef, GameMode } from '@/types';

/**
 * Dungeon mode — a generated strip, walked once, worth nothing outside itself.
 *
 * It extends `GameplayScene` rather than duplicating it: the combat glue (spawning, area damage, the
 * projectile pools, pickups, the freeze-and-settle rules) is one set of rules with one set of bugs
 * already paid for, and a second copy would drift. Everything that could reach the *save* is overridden
 * here — `collectPickup`, `addEssence`, `refundOrb`, `onEnemyKilled`, `onPlayerDamageDealt`,
 * `onPlayerDeath` — because the mode's premise is that nothing carries out, and the inherited versions
 * credit essence, shards, mastery and run statistics.
 *
 * The world is one authored cell wide, repeated. `setWorldFramePlanning(false)` keeps `worldFrame`
 * meaning "the cell" for the whole run (walls, hazard placement and the frame's clamps all read it), and
 * the strip's own extent lives in `plan` — which is also why the camera bounds and the entity clamp here
 * use `plan.width` instead of the frame.
 */
/** The eight half-tile bearings tried first when a body is already inside a wall body. */
const ESCAPE_DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
] as const;

export class DungeonScene extends GameplayScene {
  static readonly KEY = 'DungeonScene';

  private plan!: DungeonPlan;
  private ground!: DungeonGround;
  private strip!: DungeonDirector;
  private stones: Stone[] = [];
  private ally!: Ally;
  /** The run's whole economy: a number on a card, never a wallet. */
  private ledger = 0;
  private kills = 0;
  private damageDealt = 0;
  private bestHit = 0;
  private cellIndex = -1;
  private reported = false;
  /** Per-enemy cooldown so one body cannot shred the partner at contact range. */
  private readonly allyHitAt = new WeakMap<Enemy, number>();
  /**
   * What the partner is holding, by spawn tag. The drop itself is retired the moment it is picked up —
   * an orb in someone else's hands is not on the floor any more — and this is what lets it be put down
   * again at the warden's feet without a second copy of the collection rules.
   */
  private readonly allyStash = new Map<number, { defId: string; value: number }>();
  private goalMark: Phaser.GameObjects.Image | null = null;
  /** The stone that explains the strip, and the pen the charts' marks are drawn with. */
  private guide: GuideStone | null = null;
  private guideShown = false;
  private beaconPen: Phaser.GameObjects.Graphics | null = null;
  /**
   * How many marks the pen laid this frame, split by kind: the pips above what is still to come, and the
   * crumbs of the dotted way. A tally the scene keeps itself, so that the feature is measurable — the
   * alternative is a gate reading Phaser's command buffer, which is a private shape to depend on and tells
   * you about draw calls rather than about what the mode decided to mark.
   */
  beaconMarks = { pips: 0, crumbs: 0 };
  /** How many of the three charts the warden has walked over. Everything the way-in marking costs. */
  chartsFound = 0;
  private readonly carryPips: Phaser.GameObjects.Image[] = [];
  /** The seed this scene instance was built from; survives a restart, which arrives seedless. */
  private stripSeed: number | null = null;

  constructor() {
    super(DungeonScene.KEY);
  }

  override create(): void {
    const settings = useSettingsStore.getState();
    const save = useSaveStore.getState();
    const request = takeRunRequest() ?? { mode: 'story' as GameMode, startWave: 1 };
    this.run = { ...request, mode: 'story', kind: 'strip', reason: 'new' };
    this.runStartedAt = Date.now();
    this.essenceRun = 0;
    this.shardsRun = 0;
    this.buffTimer = 0;
    this.bossHandled = false;
    this.destroyed = false;
    this.frozen = false;
    this.ledger = 0;
    this.kills = 0;
    this.damageDealt = 0;
    this.bestHit = 0;
    this.cellIndex = -1;
    this.reported = false;

    setWorldFramePlanning(false);
    // Saved buffs speak the previous scene's clock. Rebase is the one write this mode makes to the
    // save, and it is housekeeping rather than progress: without it every live buff would read as
    // expired the moment the strip began (docs §A3).
    save.rebaseRunBuffs(this.time.now);

    const data = useSaveStore.getState().data;
    const activeSlot = data?.loadout.activeSlot ?? 0;
    const activeElement = (data?.loadout.slots[activeSlot] ?? data?.profile.starter ?? 'fire') as keyof typeof ELEMENT_REGISTRY;
    const stats = computePlayerStats(data, activeElement, liveRunBuffs(data, this.time.now));

    // A restart that arrives without a seed — the base's own respawn/restart commands do not carry one
    // — must not rebuild the ground under the player's feet, so the first seed of this scene instance
    // is kept on the instance itself.
    const seed = request.seed ?? this.stripSeed ?? 20261011;
    this.stripSeed = seed;
    // The brain, not a strip. `planCortex` hands the scene the derived organ — its merged walls, its
    // entry at the back of the head, its seven nested layers — in the same shape the strip's generator
    // produced, so the walk, the stones and the camera all read one plan and cannot disagree with the map.
    this.plan = planCortex(seed);

    ensureDotTexture(this);
    ensurePortalTexture(this);
    ensureRingTexture(this);
    ensureSquareParticle(this);

    this.fx = new FxSystem(this, this.cameras.main, {
      screenShake: settings.screenShake,
      damageNumbers: settings.damageNumbers,
      pixelEffects: settings.pixelEffects,
      reducedMotion: settings.reducedMotion,
      particleScale: 1,
    });

    this.enemies = this.physics.add.group({
      classType: Enemy as unknown as typeof Phaser.Physics.Arcade.Sprite,
      maxSize: 90,
      runChildUpdate: false,
    });
    this.pickups = this.physics.add.group({
      classType: Pickup as unknown as typeof Phaser.Physics.Arcade.Sprite,
      maxSize: 120,
      runChildUpdate: false,
    });
    this.playerProjectiles = new ProjectileManager(this, POOLS.projectiles);
    this.enemyProjectiles = new ProjectileManager(this, POOLS.enemyProjectiles);
    this.fields = new FieldManager(this);

    this.ground = new DungeonGround(this, this.plan, FLOOR_REGISTRY as unknown as Record<number, FloorDef>);
    this.ground.applyWorldBounds();
    // Bodies for every circuit, once, before anything can move.
    this.ground.buildColliders();

    // The mouth of the labyrinth: the first cell's entering lane, before its crossing. The middle of
    // the cell is the spine, and a warden who started inside a wall would spend the run walking out of
    // one — which is exactly the kind of thing a static map check never sees.
    const entry = this.plan.cells[0].circuit;
    const start = this.plan.spawn ?? { x: this.plan.cellWidth * 0.16, y: entry.laneTopFy * this.plan.cellHeight };
    this.player = new Player(this, start.x, start.y, stats, activeElement);
    if (data) {
      this.player.setLoadout(data.loadout.slots, data.loadout.activeSlot);
      this.autoCast.setLoadout(data.loadout.slots, data.loadout.activeSlot, this.xpOfElement);
    }
    this.player.setEvents({
      onAttack: (element) => this.onPlayerAttack(element),
      onSkill: (element) => this.onPlayerSkill(element),
      onUltimate: (element) => this.onPlayerUltimate(element),
      onDash: () => this.publishSnapshot(true),
      onDamageDealt: (amount, isCrit, isBoss) => this.onPlayerDamageDealt(amount, isCrit, isBoss),
      onDamageTaken: (amount) => this.onPlayerDamaged(amount),
      onDeath: () => this.onPlayerDeath(),
    });

    const color = ELEMENT_REGISTRY[activeElement].colorInt;
    const allyTexture = ensurePlayerTexture(this, activeElement, color);
    this.ally = new Ally(this, start.x - 16, start.y, allyTexture, color);
    this.ally.applyStats(stats);

    // The labyrinth's walls stop everybody: the warden, the partner, what wakes up, and every cast in
    // flight. Nothing here needs to pathfind — one corridor with no branches means "get out of the way"
    // is the whole of it, which is why the walls are bodies and not paint.
    const walls = this.ground.walls;
    this.physics.add.collider(this.player, walls);
    this.physics.add.collider(this.ally, walls);
    this.physics.add.collider(this.enemies, walls);
    const stopOn = (manager: ProjectileManager) => (projectile: unknown): void => {
      const shot = projectile as Phaser.GameObjects.Image;
      if (!shot?.active) return;
      this.fx.hitSpark(shot.x, shot.y, 0xffffff, 0.35, 'spark');
      manager.release(shot as never);
    };
    this.physics.add.collider(this.playerProjectiles.group, walls, stopOn(this.playerProjectiles), undefined, this);
    this.physics.add.collider(this.enemyProjectiles.group, walls, stopOn(this.enemyProjectiles), undefined, this);

    // The centre, lit: a goal you can see from the mouth of the last circuit is a goal you walk to.
    // It stays dark until a chart is found, which is what makes the charts the thing that lets a run be
    // finished rather than merely survived.
    this.goalMark = this.add
      .image(this.plan.goal.x, this.plan.goal.y, 'fx_ring')
      .setVisible(false)
      .setDepth(-8)
      .setScale(2.4)
      .setAlpha(0.4)
      .setTint(Phaser.Display.Color.HexStringToColor(this.floorAt(0).palette.accent).color);

    this.context = {
      scene: this,
      fx: this.fx,
      camera: this.cameras.main,
      player: this.player,
      enemies: this.enemies,
      playerProjectiles: this.playerProjectiles,
      enemyProjectiles: this.enemyProjectiles,
      fields: this.fields,
      floor: this.floorAt(0),
      scaling: { hpMult: 1, damageMult: 1, speedMult: 1, eliteChance: 0.12, affixChance: 0.2, affixes: [] },
      spawnEnemy: (defId, x, y, options) => this.spawnEnemy(defId, x, y, options),
      spawnPortal: (x, y, color) => this.spawnPortal(x, y, color),
      spawnPickup: (id, x, y, value) => this.spawnPickup(id, x, y, value),
      rollDropTable: (table, x, y, bonus) => this.rollDropTable(table, x, y, bonus),
      addEssence: (amount) => this.addEssence(amount),
      addShards: (amount) => {
        this.shardsRun += amount;
      },
      onEnemyKilled: (enemy) => this.onEnemyKilled(enemy),
      onBossPhase: () => undefined,
      onBossTelegraph: () => undefined,
      damageArea: (config) => this.damageArea(config),
      eruption: (config) => this.eruption(config),
      hitSparkAt: (x, y, hitColor, power, vfx, family) => this.fx.hitSpark(x, y, hitColor, power, vfx, family),
      addHazardBurst: (x, y, radius, damage, hazardColor, element, statuses) =>
        this.addHazardBurst(x, y, radius, damage, hazardColor, element, statuses),
      telegraph: (x, y, radius, telegraphColor, durationMs) => this.telegraph(x, y, radius, telegraphColor, durationMs),
      addField: (config) => this.fields.add(config),
      audioEnabled: true,
    };
    this.player.setContext(this.context);

    this.strip = new DungeonDirector(this.plan, {
      release: (site, x, y, index) => this.releaseFrom(site, x, y, index),
      finish: (reason) => this.finishRun(reason),
    });

    this.buildStones(this.cellStart(start.x));
    this.beaconPen = this.add.graphics().setDepth(-7);
    // A scene is restarted, not reconstructed: what the last walk found must not mark the way in this one.
    this.chartsFound = 0;
    this.guideShown = false;
    this.buildGuide();
    this.buildCharts();
    this.registerPhysicsOverlaps();
    this.registerBusCommands();
    this.registerStripOverlaps();

    this.inputManager = new InputManager(this, {
      onPause: () => {
        const ui = useUiStore.getState();
        if (ui.deathOpen || ui.transition) return;
        if (isRunSubscreen(ui.screen)) {
          ui.back();
          return;
        }
        ui.setPaused(!ui.paused);
      },
      onSwitchSlot: (slot) => this.switchElement(slot),
      onCycleElement: (direction) => this.player.cycleElement(direction),
      onSkill: () => undefined,
      onUltimate: () => undefined,
      onDash: () => undefined,
    });

    this.setupStripCamera();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.handleStripResize, this);

    this.setupMusic(this.plan.cells[0].biome);

    this.publishSnapshot(true);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.cleanup());
    this.scene.launch('PauseScene');
  }

  /* ------------------------------------------------------------------ */
  /* The strip                                                          */
  /* ------------------------------------------------------------------ */

  private floorAt(index: number): FloorDef {
    const cell = this.plan.cells[Math.max(0, Math.min(this.plan.chunkCount - 1, index))];
    return (FLOOR_REGISTRY[cell?.biome ?? 1] ?? FLOOR_REGISTRY[1]) as FloorDef;
  }

  private cellStart(x: number): number {
    return Math.max(0, Math.min(this.plan.chunkCount - 1, Math.floor(x / this.plan.cellWidth)));
  }

  /**
   * Which cell of the plan the warden is standing in. On a strip that is the column under their feet; in the
   * brain it is the layer the run is *in*, which is a question about the tile, not about the x. Everything
   * that labels the player's position — the HUD's line counter, the minimap's highlight, the beacon's search
   * for the next unspent site — asks this instead of doing the division itself.
   */
  private cellNow(): number {
    const layer = this.plan.layerAt?.(this.player.x, this.player.y) ?? -1;
    return layer >= 0
      ? Math.max(0, Math.min(this.plan.chunkCount - 1, layer))
      : this.cellStart(this.player.x);
  }

  /**
   * Whether a site should have a sprite on the world right now.
   *
   * On a strip a site belongs to a column and the two columns either side of the camera are enough. The
   * brain is one cell wide with every site at `chunk: 0`, so that same test retires the whole map the
   * moment the walk reaches the third band — which is a fault, not a saving: past line five of a dungeon
   * run there were no stones left to find, and a run that spends its deep bands on an empty floor is the
   * "the dungeon is empty" report with the wrong diagnosis attached. So the window asks the plan which
   * band a site is in, and falls back to keeping it when the plan cannot say.
   *
   * Waystones never leave. A link is a fact about the run, and a node that is lit, gone, and lit again
   * depending on where the camera happens to be is a network the player cannot read.
   */
  private siteInWindow(site: DungeonSite): boolean {
    if (site.kind === 'waypoint') return true;
    if (this.plan.layerAt) {
      const band = this.plan.layerAt(site.fx * this.plan.cellWidth, site.fy * this.plan.cellHeight);
      if (band >= 0) return Math.abs(band - this.cellNow()) <= 1;
      return true;
    }
    return Math.abs(site.chunk - this.cellIndex) <= 1;
  }

  /** Stones exist only near the camera, and their state lives in the director, not in the sprite. */
  private buildStones(centre: number): void {
    void centre;
    for (const site of this.strip.allSites) {
      if (!this.siteInWindow(site)) continue;
      if (this.stones.some((stone) => stone.site.id === site.id)) continue;
      const world = { x: site.fx * this.plan.cellWidth + site.chunk * this.plan.cellWidth, y: site.fy * this.plan.cellHeight };
      const variant = site.kind === 'cache' ? 1 : site.kind === 'spring' ? 2 : 0;
      const texture = ensureStoneTexture(this, this.stoneColor(site.kind), variant);
      const stone = new Stone(this, world.x, world.y, site, texture, variant);
      if (this.strip.isSpent(site.id)) stone.spend();
      // A waystone already on the network comes back lit: the link outlives the sprite, and the sprite is
      // the only place the run shows it.
      else if (site.kind === 'waypoint' && this.strip.isLinked(site.id)) stone.awaken(this.stoneColor('waypoint'));
      this.stones.push(stone);
    }
  }

  private stoneColor(kind: DungeonSite['kind']): number {
    if (kind === 'spring') return 0x57c7ff;
    if (kind === 'cache') return 0xf2c96b;
    if (kind === 'field') return 0xff5c6c;
    if (kind === 'den') return 0xb98cff;
    // Plain bright stone, not another jewel: a waystone is furniture, and the guide stone's mint already
    // owns the "read me" colour at the mouth.
    if (kind === 'waypoint') return 0xdfe9ff;
    return 0xff7a3c;
  }

  /**
   * One handler for the whole run.
   *
   * It overlaps the *group*, and cells add their stones to that same group as they come into range —
   * registering per cell instead would stack a handler per cell change, and a spring would drink twice
   * on the third visit to a cell.
   */
  private registerStripOverlaps(): void {
    if (this.stoneOverlapRegistered) return;
    this.stoneOverlapRegistered = true;
    this.physics.add.overlap(this.player, this.stonesGroup(), (_a, b) => {
      const stone = b as unknown as Stone;
      if (!stone?.interactive) return;
      this.activate(stone);
    });
  }

  /** A group, because Arcade's overlap wants one and the scene already pools enemies this way. */
  private stonesGroup(): Phaser.Physics.Arcade.Group {
    if (!this.stoneGroup) {
      this.stoneGroup = this.physics.add.group({ allowGravity: false, immovable: true });
    }
    for (const stone of this.stones) {
      if (!this.stoneGroup.contains(stone)) this.stoneGroup.add(stone, false);
    }
    return this.stoneGroup;
  }
  private stoneGroup: Phaser.Physics.Arcade.Group | null = null;
  private stoneOverlapRegistered = false;
  /**
   * Whether a waystone will currently hop the party.
   *
   * A warp lands the warden *on* the destination stone, so the overlap that produced the hop is still true
   * on the next frame — without this the ring would spin the party through every link once per frame. It
   * re-arms in `update` once they have stepped clear of every waystone.
   */
  private warpArmed = true;
  private lastWarpAt = 0;
  /**
   * When the warden last *stood* on this kind of stone, or null while they are only passing over it.
   *
   * A waystone is walked through, not walked onto — see `DUNGEON.warp`. The dwell is cleared whenever the
   * warden is moving, whenever they are clear of every stone, and after any hop or refusal, so a hop always
   * costs a deliberate stop rather than a frame of contact.
   */
  private warpDwellSince: number | null = null;
  /** The hostiles the bands supplied, tracked so they can be culled when the camera loses them. */
  private readonly roamers = new Set<Enemy>();
  private nextRoamAt = 0;
  private roamTick = 0;
  /**
   * Where the party was when the bands last sent something.
   *
   * The trickle answers movement, not patience: standing still in a corridor is a rest, and a spawner that
   * kept arriving while the warden was not going anywhere turns a paused player into a target. It also keeps
   * the mode's own gates honest — several of them park the warden to measure something, and an ambush during
   * a parked measurement used to end the run mid-probe.
   */
  private roamAnchor: { x: number; y: number } | null = null;
  /** Ground covered since the last arrival, in world pixels — see `tickRoamers`. */
  private roamTravel = 0;
  private roamPrevious: { x: number; y: number } | null = null;

  private activate(stone: Stone): void {
    if (!stone.interactive || stone.releasing) return;
    const site = stone.site;
    if (site.kind === 'grove' || site.kind === 'den') {
      stone.releasing = true;
      stone.awaken(this.stoneColor(site.kind));
      this.strip.wake(site, stone.x, stone.y);
      this.fx.callout(stone.x, stone.y - 12, site.kind === 'den' ? 'THE DEN' : 'WAKING', '#FF7A3C', 6);
      pulse('skill');
      return;
    }
    if (site.kind === 'cache') {
      const table = getDropTable(site.tableId ?? '');
      if (table) this.popCache(table, stone.x, stone.y);
      stone.awaken(this.stoneColor('cache'));
      stone.spend();
      this.strip.spend(site.id);
      this.fx.ring(stone.x, stone.y, 0xf2c96b, 26, 0.5, 1.1);
      pulse('crit');
      return;
    }
    if (site.kind === 'spring') {
      this.player.heal(Math.max(1, Math.round(this.player.maxHp * 0.28)));
      this.ally.restore();
      stone.charges -= 1;
      this.fx.ring(stone.x, stone.y, 0x57c7ff, 22, 0.55, 1);
      this.fx.callout(stone.x, stone.y - 12, `SPRING ${Math.max(0, stone.charges)} LEFT`, '#57C7FF', 6);
      if (stone.charges <= 0) {
        stone.spend();
        this.strip.spend(site.id);
      }
      return;
    }
    if (site.kind === 'field') {
      // A band of ground that hurts, built from the scene's own mine path so the biome hazard director
      // — which places as a fraction of the *frame* — stays out of this mode entirely.
      const floor = this.floorAt(site.chunk);
      const color = this.stoneColor('field');
      for (let i = 0; i < 5; i += 1) {
        const angle = (i / 5) * Math.PI * 2;
        this.spawnMine(
          stone.x + Math.cos(angle) * DUNGEON.fieldRingRadius,
          stone.y + Math.sin(angle) * DUNGEON.fieldRingRadius * DUNGEON.ringSquash,
          // The band's own intensity, which the generator scales with depth: a field on the sixth line is
          // not a field on the first with the same teeth.
          Math.max(3, Math.round(6 * floor.modifiers.damageMult * (site.intensity ?? 1))),
          color,
        );
      }
      stone.spend();
      this.strip.spend(site.id);
      this.fx.callout(stone.x, stone.y - 12, 'FIELD SEEDED', '#FF5C6C', 6);
      return;
    }
    if (site.kind === 'waypoint') {
      const color = 0xdfe9ff;
      // First touch links. It is the only touch that changes the map, and it never spends the stone.
      if (this.strip.link(site)) {
        stone.awaken(color);
        this.fx.ring(stone.x, stone.y, color, 24, 0.5, 1);
        this.fx.callout(
          stone.x,
          stone.y - 12,
          this.strip.nextLinked(site.id) ? 'WAYSTONE LINKED' : 'LINKED · ONE ON THE NETWORK',
          '#DFE9FF',
          6,
        );
        this.warpArmed = true;
        pulse('skill');
        return;
      }
      const now = this.time.now;
      if (!this.warpArmed || now - this.lastWarpAt < DUNGEON.warp.hopFloorMs) return;
      const body = this.player.body as Phaser.Physics.Arcade.Body | null;
      const speed = body ? Math.hypot(body.velocity.x, body.velocity.y) : 0;
      if (speed > DUNGEON.warp.dwellSpeedPx) {
        // Passing over it. The stone's own ring flickers to say it noticed, and that is all a stride gets.
        this.warpDwellSince = null;
        return;
      }
      if (this.warpDwellSince === null) {
        this.warpDwellSince = now;
        return;
      }
      if (now - this.warpDwellSince < DUNGEON.warp.dwellMs) return;
      this.warpDwellSince = null;
      this.lastWarpAt = now;
      const to = this.strip.nextLinked(site.id);
      if (!to) {
        // A stone that cannot take you anywhere says so. A verb that fails quietly is a bug the player
        // has to find by guessing.
        this.fx.callout(stone.x, stone.y - 12, 'NO SECOND STONE TO REACH', '#DFE9FF', 5);
        return;
      }
      const dest = {
        x: to.fx * this.plan.cellWidth + to.chunk * this.plan.cellWidth,
        y: to.fy * this.plan.cellHeight,
      };
      const move = (go: Phaser.GameObjects.Sprite | null, x: number, y: number) => {
        if (!go?.active) return;
        (go.body as Phaser.Physics.Arcade.Body | null)?.reset(x, y);
        go.setPosition(x, y);
      };
      this.strip.noteWarp();
      this.warpArmed = false;
      this.fx.ring(stone.x, stone.y, color, 30, 0.5, 1.2);
      // The partner comes with them. Leaving the ally three lines away is what the labyrinth is for in a
      // fight, not in a transport — and the mode already has a gate about the partner being left somewhere.
      move(this.player, dest.x, dest.y);
      if (this.ally.allyState !== 'downed') move(this.ally, dest.x - 16, dest.y);
      this.cameras.main.centerOn(dest.x, dest.y);
      this.fx.ring(dest.x, dest.y, color, 34, 0.6, 1.3);
      const stage = this.strip.stage(dest.x, dest.y);
      const hops = this.strip.warpCount;
      this.fx.callout(dest.x, dest.y - 14, `LINE ${stage.line} · ${hops} WARP${hops > 1 ? 'S' : ''}`, '#DFE9FF', 6);
      pulse('skill');
      return;
    }
  }

  /**
   * A cache opens outward, one placement per drop.
   *
   * `rollDropTable` puts everything on a single point, which is right for a corpse in an arena and wrong
   * for a stone the player is standing on: the pile would stack and vacuum away as one. Same table, same
   * `rollTable` the story path uses — only the geometry is the strip's own.
   */
  private popCache(table: DropTable, x: number, y: number): void {
    const rolls = rollTable(table, createRng(Math.floor(Math.random() * 1_000_000)), 1);
    const total = Math.max(1, rolls.reduce((sum, roll) => sum + roll.count, 0));
    let placed = 0;
    for (const roll of rolls) {
      for (let i = 0; i < roll.count; i += 1) {
        const angle = (placed / total) * Math.PI * 2;
        const spot = this.groundNear({ x, y }, Math.cos(angle) * DUNGEON.dropRadius, Math.sin(angle) * DUNGEON.dropRadius * DUNGEON.ringSquash);
        this.spawnPickup(roll.id, spot.x, spot.y);
        placed += 1;
      }
    }
  }

  /**
   * A ring position that is actually ground.
   *
   * Drops and woken enemies are scattered outward from a stone, which is right on an open field and wrong
   * in a fold: a cache's orb inside a ridge is an orb nobody will ever carry, and an enemy standing in
   * stone is a fight that never starts. So the offset is tried at full reach, then shorter, then around,
   * and only if every one of those is stone does the scatter collapse onto the site's own tile — a pile in
   * one place beats a pile in the wall.
   */
  /**
   * The bands hunt you whether or not anything has been woken.
   *
   * A roamer is placed **ahead on the route and outside the frame**, which is what makes it a threat arriving
   * rather than a sprite popping on top of the warden: the corridor is searched forward from the tile the
   * party is nearest, and the first candidate clear of both the ahead-distance and the camera's view wins.
   * `groundNear` then pulls it onto walkable ground, because a hostile standing in stone is a fight that never
   * starts — and, in this mode, a body inside a wall is a fault with a gate on it.
   *
   * Four limits keep it cheap and honest: the cap, the fight ceiling (the mode already wakes packs from stones,
   * and a trickle that reinforced a live battle would be the dungeon doubling its own difficulty behind the
   * pacing it was authored with), the interval (which shortens with the band, so line six is not line one with
   * more of it), and the cull (a roamer the camera has lost is retired — an ever-growing trail of pursuers is a
   * slow leak that only shows up as frame time). They are never sites: `LEAVE NOTHING` counts what the map holds, and that stays true whether
   * or not you are being chased.
   */
  private tickRoamers(): void {
    const tile = this.plan.fissure?.tilePx ?? 64;
    // Where the warden *got to*, not how hard they are pushing: counting the body's velocity meant that holding
    // a direction into stonework accumulated the same pressure as advancing, and the bands turned a stuck
    // button into an ambush. One tile per frame is the ceiling on what counts, so a waystone hop — which is
    // teleportation, not travel — cannot farm a spawn on arrival; the party should be hunted for walking the
    // corridor, and warping is the one verb this mode gives them for not walking it.
    const nowPos = { x: this.player.x, y: this.player.y };
    if (this.roamPrevious) {
      const d = Math.hypot(nowPos.x - this.roamPrevious.x, nowPos.y - this.roamPrevious.y);
      if (d < tile) this.roamTravel += d;
    }
    this.roamPrevious = nowPos;
    const view = this.cameras.main.worldView;
    if (this.roamers.size) {
      const cull = DUNGEON.roamCullTiles * tile;
      for (const foe of [...this.roamers]) {
        if (!foe.active) {
          this.roamers.delete(foe);
          continue;
        }
        if (
          Phaser.Math.Distance.Between(foe.x, foe.y, this.player.x, this.player.y) > cull &&
          !view.contains(foe.x, foe.y)
        ) {
          foe.retire();
          this.roamers.delete(foe);
        }
      }
    }
    const now = this.time.now;
    if (now < this.nextRoamAt) return;
    if (!this.roamAnchor) {
      this.roamAnchor = { x: this.player.x, y: this.player.y };
      return;
    }
    // Distance *covered*, not distance from where the last one arrived: a warden working a corner, backing off
    // a face and coming around again has spent the run's attention and deserves the pressure, while one
    // measuring displacement from an anchor can pace a dead end forever without the bands noticing — which is
    // exactly what the first version of this rule did, and what a keyboard walk into a wall exposed.
    if (this.roamTravel < tile * 1.2) return;
    const band = this.cellNow();
    this.nextRoamAt = now + Math.max(DUNGEON.roamMinIntervalMs, DUNGEON.roamIntervalMs - band * 250);
    // The trickle ramps with the bands too, so line six hunts and line eight rests: one pursuer at the mouth,
    // two by the middle rings, and the ceiling only down where the run has springs to spend.
    const cap = Math.min(DUNGEON.roamCap, 1 + Math.floor(band / 2.5));
    if (this.roamers.size >= cap) return;
    if (this.enemies.countActive(true) >= DUNGEON.roamFightCeiling) return;

    const route = this.plan.cells[band]?.circuit.route ?? this.plan.cells[0]?.circuit.route ?? [];
    if (route.length < 4) return;
    const at = (p: { fx: number; fy: number }) => ({ x: p.fx * this.plan.cellWidth, y: p.fy * this.plan.cellHeight });
    const here = { x: this.player.x, y: this.player.y };
    let nearest = 0;
    let bestD = Number.POSITIVE_INFINITY;
    for (let i = 0; i < route.length; i += 1) {
      const p = at(route[i]);
      const d = (p.x - here.x) ** 2 + (p.y - here.y) ** 2;
      if (d < bestD) {
        bestD = d;
        nearest = i;
      }
    }
    const ahead = DUNGEON.roamAheadTiles * tile;
    let spot: { x: number; y: number } | null = null;
    let farthest = 0;
    for (let step = 1; step <= 20; step += 1) {
      const p = at(route[(nearest + step * 2) % route.length]);
      const d = Math.hypot(p.x - here.x, p.y - here.y);
      if (d < ahead) continue;
      // Off the frame is what makes it an arrival rather than an appearance, and at the authored 320 × 200
      // view there is usually such a place four tiles up the corridor. At a phone or a zoom-2 window the view
      // is 450 × 350 world pixels wide, and "off the frame" and "four tiles away" stop being simultaneously
      // satisfiable on a snaking route — so the farthest stretch of corridor wins instead. Refusing to spawn
      // at all was the alternative, which meant half the players in the world had no trickle whatsoever.
      if (!view.contains(p.x, p.y)) {
        spot = p;
        break;
      }
      if (d > farthest) {
        farthest = d;
        spot = p;
      }
    }
    if (!spot) return;
    const floor = this.floorAt(band);
    const pool = floor.enemyPool;
    if (!pool?.length) return;
    const ground = this.groundNear(spot, 0, 0);
    this.roamTick += 1;
    const defId = pickDef(floor.id, pool[this.roamTick % pool.length], band * 8 + this.roamTick);
    const foe = this.spawnEnemy(defId, ground.x, ground.y, { rank: 'normal' });
    if (!foe) return;
    // The pool hands back retired objects, so a reused enemy may carry its old membership.
    this.roamers.delete(foe);
    this.roamers.add(foe);
    this.roamTravel = 0;
    this.fx.hitSpark(foe.x, foe.y, 0xffffff, 0.5, 'spark');
  }

  private groundNear(from: { x: number; y: number }, dx: number, dy: number): { x: number; y: number } {
    if (!this.plan.layerAt) return { x: from.x + dx, y: from.y + dy };
    for (const k of [1, 0.7, 0.45]) {
      const at = { x: from.x + dx * k, y: from.y + dy * k };
      if (this.plan.layerAt(at.x, at.y) >= 0) return at;
    }
    const step = this.plan.walls ? (this.plan.fissure?.tilePx ?? 64) : 24;
    for (let ring = 1; ring <= 4; ring += 1) {
      for (let a = 0; a < 8; a += 1) {
        const at = {
          x: from.x + Math.cos((a / 8) * Math.PI * 2) * step * ring,
          y: from.y + Math.sin((a / 8) * Math.PI * 2) * step * ring,
        };
        if (this.plan.layerAt(at.x, at.y) >= 0) return at;
      }
    }
    return { x: from.x, y: from.y };
  }

  private releaseFrom(site: DungeonSite, x: number, y: number, index: number): void {
    const floor = this.floorAt(site.chunk);
    const angle = (index / Math.max(1, site.n)) * Math.PI * 2 + 0.4;
    // Clamped to the *cell*, in world pixels: a cell-relative bound here yanked everything woken in
    // cell 3 back to the first cell's edge, which is a spawn nobody can see happening.
    const cellLeft = site.chunk * this.plan.cellWidth + 20;
    const ring = this.groundNear(
      {
        x: clamp(x + Math.cos(angle) * DUNGEON.dropRadius, cellLeft, cellLeft + this.plan.cellWidth - 40),
        y: clamp(y + Math.sin(angle) * DUNGEON.dropRadius * DUNGEON.ringSquash, 20, this.plan.cellHeight - 20),
      },
      0,
      0,
    );
    const ex = ring.x;
    const ey = ring.y;
    const elite = site.kind === 'den';
    // Archetypes are what the floor author wrote; the roster says which definitions stand in for them
    // on this floor. Same function the wave generator uses, so a strip cannot drift from the story.
    const archetype = floor.enemyPool[index % Math.max(1, floor.enemyPool.length)];
    const defId = elite ? site.bossId ?? floor.miniBossId : pickDef(floor.id, archetype, index + site.chunk);
    const enemy = this.spawnEnemy(defId, ex, ey, {
      rank: elite ? 'miniboss' : 'normal',
      elite,
      affixes: elite && floor.affixPool.length ? [floor.affixPool[index % floor.affixPool.length]] : [],
    });
    if (enemy) this.fx.hitSpark(enemy.x, enemy.y, 0xffffff, 0.6, 'spark');
    if (index >= Math.max(1, site.n) - 1) {
      const stone = this.stones.find((s) => s.site.id === site.id);
      stone?.spend();
      stone && (stone.releasing = false);
    }
  }

  private allyView(): AllyView {
    return this.allyViewObject ??= {
      player: this.player,
      nearestEnemy: (x, y, radius) => {
        let best: Enemy | null = null;
        let bestScore = radius * radius;
        for (const child of this.enemies.getChildren() as Enemy[]) {
          if (!child.active) continue;
          const score = (child.x - x) ** 2 + (child.y - y) ** 2;
          if (score < bestScore) {
            bestScore = score;
            best = child;
          }
        }
        return best;
      },
      strike: (enemy) => {
        const element = this.allyElement();
        this.damageArea({
          x: enemy.x,
          y: enemy.y,
          radius: 26,
          damage: this.ally.power,
          element,
          vfx: 'spark',
          color: element ? ELEMENT_REGISTRY[element].colorInt : 0xf2c96b,
          friendly: true,
          auto: true,
          maxTargets: 2,
        });
      },
      hazardAt: (x, y) => {
        let worst = 0;
        for (const mine of this.hazardSprites) {
          const sprite = mine as Phaser.GameObjects.Image;
          if (!sprite.active) continue;
          const distance = Math.hypot(sprite.x - x, sprite.y - y);
          if (distance < 18) worst = Math.max(worst, 14);
        }
        return worst;
      },
      onDowned: () => {
        this.fx.callout(this.ally.x, this.ally.y - 12, 'PARTNER DOWN', '#FF5C6C', 7);
        pulse('hurt');
      },
      // An orb the warden is already reaching for is the warden's. Anything else on the floor with
      // value on it is the partner's errand.
      nearestOrb: (x, y, radius) => {
        let best: { id: number; x: number; y: number } | null = null;
        let bestScore = radius * radius;
        for (const child of this.pickups.getChildren() as Pickup[]) {
          if (!child.active || child.gathering || child.placed) continue;
          if (child.kind !== 'essence' && child.kind !== 'shard') continue;
          if (this.ally.carried.includes(child.spawnTag)) continue;
          if (Math.hypot(child.x - this.player.x, child.y - this.player.y) < this.player.pickupRadius) continue;
          const score = (child.x - x) ** 2 + (child.y - y) ** 2;
          if (score < bestScore) {
            bestScore = score;
            best = { id: child.spawnTag, x: child.x, y: child.y };
          }
        }
        return best;
      },
      takeOrb: (orb) => {
        const pickup = (this.pickups.getChildren() as Pickup[]).find(
          (child) => child.active && child.spawnTag === orb.id,
        );
        if (!pickup || pickup.placed) return false;
        this.allyStash.set(pickup.spawnTag, { defId: pickup.defId, value: pickup.value });
        this.fx.ring(pickup.x, pickup.y, pickup.colorInt, 16, 0.3);
        pickup.retire();
        return true;
      },
      /**
       * The partner's one piece of map knowledge: the only way from one side of the spine to the other
       * is this cell's crossing, so that is what it aims at when the straight line stops working. The
       * merged last cell needs no crossing at all, which is why the centre reads as an arrival.
       */
      // "Can I stand where I am about to step?" — asked after the route answers, and answered from the same
      // wall list the physics runs on, so the partner's aim and the warden's collisions cannot drift apart.
      standable: (x, y, toward) => this.standableSpot(x, y, toward),
      recallDistance: Math.max(
        DUNGEON.partner.leashDistance * 6,
        (this.plan.fissure?.tilePx ?? 64) * DUNGEON.partner.recallTiles,
      ),
      corridorStep: (x, y, to, heading) => {
        // The corridor is the map's own polyline, built once and reused: the partner walks the route the
        // generator laid out and the renderer drew, so the three of them cannot disagree, and "can the
        // partner get there" stops being a question — in a labyrinth the route is the only way and it
        // always exists.
        const points = (this.routePx ??= this.plan.route ?? stripRoute(this.plan));
        const lengths = (this.routeLens ??= routeLengths(points));
        const blocked = (a: { x: number; y: number }, b: { x: number; y: number }) =>
          this.wallBetween(a.x, a.y, b.x, b.y);
        return corridorStep(points, lengths, { x, y }, to, DUNGEON.partner.corridorLookahead, blocked, heading);
      },
      deliver: (ids, x, y) => {
        let placed = 0;
        for (const tag of ids) {
          const held = this.allyStash.get(tag);
          if (!held) continue;
          this.allyStash.delete(tag);
          const angle = (placed / Math.max(1, ids.length)) * Math.PI * 2 + 0.6;
          // Placed at the warden's feet, inside their own pickup radius, so the ledger grows through
          // the same vacuum every other drop rides. The partner never credits anything by hand.
          this.spawnPickup(
            held.defId,
            x + Math.cos(angle) * DUNGEON.dropRadius * 0.7,
            y + Math.sin(angle) * DUNGEON.dropRadius * 0.7 * DUNGEON.ringSquash,
            held.value,
          );
          placed += 1;
        }
        if (placed > 0) {
          this.fx.callout(x, y - 14, `BROUGHT ${placed} TO YOU`, '#F2C96B', 6);
        }
      },
    };
  }
  private allyViewObject: AllyView | null = null;
  /** The strip's corridor in world pixels, and its cumulative lengths: the partner's only map. */
  private routePx: { x: number; y: number }[] | null = null;
  private routeLens: number[] | null = null;

  /**
   * Does a wall stand between two points? A segment against the strip's own rectangles, which is all the
   * geometry the mode has: no grid, no navmesh, nothing to keep in step with the map generator.
   */
  /**
   * Is a box at this centre wholly inside one of the wall bodies? The same shape the gates measure with —
   * more than a pixel of penetration on all four sides — so the game and the audit can never disagree about
   * what "inside a wall" means. A centre-point test would not do: a mover straddling a thin ridge reads as
   * clear, and a mover buried in a thick one reads the same.
   */
  private buriedAt(cx: number, cy: number, w = 12, h = 12): boolean {
    const x = cx - w / 2;
    const y = cy - h / 2;
    for (const rect of this.ground.wallRects) {
      if (x > rect.x + 1 && x + w < rect.x + rect.w - 1 && y > rect.y + 1 && y + h < rect.y + rect.h - 1) {
        return true;
      }
    }
    return false;
  }

  /**
   * The point this body can stand on that is closest to `toward`, walking back toward the body in half-tile
   * steps; or, when the body is already inside stone, the nearest tile centre that is not.
   *
   * Half a tile is the unit because that is the resolution the map is authored at — a finer search finds a
   * point that is geometrically clear and still visually jammed into a corner.
   */
  private standableSpot(
    x: number,
    y: number,
    toward: { x: number; y: number },
  ): { x: number; y: number } | null {
    const tile = this.plan.fissure?.tilePx ?? 64;
    const floor = (px: number, py: number) => (this.plan.layerAt ? this.plan.layerAt(px, py) >= 0 : true);
    if (this.buriedAt(x, y)) {
      for (let k = 1; k <= 8; k += 1) {
        for (const [dx, dy] of ESCAPE_DIRS) {
          const px = x + dx * tile * k * 0.5;
          const py = y + dy * tile * k * 0.5;
          if (!this.buriedAt(px, py) && floor(px, py)) return { x: px, y: py };
        }
      }
      // Trapped: hold in place rather than add another shove against the fold to the pile.
      return { x, y };
    }
    if (!this.buriedAt(toward.x, toward.y) && !this.wallBetween(x, y, toward.x, toward.y)) return toward;
    if (!this.buriedAt(toward.x, toward.y)) return null;
    // The aim itself is in stone — a leash point 34px on the far side of a fold is exactly this. Walk back
    // along the line to the first ground that is both clear and reachable; if the corridor is the only way
    // round, `corridorStep` already has it and there is nothing to correct.
    const len = Math.hypot(toward.x - x, toward.y - y) || 1;
    const ux = (toward.x - x) / len;
    const uy = (toward.y - y) / len;
    for (let at = len - tile * 0.5; at > tile * 0.25; at -= tile * 0.5) {
      const px = x + ux * at;
      const py = y + uy * at;
      if (this.buriedAt(px, py) || !floor(px, py)) continue;
      if (this.wallBetween(x, y, px, py)) continue;
      return { x: px, y: py };
    }
    return null;
  }

  private wallBetween(ax: number, ay: number, bx: number, by: number): boolean {
    for (const rect of this.ground.wallRects) {
      if (crossesRect(ax, ay, bx, by, rect)) return true;
    }
    return false;
  }

  /** Two dots in the partner's hands, so "it is carrying my loot" is visible and not a guess. */
  private syncCarryPips(): void {
    const want = Math.min(DUNGEON.partner.carryCapacity, this.ally.carrying);
    while (this.carryPips.length > want) this.carryPips.pop()?.destroy();
    while (this.carryPips.length < want) {
      this.carryPips.push(this.add.image(0, 0, 'fx_dot').setDepth(11).setTint(0xf2c96b).setScale(1.6));
    }
    this.carryPips.forEach((pip, index) => {
      const angle = -Math.PI / 2 + (index - (this.carryPips.length - 1) / 2) * 0.9;
      pip.setPosition(Math.round(this.ally.x + Math.cos(angle) * 9), Math.round(this.ally.y + Math.sin(angle) * 9));
    });
  }

  private allyElement(): ElementId | null {
    const equipped = this.player.slots.filter(Boolean) as ElementId[];
    const support = equipped.filter((element) => element !== this.player.activeElement);
    return support[0] ?? this.player.activeElement ?? null;
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                              */
  /* ------------------------------------------------------------------ */

  private setupStripCamera(): void {
    const camera = this.cameras.main;
    const overscan = cameraOverscan();
    // No frame demand of its own: the dungeon is fitted and zoomed exactly as a wave run is, so a warden is
    // the same number of CSS pixels tall in both. What the labyrinth controls instead is its own unit —
    // `tilePx` in the derivation — and that is the dial that decides how much of it fits in the shared frame.
    // Bounds follow the strip, not the frame: this is the one place the map is wider than a cell.
    camera.setBounds(0, -overscan, this.plan.width, this.plan.height + overscan * 2);
    camera.setRoundPixels(true);
    camera.setZoom(1);
    this.fx.setBaseZoom(1);
    camera.startFollow(this.player, true, CAMERA_CONFIG.followLerp, CAMERA_CONFIG.followLerp);
    if (overscan > 0) {
      // The strip opts out of frame re-planning, so it cannot shrink the field away from the thumb
      // pads the way a wave run does. The camera pays for it instead: the focus sits
      // `1 - padBandFraction` of the band above the middle, so the party walks in the clear space.
      camera.setFollowOffset(0, -Math.round(overscan * (1 - DUNGEON.camera.padBandFraction)));
    }
    camera.setBackgroundColor(this.floorAt(0).palette.bg);
    camera.fadeIn(280, 0, 0, 0);
  }

  /**
   * A frame change never re-plans the field here, so the only work is re-fitting the camera and pulling
   * anything that fell outside the *strip* back in. Clamping to the cell instead would drag the player
   * to the far side of the map on every rotation.
   */
  private handleStripResize = (): void => {
    if (this.destroyed || !this.player) return;
    this.fx.settle();
    const camera = this.cameras.main;
    const overscan = cameraOverscan();
    camera.setBounds(0, -overscan, this.plan.width, this.plan.height + overscan * 2);
    this.fx.setBaseZoom(1);
    const inset = 18;
    const inside = (sprite: Phaser.Physics.Arcade.Sprite): void => {
      if (!sprite?.active) return;
      sprite.x = Phaser.Math.Clamp(sprite.x, inset, this.plan.width - inset);
      sprite.y = Phaser.Math.Clamp(sprite.y, inset, this.plan.cellHeight - inset);
    };
    inside(this.player);
    inside(this.ally);
    for (const child of this.enemies.getChildren() as Enemy[]) inside(child);
  };


  /* ------------------------------------------------------------------ */
  /* Loop                                                               */
  /* ------------------------------------------------------------------ */
  /**
   * The guide stone, beside the corridor's first stride. It is not a site: it holds nothing, it is never
   * spent, and it is not in the ledger's count of things left to use. What it holds is the vocabulary —
   * which stone wakes what, which one pays, which one ends the walk — in a card the HUD draws.
   */
  private buildGuide(): void {
    const spot = this.plan.route ? cortexGuide(this.plan) : guideSpot(this.plan);
    this.guide = new GuideStone(this, spot.x, spot.y, ensureStoneTexture(this, 0x7fe0c0, 0));
    this.physics.add.overlap(this.player, this.guide, () => this.raiseGuide());
  }

  /**
   * The charts: placed on the corridor itself, in every other cell. Not dropped, so no scatter and no
   * lifetime — a map that evaporated while you were fighting a grove would be a worse joke than no map.
   */
  private buildCharts(): void {
    for (const spot of this.plan.route ? cortexCharts(this.plan) : chartSpots(this.plan)) {
      this.spawnPickup('way_map', spot.x, spot.y, 1, true);
    }
  }

  /** Opened by walking into the stone, the mode's only interaction verb, and free to read again. */
  private raiseGuide(): void {
    const guide = this.guide;
    if (!guide) return;
    const now = this.time.now;
    if (now - guide.raisedAt < 6000) return;
    guide.raisedAt = now;
    if (!this.guideShown) {
      this.guideShown = true;
      this.fx.callout(guide.x, guide.y - 14, 'THE STONE READS', '#7FE0C0', 5);
    }
    gameBus.emit('game:guideOpened', { at: now });
  }

  /**
   * What a chart buys. The first lights the centre; the second marks the next untouched stone in every cell
   * still ahead; the third dots the corridor itself from here to the end of the strip. Drawn with integers
   * on one graphics pen, from state the scene already holds, so the marking costs no allocation loop and no
   * tween that could outlive a pause.
   */
  private drawBeacons(): void {
    const pen = this.beaconPen;
    if (!pen) return;
    pen.clear();
    this.beaconMarks.pips = 0;
    this.beaconMarks.crumbs = 0;
    if (this.chartsFound <= 0 || this.destroyed) return;
    const jade = 0x7fe0c0;
    if (this.chartsFound >= 2) {
      for (let cell = this.cellNow(); cell < this.plan.chunkCount; cell += 1) {
        const next = this.plan.cells[cell]?.sites.find((site) => !this.strip.isSpent(site.id));
        if (!next) continue;
        const x = Math.round(next.fx * this.plan.cellWidth + next.chunk * this.plan.cellWidth);
        const y = Math.round(next.fy * this.plan.height);
        pen.fillStyle(jade, 0.85);
        pen.fillRect(x - 1, y - 15, 3, 3);
        pen.fillStyle(jade, 0.35);
        pen.fillRect(x - 3, y - 11, 7, 1);
        this.beaconMarks.pips += 1;
      }
    }
    if (this.chartsFound >= 3) {
      const points = (this.routePx ??= this.plan.route ?? stripRoute(this.plan));
      const lengths = (this.routeLens ??= routeLengths(points));
      if (points.length < 2) return;
      const mine = routeProjection(points, lengths, { x: this.player.x, y: this.player.y });
      for (let step = 1; step <= 8; step += 1) {
        const at = routeAtDistance(points, lengths, mine.at + step * 44);
        // The fade says "further along", and the last of the eight is still the far side of a bend, so the
        // floor of that fade has to stay above the ground's own noise. Measured off a screenshot, at the
        // shipped zoom, where a 2px dot at alpha 0.2 was simply gone.
        pen.fillStyle(jade, Math.max(0.42, 1 - step * 0.08));
        pen.fillRect(Math.round(at.x) - 1, Math.round(at.y) - 1, 3, 3);
        this.beaconMarks.crumbs += 1;
      }
    }
  }

  private markTheWay(): void {
    if (this.goalMark) this.goalMark.setVisible(this.chartsFound > 0);
    const words = ['THE CENTRE IS MARKED', 'THE STONES AHEAD ARE MARKED', 'THE WAY AHEAD IS DOTTED'];
    this.fx.callout(
      this.player.x,
      this.player.y - 16,
      words[Math.min(this.chartsFound, words.length) - 1],
      '#7FE0C0',
      7,
    );
    pulse('skill');
  }

  /**
   * Nothing ends a frame inside a circuit wall.
   *
   * Arcade resolves `vs walls` before `vs bodies`, so a mob that crowds the warden against the spine shoves
   * it *into* the stone and then holds it there: one frame of overlap becomes two, the warden walks out the
   * far side, and the labyrinth has a hole in it. Measured before this method existed: 90 of 90 frames with
   * the warden's centre inside a tooth while one mob leaned on it from the west. The walls therefore get the
   * last word, after every system that can move a body — the shallowest exit is taken, the velocity into the
   * wall is dropped (motion *along* it survives, so being pinned is not being frozen), and positions land on
   * whole pixels because this is pixel art.
   */
  private pressOutOfWalls(): void {
    if (!this.ground?.wallRects.length) return;
    const rects = this.ground.wallRects;
    const consider = (object: {
      body?: Phaser.Physics.Arcade.Body | Phaser.Physics.Arcade.StaticBody | null;
      x: number;
      y: number;
    }): void => {
      const physics = object.body;
      // Only dynamic bodies are ever shoved anywhere; a static one is the wall itself.
      if (!(physics instanceof Phaser.Physics.Arcade.Body) || !physics.enable) return;
      /*
       * Enough passes to clear the whole stack, because the exit of one rectangle can land inside its
       * neighbour. Two were fine on the strip, where a wall band is one rectangle thick; a brain's cleft is
       * five merged rows deep and a 10px body sitting on the seam between two of them had the push-out
       * choose *north* out of the lower row and *south* out of the upper one, forever — measured, not
       * guessed: the warden dropped in the middle of the division stayed there for eight frames at zero net
       * movement. Now the loop keeps pushing until a pass changes nothing, which for a body of any size is
       * "until it is out", and the walls genuinely do get the last word.
       */
      for (let pass = 0; pass < 12; pass += 1) {
        let moved = false;
        for (const rect of rects) {
          const left = physics.position.x;
          const right = left + physics.width;
          const top = physics.position.y;
          const bottom = top + physics.height;
          const outWest = right - rect.x;
          const outEast = rect.x + rect.w - left;
          const outNorth = bottom - rect.y;
          const outSouth = rect.y + rect.h - top;
          if (outWest <= 0.5 || outEast <= 0.5 || outNorth <= 0.5 || outSouth <= 0.5) continue;
          const shallowest = Math.min(outWest, outEast, outNorth, outSouth);
          const at = { x: object.x, y: object.y };
          const kept = physics.velocity;
          // The velocity *along* the wall survives; the one *into* it does not, so being pinned against the
          // spine still lets you slide to the crossing instead of sticking to it.
          let vx = kept.x;
          let vy = kept.y;
          let x = at.x;
          let y = at.y;
          if (shallowest === outWest) {
            x -= Math.ceil(shallowest);
            vx = Math.min(0, vx);
          } else if (shallowest === outEast) {
            x += Math.ceil(shallowest);
            vx = Math.max(0, vx);
          } else if (shallowest === outNorth) {
            y -= Math.ceil(shallowest);
            vy = Math.min(0, vy);
          } else {
            y += Math.ceil(shallowest);
            vy = Math.max(0, vy);
          }
          // `reset` places the *Game Object* and stops the body, so the kept half of the velocity goes back
          // on afterwards and the whole nudge lands on integer pixels.
          physics.reset(Math.round(x), Math.round(y));
          physics.velocity.set(vx, vy);
          moved = true;
          break;
        }
        if (!moved) return;
      }
    };
    consider(this.player);
    consider(this.ally);
    for (const child of this.enemies.getChildren() as Enemy[]) if (child.active) consider(child);
  }


  override update(_time: number, delta: number): void {
    if (this.destroyed) return;
    const ui = useUiStore.getState();
    const shouldFreeze =
      ui.paused || ui.deathOpen || ui.transition !== null || ui.summary !== null || isRunSubscreen(ui.screen);
    this.setFrozen(shouldFreeze);
    if (this.frozen) {
      this.fx.update(Math.min(delta, 32));
      this.hudTimer += delta;
      if (this.hudTimer > 100) this.publishSnapshot();
      return;
    }

    if (!this.warpArmed && this.time.now - this.lastWarpAt > DUNGEON.warp.rearmMs) {
      const stillOnAStone = this.stones.some(
        (stone) =>
          stone.site.kind === 'waypoint' &&
          Phaser.Math.Distance.Between(stone.x, stone.y, this.player.x, this.player.y) < 30,
      );
      if (!stillOnAStone) this.warpArmed = true;
    }
    // Off the network entirely: the dwell starts over, so a hop can never be paid for by a pause that
    // happened somewhere else on the map.
    if (this.warpDwellSince !== null) {
      const onOne = this.stones.some(
        (stone) =>
          stone.site.kind === 'waypoint' &&
          Phaser.Math.Distance.Between(stone.x, stone.y, this.player.x, this.player.y) < 30,
      );
      if (!onOne) this.warpDwellSince = null;
    }

    const dt = Math.min(delta, 50);
    this.tickRoamers();
    this.tickRunBuffs(dt);

    const input = this.inputManager.read(this.player.x, this.player.y, useSettingsStore.getState().autoAim);
    this.player.setInput(input);
    this.player.tick(dt);

    for (const child of this.enemies.getChildren() as Enemy[]) {
      if (child.active) child.tick(dt);
    }
    if (AUTO_CAST.enabled && this.player.alive) {
      this.autoCast.update(dt, this.player, {
        pickTarget: (from, radius) => this.findSupportTarget(from.x, from.y, radius),
        xpOf: this.xpOfElement,
        cast: (element, target, accuracy) => this.player.castSupport(element, target, accuracy),
      });
    }

    this.ally.tick(dt, this.allyView());
    this.playerProjectiles.step(dt, this.context);
    this.enemyProjectiles.step(dt, this.context);
    this.fields.update(dt, this.context);
    this.updatePickups(dt);
    this.strip.update(dt);
    this.strip.noteDepth(this.player.x);

    // The partner is in danger the same way the player is: standing next to something that hits.
    for (const child of this.enemies.getChildren() as Enemy[]) {
      const lockedUntil = this.allyHitAt.get(child) ?? 0;
      if (!child.active || this.time.now < lockedUntil) continue;
      if (Math.hypot(child.x - this.ally.x, child.y - this.ally.y) < 16) {
        this.ally.hurt(child.damage * dt * 0.001);
        this.allyHitAt.set(child, this.time.now + 420);
      }
    }

    this.syncCells();
    this.pressOutOfWalls();
    this.guide?.breathe(this.time.now);
    this.drawBeacons();
    this.fx.update(dt);

    this.syncCarryPips();
    if (this.goalMark?.visible) {
      // Breathing, driven by the run clock rather than a tween, so a pause stops it with everything
      // else instead of twinkling behind the card.
      this.goalMark.setAlpha(0.3 + 0.16 * Math.sin(this.time.now * 0.003));
    }
    if (!this.strip.endingReason && this.strip.stage(this.player.x, this.player.y).atCenter) {
      this.strip.finish('end');
    }

    this.hudTimer += dt;
    if (this.hudTimer >= 1000 / 12) {
      this.hudTimer = 0;
      this.publishSnapshot();
    }
  }

  /** The cell the camera is in decides props, music, enemy strength and which stones are drawn. */
  private syncCells(): void {
    const index = this.cellNow();
    this.ground.sync(this.player.x);
    if (index === this.cellIndex) return;
    this.cellIndex = index;
    const floor = this.floorAt(index);
    this.context.floor = floor;
    this.cameras.main.setBackgroundColor(floor.palette.bg);
    // The biome's own track, through the story scene's one music entry point — a strip that changed
    // floor and kept the same loop would be a lie about where you are.
    this.setupMusic(floor.id);
    this.buildStones(index);
    // Sprites from cells that are no longer near the camera go away; the stones themselves stay spent.
    for (const stone of [...this.stones]) {
      if (!this.siteInWindow(stone.site)) {
        stone.retire();
        this.stones.splice(this.stones.indexOf(stone), 1);
      }
    }
    this.stonesGroup();
    this.publishSnapshot(true);
  }

  /* ------------------------------------------------------------------ */
  /* Overrides that keep the save out of it                             */
  /* ------------------------------------------------------------------ */

  protected override addEssence(amount: number): void {
    if (amount <= 0) return;
    this.ledger += amount;
    // No `game:loot`: that event is what the save bridge listens to, and a strip run credits nothing.
  }

  protected override collectPickup(pickup: Pickup): void {
    // A chart is not a payout. It is intercepted here, before the ledger and before the base class's kind
    // switch, because `kind: 'shard'` is only what gave it a shape to have: walking over a map must credit
    // neither shards nor essence nor anything the save could keep. `audit:dungeonrun` diffs the ledger and
    // the wallet across all three collections to hold that line.
    if (pickup.defId === 'way_map') {
      pickup.retire();
      this.chartsFound += 1;
      this.markTheWay();
      return;
    }
    const def = getPickupDef(pickup.defId);
    if (!def) {
      pickup.retire();
      return;
    }
    switch (def.kind) {
      case 'health':
        this.player.heal(def.value);
        break;
      case 'energy':
        this.player.addEnergy(def.value);
        break;
      default:
        this.ledger += def.value || 1;
        break;
    }
    pickup.retire();
    this.publishSnapshot(true);
  }

  /**
   * The whole of the mode's self-containment, in one method: a strip earns no mastery, records no
   * element usage and therefore starts no achievement ticking. See `creditCastProgress` in the base.
   */
  protected override creditCastProgress(): void {
    /* deliberately nothing */
  }

  protected override onEnemyKilled(enemy: Enemy): void {
    // Deliberately narrower than the story version: no mastery, no statistics, no wallet.
    this.kills += 1;
    this.ledger += enemy.essenceValue;
    enemy.retire();
    this.publishSnapshot(true);
  }

  protected override onPlayerDamageDealt(amount: number, _isCrit: boolean, _isBoss: boolean): void {
    this.damageDealt += amount;
    this.bestHit = Math.max(this.bestHit, amount);
  }

  protected override onPlayerDeath(): void {
    pulse('death');
    this.strip.finish('death');
  }

  private finishRun(reason: 'end' | 'death'): void {
    if (this.reported) return;
    this.reported = true;
    const seconds = Math.max(1, Math.round((Date.now() - this.runStartedAt) / 1000));
    const left = this.strip.sitesLeft();
    const untouched = left.grove + left.cache + left.spring + left.field + left.den;
    useUiStore.getState().setPaused(true);
    useUiStore.getState().pushToast({
      title: reason === 'end' ? 'THE STRIP ENDS' : 'THE STRIP KEEPS YOU',
      body:
        `${this.strip.stage(this.player.x, this.player.y).atCenter ? 'Center reached' : `Line ${this.cellIndex + 1}`} · ${seconds}s · ${this.kills} felled · ` +
        `${untouched} stones untouched · ledger ${this.ledger} · best hit ${Math.round(this.bestHit)} · ` +
        `${this.shotsCountered} swatted · ` +
        `${this.strip.linkedCount}/${this.strip.waypoints.length} waystones linked, ${this.strip.warpCount} warped. ` +
        `Nothing is carried out — this run is its own record.`,
      color: reason === 'end' ? '#6BE39A' : '#FF5C6C',
    });
    this.fx.shake('heavy');
    audioEngine.stopMusic();
    gameBus.emit('game:dungeonEnded', {
      seed: this.run.seed ?? null,
      reason,
      seconds,
      kills: this.kills,
      ledger: this.ledger,
      cells: this.cellIndex + 1,
      partnerDown: this.ally.allyState === 'downed',
      // Warps are on the record. Nothing about the run is cheaper for having used them.
      warps: this.strip.warpCount,
      waystonesLinked: this.strip.linkedCount,
    });
    this.publishSnapshot(true);
  }

  /* ------------------------------------------------------------------ */
  /* Snapshot + teardown                                                */
  /* ------------------------------------------------------------------ */

  /**
   * The strip's read of the world. `force` exists for the inherited call sites and is ignored: this
   * publish is one small object merge, so there is nothing to skip by throttling it.
   */
  protected override publishSnapshot(force?: boolean): void {
    void force;
    const left = this.strip
      ? this.strip.sitesLeft()
      : { grove: 0, cache: 0, spring: 0, field: 0, den: 0, waypoint: 0 };
    const stage = this.strip
      ? this.strip.stage(this.player.x, this.player.y)
      : { cell: 0, line: 1, atCenter: false };
    useRunStore.getState().publish({
      ...EMPTY_SNAPSHOT,
      mode: 'story',
      runKind: 'strip',
      wave: stage.line,
      localWave: stage.line,
      floor: this.floorAt(stage.cell).id,
      floorName: this.floorAt(stage.cell).name,
      waveLabel: stage.atCenter ? 'CENTER' : `LINE ${stage.line}`,
      // The plate's denominator is the labyrinth's lines — one per circuit, plus the centre — not the
      // story's 200, and `wave` is the line the party is standing on.
      waveTotal: this.strip?.lines ?? this.plan.chunkCount + 1,
      stripAtCenter: stage.atCenter,
      enemiesRemaining: this.enemies.countActive(true),
      hp: Math.max(0, Math.round(this.player.hp)),
      maxHp: Math.round(this.player.maxHp),
      energy: Math.max(0, Math.round(this.player.energy)),
      maxEnergy: Math.round(this.player.maxEnergy),
      shield: Math.round(this.player.shield),
      dashReady: this.player.dashCooldownRatio,
      skillReady: this.player.skillCooldownRatio,
      ultimateReady: this.player.ultimateChargeRatio,
      slots: [...this.player.slots],
      activeSlot: this.player.activeSlot,
      auto: this.autoCast.summary(),
      activeElement: this.player.activeElement,
      essenceRun: this.ledger,
      shardsRun: this.shardsRun,
      enemyCount: this.enemies.countActive(true),
      statuses: this.player.statuses
        .indicators()
        .map((entry) => ({ id: entry.id, stacks: entry.stacks, ratio: entry.ratio, color: intToHex(entry.color) })),
      elapsedMs: this.runStartedAt ? Date.now() - this.runStartedAt : 0,
      playerAlive: this.player.alive,
      depth: Math.round((this.strip?.progress(this.player.x, this.player.y) ?? 0) * 100) / 100,
      sitesLeft: left,
      partner: {
        hp: Math.round(this.ally.hp),
        maxHp: Math.round(this.ally.maxHp),
        state: this.ally.allyState,
        carrying: this.ally.carrying,
      },
      stripCells: this.plan.cells.map((cell) => {
        const floor = this.floorAt(cell.index);
        const cleared = cell.sites.filter((site) => this.strip.isSpent(site.id)).length;
        const here = cell.index === this.cellNow();
        return {
          accent: floor.palette.accent,
          sites: cell.sites.length,
          cleared,
          here,
          goal: cell.index === this.plan.chunkCount - 1,
          // The cell's own corridor, flat [fx, fy] pairs, and the walker's place on it. Both in
          // fractions of *this* cell, so the HUD can fold them into a plan without knowing the strip.
          route: cell.circuit.route.flatMap((spot) => [spot.fx, spot.fy]),
          you: here
            ? {
                fx: (this.player.x - cell.index * this.plan.cellWidth) / this.plan.cellWidth,
                fy: this.player.y / this.plan.height,
              }
            : null,
        };
      }),
      fps: Math.round(this.game.loop.actualFps),
    });
  }

  protected override cleanup(): void {
    this.roamers.clear();
    this.nextRoamAt = 0;
    this.warpDwellSince = null;
    this.roamAnchor = null;
    this.roamTravel = 0;
    this.roamPrevious = null;
    this.stones.forEach((stone) => stone.retire());
    this.stones = [];
    this.allyStash.clear();
    this.carryPips.forEach((pip) => pip.destroy());
    this.carryPips.length = 0;
    this.goalMark?.destroy();
    this.goalMark = null;
    this.guide?.destroy();
    this.guide = null;
    this.beaconPen?.destroy();
    this.beaconPen = null;
    this.ground?.destroy();
    this.ally?.destroy();
    this.stoneGroup?.destroy(true, true);
    this.stoneGroup = null;
    setWorldFramePlanning(true);
    this.scale.off(Phaser.Scale.Events.RESIZE, this.handleStripResize, this);
    super.cleanup();
  }

  override get debugInfo(): {
    enemyCount: number;
    projectileCount: number;
    fieldCount: number;
    state: string;
    wave: number;
  } {
    return {
      enemyCount: this.enemies.countActive(true),
      projectileCount: this.playerProjectiles.count + this.enemyProjectiles.count,
      fieldCount: this.fields.activeCount,
      state: this.strip?.endingReason ?? `line ${this.strip?.stage(this.player.x, this.player.y).line ?? 1}`,
      wave: this.strip?.stage(this.player.x, this.player.y).line ?? this.cellIndex + 1,
    };
  }
}
