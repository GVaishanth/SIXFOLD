/**
 * Does the dungeon finish?
 *
 * Every other gate in this repo proves a *part* of the mode — a site placement, a cull window, a warp verb, a
 * pacing rule. None of them answered the only question a player asks: is the walk to the centre actually walkable
 * by a warden, and what does it cost them. The answer had been arithmetic (route px ÷ base speed) plus a bot that
 * stalled at 40% and was blamed on its own steering, which is how both the waystone-warp fault and the missing
 * traversal gate got found. This tool is the measurement that closes that gap.
 *
 * It flies a real run through the shipped input path — `InputManager.setTouchMovement` / `setTouchButtons`, the
 * same calls the thumb pads make — with a policy a player would recognise: **never stop**, hold the attack at the
 * nearest hostile, bias the heading away from anything that gets within arm's reach, and dash out of a grab. The
 * policy matters more than it looks: the first version stopped to shoot, spent its clock inside the fights it
 * chose, and "couldn't finish" a mode that a human crosses in a few minutes. A measurement of an autopilot is a
 * measurement of the autopilot, so the policy is printed with the result.
 *
 * Deliberately not in `verify`: it costs minutes of browser time, and a gate whose price is minutes gets skipped
 * until it is broken. Run it after touching the generator, the collision bands, the warp verb or the roamer
 * trickle — the four things that can make a finishable map unfinishable without failing any other check.
 *
 * `npm run audit:dungeoncomplete`, with a dev server on :5173 (the debug scene handle is dev-only).
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
if (!chromium) throw new Error('playwright chromium not installed');

const BASE = process.env.SIXFOLD_URL ?? 'http://127.0.0.1:5173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickText = async (page, text) => {
  const btn = page.locator('button', { hasText: text }).first();
  if (await btn.count()) await btn.click({ noWaitAfter: true }).catch(() => {});
};

/**
 * The bound, read from what is authored rather than from a number invented here.
 *
 * `routePx / baseSpeed` is the time a warden needs if they walk the corridor and never spend a frame on anything
 * else; three times that is the allowance for the fights the mode insists on. A bound copied from a previous
 * measurement would drift the moment the map did, and this file's whole purpose is to notice that drift.
 */
const cfg = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'config', 'gameConfig.ts'), 'utf8');
const baseSpeed = Number(/baseSpeed:\s*(\d+)/.exec(cfg)?.[1] ?? '82');
const dwellMs = Number(/dwellMs:\s*(\d+)/.exec(cfg)?.[1] ?? '380');

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(BASE, { waitUntil: 'load' });
await sleep(1000);
if (await page.locator('text=NEW WARDEN').count()) {
  await page.click('text=NEW WARDEN');
  await sleep(300);
  const plinth = page.locator('.slot-plinth:has-text("RAISE A WARDEN")');
  if (await plinth.count()) await plinth.first().click();
  await sleep(300);
  await clickText(page, 'BIND AND BEGIN');
  await sleep(300);
  await clickText(page, 'CREATE WARDEN');
  await sleep(700);
}
await page
  .waitForFunction(
    () => Array.from(document.querySelectorAll('button')).some((b) => /WALK THE STRIP/.test(b.textContent || '')),
    null,
    { timeout: 20000 },
  )
  .catch(() => undefined);
await clickText(page, 'WALK THE STRIP');
await sleep(2600);

const run = await page.evaluate(async ({ speedCapFactor, dwell, speed }) => {
  const scene = window.__sixfoldGame.scene.getScene('DungeonScene');
  const plan = scene.plan;
  const walk = plan.route ?? [];
  const im = scene.inputManager;
  const tile = plan.fissure?.tilePx ?? 64;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let siteTotal = 0;
  for (const c of plan.cells) siteTotal += c.sites.length;
  let routePx = 0;
  for (let i = 1; i < walk.length; i += 1) {
    routePx += Math.hypot(walk[i].x - walk[i - 1].x, walk[i].y - walk[i - 1].y);
  }
  const CAP = Math.ceil(((routePx / speed) * speedCapFactor) / 10) * 10 * 1000;
  const status = (window.__run = { note: 'start' });

  const at = (k) => walk[Math.max(0, Math.min(walk.length - 1, k))];
  /**
   * Where the body sits *along* the corridor, as a continuous position on the polyline.
   *
   * Advancing a cursor when the body comes near a vertex sounds right and is not: the generator puts waystones,
   * caches and groves on the walk on purpose, and a 14px immovable stone at a vertex is a point the warden can
   * never occupy — so the arrival test never fires, a watchdog starts skipping the path, and the run ends up
   * 2,717px from the centre with its cursor past the end of the route (that exact failure is in this file's
   * history). Projecting onto the nearest segment instead makes progress continuous: sliding past a stone at
   * 20px of lateral offset is progress, which is what a player would tell you it is.
   */
  const arcAt = (x, y) => {
    let best = { arc: -1, foot: null, off: Infinity };
    for (let j = 0; j < walk.length - 1; j += 1) {
      const a = walk[j];
      const b = walk[j + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1) continue;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
      const fx = a.x + dx * t;
      const fy = a.y + dy * t;
      const off = Math.hypot(x - fx, y - fy);
      if (off > 46) continue;
      const arc = j + t;
      if (arc > best.arc) best = { arc, foot: { x: fx, y: fy }, off, next: { x: b.x, y: b.y } };
    }
    return best;
  };
  const t0 = scene.time.now;
  let i = Math.floor(Math.max(0, arcAt(scene.player.x, scene.player.y).arc));
  let lastAdvance = 0;
  let nudges = 0;
  let ticks = 0;
  let damage = 0;
  let hits = 0;
  let hpMin = scene.player.hp;
  let prevHp = scene.player.hp;
  let maxActive = 0;
  let pxCovered = 0;
  let dashes = 0;
  let last = { x: scene.player.x, y: scene.player.y };
  const trace = [];
  while (scene.player.hp > 0 && !scene.strip.endingReason && scene.time.now - t0 < CAP) {
    ticks += 1;
    const here = { x: scene.player.x, y: scene.player.y };
    // Follow the walk by arc projection and never let the cursor go backwards. The corridor folds on itself, so
    // "nearest point" alone can hand the run a shortcut through a wall, and the two stalls this file exists to
    // chase were the cursor wandering in exactly that way.
    const proj = arcAt(here.x, here.y);
    const walked = proj.arc >= 0 ? Math.floor(proj.arc) : i;
    if (walked > i) {
      i = walked;
      lastAdvance = ticks;
    }
    if (ticks - lastAdvance > 60) {
      // Off the corridor and staying off it: aim back at the polyline rather than skipping ahead of it. A
      // follower that gives up on the path and heads for the goal in a straight line is a follower that walks
      // into a wall, and the run then reports a map it could not finish.
      i += 1;
      lastAdvance = ticks;
      nudges += 1;
    }
    const foes = scene.enemies
      .getChildren()
      .filter((f) => f.active)
      .map((f) => ({ f, d: Math.hypot(f.x - here.x, f.y - here.y) }))
      .sort((a, b) => a.d - b.d);
    const foe = foes[0] ?? null;
    // Aim along the corridor, not at the vertex: the point 46px down the polyline's *next* stride, which keeps
    // the body in the middle of the lane and never asks it to stand inside a stone.
    const target =
      i + 1 >= walk.length
        ? plan.goal
        : proj.arc >= 0 && Math.hypot(proj.foot.x - here.x, proj.foot.y - here.y) > 12
          ? proj.foot
          : at(i + 1);
    let ang = Math.atan2(target.y - here.y, target.x - here.x);
    if (foe && foe.d < 90) {
      const away = Math.atan2(here.y - foe.f.y, here.x - foe.f.x);
      const diff = ((away - ang + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      ang += Math.sign(diff) * Math.min(Math.abs(diff), 0.9);
    }
    im.setTouchMovement(Math.cos(ang), Math.sin(ang));
    const wantDash = Boolean(foe) && foe.d < 70 && ticks % 9 === 0;
    im.setTouchButtons({ attack: true, dash: wantDash });
    im.setTouchAim(foe ? { x: foe.f.x, y: foe.f.y } : { x: target.x, y: target.y });
    if (wantDash) dashes += 1;
    await sleep(70);
    pxCovered += Math.hypot(scene.player.x - last.x, scene.player.y - last.y);
    last = { x: scene.player.x, y: scene.player.y };
    if (scene.player.hp < prevHp) {
      damage += prevHp - scene.player.hp;
      hits += 1;
    }
    prevHp = scene.player.hp;
    hpMin = Math.min(hpMin, scene.player.hp);
    maxActive = Math.max(maxActive, scene.enemies.countActive(true));
    status.note = `${Math.round((scene.time.now - t0) / 1000)}s idx${i}/${walk.length} hp${Math.round(scene.player.hp)} spent${scene.strip.spentCount}`;
    if (ticks % 40 === 0) trace.push(status.note);
  }
  im.setTouchMovement(0, 0);
  im.setTouchButtons({ attack: false });
  im.setTouchAim(null);
  const secs = Math.round((scene.time.now - t0) / 1000);
  const pxToCentre = Math.round(Math.hypot(plan.goal.x - scene.player.x, plan.goal.y - scene.player.y));
  return {
    secs,
    ended: scene.strip.endingReason ?? 'cap',
    routePx: Math.round(routePx),
    points: walk.length,
    siteTotal,
    idx: i,
    progressPercent: Math.round((i / Math.max(1, walk.length)) * 100),
    pxToCentre,
    hp: Math.round(scene.player.hp),
    hpMin: Math.round(hpMin),
    damageTaken: Math.round(damage),
    hitsTaken: hits,
    kills: scene.kills,
    ledger: scene.ledger,
    sitesSpent: scene.strip.spentCount,
    waypointsLinked: scene.strip.linkedCount,
    warps: scene.strip.warpCount,
    charts: scene.chartsFound,
    maxEnemiesAtOnce: maxActive,
    pxCovered: Math.round(pxCovered),
    cursorNudges: nudges,
    dashes,
    ticks,
    fps: Math.round(scene.game.loop.actualFps),
    dwellMs: dwell,
    trace,
  };
}, { speedCapFactor: 3, dwell: dwellMs, speed: baseSpeed });

const bound = Math.ceil((run.routePx / baseSpeed) * 3);
const finished = run.ended === 'end';
const ok = finished && run.secs <= bound;
const line = `${ok ? 'PASS' : 'FAIL'}  the strip can be finished by walking it — ${
  finished ? `centre reached in ${run.secs}s against a ${bound}s allowance (${Math.round(run.routePx)}px of route at ${baseSpeed}px/s, x3 for the fights)` : `did not reach the centre (${run.ended} at ${run.secs}s, ${run.progressPercent}% of the route, ${run.pxToCentre}px short)`
} · hp ${run.hp} (min ${run.hpMin}), ${run.damageTaken} damage over ${run.hitsTaken} hits, ${run.kills} felled, ${run.ledger} ledger, ${run.sitesSpent}/${run.siteTotal} sites spent, ${run.waypointsLinked} waystones linked and ${run.warps} warped, ${run.charts} charts, ${run.maxEnemiesAtOnce} hostiles at once, ${run.cursorNudges} cursor nudges and ${run.dashes} dashes by the autopilot · ${run.fps} fps`;
console.log(line);
console.log(
  `POLICY  never stop moving; hold attack, aim the nearest hostile; bias 50° off anything inside 90px; dash out of a grab under 70px. A completion claim measured through a bot is a claim about the bot too, so the policy is printed with it.`,
);
for (const t of run.trace.slice(-4)) console.log(`  · ${t}`);
if (errors.length) console.log(`CONSOLE ERRORS (${errors.length}): ${errors.slice(0, 3).join(' | ')}`);

await page.screenshot({ path: '/home/user/audit/dungeon-complete.png' }).catch(() => {});
await browser.close();
process.exit(ok && errors.length === 0 ? 0 : 1);
