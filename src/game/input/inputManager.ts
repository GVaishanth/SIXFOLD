import Phaser from 'phaser';
import type { PlayerInputState } from '@/game/entities/Player';

export interface InputHooks {
  onPause: () => void;
  onSwitchSlot: (slot: number) => void;
  onCycleElement: (direction: 1 | -1) => void;
  onSkill: () => void;
  onUltimate: () => void;
  onDash: () => void;
}

/**
 * Unified input.
 *
 * Desktop keyboard + mouse are read here; touch controls live in React (for
 * safe-area handling and large touch targets) and push their state through the
 * event bus, which calls the `setTouch*` methods below. Both paths feed the
 * same `PlayerInputState`, so gameplay code never branches on platform.
 */
export class InputManager {
  private scene: Phaser.Scene;
  private keys: Record<string, Phaser.Input.Keyboard.Key> = {};
  private hooks: InputHooks;
  private pointerDown = false;
  private pointerWorld = new Phaser.Math.Vector2();
  private touchMove = new Phaser.Math.Vector2();
  private touchAttack = false;
  private touchSkill = false;
  private touchUltimate = false;
  private touchDash = false;
  private touchAimPoint: { x: number; y: number } | null = null;
  private attackLatched = false;
  private skillLatched = false;
  private ultimateLatched = false;
  private dashLatched = false;
  private disposers: (() => void)[] = [];

  constructor(scene: Phaser.Scene, hooks: InputHooks) {
    this.scene = scene;
    this.hooks = hooks;

    const keyboard = scene.input.keyboard;
    if (keyboard) {
      const codes = [
        'W', 'A', 'S', 'D',
        'UP', 'DOWN', 'LEFT', 'RIGHT',
        'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX',
        'E', 'Q', 'SPACE', 'ESC', 'TAB',
      ];
      for (const code of codes) {
        const key = keyboard.addKey(code as Parameters<typeof keyboard.addKey>[0], false, false);
        this.keys[code] = key;
      }
      // Number keys 1..6 switch elements.
      for (let i = 0; i < 6; i += 1) {
        const names = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX'] as const;
        const key = this.keys[names[i]];
        if (!key) continue;
        const handler = () => this.hooks.onSwitchSlot(i);
        key.on('down', handler);
        this.disposers.push(() => key.off('down', handler));
      }
      const qKey = this.keys.Q;
      if (qKey) {
        const handler = () => {
          this.ultimateLatched = true;
        };
        qKey.on('down', handler);
        this.disposers.push(() => qKey.off('down', handler));
      }
      const eKey = this.keys.E;
      if (eKey) {
        const handler = () => {
          this.skillLatched = true;
        };
        eKey.on('down', handler);
        this.disposers.push(() => eKey.off('down', handler));
      }
      const space = this.keys.SPACE;
      if (space) {
        const handler = () => {
          this.dashLatched = true;
        };
        space.on('down', handler);
        this.disposers.push(() => space.off('down', handler));
      }
      const esc = this.keys.ESC;
      if (esc) {
        const handler = () => this.hooks.onPause();
        esc.on('down', handler);
        this.disposers.push(() => esc.off('down', handler));
      }
      const wheelHandler = (
        pointer: Phaser.Input.Pointer,
        _objects: unknown,
        _dx: number,
        dy: number,
      ) => {
        void pointer;
        void _objects;
        if (dy !== 0) this.hooks.onCycleElement(dy > 0 ? 1 : -1);
      };
      scene.input.on('wheel', wheelHandler);
      this.disposers.push(() => scene.input.off('wheel', wheelHandler));
    }

    const canvas = scene.game.canvas;
    const preventMenu = (event: Event) => event.preventDefault();
    canvas.addEventListener('contextmenu', preventMenu);
    this.disposers.push(() => canvas.removeEventListener('contextmenu', preventMenu));

    const downHandler = (pointer: Phaser.Input.Pointer) => {
      if (pointer.leftButtonDown() || pointer.wasTouch) {
        this.pointerDown = true;
        this.attackLatched = true;
      }
    };
    const upHandler = () => {
      this.pointerDown = false;
    };
    const moveHandler = (pointer: Phaser.Input.Pointer) => {
      this.pointerWorld.set(pointer.worldX, pointer.worldY);
    };
    scene.input.on('pointerdown', downHandler);
    scene.input.on('pointerup', upHandler);
    scene.input.on('pointerupoutside', upHandler);
    scene.input.on('pointermove', moveHandler);
    this.disposers.push(() => {
      scene.input.off('pointerdown', downHandler);
      scene.input.off('pointerup', upHandler);
      scene.input.off('pointerupoutside', upHandler);
      scene.input.off('pointermove', moveHandler);
    });
  }

  /* ------------------ touch/mobile API (from React) ------------------ */

  setTouchMovement(x: number, y: number): void {
    this.touchMove.set(x, y);
  }

  setTouchButtons(state: { attack?: boolean; skill?: boolean; ultimate?: boolean; dash?: boolean }): void {
    if (state.attack !== undefined) {
      if (state.attack && !this.touchAttack) this.attackLatched = true;
      this.touchAttack = state.attack;
    }
    if (state.skill !== undefined) {
      if (state.skill && !this.touchSkill) this.skillLatched = true;
      this.touchSkill = state.skill;
    }
    if (state.ultimate !== undefined) {
      if (state.ultimate && !this.touchUltimate) this.ultimateLatched = true;
      this.touchUltimate = state.ultimate;
    }
    if (state.dash !== undefined) {
      if (state.dash && !this.touchDash) this.dashLatched = true;
      this.touchDash = state.dash;
    }
  }

  setTouchAim(point: { x: number; y: number } | null): void {
    this.touchAimPoint = point;
  }

  /** Aim assist strength 0..1 — mobile players should not need pixel-perfect aim. */
  private aimWithAssist(playerX: number, playerY: number, autoAim: number): { x: number; y: number; aiming: boolean } {
    if (this.touchAimPoint) {
      return { x: this.touchAimPoint.x, y: this.touchAimPoint.y, aiming: true };
    }
    if (this.pointerDown || this.scene.input.activePointer.wasTouch === false) {
      if (this.pointerWorld.lengthSq() > 1) {
        return { x: this.pointerWorld.x, y: this.pointerWorld.y, aiming: true };
      }
    }
    if (autoAim > 0.4) {
      return { x: playerX, y: playerY, aiming: false };
    }
    return { x: playerX + 20, y: playerY, aiming: false };
  }

  /** Build the input snapshot the player consumes this frame. */
  read(playerX: number, playerY: number, autoAim: number): PlayerInputState {
    const keyboard = this.scene.input.keyboard;
    let moveX = 0;
    let moveY = 0;
    if (keyboard) {
      const isDown = (code: string) => Boolean(this.keys[code]?.isDown);
      if (isDown('A') || isDown('LEFT')) moveX -= 1;
      if (isDown('D') || isDown('RIGHT')) moveX += 1;
      if (isDown('W') || isDown('UP')) moveY -= 1;
      if (isDown('S') || isDown('DOWN')) moveY += 1;
    }
    if (Math.abs(this.touchMove.x) > 0.01 || Math.abs(this.touchMove.y) > 0.01) {
      moveX = this.touchMove.x;
      moveY = this.touchMove.y;
    }
    if (moveX !== 0 && moveY !== 0) {
      const length = Math.hypot(moveX, moveY);
      if (length > 1) {
        moveX /= length;
        moveY /= length;
      }
    }

    const aim = this.aimWithAssist(playerX, playerY, autoAim);
    const state: PlayerInputState = {
      moveX,
      moveY,
      attack: this.pointerDown || this.touchAttack || this.attackLatched,
      skill: this.touchSkill || this.skillLatched,
      ultimate: this.touchUltimate || this.ultimateLatched,
      dash: this.touchDash || this.dashLatched,
      aimX: aim.x,
      aimY: aim.y,
      aiming: aim.aiming,
    };
    this.attackLatched = false;
    this.skillLatched = false;
    this.ultimateLatched = false;
    this.dashLatched = false;
    return state;
  }

  /** Hold-to-attack stays active while the button is held; latches cover taps. */
  get wantsDash(): boolean {
    return this.touchDash || this.dashLatched;
  }

  destroy(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.keys = {};
    this.touchAimPoint = null;
  }
}
