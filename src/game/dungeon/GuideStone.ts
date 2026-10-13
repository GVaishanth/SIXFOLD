import Phaser from 'phaser';

/**
 * The one object in the strip that gives nothing away and explains everything else.
 *
 * It is a stone in the same visual vocabulary as the five kinds that hold loot or danger, because the mode
 * has no key prompts and no tooltips — a 20 px target and a thumb pad do not mix — so the verb for reading
 * it is the verb for opening a cache: walk into it. It is not spent, and the card it raises deliberately
 * does not stop the run. The warden is still in danger while it reads, which is why the card is eight lines
 * long and closes itself.
 */
export class GuideStone extends Phaser.Physics.Arcade.Sprite {
  /** Set the last time it raised the card, so standing on the stone does not re-open it every frame. */
  raisedAt = Number.NEGATIVE_INFINITY;

  constructor(scene: Phaser.Scene, x: number, y: number, textureKey: string) {
    super(scene, x, y, textureKey);
    scene.add.existing(this);
    scene.physics.add.existing(this);
    const body = this.body as Phaser.Physics.Arcade.Body;
    // Static and forgiving, exactly like a site stone: it must not shove the warden, and it must be easy
    // to touch on purpose.
    body.setImmovable(true);
    body.setSize(18, 18);
    body.allowGravity = false;
    this.setPosition(Math.round(x), Math.round(y));
    this.setDepth(6);
  }

  /** A pulse on the run clock rather than a tween, so a paused frame stops it with everything else. */
  breathe(now: number): void {
    this.setAlpha(0.78 + 0.18 * Math.sin(now * 0.0022));
  }
}
