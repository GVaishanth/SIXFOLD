/**
 * Page-fit check.
 *
 * The standing rule: a full-screen page uses the whole frame. It must not render
 * as a short panel with its own scrollbar while the bottom half of the window
 * sits empty, and the document itself must never scroll. Both orientations of a
 * phone are covered, because a 844×390 frame fails in the opposite way to a
 * 390×844 one: the vertical budget, not the width, is what runs out.
 *
 * Usage:
 *   SIXFOLD_URL=http://localhost:5173/ node tools/page-fit.mjs
 *
 * Exits non-zero when any screen fails. Writes report + screenshots to
 * /home/user/audit/page-fit (override with OUT=…).
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const npxRoot = path.join(homedir(), '.npm', '_npx');
let chromium = null;
for (const candidate of [
  path.resolve('node_modules/playwright'),
  ...(existsSync(npxRoot) ? readdirSync(npxRoot).map((d) => path.join(npxRoot, d, 'node_modules/playwright')) : []),
]) {
  if (!existsSync(path.join(candidate, 'package.json'))) continue;
  try {
    chromium = require(candidate).chromium;
    break;
  } catch {
    /* next */
  }
}
if (!chromium) throw new Error('playwright is not resolvable');

const URL_BASE = process.env.SIXFOLD_URL ?? 'http://localhost:5173/';
import { MIN_FONT } from './hud-plates.mjs';

const OUT = process.env.OUT ?? '/home/user/audit/page-fit';
mkdirSync(OUT, { recursive: true });

const SHAPES = [
  { label: 'phone-portrait', width: 390, height: 844, touch: true },
  { label: 'phone-small', width: 360, height: 640, touch: true },
  { label: 'phone-landscape', width: 844, height: 390, touch: true },
  { label: 'tablet-portrait', width: 820, height: 1180, touch: true },
  { label: 'desktop', width: 1366, height: 768, touch: false },
];

const PAGES = [
  { label: 'hub', enter: null },
  { label: 'loadout', enter: 'ARRANGE LOADOUT' },
  { label: 'skilltree', enter: 'SKILL TREE' },
  { label: 'codex', enter: 'OPEN CODEX' },
  { label: 'freemode', enter: 'FREE MODE' },
  { label: 'ascension', enter: /ASCENSION/ },
  { label: 'achievements', enter: 'ACHIEVEMENTS' },
  { label: 'settings', enter: 'SETTINGS' },
];

/*
 * A control that will not act has to say why, and say it where a thumb can read it. Hover-only text is not
 * an answer — a touch device has no hover, and a disabled button never receives the pointer event a tooltip
 * needs. So the frame itself is asked: for every inert button, is there a visible reason inside it, and does
 * that reason fit? `data-reason` is the accepted exception for controls whose refusal is spatial (the pager
 * arrows at either end of a count line), and it is counted so the rule can never measure nothing.
 */
const lockProbe = () => {
  const inert = [...document.querySelectorAll('button')].filter(
    (b) => b.disabled || b.getAttribute('aria-disabled') === 'true' || b.classList.contains('is-locked'),
  );
  const screen = document.querySelector('.screen');
  return {
    // A refusal printed as a description is the thing the player said no to: thirty of them is a wall of text.
    captions: [...(screen ? screen.querySelectorAll('.lock-reason') : [])].length,
    rows: inert.map((b) => {
      // Which refusal this is in the order the driver enumerates them, so the click and the reason match up.
      const refusalIndex = [...document.querySelectorAll('.screen [aria-disabled="true"][data-reason]')].indexOf(b);
      const rect = b.getBoundingClientRect();
      const reason = (b.dataset.reason || b.getAttribute('title') || b.getAttribute('aria-label') || '').trim();
      return {
        refusalIndex,
        label: (b.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
        reason: reason.slice(0, 120),
        // A `disabled` control swallows the press, so nothing can pop: only aria-disabled ones must answer.
        pressable: !b.disabled && b.getAttribute('aria-disabled') === 'true' && Boolean(b.dataset.reason),
        unreachable: (() => {
          let node = b.parentElement;
          while (node && node !== document.body) {
            const style = getComputedStyle(node);
            const nr = node.getBoundingClientRect();
            if (/(auto|scroll)/.test(style.overflowX)) return false;
            if (/(hidden|clip)/.test(style.overflowX)) {
              return rect.right > nr.right + 1.5 || rect.left < nr.left - 1.5;
            }
            node = node.parentElement;
          }
          return rect.right > innerWidth + 1 || rect.left < -1;
        })(),
      };
    }),
  };
};

/**
 * Every heading the screen promises to show, measured against the frame and against the nearest ancestor that
 * clips it. A control that scrolls sideways is exempt — the hub rail's six station titles are all past its
 * edge on purpose, and reading that as a fault is how a harness invents one.
 */
const headProbe = () => {
  const rows = [];
  for (const el of document.querySelectorAll('h1, h2, h3, .ambient-header, .section-label')) {
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 60) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    let edge = innerWidth;
    let node = el.parentElement;
    let pannable = false;
    while (node && node !== document.body) {
      const cs = getComputedStyle(node);
      if (/(auto|scroll)/.test(cs.overflowX)) {
        pannable = true;
        break;
      }
      if (/(hidden|clip)/.test(cs.overflowX)) {
        edge = Math.min(edge, node.getBoundingClientRect().right);
        break;
      }
      node = node.parentElement;
    }
    const over = pannable ? 0 : Math.round(Math.max(0, r.right - edge));
    rows.push({ text: text.slice(0, 40), over, clipped: over > 0 });
  }
  return rows.filter((row) => row.clipped);
};

const probe = () => {
  const doc = document.documentElement;
  // Most pages wrap their content in `.screen-inner`; the hub and the mode
  // pickers use their own layout, so fall back to the widest direct child of the
  // screen instead of reporting nothing for them.
  const screen = document.querySelector('.screen');
  const candidates = [document.querySelector('.screen-inner'), screen].filter(Boolean);
  let inner = candidates[0] ?? null;
  if (screen && !document.querySelector('.screen-inner')) {
    let best = null;
    let bestArea = 0;
    for (const child of screen.children) {
      const r = child.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        best = child;
      }
    }
    inner = best;
  }
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width) };
  };
  const scrollers = [...document.querySelectorAll('.scroll-y')].map((el) => {
    const r = el.getBoundingClientRect();
    return {
      cls: typeof el.className === 'string' ? el.className : '',
      h: Math.round(r.height),
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      scrolls: el.scrollHeight - el.clientHeight,
      pctOfFrame: Math.round((r.height / window.innerHeight) * 100),
    };
  });
  const panels = [...document.querySelectorAll('.panel')].map((el) => {
    const r = el.getBoundingClientRect();
    return { h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom), scrolls: el.scrollHeight - el.clientHeight };
  });
  return {
    frame: [window.innerWidth, window.innerHeight],
    pageScroll: doc.scrollHeight - doc.clientHeight,
    overflowX: doc.scrollWidth - doc.clientWidth,
    bodyScrolls: getComputedStyle(document.body).overflowY !== 'visible' ? false : doc.scrollTop > 0,
    inner: box(inner),
    innerPctOfFrame: inner ? Math.round((inner.getBoundingClientRect().height / window.innerHeight) * 100) : null,
    unusedBottom: inner ? Math.round(window.innerHeight - inner.getBoundingClientRect().bottom) : null,
    scrollers,
    panels,
    hasScreen: Boolean(document.querySelector('.screen')),
  };
};

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const report = [];
/**
 * The menu backdrop is drawn by Phaser, not the DOM, so "does the background
 * cover the screen" cannot be measured with element rects. This reads the
 * display objects the atmosphere lays down and compares their union with what
 * the camera can actually see: any edge the union falls short of is a strip of
 * page showing through the artwork, which is exactly the bug this check exists
 * for (a TileSprite left at the authored 320 width, or bands rested on the
 * authored floor instead of the frame's).
 */
const BACKDROP_PROBE = () => {
  const game = window.__sixfoldGame;
  const menu = game?.scene?.getScene('MainMenuScene');
  const atmosphere = menu?.atmosphere;
  if (!atmosphere?.world) return null;
  const view = menu.cameras.main.worldView;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const child of atmosphere.world.list) {
    if (!child || child.visible === false || !child.getBounds) continue;
    const b = child.getBounds();
    if (!b || !Number.isFinite(b.width) || b.width <= 0) continue;
    left = Math.min(left, b.x);
    top = Math.min(top, b.y);
    right = Math.max(right, b.x + b.width);
    bottom = Math.max(bottom, b.y + b.height);
  }
  const skyKeys = menu.textures.getTextureKeys().filter((key) => key.startsWith('menu_sky_'));
  return {
    view: [Math.round(view.width), Math.round(view.height)],
    /**
     * How far short of each edge the paint falls, in world pixels. Positive is a
     * hole; over-coverage is negative and is clamped to zero so a wide phone view
     * (where the bands deliberately bleed past the sides) reads as clean.
     */
    holes: {
      left: Math.max(0, Math.round(left - view.x)),
      top: Math.max(0, Math.round(top - view.y)),
      right: Math.max(0, Math.round(view.x + view.width - right)),
      bottom: Math.max(0, Math.round(view.y + view.height - bottom)),
    },
    skyTextures: skyKeys.length,
  };
};

const verdicts = [];

/**
 * One screen's inert controls, judged. A control that will not act has to say why, and say it where a thumb
 * can read it: hover-only text is not an answer, because a touch device has no hover and a disabled button
 * never receives the pointer event a tooltip needs. `data-reason` is the accepted exception for controls
 * whose refusal is spatial — a pager arrow at either end of a "3 / 6" count line — and it is still counted,
 * so the rule can never pass by measuring nothing.
 */
function judgeLocks(frame, label, locks, out) {
  const rows = locks.rows ?? [];
  out.count += rows.length;
  if (locks.captions > 0) {
    verdicts.push(
      `FAIL ${frame}/${label}: ${locks.captions} refusal(s) are printed as standing text on the screen — a reason is answered on the press, not parked under the label`,
    );
  }
  for (const lock of rows) {
    out.rows.push({ frame, label, ...lock });
    if (!lock.reason) {
      verdicts.push(
        `FAIL ${frame}/${label}: "${lock.label}" refuses without a reason — nothing in the markup to pop, hover or read`,
      );
    }
    if (lock.unreachable) {
      verdicts.push(
        `FAIL ${frame}/${label}: "${lock.label}" sits past the edge of a clipped container — neither it nor its answer can be reached`,
      );
    }
  }
}

/** The words a press owes the player, minus the punctuation, so the match is about content not formatting. */
const words = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2).slice(0, 4);

/**
 * Press a refusal and read the answer back. This is the half the player judges: the reason must arrive as a
 * pop, in the frame, and must not move them anywhere. Two refusals per screen is enough to prove the wiring —
 * they all come out of the same primitive, and clicking every locked tile would only make the gate slow.
 */
async function pressRefusals(page, frame, label, locks) {
  const targets = (locks.rows ?? []).filter((r) => r.pressable).slice(0, 2);
  for (const target of targets) {
    const locator = page.locator('.screen button[aria-disabled="true"][data-reason]').nth(target.refusalIndex);
    if (!(await locator.count())) continue;
    const before = await page.evaluate(() => document.querySelectorAll('.toast').length);
    const headingBefore = await headingOf(page);
    /*
     * `force` because a refusal is `aria-disabled`, and Playwright reads that as "not actionable" and waits
     * out the timeout instead of tapping. A finger does not ask permission of a disabled-looking button, and
     * the whole point of the markup is that the press still lands — so the harness has to land it too.
     */
    await locator.click({ force: true, timeout: 4000 }).catch(() => undefined);
    await page.waitForTimeout(420);
    const popped = await page.evaluate(() => {
      const node = document.querySelector('.toast-stack .toast:last-child');
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return {
        text: (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
        inFrame: r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1,
      };
    });
    if (!popped) {
      verdicts.push(`FAIL ${frame}/${label}: pressing "${target.label}" produced no message at all`);
      continue;
    }
    const wanted = words(target.reason);
    const got = popped.text.toLowerCase();
    const hits = wanted.filter((w) => got.includes(w)).length;
    if (wanted.length > 0 && hits < Math.min(3, wanted.length)) {
      verdicts.push(
        `FAIL ${frame}/${label}: pressing "${target.label}" popped "${popped.text.slice(0, 60)}", which does not say "${target.reason.slice(0, 60)}"`,
      );
    }
    if (!popped.inFrame) {
      verdicts.push(`FAIL ${frame}/${label}: the refusal message for "${target.label}" is outside the frame`);
    }
    if ((await headingOf(page)) !== headingBefore) {
      verdicts.push(`FAIL ${frame}/${label}: pressing the locked "${target.label}" navigated anyway`);
    }
    void before;
  }
}

const headingOf = (page) =>
  page.evaluate(() => {
    const h = document.querySelector('.screen h1, .screen .title-xl, .screen h2, .screen .ambient-header');
    return (h?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 48);
  });

const lockTotals = {};
const allLocksTotal = [];

for (const shape of SHAPES) {
  const context = await browser.newContext({
    viewport: { width: shape.width, height: shape.height },
    deviceScaleFactor: shape.touch ? 3 : 1,
    hasTouch: shape.touch,
    isMobile: shape.touch,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error).slice(0, 160)));

  await page.goto(URL_BASE, { waitUntil: 'load' });
  await page.waitForSelector('text=NEW WARDEN', { timeout: 40000 });
  await page.click('text=NEW WARDEN');
  await page.waitForSelector('text=THE VAULT');
  await page.click('.slot-plinth:has-text("RAISE A WARDEN")');
  await page.waitForSelector('text=CHOOSE YOUR FLAME');
  await page.locator('button', { hasText: 'BIND AND BEGIN' }).click();
  await page.waitForSelector('text=CREATE WARDEN');
  await page.locator('button', { hasText: 'CREATE WARDEN' }).click();
  await page.waitForSelector('text=STEP THROUGH');
  await page.waitForTimeout(1500);

  const screens = {};
  // Every inert control on every station of this shape, in one list, so the run-wide guard at the bottom
  // can prove the refusal rule actually looked at something.
  const lockOut = { count: 0, rows: [] };
  for (const target of PAGES) {
    /*
     * Several stations are gated on progress — FREE MODE and ASCENSION are locked on a
     * fresh save — and a click on an absent or disabled control leaves the *previous*
     * screen on the frame. Measuring that and labelling it "freemode" is how a harness
     * reports a fault the game does not have, so the screen's own heading is compared
     * before and after, and an entry that did not happen is recorded as not measured.
     */
    let notReached = null;
    if (target.enter) {
      const before = await headingOf(page);
      const button =
        typeof target.enter === 'string'
          ? page.locator(`button:has-text("${target.enter}")`).first()
          : page.locator('button').filter({ hasText: target.enter }).first();
      if (!(await button.count())) {
        notReached = 'the control that opens it is not present for this save';
      } else if (await button.isDisabled().catch(() => false)) {
        notReached = 'the control that opens it is disabled for this save';
      } else {
        await button.click().catch(() => undefined);
        await page.waitForTimeout(1400);
        if ((await headingOf(page)) === before) notReached = 'the click did not change the screen';
      }
    }
    const data = await page.evaluate(probe);
    const locks = notReached ? { captions: 0, rows: [] } : await page.evaluate(lockProbe);
    screens[target.label] = notReached ? { notReached, frame: data.frame } : data;
    await page.screenshot({ path: path.join(OUT, `${shape.label}-${target.label}.png`) });
    if (notReached) {
      verdicts.push(`INFO ${shape.label}/${target.label}: not measured — ${notReached}`);
      continue;
    }

    // Failures: the document scrolls, content spills sideways, or a scroll
    // region is a short window with dead frame under it.
    if (data.pageScroll > 1) {
      verdicts.push(`FAIL ${shape.label}/${target.label}: the document scrolls by ${data.pageScroll}px`);
    }
    if (data.overflowX > 1) {
      verdicts.push(`FAIL ${shape.label}/${target.label}: horizontal overflow ${data.overflowX}px`);
    }
    for (const line of await page.evaluate(headProbe)) {
      if (line.clipped) {
        verdicts.push(
          `FAIL ${shape.label}/${target.label}: the heading "${line.text}" is ${line.over}px wider than the frame and the screen clips it`,
        );
      }
    }

    judgeLocks(shape.label, target.label, locks, lockOut);
    await pressRefusals(page, shape.label, target.label, locks);

    if (data.hasScreen && data.innerPctOfFrame !== null && data.innerPctOfFrame < 82 && target.label !== 'hub') {
      verdicts.push(
        `WARN ${shape.label}/${target.label}: the page body uses ${data.innerPctOfFrame}% of the frame (${data.unusedBottom}px of window below it)`,
      );
    }
    for (const scroller of data.scrollers) {
      if (scroller.pctOfFrame < 42) {
        verdicts.push(
          `WARN ${shape.label}/${target.label}: scroll region is ${scroller.pctOfFrame}% of the frame (${scroller.h}px, ${scroller.scrolls}px of content hidden)`,
        );
      }
    }
    for (const panel of data.panels) {
      if (panel.scrolls > 4 && panel.h < shape.height * 0.42) {
        verdicts.push(`WARN ${shape.label}/${target.label}: a ${panel.h}px panel hides ${panel.scrolls}px of its own content`);
      }
    }
    if (target.enter) {
      // Back to the hub for the next station, without resuming the run.
      const back = page.locator('button:has-text("BACK")').first();
      if (await back.count()) {
        await back.click().catch(() => undefined);
        await page.waitForTimeout(900);
      }
    }
  }
  // Backdrop coverage, before and after a live resize: the composition is
  // re-laid on every frame change, so the second measurement is the one that
  // catches a listener that only runs at create.
  const backdrops = [];
  for (const [label, size] of [
    ['static', null],
    ['resized', { width: Math.round(shape.width * 0.72), height: Math.round(shape.height * 1.22) }],
  ]) {
    if (size) {
      await page.setViewportSize(size);
      await page.waitForTimeout(700);
    }
    const data = await page.evaluate(BACKDROP_PROBE);
    if (!data) {
      verdicts.push(`WARN ${shape.label}/backdrop: not measurable (no dev scene handle)`);
      continue;
    }
    backdrops.push({ label, ...data });
    const holes = Object.entries(data.holes).filter(([, px]) => px > 2);
    if (holes.length) {
      verdicts.push(
        `FAIL ${shape.label}/backdrop (${label}): the menu background leaves ${holes.map(([k, v]) => `${v}px of ${k}`).join(', ')} unpainted in a ${data.view.join('×')} view`,
      );
    }
    if (data.skyTextures !== 1) {
      verdicts.push(`FAIL ${shape.label}/backdrop (${label}): ${data.skyTextures} sky plates alive — the frame-size plate is leaking`);
    }
  }
  screens.backdrop = backdrops;

  /*
   * ACHIEVEMENTS and the codex hang off the title screen, which the flow above has already left, and a
   * thirty-card ledger is exactly the kind of list that goes wrong at 390px. A reload puts the frame back
   * on the menu with the save the flow just created, so both are measured for real. Nothing after this
   * depends on the run still being open — the next shape starts a fresh context.
   */
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=ELEMENT CODEX', { timeout: 40000 });
  await page.waitForTimeout(700);
  for (const station of [
    { label: 'menu', enter: null },
    { label: 'achievements', enter: 'ACHIEVEMENTS' },
    { label: 'codex', enter: 'ELEMENT CODEX' },
  ]) {
    if (station.enter) {
      const button = page.locator('button', { hasText: station.enter }).first();
      if (!(await button.count()) || (await button.isDisabled().catch(() => false))) {
        verdicts.push(`INFO ${shape.label}/${station.label}: not measured — the tile will not open for this save`);
        continue;
      }
      await button.click().catch(() => undefined);
      await page.waitForTimeout(1200);
    }
    const data = await page.evaluate(probe);
    screens[station.label] = data;
    const stationLocks = await page.evaluate(lockProbe);
    judgeLocks(shape.label, station.label, stationLocks, lockOut);
    await pressRefusals(page, shape.label, station.label, stationLocks);
    await page.screenshot({ path: path.join(OUT, `${shape.label}-${station.label}.png`) });
    if (data.overflowX > 1) {
      verdicts.push(`FAIL ${shape.label}/${station.label}: horizontal overflow ${data.overflowX}px`);
    }
    if (station.enter) {
      const back = page.locator('button:has-text("BACK")').first();
      if (await back.count()) {
        await back.click().catch(() => undefined);
        await page.waitForTimeout(800);
      }
    }
  }

  screens.locks = lockOut.rows;
  report.push({ shape, screens, errors, locksMeasured: lockOut.count, locks: lockOut.rows });
  lockTotals[shape.label] = lockOut.count;
  allLocksTotal.push(...lockOut.rows);
  await context.close();
}
await browser.close();

/*
 * A rule that measures nothing is worse than no rule, because it reads like a pass. A fresh save opens with
 * CHECKPOINT, FREE MODE and ASCENSION all refusing on the hub, so fewer than three inert controls anywhere
 * means the audit has been disarmed — usually by a screen losing its locked state, or by the probe's
 * selector drifting away from the markup.
 */
const locksMeasured = Object.values(lockTotals).reduce((total, n) => total + n, 0);
const pressableTotal = allLocksTotal.filter((row) => row.pressable).length;
if (locksMeasured < 3 || pressableTotal < 3) {
  verdicts.push(
    `FAIL the refusal rule measured ${locksMeasured} inert control(s), ${pressableTotal} pressable, across ${SHAPES.length} shapes — it is not looking at anything`,
  );
}
writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
const fails = verdicts.filter((v) => v.startsWith('FAIL'));
console.log(
  JSON.stringify(
    {
      url: URL_BASE,
      shapes: SHAPES.map((s) => s.label),
      verdicts: verdicts.length ? verdicts : ['no findings'],
      refusals: {
        measured: locksMeasured,
        printed: allLocksTotal.filter((l) => l.printed).length,
        markupOnly: allLocksTotal.filter((l) => !l.printed && l.announced).length,
      },
      counts: {
        fail: fails.length,
        // Anything that is not a failure is not automatically a warning: the run also
        // reports INFO lines (a station a fresh save cannot reach is stated, not judged).
        warn: verdicts.filter((v) => v.startsWith('WARN')).length,
        info: verdicts.filter((v) => v.startsWith('INFO')).length,
      },
      out: OUT,
    },
    null,
    2,
  ),
);
process.exit(fails.length ? 1 : 0);
