import Phaser from 'phaser';
import { ARENA, PERFORMANCE } from '@/config/gameConfig';
import { worldFrame } from '@/game/world/worldFrame';
import { ensurePropTexture, ensureSoftGlowKey, ensureTileTextures, ensureVignetteTexture } from '@/game/textureFactory';
import type { FloorDef } from '@/types';
import { hexToInt } from '@/utils/color';

/** How far past the walls the backdrop gradient continues, in world pixels. */
const BACKDROP_PAD = 420;

interface AmbientParticle {
  sprite: Phaser.GameObjects.Image;
  vx: number;
  vy: number;
  phase: number;
}

/**
 * Arena world.
 *
 * Builds the floor visuals (gradient backdrop, tiled ground, walls, props) and
 * runs the ambient particle layer. The physics bounds are inset by the wall
 * thickness so the player and enemies always collide correctly with the arena
 * boundary without extra colliders.
 */
export class Arena {
  readonly scene: Phaser.Scene;
  readonly floor: FloorDef;
  private ambient: AmbientParticle[] = [];
  private props: Phaser.GameObjects.Image[] = [];
  private hazardSprites: Phaser.GameObjects.Image[] = [];
  private backdrop?: Phaser.GameObjects.Graphics;
  private vignette?: Phaser.GameObjects.Image;
  private lightPool?: Phaser.GameObjects.Image;
  private wallThickness = ARENA.wall;
  /**
   * The field this instance is currently drawn for. `worldFrame` can move under
   * us when the frame changes shape (a phone turning upright halves the arena
   * width so actors stay readable), and every layer here is positioned from
   * this copy so a re-plan can re-lay them in one pass.
   */
  private frame = { width: worldFrame.width, height: worldFrame.height };
  private ground?: Phaser.GameObjects.TileSprite;
  private groundBorder?: Phaser.GameObjects.Graphics;
  private lips: Phaser.GameObjects.TileSprite[] = [];
  private walls: Phaser.GameObjects.TileSprite[] = [];
  private propAnchors: {
    prop: Phaser.GameObjects.Image;
    shadow: Phaser.GameObjects.Image;
    fx: number;
    fy: number;
  }[] = [];
  /** 0 = normal floor, 1 = a warden is on the field. Eased in `update`. */
  private threat = 0;
  private threatTarget = 0;

  constructor(scene: Phaser.Scene, floor: FloorDef, quality: 'low' | 'medium' | 'high') {
    this.scene = scene;
    this.floor = floor;

    ensureTileTextures(scene, {
      floor: floor.palette.floor,
      grout: floor.palette.grout,
      wall: floor.palette.wall,
    });
    this.buildBackdrop();
    this.buildGround();
    this.buildWalls();
    this.buildProps();
    this.buildAmbient(PERFORMANCE.qualityMult[quality]);
    this.buildLighting();
    // The render buffer follows the window, so anything screen-fixed has to be
    // re-fitted when the window changes shape rather than trusted to a size
    // measured once at create.
    this.scene.scale.on(Phaser.Scale.Events.RESIZE, this.reframe, this);
    this.scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scene.scale.off(Phaser.Scale.Events.RESIZE, this.reframe, this);
    });
  }

  get bounds(): Phaser.Geom.Rectangle {
    return new Phaser.Geom.Rectangle(
      this.wallThickness,
      this.wallThickness,
      this.frame.width - this.wallThickness * 2,
      this.frame.height - this.wallThickness * 2,
    );
  }

  /** The field the arena is drawn for, in world pixels. */
  get size(): { width: number; height: number } {
    return { ...this.frame };
  }

  /**
   * Re-lay every field-fixed layer for the current `worldFrame`. Called on the
   * scale RESIZE event when the plan changed the arena, so an orientation flip
   * rebuilds the room instead of leaving walls around the old rectangle.
   */
  applyFrame = (): void => {
    this.frame = { width: worldFrame.width, height: worldFrame.height };
    this.drawBackdrop();
    this.placeGround();
    this.placeWalls();
    this.placeProps();
  };

  private buildBackdrop(): void {
    const graphics = this.scene.add.graphics();
    graphics.setDepth(-30);
    this.backdrop = graphics;
    this.drawBackdrop();
  }

  private drawBackdrop(): void {
    const { width, height } = this.frame;
    const graphics = this.backdrop;
    if (!graphics) return;
    graphics.clear();
    /* The render buffer follows the window, so on a tall phone the frame shows
       the world from beyond its own walls. The backdrop is therefore painted
       past the arena in every direction — the same gradient, continuing — so
       the area outside the walls reads as the hall the arena stands in rather
       than a picture pasted onto black. */
    const pad = BACKDROP_PAD;
    const bg = hexToInt(this.floor.palette.bg);
    const bgAlt = hexToInt(this.floor.palette.bgAlt);
    const accent = hexToInt(this.floor.palette.accent);

    // Vertical gradient banding (cheap, pixel-friendly).
    const bands = 18;
    const spanX = width + pad * 2;
    const spanY = height + pad * 2;
    for (let i = 0; i < bands; i += 1) {
      const t = i / (bands - 1);
      const color = Phaser.Display.Color.Interpolate.ColorWithColor(
        Phaser.Display.Color.IntegerToColor(bg),
        Phaser.Display.Color.IntegerToColor(bgAlt),
        100,
        Math.round(t * 100),
      );
      graphics.fillStyle(Phaser.Display.Color.GetColor(color.r, color.g, color.b), 1);
      graphics.fillRect(
        -pad,
        Math.floor((spanY / bands) * i) - pad,
        spanX,
        Math.ceil(spanY / bands) + 1,
      );
    }

    /* Radial glow in the arena centre, kept inside the walls: an arc escaping
       past a wall reads as a ring drawn on the screen rather than light in the
       room, which is exactly what showed on a tall phone frame. */
    const inset = Math.min(width, height) / 2 - this.wallThickness - 4;
    graphics.fillStyle(accent, 0.06);
    graphics.fillCircle(width / 2, height / 2, inset);
    graphics.fillStyle(accent, 0.05);
    graphics.fillCircle(width / 2, height / 2, inset * 0.58);

    /* An apron of shadow around the outside of the walls. The frame can show
       more world than the arena, and this is what makes that area the darker
       hall the lit pit sits in, instead of the same flat fill continuing. */
    for (let ring = 0; ring < 14; ring += 1) {
      const grow = 2 + ring * 7;
      graphics.lineStyle(7, 0x000000, Math.max(0.02, 0.085 - ring * 0.005));
      graphics.strokeRect(
        -grow,
        -grow,
        width + grow * 2,
        height + grow * 2,
      );
    }
  }

  private buildGround(): void {
    this.ground = this.scene.add
      .tileSprite(0, 0, 8, 8, `tile_${this.floor.palette.floor}`)
      .setDepth(-20)
      .setAlpha(0.7);
    this.groundBorder = this.scene.add.graphics().setDepth(-19);
    [0.17, 0.09, 0.14].forEach((alpha, index) => {
      this.lips.push(
        this.scene.add
          .tileSprite(0, 0, 8, index === 2 ? 12 : 14, `tile_${this.floor.palette.floor}`)
          .setDepth(-21)
          .setAlpha(alpha)
          .setFlipY(index !== 2),
      );
    });
    this.placeGround();
  }

  private placeGround(): void {
    const { width, height } = this.frame;
    const inset = this.wallThickness;
    this.ground?.setPosition(width / 2, height / 2).setSize(width - inset * 2, height - inset * 2);

    // A subtle inner border marks the playable area, and a heavier dark line
    // just inside the walls sells the depth of the pit.
    const border = this.groundBorder;
    if (border) {
      border.clear();
      border.lineStyle(1, hexToInt(this.floor.palette.accent), 0.4);
      border.lineStyle(3, 0x000000, 0.22);
      border.strokeRect(inset, inset, width - inset * 2, height - inset * 2);
    }

    /* The lip of the pit. A tall frame sees past the top and bottom walls, and a
       mirrored strip of the floor's own tile — dim, thin, cut off by
       darkness — says the arena is a lit room set into a larger hall rather
       than a picture pasted onto a void. */
    const [below, far, above] = this.lips;
    below?.setPosition(width / 2, height + 6).setSize(width + 120, 14);
    far?.setPosition(width / 2, height + 21).setSize(width + 120, 14);
    above?.setPosition(width / 2, -6).setSize(width + 120, 12);

  }

  private buildWalls(): void {
    const wallKey = `wall_${this.floor.palette.wall}`;
    for (let side = 0; side < 4; side += 1) {
      this.walls.push(
        this.scene.add.tileSprite(0, 0, this.wallThickness, this.wallThickness, wallKey).setDepth(-10),
      );
    }
    this.placeWalls();
  }

  /** Moves the four wall bands and hands the new interior to physics. */
  private placeWalls(): void {
    const { width, height } = this.frame;
    const thickness = this.wallThickness;
    const [top, bottom, left, right] = this.walls;
    top?.setPosition(width / 2, thickness / 2).setSize(width, thickness);
    bottom?.setPosition(width / 2, height - thickness / 2).setSize(width, thickness);
    left?.setPosition(thickness / 2, height / 2).setSize(thickness, height);
    right?.setPosition(width - thickness / 2, height / 2).setSize(thickness, height);

    // Physics bounds keep the player inside the walls.
    this.scene.physics.world.setBounds(
      thickness,
      thickness,
      width - thickness * 2,
      height - thickness * 2,
    );
  }

  /**
   * Re-fit every screen-fixed layer to the current frame — and, when the plan
   * resized the field itself (a phone turning upright), re-lay the room.
   */
  reframe = (): void => {
    if (worldFrame.width !== this.frame.width || worldFrame.height !== this.frame.height) {
      this.applyFrame();
    }
    const { width, height } = this.scene.scale;
    this.vignette?.setDisplaySize(width, height);
    if (this.lightPool) {
      this.lightPool
        .setPosition(width / 2, height / 2 + 6)
        .setDisplaySize(width * 0.86, height * 0.78);
    }
  };

  /**
   * Lighting pass.
   *
   * Two screen-fixed layers do almost all of the work: a vignette that sinks the
   * corners into the void, and a warm pool under the player that makes them read
   * as the lit subject of the frame. Both are camera-space, so the cost is two
   * quads no matter how big the arena gets.
   */
  private buildLighting(): void {
    const { width, height } = this.scene.scale;
    const vignette = this.scene.add
      .image(width / 2, height / 2, ensureVignetteTexture(this.scene))
      .setDisplaySize(width, height)
      .setScrollFactor(0)
      .setDepth(28)
      .setBlendMode(Phaser.BlendModes.MULTIPLY);
    vignette.setAlpha(0.9);
    this.vignette = vignette;

    const accent = hexToInt(this.floor.palette.portal);
    const pool = this.scene.add
      .image(width / 2, height / 2 + 6, ensureSoftGlowKey(this.scene))
      .setDisplaySize(width * 0.86, height * 0.78)
      .setScrollFactor(0)
      .setDepth(-6)
      .setTint(accent)
      .setAlpha(0.1)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.lightPool = pool;
  }

  /**
   * Arena mood for a warden (§13): the pool of light takes their colour and
   * swells, the vignette closes in on the frame. Releasing the threat returns
   * the room to the floor's own palette, so a boss dying visibly ends.
   */
  setThreat(color: number | null): void {
    this.threatTarget = color === null ? 0 : 1;
    if (this.lightPool) {
      this.lightPool.setTint(color ?? hexToInt(this.floor.palette.portal));
    }
    if (this.vignette) {
      this.scene.tweens.add({
        targets: this.vignette,
        alpha: color === null ? 0.9 : 1,
        duration: 620,
        ease: 'sine.inout',
      });
      if (color === null) this.vignette.clearTint();
      else this.vignette.setTint(0xaeb8cd);
    }
    // Motes carry the mood too: `update` widens their drift as threat rises.
  }

  get threatLevel(): number {
    return this.threat;
  }

  private buildProps(): void {
    const color = hexToInt(this.floor.palette.accent);
    const family = this.floor.props;
    /* Anchored as fractions of the field, not as offsets from its walls: on a
       handheld frame the arena narrows, and a prop placed "36 px from the right
       wall" would end up in the middle of the floor. These are the same six
       points the authored 880×520 field produced. */
    const layout: [number, number][] = [
      [0.041, 0.111],
      [0.959, 0.104],
      [0.057, 0.889],
      [0.946, 0.842],
      [0.5, 0.062],
      [0.5, 0.938],
    ];
    for (const [fx, fy] of layout) {
      const prop = this.scene.add.image(0, 0, ensurePropTexture(this.scene, family, color));
      prop.setDepth(-8);
      prop.setAlpha(0.85);
      prop.setScale(1 + Math.random() * 0.35);
      // A contact shadow pins the silhouette to the floor instead of letting it
      // float over the tiles.
      const shadow = this.scene.add
        .image(0, 0, 'fx_soft_glow')
        .setDisplaySize(20, 7)
        .setTint(0x000000)
        .setAlpha(0.5)
        .setDepth(-9)
        .setBlendMode(Phaser.BlendModes.MULTIPLY);
      this.props.push(prop, shadow);
      this.propAnchors.push({ prop, shadow, fx, fy });
    }
    this.placeProps();
  }

  private placeProps(): void {
    const { width, height } = this.frame;
    for (const anchor of this.propAnchors) {
      const x = Math.round(anchor.fx * width);
      const y = Math.round(anchor.fy * height);
      anchor.prop.setPosition(x, y);
      anchor.shadow.setPosition(x, y + 6);
    }
  }

  private buildAmbient(qualityMultiplier: number): void {
    const count = Math.round(16 * this.floor.ambientDensity * qualityMultiplier);
    const color = hexToInt(this.floor.palette.accent);
    for (let i = 0; i < count; i += 1) {
      const sprite = this.scene.add.image(
        Math.random() * this.frame.width,
        Math.random() * this.frame.height,
        'fx_square',
      );
      sprite.setDepth(-5);
      sprite.setTint(color);
      sprite.setAlpha(0.25 + Math.random() * 0.4);
      sprite.setScale(this.floor.ambientParticle === 'snow' ? 1.4 : 0.6 + Math.random());
      const speed = this.ambientSpeed();
      this.ambient.push({
        sprite,
        vx: speed.x * (0.6 + Math.random() * 0.8),
        vy: speed.y * (0.6 + Math.random() * 0.8),
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  private ambientSpeed(): { x: number; y: number } {
    const d = this.floor.ambientDensity;
    switch (this.floor.ambientParticle) {
      case 'ember':
        return { x: 3 + d * 3, y: -6 - d * 4 };
      case 'bubble':
        return { x: 1, y: -4 - d * 3 };
      case 'gust':
        return { x: 14 + d * 6, y: -1 };
      case 'spore':
        return { x: 2, y: -2.5 };
      case 'glint':
        return { x: 1, y: -1 };
      case 'spark':
        return { x: -6, y: -3 };
      case 'ash':
        return { x: 4, y: 3 };
      case 'snow':
        return { x: -5, y: 5 };
      case 'miasma':
        return { x: 2, y: 1.4 };
      default:
        return { x: 1.5, y: -1.5 };
    }
  }

  /** Ambient hazard visuals (lava seeps, blight pods, ice sheets). */
  spawnHazardVisual(x: number, y: number, radius: number, color: number, durationMs: number): void {
    const sprite = this.scene.add.image(Math.round(x), Math.round(y), 'fx_puff').setDepth(8);
    sprite.setTint(color);
    sprite.setAlpha(0.5);
    sprite.setScale((radius * 2) / 10);
    this.hazardSprites.push(sprite);
    this.scene.tweens.add({
      targets: sprite,
      alpha: 0.15,
      duration: durationMs,
      onComplete: () => {
        sprite.destroy();
        const index = this.hazardSprites.indexOf(sprite);
        if (index >= 0) this.hazardSprites.splice(index, 1);
      },
    });
  }

  update(deltaMs: number, camera: Phaser.Cameras.Scene2D.Camera): void {
    const dt = deltaMs / 1000;
    const scrollX = camera.scrollX * 0.12;
    const scrollY = camera.scrollY * 0.12;
    // A warden on the field agitates the whole room: the motes in the air pick up
    // speed, which is cheaper and calmer than adding a new effect per boss.
    const agitation = 1 + this.threat * 0.55;
    for (const particle of this.ambient) {
      particle.phase += dt * 2;
      particle.sprite.x += particle.vx * dt * agitation;
      particle.sprite.y += particle.vy * dt * agitation;
      if (particle.sprite.y < -4) particle.sprite.y = this.frame.height + 4;
      if (particle.sprite.y > this.frame.height + 4) particle.sprite.y = -4;
      if (particle.sprite.x < -4) particle.sprite.x = this.frame.width + 4;
      if (particle.sprite.x > this.frame.width + 4) particle.sprite.x = -4;
      particle.sprite.setAlpha(0.2 + Math.abs(Math.sin(particle.phase)) * 0.35);
    }
    // Props do not bob. Nothing in the arena moves on its own except light and
    // air: every animated thing here has to be telling you something.
    void scrollX;
    void scrollY;

    /* The pool of light under the player breathes slowly — the only constant
       motion in the frame, and it reads as a torch rather than an animation. */
    if (this.lightPool) {
      const seconds = this.scene.time.now / 1000;
      // Threat eases toward its target so a warden entering or leaving changes
      // the whole room's light over a second rather than in one frame.
      this.threat += (this.threatTarget - this.threat) * Math.min(1, deltaMs / 1000 * 2.2);
      // Threat lifts the pool a little — enough to read as the room changing
      // colour, never enough to wash out the floor the player is reading.
      this.lightPool.setAlpha(
        0.09 + this.threat * 0.07 + Math.sin(seconds * 0.7) * 0.012 * (1 - this.threat * 0.5),
      );
      const scale = 1 + Math.sin(seconds * 0.5) * 0.015 + this.threat * 0.03;
      this.lightPool.setScale(scale);
    }
  }

  destroy(): void {
    this.scene.scale.off(Phaser.Scale.Events.RESIZE, this.reframe, this);
    for (const particle of this.ambient) particle.sprite.destroy();
    for (const prop of this.props) prop.destroy();
    for (const hazard of this.hazardSprites) hazard.destroy();
    this.ambient = [];
    this.props = [];
    this.hazardSprites = [];
    this.backdrop?.destroy();
    this.ground?.destroy();
    this.groundBorder?.destroy();
    for (const lip of this.lips) lip.destroy();
    for (const wall of this.walls) wall.destroy();
    this.lips = [];
    this.walls = [];
    this.propAnchors = [];
    this.backdrop = undefined;
    this.ground = undefined;
    this.groundBorder = undefined;
    // Screen-fixed layers are not children of the world, so they must be torn
    // down here or they survive into the next run.
    this.vignette?.destroy();
    this.lightPool?.destroy();
    this.vignette = undefined;
    this.lightPool = undefined;
  }
}
