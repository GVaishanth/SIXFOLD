#!/usr/bin/env node
/**
 * Ranged-counter gate — `npm run audit:counter`.
 *
 * The rule the player asked for: firing into an incoming bolt stops it, and an ordinary bolt pays for that
 * with its own life. A crystal shard or an ultimate is the exception — it carries `destroysEnemyProjectiles`,
 * which since this change means exactly one thing: *counters without spending yourself*.
 *
 * Nothing about that is visible in a still frame, and a unit test of the overlap callback would only prove
 * that the callback does what I wrote it to do. So this drives the real scene: it starts a story run, parks
 * a bolt and a shot on the same pixel, and reads back which of the two survived — plus the tallies the
 * ledger and the strip report print, because a tally nobody writes is a lie in the achievements screen.
 *
 * Needs the dev server (`npm run dev`) and Playwright's chromium, like the other browser gates.
 * Optional env: SIXFOLD_URL (default http://localhost:5173/).
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const URL_BASE = process.env.SIXFOLD_URL ?? 'http://localhost:5173/';

function loadPlaywright() {
  const candidates = [null, process.env.SIXFOLD_PLAYWRIGHT];
  const npxRoot = join(homedir(), '.npm', '_npx');
  if (existsSync(npxRoot)) {
    for (const entry of readdirSync(npxRoot)) {
      const candidate = join(npxRoot, entry, 'node_modules', 'playwright');
      if (existsSync(join(candidate, 'package.json'))) candidates.push(candidate);
    }
  }
  for (const candidate of candidates) {
    try {
      return candidate ? require(candidate) : require('playwright');
    } catch {
      /* next */
    }
  }
  console.error('playwright is not resolvable (npm i -D playwright && npx playwright install chromium)');
  process.exit(2);
}

const { chromium } = loadPlaywright();
const rows = [];
const check = (ok, label, detail = '') => {
  rows.push({ ok, label });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 180)));

await page.goto(URL_BASE, { waitUntil: 'load' });
await page.evaluate(() => localStorage.removeItem('sixfold.save.v4'));
await page.reload({ waitUntil: 'load' });

/* A warden has to exist before there is a scene to fight in, so the gate walks the real flow. */
await page.waitForSelector('text=NEW WARDEN', { timeout: 40000 });
await page.click('text=NEW WARDEN');
await page.waitForSelector('text=THE VAULT');
await page.click('.slot-plinth:has-text("RAISE A WARDEN")');
await page.waitForSelector('text=CHOOSE YOUR FLAME');
await page.locator('button', { hasText: 'BIND AND BEGIN' }).click();
await page.waitForSelector('text=CREATE WARDEN');
await page.locator('button', { hasText: 'CREATE WARDEN' }).click();
await page.waitForSelector('text=STEP THROUGH');
await page.click('text=STEP THROUGH');
await page.waitForTimeout(7000);

const ready = await page.evaluate(() => {
  const scene = window.__sixfoldGame?.scene?.getScene('GameplayScene');
  return Boolean(scene && scene.playerProjectiles && scene.enemyProjectiles);
});
check(ready, 'a live GameplayScene with both projectile managers');
if (!ready) {
  console.log('\ncannot test the counter without a scene — is the dev server on?');
  await browser.close();
  process.exit(1);
}

/**
 * Fires one shot from each side onto the same pixel, far enough from the player that nothing else is in the
 * way, then reports what survived. `keep` selects the crystal/ultimate flag.
 */
const trade = (keep) =>
  page.evaluate(
    async (carry) => {
      const scene = window.__sixfoldGame.scene.getScene('GameplayScene');
      const base = {
        angle: 0,
        speed: 0,
        damage: 7,
        owner: 'enemy',
        element: null,
        vfx: 'spark',
        color: 0xff5c6c,
        radius: 6,
        lifetime: 2,
        pierce: 0,
        chain: 0,
        homing: 0,
        knockback: 0,
        statuses: [],
        explodeRadius: 0,
        explodeDamageMult: 0,
        destroysEnemyProjectiles: carry,
        boomerang: false,
      };
      const x = scene.player.x + 320;
      const y = scene.player.y - 90;
      // Clear the air first, so only the two bolts below can be involved in what follows.
      scene.enemyProjectiles.releaseAll();
      scene.playerProjectiles.releaseAll();
      const before = { countered: scene.shotsCountered, pool: scene.playerProjectiles.count };
      const enemyShot = scene.enemyProjectiles.fire({ ...base, x, y });
      const playerShot = scene.playerProjectiles.fire({
        ...base,
        owner: 'player',
        x,
        y,
        color: 0x7fe0c0,
        damage: 9,
        destroysEnemyProjectiles: carry,
      });
      const t0 = performance.now();
      while (performance.now() - t0 < 260) {
        await new Promise((r) => requestAnimationFrame(r));
      }
      // The app's own store instance, not a second copy of the module (see src/main.tsx).
      const store = window.__sixfoldSave;
      return {
        enemyAlive: Boolean(enemyShot?.active),
        playerAlive: Boolean(playerShot?.active),
        bothFired: Boolean(enemyShot && playerShot),
        placed: Math.round(Math.hypot(enemyShot.x - playerShot.x, enemyShot.y - playerShot.y)),
        counteredDelta: scene.shotsCountered - before.countered,
        poolDelta: scene.playerProjectiles.count - before.pool,
        hooked: Boolean(store),
        stat: store?.getState().data?.stats.projectilesCountered ?? -1,
        run: store?.getState().run?.shotsCountered ?? -1,
      };
    },
    keep,
  );

const ordinary = await trade(false);
check(ordinary.bothFired && ordinary.placed <= 2, 'both bolts were fired onto the same pixel', ordinary.placed);
check(ordinary.enemyAlive === false, 'an ordinary player bolt stops the incoming shot', `enemyAlive=${ordinary.enemyAlive}`);
check(ordinary.playerAlive === false, 'and pays for it with its own life', `playerAlive=${ordinary.playerAlive}`);
check(ordinary.counteredDelta >= 1, 'the scene counts the counter', `+${ordinary.counteredDelta}`);
check(
  ordinary.hooked,
  'the gate reads the store the app is running, not a second copy of the module',
  `hooked=${ordinary.hooked}`,
);
check(
  ordinary.stat >= 1,
  'the save records it for the ledger',
  ordinary.hooked ? `stats.projectilesCountered=${ordinary.stat}` : 'unreadable — no live store handle',
);
check(
  ordinary.run >= 1,
  'the run record carries it to the strip report',
  ordinary.hooked ? `run.shotsCountered=${ordinary.run}` : 'unreadable — no live store handle',
);

const kept = await trade(true);
check(kept.enemyAlive === false, 'a shard-class bolt still stops the shot', `enemyAlive=${kept.enemyAlive}`);
check(kept.playerAlive === true, 'and keeps itself', `playerAlive=${kept.playerAlive}`);
check(kept.counteredDelta >= 1, 'the free counter is counted too', `+${kept.counteredDelta}`);

/* Two more trades: the tally has to keep moving, and the pool must not leak either way. */
const again = await trade(false);
check(again.counteredDelta >= 1 && again.playerAlive === false, 'the rule repeats on the next bolt', again.counteredDelta);
check(
  again.poolDelta <= 0 && kept.poolDelta <= 1,
  'spent bolts return to the pool',
  `ordinary ${again.poolDelta}, kept ${kept.poolDelta}`,
);

/*
 * One line per run, not per hit: the third trade must still move the counter, and the scene must not have
 * accumulated three separate banners. `shotsCountered` is the number the strip report prints, so it is what
 * a player can actually check; the banner itself is a Phaser tween, not a DOM node, and this gate does not
 * pretend to see it.
 */
const tallied = await page.evaluate(() => {
  const scene = window.__sixfoldGame.scene.getScene('GameplayScene');
  return { counter: scene.shotsCountered, flag: scene.counterShown };
});
check(tallied.counter >= 3, 'three trades, three counted', tallied.counter);
check(tallied.flag === true, 'the callout has been spent for this run', tallied.flag);

check(errors.length === 0, 'no page errors while countering', errors.slice(0, 2));

await page.screenshot({ path: '/home/user/audit/shot-6-counter.png' });
await context.close();
await browser.close();

const failed = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - failed.length}/${rows.length} counter checks passed.`);
if (failed.length) process.exitCode = 1;