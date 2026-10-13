import Phaser from 'phaser';
import type { DungeonSite, SiteKind, StoneState } from '@/types';

/**
 * A dungeon stone — the strip's only interactive object.
 *
 * One prop, three jobs (grove / cache / spring, plus a den that holds something bigger), because a
 * generated map the player can *read* needs one vocabulary rather than five. Interaction is overlap
 * only: a 20 px target and a thumb pad do not mix, so there is no key prompt anywhere in the mode.
 *
 * It deliberately owns no rules. What waking, opening and picking up mean lives in
 * `DungeonScene`, which is the only place that knows about enemies, drop tables and the party's health.
 */
export class Stone extends Phaser.Physics.Arcade.Sprite {
  readonly site: DungeonSite;
  readonly kind: SiteKind;
  /** Named away from `Sprite.state` for the same reason the ally's state is — see `Ally.ts`. */
  stoneState: StoneState = 'dormant';
  /** Spring only: how many times it will still pick the party up. */
  charges: number;
  /** The `ensureStoneTexture` variant this stone was drawn as. */
  readonly variant: number;
  /** Set when a grove is mid-release, so a second walk-over cannot start a second wave. */
  releasing = false;
  private glow: Phaser.GameObjects.Image | null = null;
  private retired = false;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    site: DungeonSite,
    textureKey: string,
    variant: number,
  ) {
    super(scene, x, y, textureKey);
    this.site = site;
    this.kind = site.kind;
    this.variant = variant;
    this.charges = site.kind === 'spring' ? site.n : 0;
    scene.add.existing(this);
    scene.physics.add.existing(this);
    const body = this.body as Phaser.Physics.Arcade.Body;
    // Static, and slightly wider than the sprite: "walk into it" has to be forgiving on a phone.
    body.setImmovable(true);
    body.setSize(14, 14);
    body.allowGravity = false;
    this.setDepth(6);
  }

  get interactive(): boolean {
    return !this.retired && this.stoneState !== 'spent';
  }

  /** Awake: the cap lights and the stone stops being scenery. */
  awaken(color: number): void {
    if (this.retired || this.stoneState === 'active') return;
    this.stoneState = 'active';
    this.setTint(0xffffff);
    if (!this.glow) {
      this.glow = this.scene.add.image(this.x, this.y + 1, 'fx_ring');
      this.glow.setDepth(5).setAlpha(0.55).setTint(color).setScale(0.55);
    }
    this.glow.setVisible(true);
  }

  /**
   * Spent stones stay drawn and go dark.
   *
   * Removing them would move the map under the player between two looks at it, and a spent grove is
   * information — it is the reason the strip does not need a minimap of its own history.
   */
  spend(): void {
    this.stoneState = 'spent';
    this.releasing = false;
    this.setAlpha(0.55);
    this.setTint(0x6f7c93);
    this.glow?.setVisible(false);
    const body = this.body as Phaser.Physics.Arcade.Body | null;
    body?.setSize(12, 12);
  }

  /** Used by the scene when the cell scrolls out of range: the sprite goes, the state does not. */
  retire(): void {
    this.retired = true;
    this.glow?.destroy();
    this.glow = null;
    this.destroy();
  }
}
