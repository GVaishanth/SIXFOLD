import gsap from 'gsap';

/** Anything GSAP can animate. Kept structural so the module has no GSAP type deps. */
type Node = HTMLElement | SVGElement | Element;
type Target = Node | Node[] | string | NodeListOf<Node>;

/**
 * Motion system.
 *
 * One vocabulary for the whole interface so a screen, a plaque, a bar and a
 * denied button all move with the same easing and the same sense of weight.
 * Every helper is (a) reduced-motion aware and (b) scoped to the screen that
 * created it, so unmounting reverts the DOM instead of leaving tweens running.
 *
 * Motion here communicates state, cause and importance. It is never ambient:
 * no infinite float on menus, no idle pulse on buttons, nothing animating
 * because it can.
 */

export const MOTION = {
  dur: { tin: 0.09, fast: 0.14, base: 0.2, slow: 0.32, reveal: 0.52, exit: 0.14 },
  ease: {
    out: 'power2.out',
    inOut: 'power3.inOut',
    spring: 'back.out(1.7)',
    settle: 'power1.out',
    in: 'power2.in',
  },
  stagger: 0.026,
  travel: 24,
} as const;

let reduced = false;

/** Driven by the accessibility setting plus `prefers-reduced-motion`. */
export function setReducedMotion(value: boolean): void {
  reduced = value;
  document.documentElement.dataset.reducedMotion = value ? 'true' : 'false';
}

export function isReducedMotion(): boolean {
  return reduced;
}

/** Below this, an animation is only a dropped frame. */
const INSTANT = 0.03;

function duration(value: number): number {
  return reduced ? Math.min(value, INSTANT) : value;
}

function staggerStep(value: number): number {
  return reduced ? 0 : value;
}

/* ------------------------------- screens -------------------------------- */

/**
 * Screen entrance. Children tagged `data-anim` rise in behind the container;
 * `data-anim="lead"` (the title) goes first and settles from a wider tracking,
 * which reads as the screen *focusing* rather than popping into the DOM.
 *
 * Returns the teardown that reverts every inline transform GSAP wrote.
 */
export function enterScreen(root: HTMLElement | null, direction = 1): (() => void) | undefined {
  if (!root) return undefined;
  const ctx = gsap.context(() => {
    const lead = Array.from(root.querySelectorAll<HTMLElement>('[data-anim="lead"]'));
    const rest = Array.from(root.querySelectorAll<HTMLElement>('[data-anim]:not([data-anim="lead"])'));
    if (reduced) {
      gsap.set([root, ...lead, ...rest], { clearProps: 'opacity,visibility,transform' });
      return;
    }
    gsap.fromTo(
      root,
      { autoAlpha: 0, y: MOTION.travel * 0.35 * direction },
      { autoAlpha: 1, y: 0, duration: duration(MOTION.dur.base), ease: MOTION.ease.out, overwrite: 'auto' },
    );
    if (lead.length) {
      gsap.from(lead, {
        autoAlpha: 0,
        y: -MOTION.travel * 0.4,
        letterSpacing: '0.6em',
        duration: duration(MOTION.dur.slow),
        ease: MOTION.ease.inOut,
        overwrite: 'auto',
      });
    }
    /* Screens that do not tag their own blocks still get a staggered entrance:
       the direct children are the honest unit of "what appeared". */
    const targets: Node[] = rest.length
      ? rest
      : (Array.from(root.children) as HTMLElement[]).filter((el) => el.dataset.anim !== 'skip').slice(0, 12);
    if (targets.length) {
      gsap.from(targets, {
        autoAlpha: 0,
        y: MOTION.travel * direction,
        duration: duration(MOTION.dur.base),
        ease: MOTION.ease.out,
        stagger: staggerStep(MOTION.stagger),
        delay: staggerStep(0.04),
        overwrite: 'auto',
        clearProps: 'transform',
      });
    }
  }, root);
  return () => ctx.revert();
}

/** Exit, awaited before navigation actually swaps the route. */
export function exitScreen(root: HTMLElement | null, direction = -1): Promise<void> {
  if (!root || reduced) return Promise.resolve();
  return new Promise((resolve) => {
    gsap.to(root, {
      autoAlpha: 0,
      y: MOTION.travel * 0.5 * direction,
      duration: MOTION.dur.exit,
      ease: MOTION.ease.in,
      onComplete: () => resolve(),
    });
  });
}

/* --------------------------- interaction states --------------------------- */

export function hoverIn(target: Target): void {
  if (reduced) return;
  gsap.to(target, { y: -1, duration: duration(MOTION.dur.tin), ease: MOTION.ease.out, overwrite: 'auto' });
}

export function hoverOut(target: Target): void {
  if (reduced) return;
  gsap.to(target, { y: 0, duration: duration(MOTION.dur.fast), ease: MOTION.ease.settle, overwrite: 'auto' });
}

/** Physical compression: the interface has weight and resists you. */
export function press(target: Target): void {
  if (reduced) return;
  gsap.to(target, { scale: 0.972, y: 1, duration: 0.07, ease: MOTION.ease.in, overwrite: 'auto' });
}

export function release(target: Target): void {
  if (reduced) return;
  gsap.to(target, { scale: 1, y: 0, duration: 0.24, ease: MOTION.ease.spring, overwrite: 'auto' });
}

/** The action was refused. One short lateral beat, then stillness. */
export function deny(target: Node | null): void {
  if (!target || reduced) return;
  const tl = gsap.timeline();
  tl.to(target, { x: -3, duration: 0.05, ease: 'power1.out' })
    .to(target, { x: 3, duration: 0.05, ease: 'power1.inOut' })
    .to(target, { x: -2, duration: 0.05, ease: 'power1.inOut' })
    .to(target, { x: 0, duration: 0.07, ease: MOTION.ease.settle })
    .to(target, { borderColor: 'rgba(255, 92, 108, 0.9)', duration: 0.12, yoyo: true, repeat: 1 }, 0);
}

/** Confirmed: a single sweep of approval, never a loop. */
export function success(target: Node | null): void {
  if (!target || reduced) return;
  const tl = gsap.timeline();
  tl.to(target, { scale: 1.014, duration: 0.1, ease: MOTION.ease.out })
    .to(target, { scale: 1, duration: 0.22, ease: MOTION.ease.spring }, '>0.02')
    .fromTo(
      target,
      { boxShadow: '0 0 0 0 rgba(107, 227, 154, 0.5)' },
      { boxShadow: '0 0 0 5px rgba(107, 227, 154, 0)', duration: 0.42, ease: MOTION.ease.out },
      0,
    );
}

/** Locked: a restrained knock, clearly different from an error. */
export function locked(target: Node | null): void {
  if (!target || reduced) return;
  gsap.fromTo(
    target,
    { x: 0 },
    {
      x: -1.5,
      duration: 0.05,
      ease: 'power1.inOut',
      yoyo: true,
      repeat: 3,
      onComplete: () => gsap.set(target, { x: 0 }),
    },
  );
}

/* ------------------------------- reveals -------------------------------- */

export function popIn(target: Target | null, fromScale = 0.88): void {
  if (!target || reduced) return;
  gsap.fromTo(
    target,
    { autoAlpha: 0, scale: fromScale },
    { autoAlpha: 1, scale: 1, duration: duration(MOTION.dur.slow), ease: MOTION.ease.spring, overwrite: 'auto' },
  );
}

/** Detail panels unfold; they do not replace each other instantly. */
export function unfold(target: Target): void {
  if (reduced) {
    gsap.set(target, { clearProps: 'opacity,transform' });
    return;
  }
  gsap.fromTo(
    target,
    { autoAlpha: 0, height: 0, y: -6 },
    { autoAlpha: 1, height: 'auto', y: 0, duration: duration(MOTION.dur.base), ease: MOTION.ease.out, overwrite: 'auto' },
  );
}

/** Staggered list reveal for reward rows, stat lines, codex entries. */
export function staggerIn(targets: HTMLElement[], axis: 'y' | 'x' = 'y', amount = MOTION.travel * 0.5): void {
  if (!targets.length) return;
  if (reduced) {
    gsap.set(targets, { clearProps: 'opacity,transform' });
    return;
  }
  gsap.from(targets, {
    autoAlpha: 0,
    [axis]: amount,
    duration: duration(MOTION.dur.base),
    ease: MOTION.ease.out,
    stagger: MOTION.stagger,
    overwrite: 'auto',
  });
}

/** Modal cards are *placed* into the world, not toggled in the DOM. */
export function modalIn(target: HTMLElement | null, card?: HTMLElement | null): void {
  if (!target || reduced) return;
  gsap.fromTo(target, { autoAlpha: 0 }, { autoAlpha: 1, duration: duration(MOTION.dur.fast), ease: MOTION.ease.out });
  if (card) {
    gsap.fromTo(
      card,
      { autoAlpha: 0, y: 16, scale: 0.98 },
      { autoAlpha: 1, y: 0, scale: 1, duration: duration(MOTION.dur.slow), ease: MOTION.ease.spring },
    );
  }
}

export function modalOut(layer: HTMLElement | null, card?: HTMLElement | null): Promise<void> {
  if (!layer || reduced) return Promise.resolve();
  return new Promise((resolve) => {
    const tl = gsap.timeline({ onComplete: () => resolve() });
    if (card) tl.to(card, { autoAlpha: 0, y: 8, scale: 0.99, duration: MOTION.dur.fast, ease: MOTION.ease.in }, 0);
    tl.to(layer, { autoAlpha: 0, duration: MOTION.dur.fast, ease: MOTION.ease.in }, 0);
  });
}

/* ---------------------------------- HUD ----------------------------------- */

/** Bars tween to their new value; a stepped bar reads as broken data. */
export function barFill(el: HTMLElement | null, ratio: number, ms = 180): void {
  if (!el) return;
  const width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  if (reduced) {
    el.style.width = width;
    return;
  }
  gsap.to(el, { width, duration: Math.min(ms / 1000, duration(ms / 1000)), ease: MOTION.ease.out, overwrite: 'auto' });
}

/** A counter that changed says so, once. */
export function valueBump(el: HTMLElement | null, strong = false): void {
  if (!el || reduced) return;
  gsap.fromTo(
    el,
    { scale: strong ? 1.22 : 1.11 },
    { scale: 1, duration: strong ? 0.34 : 0.2, ease: MOTION.ease.spring, overwrite: 'auto' },
  );
}

/** A cooldown becoming available: one finite ring pulse. */
export function readyPulse(el: HTMLElement | null, rgb = '242, 201, 107'): void {
  if (!el || reduced) return;
  gsap.fromTo(
    el,
    { boxShadow: `0 0 0 0px rgba(${rgb}, 0.55)` },
    { boxShadow: `0 0 0 7px rgba(${rgb}, 0)`, duration: 0.42, ease: MOTION.ease.out, overwrite: 'auto' },
  );
}

/** Damage taken: the vitals block jolts away from the hit. */
export function hurt(el: HTMLElement | null): void {
  if (!el || reduced) return;
  gsap.fromTo(
    el,
    { x: 0 },
    {
      x: 0,
      keyframes: [
        { x: -2.5, duration: 0.05 },
        { x: 2, duration: 0.05 },
        { x: 0, duration: 0.08 },
      ],
      ease: MOTION.ease.settle,
      overwrite: 'auto',
    },
  );
}

/* ------------------------------- scene beat ------------------------------- */

/**
 * Full-bleed elemental wipe for transitions that are part of the game
 * (entering a run, a chapter change) — never for ordinary menu navigation.
 */
export function wipe(color = '#F2C96B', holdMs = 110): Promise<void> {
  if (reduced) return Promise.resolve();
  return new Promise((resolve) => {
    const veil = document.createElement('div');
    veil.setAttribute('aria-hidden', 'true');
    veil.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:26',
      'pointer-events:none',
      `background:linear-gradient(180deg, transparent 0%, ${color} 44%, ${color} 56%, transparent 100%)`,
      'transform:scaleY(0)',
      'transform-origin:50% 50%',
      'mix-blend-mode:screen',
      'opacity:0.45',
    ].join(';');
    document.body.appendChild(veil);
    const tl = gsap.timeline({
      onComplete: () => {
        veil.remove();
        resolve();
      },
    });
    tl.to(veil, { scaleY: 1, opacity: 0.4, duration: 0.16, ease: MOTION.ease.inOut })
      .to(veil, { opacity: 0.16, duration: holdMs / 1000, ease: 'none' })
      .to(veil, { scaleY: 0.001, opacity: 0, duration: 0.2, ease: MOTION.ease.out });
  });
}

/** Number roll for reveals: rewards gained, essence, mastery steps. */
export function countTo(
  el: HTMLElement | null,
  from: number,
  to: number,
  format: (value: number) => string = (value) => String(Math.round(value)),
): void {
  if (!el) return;
  if (reduced) {
    el.textContent = format(to);
    return;
  }
  const state = { value: from };
  gsap.to(state, {
    value: to,
    duration: 0.5,
    ease: MOTION.ease.out,
    onUpdate: () => {
      el.textContent = format(state.value);
    },
    onComplete: () => {
      el.textContent = format(to);
    },
  });
}

/**
 * Energy travelling along a connection — used by the skill tree so an unlocked
 * branch reads as a live circuit. Finite by design: `repeats` is explicit and
 * the caller kills it when the screen closes.
 */
export function flowAlong(targets: Target, distance: number, repeats = -1, speed = 1.6): gsap.core.Tween {
  return gsap.to(targets, {
    strokeDashoffset: -distance,
    duration: reduced ? 0.001 : speed,
    ease: 'none',
    repeat: reduced ? 0 : repeats,
  });
}

/**
 * Timed schedule for event furniture (boss plate, wave strip, chapter card).
 *
 * Components must not import GSAP directly, and a stager written with nested
 * `setTimeout`s leaks when the screen unmounts mid-sequence — so the beats live
 * here: fire `step(index)` at each cumulative mark, and call the returned
 * teardown to cancel whatever has not happened yet. Reduced motion collapses
 * the whole sequence to a single immediate step.
 */
export function scheduleBeats(step: (index: number) => void, marks: number[]): () => void {
  if (reduced) {
    marks.forEach((_, index) => step(index));
    return () => undefined;
  }
  let elapsed = 0;
  const ids = marks.map((ms, index) => {
    elapsed += ms;
    return window.setTimeout(() => step(index), elapsed);
  });
  return () => ids.forEach((id) => window.clearTimeout(id));
}

/** Finite exit for event furniture, so nothing in this game only ever appears. */
export function fadeOut(el: HTMLElement | null, ms = 140, lift = 8): Promise<void> {
  if (!el || reduced) return Promise.resolve();
  return new Promise((resolve) => {
    gsap.to(el, {
      autoAlpha: 0,
      y: -lift,
      duration: Math.max(MOTION.dur.exit, ms / 1000),
      ease: MOTION.ease.in,
      onComplete: () => resolve(),
    });
  });
}

/** A rule that draws itself once, left to right — used under boss names and titles. */
export function drawLine(el: HTMLElement | null, ms = 420): void {
  if (!el) return;
  if (reduced) {
    el.style.transform = 'scaleX(1)';
    return;
  }
  gsap.fromTo(
    el,
    { scaleX: 0, transformOrigin: 'left center' },
    { scaleX: 1, duration: duration(ms / 1000), ease: MOTION.ease.inOut, overwrite: 'auto' },
  );
}

/** Kill everything this module started on a subtree (screen teardown). */
export function killMotion(target: Target): void {
  gsap.killTweensOf(target);
}
