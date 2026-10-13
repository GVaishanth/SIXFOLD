/**
 * Mobile UI audit.
 *
 * Drives the game on real phone and tablet shapes and measures the things that
 * decide whether a touch build is usable, rather than how it looks in a
 * screenshot: touch-target size, occlusion of the play area by the controls,
 * whether text is legible at the device's own pixel size, horizontal overflow,
 * scroll containment, safe-area handling, and how big the sprites actually end
 * up on screen once the viewport system has chosen its zoom.
 *
 * Usage:
 *   node tools/mobile-audit.mjs                    # every device shape
 *   NODE=1 SIXFOLD_URL=http://localhost:5173/ node tools/mobile-audit.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { HUD_PLATE_SELECTORS } from './hud-plates.mjs';

const require = createRequire(import.meta.url);
const URL_BASE = process.env.SIXFOLD_URL ?? 'http://localhost:5173/';
const OUT = process.env.OUT ?? '/home/user/audit/mobile-audit';
const MIN_TARGET = 40;
const MIN_FONT = 9.5;

const DEVICES = [
  { name: 'phone-portrait-small', width: 360, height: 640, dpr: 3 },
  { name: 'phone-portrait', width: 390, height: 844, dpr: 3 },
  { name: 'phone-large', width: 430, height: 932, dpr: 3 },
  { name: 'phone-landscape', width: 844, height: 390, dpr: 3 },
  { name: 'tablet-portrait', width: 820, height: 1180, dpr: 2 },
];

function playwright() {
  const npxRoot = path.join(homedir(), '.npm', '_npx');
  const candidates = [
    path.resolve('node_modules/playwright'),
    process.env.SIXFOLD_PLAYWRIGHT ?? '',
    ...(existsSync(npxRoot)
      ? readdirSync(npxRoot).map((d) => path.join(npxRoot, d, 'node_modules/playwright'))
      : []),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (!existsSync(path.join(candidate, 'package.json'))) continue;
      return require(candidate);
    } catch {
      /* next */
    }
  }
  throw new Error('playwright is not resolvable — install it or set SIXFOLD_PLAYWRIGHT');
}

const { chromium } = playwright();
fs.mkdirSync(OUT, { recursive: true });

/** Runs inside the page: everything measurable about the current screen. */
/**
 * The wave announcement and the countdown, measured while *both* are up.
 *
 * This file used to wait past the countdown before measuring, which is precisely the half-second the two
 * centre overlays share the middle of the frame for — so the pair had never been measured at any shape.
 * The announcement is raised on purpose instead of hoped for, and the used colours are read back rather
 * than assumed: a plate whose fill is the arena's own colour is a plate nobody sees.
 */
const WAVE_START_SCAN = (plateSelsIn) => {
  if (!Array.isArray(plateSelsIn)) throw new Error('WAVE_START_SCAN: the HUD plate list must be passed in');
  const bus = window.__sixfoldBus;
  if (!bus) return { notReached: 'no dev bus in this bundle, so the announcement cannot be raised on purpose' };
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) };
  };
  const lum = (color) => {
    const parts = (color.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map((v) => Number(v) / 255);
    return parts
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0);
  };
  const ratio = (a, b) => {
    const [hi, lo] = a > b ? [a, b] : [b, a];
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 10) / 10;
  };
  const frame = () => new Promise((done) => requestAnimationFrame(done));
  return (async () => {
    let banner = null;
    let count = null;
    // The countdown plate only exists for a few seconds, and the pair is only worth measuring while the
    // announcement is up over it, so this polls frames rather than sleeping once and hoping.
    for (let i = 0; i < 300 && !(banner && count); i += 1) {
      await frame();
      count = box('.countdown-plate');
      if (!count) continue;
      bus.emit('game:waveStarted', { wave: 1, floor: 1, isBoss: false, label: 'MEASURED', total: 200 });
      banner = box('.banner');
    }
    if (!banner || !count) return { bothUp: false, why: `banner=${Boolean(banner)} countdown=${Boolean(count)} after 300 frames` };
    // The count pops in with a spring, so its box is briefly bigger than its layout box. One reading of the
    // pair is a reading of the layout, not of what the eye gets: sample across the pop and keep the worst.
    let minGap = count.t - banner.b;
    for (let i = 0; i < 20; i += 1) {
      await frame();
      bus.emit('game:waveStarted', { wave: 1, floor: 1, isBoss: false, label: 'MEASURED', total: 200 });
      const b2 = box('.banner');
      const c2 = box('.countdown-plate');
      if (!b2 || !c2) break;
      minGap = Math.min(minGap, c2.t - b2.b);
      banner = b2;
      count = c2;
    }
    const el = document.querySelector('.banner');
    const style = getComputedStyle(el);
    const title = el.querySelector('.banner-title');
    const sub = el.querySelector('.banner-sub');
    const clash = [];
    for (const sel of plateSelsIn) {
      if (sel === '.banner') continue;
      for (const other of document.querySelectorAll(sel)) {
        const cs = getComputedStyle(other);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
        const b = box(sel);
        if (!b) continue;
        if (Math.min(banner.b, b.b) - Math.max(banner.t, b.t) > 0 && Math.min(banner.r, b.r) - Math.max(banner.l, b.l) > 0) {
          clash.push(`.banner overlaps ${sel} ${JSON.stringify(b)}`);
        }
      }
    }
    const size = (node) => parseFloat(getComputedStyle(node).fontSize) || 0;
    return {
      banner: {
        bothUp: true,
        gap: count.t - banner.b,
        minGap,
        above: banner.t < count.t,
        inFrame: banner.t >= 0 && count.b <= window.innerHeight && banner.l >= 0 && banner.r <= window.innerWidth,
        contrast: ratio(lum(style.backgroundColor), lum(getComputedStyle(title).color)),
        subContrast: ratio(lum(style.backgroundColor), lum(getComputedStyle(sub).color)),
        fill: style.backgroundColor,
        minFont: Math.min(size(title), size(sub)),
        zoom: window.__sixfoldGame?.scale?.displaySize?.width ? Math.round((window.__sixfoldGame.scale.displaySize.width / window.innerWidth) * 100) / 100 : 1,
      },
      plateClash: clash,
    };
  })();
};

const SCAN = (plateSelsIn) => {
  // The page evaluates this as a standalone function: constants it needs have
  // to live inside it, not in module scope. The plate list is the one thing worth sharing with the
  // other gate, so it arrives as an argument — and missing it is an error, not a silent no-op.
  if (!Array.isArray(plateSelsIn)) throw new Error('SCAN: the HUD plate list must be passed in');
  const MIN_TARGET = 40;
  const MIN_FONT = 9.5;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const inViewport = (r) =>
    r.width > 0 &&
    r.height > 0 &&
    r.bottom > -1 &&
    r.top < vh + 1 &&
    r.right > -1 &&
    r.left < vw + 1;
  const vis = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  };
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const boxRect = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });

  /* --- 1. layout: overflow and page-level scrolling --------------------- */
  const doc = document.documentElement;
  const layout = {
    overflowX: doc.scrollWidth - doc.clientWidth,
    bodyScrolls: doc.scrollHeight > doc.clientHeight + 1,
    scrollable: Array.from(document.querySelectorAll('body *'))
      .filter(
        (el) =>
          el.scrollHeight > el.clientHeight + 4 &&
          ['auto', 'scroll'].includes(getComputedStyle(el).overflowY) &&
          vis(el),
      )
      .map((el) => `${el.className.toString().split(' ')[0]}:${el.scrollHeight - el.clientHeight}px`),
  };

  /* --- 2. touch targets -------------------------------------------------- */
  const interactive = Array.from(
    document.querySelectorAll('button, [role="button"], a[href], input, select, [tabindex="0"]'),
  ).filter((el) => vis(el) && inViewport(el.getBoundingClientRect()));
  const targets = interactive.map((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      label: (el.getAttribute('aria-label') || el.textContent || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 26),
      w: Math.round(r.width),
      h: Math.round(r.height),
      touchAction: cs.touchAction,
      userSelect: cs.userSelect,
      radius: cs.borderRadius,
      // Contrast-ish proxy: font size against its own control height.
      font: Math.round(parseFloat(cs.fontSize) * 10) / 10,
    };
  });
  const smallTargets = targets
    .filter((t) => Math.min(t.w, t.h) < MIN_TARGET)
    .sort((a, b) => Math.min(a.w, a.h) - Math.min(b.w, b.h))
    .slice(0, 12);
  const badTouchAction = targets.filter((t) => t.touchAction === 'auto' && t.h > 0 && t.h < 60);

  /* --- 3. legibility ----------------------------------------------------- */
  const texts = Array.from(document.querySelectorAll('.hud *, .screen *, [class^="touch-"], [class*=" touch-"], .overlay-card *'))
    .filter((el) => el.children.length === 0 && (el.textContent || '').trim().length > 0 && vis(el))
    .map((el) => ({
      t: el.textContent.trim().slice(0, 22),
size:
          // SVG text is authored in user units, so the computed font-size is not what
          // reaches the screen — scale it by the element's own CTM before judging it.
          Math.round(
            parseFloat(getComputedStyle(el).fontSize) * (el.getScreenCTM?.()?.a ?? 1) * 10,
          ) / 10,
      cls: el.className.toString().split(' ')[0],
    }));
  const tinyText = texts
    .filter((x) => x.size < MIN_FONT)
    .sort((a, b) => a.size - b.size)
    .slice(0, 10);

  /* --- 4. occlusion: do the controls cover anything you must read? ------- */
  const rectOf = (sel) => {
    const el = document.querySelector(sel);
    return el && vis(el) ? el.getBoundingClientRect() : null;
  };
  const controlRects = ['.touch-zone', '.touch-actions', '.hud-bottom', '.touch-btn-attack']
    .map((sel) => ({ sel: sel.replace('.', ''), r: rectOf(sel) }))
    .filter((x) => x.r);
  const hudRects = ['.hud-tl', '.hud-tc', '.hud-tr', '.vitals', '.floor-plate', '.boss-plate', '.element-rail', '.ability-cluster']
    .map((sel) => ({ sel: sel.replace('.', ''), r: rectOf(sel) }))
    .filter((x) => x.r);
  const collide = [];
  for (const a of controlRects) {
    for (const b of hudRects) {
      const x = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const y = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (x > 2 && y > 2) collide.push(`${a.sel} x ${b.sel} (${Math.round(x)}x${Math.round(y)})`);
    }
  }
  // Do controls overlap each other (joystick vs buttons)?
  for (let i = 0; i < controlRects.length; i += 1) {
    for (let j = i + 1; j < controlRects.length; j += 1) {
      const a = controlRects[i].r;
      const b = controlRects[j].r;
      const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (x > 2 && y > 2) collide.push(`controls: ${controlRects[i].sel} x ${controlRects[j].sel} (${Math.round(x)}x${Math.round(y)})`);
    }
  }

  /* --- 5. reachability: is the control you must press actually pressable? --
     * `interactive` already drops anything a `display:none` ancestor hides and
     * anything with no box, so what is left is measured for three ways of failing:
     * past the edge of the frame, behind another element, and (the shape this was
     * written for) a wide-but-short landscape phone that lays the hub out as if it
     * had a thousand pixels of height. */
  const scrollerOf = (el) => {
    let n = el.parentElement;
    while (n && n !== document.body) {
      const cs = getComputedStyle(n);
      if (['auto', 'scroll'].includes(cs.overflowY) && n.scrollHeight > n.clientHeight + 4) return true;
      n = n.parentElement;
    }
    return false;
  };
  const reachable = Array.from(
    document.querySelectorAll('.hud button, .touch-layer button, .touch-layer [role=\"presentation\"]'),
  )
    .filter((el) => vis(el))
    .map((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const top = cx >= 0 && cy >= 0 && cx < vw && cy < vh ? document.elementFromPoint(cx, cy) : null;
      const covered = Boolean(top) && !(el === top || el.contains(top) || top.contains(el));
      return {
        label: (el.getAttribute('aria-label') || el.textContent || el.className).replace(/\s+/g, ' ').trim().slice(0, 26),
        r: box(el),
        offFrame: r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1,
        scrolls: scrollerOf(el),
        covered: covered ? `${top.tagName.toLowerCase()}.${top.className.toString().split(' ')[0]}` : '',
      };
    });
  const unreachable = reachable.filter((c) => (c.offFrame && !c.scrolls) || c.covered);
  const strandedByScroll = reachable.filter((c) => c.offFrame && c.scrolls).length;

  /* --- 6. plates against plates -----------------------------------------
     * The old occlusion pass only ever compared the pads with the top-row plates,
     * so the wave countdown — which is centred in the frame and lands on the wave
     * plate as soon as the frame is short — could not be reported. Containment is
     * not a collision, so those pairs are dropped. */
  const plateSels = plateSelsIn;
  const plates = plateSels
    .map((sel) => {
      const el = document.querySelector(sel);
      return el && vis(el) ? { sel: sel.replace('.', ''), el, r: el.getBoundingClientRect() } : null;
    })
    .filter(Boolean);
  const plateClash = [];
  for (let i = 0; i < plates.length; i += 1) {
    for (let j = i + 1; j < plates.length; j += 1) {
      const a = plates[i];
      const b = plates[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const x = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const y = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (x > 2 && y > 2) plateClash.push(`${a.sel} x ${b.sel} (${Math.round(x)}x${Math.round(y)})`);
    }
  }

  /* --- 7. the pause door: a phone has no Escape key --------------------- */
  const menuButton = document.querySelector('.hud-menu-btn');
  const menu = {
    present: Boolean(menuButton),
    box: menuButton ? box(menuButton) : null,
    pressable: Boolean(menuButton && vis(menuButton) && (() => {
      const r = menuButton.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return top && (menuButton === top || menuButton.contains(top) || top.contains(menuButton));
    })()),
  };

  /* --- 8. a short frame should not be a scrolling column of desktop ------ */
  const screen = document.querySelector('.screen');
  const depth = screen && screen.clientHeight > 0 ? Math.round((screen.scrollHeight / screen.clientHeight) * 10) / 10 : null;

  /* --- focus visibility -------------------------------------------------- */
  const focusable = interactive.length;

  return {
    frame: [vw, vh],
    dpr: window.devicePixelRatio,
    layout,
    targets: { count: focusable, smallest: smallTargets, badTouchAction: badTouchAction.length },
    tinyText,
    collide,
    controls: controlRects.map((c) => ({ sel: c.sel, r: boxRect(c.r) })),
    hud: hudRects.map((h) => ({ sel: h.sel, r: boxRect(h.r) })),
    unreachable,
    strandedByScroll,
    plateClash,
    menu,
    depth,
    content: screen ? { sh: screen.scrollHeight, ch: screen.clientHeight } : null,
  };
};

/** The live world measurements, only available on the dev server. */
const WORLD = () => {
  const game = window.__sixfoldGame;
  if (!game) return { dev: false };
  const scene = game.scene.getScene('GameplayScene');
  if (!scene) return { dev: true, playing: false };
  const cam = game.scale.gameSize;
  const camera = scene.cameras?.main;
  const rect = game.canvas.getBoundingClientRect();
  const cssPerWorld = rect.width / game.scale.width;
  const player = scene.player?.getBounds?.();
  const enemies = scene.enemies ? scene.enemies.getChildren().filter((e) => e.active) : [];
  const view = camera?.worldView ?? { x: 0, y: 0 };
  const sample = enemies.slice(0, 10).map((e) => {
    const b = e.getBounds();
    return {
      id: e.def?.id ?? '?',
      // Where the sprite lands in CSS pixels, and whether a control is on top
      // of it — the one mobile rule that matters: never fight the thumb zone.
      css: {
        x: Math.round((b.x + b.width / 2 - view.x) * cssPerWorld),
        y: Math.round((b.y + b.height / 2 - view.y) * cssPerWorld),
        w: Math.round(b.width * cssPerWorld),
        h: Math.round(b.height * cssPerWorld),
      },
    };
  });
  return {
    dev: true,
    playing: true,
    buffer: [game.scale.width, game.scale.height],
    zoom: Math.round((cssPerWorld + Number.EPSILON) * 100) / 100,
    viewPx: view ? [Math.round(view.width), Math.round(view.height)] : null,
    cssCanvas: [Math.round(rect.width), Math.round(rect.height)],
    gameSize: [cam.width, cam.height],
    playerCss: player
      ? {
          w: Math.round(player.width * cssPerWorld),
          h: Math.round(player.height * cssPerWorld),
        }
      : null,
    enemyCount: enemies.length,
    enemies: sample,
    playerUnderControls: (() => {
      if (!player) return 0;
      const box = {
        x: (player.x + player.width / 2 - view.x) * cssPerWorld,
        y: (player.y + player.height / 2 - view.y) * cssPerWorld,
        w: player.width * cssPerWorld,
        h: player.height * cssPerWorld,
      };
      const zones = ['.touch-btn', '.joystick', '.touch-elements .element-slot']
        .flatMap((sel) => [...document.querySelectorAll(sel)])
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 2 && r.height > 2);
      return zones.some((z) => {
        const dx = Math.min(box.x + box.w / 2, z.right) - Math.max(box.x - box.w / 2, z.left);
        const dy = Math.min(box.y + box.h / 2, z.bottom) - Math.max(box.y - box.h / 2, z.top);
        return dx > 0 && dy > 0;
      })
        ? 1
        : 0;
    })(),
    padOpacity: (() => {
      const el = document.querySelector('.touch-btn');
      if (!el) return null;
      const bg = getComputedStyle(el).backgroundColor;
      const m = /rgba?\([^)]*?,\s*([\d.]+)\)/.exec(bg);
      return m ? Number(m[1]) : 1;
    })(),
    // The mobile rule this exists to catch: a hostile must never be behind a
    // thumb, because the tap that would have dodged it is already spent.
    // Only the boxes that actually paint something: a container that spans the
    // bottom band with transparent gaps is not covering anything, and counting
    // it would be a fake failure.
    underControls: (() => {
      const zones = ['.touch-btn', '.joystick', '.touch-elements .element-slot', '.rail-slot', '.ability']
        .flatMap((sel) => [...document.querySelectorAll(sel)])
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 2 && r.height > 2);
      return sample.filter((e) =>
        zones.some((z) => {
          const x = Math.min(e.css.x + e.css.w / 2, z.right) - Math.max(e.css.x - e.css.w / 2, z.left);
          const y = Math.min(e.css.y + e.css.h / 2, z.bottom) - Math.max(e.css.y - e.css.h / 2, z.top);
          return x > 0 && y > 0;
        }),
      ).length;
    })(),
    safe: (() => {
      const cs = getComputedStyle(document.querySelector('.app') ?? document.documentElement);
      const hud = getComputedStyle(document.querySelector('.hud') ?? document.body);
      return {
        top: cs.getPropertyValue('--safe-top').trim() || null,
        bottom: cs.getPropertyValue('--safe-bottom').trim() || null,
        hudPad: hud.padding,
      };
    })(),
  };
};

async function openRun(page) {
  await page.goto(URL_BASE, { waitUntil: 'load' });
  await page.waitForSelector('text=NEW WARDEN', { timeout: 40000 });
  await page.click('text=NEW WARDEN');
  await page.waitForSelector('text=THE VAULT');
  await page.click('.slot-plinth:has-text("RAISE A WARDEN")');
  await page.waitForSelector('text=CHOOSE YOUR FLAME');
  await page.locator('button', { hasText: 'BIND AND BEGIN' }).click();
  await page.waitForSelector('text=CREATE WARDEN');
  await page.locator('button', { hasText: 'CREATE WARDEN' }).click();
  await page.waitForSelector('text=STEP THROUGH', { timeout: 20000 });
}

const report = [];
// Vibration has no observable DOM effect, so the only honest check is to put a
// recorder where the platform API should be and count what the game asks for.
const VIBRATE_RECORDER = () => {
  window.__vibes = [];
  const record = (pattern) => window.__vibes.push(pattern);
  try {
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      writable: true,
      value: (pattern) => {
        record(pattern);
        return true;
      },
    });
  } catch {
    /* nothing else to do */
  }
};

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});

for (const device of DEVICES) {
  const entry = { device: device.name, screens: {} };
  const page = await browser.newPage({
    viewport: { width: device.width, height: device.height },
    deviceScaleFactor: device.dpr,
    hasTouch: true,
    isMobile: true,
  });
  // An init script only applies to navigations after it is registered, so this
  // has to come before openRun() — installing it later measures nothing.
  await page.addInitScript(VIBRATE_RECORDER);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });

  await openRun(page);

  // Meta viewport + PWA-ish wiring, checked once per device shape.
  entry.head = await page.evaluate(() => {
    const meta = document.querySelector('meta[name="viewport"]');
    return {
      viewport: meta?.getAttribute('content') ?? null,
      themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null,
      touchActionOnHtml: getComputedStyle(document.documentElement).touchAction,
      userSelectOnBody: getComputedStyle(document.body).userSelect,
      title: document.title,
    };
  });

  await page.screenshot({ path: `${OUT}/${device.name}-01-hub.png` });
  entry.screens.hub = await page.evaluate(SCAN, HUD_PLATE_SELECTORS);

  await page.click('text=STEP THROUGH');
  // First, while the wave is opening: the announcement and the count share the middle of the frame for
  // half a second and that is the moment the pair has to be right. Only then measure the arena.
  entry.screens.wavestart = await page.evaluate(WAVE_START_SCAN, HUD_PLATE_SELECTORS);
  await page.screenshot({ path: `${OUT}/${device.name}-01b-wavestart.png` });
  // The countdown gate holds enemies back; measuring during it would report an
  // empty arena, so wait until the wave is actually live.
  // The wave opens on a countdown, so the objective line reads "CLEAR n
  // HOSTILES" while the arena is still empty. Wait for the director to be
  // fighting with live bodies, or the world numbers below measure nothing.
  await page.waitForTimeout(1200);
  await page
    .waitForFunction(
      () => {
        const scene = window.__sixfoldGame?.scene?.getScene('GameplayScene');
        if (!scene) return true; // production build: no dev handle, DOM-only scan
        return (
          scene.director?.state === 'fighting' &&
          scene.enemies?.getChildren?.().some((e) => e.active) === true
        );
      },
      null,
      { timeout: 90000, polling: 500 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${OUT}/${device.name}-02-play.png` });
  // A camera effect that never returns to its base is invisible to every other check in
  // this file — it changes no layout — so it is measured here, after the frame has been
  // given every reason to punch: a wave of attacks and a boss.
  const camState = () =>
    page.evaluate(() => {
      const scene = window.__sixfoldGame?.scene?.getScene('GameplayScene');
      if (!scene) return null;
      return {
        zoom: Number(scene.cameras.main.zoom.toFixed(4)),
        sceneTs: Number(scene.time.timeScale.toFixed(3)),
        physicsTs: Number(scene.physics.world.timeScale.toFixed(3)),
      };
    });
  await page.keyboard.press('Space');
  await page.waitForTimeout(320);
  await page.keyboard.press('Space');
  await page.waitForTimeout(900);
  const camPlaying = await camState();
  entry.screens.playing = { ...(await page.evaluate(SCAN, HUD_PLATE_SELECTORS)), world: await page.evaluate(WORLD), camera: camPlaying };

  // Haptics (§23). The recorder replaces navigator.vibrate, so this measures
  // what the game *asked the platform for*, not a claim in a comment.
  await page.evaluate(() => {
    window.__vibes = [];
  });
  for (const selector of ['.touch-btn.primary', '.touch-btn', '.touch-elements [class^="touch-"]', '.touch-elements .element-slot']) {
    const target = page.locator(selector).first();
    if (await target.count().catch(() => 0)) {
      await target.tap().catch(() => target.click().catch(() => undefined));
      await page.waitForTimeout(220);
    }
  }
  const vibes = await page.evaluate(() => window.__vibes ?? []);
  entry.screens.playing.haptics = { calls: vibes.length, patterns: vibes.slice(0, 6) };

  // Pause card.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/${device.name}-03-pause.png` });
  entry.screens.pause = { ...(await page.evaluate(SCAN, HUD_PLATE_SELECTORS)), camera: await camState() };

  // Skill tree from the pause card.
  const tree = page.locator('text=SKILL TREE').first();
  if (await tree.isVisible().catch(() => false)) {
    await tree.click();
    await page.waitForTimeout(1600);
    await page.screenshot({ path: `${OUT}/${device.name}-04-skilltree.png` });
    entry.screens.skilltree = await page.evaluate(SCAN, HUD_PLATE_SELECTORS);
    await page.locator('text=BACK').first().click().catch(() => undefined);
    await page.waitForTimeout(700);
  }

  // The elements tab, and the loadout editor opened from inside a live run. The hub
  // route to the editor is measured below; this one is the case that can only go wrong
  // over a running simulation — a frozen scene, an editor that hands the run back
  // paused, and a card that stays in frame with a fifth button in it.
  const elementsTab = page.locator('text=ELEMENTS').first();
  if (await elementsTab.isVisible().catch(() => false)) {
    await elementsTab.click();
    await page.waitForTimeout(420);
    await page.screenshot({ path: `${OUT}/${device.name}-03b-pause-elements.png` });
    entry.screens['pause-elements'] = await page.evaluate(SCAN, HUD_PLATE_SELECTORS);
    const edit = page.locator('text=EDIT LOADOUT').first();
    const editSeen = await edit.isVisible().catch(() => false);
    entry.screens['pause-elements'].editRoute = editSeen;
    if (editSeen) {
      await edit.click();
      await page.waitForTimeout(1300);
      await page.screenshot({ path: `${OUT}/${device.name}-03c-run-loadout.png` });
      const runScan = await page.evaluate(SCAN, HUD_PLATE_SELECTORS);
      runScan.frozen = await page.evaluate(
        () => window.__sixfoldGame?.scene?.getScene('GameplayScene')?.frozen ?? null,
      );
      await page.locator('text=BACK').first().click().catch(() => undefined);
      await page.waitForTimeout(800);
      runScan.backToCard = await page.evaluate(
        () => Boolean(document.querySelector('[role="dialog"][aria-label="Paused"]')),
      );
      entry.screens['run-loadout'] = runScan;
      // The editor left the card open on its elements tab; SAVE & EXIT lives on the
      // root tab, so step back to it before the hub leg of the audit.
      await page.locator('text=BACK').first().click().catch(() => undefined);
      await page.waitForTimeout(420);
    }
  }

  /* Codex, loadout and settings, from the hall.

     Two faults lived in this leg. `SAVE & EXIT` goes *home*, not to the hall — the run summary is
     only opened by death or a floor clear — so after the fixed 2.6 s sleep the loop was searching
     the home page, which happens to have a SETTINGS control. The home's settings card got measured
     and labelled `settings`; the two screens that only exist in the hall were silently `continue`d,
     on all five shapes, and the run still reported clean. And even in the hall the stations are a
     swipe strip on phone shapes, so a control can sit a thousand world pixels outside the frame.
     Enter the hall explicitly, walk the strip until the control exists, and report a screen as
     `not measured — <why>` rather than skipping it. */
  await page.locator('text=SAVE & EXIT').first().click().catch(() => undefined);
  await page.waitForTimeout(1400);
  const hall = page.locator('text=THE HALL').first();
  if (await hall.isVisible().catch(() => false)) {
    await hall.click().catch(() => undefined);
    await page.waitForTimeout(1300);
  }
  await page
    .waitForFunction(
      () => Array.from(document.querySelectorAll('button')).some((b) => /STEP THROUGH/.test(b.textContent || '')),
      null,
      { timeout: 12000 },
    )
    .then(() => undefined)
    .catch(() => undefined);

  const reach = async (button) => {
    const target = page.locator(`text=${button}`).first();
    const steps = await page.evaluate(() => document.querySelectorAll('.hall-floor > .station').length);
    for (let i = 0; i <= Math.max(0, steps); i += 1) {
      if ((await target.count().catch(() => 0)) > 0) return target;
      await page
        .evaluate((index) => {
          const floor = document.querySelector('.hall-floor');
          if (!floor) return;
          const card = floor.querySelectorAll(':scope > .station')[index];
          if (card) card.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'center' });
        }, i)
        .catch(() => undefined);
      await page.waitForTimeout(320);
    }
    return null;
  };

  for (const [label, button] of [
    ['codex', 'OPEN CODEX'],
    ['loadout', 'ARRANGE LOADOUT'],
    ['settings', 'SETTINGS'],
  ]) {
    const target = await reach(button);
    const found = Boolean(target);
    if (found) await target.scrollIntoViewIfNeeded().catch(() => undefined);
    if (!found || (await target.isDisabled().catch(() => false))) {
      const offered = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.screen button'))
          .map((b) => (b.textContent || '').trim().replace(/\s+/g, ' '))
          .filter(Boolean)
          .slice(0, 16),
      );
      entry.screens[label] = {
        notReached: found
          ? 'the control is disabled for this save'
          : `no ${button} control on this screen — the hub offers ${JSON.stringify(offered)}`,
      };
      continue;
    }
    await target.click();
    await page.waitForTimeout(1400);
    await page.screenshot({ path: `${OUT}/${device.name}-05-${label}.png` });
    entry.screens[label] = await page.evaluate(SCAN, HUD_PLATE_SELECTORS);
    await page.locator('text=BACK').first().click().catch(() => undefined);
    await page.waitForTimeout(900);
  }

  entry.errors = errors.slice(0, 6);
  report.push(entry);
  await page.close();
}

await browser.close();

/* ---- verdicts ---------------------------------------------------------- */
const verdicts = [];
for (const entry of report) {
  for (const [screen, scan] of Object.entries(entry.screens)) {
    if (!scan) continue;
    const name = `${entry.device}/${screen}`;
    if (scan.notReached) {
      verdicts.push(`INFO ${name}: not measured — ${scan.notReached}`);
      continue;
    }
    if (scan.layout?.overflowX > 0) verdicts.push(`FAIL ${name}: horizontal overflow ${scan.layout.overflowX}px`);
    if (scan.layout?.bodyScrolls) verdicts.push(`WARN ${name}: the document itself scrolls (screen should own its scroll)`);
    if (scan.targets?.smallest?.length) {
      verdicts.push(
        `WARN ${name}: ${scan.targets.smallest.length} control(s) under ${MIN_TARGET}px — ` +
          scan.targets.smallest.map((t) => `${t.label} ${t.w}x${t.h}`).join(', '),
      );
    }
    if (scan.collide?.length) verdicts.push(`FAIL ${name}: ${scan.collide.join(' | ')}`);
    if (scan.plateClash?.length) {
      verdicts.push(`FAIL ${name}: HUD plates are drawn on top of each other — ${scan.plateClash.join(' | ')}`);
    }
    if (scan.banner) {
      const b = scan.banner;
      if (!b.above) verdicts.push(`FAIL ${name}: the wave announcement does not sit above the countdown plate (gap ${b.gap}px)`);
      if (!b.inFrame) verdicts.push(`FAIL ${name}: the announcement and the count do not fit the ${entry.device} frame`);
      if (b.minGap <= 0) {
        verdicts.push(`FAIL ${name}: the announcement touches the countdown plate during the pop — closest approach ${b.minGap}px`);
      }
      if (b.contrast < 3 || b.subContrast < 3) {
        verdicts.push(`FAIL ${name}: the announcement is not legible against its own plate — ${b.contrast}:1 on the title, ${b.subContrast}:1 on the sub-line, fill ${b.fill}`);
      } else if (b.contrast < 4.5) {
        verdicts.push(`WARN ${name}: title contrast ${b.contrast}:1 is under 4.5:1 (the plate clears the 3:1 large-text bar)`);
      }
      if (b.minFont < MIN_FONT) verdicts.push(`FAIL ${name}: the announcement is set at ${b.minFont}px, under the ${MIN_FONT}px floor`);
      verdicts.push(
        `INFO ${name}: announcement ${b.gap}px above the count (never closer than ${b.minGap}px across the pop), contrast ${b.contrast}:1 / ${b.subContrast}:1, ${b.minFont}px type, ${b.zoom}x`, 
      );
    } else if (scan.bothUp === false) {
      verdicts.push(`FAIL ${name}: the announcement and the count were never up together — ${scan.why}`);
    }
    if (scan.unreachable?.length) {
      verdicts.push(
        `FAIL ${name}: ${scan.unreachable.length} control(s) cannot be reached — ` +
          scan.unreachable.map((c) => `${c.label} ${JSON.stringify(c.r)}${c.covered ? ` covered by ${c.covered}` : ' off-frame with no scroller'}`).join(', '),
      );
    }
    if (scan.strandedByScroll) {
      verdicts.push(
        `WARN ${name}: ${scan.strandedByScroll} control(s) sit past the frame and only come in by scrolling ` +
          `(content is ${scan.depth}x the frame${scan.content ? `, ${scan.content.sh}px in ${scan.content.ch}px` : ''})`,
      );
    }
    if (scan.depth && scan.depth > 2.2) {
      verdicts.push(`WARN ${name}: this screen is ${scan.depth}x taller than the frame — short frames need their own layout, not more scrolling`);
    }
    if (screen === 'playing') {
      if (!scan.menu?.present) verdicts.push(`FAIL ${name}: no on-screen control opens the pause card, and a touch device has no Escape key`);
      else if (!scan.menu.pressable) verdicts.push(`FAIL ${name}: the pause control is at ${JSON.stringify(scan.menu.box)} and cannot be tapped`);
    }
    if (screen === 'pause-elements' && scan.editRoute === false) {
      verdicts.push(`FAIL ${name}: the pause card's elements tab offers no route to the loadout editor`);
    }
    if (screen === 'run-loadout') {
      if (scan.frozen !== true) {
        verdicts.push(`FAIL ${name}: the loadout editor opened over a live run but the simulation is not frozen (frozen=${scan.frozen})`);
      }
      if (scan.backToCard !== true) {
        verdicts.push(`FAIL ${name}: BACK from the run's editor did not return to the pause card (got ${scan.backToCard})`);
      }
    }
    if (scan.tinyText?.length) {
      verdicts.push(
        `WARN ${name}: text under ${MIN_FONT}px — ` + scan.tinyText.map((t) => `${t.cls} ${t.size}px "${t.t}"`).join(', '),
      );
    }
    if (scan.camera && (scan.camera.zoom !== 1 || scan.camera.sceneTs !== 1 || scan.camera.physicsTs !== 1)) {
      verdicts.push(
        `FAIL ${name}: the frame is not on its fitted base — zoom ${scan.camera.zoom}, scene clock ${scan.camera.sceneTs}, physics clock ${scan.camera.physicsTs} (a punch or hit-stop that never returned)`,
      );
    }
    const world = scan.world;
    if (world?.dev && world.playing) {
      const enemiesCount = (w) => w.enemyCount ?? w.enemies.length;
      if (world.underControls > 0) {
        verdicts.push(
          `WARN ${name}: ${world.underControls} hostile(s) pass under a pad (arena view ${world.viewPx}, zoom ${world.zoom}) — pads are translucent at alpha ${world.padOpacity}`,
        );
      }
      if (world.playerUnderControls) {
        verdicts.push(
          `FAIL ${name}: the player renders under a touch control (buffer ${world.buffer}, zoom ${world.zoom}) — the camera has to keep the warden above the pad band`,
        );
      }
      if (world.padOpacity !== null && world.padOpacity > 0.6) {
        verdicts.push(`WARN ${name}: the pads paint at alpha ${world.padOpacity}, which hides what walks behind them (target ≤ 0.6)`);
      }
      if (world.enemies?.length) {
        const sizes = world.enemies.map((e) => Math.max(e.css.w, e.css.h));
        verdicts.push(
          `INFO ${name}: ${enemiesCount(world)} live hostiles, sprite size on screen ${Math.min(...sizes)}-${Math.max(...sizes)} CSS px (buffer ${world.buffer}, zoom ${world.zoom})`,
        );
      }
      // 15 CSS px is where a nearest-neighbour sprite stops reading as a shape at
      // arm's length; a phone lands on 16 and a desktop on 32 or better.
      if (world.playerCss && Math.max(world.playerCss.w, world.playerCss.h) < 15) {
        verdicts.push(`WARN ${name}: the player is ${world.playerCss.w}x${world.playerCss.h} CSS px on screen (buffer ${world.buffer}, zoom ${world.zoom})`);
      }
      if (scan.haptics) {
        // Every shape in this audit is a touch device, so a coarse pointer that
        // never asks the motor to move is a real miss, not a platform quirk.
        if (scan.haptics.calls === 0) {
          verdicts.push(`FAIL ${name}: pressing ATTACK, SKILL and an element slot asked for no vibration pattern (haptics never fired)`);
        } else {
          verdicts.push(`INFO ${name}: haptics fired ${scan.haptics.calls}x — ${JSON.stringify(scan.haptics.patterns.slice(0, 3))}`);
        }
      }
    }
  }
}

const failures = verdicts.filter((v) => v.startsWith('FAIL'));
console.log(JSON.stringify({ devices: report.length, verdicts: verdicts.length ? verdicts : ['no failures'], out: OUT }, null, 2));
/* The verdicts are only a gate if the run stops on one: this file used to print FAILs and
   exit 0, which is how a landscape HUD nobody had measured stayed broken. */
if (failures.length) {
  console.error(`\n${failures.length} layout failure(s) — see the FAIL lines above`);
  process.exitCode = 1;
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
