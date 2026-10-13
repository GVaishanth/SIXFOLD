/**
 * Two faults the stat audits could not see, measured end to end.
 *
 * (1) The focus shop sold any wave-milestone element at one flat price, so a wave-1 save
 *     with 6 shards could buy the `final` tier (tempest, wave 195). Eligibility is asked of
 *     the shipped pure function against the real element graph — no re-implementation.
 * (2) SAVE & EXIT handed CONTINUE back a full health bar. This takes real damage from real
 *     enemies in a real wave, walks out through the pause card, reads what landed in
 *     localStorage, comes back in, and compares the warden's hit points.
 *
 * Usage: npm run audit:progression
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

const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });

/* ---------------------------------------------------------------- (1) the shop */
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'load' });
const shop = await page.evaluate(async () => {
  const prog = await import('/src/game/systems/elementProgression.ts');
  const cfg = await import('/src/config/gameConfig.ts');
  const reg = await import('/src/data/elements/index.ts');
  const ask = (id, unlocked, shards) => {
    const r = prog.shardUnlockEligible(id, unlocked, shards);
    return { id, ok: r.ok, cost: r.cost, reason: r.reason };
  };
  const E = reg.ELEMENT_REGISTRY;
  const cases = [
    ['final tier on a fresh save', ask('tempest', ['fire'], 9999), { ok: false }],
    ['advanced tier on a fresh save', ask('magma', ['fire'], 9999), { ok: false }],
    ['advanced tier with no unlocked parent', ask('sand', ['fire', 'smoke'], 9999), { ok: false }],
    ['primordial milestone, affordable', ask('earth', ['fire'], 6), { ok: true, cost: 6 }],
    ['primordial milestone, short by a shard', ask('earth', ['fire'], 5), { ok: false, cost: 6 }],
    ['branching with an unlocked parent', ask('smoke', ['fire', 'air'], 6), { ok: true, cost: 6 }],
    ['branching with no unlocked parent', ask('mist', ['fire'], 6), { ok: false }],
    ['advanced at the right tier depth', ask('magma', ['fire', 'smoke'], 12), { ok: true, cost: 12 }],
    ['final at the right tier depth', ask('volcano', ['fire', 'magma', 'ash'], 18), { ok: true, cost: 18 }],
    ['final needs an advanced in hand', ask('volcano', ['fire', 'smoke', 'mist'], 9999), { ok: false }],
    ['boss-only element never in the shop', ask('frost', ['water', 'ice'], 9999), { ok: false }],
    ['starter never in the shop', ask('water', ['fire'], 9999), { ok: false }],
  ];
  return {
    cases: cases.map(([name, got, want]) => ({
      name,
      got,
      want,
      pass: Object.entries(want).every(([k, v]) => got[k] === v),
    })),
    costMap: cfg.PROGRESSION.shardUnlockCostByTier,
    flatKeyGone: cfg.PROGRESSION.shardUnlockCost === undefined,
    tiers: [...new Set(Object.values(E).map((d) => d.tier))].join(','),
  };
});
for (const c of shop.cases) check(`focus shop: ${c.name}`, c.pass, { got: c.got, want: c.want });
check('focus shop: priced by tier 6/6/12/18', JSON.stringify(shop.costMap) === JSON.stringify({ primordial: 6, branching: 6, advanced: 12, final: 18 }), shop.costMap);
check('focus shop: the flat price is gone from the config', shop.flatKeyGone, shop.flatKeyGone);

/* ------------------------------------------------------------- (2) walk away hurt */
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

// Let the wave hurt the warden for real, standing still.
await page
  .waitForFunction(
    () => {
      const s = window.__sixfoldGame?.scene?.getScene('GameplayScene');
      return !!s && s.player && s.player.hp < s.player.maxHp;
    },
    null,
    { timeout: 90000, polling: 300 },
  )
  .catch(() => undefined);
const beforeExit = await page.evaluate(() => {
  const s = window.__sixfoldGame.scene.getScene('GameplayScene');
  return { hp: Math.round(s.player.hp), maxHp: Math.round(s.player.maxHp), wave: s.run?.startWave ?? null };
});
check('the run actually took damage before leaving', beforeExit.hp < beforeExit.maxHp, beforeExit);

await page.keyboard.press('Escape');
await page.waitForTimeout(600);
await page.locator('button', { hasText: 'SAVE & EXIT' }).first().click();
await page.waitForTimeout(1600);

const stored = await page.evaluate(() => {
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || !/sixfold|save/i.test(key)) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(localStorage.getItem(key));
    } catch {
      continue;
    }
    const slots = parsed?.slots ?? null;
    if (!Array.isArray(slots)) continue;
    const hit = slots.find((x) => x && x.resumeRun);
    if (hit) return { key, resumeRun: hit.resumeRun, currentWave: hit.story.currentWave };
  }
  return { key: null, resumeRun: null };
});
check('save & exit wrote the health it left behind', stored.resumeRun && stored.resumeRun.hp === beforeExit.hp, stored);
check('the record names the run it belongs to', stored.resumeRun && stored.resumeRun.mode === 'story' && stored.resumeRun.wave === (beforeExit.wave ?? 1), stored.resumeRun);

// One click per screen, and never a second start: a second `startGameplay` would rebuild the
// scene at full health and the probe would then measure its own restart instead of the resume.
await page.waitForSelector('text=CONTINUE', { timeout: 20000 });
await page.locator('[title="CONTINUE"], button:has-text("CONTINUE")').first().click();
await page.waitForTimeout(1500);
if (await page.locator('button:has-text("STEP THROUGH")').first().isVisible().catch(() => false)) {
  await page.locator('button:has-text("STEP THROUGH")').first().click();
  await page.waitForTimeout(1500);
}
if (await page.locator('button:has-text("CONTINUE STORY")').first().isVisible().catch(() => false)) {
  await page.locator('button:has-text("CONTINUE STORY")').first().click();
  await page.waitForTimeout(1500);
}
await page
  .waitForFunction(() => !!window.__sixfoldGame?.scene?.getScene('GameplayScene')?.player, null, { timeout: 40000 })
  .catch(() => undefined);
await page.waitForTimeout(900);
const afterResume = await page.evaluate(() => {
  const s = window.__sixfoldGame.scene.getScene('GameplayScene');
  return { hp: Math.round(s.player.hp), maxHp: Math.round(s.player.maxHp), wave: s.run?.startWave ?? null };
});
const resumeProbe = await page.evaluate(() => {
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || !/sixfold|save/i.test(key)) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(localStorage.getItem(key));
    } catch {
      continue;
    }
    if (!Array.isArray(parsed?.slots)) continue;
    const hit = parsed.slots.find((x) => x);
    if (hit) return { resumeRun: hit.resumeRun ?? null };
  }
  return { resumeRun: 'no-save' };
});
/*
 * The wave is live while this is measured, so regeneration is allowed to move the number a
 * couple of points — the fault being tested is the bar coming back *full*, and that is the
 * comparison that matters.
 */
check(
  'CONTINUE re-enters at the wound that was left, not a full bar',
  afterResume.hp < afterResume.maxHp && Math.abs(afterResume.hp - (stored.resumeRun?.hp ?? -1)) <= 4,
  { stored: stored.resumeRun?.hp, resumed: afterResume },
);
check('the record is spent exactly once', resumeProbe.resumeRun === null, resumeProbe);

let failed = 0;
for (const c of checks) {
  if (!c.pass) failed += 1;
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  — ${c.detail}`);
}
check('no page errors', errors.length === 0, errors.slice(0, 3));
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
await browser.close();
process.exit(failed ? 1 : 0);
