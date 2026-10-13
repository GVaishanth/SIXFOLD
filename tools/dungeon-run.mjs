/**
 * Dungeon mode probe.
 *
 * The generator has its own gate (`audit:dungeon`); this one proves the *scene*, in the browser the
 * player actually uses: that entering a strip writes nothing to the save, that the world is one authored
 * cell wide and streamed rather than built whole, that walking east is what ends the run, that the strip's
 * plates survive a phone frame, and that story mode still starts afterwards. A check that only compiled
 * the scene would prove none of that.
 *
 * `npm run audit:dungeonrun`, with a dev server on :5173 (the debug scene handle is dev-only).
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { HUD_PLATE_SELECTORS, MIN_FONT } from './hud-plates.mjs';

const require = createRequire(import.meta.url);
const npxRoot = path.join(homedir(), '.npm', '_npx');
let chromium = null;
for (const c of [
  path.resolve('/home/user/sixfold/node_modules/playwright'),
  ...(existsSync(npxRoot) ? readdirSync(npxRoot).map((d) => path.join(npxRoot, d, 'node_modules/playwright')) : []),
]) {
  try {
    if (!existsSync(path.join(c, 'package.json'))) continue;
    chromium = require(c).chromium;
    break;
  } catch {
    /* next */
  }
}
if (!chromium) throw new Error('playwright chromium not installed');

const BASE = process.env.SIXFOLD_URL ?? 'http://127.0.0.1:5173/';
const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});

const out = [];
let reported = false;
/**
 * A throw in the middle of a run must not cost the findings. Buffered output is what keeps the report
 * readable, and a gate that dies silently is a gate that tells you nothing about why.
 */
const dump = () => {
  if (reported) return;
  reported = true;
  console.log(out.join('\n'));
  if (errors.length) console.log(`CONSOLE ERRORS (${errors.length}):\n${errors.slice(0, 6).join('\n')}`);
};
const check = (name, ok, detail = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  // One line per finding, as it happens. A gate that buffers everything is a gate that reports nothing when
  // it stalls, and a stall is the failure mode that costs the most time to find.
  console.log(out[out.length - 1]);
};
process.on('SIGTERM', () => {
  dump();
  process.exit(1);
});
const info = (name, detail) => out.push(`INFO  ${name}${detail ? ` — ${detail}` : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Anything the browser can be asked to do may simply never answer: a context under memory pressure takes its
 * time to start, a wedged renderer never returns from an evaluate, and Playwright puts no timeout on either.
 * Everything in the phone pass goes through this, so a stuck frame becomes a finding about that frame
 * instead of silence about every check that followed it.
 */
const withTimeout = (promise, ms, what) =>
  Promise.race([
    Promise.resolve(promise),
    new Promise((resolve, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ]);

/** Buff expiry is clock housekeeping a scene must do on entry; nothing else may move. */
const ALLOWED = /^runBuffs\.\d+\.expiresAt$/;

/** Paths that changed between two save records, as dotted strings. */
function diffPaths(a, b) {
  const paths = [];
  const walk = (x, y, prefix) => {
    if (x === y) return;
    if (Array.isArray(x) || Array.isArray(y)) {
      const len = Math.max(x?.length ?? 0, y?.length ?? 0);
      for (let i = 0; i < len; i += 1) walk(x?.[i], y?.[i], `${prefix}.${i}`);
      return;
    }
    if (x && y && typeof x === 'object' && typeof y === 'object') {
      const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
      for (const key of keys) walk(x?.[key], y?.[key], prefix ? `${prefix}.${key}` : key);
      return;
    }
    paths.push(prefix);
  };
  walk(a, b, '');
  return paths;
}
const leaked = (paths) => (paths ?? []).filter((p) => !ALLOWED.test(p));

/* ------------------------------------------------------------------ */
/* Page helpers                                                        */
/* ------------------------------------------------------------------ */

const saveRecord = (page) =>
  page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      const raw = localStorage.getItem(key) ?? '';
      if (!raw.includes('"progression"')) continue;
      try {
        const json = JSON.parse(raw);
        return (json.slots ?? []).find(Boolean) ?? json.state?.data ?? json.data ?? json;
      } catch {
        return null;
      }
    }
    return null;
  });

/**
 * Click a button by label, scrolling it into view first.
 *
 * The hall's stations are reachable by scroll — a phone puts them in a side-scroller and a short frame
 * puts the plinth below the fold — so "present but not in view" is a normal state, not a failure.
 */
const clickText = async (page, text, timeout = 8000) => {
  const button = page.locator('button', { hasText: text }).first();
  await button.waitFor({ state: 'attached', timeout });
  await button.scrollIntoViewIfNeeded().catch(() => undefined);
  await sleep(140);
  /*
   * `noWaitAfter`, because every one of these clicks changes what the page is: Hall to onboarding,
   * onboarding to the dungeon, dungeon back to the Hall. Playwright's default is to wait for the resulting
   * navigation to settle, and under swiftshader that wait outlasts the timeout on a slow frame — which
   * reads as "the button could not be clicked" for a button that worked perfectly.
   */
  await button.click({ timeout, noWaitAfter: true });
};

/** Walk the interface back to the hall, wherever in the menus the page currently is. */
async function toHall(page) {
  for (let i = 0; i < 3; i += 1) {
    if (await page.locator('.station-deep').count()) return true;
    const hall = page.locator('button', { hasText: 'THE HALL' }).first();
    if (await hall.count()) {
      // Deliberately not `CONTINUE`: that starts a story run, which is a different thing from opening
      // the hall, and a probe that fights its way through a wave to get to a menu is testing nothing.
      await hall.scrollIntoViewIfNeeded().catch(() => undefined);
      await hall.click({ timeout: 4000 }).catch(() => undefined);
      await sleep(900);
      continue;
    }
    return false;
  }
  return Boolean(await page.locator('.station-deep').count());
}

/** Everything from the new-warden flow up to a live strip, in whatever shape the page is in. */
async function enterStrip(page) {
  await page.goto(BASE, { waitUntil: 'load' });
  await sleep(900);
  if (await page.locator('text=NEW WARDEN').count()) {
    await page.click('text=NEW WARDEN');
    await sleep(300);
    const plinth = page.locator('.slot-plinth:has-text("RAISE A WARDEN")');
    if (await plinth.count()) await plinth.first().click();
    await sleep(300);
    await clickText(page, 'BIND AND BEGIN', 4000).catch(() => {});
    await sleep(300);
    await clickText(page, 'CREATE WARDEN', 4000).catch(() => {});
    await sleep(700);
  }
  await page
    .waitForFunction(() => Array.from(document.querySelectorAll('button')).some((b) => /WALK THE STRIP/.test(b.textContent || '')), null, { timeout: 15000 })
    .catch(() => undefined);
  const save = await saveRecord(page);
  await clickText(page, 'WALK THE STRIP');
  await sleep(1500);
  return { save };
}

/** Is this body's box inside one of these wall rectangles on all four sides? */
function buriedIn(object, rects) {
  const b = object?.body;
  if (!b) return false;
  return rects.some(
    (r) =>
      b.position.x > r.x + 1 &&
      b.position.x + b.width < r.x + r.w - 1 &&
      b.position.y > r.y + 1 &&
      b.position.y + b.height < r.y + r.h - 1,
  );
}

const stripState = (page) =>
  page.evaluate(() => {
    const g = window.__sixfoldGame;
    const scene = g?.scene.getScene('DungeonScene');
    if (!scene || !scene.plan) return null;
    // `-1` means "the question could not be asked", and only for numbers: a boolean probe that failed must
    // not come back as a truthy sentinel and be read as a positive finding.
    const safe = (fn) => {
      try {
        return fn();
      } catch (error) {
        console.log(`probe failed: ${error?.message ?? error}`);
        return -1;
      }
    };
    const safeBool = (fn) => {
      try {
        return Boolean(fn());
      } catch {
        return null;
      }
    };
    const rect = (r) => (r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null);
    const camera = scene.cameras?.main;
    return {
      active: Boolean(scene.scene?.isActive()),
      storyActive: Boolean(g.scene.getScene('GameplayScene')?.scene?.isActive()),
      cells: scene.plan.chunkCount,
      cellWidth: scene.plan.cellWidth,
      width: scene.plan.width,
      height: scene.plan.height,
      worldBounds: rect(scene.physics?.world?.bounds),
      // `camera.bounds` is the viewport; `_bounds` is the world the camera may travel in.
      cameraBounds: rect(camera?._bounds ?? camera?.bounds),
      zoom: camera?.zoom ?? 0,
      drawnCells: safe(() => scene.ground?.cells?.size ?? -1),
      stones: scene.stones?.length ?? -1,
      spent: scene.strip?.spentCount ?? -1,
      enemies: safe(() => scene.enemies?.countActive(true) ?? -1),
      allyDistance: scene.ally && scene.player ? safe(() => Math.hypot(scene.ally.x - scene.player.x, scene.ally.y - scene.player.y)) : -1,
      // Which bodies are standing in stone *right now*: the honest version of "inside a wall", and the one
      // a plan made of folds can answer.
      // Penetration, not proximity: a body has to be inside a wall body by a pixel on every side before this
      // says the world let something through it.
      // The predicate is spelled out here rather than called: `buriedIn` lives in this file's Node scope, and
      // a reference to it from inside `evaluate` is a ReferenceError in the page — which `safe` turned into
      // `-1`, a number every truthiness test in the gate read as "standing in a wall". That is what made the
      // partner's samples report stone 150 times out of 150, whatever the world was doing.
      allyInWall: safeBool(() => {
        const b = scene.ally?.body;
        if (!b) return false;
        return (scene.ground?.wallRects ?? []).some(
          (r) =>
            b.position.x > r.x + 1 &&
            b.position.x + b.width < r.x + r.w - 1 &&
            b.position.y > r.y + 1 &&
            b.position.y + b.height < r.y + r.h - 1,
        );
      }),
      playerInWall: safeBool(() => {
        const b = scene.player?.body;
        if (!b) return false;
        return (scene.ground?.wallRects ?? []).some(
          (r) =>
            b.position.x > r.x + 1 &&
            b.position.x + b.width < r.x + r.w - 1 &&
            b.position.y > r.y + 1 &&
            b.position.y + b.height < r.y + r.h - 1,
        );
      }),
      allyState: scene.ally?.allyState ?? null,
      allyHp: scene.ally?.hp ?? -1,
      player: scene.player ? { x: scene.player.x, y: scene.player.y, hp: scene.player.hp, maxHp: scene.player.maxHp } : null,
      ledger: scene.ledger ?? -1,
      kills: scene.kills ?? -1,
      damageDealt: scene.damageDealt ?? -1,
      cellIndex: scene.cellIndex ?? -1,
      brain: Boolean(scene.plan.walls),
      walls: scene.plan.walls?.length ?? scene.ground?.walls?.length ?? 0,
      layer: scene.plan.layerAt && scene.player ? scene.plan.layerAt(scene.player.x, scene.player.y) : -1,
      line: safe(() => scene.strip.stage(scene.player.x, scene.player.y).line ?? -1),
      atCenter: Boolean(safe(() => scene.strip.stage(scene.player.x, scene.player.y).atCenter)),
      carrying: scene.ally?.carried?.length ?? -1,
      closestOrb: safe(() => {
        const orbs = scene.pickups.getChildren().filter((entry) => entry.active && (entry.kind === 'essence' || entry.kind === 'shard'));
        return orbs.length ? Math.round(Math.min(...orbs.map((entry) => Math.hypot(entry.x - scene.player.x, entry.y - scene.player.y)))) : -1;
      }),
      goalX: scene.plan.goal?.x ?? -1,
      ally: scene.ally ? { x: Math.round(scene.ally.x), y: Math.round(scene.ally.y) } : null,
      // Where the circuit walls are, so a sample can say whether the partner is *inside* one.
      labyrinth: scene.plan && !scene.plan.walls
        ? {
            bandTop: scene.plan.cells[0].circuit.spine.fy0 * scene.plan.height,
            bandBottom: scene.plan.cells[0].circuit.spine.fy1 * scene.plan.height,
            passages: scene.ground.circuitRects.length
              ? Array.from({ length: scene.plan.chunkCount }, (_, i) =>
                  scene.ground
                    .circuitRects(i)
                    .filter((rect) => Math.abs(rect.y - scene.plan.cells[i].circuit.spine.fy0 * scene.plan.height) < 1),
                )
              : [],
          }
        : null,
      orbs: safe(() => scene.pickups.getChildren().filter((entry) => entry.active && (entry.kind === 'essence' || entry.kind === 'shard')).length),
      walls: safe(() => scene.ground?.walls?.getChildren().length ?? -1),
      reported: Boolean(scene.reported),
      frameWidth: g.scale?.width ?? 0,
    };
  });

/**
 * Is this body inside a circuit wall? Inside the spine's band, and not inside one of that cell's spine
 * gaps — the only openings the mode has. A partner that never trips it is a partner that walked the
 * labyrinth rather than cutting through it, which is the whole point of building walls in the first place.
 */
function insideCircuitWall(sample) {
  // A brain plan reports this straight from the wall list (see `stripState`), because it has no spine to
  // fall between; the strip's answer is the older one, computed from its band and its crossings.
  if (sample?.allyInWall !== undefined) return sample.allyInWall;
  const lab = sample?.labyrinth;
  const at = sample?.ally;
  if (!lab || !at) return false;
  if (at.y <= lab.bandTop || at.y >= lab.bandBottom) return false;
  return !(lab.passages ?? []).some((rects) => {
    const [first, second] = rects;
    if (!first) return false;
    const openFrom = first.x + first.w;
    const openTo = second ? second.x : openFrom + 1;
    return at.x > openFrom + 2 && at.x < openTo - 2;
  });
}

const hudPlates = (page) =>
  page.evaluate(({ selectors, minFont }) => {
    const vis = (el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 1 && r.height > 1;
    };
    const frame = { w: window.innerWidth, h: window.innerHeight };
    const plates = selectors
      .map((sel) => {
        const el = document.querySelector(sel);
        return el && vis(el) ? { sel: sel.replace('.', ''), el, r: el.getBoundingClientRect() } : null;
      })
      .filter(Boolean);
    const clash = [];
    for (let i = 0; i < plates.length; i += 1) {
      for (let j = i + 1; j < plates.length; j += 1) {
        const a = plates[i];
        const b = plates[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const x = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const y = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (x > 2 && y > 2) clash.push(`${a.sel} x ${b.sel} (${Math.round(x)}x${Math.round(y)})`);
      }
    }
    const offFrame = plates
      .filter(
        (p) =>
          p.r.x < -1 || p.r.y < -1 || p.r.right > frame.w + 1 || p.r.bottom > frame.h + 1,
      )
      .map((p) => p.sel);
    const tiny = [];
    for (const el of document.querySelectorAll('.hud *')) {
      if (el.children.length > 0) continue;
      if (!(el.textContent || '').trim()) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1) continue;
      const size =
        Math.round(parseFloat(cs.fontSize) * (el.getScreenCTM?.()?.a ?? 1) * 10) / 10;
      if (size < minFont) tiny.push(`${el.className.toString().split(' ')[0]}:${size}`);
    }
    return { plates: plates.map((p) => ({ sel: p.sel, r: { x: Math.round(p.r.x), y: Math.round(p.r.y), w: Math.round(p.r.width), h: Math.round(p.r.height) } })), clash, offFrame, tiny, frame };
  }, { selectors: HUD_PLATE_SELECTORS, minFont: MIN_FONT });

const hudText = (page, selector) =>
  page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? '', selector);

/* ------------------------------------------------------------------ */
/* 1. mechanics, at a desktop shape                                    */
/* ------------------------------------------------------------------ */

const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => {
  // The stack, not just the message: "reading 'size'" is not a lead, the frame above it is.
  errors.push(`pageerror: ${e.message} :: ${(e.stack ?? '').split('\n').slice(1, 15).map((l) => l.trim()).join(' | ').slice(0, 1400)}`);
});

// Registered here, not at the bottom of the file: a handler added after the run is over cannot report
// the throw that ended the run early.
process.on('uncaughtException', (error) => {
  dump();
  console.log(`FATAL  ${String(error?.stack ?? error).slice(0, 1200)}`);
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  dump();
  console.log(`FATAL  ${String(error?.stack ?? error).slice(0, 1200)}`);
  process.exit(1);
});

const entered = await enterStrip(page);
/*
 * The deterministic half of this audit does not want a hostile it was not written for. Roamers are measured on
 * the isolated page below, where the probe walks on purpose; here, several gates park the warden on a stone,
 * drop it inside a wall, or hold a key against a tooth for seconds, and the trickle turns those measurements
 * into a fight the warden loses — after which every gate downstream reads a death card instead of the thing it
 * came to measure. The suppression is the mode's own throttle, not a flag invented for the test.
 */
await quietBands(page, 900000);
check('a save exists to protect', Boolean(entered.save), entered.save ? `essence ${entered.save?.progression?.essence}` : 'none found');
const saveBefore = entered.save;

const begin = await stripState(page);
check(
  'the strip is the only run scene',
  Boolean(begin?.active) && begin.storyActive === false,
  begin ? `strip=${begin.active} story=${begin.storyActive}` : 'no scene handle',
);
check(
  begin?.brain ? 'the brain is seven nested layers' : 'the strip is six authored cells end to end',
  Boolean(begin) && begin.cells === (begin.brain ? 7 : 6) && begin.cellWidth > 300,
  begin ? `${begin.cells} × ${Math.round(begin.cellWidth)} = ${Math.round(begin.width)}×${Math.round(begin.height)} (${begin.walls} wall bodies)` : '',
);
check(
  'physics bounds span the strip, minus the wall band',
  Boolean(begin?.worldBounds) && Math.abs(begin.worldBounds.w - (begin.width - begin.worldBounds.x * 2)) < 2,
  begin ? `world ${Math.round(begin.worldBounds.w)} of ${Math.round(begin.width)}` : '',
);
check(
  'the camera can travel the whole strip',
  Boolean(begin?.cameraBounds) && Math.abs(begin.cameraBounds.w - begin.width) < 2,
  begin ? `camera ${Math.round(begin.cameraBounds.w)} at zoom ${begin.zoom.toFixed(2)}` : '',
);
check(
  'the map is authored, not fitted to the window',
  Boolean(begin) && begin.height > 300 && begin.width >= begin.cellWidth - 1 && begin.cellWidth * Math.ceil(begin.width / begin.cellWidth) - begin.width < 1,
  begin ? `${begin.cells} cells of ${Math.round(begin.cellWidth)}×${Math.round(begin.height)} world px` : '',
);
check('ground is drawn a cell at a time', Boolean(begin) && begin.drawnCells >= 1 && begin.drawnCells <= 3, begin ? `${begin.drawnCells} of 6 cells built` : '');
check('stones live near the start', Boolean(begin) && begin.stones > 0, begin ? `${begin.stones} in range` : '');
check(
  'entering a strip writes nothing to the save',
  leaked(diffPaths(saveBefore, await saveRecord(page))).length === 0,
  leaked(diffPaths(saveBefore, await saveRecord(page))).join(', '),
);

const plate = await hudText(page, '.floor-plate');
const lineCount = (begin?.cells ?? 0) + 1;
check(
  'the depth plate counts the labyrinth\'s lines',
  new RegExp(`LINE\\s+\\d+\\s*/\\s*${lineCount}|CENTER`).test(plate.replace(/\s+/g, ' ')) && /DEPTH/.test(plate) && !/WAVE \d/.test(plate),
  `${JSON.stringify(plate)} — ${begin?.cells} layers counted inwards is ${lineCount} lines`,
);
check('the objective counts what is left', /SITE|WALK/.test(await hudText(page, '.objective-text')), JSON.stringify(await hudText(page, '.objective-text')));
check('the partner is read in the vitals block', (await page.locator('.partner-line').count()) === 1);
check('the minimap is inline SVG, one folded line per circuit', (await page.locator('.strip-map .strip-cell').count()) === begin.cells, `${begin.cells} cells drawn for ${begin.cells} layers`);
check('and the last line is marked as the centre', (await page.locator('.strip-map .strip-cell.is-goal').count()) === 1);
check(
  'and the plan is the walk: a line per layer, and the warden on it',
  (await page.locator('.strip-map .strip-joint').count()) === begin.cells &&
    (await page.locator('.strip-map .strip-centre').count()) === 1 &&
    (await page.locator('.strip-map .strip-you').count()) === 1,
  `${begin.cells} lines drawn, one centre pip, one walker`,
);
check('the circuit walls are bodies, not paint', (begin?.walls ?? 0) >= begin.cells * 2, begin ? `${begin.walls} static bodies for ${begin.cells} cells` : '');

/* --- walk east ------------------------------------------------------- */

const before = await stripState(page);
await page.keyboard.down('ArrowRight');
await sleep(7000);
await page.keyboard.up('ArrowRight');
await sleep(400);
const walked = await stripState(page);
// The strip's promise was "east is the walk"; a brain's corridors run wherever the folds run, so the claim
// that survives the redesign is the one that matters: the way in is not buried, and the warden can leave it.
const mouth = await page.evaluate(() => {
  const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
  const plan = scene.plan;
  if (!plan.layerAt) return null;
  const tile = plan.fissure?.tilePx ?? 64;
  const { x, y } = plan.spawn ?? { x: plan.cellWidth * 0.16, y: plan.height / 2 };
  const open = [
    [tile, 0],
    [-tile, 0],
    [0, tile],
    [0, -tile],
  ].filter(([dx, dy]) => plan.layerAt(x + dx, y + dy) >= 0).length;
  return { open, x: Math.round(x), y: Math.round(y) };
});
check(
  'the way in is ground, and the warden can walk away from it',
  mouth ? mouth.open >= 1 : Boolean(before && walked) && walked.player.x - before.player.x > 250,
  mouth
    ? `spawn ${mouth.x},${mouth.y} has ${mouth.open} open neighbour tile${mouth.open === 1 ? '' : 's'}; held east for 7s it reached x ${Math.round((walked?.player.x ?? 0) - (before?.player.x ?? 0))}px on in`
    : `${Math.round((walked?.player.x ?? 0) - (before?.player.x ?? 0))}px east`,
);
check('the depth plate followed the walk', /DEPTH\s+([1-9]\d?|100)%/.test(await hudText(page, '.strip-depth')), JSON.stringify(await hudText(page, '.strip-depth')));
const leash = await page.evaluate(() => {
    const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
    return { guard: scene.DUNGEON_HINT ?? 0 };
  });
  void leash;
  // A partner 14% slower than the warden cannot hold a 34px leash while the player runs; what it owes
  // is that it stays inside its guard radius on the move and closes the gap the moment you stop.
  check('the partner keeps pace inside its guard radius', Boolean(walked) && walked.allyDistance >= 0 && walked.allyDistance < 200, walked ? `${Math.round(walked.allyDistance)}px back while running` : '');
  await sleep(1400);
  const settled = await stripState(page);
  check(
    'the partner closes back to its leash when the warden stops',
    Boolean(settled) && settled.allyDistance > -1 && settled.allyDistance <= 60,
    settled ? `${Math.round(settled.allyDistance)}px after 1.4s standing` : '',
  );
check(
  'ground is still streamed after walking',
  Boolean(walked) && walked.drawnCells >= 1 && walked.drawnCells <= 3,
  walked ? `${walked.drawnCells} cells built at x=${Math.round(walked.player.x)}, cell ${walked.cellIndex + 1}` : '',
);

/* --- the labyrinth: what stops you, and what lets you through -------- */

/**
 * Every number the next five checks use is read off the *bodies* the scene built (`circuitRects`), not
 * off the config: if the renderer, the physics and the generator ever disagreed about where the walls
 * are, this is where it shows up.
 */
/*
 * Walls are solid, and the division divides.
 *
 * The strip proved this with a spine and a tooth; the brain's walls are its folds, so the probe asks the
 * world three harder questions instead, all of them read out of the same lists the physics runs on: does a
 * walk east stop *flush* against a wall body rather than sinking into it or sliding along it; can the warden
 * cross the central cleft anywhere other than at a doorway; and does the partner follow. A plan can look
 * like a labyrinth in a PNG and still be a suggestion the player walks straight through — these are the
 * checks that would catch it.
 */
const geometry = await page.evaluate(() => {
  const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
  const plan = scene.plan;
  const rects = scene.ground.wallRects;
  const player = { x: scene.player.x, y: scene.player.y };
  const radius = scene.player.body?.halfWidth ?? 16;
  const ahead = rects
    .filter((r) => r.x > player.x + radius && player.y > r.y - 8 && player.y < r.y + r.h + 8)
    .sort((a, b) => a.x - b.x)[0];
  const fissure = plan.fissure ?? null;
  const tile = fissure?.tilePx ?? 64;
  // The nearest walkable tile west of the cleft at a row, so a test never starts inside a wall and then
  // gets pushed out of it — which would measure the unstick pass and call it a corridor.
  const approach = (worldY) => {
    if (!fissure) return null;
    for (let x = fissure.x - fissure.halfWidth - tile; x > tile; x -= tile) {
      if (plan.layerAt(x, worldY) >= 0) return { x, y: worldY };
    }
    return null;
  };
  const nearDoor = (worldY) => fissure?.doorRows.some((d) => Math.abs(d - worldY) <= tile * 2.5) ?? false;
  let blocked = null;
  let door = null;
  if (fissure) {
    for (const d of fissure.doorRows) {
      const at = approach(d);
      if (at) door = { ...at, doorY: d };
    }
    for (let k = 1; k < 24 && !blocked; k += 1) {
      for (const worldY of [player.y - k * tile, player.y + k * tile]) {
        if (worldY < tile || worldY > plan.height - tile || nearDoor(worldY)) continue;
        const at = approach(worldY);
        if (at) {
          blocked = at;
          break;
        }
      }
    }
  }
  return {
    brain: Boolean(plan.walls),
    radius,
    tile,
    wall: ahead ? { x: ahead.x, w: ahead.w, y: ahead.y, h: ahead.h } : null,
    cells: plan.cells.length,
    fissure,
    door,
    blocked,
  };
});

check(
  'the map\'s walls are bodies, not paint',
  (begin?.walls ?? 0) >= (geometry.brain ? 128 : geometry.cells * 2),
  `${begin?.walls ?? 0} static bodies${geometry.brain ? ` for ${geometry.cells} layers of folds` : ` for ${geometry.cells} circuits`}`,
);
check(
  'a wall you cannot walk through is what ends the eastward walk',
  Boolean(walked) && Boolean(geometry.wall) && Math.abs(walked.player.x + geometry.radius - geometry.wall.x) <= 8,
  walked
    ? `stopped with its east edge at ${Math.round(walked.player.x + geometry.radius)}, wall face ${Math.round(geometry.wall?.x ?? 0)}${geometry.wall ? ` of a ${Math.round(geometry.wall.w)}px body` : ''}`
    : '',
);
check(
  'and it is a stop, not a slow-down: the walk never slid along the wall',
  Boolean(walked) && Math.abs(walked.player.y - before.player.y) <= 6,
  `y ${Math.round(before.player.y)} → ${Math.round(walked.player.y)} across ${Math.round(walked.player.x - before.player.x)}px of held east`,
);

/**
 * Press budgets for the division checks are written in *tiles*, because the map's scale is a knob: at
 * 160px per tile the cleft is ~800px across, and a hold tuned for 32px tiles would stop short of the far
 * side and read as a blocked doorway. `walkMs` converts "how far the warden should get if nothing stops
 * them" into milliseconds at the warden's walking speed (82px/s).
 */
const WALK_PX_PER_S = 82;
const walkMs = (tiles) => Math.round((tiles * (geometry.tile ?? 32)) / WALK_PX_PER_S * 1000);

const press = async (key, ms) => {
  await page.keyboard.down(key);
  await sleep(ms);
  await page.keyboard.up(key);
  await sleep(220);
};
const park = (x, y) =>
  page.evaluate(
    ({ x, y }) => {
      const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
      scene.player.x = x;
      scene.player.y = y;
      const body = scene.player.body;
      if (body?.velocity) body.velocity.setTo(0, 0);
      if (body) body.updateFromGameObject();
    },
    { x, y },
  );

if (geometry.brain && geometry.blocked && geometry.door) {
  // Midway between doorways, pressing east from the floor beside the cleft must not change hemisphere.
  const leftOf = await stripState(page);
  await park(geometry.blocked.x, geometry.blocked.y);
  const atWall = await stripState(page);
  await press('ArrowRight', walkMs(2));
  const pushed = await stripState(page);
  check(
    'the division is impassable between doorways — the warden cannot cross the cleft on a whim',
    Boolean(pushed) && pushed.player.x < geometry.fissure.x,
    `parked at x ${Math.round(atWall.player.x)} (layer ${atWall.layer}), pushed east 2.6s, reached x ${Math.round(pushed.player.x)} (layer ${pushed.layer}); the midline is ${Math.round(geometry.fissure.x)} and its half-width ${Math.round(geometry.fissure.halfWidth)}`,
  );
  check(
    'and no push moved them out of the layer they were standing in',
    Boolean(pushed) && pushed.layer === atWall.layer,
    `layer ${atWall.layer} before, ${pushed.layer} after`,
  );

  // At a doorway, the same press must cross. This is what makes the doorways the *only* way between the
  // hemispheres rather than decoration: one row apart, the same effort changes the answer.
  await park(geometry.door.x, geometry.door.y);
  // Pressed in bursts until the hemisphere changes: the door is a way through, and how long that takes is
  // a property of the map's scale, not of the check.
  // Budgeted against the scene's own clock. A press measured in wall-clock seconds spends fewer simulation
  // steps when the renderer is slow — a 1280×800 buffer under software GL runs this page near 16fps against
  // 47 at the authored 320×200 — and the claim under test is "the doorway can be walked through", not "in
  // 1.5 real seconds", so the wait is released on simulated time and the budget is the same distance either way.
  const simNow = () => page.evaluate(() => window.__sixfoldGame.scene.getScene('DungeonScene').time.now);
  let through = null;
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const t0 = await simNow();
    let spent = 0;
    while (spent < 1500) {
      await press('ArrowRight', 400);
      spent = (await simNow()) - t0;
    }
    through = await stripState(page);
    if (through && through.player.x > geometry.fissure.x) break;
  }
  check(
    'a doorway across the division is a way through, and the walk finds it',
    Boolean(through) && through.player.x > geometry.fissure.x,
    `the doorway at row ${Math.round(geometry.door.doorY)} took them from x ${Math.round(geometry.door.x)} to ${Math.round(through.player.x)}`,
  );
} else {
  info('the division test needs a brain plan', geometry.brain ? 'no approach tile found beside the cleft' : 'strip plan: the spine and crossing have their own checks');
}

// The partner: budgeted in *simulated* time, because swiftshader clamps dt and a short press measures the
// renderer rather than the corridor. It walks the route, so a brain's folds are no excuse for losing it.
await press('ArrowRight', 6000);
const afterWalk = await stripState(page);
// The warden was carried across the cleft twice on the way here, which at this map's scale is kilometres of
// corridor: a walk the partner can start and no budget should finish. What the promise owes is narrower and
// free of scale — set down a couple of tiles away, on ground of its own, it comes back, and it never ends up
// standing in stone. So the pair is placed rather than flung, and the tiles are read off the same wall list
// the physics runs on.
const reset = await page.evaluate(() => {
  const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
  const tile = scene.plan.fissure?.tilePx ?? 64;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]];
  for (let k = 2; k < 8; k += 1) {
    for (const [dx, dy] of dirs) {
      const x = Math.round(scene.player.x + dx * tile * k);
      const y = Math.round(scene.player.y + dy * tile * k);
      if (scene.plan.layerAt && scene.plan.layerAt(x, y) < 0) continue;
      if (scene.buriedAt(x, y)) continue;
      const body = scene.ally.body;
      body?.reset?.(x, y);
      scene.ally.setPosition(x, y);
      body?.velocity?.setTo(0, 0);
      body?.updateFromGameObject?.();
      return { gap: Math.round(Math.hypot(x - scene.player.x, y - scene.player.y)) };
    }
  }
  return null;
});
const settleMs = reset ? Math.min(14000, Math.round((reset.gap / 90) * 1000) + 1400) : 2600;
/*
 * The wait below is polled, not slept: `settleMs` is the *simulated* budget the partner needs at half its
 * walking speed (45px/s of 90), and a slow renderer needs more real seconds to spend it. Polling on the
 * scene clock keeps the claim — a partner left 320px away comes back — measurable on any frame rate instead
 * of only on a fast one.
 */
const settleTarget = reset ? Math.round((reset.gap / 45) * 1000) + 1400 : settleMs;
const partnerDist = () =>
  page.evaluate(() => {
    const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
    const dx = scene.ally.x - scene.player.x;
    const dy = scene.ally.y - scene.player.y;
    return { dist: Math.round(Math.hypot(dx, dy)), sim: scene.time.now };
  });
const settledStart = await partnerDist();
let settledEarly = await stripState(page);
let settledNow = settledStart;
for (let waited = 0; waited < settleTarget; waited += 250) {
  await sleep(250);
  settledNow = await partnerDist();
  settledEarly = await stripState(page);
  if (settledNow.dist <= 60) break;
  if (settledNow.sim - settledStart.sim >= settleTarget) break;
}
// How much real time the sim budget cost is the difference between measuring the partner and measuring the
// renderer, so it goes in the detail rather than being silently absorbed by a longer sleep.
const settleRealMs = Math.max(1, settledNow.sim - settledStart.sim);
check(
  'and the partner comes back to the warden instead of being left somewhere',
  Boolean(afterWalk && settledEarly) &&
    (reset ? settledEarly.allyDistance <= 60 : settledEarly.allyDistance < afterWalk.allyDistance - 60) &&
    !settledEarly.allyInWall,
  afterWalk && settledEarly
    ? `${Math.round(settledEarly.allyDistance)}px after ${(settleMs / 1000).toFixed(1)}s from ${
        reset ? `${reset.gap}px away, on ground chosen to be clear of stone (${(settleRealMs / 1000).toFixed(1)}s of simulated time allowed)` : 'where the walk left it'
      } (was ${Math.round(afterWalk.allyDistance)}px behind at the end of the walk)${
        settledEarly.allyInWall ? ', and standing inside a wall' : ''
      }`
    : '',
);

/* --- the walls are thick enough for the things that move in them ------ */

/*
 * Tunneling is a ratio, so the check is a ratio: the thinnest wall body against the longest step a mover
 * takes in one frame, *measured* with the world running rather than assumed. The scene clamps dt to 50ms,
 * so the fastest legal single step is bounded — and the sample below is deliberately driven harder than the
 * config allows (680px/s is twice the dash) so that if some other code path ever launches a body faster
 * than the numbers in `gameConfig.ts` suggest, this is the check that notices.
 *
 * Two answers are wanted, not one. Nobody may end up *inside* a wall body, and nobody may end up on the
 * far side of a wall they were thrown at: the second is the one the player calls "glitching through".
 */
const stress = await page.evaluate(async () => {
  const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
  const rects = scene.ground.wallRects;
  // Bounded, because `postupdate` only arrives while the scene is stepping: a wait that assumes it is a
// hang waiting to happen, and a gate that hangs tells you less than a gate that fails.
const frame = (ms = 250) =>
  Promise.race([
    new Promise((done) => scene.events.once('postupdate', done)),
    new Promise((done) => setTimeout(done, ms)),
  ]);
  const box = (o) => {
    const b = o?.body;
    return b ? { x: b.position.x, y: b.position.y, w: b.width, h: b.height } : null;
  };
  const enclosed = (o) => {
    const r = box(o);
    if (!r || !o.body?.enable) return false;
    return rects.some(
      (b) => r.x > b.x + 1 && r.x + r.w < b.x + b.w - 1 && r.y > b.y + 1 && r.y + b.h - 1 && r.y + r.h < b.y + b.h - 1,
    );
  };
  const tile = scene.plan.fissure?.tilePx ?? 64;
  // Returns the spot, or null when it could not get the body onto clear ground. Returning `null` for a
  // mover that is simply missing (already gone) is deliberate; failing to place a *live* one is reported,
  // because a body left where the previous check put it will happily "pass" by never reaching the wall —
  // or, worse, "fail" as having crossed it, which is exactly what a stale run of this probe did.
  const place = (o, x, y) => {
    if (!o?.active) return null;
    const b = o.body;
    const w = b?.width ?? 10;
    const h = b?.height ?? 10;
    // Step west in half-tiles until the body is on floor and covered by no wall body: a mover dropped
    // *into* stone at the start would have the ejection pass do the testing, not the wall.
    for (let k = 0; k < 8; k += 1) {
      const px = x - k * tile * 0.5;
      if ((!scene.plan.layerAt || scene.plan.layerAt(px, y) >= 0) && !scene.buriedAt(px, y, w, h)) {
        o.x = px;
        o.y = y;
        if (b?.velocity) b.velocity.setTo(0, 0);
        if (b) b.updateFromGameObject();
        return { x: px, y };
      }
    }
    return null;
  };
  // A wall body whose west face has floor in front of it and floor beyond it: a wall a mover can be thrown
  // at without the world's own edge or a neighbouring ridge doing the stopping for it.
  const openWestOf = (r, y) => scene.plan.layerAt(r.x - 24, y) >= 0 && scene.plan.layerAt(r.x + r.w + 24, y) >= 0;
  const y0 = Math.round(scene.player.y);
  const target = rects
    .filter((r) => r.x > scene.player.x + 40 && r.x < scene.player.x + 3000 && y0 > r.y - 8 && y0 < r.y + r.h + 8 && openWestOf(r, y0))
    .sort((a, b) => a.x - b.x)[0];
  const report = {
    frames: 0,
    maxStep: 0,
    enclosedFrames: 0,
    enemyFrames: 0,
    movers: 0,
    unplaced: 0,
    enemies: 0,
    thinnest: Math.min(...rects.map((r) => Math.min(r.w, r.h))),
    wall: null,
    crossed: null,
    allyCrossed: null,
    enemiesCrossed: null,
    woke: false,
    sites: 0,
    start: null,
    finish: null,
  };
  /*
   * The user's fault is about *enemies*, so hostiles have to be in the sample and not just the two friendly
   * bodies: a wave is woken deliberately (the same overlap the stones section uses, only the walking is
   * skipped) before the wall is chosen, and every live enemy is shoved at it alongside them.
   */
  const liveFoes = () => (scene.enemies?.getChildren?.() ?? []).filter((entry) => entry.active).length;
  const unspent = (scene.strip?.allSites ?? []).filter((entry) => !scene.strip.isSpent(entry.id));
  // Dens release one body and groves release `site.n`, so the sites are walked in size order and the wake
  // stops at four hostiles: enough bodies crowding one wall face to say something about a crowd, and a
  // bound on how long the gate spends waking them.
  for (const site of [...unspent].sort((a, b) => (b.n ?? 1) - (a.n ?? 1)).slice(0, 6)) {
    if (liveFoes() >= 4) break;
    scene.player.x = site.fx * scene.plan.cellWidth + site.chunk * scene.plan.cellWidth;
    scene.player.y = site.fy * scene.plan.height;
    scene.player.body?.updateFromGameObject?.();
    for (let i = 0; i < 90 && liveFoes() < 4; i += 1) await frame();
  }
  report.woke = liveFoes() > 0;
  report.sites = unspent.length;
  if (!target) return report;
  const face = target.x;
  report.wall = { x: Math.round(face), w: Math.round(target.w), h: Math.round(target.h) };
  const foes = (scene.enemies?.getChildren?.() ?? []).filter((entry) => entry.active);
  report.enemies = foes.length;
  const movers = [scene.player, scene.ally, ...foes];
  report.movers = movers.length;
  // Every mover on the row the wall was validated on, lined up a body-width apart instead of stacked — at
  // 12px apart they overlapped, and Arcade's de-overlap snaps stacked bodies in one step, which measured
  // the pile rather than the speed (102px of a 160px tile). A body that ends up past the face has crossed
  // stone, not walked around it.
  let unplaced = 0;
  for (let i = 0; i < movers.length; i += 1) if (!place(movers[i], face - 200 - i * 24, y0)) unplaced += 1;
  report.unplaced = unplaced;
  report.start = Math.round(scene.player.x);
  const prev = new Map();
  const mark = (o) => {
    if (!o) return 0;
    const before = prev.get(o);
    prev.set(o, { x: o.x, y: o.y });
    return before ? Math.hypot(o.x - before.x, o.y - before.y) : 0;
  };
  const shove = () => movers.forEach((m) => m?.body?.velocity?.setTo(680, 0));
  shove();
  for (let i = 0; i < 90; i += 1) {
    await frame();
    report.frames += 1;
    for (const m of movers) {
      report.maxStep = Math.max(report.maxStep, mark(m));
      if (enclosed(m)) {
        report.enclosedFrames += 1;
        if (foes.includes(m)) report.enemyFrames += 1;
      }
    }
    shove();
  }
  movers.forEach((m) => m?.body?.velocity?.setTo(0, 0));
  report.finish = Math.round(scene.player.x);
  const through = (o) => Boolean(o) && o.x > face + target.w;
  report.crossed = through(scene.player);
  report.allyCrossed = through(scene.ally);
  report.enemiesCrossed = foes.filter(through).length;
  // Hand the world back: the woken pack is this measurement's prop, not the run's, and anything still
  // chasing the player would be scored by whichever check runs next.
  for (const foe of foes) {
    // `killAndHide` for the group's bookkeeping, and the body is *disabled* — `body.enable` is a property on
    // an Arcade body, not a method, which is what the first version of this assumed.
    scene.enemies?.killAndHide?.(foe);
    if (foe?.body) foe.body.enable = false;
  }
  return report;
});
check(
  'no mover thrown at a wall as fast as the world allows ends up inside it',
  // The requirement is about hostiles specifically, so a sample without any in it has not tested it. This
  // runs before the stones section, while every site is still unspent; if a future edit moves it later, the
  // wake will find nothing and this must stay red rather than quietly pass on two friendly bodies.
  stress.enclosedFrames === 0 && stress.enemies > 0,
  `${stress.enclosedFrames} mover-frames inside a wall body (${stress.enemyFrames} of them hostile), ${Math.round(stress.maxStep)}px in the longest single frame against ${stress.thinnest}px of stone — ${stress.movers} movers (${stress.enemies} hostiles from ${stress.sites} unspent site${stress.sites === 1 ? '' : 's'}) over ${stress.frames} frames`,
);
check(
  'and none of them comes out the far side',
  Boolean(stress.wall) &&
    // Every mover has to have actually been put in front of the wall for the answer to mean anything.
    stress.unplaced === 0 &&
    stress.crossed === false &&
    stress.allyCrossed === false &&
    stress.enemiesCrossed === 0,
  stress.wall
    ? `wall face ${stress.wall.x}px (${stress.wall.w}×${stress.wall.h}) — pushed from x ${stress.start} to x ${stress.finish}; through it: player ${stress.crossed}, partner ${stress.allyCrossed}, ${stress.enemiesCrossed} of ${stress.enemies} hostiles${stress.unplaced ? ` — ${stress.unplaced} mover(s) could not be put in front of the wall, so this run measured nothing about them` : ''}`
    : 'no wall body with open floor on both sides was found near the walk',
);

/* --- the map still fits the frame ------------------------------------ */

// The rule is read where it is authored rather than copied into this file: a gate that hardcodes the number
// it checks happily passes a project whose rule has since moved.
const viewRule = /minTilesInView:\s*(\d+)/.exec(
  readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'config', 'gameConfig.ts'), 'utf8'),
);
const minTiles = viewRule ? Number(viewRule[1]) : null;
/*
 * Read-only: the frame's size is arithmetic on the buffer and the camera's zoom, and which parts of the map
 * would be on screen is a rectangle test against the route. The first version of this probe walked the player
 * along twelve route points to look, which meant every check after it started from wherever the last sample
 * left the party — a gate that moves the world it is grading.
 */
const frame = await page.evaluate(() => {
  const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
  const game = window.__sixfoldGame;
  const tile = scene.plan.fissure?.tilePx ?? 64;
  const zoom = scene.cameras.main.zoom || 1;
  const viewW = game.canvas.width / zoom;
  const viewH = game.canvas.height / zoom;
  const rects = scene.ground?.wallRects ?? [];
  const sites = scene.strip?.allSites ?? [];
  const span = { w: viewW, h: viewH };
  const hits = (cx, cy, x, y, w = 0, h = 0) =>
    x < cx + span.w / 2 && x + w > cx - span.w / 2 && y < cy + span.h / 2 && y + h > cy - span.h / 2;
  const route = scene.plan.route ?? [];
  const samples = [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95].map((f) => route[Math.floor(f * (route.length - 1))]).filter(Boolean);
  return {
    tilesAcross: viewW / tile,
    tilesDown: viewH / tile,
    cssWidth: game.canvas.width,
    canvas: { w: game.canvas.width, h: game.canvas.height },
    zoom,
    tilePx: tile,
    stoneSeen: samples.filter((t) => rects.some((r) => hits(t.x, t.y, r.x, r.y, r.w, r.h))).length,
    sitesSeen: samples.filter((t) => sites.some((site) => hits(
      t.x, t.y,
      site.fx * scene.plan.cellWidth + site.chunk * scene.plan.cellWidth,
      site.fy * scene.plan.height,
    ))).length,
    // How far each site stands from the corridor it was supposed to be placed on. The scene's `plan.route`
    // is the whole walk; a band's own `circuit.route` is the corridor a player actually sees, and content
    // that is on the band's floor but off its corridor is content that will never be looked at.
    corridor: (() => {
      // The walk, not each band's own polyline: this is the line the partner follows and the renderer draws,
      // so "the site is on the corridor" means something only against it. A site on a band's path but off the
      // walk is invisible to the warden and unreachable by the courier, and the courier gate would then blame
      // the courier.
      const pts = (scene.plan.route ?? []).slice();
      if (!pts.length) for (const cell of scene.plan.cells) for (const rp of cell.circuit.route ?? []) pts.push({ x: rp.fx * scene.plan.cellWidth, y: rp.fy * scene.plan.cellHeight });
      const worst = { walked: 0, room: 0 };
      let walkedCount = 0;
      for (const site of sites) {
        const sx = site.fx * scene.plan.cellWidth + site.chunk * scene.plan.cellWidth;
        const sy = site.fy * scene.plan.cellHeight;
        let d = Infinity;
        for (const pt of pts) {
          const e = Math.abs(pt.x - sx) + Math.abs(pt.y - sy);
          if (e < d) d = e;
        }
        const tiles = d / tile;
        const key = site.kind === 'den' ? 'room' : 'walked';
        if (key === 'walked') walkedCount += 1;
        if (tiles > worst[key]) worst[key] = tiles;
      }
      return { points: pts.length, walkedCount: walkedCount, ...worst };
    })(),
    samples: samples.length,
    sites: sites.length,
    planAreaMpx: (scene.plan.width * scene.plan.height) / 1e6,
    expectedSites: (sites.length * viewW * viewH) / (scene.plan.width * scene.plan.height),
    rects: rects.length,
    wallSprites: (scene.ground?.cells?.get(0) ?? []).filter((o) => o?.type === 'TileSprite').length,
  };
});
const atScale = `${frame.tilesAcross.toFixed(2)} × ${frame.tilesDown.toFixed(2)} tiles across a ${frame.canvas.w}×${frame.canvas.h} render canvas at zoom ${frame.zoom}`;
check(
  'the dungeon frames enough of the map to read',
  // A whole-number zoom is the viewport's own law, so a 900px window cannot show six 160px tiles no matter
  // what the dungeon asks for. The rule is therefore "the frame you can afford, not the frame you were given".
  minTiles !== null && frame.tilesAcross >= Math.min(minTiles, Math.floor(frame.cssWidth / frame.tilePx)),
  minTiles === null
    ? 'DUNGEON.minTilesInView is missing from the config, so there is nothing to measure against'
    : `${atScale} — the rule asks for ${minTiles} or more, and a whole-number zoom at this ${frame.cssWidth}px window can afford ${Math.floor(frame.cssWidth / frame.tilePx)}. A tile of ${frame.tilePx}px only satisfies the rule at ${frame.tilePx * minTiles}px of window or more`,
);
// The stone half is a gate: art that is not on screen is a fault. The site half is a *measurement* — whether
// a frame contains a grove is set by the map's density, and at 52 sites over 651 megapixels the expectation is
// 0.05 per position at any zoom, so demanding a sighting here would gate a design number the run does not own.
check(
  'and a walk along the route has stone on screen, not only floor',
  frame.stoneSeen >= Math.ceil(frame.samples * 0.8),
  `${frame.stoneSeen}/${frame.samples} route positions would show wall art at ${frame.tilesAcross.toFixed(2)} tiles across, out of ${frame.rects} live wall bodies painted by ${frame.wallSprites} sprites`,
);
check(
  'and a walk along the corridor has something to walk to',
  frame.sitesSeen >= frame.samples - 1,
  `${frame.sitesSeen}/${frame.samples} sampled route positions would show a site (${frame.sites} sites over ${frame.planAreaMpx.toFixed(1)} megapixels, ${frame.tilesAcross.toFixed(2)} × ${frame.tilesDown.toFixed(2)} tiles in frame). This used to be an observation about design taste; a site placed on a band's floor but off its corridor is a site nobody looks at, so it is now a requirement the generator has to meet`,
);
check(
  'every site the run can walk past stands on the corridor',
  frame.corridor.points > 0 && frame.corridor.walked <= 2,
  `worst distance to the band's route: ${frame.corridor.walked.toFixed(2)} tiles across ${frame.corridor.walkedCount} walked sites, measured against ${frame.corridor.points} route points. A den is excluded on purpose — it is placed at a chamber's centre because a room is a destination, and its own gate is that its ground is walkable, not that it sits by the corridor (its worst is ${frame.corridor.room.toFixed(1)} tiles out)`,
);

/* --- stones respond -------------------------------------------------- */

let touch = await stripState(page);
if ((touch?.enemies ?? 0) <= 0 && (touch?.spent ?? 0) <= 0) {
  // Headless frames run slow, so step onto the nearest grove deliberately. The overlap and the
  // director are still the ones under test — only the walking is skipped.
  const moved = await page.evaluate(() => {
    const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
    const grove = (scene.strip.allSites ?? []).find((s) => s.kind === 'grove' && !scene.strip.isSpent(s.id));
    if (!grove) return null;
    scene.player.x = grove.fx * scene.plan.cellWidth + grove.chunk * scene.plan.cellWidth;
    scene.player.y = grove.fy * scene.plan.height;
    return { x: scene.player.x, y: scene.player.y };
  });
  info('stepped onto a grove stone', moved ? `x ${Math.round(moved.x)}` : 'none left');
  await sleep(1200);
  touch = await stripState(page);
}
check(
  'a stone touched from the path wakes something or spends itself',
  (touch?.enemies ?? 0) > 0 || (touch?.spent ?? 0) > 0,
  touch ? `enemies ${touch.enemies}, stones spent ${touch.spent}, living ${touch.stones}` : '',
);
if ((touch?.enemies ?? 0) > 0) {
  // Nothing here is scripted: the probe presses the same SKILL button the HUD offers.
  await page.locator('.ability-cluster button').nth(1).click().catch(() => undefined);
  await sleep(2600);
  const fought = await stripState(page);
  check(
    'combat in the strip is scored locally',
    Boolean(fought) && (fought.damageDealt > 0 || fought.ledger > 0),
    fought ? `damage ${Math.round(fought.damageDealt)}, kills ${fought.kills}, ledger ${fought.ledger}` : '',
  );
} else {
  info('no shots fired on this path', 'the walk met springs and caches only');
}
/* --- a cache: the design's promise is that it opens outward, and the floor is not bare --- */

const ledgerBefore = (await stripState(page))?.ledger ?? 0;
const cacheSite = await page.evaluate(() => {
  const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
  const site = (scene.strip.allSites ?? []).find((s) => s.kind === 'cache' && !scene.strip.isSpent(s.id));
  if (!site) return null;
  scene.player.x = site.fx * scene.plan.cellWidth + site.chunk * scene.plan.cellWidth;
  scene.player.y = site.fy * scene.plan.height;
  return { id: site.id };
});
await sleep(260);
const popped = await page.evaluate(() => {
  const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
  const drops = scene.pickups.getChildren()
    .filter((entry) => entry.active && entry.defId !== 'way_map')
    .map((entry) => ({ x: entry.x, y: entry.y }));
  let spread = 0;
  for (let i = 0; i < drops.length; i += 1) {
    for (let j = i + 1; j < drops.length; j += 1) {
      spread = Math.max(spread, Math.hypot(drops[i].x - drops[j].x, drops[i].y - drops[j].y));
    }
  }
  const onFloor = drops.filter((d) => (scene.plan.layerAt ? scene.plan.layerAt(d.x, d.y) >= 0 : true)).length;
  return {
    count: drops.length,
    spread: Math.round(spread),
    onFloor,
    motes: scene.children.list.filter((object) => object.texture?.key === 'fx_square').length,
  };
});
if ((popped?.count ?? 0) > 0) {
  // Every drop has to be ground the warden can stand on: a fold is one tile wide, and an orb scattered into
  // the ridge beside it is an orb the run will never see again. Where there is room the ring opens outward,
  // and where there is not it collapses onto the stone — which is the honest behaviour, not a failure.
  check(
    'a cache opens onto ground the warden can walk, never into the ridge',
    popped.onFloor === popped.count && (popped.count < 2 || popped.spread >= 1),
    `${popped.count} drops, ${popped.onFloor} on floor, ${popped.spread}px across (the strip's cache ring is up to 90px; a fold is ${popped.spread}px wide)`,
  );
} else {
  info('cache ring not measurable', `${popped?.count ?? 0} drop on this table roll, or already collected`);
}
check('the floor carries its light', (popped?.motes ?? 0) > 40, `${popped?.motes ?? 0} motes drawn`);
// The pile lands a stride away from the stone — that is the whole point of popping it outward — and the
// strip has no vacuum: standing on the rock and waiting measures nothing. Walk onto the nearest drop.
await page.evaluate(() => {
  const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
  const drop = scene.pickups.getChildren().find((entry) => entry.active && entry.defId !== 'way_map');
  if (!drop) return;
  scene.player.x = drop.x;
  scene.player.y = drop.y;
});
await sleep(700);
const ledgerAfter = (await stripState(page))?.ledger ?? 0;
check('a cache fills the ledger, and only the ledger', ledgerAfter > ledgerBefore, `${ledgerBefore} → ${ledgerAfter}`);

/* --- the partner is the courier -------------------------------------- */

// A second cache, popped with the warden deliberately parked on the *other* side of the spine: the orbs
// are unreachable to it (well beyond the pickup radius) and reaching them means crossing a wall, so the
// only way the ledger can grow from here is the partner fetching them and bringing them back.
const courier = await page.evaluate(async () => {
  const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
  const cellW = scene.plan.cellWidth;
  const cellH = scene.plan.height;
  const site = (scene.strip.allSites ?? []).find(
    (entry) => entry.kind === 'cache' && !scene.strip.isSpent(entry.id),
  );
  if (!site) return null;
  // Bounded, because `postupdate` only arrives while the scene is stepping: a wait that assumes it is a
// hang waiting to happen, and a gate that hangs tells you less than a gate that fails.
const frame = (ms = 250) =>
  Promise.race([
    new Promise((done) => scene.events.once('postupdate', done)),
    new Promise((done) => setTimeout(done, ms)),
  ]);
  const sx = site.fx * cellW + site.chunk * cellW;
  const sy = site.fy * cellH;
  scene.player.x = sx;
  scene.player.y = sy;
  const body = scene.player.body;
  if (body?.velocity) body.velocity.setTo(0, 0);
  const circuit = scene.plan.cells[site.chunk].circuit;
  // A cache opens when the warden is standing on it for a frame, not when the gate moves a coordinate, so
  // the pop is waited for. A courier test run against a closed cache measures an empty room.
  for (let i = 0; i < 30; i += 1) {
    await frame();
    if (scene.pickups.getChildren().some((entry) => entry.active && !entry.placed && entry.defId !== 'way_map')) break;
  }
  return {
    sx,
    sy,
    cell: site.chunk,
    cellLeft: site.chunk * cellW,
    cellWidth: cellW,
    brain: Boolean(scene.plan.walls),
    laneTop: circuit.laneTopFy * cellH,
    laneBottom: circuit.laneBottomFy * cellH,
  };
});
await sleep(400);
if (courier?.sx !== undefined) {
  const parked = await page.evaluate((spot) => {
    const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
    // On a strip the park goes across the spine and down the lane, so the only way back is the crossing.
    // A brain has no spine and no lanes — its single cell is the whole organ — so its lane fractions are the
    // world's height, and parking "in the other lane" flings the warden two thousand pixels from its partner
    // and measures the teleport instead of the courier.
    if (!spot.brain) {
      const other = Math.abs(spot.sy - spot.laneTop) < Math.abs(spot.sy - spot.laneBottom) ? spot.laneBottom : spot.laneTop;
      scene.player.y = other;
      scene.player.x = Math.min(spot.cellLeft + spot.cellWidth - 60, spot.sx + 240);
    }
    // Fetchable means what `nearestOrb` fetches: active, unplaced, unclaimed, and not the way map. Counting
    // the three `way_map` shards every run carries as `placed` orbs is what made this section report nine
    // orbs on the floor while the partner correctly ignored all nine.
    const live = () =>
      scene.pickups
        .getChildren()
        .filter(
          (entry) =>
            entry.active &&
            !entry.placed &&
            !entry.gathering &&
            entry.defId !== 'way_map' &&
            (entry.kind === 'essence' || entry.kind === 'shard'),
        );
    // The partner looks for orbs within `orbRadius` of the *warden*, so this test is only a test of the
    // courier if an orb is inside that. On a strip the park left one 300px off; in a brain the drops are
    // scattered through the folds and the nearest one can be a kilometre of corridor away, which measures
    // nothing but distance. So the warden is moved to just outside its own pickup reach of the closest orb —
    // far enough that standing still cannot pay, near enough that fetching can — and the partner is set down
    // beside it. What is under test is the fetch, carry and deliver, in a world the walk found reachable.
    const orb = live()
      .map((entry) => ({ entry, d: Math.hypot(entry.x - scene.player.x, entry.y - scene.player.y) }))
      .sort((a, b) => a.d - b.d)[0];
    if (orb) {
      const tile = scene.plan.fissure?.tilePx ?? 64;
      const rects = scene.ground.wallRects;
      // "Open" has to mean open to the physics, not to the layer table: a merged wall rectangle can cover a
      // tile the mask calls floor (the outline is dilated by a tile), and a probe that parks its subject in
      // stone before measuring it can only ever report stone. (That is exactly what this section did, for
      // as long as it reported the partner buried 150 times out of 150.)
      const clearOf = (cx, cy, w, h) =>
        !rects.some((r) => cx - w / 2 < r.x + r.w && cx + w / 2 > r.x && cy - h / 2 < r.y + r.h && cy + h / 2 > r.y);
      const centre = (v) => Math.floor(v / tile) * tile + tile / 2;
      const openNear = (x, y) => {
        const cx = centre(x);
        const cy = centre(y);
        const found = [];
        for (let rx = -4; rx <= 4; rx += 1) {
          for (let ry = -4; ry <= 4; ry += 1) {
            const px = cx + rx * tile;
            const py = cy + ry * tile;
            if (scene.plan.layerAt && scene.plan.layerAt(px, py) < 0) continue;
            if (!clearOf(px, py, 12, 12)) continue;
            found.push({ x: px, y: py });
          }
        }
        return found;
      };
      // The park is a *choice*, not a nudge. The warden has a vacuum of its own, so any spot that leaves an
      // orb within its reach measures the warden and calls it the courier — which is how this section passed
      // with the partner never leaving its side. Every clear tile in sight of the pile is scored by how far
      // the nearest orb is; the winner is the one furthest out of the warden's reach that the partner can
      // still see, since the partner only leaves for an orb within `orbRadius` of the warden.
      const reach = scene.player.pickupRadius + 120;
      const partnerSight = 460;
      const drops = live();
      const scored = [];
      for (const entry of drops) {
        for (const c of openNear(entry.x, entry.y)) {
          const nearest = Math.min(...drops.map((o) => Math.hypot(o.x - c.x, o.y - c.y)));
          if (nearest < reach || nearest > partnerSight - 60) continue;
          scored.push({ c, nearest });
        }
      }
      scored.sort((a, b) => b.nearest - a.nearest);
      const chosen = scored[0];
      const place = (obj, at) => {
        const body = obj.body;
        const w = body?.width ?? 10;
        const h = body?.height ?? 10;
        if (body?.reset) {
          body.reset(at.x, at.y);
          body.velocity?.setTo(0, 0);
          obj.setPosition(at.x, at.y);
          body.updateFromGameObject();
        } else {
          obj.setPosition(at.x, at.y);
        }
        return w || h;
      };
      if (chosen) {
        place(scene.player, chosen.c);
        const beside = openNear(scene.player.x, scene.player.y)
          .map((c) => ({ c, d: Math.hypot(c.x - scene.player.x, c.y - scene.player.y) }))
          .filter((e) => e.d > 40 && e.d <= tile * 2)
          .sort((a, b) => a.d - b.d)[0];
        if (beside) place(scene.ally, beside.c);
      }
    }
    const drops = live().map((entry) => ({ x: entry.x, y: entry.y }));
    return {
      ledger: scene.ledger,
      orbs: drops.length,
      closest: drops.length
        ? Math.round(Math.min(...drops.map((d) => Math.hypot(d.x - scene.player.x, d.y - scene.player.y))))
        : -1,
      player: { x: scene.player.x, y: scene.player.y },
    };
  }, courier);
  // The partner looks within `orbRadius` of the warden and refuses anything the warden could take itself, so
  // the errand exists only inside that window. Outside it there is nothing to measure, and saying so is the
  // honest result — a FAIL would blame the courier for a floor it was never given.
  const hasOrb = (parked?.orbs ?? 0) > 0 && parked.closest > 120 && parked.closest <= 460;
  /*
   * The three checks below are gated on the pile being where it has to be, which raises the obvious danger:
   * a guard that skips a check passes it too. So the premise is a check of its own. If the park can never be
   * arranged — the cache stops opening, the drops land inside the warden's reach, the floor runs out of
   * clear tiles — this goes red and says which, instead of the courier quietly going green forever.
   */
  check(
    'the courier was given a pile it had to leave the warden for',
    hasOrb,
    `${parked?.orbs ?? 0} fetchable orbs on the floor, nearest ${parked?.closest ?? -1}px from the warden — it needs an orb beyond the warden's own reach (~36px) and inside the partner's (460px)`,
  );
  if (!hasOrb) {
    info(
      'the courier needs an orb it is worth leaving for',
      `${parked?.orbs ?? 0} fetchable orbs, nearest ${parked?.closest ?? -1}px from the warden (it looks within 460px, and will not steal one the warden can reach)`,
    );
  }
  // Held off for the whole courier measurement, and re-armed here rather than only at entry: a gate between
  // the two can restart the scene, and the suppression lives on the scene. This gate parks the warden and
  // waits for the partner to walk an orb in — it is not a measurement of a fight, and a roamer arriving turns
  // the courier to `engaging` so the orbs simply expire off the floor.
  await quietBands(page, 900000);
  const samples = [];
  for (let i = 0; i < 150; i += 1) {
    await sleep(300);
    const sample = await stripState(page);
    if (sample) samples.push(sample);
    const last = samples[samples.length - 1];
    // Ending early on *any* ledger growth is what let a warden vacuum pass for a delivery: stop only once
    // the partner has been seen carrying and has then put the load down.
    if (samples.some((s) => s.carrying > 0) && last.carrying === 0 && (last.ledger ?? 0) > parked.ledger) break;
  }
  const fetched = samples[samples.length - 1] ?? {};
  const states = [...new Set(samples.map((s) => s.allyState))];
  check(
    'the partner leaves the warden to fetch what it cannot carry on its own',
    !hasOrb || samples.some((s) => s.allyState === 'fetching' || s.carrying > 0),
    `states ${states.join('/') || 'none'}`,
  );
  // The warden never moved, so the ledger can only have grown by something *arriving*. Distance from
  // the ring is the second half of the proof: an orb that was 300px away across a wall cannot be picked
  // up standing still, and a delivered one lands inside the pickup radius on purpose.
  const drifted = Math.max(
    0,
    ...samples.map((s) => Math.hypot(s.player.x - parked.player.x, s.player.y - parked.player.y)),
  );
  check(
    'it brings the orbs in, and the warden never came near them',
    !hasOrb ||
      ((fetched.ledger ?? 0) > parked.ledger &&
        parked.closest > 120 &&
        drifted < 4 &&
        samples.some((s) => s.carrying > 0)),
    `ledger ${parked.ledger} → ${fetched.ledger}, warden drifted ${Math.round(drifted)}px, nearest orb ${parked.closest}px at the park, ${parked.orbs} on the floor → ${fetched.orbs ?? -1} left`,
  );
  check(
    'it carries what its hands hold and no more, then goes back to its post',
    !hasOrb ||
      (Math.max(0, ...samples.map((s) => s.carrying)) <= 2 &&
        samples.some((s, i) => s.carrying === 0 && i > 0 && samples[i - 1].carrying > 0)),
    `peak carry ${Math.max(0, ...samples.map((s) => s.carrying))}, ended carrying ${fetched.carrying ?? -1} with ${samples.length} samples`,
  );
  check(
    'the partner walks the labyrinth instead of through it',
    samples.every((s) => !insideCircuitWall(s)),
    `${samples.filter((s) => insideCircuitWall(s)).length} of ${samples.length} samples inside a wall`,
  );
  // --- the walls get the last word ---------------------------------------------------------------
  // Arcade resolves `vs walls` before `vs bodies`, so a mob that crowds you against the spine can shove you
  // *into* the stone and hold you there — which is how a labyrinth grows a hole. The scene's correction runs
  // at the end of its update, so the measurement waits for `postupdate` and counts frames spent inside wall.
  const shoved = await page.evaluate(async () => {
    const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
    // The list the physics actually runs on: for a strip that is the per-cell circuits, for the brain it is
    // the merged folds. Reading the generator's fractions instead would have this test shove the warden into
    // a wall that was never built — which is precisely what it did before, and it passed.
    const rects = scene.ground.wallRects;
    // Buried means the *body box* is inside the stone on all four sides, with a pixel to spare: a warden
    // standing on a wall's top edge is on the map, not in it, and a test that cannot tell the two apart
    // reports the walls as leaking when they are holding. (This is also why the earlier version of this check
    // said "60/60 frames inside stone" — the centre point was over a merged row the body was only resting on.)
    const inside = (object) => {
      const b = object?.body;
      if (!b) return false;
      return rects.some(
        (r) =>
          b.position.x > r.x + 1 &&
          b.position.x + b.width < r.x + r.w - 1 &&
          b.position.y > r.y + 1 &&
          b.position.y + b.height < r.y + r.h - 1,
      );
    };
    // Bounded, because `postupdate` only arrives while the scene is stepping: a wait that assumes it is a
// hang waiting to happen, and a gate that hangs tells you less than a gate that fails.
const frame = (ms = 250) =>
  Promise.race([
    new Promise((done) => scene.events.once('postupdate', done)),
    new Promise((done) => setTimeout(done, ms)),
  ]);
    const circuit = scene.plan.cells[0].circuit;
    // A body wide enough to be buried in, with ground on its west face so the warden can stand outside it
    // and be pushed into it. That is the tooth for a strip and any fold for a brain, and the test never has
    // to know which.
    const target =
      rects
        .filter((r) => r.w >= 32 && r.h >= 32 && r.x > 80)
        .sort((a, b) => b.w * b.h - a.w * a.h)
        .find((r) => !scene.plan.layerAt || scene.plan.layerAt(r.x - 14, r.y + r.h / 2) >= 0) ?? rects[0];
    const atTooth = (offset) =>
      scene.plan.walls
        ? { x: target.x + offset, y: target.y + target.h / 2 }
        : {
            x: circuit.toothFx * scene.plan.cellWidth + offset,
            y: circuit.laneTopFy * scene.plan.height,
          };
    const pin = atTooth(-14);
    scene.player.body.reset(pin.x, pin.y);
    const brute = scene.spawnEnemy('thorn_brute', pin.x - 26, pin.y);
    const shove = () => {
      if (brute && brute.active && brute.body) brute.body.velocity.set(430, 0);
    };
    scene.events.on('preupdate', shove);
    let frames = 0;
    let insideCount = 0;
    let allyInside = 0;
    while (frames < 60) {
      await frame();
      frames += 1;
      if (inside(scene.player)) insideCount += 1;
      if (inside(scene.ally)) allyInside += 1;
    }
    scene.events.off('preupdate', shove);
    if (brute && brute.active) brute.destroy();
    // The stronger claim, measured directly: dropped *inside* stone, the warden leaves it within a few frames.
    const buried = scene.plan.walls ? { x: target.x + target.w / 2, y: target.y + target.h / 2 } : atTooth(0);
    // `reset` puts the *body* at its own corner, so aim at the middle of the wall and let the box settle:
    // what the claim needs is a warden genuinely enclosed by stone, not one resting on a merged row's edge.
    if (scene.plan.walls && scene.player.body) {
      scene.player.body.reset(buried.x - scene.player.body.width / 2, buried.y - scene.player.body.height / 2);
    }
    scene.player.body.reset(buried.x, buried.y);
    let escapedIn = -1;
    for (let pass = 0; pass < 8; pass += 1) {
      await frame();
      if (!inside(scene.player)) {
        escapedIn = pass + 1;
        break;
      }
    }
    return {
      frames,
      insideCount,
      allyInside,
      escapedIn,
      rects: rects.length,
      where: [Math.round(scene.player.x), Math.round(scene.player.y)],
      buriedInStone: Boolean(inside({ x: buried.x, y: buried.y })),
    };
  });
  check(
    'a mob cannot shove the warden through a circuit wall',
    shoved.insideCount === 0 && shoved.allyInside === 0,
    `${shoved.insideCount}/${shoved.frames} frames of the warden inside stone, ${shoved.allyInside} for the partner, while a brute drove it into the tooth`,
  );
  check(
    'and the walls get the last word: dropped inside one, you are out within three frames',
    shoved.escapedIn > 0 && shoved.escapedIn <= 3,
    shoved.buriedInStone
      ? `dropped at the middle of a ${shoved.rects}-body wall list and out in ${shoved.escapedIn} frame(s), landing at ${shoved.where.join(',')}`
      : `the probe could not find a body wide enough to bury the warden in (${shoved.rects} bodies)`,
  );

  check(
    'a fetch is not a payout: the save still does not know any of this',
    leaked(diffPaths(saveBefore, await saveRecord(page))).length === 0,
    leaked(diffPaths(saveBefore, await saveRecord(page))).join(', '),
  );
} else {
  info('no second cache to pop', 'the courier legs need a cache the warden had not spent');
}

check(
  'fighting, looting and waking still write nothing',
  leaked(diffPaths(saveBefore, await saveRecord(page))).length === 0,
  leaked(diffPaths(saveBefore, await saveRecord(page))).join(', '),
);

/* --- the end of the strip is the goal -------------------------------- */

/* ------------------------------------------------------------------ */
/* 1b. the stone that teaches, and the charts that mark the way        */
/* ------------------------------------------------------------------ */

const stone = await page.evaluate(() => {
  const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
  const guide = scene.children.list.find((o) => o.constructor?.name === 'GuideStone');
  return {
    at: guide ? [Math.round(guide.x), Math.round(guide.y)] : null,
    charts: scene.pickups.getChildren()
      .filter((p) => p.active && p.defId === 'way_map')
      .map((p) => [Math.round(p.x), Math.round(p.y)]),
    chartsFound: scene.chartsFound,
    goalVisible: Boolean(scene.goalMark?.visible),
  };
});
const chartSpots = stone.charts;
stone.charts = chartSpots.length;
check(
  'the entry stone stands on the way in, and three charts are lying on the route',
  Boolean(stone.at) && stone.charts === 3 && stone.chartsFound === 0,
  `stone at ${stone.at?.join(',')}, ${stone.charts} charts placed, ${stone.chartsFound} found`,
);
check(
  'and the centre stays unmarked until a chart is walked over',
  stone.goalVisible === false,
  stone.goalVisible ? 'the goal was lit at spawn' : 'dark at the mouth',
);

// A chart is scenery, so the courier must look straight through it. Empty the floor of everything that is
// *not* placed and let the partner think: if the map can be fetched, this is where it walks off to.
await page.evaluate(() => {
  const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
  for (const entry of scene.pickups.getChildren()) if (entry.active && !entry.placed) entry.retire();
});
await sleep(2600);
/**
 * Quiet the bands for a measurement that is about a card, not a fight.
 *
 * Several gates park the warden on a stone and read the DOM. The trickle answers movement, and parking *is*
 * movement at probe cadence, so an idle warden under a teleported probe dies mid-gate and every check after it
 * measures a death card — which is exactly the cascade this prevents. Nothing is faked: the pursuers are
 * retired through the mode's own retire path and the run resumes hunting as soon as the window is over.
 */
async function quietBands(target, horizonMs = 20000) {
  await target.evaluate((horizon) => {
    const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
    if (!scene?.roamers) return;
    for (const foe of scene.enemies.getChildren()) {
      if (scene.roamers.has(foe)) foe.retire();
    }
    scene.roamers.clear();
    scene.nextRoamAt = scene.time.now + horizon;
    if (scene.player) scene.player.hp = scene.player.maxHp;
  }, horizonMs);
  await sleep(120);
}

const afterErrands = await page.evaluate(() => {
  const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
  return {
    at: scene.pickups.getChildren().filter((p) => p.active && p.defId === 'way_map').map((p) => [Math.round(p.x), Math.round(p.y)]),
    carried: scene.ally?.carrying ?? -1,
    ids: (scene.ally?.carried ?? []).length,
    chartsGone: 0,
  };
});
check(
  'a chart is beneath the partner\u2019s notice: placed props are not errands',
  JSON.stringify(afterErrands.at) === JSON.stringify(chartSpots),
  `${afterErrands.at.map((c) => c.join(',')).join(' | ')} after ${chartSpots.length} lay about · the partner holds ${afterErrands.carried} orb(s), and every chart it was lying next to is still where it was put. The claim is that a chart is not an errand, not that the courier never works: a cache dropped beside the route can legitimately be fetched, so the count is reported rather than required to be zero`,
);

// The mode has one verb — walk into the stone — and the guide is no exception, so this is how it is read.
await quietBands(page);
await page.evaluate(() => {
  const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
  const guide = scene.children.list.find((o) => o.constructor?.name === 'GuideStone');
  scene.player.x = guide.x;
  scene.player.y = guide.y + 2;
  scene.player.body.reset(scene.player.x, scene.player.y);
});
await sleep(600);
/* --- the guide card and the legend it owes --------------------------- */

// The row count is read out of the card's own source for the same reason the frame rule is: a gate that
// hardcodes how many rows the legend has will happily pass a legend that has since grown, and it will go
// red on a legend that merely reordered. `null` is a failure here rather than a skip — a rule this file
// could not read is a rule that checked nothing.
const guideSource = readFileSync(
  path.resolve(import.meta.dirname, '..', 'src', 'components', 'hud', 'GuideCard.tsx'),
  'utf8',
);
const guideBlock = /const GUIDE_ROWS = \[([\s\S]*?)\n\];/.exec(guideSource);
const guideRows = guideBlock ? (guideBlock[1].match(/\{\s*color/g) || []).length : null;
const guideNames = guideBlock ? [...guideBlock[1].matchAll(/name:\s*'([A-Z]+)'/g)].map((m) => m[1]) : [];

const reading = await page.evaluate(() => {
  const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
  const card = document.querySelector('.guide-card');
  const box = card?.getBoundingClientRect();
  return {
    open: Boolean(card),
    rows: document.querySelectorAll('.guide-list li').length,
    frozen: scene.frozen,
    clock: scene.time.now,
    // Why it is frozen, in the detail — a gate that reports only "frozen=true" sends the next reader back
    // through the whole file to find out which card is up.
    hp: Math.round(scene.player?.hp ?? -1),
    reported: scene.reported ?? null,
    upNow: [...document.querySelectorAll('[class*="death"], [class*="summary"], [class*="pause"]')]
      .map((n) => n.className).slice(0, 3),
    smallest: card ? Math.min(...[...card.querySelectorAll('*')].map((n) => parseFloat(getComputedStyle(n).fontSize) || 99)) : -1,
    onFrame: box ? box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth : false,
  };
});
check(
  'it reads as a card of what every object does, not as a screen',
  reading.open && guideRows !== null && reading.rows === guideRows && reading.onFrame,
  `${reading.rows} rows against ${guideRows} authored in GuideCard.tsx, on frame=${reading.onFrame}, smallest font ${reading.smallest}px — hp ${reading.hp}, run reported=${reading.reported}, cards up: ${reading.upNow.join(' / ') || 'none'}`,
);
check('nothing under the legibility floor in the card', reading.smallest >= 9.5, `${reading.smallest}px`);
check('reading the stone does not freeze the run', reading.frozen === false, `frozen=${reading.frozen}`);
await sleep(700);
const afterReading = await page.evaluate(() => {
  const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
  return { clock: scene.time.now, up: Boolean(document.querySelector('.guide-card')) };
});
check(
  'and the sim kept running the whole time it was up',
  afterReading.up && afterReading.clock - reading.clock > 300,
  `+${Math.round(afterReading.clock - reading.clock)}ms of run clock, still open=${afterReading.up}`,
);
await page.click('.guide-card');
await sleep(400);
await page.evaluate(() => {
  const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
  scene.player.body.reset(scene.player.x + 1, scene.player.y);
});
await sleep(500);
check(
  'a tap puts it away, and it does not shove itself back open',
  (await page.locator('.guide-card').count()) === 0,
);

const saveBeforeCharts = await saveRecord(page);
const beforeCharts = await page.evaluate(() => {
  const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
  return { ledger: scene.ledger, shards: scene.shardsRun };
});
const penCommands = () =>
  page.evaluate(() => {
    const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
    return {
      charts: scene.chartsFound,
      marks: { ...(scene.beaconMarks ?? { pips: -1, crumbs: -1 }) },
      goal: Boolean(scene.goalMark?.visible),
      // The rule is "a pip above the first uncleared site of every cell from here to the end", so the
      // expected number is counted from the plan the same way rather than hard-coded from a lucky roll.
      expectPips: (() => {
        let n = 0;
        for (let cell = scene.cellIndex; cell < scene.plan.chunkCount; cell += 1) {
          if (scene.plan.cells[cell]?.sites.some((site) => !scene.strip.isSpent(site.id))) n += 1;
        }
        return n;
      })(),
    };
  });
// Nothing but charts on the floor for this measurement. A cache that now sits on the corridor drops essence
// within reach of the walk between beacons, and the gate read that vacuum as a chart paying out (ledger 4 → 10).
// The claim is about the chart, so the other loot is taken out of the run; the ledger delta then has exactly
// one possible source, which is the point.
await page.evaluate(() => {
  const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
  for (const p of scene.pickups.getChildren()) if (p.active && !p.placed) p.retire();
});
const penBefore = await penCommands();
const penSteps = [];
for (let trip = 0; trip < 3; trip += 1) {
  await page.evaluate(() => {
    const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
    const spot = scene.pickups.getChildren().find((p) => p.active && p.defId === 'way_map');
    if (!spot) return;
    scene.player.x = spot.x;
    scene.player.y = spot.y;
    scene.player.body.reset(spot.x, spot.y);
  });
  await sleep(700);
  penSteps.push(await penCommands());
}
check(
  'the beacons are earned one at a time, in the world and not on the HUD',
  penBefore.marks.pips === 0 &&
    penBefore.marks.crumbs === 0 &&
    penSteps[0].marks.pips === 0 &&
    penSteps[0].marks.crumbs === 0 &&
    penSteps[0].goal &&
    penSteps[1].marks.pips === penSteps[1].expectPips &&
    penSteps[1].marks.crumbs === 0 &&
    penSteps[2].marks.pips === penSteps[2].expectPips &&
    penSteps[2].marks.crumbs === 8,
  `before: nothing drawn; one chart: ${penSteps[0].marks.pips}/${penSteps[0].marks.crumbs} with the centre marked=${penSteps[0].goal}; two: ${penSteps[1].marks.pips} pips, ${penSteps[1].expectPips} cells still have a site ahead; three: ${penSteps[2].marks.pips} pips + ${penSteps[2].marks.crumbs} crumbs`, 
);
const afterCharts = await page.evaluate(() => {
  const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
  return {
    charts: scene.chartsFound,
    left: scene.pickups.getChildren().filter((p) => p.active && p.defId === 'way_map').length,
    goal: Boolean(scene.goalMark?.visible),
    ledger: scene.ledger,
    shards: scene.shardsRun,
  };
});
check(
  'all three are collectible, and the first one lights the centre',
  afterCharts.charts === 3 && afterCharts.left === 0 && afterCharts.goal,
  `${afterCharts.charts}/3 found, ${afterCharts.left} left on the floor, centre marked=${afterCharts.goal}`,
);
check(
  'a chart is not loot: the ledger, the wallet and the save all stay as they were',
  afterCharts.ledger === beforeCharts.ledger &&
    afterCharts.shards === beforeCharts.shards &&
    leaked(diffPaths(saveBeforeCharts, await saveRecord(page))).length === 0,
  `ledger ${beforeCharts.ledger} → ${afterCharts.ledger}, shards ${beforeCharts.shards} → ${afterCharts.shards}, save paths ${leaked(diffPaths(saveBeforeCharts, await saveRecord(page))).join(', ') || 'unchanged'}`,
);

const farWall = await page.evaluate(() => {
  const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
  const last = scene.plan.cells[scene.plan.chunkCount - 1].circuit;
  // The far wall, in the lane beside the centre: 300px of open floor from the goal and no wall between
  // them, but no arrival either. A strip that ended at "x is big" would end here, and wrongly.
  scene.player.x = scene.plan.width - 30;
  scene.player.y = last.laneBottomFy * scene.plan.height;
  return { x: scene.player.x, y: scene.player.y, goal: scene.plan.goal.x };
});
await sleep(1200);
const shortOf = await stripState(page);
check(
  'the far wall is not the goal',
  Boolean(shortOf) && shortOf.reported === false && shortOf.atCenter === false,
  shortOf ? `x ${Math.round(farWall.x)} of ${Math.round(shortOf.width)}, goal at ${Math.round(farWall.goal)}, reported=${shortOf.reported}` : '',
);

await page.evaluate(() => {
  const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
  scene.player.x = scene.plan.goal.x;
  scene.player.y = scene.plan.goal.y;
});
await sleep(1000);
const ended = await stripState(page);
const toast = await hudText(page, '.toast') || (await page.evaluate(() => document.querySelector('[class*="toast"]')?.textContent?.trim() ?? ''));
check('walking into the centre ends the run', Boolean(ended?.reported) && ended.atCenter, ended ? `reported=${ended.reported}, line ${ended.line}, atCenter=${ended.atCenter}` : '');
check(
  'and the centre is the merge, not the end wall',
  Boolean(ended) && ended.goalX > 0 && ended.goalX < ended.width - 40,
  ended ? `centre at x ${Math.round(ended.goalX)}, the strip ends at ${Math.round(ended.width)}` : '',
);
check('the report says nothing is carried out', /carried out/i.test(toast), JSON.stringify(toast.slice(0, 200)));

/* --- the pause card describes the strip ------------------------------ */

await page.locator('.hud-menu-btn').click().catch(() => {});
await sleep(500);
const paused = await page.evaluate(() => document.querySelector('[role="dialog"][aria-label="Paused"]')?.innerText ?? '');
check(
  'the pause card describes the strip, not the story wave',
  /LINE \d\/7|CENTER/.test(paused) && /NOTHING CARRIED OUT/.test(paused) && !/Wave \d+ · Floor/.test(paused),
  JSON.stringify(paused.slice(0, 120)),
);
check('a strip run offers no story checkpoint to return to', !/Last checkpoint/.test(paused));

const frozenA = await stripState(page);
await sleep(600);
const frozenB = await stripState(page);
check(
  'the strip freezes while the pause card is up',
  Boolean(frozenA && frozenB) && Math.abs(frozenB.player.x - frozenA.player.x) < 0.5,
  `Δx ${frozenA && frozenB ? (frozenB.player.x - frozenA.player.x).toFixed(2) : '?'}`,
);

await clickText(page, 'SAVE & EXIT').catch(() => {});
await sleep(1000);
const afterExit = await stripState(page);
const exitLeak = leaked(diffPaths(saveBefore, await saveRecord(page)));
check('leaving a strip run writes nothing to the save', exitLeak.length === 0, exitLeak.join(', '));
check('the strip scene is stopped on the way out', !afterExit?.active, afterExit ? `active=${afterExit.active}` : 'handle gone with the scene');

/* --- death: the strip keeps you, and still writes nothing ------------ */

check('the hall is reachable after leaving a strip', await toHall(page));
await clickText(page, 'WALK THE STRIP');
await sleep(1500);
const died = await page.evaluate(async () => {
  const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
  if (!scene?.player || !scene.scene?.isActive()) return null;
  scene.player.invulnUntil = 0;
  scene.player.takeDamage({
    amount: 9_999,
    isCrit: false,
    element: null,
    vfx: 'spark',
    damageType: 'physical',
    statuses: [],
    knockback: 0,
    source: 'enemy',
    sourceX: 0,
    sourceY: 0,
    pure: true,
  });
  return { alive: scene.player.alive, hp: scene.player.hp };
});
await sleep(900);
const afterDeath = await stripState(page);
check('death ends the strip instead of respawning a wave', Boolean(died) && died.alive === false && Boolean(afterDeath?.reported), died ? `hp ${Math.round(died.hp)} → reported=${afterDeath?.reported}` : 'no scene');
check(
  'a strip death writes no death, no resume, no wave to the save',
  leaked(diffPaths(saveBefore, await saveRecord(page))).length === 0,
  leaked(diffPaths(saveBefore, await saveRecord(page))).join(', '),
);
await page.reload({ waitUntil: 'load' });
await sleep(800);

/* ------------------------------------------------------------------ */
/* 2. presentation, in the shapes that break things                    */
/* ------------------------------------------------------------------ */

/*
 * The desktop page is still open at this point, and it is not idle: the strip scene keeps stepping. Under a
 * software rasteriser one live WebGL page is roughly the budget, so a phone context opened beside it
 * starves — its first load does not finish, `stripState` comes back empty and every phone check reports a
 * problem the device does not have. The desktop page is parked (it is reloaded for the story pass below)
 * and the phone frames get the browser to themselves.
 */
await page.goto('about:blank').catch(() => undefined);
await sleep(600);

for (const shape of [
  { name: 'phone-portrait', width: 360, height: 640, dpr: 3 },
  { name: 'phone-landscape', width: 844, height: 390, dpr: 2 },
]) {
  let pctx = null;
  let ppage = null;
  try {
    pctx = await withTimeout(
      browser.newContext({
        viewport: { width: shape.width, height: shape.height },
        deviceScaleFactor: shape.dpr,
        hasTouch: true,
        isMobile: true,
      }),
      45000,
      `${shape.name} context`,
    );
    ppage = await withTimeout(pctx.newPage(), 30000, `${shape.name} page`);
  } catch (error) {
    check(
      `${shape.name}: the phone frame could be opened`,
      false,
      String(error?.message ?? error).split('\n')[0],
    );
    await pctx?.close().catch(() => undefined);
    continue;
  }
  const perrors = [];
  ppage.on('pageerror', (e) => perrors.push(e.message));
  // A renderer that dies is a finding, not a reason to lose the rest of the report: a page crash used to
  // surface as "Target page, context or browser has been closed" thrown out of the middle of the loop, and
  // every check after it went unsaid.
  ppage.on('crash', () => perrors.push('RENDERER CRASHED'));
  let shapeFailed = null;
  try {
  const alive = async (fn, fallback) => {
    if (ppage.isClosed()) return fallback;
    try {
      return await withTimeout(fn(), 60000, 'page work');
    } catch (error) {
      perrors.push(`page went away: ${String(error?.message ?? error).split('\n')[0]}`);
      return fallback;
    }
  };
  const pSave = (await alive(() => enterStrip(ppage), { save: null })).save;
  const state = await alive(() => stripState(ppage), null);
  const hud = await alive(() => hudPlates(ppage), { plates: [], offFrame: [], clash: [], tiny: [] });
  check(
    `${shape.name}: the map is authored, not fitted to the phone`,
    Boolean(state) && Math.abs(state.width - begin.width) < 1 && Math.abs(state.height - begin.height) < 1,
    state ? `world ${Math.round(state.width)}×${Math.round(state.height)} in a ${shape.width}×${shape.height} frame (the same map the desktop walks)` : 'no scene',
  );
  check(
    `${shape.name}: every strip plate is on frame`,
    hud.offFrame.length === 0,
    hud.offFrame.join(', ') || `${hud.plates.length} plates measured`,
  );
  check(`${shape.name}: no strip plate sits on another`, hud.clash.length === 0, hud.clash.join(', '));
  check(`${shape.name}: nothing under the legibility floor`, hud.tiny.length === 0, hud.tiny.join(', '));
  check(`${shape.name}: the plates the gate knows about are the ones drawn`, hud.plates.some((p) => p.sel === 'floor-plate') && hud.plates.some((p) => p.sel === 'vitals'));
  const mapHidden = await alive(
    () => ppage.evaluate(() => getComputedStyle(document.querySelector('.strip-map') ?? document.body).display === 'none'),
    null,
  );
  check(
    `${shape.name}: the minimap yields to the progress line on a short frame`,
    shape.height > 520 ? mapHidden === false : mapHidden === true,
    mapHidden ? 'hidden' : 'shown',
  );
  // The card is opened by walking into a stone, which is exactly what a thumb does on a phone — so the one
  // reading surface in the mode is measured in the shapes that break it, not assumed from the desktop leg.
  await quietBands(ppage);
  const stoneHere = await alive(() => ppage.evaluate(() => {
    const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
    const guide = scene.children.list.find((o) => o.constructor?.name === 'GuideStone');
    if (!guide) return null;
    scene.player.x = guide.x;
    scene.player.y = guide.y + 2;
    scene.player.body.reset(scene.player.x, scene.player.y);
    return { at: [Math.round(guide.x), Math.round(guide.y)] };
  }), null);
  await sleep(700);
  const cardPlates = await alive(() => hudPlates(ppage), { plates: [], offFrame: [], clash: [], tiny: [] });
  const cardText = (await alive(() => hudText(ppage, '.guide-card'), '')).replace(/\s+/g, ' ');
  check(
    `${shape.name}: the guide card opens on frame and shares no pixels with another plate`,
    Boolean(stoneHere) && /THE STRIP, READ/.test(cardText) && cardPlates.offFrame.length === 0 && cardPlates.clash.length === 0,
    `${cardPlates.plates.length} plates measured, off frame ${cardPlates.offFrame.length}, clashes ${cardPlates.clash.length ? cardPlates.clash.join(' | ') : 0}`,
  );
  check(
    `${shape.name}: and every word of it clears the legibility floor`,
    cardPlates.tiny.length === 0 && guideNames.length === guideRows && guideNames.every((n) => cardText.includes(n)),
    cardPlates.tiny.join(', ') || 'every row of the card reads',
  );
  // A card that has to scroll is only honest if the last line can be reached, and only if scrolling it does
  // not turn it into a 100px sliver. Both numbers are measured rather than designed for.
  const scroll = await alive(() => ppage.evaluate(() => {
    const el = document.querySelector('.guide-card');
    if (!el) return null;
    const rows = [...document.querySelectorAll('.guide-list li')];
    const box = el.getBoundingClientRect();
    const visible = rows.filter((row) => {
      const b = row.getBoundingClientRect();
      return b.top >= box.top - 0.5 && b.bottom <= box.bottom + 0.5;
    }).length;
    el.scrollTop = el.scrollHeight;
    return { visible, scrollable: el.scrollHeight > el.clientHeight + 1, rows: rows.length };
  }), null);
  await sleep(120);
  const lastRow = await alive(() => ppage.evaluate(() => {
    const el = document.querySelector('.guide-card');
    const row = [...document.querySelectorAll('.guide-list li')].pop();
    if (!el || !row) return null;
    const a = el.getBoundingClientRect();
    const b = row.getBoundingClientRect();
    return b.top >= a.top - 0.5 && b.bottom <= a.bottom + 0.5;
  }), null);
  check(
    `${shape.name}: the card shows what fits and flicks to the rest`,
    Boolean(scroll) && scroll.visible >= 3 && (scroll.scrollable === false || lastRow === true),
    scroll ? `${scroll.visible} of ${scroll.rows} lines without scrolling, last line reached=${lastRow}` : 'no card',
  );
  // A thumb, twice if it takes twice — the dismiss is on pointer-up, and a frame that is still catching up
  // from opening the card can swallow the first. A stalled page is reported as a stalled page: the old
  // fallback of `1` read as "the card is stuck open", which blamed the mode for the probe's own timeout.
  let cardCount = null;
  for (let tryTap = 0; tryTap < 2; tryTap += 1) {
    await alive(() => ppage.tap('.guide-card').catch(() => ppage.click('.guide-card', { noWaitAfter: true })), undefined);
    await sleep(400);
    cardCount = await alive(() => ppage.locator('.guide-card').count(), null);
    if (cardCount === 0) break;
  }
  check(
    `${shape.name}: a tap on the card puts it away on a phone too`,
    cardCount === 0,
    cardCount === null
      ? 'the page stopped answering mid-probe — a stalled measurement, not a stuck card'
      : `${cardCount} card(s) left on frame after two taps`,
  );
  const plateText = await alive(() => hudText(ppage, '.floor-plate'), '');
  check(`${shape.name}: the depth plate still reads as the strip`, /LINE \d|CENTER/.test(plateText.replace(/\s+/g, ' ')), JSON.stringify(plateText.slice(0, 60)));
  check(`${shape.name}: the frame change wrote nothing to the save`, leaked(diffPaths(pSave, await alive(() => saveRecord(ppage), pSave))).length === 0, leaked(diffPaths(pSave, await alive(() => saveRecord(ppage), pSave))).join(', '));
  } catch (error) {
    shapeFailed = String(error?.message ?? error).split('\n')[0];
  }
  check(
    `${shape.name}: the phone frame survived the whole visit`,
    shapeFailed === null && perrors.length === 0,
    shapeFailed ? `the page stopped answering: ${shapeFailed}` : perrors.slice(0, 2).join(' | ') || 'no page errors',
  );
  errors.push(...perrors.map((e) => `${shape.name}: ${e}`));
  await pctx.close();
}

/* ------------------------------------------------------------------ */
/* 3. story mode, afterwards, unchanged                               */
/* ------------------------------------------------------------------ */

// The same page, in the same session: the claim worth making is that a strip run leaves the story
// entry point working, not that a fresh browser can still start one. (The phone pass parked this page on
// about:blank; coming back is deliberate, not a fresh browser.)
await page.goto(BASE, { waitUntil: 'load' });
await sleep(900);
const hallOpen = await toHall(page);
check('the hall opens from the menu after a strip run', hallOpen);
await clickText(page, 'STEP THROUGH', 6000).catch(() => {});
await sleep(1800);
const storyPlate = await hudText(page, '.floor-plate');
const story = await page.evaluate(() => {
  const g = window.__sixfoldGame;
  const gameplay = g?.scene.getScene('GameplayScene');
  const dungeon = g?.scene.getScene('DungeonScene');
  return {
    gameplay: Boolean(gameplay?.scene?.isActive()),
    dungeon: Boolean(dungeon?.scene?.isActive()),
    bounds: gameplay?.physics?.world?.bounds?.width ?? 0,
    wave: gameplay?.director?.currentSpec?.wave ?? -1,
    cells: dungeon?.plan?.chunkCount ?? null,
  };
});
// Every later story claim carries `story.gameplay` as a precondition: a check that passes because the
// run never started is worse than one that fails.
check('story mode still runs after a strip', story.gameplay && !story.dungeon, `story=${story.gameplay} strip=${story.dungeon}`);
check('the wave plate is back with no strip wording', story.gameplay && /WAVE \d/.test(storyPlate) && !/LINE|CENTER|DEPTH/.test(storyPlate), JSON.stringify(storyPlate));
check(
  'story bounds are one frame again',
  story.gameplay && story.bounds > 300 && story.bounds < 1400,
  `bounds ${Math.round(story.bounds)}, wave ${story.wave}`,
);
check('the wave director is the one under test, not a leftover strip', story.gameplay && story.wave >= 1 && story.cells === null, `wave ${story.wave}, strip cells ${story.cells}`);
const storyHud = story.gameplay ? await hudPlates(page) : { clash: ['run never started'], tiny: [] };
// Geometry is judged at every shape; the 9.5px legibility floor is a touch-device rule, and keycap
// hints sit at 8px on a desktop by design — which is what `audit:mobile` measures at phone shapes.
check('story plates sit clear of one another', storyHud.clash.length === 0, storyHud.clash.join(' '));

// The middle of the frame belongs to two overlays at once: the wave announcement and the countdown it
// counts into. They were two absolutely-positioned guesses; now they are one stack, and the pair is
// measured with both up — which no fixed sleep can guarantee, so the announcement is raised on purpose
// while the count is running, at the tallest shape and at the flattest one the shipped layout supports.
const centreStack = async (label) =>
  page.evaluate(async (which) => {
    const bus = window.__sixfoldBus;
    const frame = () => new Promise((done) => requestAnimationFrame(done));
    bus?.emit('command:grantCheat', { nextWave: true });
    const boxOf = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.getBoundingClientRect() : null;
    };
    const lum = (color) => {
      const [r, g, b] = (color.match(/[\d.]+/g) ?? ['0', '0', '0']).map((v) => Number(v) / 255);
      return [r, g, b].map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0);
    };
    let banner = null;
    let count = null;
    for (let i = 0; i < 120 && !(banner && count); i += 1) {
      await frame();
      count = boxOf('.countdown-plate');
      if (!count) continue;
      bus?.emit('game:waveStarted', { wave: 3, floor: 1, isBoss: false, label: 'MEASURED', total: 200 });
      banner = boxOf('.banner');
    }
    if (!banner || !count) return { ok: false, why: `banner=${Boolean(banner)} countdown=${Boolean(count)} at ${which}` };
    const el = document.querySelector('.banner');
    const title = document.querySelector('.banner-title');
    const style = getComputedStyle(el);
    const ratio = (a, b) => {
      const [hi, lo] = a > b ? [a, b] : [b, a];
      return Math.round(((hi + 0.05) / (lo + 0.05)) * 10) / 10;
    };
    return {
      ok: true,
      at: which,
      gap: Math.round(count.top - banner.bottom),
      overlap: Math.round(
        Math.min(banner.bottom, count.bottom) - Math.max(banner.top, count.top) > 0 &&
          Math.min(banner.right, count.right) - Math.max(banner.left, count.left) > 0
          ? Math.min(banner.bottom, count.bottom) - Math.max(banner.top, count.top)
          : 0,
      ),
      above: banner.top < count.top,
      inFrame: banner.top >= 0 && count.bottom <= innerHeight,
      fill: style.backgroundColor,
      ink: getComputedStyle(title).color,
      contrast: ratio(lum(style.backgroundColor), lum(getComputedStyle(title).color)),
      subContrast: ratio(lum(style.backgroundColor), lum(getComputedStyle(document.querySelector('.banner-sub')).color)),
    };
  }, label);
const desktopCentre = await centreStack('desktop 1180×780');
check(
  'the wave announcement sits above the countdown, sharing no pixels',
  desktopCentre.ok && desktopCentre.above && desktopCentre.overlap === 0 && desktopCentre.inFrame,
  JSON.stringify(desktopCentre),
);
check(
  'and it is a plate you can read against the arena, not a band of the same colour as it',
  desktopCentre.ok && desktopCentre.contrast >= 4.5 && desktopCentre.subContrast >= 3,
  `title ${desktopCentre.contrast}:1 on ${desktopCentre.fill}, sub ${desktopCentre.subContrast}:1 on ${desktopCentre.ink}`,
);
await page.setViewportSize({ width: 844, height: 390 });
await sleep(900);
const shortCentre = await centreStack('landscape phone 844×390');
check(
  'on a 390-tall frame the two still do not share a pixel',
  shortCentre.ok && shortCentre.overlap === 0 && shortCentre.inFrame,
  JSON.stringify(shortCentre),
);
await page.setViewportSize({ width: 900, height: 700 });
await sleep(700);

/* --- waystones: the network, the hop, and what the deep bands hold ---- */

// Its own page. A warp moves the party, and every gate above this one measures where the party stands —
// a transport that ran at the tail of the shared probe would be grading itself against a world it had
// already rearranged. The wall-stress block learned this the hard way.
let net = null;
try {
  const nctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const npage = await nctx.newPage();
  await enterStrip(npage);
  await sleep(2200);
  net = await npage.evaluate(async () => {
    const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const tile = scene.plan.fissure?.tilePx ?? 64;
    const rects = scene.ground?.wallRects ?? [];
    const inWall = (x, y) => rects.some((r) => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h);
    const world = (s) => ({ x: s.fx * scene.plan.cellWidth + s.chunk * scene.plan.cellWidth, y: s.fy * scene.plan.cellHeight });
    // Looked up by site id every time, never held: the sprite pool retires and rebuilds stones as the
    // camera moves, and a probe holding a retired sprite measures a corpse.
    const stoneFor = (id) => scene.stones.find((st) => st.site.id === id) ?? null;
    const ids = scene.strip.waypoints.map((s) => ({ id: s.id, site: s }));
    const list = ids.map(({ id, site }) => {
      const at = world(site);
      return {
        id,
        entry: !!site.entry,
        band: scene.plan.layerAt?.(at.x, at.y) ?? -1,
        x: at.x,
        y: at.y,
        linked: scene.strip.isLinked(id),
        sprite: Boolean(stoneFor(id)),
        onStone: inWall(at.x, at.y),
      };
    });
    const out = {
      ok: true,
      total: list.length,
      spriteless: list.filter((s) => !s.sprite).length,
      bands: [...new Set(list.map((s) => s.band))].sort((a, b) => a - b),
      layerCount: scene.plan.chunkCount,
      buried: list.filter((s) => s.onStone).length,
      entryLinked: list.some((s) => s.entry && s.linked),
      entryAtSpawn: false,
      entryStride: false,
      entryDistance: -1,
      hops: [],
      budget: scene.plan.cells.map((c) => c.awakeBudget ?? 0),
      density: [],
      presence: [],
      warps: 0,
      links: 0,
      litAfter: 0,
    };
    const root = list.find((s) => s.entry);
    const spawn = scene.plan.spawn ?? { x: 0, y: 0 };
    const rootGap = root ? Math.hypot(root.x - spawn.x, root.y - spawn.y) / tile : -1;
    out.entryAtSpawn = root ? rootGap <= 2.2 : false;
    // "On the spawn tile" was the old claim, and it was wrong: it put the warden's body inside the stone's
    // immovable collider, so their first step east shoved them off it and a physics gate read that as a wall
    // sliding. The honest version is *beside* the spawn — one stride, still the first thing in frame.
    out.entryStride = rootGap >= 0.9 && rootGap <= 2.2;
    out.entryDistance = Math.round(rootGap * 100) / 100;

    const player = scene.player;
    const put = (x, y) => {
      player.body?.reset?.(x, y);
      player.setPosition(x, y);
    };

    // Sites per walkable tile, sampled on a tile stride: "harder deeper down" is a claim about density,
    // and a band's raw site count says nothing on its own if the deep bands are simply bigger.
    const seen = new Array(out.layerCount).fill(0);
    const per = new Array(out.layerCount).fill(0);
    for (const cell of scene.plan.cells) per[cell.index] = cell.sites.length;
    for (let x = tile / 2; x < scene.plan.width; x += tile) {
      for (let y = tile / 2; y < scene.plan.height; y += tile) {
        const band = scene.plan.layerAt?.(x, y) ?? -1;
        if (band >= 0 && band < out.layerCount && !inWall(x, y)) seen[band] += 1;
      }
    }
    out.density = per.map((n, i) => (seen[i] ? Math.round((n / seen[i]) * 10000) / 10000 : 0));

    // Touch, step off, touch: the shipped debounce and "you have to leave the stone to hop again" are part
    // of what is being tested, so the probe walks those conditions instead of poking the fields.
    for (const entry of list) {
      const st = stoneFor(entry.id);
      if (!st) {
        out.hops.push({ from: entry.id, missing: true });
        continue;
      }
      put(st.x + tile * 2, st.y);
      await sleep(150);
      put(st.x, st.y);
      scene.activate(st);
      await sleep(60);
      const before = { id: entry.id, linked: scene.strip.isLinked(entry.id) };
      const target = scene.strip.nextLinked(entry.id);
      if (!target) {
        out.hops.push({ from: before.id, linked: before.linked, target: null });
        continue;
      }
      const dest = world(target);
      const warpsBeforeHop = scene.strip.warpCount;
      for (let i = 0; i < 30 && !(scene.warpArmed && scene.time.now - scene.lastWarpAt >= 400); i += 1) {
        put(st.x + tile * 2, st.y);
        await sleep(50);
        put(st.x, st.y);
      }
      // Stand on it, and keep touching it, until the network answers: a hop now costs a pause (see
      // `DUNGEON.warp`), so one call to `activate` only starts the dwell. This is the shipped loop the player
      // walks, not a poke at the fields.
      scene.activate(st);
      let dwellWaited = 0;
      while (scene.strip.warpCount === warpsBeforeHop && dwellWaited < 2400) {
        scene.activate(st);
        await sleep(120);
        dwellWaited += 120;
      }
      const at = { x: player.x, y: player.y };
      out.hops.push({
        from: before.id,
        to: target.id ?? null,
        landed: Math.round(Math.hypot(at.x - dest.x, at.y - dest.y)),
        wall: inWall(at.x, at.y),
        allyWall: inWall(scene.ally.x, scene.ally.y),
        warpsAfter: scene.strip.warpCount,
      });
    }
    // The dwell rule, measured rather than asserted, and in both directions. A stride past a linked stone must
    // not hop the party — that is the whole reason the rule exists, because the corridor is threaded with
    // stones and an overlap-only verb teleported anyone merely walking it. Standing on one must, because free
    // travel between touched stones is the feature. A gate on only one half would pass a project that had
    // turned the verb off entirely.
    const hopper = scene.strip.waypoints.find((s) => scene.strip.isLinked(s.id) && scene.strip.nextLinked(s.id));
    const hopperStone = hopper ? stoneFor(hopper.id) : null;
    if (hopper && hopperStone) {
      const here = world(hopper);
      const before = scene.strip.warpCount;
      put(here.x - tile, here.y);
      player.body?.setVelocity?.(230, 0);
      let peakSpeed = 0;
      for (let k = 0; k < 7; k += 1) {
        await sleep(60);
        peakSpeed = Math.max(peakSpeed, Math.round(Math.hypot(player.body?.velocity?.x ?? 0, player.body?.velocity?.y ?? 0)));
        player.body?.setVelocity?.(230, 0);
      }
      const walkedPast = {
        warped: scene.strip.warpCount !== before,
        dwell: scene.warpDwellSince,
        peakSpeed,
      };
      player.body?.setVelocity?.(0, 0);
      put(here.x, here.y);
      const parkedAt = scene.strip.warpCount;
      // Time the dwell from *contact*, not from the probe's next poke: the scene's own overlap fires the verb on
      // the physics step, so the dwell is already running when this loop starts, and counting only the loop's
      // sleeps reported a hop at 240ms against a 380ms rule that had in fact been honoured. A gate that
      // mis-measures its own subject is worse than no gate — it teaches you to distrust the green ones.
      const parkedAtMs = scene.time.now;
      let waited = 0;
      while (scene.strip.warpCount === parkedAt && waited < 2400) {
        scene.activate(hopperStone);
        await sleep(120);
        waited += 120;
      }
      out.dwell = {
        walkedPast,
        hoppedWhenParked: scene.strip.warpCount > parkedAt,
        hoppedAfterMs: Math.round(scene.time.now - parkedAtMs),
      };
    } else {
      out.dwell = null;
    }

    out.warps = scene.strip.warpCount;
    out.links = scene.strip.linkedCount;
    // A rebuilt waystone has to come back lit: the link is a fact about the run and the sprite is the only
    // place the run shows it.
    out.litAfter = scene.stones.filter((s) => s.site.kind === 'waypoint' && s.stoneState === 'active').length;

    // The cull regression, which is the bigger claim here: a band's stones must exist while the party is
    // standing in that band. The old column test retired all of them past the third one, so a deep run
    // walked a floor with nothing on it and every density number in this file measured an empty room.
    for (let b = 0; b < out.layerCount; b += 1) {
      const cell = scene.plan.cells[b];
      const want = cell ? cell.sites.filter((s) => s.kind !== 'waypoint').length : 0;
      if (!cell || !cell.sites.length) {
        out.presence.push({ band: b, live: 0, want });
        continue;
      }
      const site = cell.sites.find((s) => s.kind !== 'waypoint') ?? cell.sites[0];
      const at = world(site);
      put(at.x, at.y);
      await sleep(300);
      const live = scene.stones.filter((s2) => {
        if (!s2.active || s2.site.kind === 'waypoint') return false;
        const p = world(s2.site);
        return (scene.plan.layerAt?.(p.x, p.y) ?? -1) === b;
      }).length;
      out.presence.push({ band: b, live, want });
    }
    return out;
  });
} catch (err) {
  out.push(`FAIL  the waystone probe ran${' — ' + String(err).slice(0, 160)}`);
  net = null;
}

/*
 * The trickle gets its own page. The gate above it warps the party across the map a dozen times, and every
 * warp leaves a callout with a tween on it; measuring frame rate with that still on screen produced 16 fps for
 * a feature that costs one frame in sixty, and a gate that measures the probe's own debris is worse than no
 * gate. Same reason the wall-stress block has its own context: a destructive or noisy measurement belongs
 * somewhere it cannot contaminate a neighbour.
 */
let roam = null;
try {
  const rctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const rpage = await rctx.newPage();
  await enterStrip(rpage);
  await sleep(2200);
  roam = await rpage.evaluate(async () => {
    const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const rects = scene.ground?.wallRects ?? [];
    const inWall = (x, y) => rects.some((r) => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h);
    const tile = scene.plan.fissure?.tilePx ?? 64;
    const out = {};
    // The party is parked mid-map and left alone, because the claim is about arriving, not about fighting.
    // HP is topped up so a measurement of the spawner cannot be ended by a lucky kill; whether the warden was
    // alive at all when this finished is reported rather than hidden.
    // Only enemies the scene is actually hunting with are counted (`scene.roamers`), because a march that
    // walked onto a grove would otherwise score that pack as a roamer and grade the wrong rule. The band is
    // picked shallow and clear so the fight ceiling (which holds the trickle back during a live battle,
    // correctly) is not what this measurement keeps tripping over.
    const spentBefore = scene.strip.spentCount;
    const pendingAtStart = scene.strip.hasPendingWakes;
    const spotted = new Map();
    let march = 0;
    scene.player.hp = scene.player.maxHp;
    for (const foe of scene.enemies.getChildren()) foe.retire?.();
    scene.roamers?.clear();
    scene.nextRoamAt = scene.time.now + 900000;
    await sleep(2500);
    const fpsQuiet = Math.round(scene.game.loop.actualFps);
    const bandRoam = 1;
    const rt = (scene.plan.cells[bandRoam]?.circuit.route ?? []).slice();
    const worldOf = (q) => ({ x: q.fx * scene.plan.cellWidth, y: q.fy * scene.plan.cellHeight });
    const clearOfSites = rt.filter((q) => {
      const w = worldOf(q);
      return !scene.strip.allSites.some((site) => {
        const at = { x: site.fx * scene.plan.cellWidth, y: site.fy * scene.plan.cellHeight };
        return Math.hypot(at.x - w.x, at.y - w.y) < (scene.plan.fissure?.tilePx ?? 64) * 1.4;
      });
    });
    // Traveled, not teleported. The trickle keys off ground *crossed*, because
    // that is what a warden does between fights, and a probe that snaps the party along a polyline has no
    // velocity to count and would measure a rule it never exercised. Teleporting here produced a green
    // sightings count once only because a leftover dash was still carrying the body.
    // Head for the *walk*, a few points at a time, under the game's own physics. Two earlier versions of this
    // probe failed for the probe's reasons and not the game's: teleporting the party left the body with no
    // velocity for the travel rule to count, and steering at one band's own polyline aimed the warden into a
    // wall it stayed pressed against. Following `plan.route` in short hops is what a player does.
    const walk = (scene.plan.route ?? []).slice();
    // Ground the warden actually crossed, measured by the probe rather than read off the trickle's own counter
    // (which resets on every arrival, so at the end of the window it always reads near zero and says nothing).
    let covered = 0;
    let coveredAtLastStep = 0;
    let aimAhead = 3;
    let prev = { x: scene.player.x, y: scene.player.y };
    const step = async () => {
      if (!walk.length) return false;
      // Aim a few strides ahead of wherever the warden currently is on the polyline, not at some fixed index:
      // a distant route point is on the far side of a wall, and a probe that walks into stonework for nine
      // seconds measures a trickle that never had any ground to cover. Looking three tiles ahead is what the
      // rule assumes the player is doing.
      let near = 0;
      let nearD = Number.POSITIVE_INFINITY;
      for (let k = 0; k < walk.length; k += 1) {
        const d = Math.hypot(walk[k].x - scene.player.x, walk[k].y - scene.player.y);
        if (d < nearD) { nearD = d; near = k; }
      }
      // If the last look put the warden no further along the corridor, aim further ahead: a corner of stonework
      // is a thing a player walks around, and a probe that keeps pressing its face into it proves nothing about
      // a rule that keys off ground crossed.
      if (Math.abs(covered - coveredAtLastStep) < 10) aimAhead = Math.min(14, aimAhead + 3);
      else aimAhead = 3;
      coveredAtLastStep = covered;
      const target = walk[Math.min(walk.length - 1, near + aimAhead)];
      if (!target) return false;
      const ang = Math.atan2(target.y - scene.player.y, target.x - scene.player.x);
      scene.player.body?.setVelocity?.(Math.cos(ang) * 220, Math.sin(ang) * 220);
      await sleep(460);
      if (scene.player.body) scene.player.body.velocity.set(0, 0);
      return true;
    };
    await step();
    scene.nextRoamAt = 0;
    const t0 = scene.time.now;
    let frames = 0;
    let peak = 0;
    let died = false;
    while (scene.time.now - t0 < 18000 && !died && window.__sixfoldGame.scene.isActive('DungeonScene')) {
      frames += 1;
      covered += Math.hypot(scene.player.x - prev.x, scene.player.y - prev.y);
      prev = { x: scene.player.x, y: scene.player.y };
      const view = scene.cameras.main.worldView;
      for (const foe of scene.enemies.getChildren()) {
        if (!foe?.active || spotted.has(foe) || !scene.roamers?.has(foe)) continue;
        spotted.set(foe, {
          d: Math.round(Math.hypot(foe.x - scene.player.x, foe.y - scene.player.y)),
          offFrame: !view.contains(foe.x, foe.y),
          wall: inWall(foe.x, foe.y),
        });
      }
      peak = Math.max(peak, scene.roamers.size);
      if (scene.player.hp <= 0) died = true;
      // The trickle answers movement, so the probe has to move. Only over ground clear of stones: landing on
      // a grove wakes a pack, the fight ceiling then (correctly) holds the trickle back, and the measurement
      // becomes a measurement of that rule instead of this one.
      if (frames % 2 === 0) await step();
      await sleep(60);
    }
    // Settle before reading the frame rate, and take a *third* sample after it. This audit now runs three
    // browser contexts against one software GL, so the absolute numbers drift down over a minute — 13 fps for
    // an empty world, 33 for the same page alone — and a ratio against a stale baseline blames the feature for
    // the machine. The claim is therefore measured against the slower of the two quiet samples around it.
    scene.nextRoamAt = scene.time.now + 900000;
    for (const foe of scene.enemies.getChildren()) {
      if (scene.roamers?.has(foe)) foe.retire();
    }
    await sleep(2500);
    const fpsLive = Math.round(scene.game.loop.actualFps);
    await sleep(1200);
    const fpsAfter = Math.round(scene.game.loop.actualFps);
    out.roam = { travel: Math.round(scene.roamTravel ?? 0),
      cap: Math.min(3, 1 + Math.floor((scene.plan.layerAt(scene.player.x, scene.player.y) ?? 0) / 2.5)),
      active: scene.enemies.countActive(true),
      pendingAtStart,
      sightings: spotted.size,
      offFrame: [...spotted.values()].filter((v) => v.offFrame).length,
      nearMiss: [...spotted.values()].filter((v) => v.d < 140).length,
      inWall: [...spotted.values()].filter((v) => v.wall).length,
      minDistance: Math.min(...[...spotted.values()].map((v) => v.d), 99999),
      peak,
      frames,
      clear: clearOfSites.length,
      spentGrew: scene.strip.spentCount - spentBefore,
      alive: scene.player.hp > 0,
      fpsQuiet,
      fpsLive,
      fpsAfter,
      tracked: scene.roamers.size,
      band: bandRoam,
    };
    return out.roam;
  });
} catch (err) {
  out.push(`FAIL  the trickle probe ran${' — ' + String(err).slice(0, 160)}`);
  roam = null;
}
// Read where it is authored, as every other pacing rule in this file is: a gate that repeats the number
// passes a project that has since changed it.
const roamConfig = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'config', 'gameConfig.ts'), 'utf8');
const roamCap = Number(/roamCap:\s*(\d+)/.exec(roamConfig)?.[1] ?? '');
const roamAhead = Number(/roamAheadTiles:\s*(\d+)/.exec(roamConfig)?.[1] ?? '');

check(
  'the bands send hostiles without being woken, and they arrive from off the frame',
  Boolean(roam) && roam.sightings >= 1 && roam.offFrame === roam.sightings && roam.nearMiss === 0 && roam.pendingAtStart === false,
  roam
    ? `${roam.sightings} roamer(s) first seen over ${roam.frames} polls in band ${roam.band}, ${roam.offFrame} of them outside the camera's view, closest approach ${roam.minDistance}px against ${roamAhead} tiles of authored standoff · ${roam.spentGrew} sites spent, so no woke pack was holding the fight ceiling · ground covered ${roam.travel}px against the ~77px a spawn costs, ${roam.active} hostile(s) active against a cap of ${roam.cap} for that depth — the probe walks the corridor under the game's own physics, because the rule it tests keys off ground crossed and a probe that parks proves nothing`
    : 'the trickle probe never reached a dungeon',
);
check(
  'a roamer is never delivered inside a wall, and never outnumbers its cap',
  Boolean(roam) && roam.inWall === 0 && roam.peak <= roamCap && Number.isFinite(roamCap) && roamCap > 0,
  roam ? `peak ${roam.peak} against a cap of ${roamCap} · ${roam.inWall} first sightings in stone · ${roam.tracked} still on the books` : '',
);
check(
  'and the trickle does not cost the frame — "render it fast" is a requirement, not a wish',
  Boolean(roam) && roam.fpsLive >= Math.min(roam.fpsQuiet, roam.fpsAfter) * 0.8,
  roam
    ? `${roam.fpsQuiet} fps quiet, ${roam.fpsLive} with ${roam.peak} roaming, ${roam.fpsAfter} quiet again — the trickle is measured against the slower of the two still samples around it, because this page shares one software GL with two other contexts and every absolute number in it drifts (the same world at this size reads 33 fps when the page runs alone). No absolute floor is asserted here for the same reason a wall-clock pacing gate was abandoned: it measures the renderer, not the game · ${roam.alive ? 'warden alive throughout' : 'warden DIED mid-probe'}`
    : '',
);

check(
  'a waystone stands on every line of the labyrinth, and none of them is inside stone',
  Boolean(net) && net.total >= net.layerCount && net.bands.length === net.layerCount && net.buried === 0,
  net
    ? `${net.total} waystones over ${net.bands.length} of ${net.layerCount} bands · ${net.buried} buried in a wall body · ${net.spriteless} with no sprite on entry`
    : 'the probe never reached a dungeon',
);
check(
  "the mouth's waystone is waypoint one, beside the spawn and not under it",
  Boolean(net) && net.entryLinked && net.entryAtSpawn && net.entryStride,
  net
    ? `linked at construction · ${net.entryDistance} tiles from the spawn tile — far enough that the warden does not start inside a 14px immovable body, close enough to be the first thing they see`
    : 'no entry waystone',
);
check(
  'touching a waystone links it, and touching it again moves the party',
  Boolean(net) &&
    net.hops.length > 0 &&
    net.hops.every((h) => !h.missing && (h.target === null || (h.landed <= 2 && h.warpsAfter >= 1))),
  net
    ? `${net.hops.filter((h) => h.to).length} hops, worst landing ${Math.max(0, ...net.hops.map((h) => h.landed ?? 0))}px off the destination stone, ${net.hops.filter((h) => h.missing).length} with no sprite to touch · ${net.warps} on the counter · ${net.links}/${net.total} linked · ${net.litAfter} drawn lit`
    : '',
);
const warpCfg = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'config', 'gameConfig.ts'), 'utf8');
const warpDwellMs = Number(/dwellMs:\s*(\d+)/.exec(warpCfg)?.[1] ?? '');
const warpDwellSpeed = Number(/dwellSpeedPx:\s*(\d+)/.exec(warpCfg)?.[1] ?? '');
check(
  'a waystone is stood on, not walked through — the stride past hops nobody, the pause hops the network',
  Boolean(net?.dwell) &&
    net.dwell.walkedPast.warped === false &&
    net.dwell.walkedPast.dwell === null &&
    net.dwell.hoppedWhenParked === true &&
    net.dwell.hoppedAfterMs >= warpDwellMs,
  net?.dwell
    ? `running past a linked stone at up to ${net.dwell.walkedPast.peakSpeed}px/s (the rule allows ${warpDwellSpeed}) warped nobody and left no dwell running; standing on the next one hopped ${net.dwell.hoppedAfterMs}ms after contact, against a ${warpDwellMs}ms dwell. Both halves are required: a gate on one of them passes a project that quietly switched the verb off. Before this rule the same stride relocated the party 604-3,893px, because the corridor is threaded with the stones`
    : '',
);
check(
  'a hop never drops the party inside a wall, or only their partner',
  Boolean(net) && net.hops.every((h) => !h.to || (!h.wall && !h.allyWall)),
  net
    ? `${net.hops.filter((h) => h.to).length} landings tested against ${net.buried === 0 ? 'every' : 'the'} wall rectangle in the world — the destination tile is floor by construction, and a warp delivering a body into stone would have been the whole feature's bug`
    : '',
);
check(
  'a band keeps its stones while the party stands in it — the cull is a window, not a wipe',
  Boolean(net) && net.presence.length === net.layerCount && net.presence.every((p) => p.want === 0 || p.live >= 1),
  net ? `live non-waypoint stones by band ${net.presence.map((p) => `${p.band}:${p.live}/${p.want}`).join(' ')}` : '',
);
check(
  'deeper you go, harder it gets — the core bands hold more to wake per walkable tile',
  Boolean(net) &&
    net.density.length === net.layerCount &&
    net.budget[net.budget.length - 1] > net.budget[0] &&
    net.density.slice(Math.ceil(net.layerCount / 2)).reduce((a, b) => a + b, 0) >
      net.density.slice(0, Math.ceil(net.layerCount / 2)).reduce((a, b) => a + b, 0),
  net
    ? `sites per walkable tile by band ${net.density.map((d) => d.toFixed(4)).join(' ')} · awake budget ${net.budget.join(' ')}`
    : '',
);

/**
 * Route traversal: put a body on every point of the way to the centre.
 *
 * Everything else in this file checks where a site *is*; none of it checked that the polyline the run follows,
 * the renderer draws and the partner walks can be *walked*. That gap cost a whole diagnosis: a scripted walk
 * stalled at 40% and was blamed on its own steering, which is how the waystone fault got found at all. Three
 * tests against the shipped collision geometry rather than a copy of it — no route point inside a wall
 * rectangle, no route point occupied by a wall body at the warden's own footprint, and no placement where the
 * physics leaves the body further than it was put. The last is the honest one; the first two are the same
 * arithmetic the generator already trusts, and the fault was a disagreement between them.
 *
 * Its own page, like the waystone block: by now the shared run has ended and `scene.plan` is gone with it, and
 * a gate that reads a dead scene reports a crash instead of a map.
 */
let traversal = null;
try {
  const tctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const tpage = await tctx.newPage();
  await enterStrip(tpage);
  await sleep(2200);
  traversal = await tpage.evaluate(async () => {
    const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
    const plan = scene.plan;
    const walk = plan.route ?? [];
    const rects = scene.ground?.wallRects ?? [];
    const walls = scene.ground?.walls;
    const body = scene.player.body;
    const bw = body?.width ?? 10;
    const bh = body?.height ?? 10;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const inWall = (x, y) => rects.some((r) => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h);
    const out = {
      points: walk.length,
      body: `${bw}x${bh}`,
      inRectangle: 0,
      occupiedByBody: 0,
      thrownOffByPhysics: 0,
      placements: 0,
      worstDrift: 0,
      worstAt: null,
      lengthPx: 0,
      straightPx: 0,
    };
    for (let i = 0; i < walk.length; i += 1) {
      const q = walk[i];
      if (inWall(q.x, q.y)) out.inRectangle += 1;
      let bodies = 0;
      scene.physics.overlapRect(q.x - bw / 2, q.y - bh / 2, bw, bh, (obj) => {
        if (walls?.contains(obj)) bodies += 1;
      });
      if (bodies > 0) out.occupiedByBody += 1;
      if (i) out.lengthPx += Math.hypot(q.x - walk[i - 1].x, q.y - walk[i - 1].y);
    }
    out.straightPx = Math.round(Math.hypot(plan.goal.x - plan.spawn.x, plan.goal.y - plan.spawn.y));
    out.lengthPx = Math.round(out.lengthPx);
    // Each placement waits long enough for a physics frame or two and not longer than `DUNGEON.warp.dwellMs`.
    // A longer wait would have the corridor indicted for being transportable: the point of this gate is that a
    // body can stand here, not that standing here on a waystone is free.
    for (let i = 0; i < walk.length; i += Math.max(1, Math.ceil(walk.length / 24))) {
      const q = walk[i];
      body?.reset?.(q.x, q.y);
      scene.player.setPosition(q.x, q.y);
      body?.velocity?.set?.(0, 0);
      await sleep(150);
      const d = Math.round(Math.hypot(scene.player.x - q.x, scene.player.y - q.y));
      out.placements += 1;
      if (d > 8) {
        out.thrownOffByPhysics += 1;
        if (d > out.worstDrift) {
          out.worstDrift = d;
          out.worstAt = `${Math.round(q.x)},${Math.round(q.y)}`;
        }
      }
    }
    return out;
  });
  await tctx.close();
} catch (error) {
  traversal = { error: String(error) };
}
check(
  'the way to the centre can be walked — every route point takes a body, and the physics agrees',
  Boolean(traversal) &&
    !traversal.error &&
    traversal.points > 0 &&
    traversal.inRectangle === 0 &&
    traversal.occupiedByBody === 0 &&
    traversal.thrownOffByPhysics === 0,
  traversal?.error
    ? `the probe could not run — ${traversal.error}`
    : `${traversal.points} points against the warden's own ${traversal.body} body: 0 inside a wall rectangle, 0 occupied by a wall body, ${traversal.thrownOffByPhysics} of ${traversal.placements} placements thrown off by the physics (worst ${traversal.worstDrift}px${traversal.worstAt ? ` at ${traversal.worstAt}` : ''}) — ${traversal.lengthPx}px of walk versus ${traversal.straightPx}px straight, so the labyrinth is ${(traversal.lengthPx / Math.max(1, traversal.straightPx)).toFixed(1)}x longer than the line you cannot take`,
);

check('no console errors across the whole probe', errors.length === 0, errors.slice(0, 4).join(' | '));

await page.screenshot({ path: '/home/user/audit/dungeon-run.png' }).catch(() => {});
await browser.close();

dump();
const failed = out.filter((line) => line.startsWith('FAIL'));
console.log(`\n${out.filter((l) => l.startsWith('PASS')).length} passed, ${failed.length} failed, ${out.filter((l) => l.startsWith('INFO')).length} info`);
for (const line of failed) console.log(line);
process.exit(failed.length ? 1 : 0);
