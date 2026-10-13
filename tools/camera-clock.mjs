/**
 * Camera and clock integrity under the effects that touch them.
 *
 * Both of the "the game changed size and stayed that way" faults came from the same class of
 * mistake — an effect that restores a value by remembering what it *was when it started*
 * instead of what the frame is supposed to be. A crit punch read `camera.zoom` as its rest
 * position, so overlapping punches ratcheted the view in; a hit-stop did the same with
 * `time.timeScale`, so two big hits in a row left the run playing at 0.55 speed. Neither is
 * visible to a build or a stat probe, and both are invisible unless the effects are driven
 * in the overlapping order the game actually produces them.
 *
 * Usage: npm run audit:camera
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

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
if (!chromium) throw new Error('playwright not resolvable');

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
const page = await (await browser.newContext({ viewport: { width: 1372, height: 907 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const SNAP = () => {
  const s = window.__sixfoldGame.scene.getScene('GameplayScene');
  return {
    zoom: Number(s.cameras.main.zoom.toFixed(5)),
    sceneTs: Number(s.time.timeScale.toFixed(4)),
    physicsTs: Number(s.physics.world.timeScale.toFixed(4)),
    tweens: s.tweens.getTweens().length,
  };
};
const drive = (fn) => page.evaluate(fn);

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'load' });
await page.waitForSelector('text=NEW WARDEN', { timeout: 40000 });
await page.click('text=NEW WARDEN');
await page.waitForSelector('text=THE VAULT');
await page.click('.slot-plinth:has-text("RAISE A WARDEN")');
await page.waitForSelector('text=CHOOSE YOUR FLAME');
await page.locator('button', { hasText: 'BIND AND BEGIN' }).click();
await page.waitForSelector('text=CREATE WARDEN');
await page.locator('button', { hasText: 'CREATE WARDEN' }).click();
await page.waitForSelector('text=STEP THROUGH');
await page.click('button:has-text("STEP THROUGH")');
await page.waitForSelector('.hud', { timeout: 40000 });
await page.waitForTimeout(3000);

const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });

const idle = await drive(SNAP);
check('idle frame sits on the fitted zoom', idle.zoom === 1, `zoom ${idle.zoom}`);

/*
 * 1. Punches spread across the punch's own duration — the crit-in-a-pack case. The peak is
 * sampled inside the frame loop, because a value read from Node can land after the yoyo and
 * report a pass that nothing earned: the lift has to be observed to be believed.
 */
const peakRun = await drive(async () => {
  const s = window.__sixfoldGame.scene.getScene('GameplayScene');
  let peak = s.cameras.main.zoom;
  const step = () => {
    peak = Math.max(peak, s.cameras.main.zoom);
    return new Promise((res) => requestAnimationFrame(() => res()));
  };
  s.fx.zoomPunch();
  await step();
  await step();
  s.fx.zoomPunch();
  await step();
  await step();
  s.fx.zoomPunch();
  for (let i = 0; i < 18; i += 1) await step();
  return Number(peak.toFixed(4));
});
check('the punch really lifts the camera', peakRun > 1.01, `peak zoom ${peakRun}`);
check('three overlapping punches reach one punch of lift, not three', peakRun <= 1 + 0.32, `peak zoom ${peakRun}`);
await page.waitForTimeout(600);
const afterPunches = await drive(SNAP);
check('camera returns to its base after overlapping punches', afterPunches.zoom === 1, `zoom ${afterPunches.zoom}`);

/* 2. twenty punches, one per frame-ish: the ratchet */
for (let i = 0; i < 20; i += 1) {
  await drive(() => {
    const s = window.__sixfoldGame.scene.getScene('GameplayScene');
    s.fx.zoomPunch();
  });
  await page.waitForTimeout(45);
}
await page.waitForTimeout(900);
const ratcheted = await drive(SNAP);
check('repeated punches do not ratchet the view in', ratcheted.zoom === 1, `zoom after 20 punches ${ratcheted.zoom}`);

/* 3. a freeze that lands mid-punch must not leave the frame scaled */
await drive(() => {
  const s = window.__sixfoldGame.scene.getScene('GameplayScene');
  s.fx.zoomPunch(0.3);
});
await page.waitForTimeout(30);
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
const paused = await drive(SNAP);
check('pausing mid-punch shows the pause card at the true scale', paused.zoom === 1, `zoom while paused ${paused.zoom}`);
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
const resumed = await drive(SNAP);
check('resuming keeps the fitted zoom', resumed.zoom === 1, `zoom after resume ${resumed.zoom}`);

/* 4. stacked hit-stops must hand the clocks back */
await drive(() => {
  const s = window.__sixfoldGame.scene.getScene('GameplayScene');
  s.fx.hitStop(80);
  s.fx.hitStop(80);
  s.fx.hitStop(80);
});
await page.waitForTimeout(1200);
const clocks = await drive(SNAP);
check(
  'three stacked hit-stops leave both clocks at 1',
  clocks.sceneTs === 1 && clocks.physicsTs === 1,
  `scene ${clocks.sceneTs} / physics ${clocks.physicsTs}`,
);

/* 5. a freeze inside a hit-stop window must not strand the slow clock */
await drive(() => {
  const s = window.__sixfoldGame.scene.getScene('GameplayScene');
  s.fx.hitStop(400);
});
await page.waitForTimeout(60);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
const frozen = await drive(SNAP);
check('pausing inside a hit-stop releases both clocks', frozen.sceneTs === 1 && frozen.physicsTs === 1, `scene ${frozen.sceneTs} / physics ${frozen.physicsTs}`);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const thawed = await drive(SNAP);
check('and they stay released after the resume', thawed.sceneTs === 1 && thawed.physicsTs === 1, `scene ${thawed.sceneTs} / physics ${thawed.physicsTs}`);

/* 6. real play: a long burst of attacks must not leave the frame scaled or slowed */
for (let i = 0; i < 40; i += 1) {
  await page.keyboard.press('Space');
  await page.waitForTimeout(40);
}
await page.waitForTimeout(1200);
const played = await drive(SNAP);
check('after 40 attacks the frame is on its base zoom and full speed', played.zoom === 1 && played.sceneTs === 1, JSON.stringify(played));

check('no page errors while all of that ran', errors.length === 0, JSON.stringify(errors.slice(0, 3)));

let failed = 0;
for (const c of checks) {
  if (!c.pass) failed += 1;
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  — ${c.detail}`);
}
console.log(`\n${checks.length - failed}/${checks.length} camera+clock checks passed`);
await browser.close();
process.exit(failed ? 1 : 0);
