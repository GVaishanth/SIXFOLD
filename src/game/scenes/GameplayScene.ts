import Phaser from 'phaser';
import { ARENA, AUTO_CAST, CAMERA_CONFIG, DEBUG_CONFIG, DIFFICULTY, MASTERY, PICKUP_CONFIG, POOLS } from '@/config/gameConfig';
import { cameraOverscan, worldFrame } from '@/game/world/worldFrame';
import { getBoss } from '@/data/bosses';
import { ENEMY_REGISTRY } from '@/data/enemies';
import { ELEMENT_REGISTRY } from '@/data/elements';
import { ELEMENT_FAMILY } from '@/data/elements/palette';
import { openingDamageCapFraction, runWaveOf } from '@/game/systems/waveGenerator';
import { intToHex } from '@/utils/color';
import { pulse } from '@/utils/haptics';
import { FLOOR_REGISTRY, floorForWave } from '@/data/floors';
import { getDropTable, getPickupDef, rollTable } from '@/data/loot';
import { gameBus } from '@/game/systems/eventBus';
import { audioEngine, sfx } from '@/game/systems/audio';
import { FxSystem } from '@/game/systems/fx';
import { FieldManager } from '@/game/entities/Field';
import { HazardDirector, hazardBrief, hazardLabel } from '@/game/world/hazards';
import { Pickup } from '@/game/entities/Pickup';
import { Player } from '@/game/entities/Player';
import { Enemy } from '@/game/entities/Enemy';
import { Projectile, ProjectileManager, findNearest } from '@/game/entities/Projectile';
import { WaveDirector } from '@/game/systems/waveDirector';
import { AutoCastDirector } from '@/game/systems/autoCast';
import { computePlayerStats, liveRunBuffs } from '@/game/systems/statEngine';
import { Arena } from '@/game/world/arena';
import { hexToInt } from '@/utils/color';
import { InputManager } from '@/game/input/inputManager';
import { ensureDotTexture, ensurePortalTexture } from '@/game/textureFactory';
import { takeRunRequest, setRunRequest, type RunRequest } from '@/game/runRequest';
import { useRunStore } from '@/store/runStore';
import { useSaveStore } from '@/store/saveStore';
import { useSettingsStore } from '@/store/settingsStore';
import { isRunSubscreen, useUiStore } from '@/store/uiStore';
import type { CombatContext } from '@/game/combat/context';
import type { DamagePacket } from '@/game/combat/damage';
import type { DropTable, ElementId, GameMode, StatusApplication, VfxStyleId } from '@/types';
import { clamp, createRng } from '@/utils/math';

/**
 * GameplayScene — the simulation.
 *
 * Owns the arena, the player, every enemy, projectiles, fields, hazards and the
 * wave director. React never reaches into this scene directly: commands arrive
 * through the event bus and state flows back out through the run store and bus
 * events. That single boundary is what keeps React, Phaser and the save file
 * from drifting apart.
 */
/**
 * The story run.
 *
 * Several members are `protected` rather than `private` for one reason: `DungeonScene` reuses this
 * scene's combat glue — spawning, area damage, pickups, projectile hit handling, the freeze and settle
 * rules, teardown — instead of a second copy of them drifting away from the rules documented here
 * (mastery credit, the §B11/§B12 payout lanes, the §H4 zoom base). The visibility change is the whole
 * cost to this file; the dungeon overrides the parts that touch the save or the wave director, so a
 * self-contained mode cannot write progression.
 */
export class GameplayScene extends Phaser.Scene {
  protected arena!: Arena;
  protected player!: Player;
  protected enemies!: Phaser.Physics.Arcade.Group;
  protected pickups!: Phaser.Physics.Arcade.Group;
  /** The support half of the loadout: equipped elements that are not in hand. */
  protected autoCast = new AutoCastDirector();
  protected playerProjectiles!: ProjectileManager;
  protected enemyProjectiles!: ProjectileManager;
  protected fields!: FieldManager;
  protected fx!: FxSystem;
  protected director!: WaveDirector;
  protected inputManager!: InputManager;
  protected context!: CombatContext;

  protected run: RunRequest = { mode: 'story', startWave: 1 };
  private busDisposers: (() => void)[] = [];
  protected frozen = false;
  protected hudTimer = 0;
  /** Accumulator for the once-a-second run-buff prune (see `tickRunBuffs`). */
  protected buffTimer = 0;
  protected hazards: HazardDirector | null = null;
  protected hazardSprites: Phaser.GameObjects.Image[] = [];
  protected runStartedAt = 0;
  protected essenceRun = 0;
  protected shardsRun = 0;
  private waveAdvancePending = false;
  protected bossHandled = false;
  protected destroyed = false;

  /**
   * Registered under its own key by default; `DungeonScene` passes its key so it can inherit this
   * scene's behaviour without inheriting its identity.
   */
  constructor(key = 'GameplayScene') {
    super({ key });
  }

  create(): void {
    this.shotsCountered = 0;
    this.counterShown = false;
    const settings = useSettingsStore.getState();
    const save = useSaveStore.getState();
    const request = takeRunRequest() ?? { mode: 'story', startWave: 1 };
    this.run = request;
    this.runStartedAt = Date.now();
    this.essenceRun = 0;
    this.buffTimer = 0;
    this.shardsRun = 0;
    this.bossHandled = false;
    this.destroyed = false;
    this.waveAdvancePending = false;

    // Saved buffs speak the previous scene's clock; make them speak this one's before
    // anything derives stats from them (docs/STATS_GAMEPLAY_FAULTS.md §A3).
    save.rebaseRunBuffs(this.time.now);
    const data = useSaveStore.getState().data;
    const activeSlot = data?.loadout.activeSlot ?? 0;
    const activeElement = data?.loadout.slots[activeSlot] ?? data?.profile.starter ?? 'fire';
    const stats = computePlayerStats(data, activeElement, liveRunBuffs(data, this.time.now));

    const floorNumber =
      request.floorOverride ?? floorForWave(request.startWave > 200 ? (((request.startWave - 1) % 200) + 1) : request.startWave);
    const floor = FLOOR_REGISTRY[floorNumber] ?? FLOOR_REGISTRY[1];

    ensureDotTexture(this);
    ensurePortalTexture(this);

    this.arena = new Arena(this, floor, settings.graphicsQuality);

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

    this.player = new Player(
      this,
      worldFrame.width / 2,
      worldFrame.height / 2,
      stats,
      (data?.loadout.slots[activeSlot] ?? activeElement) as ElementId,
    );
    if (data) {
      this.player.setLoadout(data.loadout.slots, data.loadout.activeSlot);
      this.autoCast.setLoadout(data.loadout.slots, data.loadout.activeSlot, this.xpOfElement);
    }
    /*
     * Save & exit is not a free heal. The record is read once, here, and only honoured for
     * the run that wrote it (same mode, same starting wave); it is dropped either way, so a
     * death, a checkpoint restart or a second CONTINUE cannot reuse an old wound.
     */
    if (data?.resumeRun) {
      const resume = data.resumeRun;
      if (resume.mode === request.mode && resume.wave === request.startWave) {
        this.player.beginAtHp(resume.hp);
      }
      save.clearResumeRun();
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

    this.context = {
      scene: this,
      fx: this.fx,
      camera: this.cameras.main,
      player: this.player,
      enemies: this.enemies,
      playerProjectiles: this.playerProjectiles,
      enemyProjectiles: this.enemyProjectiles,
      fields: this.fields,
      floor,
      scaling: {
        hpMult: 1,
        damageMult: 1,
        speedMult: 1,
        eliteChance: 0,
        affixChance: 0,
        affixes: [],
      },
      spawnEnemy: (defId, x, y, options) => this.spawnEnemy(defId, x, y, options),
      spawnPortal: (x, y, color) => this.spawnPortal(x, y, color),
      spawnPickup: (id, x, y, value) => this.spawnPickup(id, x, y, value),
      rollDropTable: (table, x, y, bonus) => this.rollDropTable(table, x, y, bonus),
      addEssence: (amount) => this.addEssence(amount),
      addShards: (amount) => {
        this.shardsRun += amount;
      },
      onEnemyKilled: (enemy) => this.onEnemyKilled(enemy),
      onBossPhase: (enemy, index, banner) => this.onBossPhase(enemy, index, banner),
      onBossTelegraph: () => undefined,
      damageArea: (config) => this.damageArea(config),
      eruption: (config) => this.eruption(config),
      hitSparkAt: (x, y, color, power, vfx, family) => this.fx.hitSpark(x, y, color, power, vfx, family),
      addHazardBurst: (x, y, radius, damage, color, element, statuses) =>
        this.addHazardBurst(x, y, radius, damage, color, element, statuses),
      telegraph: (x, y, radius, color, durationMs) => this.telegraph(x, y, radius, color, durationMs),
      addField: (config) => this.fields.add(config),
      audioEnabled: true,
    };
    this.player.setContext(this.context);

    this.director = new WaveDirector(this.context, {
      onStateChange: (state, wave) => {
        this.publishSnapshot(true);
        if (state === 'idle' && wave === this.director.currentSpec?.wave) {
          this.queueNextWave();
        }
      },
      onWaveCleared: (spec, essence) => this.onWaveCleared(spec.wave, spec.floor, essence),
      onBossSpawn: (enemy) => this.onBossSpawn(enemy),
      onBossDefeated: (enemy) => this.onBossDefeated(enemy),
      onFloorCleared: (floorNumber) => this.onFloorCleared(floorNumber),
      onStoryComplete: () => this.onStoryComplete(),
    });

    this.hazards = new HazardDirector(this.context, floor.hazard.kind, {
      // Mines and crystal walls need persistent bodies, so the director decides
      // when they appear and the scene builds them.
      spawnMine: (x, y, damage, color) => this.spawnMine(x, y, damage, color),
      spawnWall: (color, damage) => this.spawnCrystalWall(color, damage),
    });

    this.inputManager = new InputManager(this, {
      onPause: () => {
        const ui = useUiStore.getState();
        if (ui.deathOpen || ui.transition) return;
        // Escape belongs to whichever full-screen menu is up. It used to toggle the
        // pause flag instead, so leaving the skill tree or the loadout dropped the
        // player straight into a running simulation they thought was still frozen.
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

    this.registerPhysicsOverlaps();
    this.registerBusCommands();
    this.setupCamera();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.onFrameResize, this);
    this.setupMusic(floorNumber);

    const mode: GameMode = request.mode;
    this.director.begin(request.startWave, mode, request.floorOverride, request.difficultyScale ?? 1);

    gameBus.emit('game:runStarted', {
      mode,
      wave: request.startWave,
      floor: floorNumber,
      floorName: floor.name,
    });

    this.publishSnapshot(true);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.cleanup());
    this.scene.launch('PauseScene');
  }

  /**
   * A frame change can resize the field under a live run — a phone turning
   * upright narrows the arena so actors stay legible — so the camera bounds and
   * anything standing outside the new walls have to follow it. Entities are
   * pulled back inside rather than dropped: a wave does not reset because
   * somebody rotated their device.
   */
  protected onFrameResize = (): void => {
    // Re-fitting the buffer re-anchors the punch base too: the base is the camera zoom the
    // frame was sized for, and a punch must return to that, not to a stale value.
    this.fx?.settle();
    const overscan = cameraOverscan();
    this.cameras.main.setBounds(0, -overscan, worldFrame.width, worldFrame.height + overscan * 2);
    this.cameras.main.setFollowOffset(0, overscan > 0 ? -Math.round(overscan * ARENA.handheldBias) : 0);
    const inset = ARENA.wall + ARENA.padding;
    const inside = (sprite: Phaser.Physics.Arcade.Sprite): void => {
      if (!sprite?.active) return;
      sprite.x = Phaser.Math.Clamp(sprite.x, inset, worldFrame.width - inset);
      sprite.y = Phaser.Math.Clamp(sprite.y, inset, worldFrame.height - inset);
    };
    inside(this.player);
    for (const child of this.enemies.getChildren() as Enemy[]) inside(child);
  };

  protected setupCamera(): void {
    const camera = this.cameras.main;
    // See `cameraOverscan`: the bounds reach past the walls so the control pads
    // never sit on top of the floor, and the focus is nudged down so the warden
    // reads in the upper third of a tall frame instead of dead centre.
    const overscan = cameraOverscan();
    camera.setBounds(0, -overscan, worldFrame.width, worldFrame.height + overscan * 2);
    camera.setRoundPixels(true);
    camera.setZoom(1);
    // The fx system punches the camera for crits; it needs to know the zoom this frame was
    // fitted with so every punch lands back here instead of wherever the camera had got to.
    this.fx.setBaseZoom(1);
    camera.startFollow(this.player, true, CAMERA_CONFIG.followLerp, CAMERA_CONFIG.followLerp);
    if (overscan > 0) camera.setFollowOffset(0, -Math.round(overscan * ARENA.handheldBias));
    camera.setBackgroundColor(this.arena.floor.palette.bg);
    camera.fadeIn(280, 0, 0, 0);
  }

  protected setupMusic(floorNumber: number): void {
    const floor = FLOOR_REGISTRY[floorNumber] ?? FLOOR_REGISTRY[1];
    audioEngine.unlock();
    audioEngine.startMusic({
      key: `${floor.music.key}_${this.run.mode}`,
      bpm: floor.music.bpm,
      scale: floor.music.scale,
      root: floor.music.root,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Bus commands                                                        */
  /* ------------------------------------------------------------------ */

  protected registerBusCommands(): void {
    const on = <K extends Parameters<typeof gameBus.on>[0]>(
      event: K,
      handler: Parameters<typeof gameBus.on<K>>[1],
    ) => {
      this.busDisposers.push(gameBus.on(event, handler));
    };

    on('command:switchElement', ({ slot }) => this.switchElement(slot));

    // §29: the world half of an unlock. A short hit-stop gives the card time to
    // register without freezing the sim, and the ring fires from the warden so the
    // moment has a place on screen, not just a panel over it.
    on('game:elementUnlocked', ({ element }) => {
      const def = ELEMENT_REGISTRY[element as ElementId];
      const player = this.player;
      // While a menu, pause, death or transition has the frame, the world stays
      // out of it: a hit-stop's restore would be stranded in a paused clock.
      if (!def || !player || this.frozen) return;
      this.fx.hitStop(180);
      this.fx.ring(player.x, player.y, def.colorInt, 54, 0.55, 2);
      this.fx.callout(player.x, player.y - 30, def.name.toUpperCase(), def.color);
    });
    on('command:cycleElement', ({ direction }) => this.player.cycleElement(direction));
    on('command:useSkill', () => this.player.useSkill());
    on('command:useUltimate', () => this.player.useUltimate());
    on('command:dash', () => this.player.performDash());
    on('command:setMovement', ({ x, y }) => this.inputManager.setTouchMovement(x, y));
    on('command:setAttack', ({ held }) => this.inputManager.setTouchButtons({ attack: held }));
    on('command:respawn', () => this.respawnAtCheckpoint());
    on('command:restartRun', (payload) => this.restartRun(payload));
    on('command:setLoadout', ({ slots, activeSlot }) => {
      this.player.setLoadout(slots as (ElementId | null)[], activeSlot);
      this.refreshPlayerStats();
    });
    // Developer-only affordances: stripped from production builds because the
    // whole branch is removed when DEBUG_CONFIG.enabled folds to false.
    if (DEBUG_CONFIG.enabled) {
      on('command:grantCheat', (payload) => {
        if (payload?.hp) this.player.heal(payload.hp);
        if (payload?.energy) this.player.addEnergy(payload.energy);
        if (payload?.killAll) this.director?.killAll();
        if (payload?.nextWave) this.forceNextWave();
      });
    }
  }

  protected switchElement(slot: number): void {
    const switched = this.player.switchElement(slot);
    if (switched) {
      this.refreshPlayerStats();
      // Switching is a small, deliberate investment now that the rate lives in
      // MASTERY.xpPerSwitch instead of a literal half-XP in the scene.
      this.creditCastProgress('switch', this.player.activeElement);
    }
  }

  protected refreshPlayerStats(): void {
    const data = useSaveStore.getState().data;
    const active = this.player.activeElement;
    const stats = computePlayerStats(data, active, liveRunBuffs(data, this.time.now));
    this.player.applyStats(stats);
    // Support elements are whatever is equipped but not in hand, so the rig rides
    // the same funnel that recomputes stats: a loadout edit, a manual switch and a
    // mid-run unlock all keep it honest without a second place to remember.
    this.autoCast.setLoadout(this.player.slots, this.player.activeSlot, this.xpOfElement);
    this.publishSnapshot(true);
  }

  /**
   * Run buffs are stored in the save, so they cannot be timed by a per-frame write.
   * Instead the scene counts a second of *unfrozen* time, and only when a buff has
   * actually lapsed does it touch the store — a single prune that also re-derives the
   * stats. Expiry itself never waits for this: `liveRunBuffs` filters on the live clock,
   * so a lapsed buff stops counting on the next recompute even if the prune is late.
   */
  protected tickRunBuffs(dt: number): void {
    this.buffTimer += dt;
    if (this.buffTimer < 1000) return;
    this.buffTimer = 0;
    const save = useSaveStore.getState();
    const data = save.data;
    if (!data || data.runBuffs.length === 0) return;
    const now = this.time.now;
    const expired = data.runBuffs.some((buff) => buff.expiresAt <= now);
    if (expired) {
      save.mutate((draft) => {
        draft.runBuffs = draft.runBuffs.filter((buff) => buff.expiresAt > now);
      });
      this.refreshPlayerStats();
      return;
    }
    // Still live: keep the reported countdown honest for anything that shows it.
    save.mutate((draft) => {
      for (const buff of draft.runBuffs) buff.remaining = Math.max(0, (buff.expiresAt - now) / 1000);
    });
  }

  /** Mastery XP is the accuracy currency: same source the loadout screen quotes. */
  protected xpOfElement = (element: ElementId): number =>
    useSaveStore.getState().data?.mastery[element]?.xp ?? 0;

  /**
   * Nearest living target for a support cast, with bosses and elites weighted up
   * so an unattended element spends its shots where they matter. The player's own
   * aim is untouched: this only answers for elements nobody is steering.
   */
  protected findSupportTarget(x: number, y: number, radius: number): { x: number; y: number } | null {
    let best: Enemy | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const child of this.enemies.getChildren() as Enemy[]) {
      if (!child.active || child.hp <= 0) continue;
      const distance = Phaser.Math.Distance.Between(x, y, child.x, child.y);
      if (distance > radius) continue;
      const priority = child.rank === 'boss' ? 0.55 : child.rank === 'elite' ? 0.8 : 1;
      const score = distance * priority;
      if (score >= bestScore) continue;
      bestScore = score;
      best = child;
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  /* ------------------------------------------------------------------ */
  /* Physics wiring                                                      */
  /* ------------------------------------------------------------------ */

  protected registerPhysicsOverlaps(): void {
    this.physics.add.collider(this.enemies, this.enemies);
    this.physics.add.collider(this.enemies, this.player);
    this.physics.add.collider(this.pickups, this.pickups);

    this.physics.add.overlap(this.playerProjectiles.group, this.enemies, (projectileObj, enemyObj) => {
      const projectile = projectileObj as unknown as Projectile;
      const enemy = enemyObj as unknown as Enemy;
      if (!projectile.active || !enemy.active) return;
      this.handleProjectileHitEnemy(projectile, enemy);
    });

    // Arcade runs a Group-vs-Sprite overlap sprite-first internally, so the
    // callback receives (player, projectile) even though the group was declared
    // first. Keep the parameter order in sync with that.
    this.physics.add.overlap(this.enemyProjectiles.group, this.player, (_playerObj, projectileObj) => {
      const projectile = projectileObj as unknown as Projectile;
      if (!projectile || !projectile.active || !this.player.alive) return;
      this.handleProjectileHitPlayer(projectile);
    });

    /* --- countering: a shot of yours answers a shot of theirs, in the air ------------------------- */
    // Ranged hostility used to be answerable only by the one element whose shard cuts bolts, which made the
    // fight a loadout question rather than an aim one. Now anything you fire can intercept anything they
    // fire — and the *rule* is the trade: your bolt is spent with theirs, so standing still and spraying
    // never becomes a shield. The exception is a bolt built to keep going (`destroysEnemyProjectiles`: the
    // crystal shard, and the ultimate), whose pierce carries through the swap. That flag used to mean "may
    // counter"; it now means "counters for free", which is the only reason to keep it.
    this.physics.add.overlap(this.playerProjectiles.group, this.enemyProjectiles.group, (a, b) => {
      const playerShot = a as unknown as Projectile;
      const enemyShot = b as unknown as Projectile;
      if (!playerShot.active || !enemyShot.active) return;
      this.enemyProjectiles.release(enemyShot);
      const carried = playerShot.destroysEnemyProjectiles;
      if (!carried) this.playerProjectiles.release(playerShot);
      this.onCounter(playerShot, enemyShot, carried);
    });

    this.physics.add.overlap(this.pickups, this.player, (_playerObj, pickupObj) => {
      const pickup = pickupObj as unknown as Pickup;
      if (pickup.active) this.collectPickup(pickup);
    });

    this.physics.add.overlap(this.enemies, this.player, (_playerObj, enemyObj) => {
      const enemy = enemyObj as unknown as Enemy;
      if (!enemy.active || !this.player.alive) return;
      if (enemy.def.archetype !== 'chaser' && enemy.def.archetype !== 'splitter' && enemy.def.archetype !== 'tank') {
        return;
      }
      this.player.contactDamage(
        enemy.damage * 0.6,
        enemy.x,
        enemy.y,
        enemy.def.onHitStatuses ?? [],
      );
    });
  }

  protected handleProjectileHitEnemy(projectile: Projectile, enemy: Enemy): void {
    if (!projectile.registerHit(enemy as unknown as number & Enemy)) return;
    const packet = projectile.toDamagePacket();
    const result = enemy.takeDamage(packet);
    if (result.dealt > 0) this.player.onDealtDamage(result.dealt, packet.isCrit, enemy.isBoss, packet.auto ?? false);

    // Chain lightning hops.
    if (projectile.chainCount > 0) {
      const candidates = (this.enemies.getChildren() as Enemy[]).filter(
        (candidate) => candidate.active && candidate !== enemy,
      );
      const next = findNearest(candidates, enemy.x, enemy.y, 96);
      if (next) {
        this.fx.hitSpark(next.x, next.y, projectile.colorInt, 1, 'bolt');
        const chainPacket: DamagePacket = {
          ...packet,
          amount: packet.amount * 0.7,
          knockback: 0,
        };
        const chainResult = next.takeDamage(chainPacket);
        // Same crit/auto verdict as the shot that chained: the hop is the same cast,
        // so it must not silently become a fresh non-crit that pays out energy.
        if (chainResult.dealt > 0)
          this.player.onDealtDamage(chainResult.dealt, chainPacket.isCrit, next.isBoss, chainPacket.auto ?? false);
        if (projectile.chainCount > 1) {
          const hop = this.playerProjectiles.fire({
            x: next.x,
            y: next.y,
            angle: Math.atan2(enemy.y - next.y, enemy.x - next.x),
            speed: 260,
            damage: packet.amount * 0.7,
            isCrit: packet.isCrit,
            auto: projectile.auto,
            owner: 'player',
            element: projectile.element,
            vfx: 'bolt',
            color: projectile.colorInt,
            radius: 2.5,
            lifetime: 0.35,
            pierce: 0,
            chain: projectile.chainCount - 1,
            homing: 0.4,
            knockback: 0,
            statuses: [],
            explodeRadius: 0,
            explodeDamageMult: 1,
            destroysEnemyProjectiles: false,
            boomerang: false,
          });
          void hop;
        }
      }
    }

    if (projectile.pierce > 0) {
      projectile.pierce -= 1;
    } else {
      this.playerProjectiles.release(projectile);
    }
  }

  protected handleProjectileHitPlayer(projectile: Projectile): void {
    if (!this.playerProjectiles) return;
    this.enemyProjectiles.release(projectile);
    this.player.takeDamage(projectile.toDamagePacket());
  }

  /* ------------------------------------------------------------------ */
  /* Spawning + loot                                                     */
  /* ------------------------------------------------------------------ */

  protected spawnEnemy(
    defId: string,
    x: number,
    y: number,
    options?: {
      rank?: 'normal' | 'elite' | 'boss' | 'miniboss';
      elite?: boolean;
      affixes?: string[];
      portal?: boolean;
    },
  ): Enemy | null {
    const bossDef = getBoss(defId);
    const def = ENEMY_REGISTRY[defId];
    if (!bossDef && !def) return null;

    let enemy = this.enemies.getFirstDead(false) as Enemy | null;
    if (!enemy) {
      if (this.enemies.getLength() >= this.enemies.maxSize) return null;
      enemy = new Enemy(this, x, y);
      this.enemies.add(enemy, true);
    }
    enemy.setContext(this.context);

    if (bossDef) {
      // Bosses have much larger base pools than trash mobs, so they take the
      // square root of the wave HP multiplier: fights lengthen steadily across
      // the story without turning into damage-sponge walls in the late game.
      const bossHpMult = Math.pow(this.context.scaling.hpMult, 0.5) * 1.15;
      enemy.spawn(
        {
          def: ENEMY_REGISTRY[bossDef.minionDefId ?? 'cinder_chaser'] ?? ENEMY_REGISTRY.cinder_chaser,
          rank: options?.rank ?? (bossDef.rank === 'major' ? 'boss' : 'miniboss'),
          affixes: (options?.affixes ?? []) as never,
          hpMult: bossHpMult,
          damageMult: this.context.scaling.damageMult,
          speedMult: this.context.scaling.speedMult,
          scale: 1.6,
          damageCap: DIFFICULTY.damageCapBaseHp * DIFFICULTY.bossDamageCapFraction,
          damageCapKnee: DIFFICULTY.damageCapSoftKnee,
          boss: bossDef,
        },
        x,
        y,
      );
    } else {
      if (!def) return null;
      const rank = options?.rank ?? (options?.elite ? 'elite' : 'normal');
      const affixes = (options?.affixes ?? []) as never[];
      enemy.spawn(
        {
          def,
          rank,
          affixes,
          hpMult: this.context.scaling.hpMult * (rank === 'elite' ? 1.6 : 1),
          damageMult: this.context.scaling.damageMult * (rank === 'elite' ? 1.2 : 1),
          speedMult: this.context.scaling.speedMult,
          // Measured against the base warden, not this player's pool: an HP upgrade
          // must not hand every mob a bigger number (docs §A4).
          damageCap:
            DIFFICULTY.damageCapBaseHp *
            // `?.` because DungeonScene has no wave director: the cap still reads correctly, at the
            // opening value, and a spawned enemy must not be able to throw a whole frame away.
            openingDamageCapFraction(runWaveOf(this.context.floor.id, this.director?.currentSpec?.localWave ?? 1)),
          damageCapKnee: DIFFICULTY.damageCapSoftKnee,
          scale: 1,
        },
        x,
        y,
      );
    }

    if (options?.portal) {
      this.fx.ring(x, y, this.context.floor.palette.portal ? parseInt(this.context.floor.palette.portal.replace('#', ''), 16) : 0xffffff, 22, 0.45);
    }
    return enemy;
  }

  protected spawnPortal(x: number, y: number, color: number): void {
    const sprite = this.add.image(x, y, 'fx_portal').setDepth(18).setTint(color).setBlendMode(Phaser.BlendModes.ADD);
    sprite.setAlpha(0.2).setScale(1.4);
    this.tweens.add({ targets: sprite, alpha: 0.9, duration: 260, yoyo: true, onComplete: () => sprite.destroy() });
  }

  /**
   * `scatter` is a knob rather than a rule: drops from a corpse fly outward, and an object the generator
   * *placed* on a route must stay exactly where it was put. The return value exists for the same reason —
   * a placed pickup needs one property set after the pool hands it out, and reaching back into the group
   * for it would be a guess about which child is which.
   */
  /** Ranged attacks swatted out of the air this run. Reset in `create`, because a scene is restarted. */
  shotsCountered = 0;
  private counterShown = false;

  /**
   * The one piece of feedback a counter gets: a spark where the two bolts met, a ring if yours survived
   * it, and the rule stated once per run so nobody has to discover the cost by losing a shot they wanted.
   * No currency, no score: the reward for a counter is the hit you did not take.
   */
  protected onCounter(playerShot: Projectile, enemyShot: Projectile, carried: boolean): void {
    const x = Math.round((playerShot.x + enemyShot.x) / 2);
    const y = Math.round((playerShot.y + enemyShot.y) / 2);
    this.fx.hitSpark(x, y, enemyShot.colorInt, 0.85, 'metal');
    if (carried) this.fx.ring(x, y, playerShot.colorInt, 13, 0.35);
    sfx('crit', { rate: 1.35 });
    this.shotsCountered += 1;
    const run = useSaveStore.getState().run;
    if (run) run.shotsCountered += 1;
    useSaveStore.getState().mutate((draft) => {
      draft.stats.projectilesCountered += 1;
    });
    if (!this.counterShown) {
      this.counterShown = true;
      this.fx.callout(x, y - 14, carried ? 'COUNTERED · BOLT KEPT' : 'COUNTERED · BOLT SPENT', '#F2C96B', 6);
    }
  }

  protected spawnPickup(id: string, x: number, y: number, value?: number, placed = false): Pickup | null {
    const def = getPickupDef(id);
    if (!def) return null;
    const activePickups = this.pickups.countActive(true);
    if (activePickups >= POOLS.pickups) return null;
    let pickup = this.pickups.getFirstDead(false) as Pickup | null;
    if (!pickup) {
      if (this.pickups.getLength() >= this.pickups.maxSize) return null;
      pickup = new Pickup(this, x, y);
      this.pickups.add(pickup, true);
    }
    // A placed prop is pinned where the mode authored it; everything the arena drops keeps scattering.
    pickup.spawn(def, value ?? def.value, x, y, !placed);
    pickup.placed = placed;
    return pickup;
  }

  /** Spawns the pile; the roll itself is `rollTable`, so the dungeon's caches obey the same rules. */
  protected rollDropTable(table: DropTable, x: number, y: number, bonus = 1): void {
    for (const drop of rollTable(table, createRng(Math.floor(Math.random() * 1_000_000)), bonus)) {
      for (let i = 0; i < drop.count; i += 1) {
        this.spawnPickup(drop.id, x, y);
      }
    }
  }

  protected collectPickup(pickup: Pickup): void {
    const def = getPickupDef(pickup.defId);
    if (!def) {
      pickup.retire();
      return;
    }
    const element = this.player.activeElement;
    const color = element ? ELEMENT_REGISTRY[element].colorInt : 0xf2c96b;
    switch (def.kind) {
      case 'health': {
        const value = def.value * (this.run.mode === 'ascension' ? 0.94 : 1);
        const gained = this.player.heal(value);
        if (gained < value * 0.5) this.refundOrb(pickup, def.value, 'FULL');
        break;
      }
      case 'energy': {
        const gained = this.player.addEnergy(def.value);
        if (gained < def.value * 0.5) this.refundOrb(pickup, def.value, 'FULL');
        break;
      }
      case 'essence':
        this.essenceRun += def.value;
        gameBus.emit('game:loot', { id: def.id, amount: def.value, kind: 'essence' });
        break;
      case 'shard':
        this.shardsRun += def.value;
        gameBus.emit('game:loot', { id: def.id, amount: def.value, kind: 'shard' });
        break;
      case 'relic':
        gameBus.emit('game:loot', { id: def.id, amount: 1, kind: 'relic' });
        break;
      case 'buff': {
        const data = useSaveStore.getState().data;
        if (data && def.buff) {
          const buff = def.buff;
          /* A buff is a window, not an asset. The entry carries the clock value it
             stops applying at, and the stack is capped at PICKUP_CONFIG.maxBuffs by
             dropping the oldest — previously `remaining` was written and then ignored,
             so every buff survived the run, the save and the reload, compounding
             forever (docs/STATS_GAMEPLAY_FAULTS.md §A3). */
          const expiresAt = this.time.now + Math.max(1, buff.duration) * 1000;
          useSaveStore.getState().mutate((draft) => {
            draft.runBuffs = [
              ...draft.runBuffs,
              {
                id: buff.id,
                name: buff.name,
                remaining: Math.max(1, buff.duration),
                expiresAt,
                magnitude: buff.magnitude,
                stat: buff.stat,
              },
            ].slice(-PICKUP_CONFIG.maxBuffs);
          }, { immediate: true });
          this.refreshPlayerStats();
        }
        gameBus.emit('game:loot', { id: def.id, amount: 1, kind: 'buff' });
        break;
      }
      default:
        break;
    }
    this.fx.hitSpark(pickup.x, pickup.y, def.colorInt, 0.6, 'spark');
    sfx('pickup', { rate: 0.9 + Math.random() * 0.3 });
    void color;
    pickup.retire();
  }

  /**
   * An orb collected at a full bar used to vanish: `heal`/`addEnergy` return early
   * when there is nothing to restore, and the pickup was retired anyway — a reward
   * deleted by the game's own generosity (and the wave-end gather made it automatic).
   * Full-bar orbs now convert to essence at half value, so the drop always means
   * something without paying full price for a free pickup.
   */
  protected refundOrb(pickup: Pickup, value: number, label: string): void {
    const refund = Math.max(1, Math.round(value / 2));
    this.essenceRun += refund;
    gameBus.emit('game:loot', { id: 'essence_orb', amount: refund, kind: 'essence' });
    this.fx.callout(pickup.x, pickup.y - 8, `${label} → ESSENCE`, '#F2C96B', 6);
  }

  protected addEssence(amount: number): void {
    if (amount <= 0) return;
    this.essenceRun += amount;
    gameBus.emit('game:loot', { id: 'essence_orb', amount, kind: 'essence' });
  }

  /* ------------------------------------------------------------------ */
  /* Damage helpers                                                      */
  /* ------------------------------------------------------------------ */

  protected damageArea(config: {
    x: number;
    y: number;
    radius: number;
    damage: number;
    element: string | null;
    vfx: VfxStyleId;
    color: number;
    statuses?: StatusApplication[];
    knockback?: number;
    friendly: boolean;
    isCrit?: boolean;
    /** A support rig's cast — pays no energy and no lifesteal. */
    auto?: boolean;
    maxTargets?: number;
  }): number {
    let hits = 0;
    const knockback = config.knockback ?? 0;

    if (config.friendly) {
      for (const child of this.enemies.getChildren() as Enemy[]) {
        if (!child.active) continue;
        const distance = Phaser.Math.Distance.Between(config.x, config.y, child.x, child.y);
        if (distance > config.radius + 6) continue;
        const falloff = 1 - clamp(distance / (config.radius + 6), 0, 1) * 0.35;
        const packet: DamagePacket = {
          amount: config.damage * falloff,
          isCrit: config.isCrit ?? false,
          element: (config.element as ElementId) ?? null,
          vfx: config.vfx,
          damageType: 'elemental',
          statuses: config.statuses ?? [],
          knockback,
          source: 'player',
          sourceX: config.x,
          sourceY: config.y,
          auto: config.auto ?? false,
        };
        const result = child.takeDamage(packet);
        if (result.dealt > 0) this.player.onDealtDamage(result.dealt, packet.isCrit, child.isBoss, packet.auto ?? false);
        hits += 1;
        if (config.maxTargets && hits >= config.maxTargets) break;
      }
    } else {
      const distance = Phaser.Math.Distance.Between(config.x, config.y, this.player.x, this.player.y);
      if (distance <= config.radius + 6 && this.player.alive) {
        this.player.takeDamage({
          amount: config.damage,
          isCrit: false,
          element: (config.element as ElementId) ?? null,
          vfx: config.vfx,
          damageType: 'elemental',
          statuses: config.statuses ?? [],
          knockback,
          source: 'boss',
          sourceX: config.x,
          sourceY: config.y,
        });
        hits += 1;
      }
    }
    return hits;
  }

  protected eruption(config: {
    count: number;
    radius: number;
    spread: number;
    damage: number;
    element: string | null;
    vfx: VfxStyleId;
    color: number;
    statuses?: StatusApplication[];
    knockback?: number;
    origin: { x: number; y: number };
    aimAngle: number;
    followPlayer: boolean;
    telegraphMs?: number;
    delayMs?: number;
  }): void {
    const bounds = this.physics.world.bounds;
    for (let i = 0; i < config.count; i += 1) {
      const delay = i * (config.delayMs ?? 200);
      this.time.delayedCall(delay, () => {
        let x: number;
        let y: number;
        if (config.followPlayer) {
          x = this.player.x + (Math.random() - 0.5) * 120;
          y = this.player.y + (Math.random() - 0.5) * 120;
        } else {
          const spread = Phaser.Math.DegToRad(config.spread);
          const angle = config.aimAngle - spread / 2 + (spread / Math.max(1, config.count - 1)) * i;
          const distance = 34 + Math.random() * 70;
          x = config.origin.x + Math.cos(angle) * distance;
          y = config.origin.y + Math.sin(angle) * distance;
        }
        x = clamp(x, bounds.x + 12, bounds.right - 12);
        y = clamp(y, bounds.y + 12, bounds.bottom - 12);
        this.telegraph(x, y, config.radius, config.color, config.telegraphMs ?? 480);
        this.time.delayedCall(config.telegraphMs ?? 480, () => {
          this.fx.ring(x, y, config.color, config.radius, 0.5, 1.5);
          this.fx.hitSpark(x, y, config.color, 1.6, config.vfx);
          this.damageArea({
            x,
            y,
            radius: config.radius,
            damage: config.damage,
            element: config.element,
            vfx: config.vfx,
            color: config.color,
            statuses: config.statuses,
            knockback: config.knockback ?? 0,
            friendly: config.element !== null && !this.isEnemyElement(config.element),
          });
        });
      });
    }
  }

  /** Eruption abilities are player-sourced unless the source was an enemy. */
  protected isEnemyElement(_element: string): boolean {
    return false;
  }

  protected telegraph(x: number, y: number, radius: number, color: number, durationMs: number): void {
    const ring = this.add.image(Math.round(x), Math.round(y), 'fx_ring').setDepth(16);
    ring.setTint(color);
    ring.setAlpha(0.55);
    ring.setScale((radius * 2) / 16);
    this.tweens.add({
      targets: ring,
      alpha: 0.15,
      duration: durationMs,
      onComplete: () => ring.destroy(),
    });
  }

  /**
   * A hazard's payoff. The caller has already telegraphed it, so this lands
   * immediately — and it lands on both sides: a crack in the floor is only a
   * decision if you can spend it on something chasing you.
   */
  protected addHazardBurst(
    x: number,
    y: number,
    radius: number,
    damage: number,
    color: number,
    element: ElementId | null = null,
    statuses?: StatusApplication[],
  ): void {
    this.fx.ring(x, y, color, radius, 0.4);
    this.fx.hitSpark(x, y, color, 1.1, 'spark', ELEMENT_FAMILY[element ?? 'fire']);
    this.damageArea({
      x,
      y,
      radius,
      damage,
      element,
      vfx: 'spark',
      color,
      statuses,
      friendly: false,
    });
    this.damageArea({
      x,
      y,
      radius: radius + 6,
      damage: damage * 0.8,
      element,
      vfx: 'spark',
      color,
      statuses,
      friendly: true,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Wave flow                                                           */
  /* ------------------------------------------------------------------ */

  private onWaveCleared(wave: number, floor: number, essence: number): void {
    const save = useSaveStore.getState();
    const elapsedMs = Math.round(this.director.currentSpec ? Date.now() - this.runStartedAt : 0);
    const shards = Math.random() < 0.35 ? 1 : 0;
    save.onWaveCleared({
      wave,
      floor,
      essence,
      shards,
      mode: this.run.mode,
      elapsedMs,
    });
    // §15: the wave's reward is a beat the player sees, not a number that quietly
    // lands in a store. The strip is non-blocking; the world keeps running.
    const localWave = wave - (floor - 1) * 20;
    gameBus.emit('game:waveCleared', {
      wave,
      floor,
      essence,
      shards,
      nextWave: wave + 1,
      chapter: localWave % 20 === 0,
      elapsedMs,
    });
    if (this.run.mode === 'ascension') {
      save.recordAscensionWave(wave);
    }
    // Fortress-class resonances are named for this moment, so this is where they pay.
    const shield = this.player.stats.shieldOnWave;
    if (shield > 0) {
      this.player.addShield(shield);
      this.fx.callout(this.player.x, this.player.y - 16, 'WAVE SHIELD', '#93A4BD', 7);
    }
    this.vacuumPickups();
    gameBus.emit('game:requestAutosave', { reason: 'wave-complete' });
    this.publishSnapshot(true);
  }

  /**
   * A cleared wave gathers what it dropped.
   *
   * Orbs lying on a field the player is about to leave are a reward they never
   * see, and hunting them down before the gateway opens is a chore rather than a
   * decision. So the wave's drops fly to the warden through the same
   * `collectPickup` path as walking over them: nothing is credited twice, nothing
   * is invented, and an orb that was about to expire still pays out.
   */
  private vacuumPickups(): void {
    const player = this.player;
    if (!player) return;
    const loose = (this.pickups.getChildren() as Pickup[]).filter((pickup) => pickup.active && !pickup.gathering);
    if (DEBUG_CONFIG.enabled) {
      // The gather is otherwise invisible: an auditor needs to know whether a wave
      // ended with loose drops at all, or with none left to fetch.
      console.info('[sixfold] wave-end gather', loose.length, 'pickup(s)');
    }
    if (loose.length === 0) return;
    const { vacuumMs, vacuumStaggerMs, vacuumMaxSpanMs } = PICKUP_CONFIG;
    // Ninety orbs must not become a two-minute trail: the stagger gives way to the
    // cap, and past a dozen or so the gather reads as one stream, which is the
    // point of it.
    const room = Math.max(0, vacuumMaxSpanMs - vacuumMs);
    const stagger = loose.length > 1 ? Math.min(vacuumStaggerMs, room / (loose.length - 1)) : 0;
    const span = vacuumMs + (loose.length - 1) * stagger;
    this.fx.ring(player.x, player.y, 0xf2c96b, 30, Math.min(0.6, span / 1000), 1);
    loose.forEach((pickup, index) => {
      // The tween owns the transform for the flight; leave the body enabled and
      // the magnet plus drag fight it.
      const body = pickup.body as Phaser.Physics.Arcade.Body | null;
      if (body) body.enable = false;
      pickup.remaining = Math.max(pickup.remaining, span / 1000 + 0.5);
      pickup.gathering = true;
      this.tweens.add({
        targets: pickup,
        x: player.x,
        y: player.y,
        scaleX: 0.7,
        scaleY: 0.7,
        duration: vacuumMs,
        delay: index * stagger,
        ease: 'Sine.easeIn',
        onComplete: () => {
          // A gather can be queued twice (a boss's drops land in bursts after the
          // wave's own clear); `gathering` is what keeps that from crediting twice.
          if (pickup.active && pickup.gathering) this.collectPickup(pickup);
        },
      });
    });
  }

  private queueNextWave(): void {
    if (this.waveAdvancePending) return;
    this.waveAdvancePending = true;
    const current = this.director.currentSpec;
    if (!current) {
      this.waveAdvancePending = false;
      return;
    }

    const nextWave = current.wave + 1;
    const isFloorBoundary = current.localWave % 20 === 0;
    const isMiniBoundary = !isFloorBoundary && current.localWave % 10 === 0;

    if (isFloorBoundary) {
      // The React layer shows the floor transition card and pauses the world.
      const nextFloor = current.floor + 1;
      if (current.localWave >= 200 && current.floor >= 10) {
        this.onStoryComplete();
        return;
      }
      const nextFloorDef = FLOOR_REGISTRY[Math.min(10, nextFloor)];
      useUiStore.getState().setTransition({
        kind: 'floor',
        title: 'FLOOR CLEARED',
        subtitle: `${this.context.floor.name} is behind you`,
        lines: [],
        accent: nextFloorDef.palette.accent,
        action: 'BEGIN FLOOR',
        chapter: {
          floorNumber: nextFloorDef.id,
          name: nextFloorDef.name,
          tagline: nextFloorDef.subtitle,
          hazardLabel: hazardLabel(nextFloorDef.hazard.kind),
          hazardBrief: hazardBrief(nextFloorDef.hazard.kind),
          wardens: [
            getBoss(nextFloorDef.miniBossId)?.name ?? '—',
            getBoss(nextFloorDef.majorBossId)?.name ?? '—',
          ],
          signals: nextFloorDef.elementDiscoveries.map((id) => ELEMENT_REGISTRY[id].name),
          previous: this.context.floor.name,
          wave: nextWave,
          ascensionCycle: this.run.mode === 'ascension' ? (useSaveStore.getState().data?.ascension.cycle ?? 0) : 0,
        },
      });
      setRunRequest({
        mode: this.run.mode,
        startWave: nextWave,
        floorOverride: nextFloorDef.id,
        reason: 'continue',
      });
      sfx('floor');
      this.publishSnapshot(true);
      return;
    }

    if (isMiniBoundary) {
      const boss = getBoss(current.bossId);
      useUiStore.getState().setTransition({
        kind: 'checkpoint',
        title: 'CHECKPOINT SECURED',
        subtitle: boss ? `${boss.name} has fallen` : 'The hall is quiet again',
        lines: [
          { label: 'CHECKPOINT', value: `Wave ${current.wave}` },
          { label: 'RESPAWN', value: `Wave ${nextWave}` },
          { label: 'ESSENCE', value: `+${Math.round(this.essenceRun)}` },
        ],
        accent: this.context.floor.palette.accent,
        action: 'CONTINUE',
      });
      setRunRequest({
        mode: this.run.mode,
        startWave: nextWave,
        floorOverride: current.floor,
        reason: 'continue',
      });
      this.publishSnapshot(true);
      return;
    }

    this.waveAdvancePending = false;
    this.director?.begin(nextWave, this.run.mode, this.run.floorOverride, this.run.difficultyScale ?? 1);
    saveCurrentWave(nextWave);
    this.publishSnapshot(true);
  }

  private forceNextWave(): void {
    const current = this.director?.currentSpec;
    if (!current) return;
    this.director.killAll();
    this.director.begin(current.wave + 1, this.run.mode, this.run.floorOverride, this.run.difficultyScale ?? 1);
    this.publishSnapshot(true);
  }

  protected onEnemyKilled(enemy: Enemy): void {
    const save = useSaveStore.getState();
    const run = save.run;
    if (run) run.enemiesDefeated += 1;
    /* Mastery follows the shot, not the hands: a support element that killed
       something levels itself, which is what makes its auto-cast accuracy climb
       (docs §B3 — it used to credit whoever happened to be held). */
    const element = enemy.lastHitElement ?? this.player.activeElement;
    if (element) {
      const xp = enemy.isBoss
        ? MASTERY.xpPerBossKill
        : enemy.rank === 'elite'
          ? MASTERY.xpPerEliteKill
          : MASTERY.xpPerKill;
      save.addMastery(element, xp);
    }
    this.director.notifyKilled(enemy);
    save.mutate((draft) => {
      draft.stats.enemiesDefeated += 1;
    });
    gameBus.emit('game:enemyKilled', {
      defId: enemy.def.id,
      rank: enemy.rank,
      isBoss: enemy.isBoss,
      essence: enemy.essenceValue,
      shards: 0,
    });
    this.publishSnapshot(true);
  }

  /**
   * §13: a warden's arrival is an event, not a spawn. The arena takes their
   * colour, the frame sinks, the ground rings where they landed and the world
   * stutters for a beat. The director is already holding the wave in `bossIntro`,
   * so none of this steals control — the intro is the pause the fight would have
   * had anyway, spent on telling you what you are about to face.
   */
  private onBossSpawn(enemy: Enemy): void {
    const def = enemy.boss?.def;
    const color = def ? hexToInt(def.color) : 0xff5c6c;
    this.arena.setThreat(color);
    this.fx.screenWash(color, 0.16, 460);
    this.fx.ring(enemy.x, enemy.y + 4, color, 52, 0.62, 1.6);
    this.fx.ring(enemy.x, enemy.y + 4, color, 26, 0.42, 1.2);
    this.fx.squash(enemy, 0.26);
    this.fx.hitSpark(enemy.x, enemy.y - 6, color, 1.8, 'spark', ELEMENT_FAMILY[def?.element ?? 'fire']);
    this.fx.hitStop(110);
    this.fx.zoomPunch(0.06);
    this.fx.shake('heavy');
    this.publishSnapshot(true);
  }

  private onBossPhase(enemy: Enemy, index: number, banner: string): void {
    pulse('bossPhase');
    const bossId = enemy.boss?.def.id ?? 'unknown';
    this.fx.callout(enemy.x, enemy.y - 26, banner, '#F2C96B', 9);
    gameBus.emit('game:bossPhase', { bossId, phase: index, banner });
    this.publishSnapshot(true);
  }

  private onBossDefeated(enemy: Enemy): void {
    if (this.bossHandled) return;
    this.bossHandled = true;
    // The room exhales: light returns to the floor's own palette.
    this.arena.setThreat(null);
    const bossDef = enemy.boss?.def;
    if (!bossDef) return;
    const save = useSaveStore.getState();
    const rewardMult = this.director.currentSpec?.rewardMult ?? 1;

    const shards = Math.round((bossDef.rank === 'major' ? 3 : 1.5) * rewardMult);
    const relics = bossDef.rank === 'major' ? 1 : 0;
    const essence = Math.round(bossDef.essence * rewardMult);

    save.onBossDefeated({
      bossId: bossDef.id,
      rank: bossDef.rank,
      essence,
      shards,
      relics,
      mode: this.run.mode,
      drops: [],
      wave: bossDef.wave,
    });

    const table = getDropTable(bossDef.rewardTableId);
    if (table) {
      const bursts = bossDef.rank === 'major' ? 4 : 2;
      for (let i = 0; i < bursts; i += 1) {
        this.time.delayedCall(i * 180, () => {
          this.rollDropTable(table, enemy.x + (Math.random() - 0.5) * 30, enemy.y + (Math.random() - 0.5) * 30, 1);
        });
      }
      // The wave's own gather fires the moment the arena is safe, which is *before*
      // these bursts have finished landing — so a boss's reward tail gets a gather of
      // its own instead of sitting on the floor until the next wave clears.
      this.time.delayedCall(bursts * 180 + 160, () => this.vacuumPickups());
    }

    if (this.run.mode === 'story') {
      save.onCheckpoint(bossDef.id, bossDef.floor, bossDef.wave);
      save.markHallLevel(bossDef.floor);
      gameBus.emit('game:checkpointReached', {
        bossId: bossDef.id,
        bossName: bossDef.name,
        floor: bossDef.floor,
        wave: bossDef.wave,
      });
    }

    gameBus.emit('game:requestAutosave', { reason: 'boss-defeat' });
    this.bossHandled = false;
    this.publishSnapshot(true);
  }

  private onFloorCleared(floorNumber: number): void {
    useSaveStore.getState().markHallLevel(Math.min(10, floorNumber + 1));
    gameBus.emit('game:requestAutosave', { reason: 'floor-cleared' });
  }

  private onStoryComplete(): void {
    const save = useSaveStore.getState();
    save.completeStory();
    useUiStore.getState().setTransition({
      kind: 'victory',
      title: 'STORY COMPLETE',
      subtitle: 'The sixfold world is yours to shape',
      lines: [
        { label: 'WAVES CLEARED', value: '200 / 200' },
        { label: 'ASCENSION MODE', value: 'UNLOCKED' },
        { label: 'FREE MODE', value: 'UNLOCKED' },
      ],
      accent: '#F2C96B',
      action: 'CONTINUE',
    });
    gameBus.emit('game:ascensionUnlocked', { cycle: 1 });
    sfx('unlock');
    this.publishSnapshot(true);
  }

  /* ------------------------------------------------------------------ */
  /* Player events                                                       */
  /* ------------------------------------------------------------------ */

  protected onPlayerAttack(element: ElementId | null): void {
    this.creditCastProgress('attack', element);
  }

  protected onPlayerSkill(element: ElementId | null): void {
    this.creditCastProgress('skill', element);
  }

  protected onPlayerUltimate(element: ElementId | null): void {
    this.creditCastProgress('ultimate', element);
  }

  /**
   * The one door a run's *progression* walks through: mastery points and element-usage statistics, which
   * is also where achievements start moving.
   *
   * Everything else this scene writes to the save is either the run's own ledger or clock housekeeping,
   * so a mode that must earn nothing — DungeonMode — declines this one method instead of every call site
   * having to remember to. That is the difference between a self-contained mode and a fork.
   */
  protected creditCastProgress(kind: 'attack' | 'skill' | 'ultimate' | 'switch', element: ElementId | null): void {
    if (!element) return;
    const save = useSaveStore.getState();
    switch (kind) {
      case 'attack':
        save.registerAttackUse(element);
        break;
      case 'skill':
        save.addMastery(element, MASTERY.xpPerSkillUse);
        save.registerAttackUse(element);
        break;
      case 'ultimate':
        save.addMastery(element, MASTERY.xpPerUltimateUse);
        save.registerAttackUse(element);
        break;
      case 'switch':
        save.addMastery(element, MASTERY.xpPerSwitch);
        break;
    }
  }

  protected onPlayerDamageDealt(amount: number, isCrit: boolean, isBoss: boolean): void {
    const save = useSaveStore.getState();
    const run = save.run;
    if (run) {
      run.totalDamage += amount;
      run.highestHit = Math.max(run.highestHit, amount);
    }
    save.mutate((draft) => {
      draft.stats.totalDamage += amount;
      if (amount > draft.stats.highestHit) draft.stats.highestHit = amount;
    });
    void isCrit;
    void isBoss;
  }

  protected onPlayerDamaged(_amount: number): void {
    this.publishSnapshot(true);
  }

  protected onPlayerDeath(): void {
    pulse('death');
    const save = useSaveStore.getState();
    save.onPlayerDeath();
    // Playtime is credited by finishRun(), which every ending funnels through.
    const spec = this.director?.currentSpec;
    useUiStore.getState().setDeathOpen(true);
    const summary = save.finishRun('death', {
      wave: spec?.wave ?? 1,
      floor: spec?.floor ?? 1,
    });
    useUiStore.getState().setSummary(summary);
    gameBus.emit('game:playerDied', {
      wave: spec?.wave ?? 1,
      floor: spec?.floor ?? 1,
    });
    gameBus.emit('game:requestAutosave', { reason: 'death' });
    audioEngine.stopMusic();
    this.publishSnapshot(true);
    this.fx.shake('heavy');
  }

  private respawnAtCheckpoint(): void {
    const save = useSaveStore.getState();
    const checkpoint = save.data?.checkpoint;
    const spec = this.director?.currentSpec;
    const respawnWave = checkpoint ? checkpoint.respawnWave : 1;
    setRunRequest({
      mode: this.run.mode,
      startWave: this.run.mode === 'story' ? Math.max(1, respawnWave) : (spec?.wave ?? 1),
      floorOverride: floorForWave(respawnWave),
      reason: 'respawn',
    });
    useUiStore.getState().setDeathOpen(false);
    useUiStore.getState().setSummary(null);
    this.scene.restart();
  }

  private restartRun(payload?: { wave?: number; mode?: 'story' | 'free' | 'ascension' }): void {
    const spec = this.director?.currentSpec;
    setRunRequest({
      mode: payload?.mode ?? this.run.mode,
      startWave: payload?.wave ?? spec?.wave ?? 1,
      floorOverride: this.run.floorOverride,
      reason: 'debug',
    });
    this.scene.restart();
  }

  /* ------------------------------------------------------------------ */
  /* Frame loop                                                          */
  /* ------------------------------------------------------------------ */

  override update(_time: number, delta: number): void {
    if (this.destroyed) return;
    const ui = useUiStore.getState();
    // Anything that takes the player out of the fight freezes the simulation:
    // pause, death, transitions, the run summary and the full-screen menus the
    // pause menu links to (skill tree, loadout, codex, statistics).
    const menuOpen = isRunSubscreen(ui.screen);
    const shouldFreeze =
      ui.paused || ui.deathOpen || ui.transition !== null || ui.summary !== null || menuOpen;
    this.setFrozen(shouldFreeze);
    if (this.frozen) {
      this.fx.update(Math.min(delta, 32));
      this.hudTimer += delta;
      if (this.hudTimer > 100) this.publishSnapshot();
      return;
    }

    const dt = Math.min(delta, 50);
    const settings = useSettingsStore.getState();
    this.tickRunBuffs(dt);

    const input = this.inputManager.read(this.player.x, this.player.y, settings.autoAim);
    this.player.setInput(input);
    this.player.tick(dt);
    this.waveAdvancePending = this.waveAdvancePending && this.director?.currentState === 'cleared';

    for (const child of this.enemies.getChildren() as Enemy[]) {
      if (child.active) child.tick(dt);
    }
    // Support elements cast for themselves — after the horde has moved, so they aim
    // at where enemies actually are rather than where they were.
    if (AUTO_CAST.enabled && this.player.alive) {
      this.autoCast.update(dt, this.player, {
        pickTarget: (from, radius) => this.findSupportTarget(from.x, from.y, radius),
        xpOf: this.xpOfElement,
        cast: (element, target, accuracy) => this.player.castSupport(element, target, accuracy),
      });
    }
    this.playerProjectiles.step(dt, this.context);
    this.enemyProjectiles.step(dt, this.context);
    this.fields.update(dt, this.context);
    this.updatePickups(dt);
    this.director.update(dt);
    this.updateHazards(dt);
    this.arena.update(dt, this.cameras.main);
    this.fx.update(dt);

    this.hudTimer += dt;
    if (this.hudTimer >= 1000 / 12) {
      this.hudTimer = 0;
      this.publishSnapshot();
    }
  }

  protected updatePickups(dt: number): void {
    for (const child of this.pickups.getChildren() as Pickup[]) {
      if (!child.active) continue;
      const state = child.step(dt, this.player.x, this.player.y, this.player.pickupRadius);
      if (state === 'expired') child.retire();
    }
  }

  protected updateHazards(dt: number): void {
    if (!this.hazards) return;
    const state = this.director.currentState;
    const busy = state === 'fighting' || state === 'boss';
    // Quiet between waves, honest during one, and dialled back for a warden so
    // the arena never competes with the boss's own patterns.
    const intensity = (this.director.currentSpec?.hazardIntensity ?? 0) * (busy ? 1 : 0.45);
    if (intensity <= 0.12) return;
    this.hazards.update(dt, intensity);
  }

  protected spawnMine(x: number, y: number, damage: number, color: number): void {
    const mine = this.add.image(Math.round(x), Math.round(y), 'fx_ring').setDepth(14).setTint(color).setAlpha(0.8);
    this.hazardSprites.push(mine);
    this.tweens.add({ targets: mine, alpha: 0.35, duration: 380, yoyo: true, repeat: -1 });
    const timer = this.time.delayedCall(4200, () => {
      if (mine.active) {
        this.explodeMine(mine.x, mine.y, damage, color, mine);
      }
    });
    mine.setData('explode', () => {
      timer.remove(false);
      this.explodeMine(mine.x, mine.y, damage, color, mine);
    });
    mine.setData('check', () => {
      if (Phaser.Math.Distance.Between(mine.x, mine.y, this.player.x, this.player.y) < 18) {
        const fn = mine.getData('explode') as () => void;
        fn();
      }
    });
  }

  protected explodeMine(x: number, y: number, damage: number, color: number, sprite: Phaser.GameObjects.Image): void {
    this.fx.ring(x, y, color, 34, 0.4);
    this.damageArea({ x, y, radius: 34, damage, element: null, vfx: 'spark', color, friendly: false });
    sprite.destroy();
    const index = this.hazardSprites.indexOf(sprite);
    if (index >= 0) this.hazardSprites.splice(index, 1);
  }

  protected spawnCrystalWall(color: number, damage: number): void {
    const bounds = this.physics.world.bounds;
    const vertical = Math.random() < 0.5;
    const length = 120;
    const x = vertical ? Phaser.Math.Between(bounds.x + 40, bounds.right - 40) : this.player.x;
    const y = vertical ? this.player.y : Phaser.Math.Between(bounds.y + 40, bounds.bottom - 40);
    const wall = this.add
      .image(Math.round(x), Math.round(y), 'fx_square')
      .setDepth(15)
      .setTint(color)
      .setAlpha(0.85)
      .setDisplaySize(vertical ? 6 : length, vertical ? length : 6);
    this.hazardSprites.push(wall);
    this.tweens.add({
      targets: wall,
      alpha: 0,
      duration: 5200,
      onComplete: () => {
        wall.destroy();
        const index = this.hazardSprites.indexOf(wall);
        if (index >= 0) this.hazardSprites.splice(index, 1);
      },
    });
    this.time.addEvent({
      delay: 400,
      repeat: 12,
      callback: () => {
        if (!wall.active) return;
        const distance = Phaser.Geom.Line.GetNearestPoint(
          new Phaser.Geom.Line(
            vertical ? x : x - length / 2,
            vertical ? y - length / 2 : y,
            vertical ? x : x + length / 2,
            vertical ? y + length / 2 : y,
          ),
          new Phaser.Geom.Point(this.player.x, this.player.y),
        );
        if (Phaser.Math.Distance.Between(distance.x, distance.y, this.player.x, this.player.y) < 12) {
          this.damageArea({ x: this.player.x, y: this.player.y, radius: 12, damage: damage * 0.4, element: null, vfx: 'crystal', color, friendly: false });
        }
      },
    });
  }

  protected setFrozen(frozen: boolean): void {
    if (frozen === this.frozen) {
      if (frozen) {
        this.runHazardChecks();
      }
      return;
    }
    this.frozen = frozen;
    const settings = useSettingsStore.getState();
    // A freeze parks every tween where it stands, including a camera punch, so the frame
    // behind the pause card could sit visibly zoomed and stay that way if the punch never
    // ran out. Settle the camera (and release a hit-stop whose restore call is now parked)
    // on the way in *and* the way out.
    this.fx.settle();
    this.fx.clearHitStop();
    if (frozen) {
      this.physics.world.pause();
      this.tweens.pauseAll();
      this.time.paused = true;
      audioEngine.setVolumes({
        master: settings.masterVolume,
        sfx: settings.sfxVolume,
        music: settings.musicVolume * 0.35,
      });
    } else {
      this.physics.world.resume();
      this.tweens.resumeAll();
      this.time.paused = false;
      audioEngine.setVolumes({
        master: settings.masterVolume,
        sfx: settings.sfxVolume,
        music: settings.musicVolume,
      });
    }
  }

  protected runHazardChecks(): void {
    for (const sprite of this.hazardSprites) {
      const check = sprite.getData('check') as (() => void) | undefined;
      check?.();
    }
  }

  /* ------------------------------------------------------------------ */
  /* HUD publishing                                                      */
  /* ------------------------------------------------------------------ */

  protected publishSnapshot(force = false): void {
    const spec = this.director.currentSpec ?? null;
    const bossEnemy = this.director.boss;
    const bossDef = bossEnemy?.boss?.def ?? getBoss(spec?.bossId ?? null);
    const activeElement = this.player.activeElement;
    void force;

    useRunStore.getState().publish({
      mode: this.run.mode,
      wave: spec?.wave ?? 1,
      localWave: spec?.localWave ?? 1,
      cycle: spec?.cycle ?? 0,
      floor: spec?.floor ?? 1,
      floorName: this.context.floor.name,
      waveLabel: spec?.label ?? '',
      enemiesRemaining: this.director.remainingEnemies,
      waveTotal: spec?.total ?? 0,
      isBossWave: Boolean(spec?.isMiniBoss || spec?.isMajorBoss),
      isCountdown: this.director.currentState === 'countdown',
      countdown: Math.ceil(this.director.countdownRemaining),
      bossId: bossDef?.id ?? null,
      bossName: bossDef?.name ?? '',
      bossTitle: bossDef?.title ?? '',
      bossHp: bossEnemy && bossEnemy.active ? bossEnemy.hp : 0,
      bossMaxHp: bossEnemy && bossEnemy.active ? bossEnemy.maxHp : 0,
      bossPhase: bossDef ? bossDef.phases[Math.max(0, (bossEnemy?.boss?.phaseIndex ?? 0))]?.name ?? '' : '',
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
      activeElement,
      essenceRun: this.essenceRun,
      shardsRun: this.shardsRun,
      enemyCount: this.enemies.countActive(true),
      statuses: this.player.statuses
        .indicators()
        .map((entry) => ({ id: entry.id, stacks: entry.stacks, ratio: entry.ratio, color: intToHex(entry.color) })),
      elapsedMs: this.runStartedAt ? Date.now() - this.runStartedAt : 0,
      playerAlive: this.player.alive,
      respawnAvailable: Boolean(useSaveStore.getState().data?.checkpoint),
      fps: Math.round(this.game.loop.actualFps),
    });
  }

  /* ------------------------------------------------------------------ */
  /* Teardown                                                            */
  /* ------------------------------------------------------------------ */

  /** Safe group teardown — never throws if Phaser already destroyed it. */
  protected clearGroup(group: Phaser.GameObjects.Group | null | undefined): void {
    if (!group || !group.scene) return;
    try {
      group.clear(true, true);
    } catch {
      // The group was already dismantled during scene shutdown.
    }
  }

  protected cleanup(): void {
    this.destroyed = true;
    for (const dispose of this.busDisposers) dispose();
    this.busDisposers = [];
    this.inputManager?.destroy();
    this.director?.destroy();
    this.hazards?.destroy();
    this.hazards = null;
    this.fields?.clear();
    this.playerProjectiles?.releaseAll();
    this.enemyProjectiles?.releaseAll();
    this.fx?.destroy();
    this.scale.off(Phaser.Scale.Events.RESIZE, this.onFrameResize, this);
    this.arena?.destroy();
    for (const sprite of this.hazardSprites) sprite.destroy();
    this.hazardSprites = [];
    // Groups can already be torn down by Phaser's shutdown, in which case their
    // internal collections are gone and clear() would throw mid-cleanup.
    this.clearGroup(this.enemies);
    this.clearGroup(this.pickups);
    audioEngine.stopMusic();
    useRunStore.getState().reset();
  }

  /** Exposed for the development debug panel. */
  get debugInfo(): {
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
      state: this.director?.currentState ?? 'none',
      wave: this.director?.currentSpec?.wave ?? 1,
    };
  }
}

/** Story progress mirrors the wave the player is about to face. */
function saveCurrentWave(wave: number): void {
  const store = useSaveStore.getState();
  if (!store.data) return;
  if (store.data.story.currentWave === wave) return;
  if (store.data.story.highestWave >= wave + 2) return;
  store.setStoryWave(wave);
}

export const SCENE_KEYS = {
  boot: 'BootScene',
  mainMenu: 'MainMenuScene',
  gameplay: 'GameplayScene',
  pause: 'PauseScene',
} as const;

