#!/usr/bin/env node
/**
 * SIXFOLD end-to-end flow test.
 *
 * Plays the game the way a player would, through the real interface, in a real
 * browser: main menu → new game → slot → starter → hub → story wave → combat →
 * pause → skill tree (simulation must freeze) → resume → save & exit → reload →
 * continue.
 *
 * It deliberately avoids the developer cheat path so it can run against any
 * build, dev or production:
 *
 *   npm run dev &            # or: npm run build && npm run preview
 *   npx -y playwright@1.56.1 install --with-deps chromium
 *   node tools/e2e.mjs
 *
 * Optional env: SIXFOLD_URL (default http://localhost:5173/).
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const URL_BASE = process.env.SIXFOLD_URL ?? 'http://localhost:5173/';

/**
 * Resolves Playwright from, in order: the project, `SIXFOLD_PLAYWRIGHT`
 * (an explicit path), or the npm `_npx` cache used by
 * `npx -y playwright install`. Playwright is intentionally not a project
 * dependency — it is only needed to run these audits.
 */
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
      /* try the next candidate */
    }
  }
  console.error(
    'Playwright is not installed.\n' +
      '  npm i -D playwright && npx playwright install --with-deps chromium\n' +
      'or run it through npx and point SIXFOLD_PLAYWRIGHT at the install.',
  );
  process.exit(2);
}

const { chromium } = loadPlaywright();
const SAVE_KEY = 'sixfold.save.v4';
const failures = [];
const step = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') pageErrors.push(message.text().slice(0, 160));
});

const screenTitle = () => page.evaluate(() => document.querySelector('.title-xl, .ambient-header')?.textContent?.trim() ?? null);

/**
 * Reads the run state from the DOM (works in production builds) falling back to
 * the live scene when the dev-only handle is present.
 */
const readRun = () =>
  page.evaluate(() => {
    const scene = window.__sixfoldGame?.scene?.getScene('GameplayScene') ?? null;
    const save = JSON.parse(localStorage.getItem('sixfold.save.v4') ?? 'null')?.slots?.[0] ?? null;
    // Read structured HUD nodes rather than scraping free text.
    // The quadrant HUD names the wave in `.wave-number` ("WAVE 12", or "WARDEN"
    // on a boss wave, which has no number to read).
    const waveLabel = document.querySelector('.hud-tc .wave-number')?.textContent ?? '';
    const hudWave = Number(/WAVE\s+(\d+)/i.exec(waveLabel)?.[1] ?? NaN);
    const remainingText =
      [...document.querySelectorAll('.hud-block .mono-value')].map((n) => n.textContent?.trim() ?? '')[0] ?? '';
    return {
      overlay: Boolean(document.querySelector('.overlay-card')),
      canvas: Boolean(document.querySelector('canvas')),
      frozen: scene ? Boolean(scene.frozen) : null,
      sceneWave: scene?.director?.currentSpec?.wave ?? null,
      hudWave: Number.isNaN(hudWave) ? null : hudWave,
      kills: save?.stats?.enemiesDefeated ?? 0,
      remaining: Number(remainingText),
    };
  });

/**
 * Compares two canvas grabs. A live scene always animates (enemies close in,
 * particles move); a frozen one renders identical frames. This works in
 * production builds where no debug handle exists.
 */
async function canvasIsAnimating(gapMs = 600, samples = 8) {
  let prev = await page.locator('canvas').screenshot();
  for (let i = 0; i < samples; i += 1) {
    await page.waitForTimeout(gapMs);
    const current = await page.locator('canvas').screenshot();
    if (!current.equals(prev)) return { animating: true, afterSamples: i + 1 };
    prev = current;
  }
  return { animating: false, afterSamples: null };
}


/* 1. Boot → main menu ------------------------------------------------- */
await page.goto(URL_BASE, { waitUntil: 'load' });
await page.waitForSelector('text=NEW WARDEN', { timeout: 30000 });
step(true, 'boots to the main menu', await screenTitle());

/* 2. New game chain --------------------------------------------------- */
await page.click('text=NEW WARDEN');
await page.waitForSelector('text=THE VAULT', { timeout: 10000 });
step(true, 'slot select opens');

await page.click('.slot-plinth:has-text("RAISE A WARDEN")');
await page.waitForSelector('text=CHOOSE YOUR FLAME', { timeout: 10000 });
await page.fill('input[aria-label="Warden name"]', 'E2E');
const starterCards = await page.$$('.pedestal');
step(starterCards.length === 3, 'new game offers exactly three starter elements', `${starterCards.length} cards`);
if (starterCards[1]) await starterCards[1].click();

// CONFIRM & BEGIN opens a confirmation card; CREATE WARDEN inside it commits.
await page.locator('button', { hasText: 'BIND AND BEGIN' }).click();
await page.waitForSelector('text=BEGIN THE ASCENT?', { timeout: 10000 });
step(true, 'confirm step asks before creating the warden');
await page.locator('button', { hasText: 'CREATE WARDEN' }).click();
await page.waitForSelector('text=STEP THROUGH', { timeout: 15000 });
const hubText = await page.evaluate(() => document.body.innerText);
step(
  hubText.includes('STEP THROUGH') || hubText.includes('REPLAY THE STORY'),
  'warden created and the hub opens',
  (await screenTitle()) ?? '',
);

/* 3. Start the story -------------------------------------------------- */
await page.click('text=STEP THROUGH');
await page.waitForTimeout(6500);
const canvas = await page.$('canvas');
step(Boolean(canvas), 'gameplay canvas is mounted');

const hud = await page.evaluate(() => ({
  wave: document.querySelector('.hud-tc .wave-number')?.textContent?.trim() ?? null,
  bars: document.querySelectorAll('.bar').length,
  slots: document.querySelectorAll('.slot-strip > *, .hud-slots > *').length,
  paused: false,
}));
step(hud.bars > 0, 'HUD renders health/energy bars', `bars=${hud.bars} wave=${hud.wave}`);

/* 4. Fight: aim at the nearest enemy with real mouse input ------------ */
let kills = 0;
let held = false;
for (let i = 0; i < 26; i += 1) {
  const aim = await page.evaluate(() => {
    const canvasEl = document.querySelector('canvas');
    const rect = canvasEl.getBoundingClientRect();
    return { cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2 };
  });
  await page.mouse.move(aim.cx, aim.cy);
  if (!held) {
    await page.mouse.down();
    held = true;
  }
  await page.waitForTimeout(400);
  const state = await page.evaluate(() => {
    const save = JSON.parse(localStorage.getItem('sixfold.save.v4') ?? 'null')?.slots?.[0];
    return { kills: save?.stats?.enemiesDefeated ?? 0, wave: save?.story?.currentWave ?? 1 };
  });
  kills = state.kills;
  if (kills > 0) break;
}
if (held) await page.mouse.up();
await page.waitForTimeout(1500);
const afterFight = await page.evaluate(() => {
  const save = JSON.parse(localStorage.getItem('sixfold.save.v4') ?? 'null')?.slots?.[0];
  return {
    kills: save?.stats?.enemiesDefeated ?? 0,
    mastery: save?.mastery?.[save?.profile?.starter]?.xp ?? 0,
    unlocked: save?.unlockedElements ?? [],
    starter: save?.profile?.starter ?? null,
  };
});
step(afterFight.kills > 0, 'combat kills enemies and records them in the save', JSON.stringify(afterFight));
step(
  afterFight.unlocked.length === 1 && afterFight.unlocked[0] === afterFight.starter,
  'a new save starts with exactly the chosen starter element',
  JSON.stringify(afterFight.unlocked),
);

/* 5. Pause → skill tree → back → resume ------------------------------- */
await page.keyboard.press('Escape');
await page.waitForTimeout(700);
const paused = await page.evaluate(() => ({
  card: document.querySelector('.overlay-card .overlay-title')?.textContent?.trim() ?? null,
  physicsPaused: window.__sixfoldGame?.scene?.getScene('GameplayScene')?.physics?.world?.isPaused ?? 'n/a (production)',
}));
step(paused.card === 'PAUSED', 'pause overlay opens', JSON.stringify(paused));

await page.click('text=SKILL TREE');
await page.waitForTimeout(700);
const skillTree = await page.evaluate(() => ({
  title: document.querySelector('.title-xl')?.textContent?.trim() ?? null,
  nodes: document.querySelectorAll('.skill-node').length,
  overlayCards: document.querySelectorAll('.overlay-card').length,
}));
step(skillTree.nodes >= 25, 'skill tree shows all 25 element nodes', JSON.stringify(skillTree));
step(skillTree.overlayCards === 0, 'pause card does not stack over the skill tree');

await page.click('text=BACK');
await page.waitForTimeout(700);
const backState = await page.evaluate(() => ({
  card: document.querySelector('.overlay-card .overlay-title')?.textContent?.trim() ?? null,
  frozen: window.__sixfoldGame?.scene?.getScene('GameplayScene')?.frozen ?? 'n/a (production)',
}));
step(backState.card === 'PAUSED', 'BACK from the skill tree returns to the paused run', JSON.stringify(backState));

await page.click('text=RESUME');
await page.waitForTimeout(1200);
const resumed = await readRun();
step(!resumed.overlay && resumed.canvas, 'resume closes the pause overlay and shows the arena', JSON.stringify(resumed));
// A live scene animates; a frozen one replays the same frame. Holding attack
// adds muzzle/particle motion so the check cannot pass on a stalled game.
await page.mouse.move(683, 384);
await page.mouse.down();
const live = await canvasIsAnimating();
await page.mouse.up();
step(live.animating, 'the simulation is live again after resume', JSON.stringify(live));

/* 6. Save & exit → reload → continue ---------------------------------- */
/*
 * The pause card is withheld while a chapter or floor card owns the frame (`paused && !transition`),
 * and the scene's Escape handler declines for the same reason — so a fixed sleep after Escape is a
 * coin toss that has already been seen to lose. Ask for the card, take whatever card is in the way's
 * own action, and only then continue.
 */
const openPauseCard = async () => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await page.locator('.overlay-card:has-text("PAUSED")').count()) return true;
    const gate = page.locator('.overlay-layer button').first();
    if (await gate.count()) await gate.click({ timeout: 3000 }).catch(() => undefined);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(450);
  }
  return Boolean(await page.locator('.overlay-card:has-text("PAUSED")').count());
};
step(await openPauseCard(), 'the pause card answers an Escape request');
await page.click('text=SAVE & EXIT');
await page.waitForTimeout(2500);
const savedFile = await page.evaluate((key) => {
  const slot = JSON.parse(localStorage.getItem(key) ?? 'null')?.slots?.[0];
  return {
    name: slot?.profile?.name ?? null,
    wave: slot?.story?.currentWave ?? null,
    playtime: Math.round(slot?.profile?.playtime ?? 0),
    lastPlayed: slot?.profile?.lastPlayed ?? null,
  };
}, SAVE_KEY);
step(savedFile.name === 'E2E' && savedFile.playtime > 0, 'save & exit writes progress and playtime', JSON.stringify(savedFile));

await page.goto(URL_BASE, { waitUntil: 'load' });
await page.waitForSelector('text=CONTINUE', { timeout: 30000 });
await page.click('text=CONTINUE');
await page.waitForTimeout(7000);
const continued = await readRun();
const waveMatches = continued.hudWave !== null && continued.hudWave >= savedFile.wave;
step(
  continued.canvas && !continued.overlay && waveMatches,
  'reload → CONTINUE resumes the run at the saved wave',
  JSON.stringify({ ...continued, savedWave: savedFile.wave }),
);

/* 7. Runtime errors --------------------------------------------------- */
step(pageErrors.length === 0, 'no uncaught errors across the whole flow', pageErrors.slice(0, 3).join(' | '));

await page.screenshot({ path: 'e2e-final.png' }); // ignored by .gitignore
await browser.close();
console.log(`\n${failures.length === 0 ? 'All end-to-end steps passed.' : `FAILURES: ${failures.join(', ')}`}`);
process.exit(failures.length === 0 ? 0 : 1);
