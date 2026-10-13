import Phaser from 'phaser';
import { PICKUP_CONFIG } from '@/config/gameConfig';
import { ensurePickupTexture } from '@/game/textureFactory';
import type { PickupDef } from '@/types';

/** Monotonic, never reused: two orbs of the same definition are still two different orbs. */
let nextSpawnTag = 1;

/**
 * Arena pickup. Floats in place, magnets toward the player inside the pickup
 * radius and is collected on contact.
 */
export class Pickup extends Phaser.Physics.Arcade.Sprite {
  defId = 'essence_orb';
  /**
   * Which of the pool's live sprites this is *this time around*. The dungeon's partner needs it: it
   * carries a drop in mind before it carries it in hand, and `defId` cannot tell one orb from the next.
   */
  spawnTag = 0;
  value = 1;
  kind: PickupDef['kind'] = 'essence';
  colorInt = 0xf2c96b;
  /** Seconds left before this drop vanishes. Typed as `number`: the config value is a literal. */
  remaining: number = PICKUP_CONFIG.lifetime;
  /** True while a wave-end gather owns this drop, so a second gather cannot queue it twice. */
  gathering = false;
  /**
   * Scenery with a duty rather than loot with a timer: the strip's charts are put on the floor by the
   * generator and stay there. A placed prop neither expires nor drifts, and the partner's errand list
   * ignores it — otherwise a courier would fetch a treasure map off the corridor and hand it over
   * wherever the warden happened to be standing, which is not how finding one is meant to work.
   */
  placed = false;
  private bobPhase = 0;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y, 'pickup_essence_orb_f2c96b');
    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.setDepth(30);
    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setAllowGravity(false);
    body.setCircle(4);
  }

  spawn(def: PickupDef, value: number, x: number, y: number, scatter = true): void {
    this.spawnTag = nextSpawnTag++;
    this.defId = def.id;
    this.value = value;
    this.kind = def.kind;
    this.colorInt = def.colorInt;
    this.remaining = PICKUP_CONFIG.lifetime;
    // Pool sprites are reused, so a flag this meaningful is cleared here rather than left to the last owner.
    this.placed = false;
    this.bobPhase = Math.random() * Math.PI * 2;
    this.setTexture(ensurePickupTexture(this.scene, def.kind === 'shard' ? 'shard' : def.kind === 'relic' ? 'relic' : def.kind, def.colorInt));
    this.setPosition(Math.round(x), Math.round(y));
    this.setActive(true).setVisible(true).setAlpha(1).setScale(1);
    const body = this.body as Phaser.Physics.Arcade.Body;
    body.enable = true;
    body.reset(Math.round(x), Math.round(y));
    if (scatter) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 22 + Math.random() * 26;
      body.velocity.setTo(Math.cos(angle) * speed, Math.sin(angle) * speed);
      body.setDrag(90, 90);
    } else {
      body.velocity.setTo(0, 0);
    }
  }

  /** Returns true when collected. */
  step(deltaMs: number, playerX: number, playerY: number, pickupRadius: number): 'alive' | 'collected' | 'expired' {
    const dt = deltaMs / 1000;
    if (!this.placed) {
      this.remaining -= dt;
      if (this.remaining <= 0) return 'expired';
    }

    this.bobPhase += dt * 3;
    this.setScale(1 + Math.sin(this.bobPhase) * 0.08);
    if (this.remaining < 4) {
      this.setAlpha(0.4 + Math.abs(Math.sin(this.remaining * 6)) * 0.6);
    } else {
      this.setAlpha(1);
    }

    const body = this.body as Phaser.Physics.Arcade.Body;
    const distance = Phaser.Math.Distance.Between(this.x, this.y, playerX, playerY);
    const magnetRange = Math.max(PICKUP_CONFIG.magnetRadius, pickupRadius);
    if (distance <= magnetRange) {
      const angle = Math.atan2(playerY - this.y, playerX - this.x);
      const strength = 40 + (1 - distance / magnetRange) * 90;
      body.velocity.x += Math.cos(angle) * strength * dt * 8;
      body.velocity.y += Math.sin(angle) * strength * dt * 8;
      body.velocity.limit(PICKUP_CONFIG.speed * 2);
    }
    return 'alive';
  }

  retire(): void {
    this.gathering = false;
    this.setActive(false).setVisible(false);
    const body = this.body as Phaser.Physics.Arcade.Body | null;
    if (body) {
      body.stop();
      body.enable = false;
    }
  }
}
