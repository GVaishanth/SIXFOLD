#!/usr/bin/env node
/**
 * SIXFOLD audit script.
 *
 * Checks the things that are easy to break and hard to notice:
 *   1. wave scaling at 1 / 201 / 402 / 603 / 1000+ (no NaN, no runaway values);
 *   2. corrupt save recovery (the game must boot, not crash);
 *   3. legacy save migration (v1–v3 keys are read and written forward).
 *
 * It drives a real Chromium instance and imports the game's own modules, so it
 * needs the Vite dev server (module paths are served from /src):
 *
 *   npm run dev &
 *   npx -y playwright@1.56.1 install --with-deps chromium
 *   node tools/audit.mjs
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
const note = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

const boot = async () => {
  await page.goto(URL_BASE, { waitUntil: 'load' });
  await page.waitForSelector('text=NEW WARDEN', { timeout: 30000 });
};

/* ------------------------------------------------------------------ */
/* 1. Wave scaling                                                     */
/* ------------------------------------------------------------------ */
await boot();
const scaling = await page.evaluate(async () => {
  const wave = await import('/src/game/systems/waveGenerator.ts');
  const bosses = await import('/src/data/bosses/index.ts');
  const difficulty = await import('/src/config/gameConfig.ts');
  const rows = [];
  for (const w of [1, 10, 20, 40, 100, 200, 201, 402, 603, 1000, 2001, 5000]) {
    const spec = wave.generateWave({ wave: w, mode: w > 200 ? 'ascension' : 'story' });
    const bossDef = spec.bossId ? bosses.getBoss(spec.bossId) : null;
    /*
     * In-game boss pools take the square root of the wave multiplier (see
     * GameplayScene.spawnEnemy) and every hit is capped against the player's
     * max HP, so the audit mirrors those two rules to stay meaningful.
     */
    const bossHpMult = Math.pow(spec.hpMult, 0.5) * 1.15;
    rows.push({
      wave: w,
      floor: spec.floor,
      localWave: spec.localWave,
      count: spec.total,
      hpMult: spec.hpMult,
      damageMult: spec.damageMult,
      bossHp: bossDef ? Math.round(bossDef.hp * bossHpMult) : null,
      eliteChance: spec.eliteChance,
      affixChance: spec.affixChance ?? 0,
      finite: [spec.hpMult, spec.damageMult, spec.eliteChance, spec.rewardMult].every(Number.isFinite),
      bossDamageCap: bossDef
        ? Math.min(bossDef.damage * spec.damageMult, 100 * difficulty.DIFFICULTY.bossDamageCapFraction)
        : null,
    });
  }
  return rows;
});

console.table(
  scaling.map((r) => ({
    wave: r.wave,
    floor: r.floor,
    enemies: r.count,
    hpMult: r.hpMult.toFixed(2),
    dmgMult: r.damageMult.toFixed(2),
    bossHp: r.bossHp ?? '-',
    bossHit: r.bossDamageCap ? r.bossDamageCap.toFixed(1) : '-',
    elite: r.eliteChance.toFixed(2),
    affix: r.affixChance.toFixed(2),
  })),
);
note(
  scaling.every((r) => r.finite),
  'wave scaling stays finite at 201 / 402 / 603 / 1000 / 5000',
);
note(
  (scaling.at(-1).hpMult ?? 0) < 1e7,
  'enemy scaling does not explode into unplayable numbers',
  `wave 5000 hpMult = ${scaling.at(-1).hpMult.toFixed(1)}`,
);
note(
  scaling.every((r) => r.count <= 34),
  'wave enemy counts respect the configured ceiling',
);

/* ------------------------------------------------------------------ */
/* 2. Corrupt save                                                     */
/* ------------------------------------------------------------------ */
await page.evaluate((key) => localStorage.setItem(key, '{ this is not json'), SAVE_KEY);
await boot();
const corrupt = await page.evaluate((key) => {
  let parsed = null;
  try {
    parsed = JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    parsed = null;
  }
  return {
    booted: true,
    repaired: Boolean(parsed),
    slots: parsed?.slots?.length ?? 0,
    backup: Boolean(localStorage.getItem(`${key}.broken`)),
  };
}, SAVE_KEY);
note(corrupt.booted && corrupt.repaired, 'corrupt save is replaced with a valid file without crashing');

/* ------------------------------------------------------------------ */
/* 3. Legacy migration                                                 */
/* ------------------------------------------------------------------ */
await page.evaluate(
  ([key]) => {
    localStorage.removeItem(key);
    localStorage.setItem(
      'sixfold.save.v3',
      JSON.stringify({
        version: 3,
        slots: [
          {
            version: 3,
            slot: 0,
            profile: { name: 'LegacyWarden', starter: 'water', createdAt: 1, lastPlayed: 2, playtime: 3600 },
            unlockedElements: ['water', 'air'],
            mastery: { water: { level: 3, xp: 250 } },
            story: { highestWave: 34, currentWave: 34, currentFloor: 2, clearedWaves: [1, 2, 3] },
            stats: { enemiesDefeated: 77 },
          },
        ],
        lastSlot: 0,
      }),
    );
  },
  [SAVE_KEY],
);
await boot();
const migrated = await page.evaluate((key) => {
  const file = JSON.parse(localStorage.getItem(key) ?? 'null');
  const slot = file?.slots?.[0];
  return {
    version: file?.version ?? null,
    name: slot?.profile?.name ?? null,
    starter: slot?.profile?.starter ?? null,
    wave: slot?.story?.currentWave ?? null,
    kills: slot?.stats?.enemiesDefeated ?? null,
    masteryLevel: slot?.mastery?.water?.level ?? null,
    keepsLegacy: Boolean(localStorage.getItem('sixfold.save.v3')),
  };
}, SAVE_KEY);
note(
  migrated.version === 4 && migrated.name === 'LegacyWarden' && migrated.wave === 34,
  'legacy v3 save migrates to the current schema',
  JSON.stringify(migrated),
);

/* ------------------------------------------------------------------ */
/* 4. Interface / simulation state sync                                */
/* ------------------------------------------------------------------ */
await page.goto(URL_BASE, { waitUntil: 'load' });
await page.waitForSelector('text=NEW WARDEN', { timeout: 30000 });
// Clear every save artefact (current, backups and legacy) so this section
// starts from a genuinely empty profile.
await page.evaluate(
  ([key]) => {
    for (const storageKey of Object.keys(localStorage)) {
      if (storageKey.startsWith('sixfold.save')) localStorage.removeItem(storageKey);
    }
    localStorage.removeItem(key);
  },
  [SAVE_KEY],
);
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('text=NEW WARDEN', { timeout: 30000 });
await page.click('text=NEW WARDEN');
await page.waitForSelector('text=THE VAULT');
await page.click('.slot-plinth:has-text("RAISE A WARDEN")');
await page.waitForSelector('text=CHOOSE YOUR FLAME', { timeout: 15000 });
await page.fill('input[aria-label="Warden name"]', 'Audit');
await page.locator('button', { hasText: 'BIND AND BEGIN' }).click();
await page.waitForSelector('text=BEGIN THE ASCENT?');
await page.locator('button', { hasText: 'CREATE WARDEN' }).click();
await page.waitForSelector('text=STEP THROUGH', { timeout: 15000 });
await page.click('text=STEP THROUGH');
await page.waitForTimeout(7000);

const desync = [];
for (let i = 0; i < 14; i += 1) {
  const sample = await page.evaluate(() => {
    const scene = window.__sixfoldGame.scene.getScene('GameplayScene');
    const director = scene.director;
    const text = document.body.innerText;
    // The quadrant HUD names the wave in `.wave-number` and the hostiles left in
    // the objective line ("CLEAR 4 HOSTILES"); a boss wave has neither number.
    const hudWave = Number(/WAVE\s+(\d+)/.exec(document.querySelector('.hud-tc .wave-number')?.textContent ?? '')?.[1] ?? NaN);
    const hudRemaining = Number(/CLEAR\s+(\d+)/.exec(text)?.[1] ?? NaN);
    const alive =
      scene.enemies.getChildren().filter((enemy) => enemy.active).length +
      Math.max(0, director.queue.length - director.queueCursor) +
      director.portals.length;
    return {
      sceneWave: director.currentSpec?.wave ?? null,
      hudWave,
      sceneActive: director.currentState !== 'cleared' && director.currentState !== 'idle' ? alive : null,
      hudRemaining,
      directorRemaining: director.remainingEnemies,
      frozen: scene.frozen,
      screen: document.querySelector('.screen') ? true : false,
    };
  });
  if (!Number.isNaN(sample.hudWave) && sample.hudWave !== sample.sceneWave) {
    desync.push(`wave HUD=${sample.hudWave} scene=${sample.sceneWave}`);
  }
  if (sample.frozen !== false && !sample.screen) desync.push('simulation frozen during live gameplay');
  if (sample.directorRemaining !== null && sample.hudRemaining !== null) {
    if (sample.hudRemaining !== sample.directorRemaining) {
      desync.push(`remaining HUD=${sample.hudRemaining} scene=${sample.directorRemaining}`);
    }
  }
  await page.waitForTimeout(600);
}
note(desync.length === 0, 'HUD stays in step with the simulation', desync.slice(0, 4).join(' | '));

/* ------------------------------------------------------------------ */
/* 5. Reactions and floor hazards are live systems, not tables        */
/* ------------------------------------------------------------------ */
// Make sure something is alive to hit: skip to a fresh wave if the arena is empty.
await page.evaluate(async () => {
  const scene = () => window.__sixfoldGame?.scene?.getScene('GameplayScene');
  for (let i = 0; i < 10; i += 1) {
    const alive = scene()?.enemies?.getChildren?.().some((e) => e.active && !e.isBoss);
    if (alive) return;
    window.__sixfoldBus?.emit('command:grantCheat', { nextWave: true });
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
});
await page.waitForTimeout(1500);

const reaction = await page.evaluate(() => {
  const scene = window.__sixfoldGame?.scene?.getScene('GameplayScene');
  if (!scene) return { ok: false, reason: 'no gameplay scene handle (dev build required)' };
  // Both measurements need the same starting point: a full-health mob with no
  // carried status. Otherwise a hazard-scuffed enemy dies to the control hit (or
  // detonates on it) and the comparison says nothing.
  const enemy = scene.enemies.getChildren().find((entry) => entry.active && !entry.isBoss);
  if (!enemy) return { ok: false, reason: 'no live enemy to test against' };
  const prime = () => {
    enemy.statuses.remove('slow');
    enemy.hp = enemy.maxHp;
  };
  const hit = () => {
    const before = enemy.hp;
    enemy.takeDamage({
      amount: 6,
      isCrit: false,
      element: 'fire',
      vfx: 'spark',
      color: 0xff9550,
      damageType: 'elemental',
      statuses: [],
      knockback: 0,
      source: 'player',
      sourceX: enemy.x,
      sourceY: enemy.y - 20,
    });
    return Math.max(0, Math.round(before - enemy.hp));
  };
  // Differential: the same packet twice, with and without the carried status.
  prime();
  const clean = hit();
  prime();
  enemy.statuses.apply({ id: 'slow', duration: 8 });
  const reacting = hit();
  const slowConsumed = !enemy.statuses.all.some((entry) => entry.id === 'slow');
  return { ok: clean > 0 && reacting > clean && slowConsumed, clean, reacting, slowConsumed };
});
note(
  reaction.ok,
  'fire on a slowed target detonates and consumes the slow (reaction system)',
  JSON.stringify(reaction),
);

const hazardState = await page.evaluate(() => {
  const scene = window.__sixfoldGame?.scene?.getScene('GameplayScene');
  const director = scene?.hazards;
  return {
    kind: scene?.context?.floor?.hazard?.kind ?? null,
    running: director ? director.active : null,
    label: director?.label ?? null,
  };
});
note(
  hazardState.kind !== 'none' && hazardState.running === true && Boolean(hazardState.label),
  'floor hazard is driven by the hazard director',
  JSON.stringify(hazardState),
);

/* ------------------------------------------------------------------ */
/* 6. Runtime errors                                                   */
/* ------------------------------------------------------------------ */
note(pageErrors.length === 0, 'no uncaught page errors during the audit', pageErrors.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n${failures.length === 0 ? 'All audit checks passed.' : `FAILURES: ${failures.join(', ')}`}`);
process.exit(failures.length === 0 ? 0 : 1);
