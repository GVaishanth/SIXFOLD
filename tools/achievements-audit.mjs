#!/usr/bin/env node
/**
 * Achievement ledger gate — `npm run audit:achievements`.
 *
 * Node only: no browser, no dev server. It bundles the *shipped* data module with esbuild (the same
 * technique as `audit:dungeon`) so every assertion below runs against the real `measure`/`requires`
 * closures, not a copy of them. Three things go wrong on their own in a list like this one, and each has
 * a check here:
 *
 *   1. **an impossible entry** — a threshold above what the game can record (a 20-warden achievement in a
 *      10-warden story). Caught by a *fixture search*: the gate grows a synthetic save by filling every
 *      path a measure reads, and demands `achievementProgress >= 1` for all of them.
 *   2. **an unreadable entry** — a measure that reads a field no code path ever writes, which sits at
 *      zero forever. Caught by extracting the read paths out of the compiled closures via
 *      `Function.prototype.toString()`, then requiring each one to be (a) assignable in the fixture and
 *      (b) written somewhere under `src/` outside the schema defaults.
 *   3. **a bar that lies** — a percentage computed from something other than the measure. Caught by
 *      requiring the store to be the only consumer of `achievementProgress`, and by forbidding a stored
 *      progress number anywhere in the data file.
 *
 * Usage: node tools/achievements-audit.mjs
 */
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const esbuild = require('esbuild');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' || detail === undefined ? '' : ` — ${fmt(detail)}`}`);
};
const fmt = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

/* ----------------------------------------------------------------- build --- */
const outfile = path.join(mkdtempSync(path.join(tmpdir(), 'sixfold-ach-')), 'bundle.mjs');
await esbuild.build({
  stdin: {
    contents: `
      export {
        ACHIEVEMENTS, ACHIEVEMENT_COUNT, ACHIEVEMENT_THEMES,
        achievementProgress, achievementReadout, getAchievement,
      } from '@/data/achievements';
      export { defaultSaveData } from '@/utils/saveSchema';
      export { computeResonances, ALL_ELEMENTS } from '@/data/elements';
      export { BOSS_LIST } from '@/data/bosses';
      export { ELEMENT_IDS } from '@/types/element';
    `,
    resolveDir: ROOT,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  alias: { '@': path.join(ROOT, 'src') },
  define: {
    'import.meta.env.DEV': 'false',
    'import.meta.env.PROD': 'true',
    'import.meta.env.VITE_SIXFOLD_DEBUG': '"false"',
  },
  logLevel: 'silent',
});
const M = await import(pathToFileURL(outfile).href);
const {
  ACHIEVEMENTS, ACHIEVEMENT_COUNT, ACHIEVEMENT_THEMES,
  achievementProgress, achievementReadout, getAchievement,
  defaultSaveData, computeResonances, ALL_ELEMENTS, BOSS_LIST, ELEMENT_IDS,
} = M;

check('the bundle exposes the shipped ledger', Array.isArray(ACHIEVEMENTS) && ACHIEVEMENTS.length > 0);

/* --------------------------------------------------------------- shape --- */
check(
  'ACHIEVEMENT_COUNT agrees with the array',
  ACHIEVEMENT_COUNT === ACHIEVEMENTS.length,
  `${ACHIEVEMENT_COUNT} vs ${ACHIEVEMENTS.length}`,
);
check('the ledger is bigger than it was (>= 24)', ACHIEVEMENTS.length >= 24, `${ACHIEVEMENTS.length} entries`);

const ids = ACHIEVEMENTS.map((def) => def.id);
check('every id is unique', new Set(ids).size === ids.length, ids.filter((id, i) => ids.indexOf(id) !== i));
check('every id resolves through getAchievement', ids.every((id) => getAchievement(id)?.id === id));

const themeIds = ACHIEVEMENT_THEMES.map((theme) => theme.id);
check(
  'every entry belongs to a declared theme',
  ACHIEVEMENTS.every((def) => themeIds.includes(def.theme)),
  [...new Set(ACHIEVEMENTS.map((def) => def.theme))].filter((t) => !themeIds.includes(t)),
);
const perTheme = themeIds.map((id) => ({ id, n: ACHIEVEMENTS.filter((def) => def.theme === id).length }));
check('no theme is a one-entry orphan', perTheme.every((row) => row.n >= 5), perTheme);

const badTarget = ACHIEVEMENTS.filter((def) => !(Number.isInteger(def.target) && def.target > 0));
check('every target is a positive integer', badTarget.length === 0, badTarget.map((def) => `${def.id}:${def.target}`));
check(
  'every entry carries a measure function',
  ACHIEVEMENTS.every((def) => typeof def.measure === 'function'),
);
check(
  'every requires, if present, is a function',
  ACHIEVEMENTS.every((def) => def.requires === undefined || typeof def.requires === 'function'),
);
check(
  'no name is duplicated',
  new Set(ACHIEVEMENTS.map((def) => def.name)).size === ACHIEVEMENTS.length,
);
check(
  'every entry has a glyph and a description',
  ACHIEVEMENTS.every((def) => def.glyph?.length > 0 && def.description?.length > 12),
);

/* -------------------------------------------------- the progress contract --- */
const dataText = readFileSync(path.join(ROOT, 'src/data/achievements.ts'), 'utf8');
check(
  'the data file stores no progress of its own',
  !/\bprogress\s*:/.test(dataText.split('export const ACHIEVEMENTS')[1] ?? '') && !/\bdef\.progress\b/.test(dataText),
);
const storeText = readFileSync(path.join(ROOT, 'src/store/saveStore.ts'), 'utf8');
check(
  'the store is the single place progress is computed',
  (storeText.match(/achievementProgress\(/g) ?? []).length === 1 && !/def\.progress\s*\(/.test(storeText),
);
const screenText = readFileSync(path.join(ROOT, 'src/components/screens/AchievementsScreen.tsx'), 'utf8');
check(
  'the ledger screen reads the count from the data file',
  /ACHIEVEMENT_COUNT/.test(screenText) && !/\.length\s*\/\s*14/.test(screenText),
);
check('the ledger screen groups by theme', /ACHIEVEMENT_THEMES\.map/.test(screenText) && /ach-\$\{theme\.id\}/.test(screenText));
check('the ledger screen can be filtered', /useState<Filter>/.test(screenText));

/* ------------------------------------------------ the reads are reachable --- */
/** The save paths a function body reads, taken from the compiled closure source. */
function readPaths(fn) {
  const src = fn.toString();
  const out = new Set();
  for (const m of src.matchAll(/\b(?:d|data|save)\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)/g)) {
    const segs = m[1].split('.');
    // Keep the path down to the leaf that is actually read (`stats.runEndings.filter` -> stats.runEndings).
    while (segs.length && /^(filter|length|some|every|map|reduce|values|includes|find|sort|flat)$/.test(segs.at(-1))) {
      segs.pop();
    }
    if (segs.length) out.add(segs.join('.'));
  }
  return [...out];
}

const allPaths = new Map();
for (const def of ACHIEVEMENTS) {
  allPaths.set(def.id, [...new Set([...readPaths(def.measure), ...(def.requires ? readPaths(def.requires) : [])])]);
}
const knownPaths = new Set([].concat(...allPaths.values()));

/** A field is "written" if something under src/ assigns it, outside the schema defaults and the ledger itself. */
function walk(dir, acc = []) {
  for (const entry of readdirSync(path.join(ROOT, dir))) {
    const full = path.join(dir, entry);
    const st = statSync(path.join(ROOT, full));
    if (st.isDirectory()) walk(full, acc);
    else if (/\.tsx?$/.test(entry)) acc.push(full);
  }
  return acc;
}
const sources = walk('src').filter(
  (file) => !/saveSchema\.ts$/.test(file) && !/data\/achievements\.ts$/.test(file) && !/types\//.test(file),
);
const texts = sources.map((file) => ({ file: path.relative(ROOT, file), text: readFileSync(path.join(ROOT, file), 'utf8') }));

const orphans = [];
for (const p of [...knownPaths].sort()) {
  const leaf = p.split('.').at(-1);
  // A save array is usually grown in place (`draft.discoveredElements.push(id)`) rather than assigned,
  // so both shapes count as a write. Anything that only ever appears in a default block is not a write.
  const assign = new RegExp(`\\b${leaf}\\b\\s*(?:\\+=|-=|:|=[^=])`);
  const mutate = new RegExp(`\\.${leaf}\\b\\s*\\.\\s*(?:push|add|splice|sort|fill)\\(`);
  const writes = texts.filter(({ text }) => assign.test(text) || mutate.test(text));
  if (!writes.length) orphans.push(p);
}
check(
  'every field a measure reads is written by the game',
  orphans.length === 0,
  orphans.length ? orphans : `${knownPaths.size} distinct save paths, all written`,
);

/* ------------------------------------------------------ the synthetic save --- */
const MAX = 1_000_000;
/** Thirty days of play, so the time-based entry clears on a save that has done everything. */
const MAX_MS = 30 * 24 * 60 * 60 * 1000;
function maxedSave() {
  const save = defaultSaveData(1, 'Fixture', ELEMENT_IDS[0]);
  save.unlockedElements = [...ELEMENT_IDS];
  save.discoveredElements = [...ELEMENT_IDS];
  save.stats.elementUsage = Object.fromEntries(ELEMENT_IDS.map((id) => [id, 40]));
  save.mastery = Object.fromEntries(ELEMENT_IDS.map((id) => [id, { level: 10, xp: 100000 }]));
  save.stats.enemiesDefeated = MAX;
  save.stats.bossesDefeated = MAX;
  save.stats.projectilesCountered = MAX;
  save.stats.highestHit = MAX;
  save.stats.totalDamage = MAX;
  save.stats.essenceCollected = MAX;
  save.stats.playtimeMs = MAX_MS;
  save.stats.runsStarted = MAX;
  save.stats.highestStoryWave = MAX;
  save.story.highestWave = 400;
  save.story.clearedWaves = Array.from({ length: 200 }, (_, i) => i + 1);
  save.story.storyBossesDefeated = BOSS_LIST.map((boss) => boss.id);
  save.story.completed = true;
  save.freeModeUnlocked = true;
  save.ascension.unlocked = true;
  save.ascension.cycle = 10;
  save.ascension.highestWave = 2000;
  save.progression.shards = MAX;
  save.progression.relics = ['a', 'b', 'c', 'd'];
  save.progression.hallLevel = 10;
  save.stats.runEndings = Array.from({ length: 30 }, () => ({
    mode: 'story',
    wave: 300,
    floor: 10,
    wavesCleared: 300,
    enemiesDefeated: 900,
    bossesDefeated: 1,
    essenceGained: 9000,
    highestHit: 900,
    durationMs: 9_999_999,
    checkpoint: null,
    unlocked: [],
    endedAt: Date.now(),
    cause: 'complete',
  }));
  // A loadout that actually resonates: search for six slots the shipped resonance rules light up.
  save.loadout.slots = pickResonantLoadout(save.loadout.slots.length || 6);
  return save;
}

function pickResonantLoadout(size) {
  let best = null;
  let bestCount = -1;
  // Combinations of `size` over the ids, capped so the gate stays a second, not a minute.
  const ids = ELEMENT_IDS;
  const idx = Array.from({ length: size }, (_, i) => i);
  let tries = 0;
  while (tries < 40000) {
    tries += 1;
    const slots = idx.map((i) => ids[i]);
    const n = computeResonances(slots).length;
    if (n > bestCount) {
      bestCount = n;
      best = [...slots];
      if (n >= 2 && tries > 200) break;
    }
    let k = size - 1;
    while (k >= 0 && idx[k] === ids.length - size + k) k -= 1;
    if (k < 0) break;
    idx[k] += 1;
    for (let j = k + 1; j < size; j += 1) idx[j] = idx[j - 1] + 1;
  }
  return best ?? ids.slice(0, size);
}

const maxed = maxedSave();
const fresh = defaultSaveData(2, 'Fresh', ELEMENT_IDS[0]);

const unreachable = [];
const invented = [];
const preearned = [];
for (const def of ACHIEVEMENTS) {
  const p = achievementProgress(def, maxed);
  if (!(p >= 1)) unreachable.push(`${def.id} ${fmt(p)} (${def.measure(maxed)}/${def.target})`);
  // A new save is allowed to be *part* of the way — it starts with one element, one discovery and one
  // mastery level — but nothing may be sealed before the player has done anything.
  if (achievementProgress(def, fresh) >= 1) preearned.push(`${def.id} ${fmt(achievementProgress(def, fresh))}`);
  for (const p2 of allPaths.get(def.id) ?? []) {
    let node = maxed;
    for (const seg of p2.split('.')) {
      if (node == null || !(seg in node)) {
        invented.push(`${def.id} reads ${p2}, which is not a save field`);
        break;
      }
      node = node[seg];
    }
  }
}
check('every entry is reachable on a save that has done everything', unreachable.length === 0, unreachable);
check('no entry is sealed on a brand-new save', preearned.length === 0, preearned);
check('no measure reads a field the save does not have', invented.length === 0, invented);
check(
  'the maxed fixture leaves no reason outstanding',
  ACHIEVEMENTS.every((def) => !def.requires || def.requires(maxed) === null),
  ACHIEVEMENTS.filter((def) => def.requires && def.requires(maxed) !== null).map((def) => def.id),
);

const readouts = ACHIEVEMENTS.map((def) => ({ id: def.id, line: achievementReadout(def, maxed) }));
check(
  'the readout on a done entry is not a percentage',
  readouts.every((row) => /done|of/.test(row.line)) &&
    ACHIEVEMENTS.filter((def) => def.target === 1).every((def) => achievementReadout(def, maxed) === 'done'),
  readouts.slice(0, 2).map((row) => row.line),
);
check(
  'a zero save prints a zero readout',
  ACHIEVEMENTS.filter((def) => achievementProgress(def, fresh) === 0).every((def) =>
    /^(0 of |not yet)/.test(achievementReadout(def, fresh)),
  ),
  achievementReadout(getAchievement('bolt_breaker'), fresh),
);

/* ------------------------------------------------ the new tally, wired up --- */
const gameplayText = readFileSync(path.join(ROOT, 'src/game/scenes/GameplayScene.ts'), 'utf8');
check(
  'the counter tally is written by the counter rule',
  /shotsCountered\s*=\s*0/.test(gameplayText) &&
    /projectilesCountered\s*\+=\s*1/.test(gameplayText) &&
    /shotsCountered\s*\+=\s*1/.test(gameplayText),
);
check(
  'the run record carries the tally out of the strip',
  /shotsCountered/.test(readFileSync(path.join(ROOT, 'src/store/saveStore.ts'), 'utf8')) &&
    /swatted/.test(readFileSync(path.join(ROOT, 'src/game/scenes/DungeonScene.ts'), 'utf8')),
);
check(
  'the bolt-keeping flag is what distinguishes a free counter',
  /destroysEnemyProjectiles/.test(gameplayText),
);

/* --------------------------------------------------------------- verdict --- */
const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} achievement checks passed.`);
if (failed.length) {
  for (const row of failed) console.log(`  FAIL ${row.name} — ${fmt(row.detail)}`);
  process.exitCode = 1;
}
