import Phaser from 'phaser';
import { RESOLUTION } from '@/config/gameConfig';
import { ensureDotTexture, ensureSquareParticle } from '@/game/textureFactory';
import {
  ensureMenuFog,
  ensureMenuRidge,
  ensureMenuRuins,
  ensureMenuShelf,
  ensureMenuSigil,
  ensureMenuSky,
  ensureSoftGlow,
} from '@/assets/menuArt';

const W = RESOLUTION.width;
const H = RESOLUTION.height;

/** How far the paint reaches past the frame, in world pixels. */
const BLEED = 4;

/** Broad emotional register of the backdrop — drives colour and motion bias. */
export type AtmosphereMood = 'calm' | 'focus' | 'danger' | 'triumph';

export interface AtmosphereOptions {
  /** Hex colour that dominates the screen (token palette, not arbitrary). */
  accent: number;
  /** 0 = recessed behind gameplay, 1 = full presentation (menus, reveals). */
  intensity?: number;
  /** Draw the ritual sigil behind the centre of the frame. */
  sigil?: boolean;
  /** Rising motes; these are real display objects so keep the number small. */
  motes?: number;
  /** Follow the pointer for parallax — menus only, never during combat. */
  pointerParallax?: boolean;
  /** Ridgeline seed + silhouette family, so each floor looks like itself. */
  seed?: number;
  /** Vertical band the ruins sit on (menus sit lower than gameplay). */
  horizon?: number;
  /** Where the sigil sits, in internal pixels. Default: frame centre. */
  sigilY?: number;
  sigilScale?: number;
}

interface Mote {
  sprite: Phaser.GameObjects.Image;
  speed: number;
  sway: number;
  phase: number;
  layer: number;
}

interface BackdropLayer {
  image?: Phaser.GameObjects.Image;
  tile?: Phaser.GameObjects.TileSprite;
  /** Pixels of travel at full pointer deflection — depth in one number. */
  factor: number;
  drift?: number;
  baseScroll: number;
  baseY: number;
  /**
   * Authored distance from the floor of the frame to the band's centre line.
   * Bands are hung from the floor rather than placed at an absolute y so the
   * composition can grow upward with a tall frame instead of floating in the
   * middle of it with dead space underneath.
   */
  floorGap: number;
}

/**
 * Shared atmospheric backdrop.
 *
 * One class builds the layered environment for the menu, the diegetic hub and
 * the floor-transition states so those screens share a place instead of each
 * inventing a background. Every texture is generated at runtime, the object
 * count stays in the dozens, and nothing here touches the DOM.
 *
 * Depth is expressed as a scroll factor: far ridges move a couple of pixels,
 * near motes move eight. At 320 px wide that is enough for the eye to read
 * distance without pretending to be 3D.
 */
export class Atmosphere {
  private readonly scene: Phaser.Scene;
  private readonly world: Phaser.GameObjects.Container;
  private readonly layers: BackdropLayer[] = [];
  private readonly motes: Mote[] = [];
  private readonly bursts: Phaser.GameObjects.Image[] = [];
  private readonly sky: Phaser.GameObjects.Image;
  private readonly glow: Phaser.GameObjects.Image;
  private readonly horizon: number;
  private sigilOuter?: Phaser.GameObjects.Image;
  private sigilInner?: Phaser.GameObjects.Image;
  private sigilY = 0;
  private sigilAnchorY = 0;
  private sigilScale = 1;
  private accent: number;
  private intensity: number;
  private pointerX = 0.5;
  private pointerY = 0.5;
  private readonly pointerEnabled: boolean;
  private mood: AtmosphereMood = 'calm';
  private offPointer?: () => void;
  private offResize?: () => void;
  /**
   * The rectangle the composition actually has to paint, in world pixels. It is
   * never smaller than the authored 320×180 and usually wider or taller, because
   * the render buffer follows the window. Everything that could leave an
   * unpainted strip is measured against this, not against W/H.
   */
  private readonly frame: {
    width: number;
    height: number;
    cx: number;
    floorY: number;
  } = {
    /** What has to be painted — never smaller than the authored plate. */
    width: W,
    height: H,
    /** Where the camera actually looks: the composition centres and rests here. */
    cx: W / 2,
    floorY: H,
  };
  private skyKey: string;
  private destroyed = false;

  constructor(scene: Phaser.Scene, options: AtmosphereOptions) {
    this.scene = scene;
    this.accent = options.accent;
    this.intensity = options.intensity ?? 1;
    this.pointerEnabled = options.pointerParallax ?? false;
    this.horizon = options.horizon ?? 26;

    const seed = options.seed ?? 3;
    this.world = scene.add.container(0, 0).setDepth(-10);

    this.skyKey = ensureMenuSky(scene, options.accent);
    this.sky = scene.add
      .image(0, 0, this.skyKey)
      .setOrigin(0, 0)
      .setDisplaySize(W, H)
      .setAlpha(0.9);
    this.world.add(this.sky);

    /* Nothing here may look like a picture pasted into a black rectangle: the
       sky carries on above the composition to the top of the frame and the
       ground bands sit on the bottom edge of it, so a tall phone sees a taller
       view of the same place rather than letterboxing. `reframe` does that
       measuring — and it has to run *after* every layer exists, because it is
       what places them. */
    const onResize = (): void => this.reframe();
    scene.scale.on('resize', onResize);
    this.offResize = () => scene.scale.off('resize', onResize);

    /* Landforms are tiled, not stretched: a 320 px strip repeated across the
       frame means parallax can slide it forever with no visible edge, and no
       nearest-neighbour banding from a scaled-up texture. */
    this.addBand(ensureMenuRidge(scene, seed, 54, 0x0d1524, 0x22334d), {
      factor: 0.6,
      drift: 0.6,
      y: H - 18 - 27,
      height: 54,
      alpha: 0.92,
    });
    this.addBand(ensureMenuRidge(scene, seed + 8, 44, 0x0b1220, 0x2c405e), {
      factor: 1.4,
      drift: 1.2,
      y: H - this.horizon - 4 - 22,
      height: 44,
      alpha: 0.95,
    });

    // High haze sits behind the ruins so the distance feels humid, not flat.
    const fogKey = ensureMenuFog(scene);
    this.addBand(fogKey, { factor: 2.2, drift: -3.4, y: H - this.horizon - 30, height: 14, alpha: 0.05 });

    // Ruins carry the only warm pixels in the frame: that is what makes the
    // place feel inhabited rather than decorated.
    this.addBand(ensureMenuRuins(scene, seed + 2, 0x0c1626, 0xf2c96b), {
      factor: 2.8,
      drift: 0,
      y: H - this.horizon - 23,
      height: 46,
      alpha: 1,
    });

    // Low fog passes in front of the ruins line, thin and quiet.
    this.addBand(fogKey, { factor: 3.6, drift: 4.6, y: H - this.horizon + 2, height: 12, alpha: 0.06 });

    this.addBand(ensureMenuShelf(scene, options.accent), {
      factor: 4.2,
      drift: 0,
      y: H - 17 + 1,
      height: 34,
      alpha: 1,
    });

    // Light pool: the accent as a soft radial wash on the ground line.
    this.glow = scene.add
      .image(W / 2, H - this.horizon - 6, ensureSoftGlow(scene))
      .setDisplaySize(W * 1.15, 116)
      .setTint(options.accent)
      .setAlpha(0.12)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.world.add(this.glow);

    if (options.sigil) {
      const sigilKey = ensureMenuSigil(scene);
      const sigilY = options.sigilY ?? H / 2 - 6;
      const sigilScale = options.sigilScale ?? 1;
      this.sigilOuter = scene.add
        .image(W / 2, sigilY, sigilKey)
        .setScale(sigilScale)
        .setAlpha(0.3)
        .setTint(options.accent)
        .setBlendMode(Phaser.BlendModes.ADD);
      this.sigilInner = scene.add
        .image(W / 2, sigilY, sigilKey)
        .setScale(sigilScale * 0.62)
        .setAlpha(0.14)
        .setTint(0xdfe8f8)
        .setBlendMode(Phaser.BlendModes.ADD);
      this.sigilY = sigilY;
      this.sigilScale = sigilScale;
      this.world.add(this.sigilOuter);
      this.world.add(this.sigilInner);
    }

    const moteKey = ensureDotTexture(scene);
    const moteCount = options.motes ?? 22;
    for (let i = 0; i < moteCount; i += 1) {
      const layer = i % 3;
      const sprite = scene.add
        .image(Phaser.Math.Between(0, W), Phaser.Math.Between(0, H), moteKey)
        .setDepth(-9 + layer)
        .setScale(1)
        .setAlpha(0.08 + layer * 0.06)
        .setTint(layer === 2 ? options.accent : 0xbccbe6);
      this.world.add(sprite);
      this.motes.push({
        sprite,
        speed: 3 + layer * 4 + Math.random() * 4,
        sway: 1 + Math.random() * 2.5,
        phase: Math.random() * Math.PI * 2,
        layer,
      });
    }

    if (this.pointerEnabled) {
      const onMove = (event: PointerEvent) => {
        this.pointerX = event.clientX / Math.max(1, window.innerWidth);
        this.pointerY = event.clientY / Math.max(1, window.innerHeight);
      };
      window.addEventListener('pointermove', onMove, { passive: true });
      this.offPointer = () => window.removeEventListener('pointermove', onMove);
      scene.events.once('shutdown', () => this.destroy());
    }

    this.reframe();
  }

  /** A full-width tiled band: parallax is a tile offset, so nothing slides off-frame. */
  private addBand(
    key: string,
    options: { factor: number; drift: number; y: number; height: number; alpha: number },
  ): void {
    const tile = this.scene.add
      .tileSprite(W / 2, options.y, W, options.height, key)
      .setOrigin(0.5, 0.5)
      .setAlpha(options.alpha);
    this.world.add(tile);
    this.layers.push({
      tile,
      factor: options.factor,
      drift: options.drift,
      baseScroll: tile.tilePositionX,
      baseY: options.y,
      floorGap: H - options.y,
    });
  }

  /** Change the dominant colour; the geography stays, the mood does not. */
  setAccent(accent: number, duration = 320): void {
    if (this.destroyed || accent === this.accent) return;
    const from = this.accent;
    const proxy = { t: 0 };
    const a = Phaser.Display.Color.IntegerToColor(from);
    const b = Phaser.Display.Color.IntegerToColor(accent);
    this.scene.tweens.add({
      targets: proxy,
      t: 1,
      duration,
      ease: 'Sine.easeInOut',
      onUpdate: () => {
        if (this.destroyed) return;
        this.accent = Phaser.Display.Color.GetColor(
          Math.round(a.red + (b.red - a.red) * proxy.t),
          Math.round(a.green + (b.green - a.green) * proxy.t),
          Math.round(a.blue + (b.blue - a.blue) * proxy.t),
        );
        this.paintAccent();
      },
      onComplete: () => {
        if (this.destroyed) return;
        this.accent = accent;
        this.paintAccent();
      },
    });
  }

  private paintAccent(): void {
    this.glow.setTint(this.accent);
    this.sigilOuter?.setTint(this.accent);
    this.motes.forEach((mote) => {
      if (mote.layer === 2) mote.sprite.setTint(this.accent);
    });
  }

  /** 0 = recessed behind gameplay, 1 = full presentation. */
  setIntensity(value: number, duration = 240): void {
    if (this.destroyed) return;
    this.scene.tweens.killTweensOf(this);
    this.scene.tweens.add({
      targets: this,
      intensity: Phaser.Math.Clamp(value, 0, 1),
      duration,
      ease: 'Sine.easeOut',
    });
  }

  setMood(mood: AtmosphereMood): void {
    this.mood = mood;
  }

  get currentAccent(): number {
    return this.accent;
  }

  /** Where a host scene can pin its own marks so they share the emblem's geometry. */
  get sigilCenter(): { x: number; y: number; radius: number } {
    return { x: this.frame.cx, y: this.sigilAnchorY, radius: 46 * this.sigilScale };
  }

  /** Ignite a handful of pixels outward from the ground line. */
  burst(color: number, count = 14): void {
    if (this.destroyed) return;
    const key = ensureSquareParticle(this.scene);
    const originX = this.frame.cx;
    const originY = this.frame.floorY - this.horizon - 4;
    const spread = Math.min(1.6, Math.max(1, this.frame.width / W));
    for (let i = 0; i < count; i += 1) {
      const angle = Phaser.Math.FloatBetween(-Math.PI, 0);
      const speed = Phaser.Math.Between(18, 62);
      const sprite = this.scene.add
        .image(originX, originY, key)
        .setDepth(1)
        .setScale(Phaser.Math.Between(1, 2))
        .setTint(color)
        .setBlendMode(Phaser.BlendModes.ADD);
      this.bursts.push(sprite);
      this.scene.tweens.add({
        targets: sprite,
        x: originX + Math.cos(angle) * speed * 2 * spread,
        y: originY + Math.sin(angle) * speed,
        alpha: 0,
        scaleX: 0,
        scaleY: 0,
        duration: Phaser.Math.Between(420, 900),
        ease: 'Sine.easeOut',
        onComplete: () => {
          sprite.destroy();
          const index = this.bursts.indexOf(sprite);
          if (index >= 0) this.bursts.splice(index, 1);
        },
      });
    }
  }

  /** Called from the host scene's update loop. */
  update(time: number, delta: number): void {
    const seconds = time / 1000;
    const drift = Math.sin(seconds * 0.12) * 3;
    const px = this.pointerEnabled ? (this.pointerX - 0.5) * 2 : 0;
    const py = this.pointerEnabled ? (this.pointerY - 0.5) * 2 : 0;
    const moodBias = this.mood === 'danger' ? 1.5 : this.mood === 'triumph' ? 1.2 : 1;

    for (const layer of this.layers) {
      const offset = px * layer.factor * moodBias;
      if (layer.tile) {
        const t = layer.tile;
        t.tilePositionX = layer.baseScroll + offset + (layer.drift ? seconds * layer.drift : 0);
        t.x = this.frame.cx + drift * (layer.factor / 9) * 0.5;
        continue;
      }
      if (layer.image) layer.image.x = offset;
    }

    this.sky.setAlpha(0.8 + this.intensity * 0.16);
    const moodGlow = this.mood === 'danger' ? 0.06 : this.mood === 'focus' ? 0.07 : this.mood === 'triumph' ? 0.09 : 0;
    this.glow.setAlpha(0.05 + this.intensity * 0.09 + moodGlow);
    this.glow.setScale(1 + Math.sin(seconds * 0.5) * 0.02);
    /* The sigil breathes at the edge of perception — 3% — and otherwise holds
       still. Endless rotation would compete with the menu for attention. */
    if (this.sigilOuter) {
      this.sigilOuter.setAlpha(0.2 + this.intensity * 0.16 + Math.sin(seconds * 0.6) * 0.03);
    }
    if (this.sigilInner) {
      this.sigilInner.setAlpha(0.12 + this.intensity * 0.12 + Math.sin(seconds * 0.6 + 1.2) * 0.02);
    }

    const moteGain = 0.4 + this.intensity * 0.6;
    for (const mote of this.motes) {
      const sprite = mote.sprite;
      sprite.y -= (mote.speed * delta) / 1000;
      sprite.x += Math.sin(seconds * 0.5 + mote.phase) * mote.sway * (delta / 1000);
      if (sprite.y < -4) {
        sprite.y = this.frame.floorY + Phaser.Math.Between(0, 12);
        sprite.x = Phaser.Math.Between(0, Math.max(1, Math.round(this.scene.scale.width)));
      }
      sprite.setAlpha((0.05 + mote.layer * 0.05) * moteGain);
    }

    // Whole-frame tilt from the pointer, eased so it never feels glued to it.
    const targetY = py * 2;
    this.world.y += (targetY - this.world.y) * Math.min(1, delta / 240);
  }

  /**
   * Fit the composition to the frame. Called on create and on every resize:
   * the internal view can be 320x180 on a 16:9 display or 320x693 on a phone.
   */
  reframe(): void {
    if (this.destroyed) return;
    const viewW = Math.max(1, Math.round(this.scene.scale.width));
    const viewH = Math.max(1, Math.round(this.scene.scale.height));
    const width = Math.max(W, viewW);
    const height = Math.max(H, viewH);
    this.frame.width = width;
    this.frame.height = height;
    /* Two different measurements, and conflating them is what leaves a seam: the
       paint extent has to be at least the authored plate (a 195 px phone view
       still gets a full 320 of tiling), while the *centre* and the *floor* have
       to be where the camera looks. Centring on 160 in a 195-wide view slides the
       whole composition off to the right; resting the bands on `height` instead
       of `viewH` buries the ground under a short window. */
    this.frame.cx = viewW / 2;
    this.frame.floorY = viewH;

    this.paintSky(width, height);
    this.world.setY(0);

    for (const layer of this.layers) {
      if (layer.tile) {
        // A TileSprite spans what you tell it to span: at the authored 320 the
        // extra columns of a wide frame were simply never painted, which is the
        // vertical seam on the right of the menu.
        layer.tile.width = width + BLEED * 2;
        layer.tile.x = this.frame.cx;
        layer.tile.y = this.frame.floorY - layer.floorGap;
        continue;
      }
      if (layer.image) {
        layer.image.setDisplaySize(width, layer.image.displayHeight);
        layer.image.x = this.frame.cx;
      }
    }

    // The ground light widens with the frame; it keeps its authored height so the
    // pool stays a pool and does not become a wash across the whole screen.
    this.glow.setPosition(this.frame.cx, this.frame.floorY - this.horizon - 6);
    this.glow.setDisplaySize(width * 1.15, 116);

    /* The crest follows the wordmark column, which the DOM centres near the top
       of the frame; at the authored height this is exactly the old position. */
    const sigilScale = this.sigilScale * Math.min(1.5, Math.max(1, width / W));
    const sigilY =
      viewH <= H * 1.2 ? this.sigilY : Math.min(viewH - (H - this.sigilY), viewH * 0.26);
    this.sigilOuter?.setPosition(this.frame.cx, sigilY).setScale(sigilScale);
    this.sigilInner?.setPosition(this.frame.cx, sigilY).setScale(sigilScale * 0.62);
    this.sigilAnchorY = sigilY;

    for (const mote of this.motes) {
      mote.sprite.x = Phaser.Math.Between(0, viewW);
      mote.sprite.y = Phaser.Math.Between(0, viewH);
    }
  }

  /**
   * Regenerate the sky plate at the frame's size (capped, so a freak 1200×150
   * buffer cannot ask for a megabyte of per-pixel work) and keep only the plate
   * in use, so resizing does not accumulate textures.
   */
  private paintSky(width: number, height: number): void {
    const key = ensureMenuSky(this.scene, this.accent, Math.min(width, 960), Math.min(height, 540));
    if (key !== this.skyKey) {
      const previous = this.skyKey;
      this.skyKey = key;
      this.sky.setTexture(key);
      if (this.scene.textures.exists(previous)) this.scene.textures.remove(previous);
    }
    /* Bled four pixels past every edge. The whole composition takes a ±2 px tilt
       from the pointer, and a plate sized exactly to the frame would let that
       tilt peel the artwork off an edge and show the page through it. */
    this.sky.setPosition(-BLEED, -BLEED);
    this.sky.setDisplaySize(width + BLEED * 2, Math.max(height, this.frame.floorY) + BLEED * 2);
  }

  /** Where the ground line sits inside the frame, in world pixels. */
  get floorY(): number {
    return this.frame.floorY;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.offResize?.();
    this.offPointer?.();
    this.bursts.forEach((sprite) => sprite.destroy());
    this.bursts.length = 0;
    this.motes.length = 0;
    this.layers.length = 0;
    this.scene.tweens.killTweensOf(this);
    this.world.destroy();
  }
}
