/**
 * Config-key liveness sweep (static; no browser).
 *
 * `docs/STATS_GAMEPLAY_FAULTS.md` §B10 exists because `src/config/gameConfig.ts` grew 44
 * depth-2 keys that no code read — knobs that look like a spec and are not. This is the
 * regression guard for that class of fault: every leaf key declared in the config file must
 * be reachable from `src/` outside the config module itself.
 *
 * A key counts as read when something writes `.key`, `["key"]`, pulls it out of its object by
 * destructure (`const { vacuumMs, … } = PICKUP_CONFIG`), or indexes / iterates the *block* it
 * sits in — `CAMERA_CONFIG.shake[strength]` and `Object.entries(PROGRESSION.waveMilestones)`
 * make every key of that block live without naming any of them.
 *
 * A `sweep: vocabulary` comment above an export exempts it, for objects that are deliberately
 * complete rather than consumed key-by-key (the colour palette).
 *
 *   node tools/configKeySweep.mjs        # exit 1 if any key is unreachable
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(root, 'src/config/gameConfig.ts');

/**
 * Leaf keys with their owner and immediate parent block, so `CAMERA_CONFIG.shake.light` is
 * reported as `CAMERA_CONFIG.shake.light` and checked against `shake[`.
 */
function declaredKeys(text) {
  const keys = new Map();
  let owner = null;
  let exempt = false;
  let stack = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (/sweep:\s*vocabulary/.test(line)) {
      exempt = true;
      continue;
    }
    const exported = line.match(/^export const ([A-Z0-9_]+)\s*[:=]/);
    if (exported) {
      owner = exported[1];
      stack = exempt ? ['__exempt__'] : [];
      exempt = false;
      continue;
    }
    if (!owner) continue;
    if (stack.includes('__exempt__')) continue;

    const closed = /^\}/.test(line) || /^\],?$/.test(line);
    if (closed && stack.length > 0) stack.pop();

    const branch = line.match(/^\s*([A-Za-z][A-Za-z0-9_]*):\s*\{\s*$/);
    if (branch) {
      stack.push(branch[1]);
      continue;
    }
    const leaf = line.match(/^\s*([A-Za-z][A-Za-z0-9_]*):\s*(?!\{)/);
    if (leaf && !/^\s*\*/.test(raw)) {
      const path = [owner, ...stack, leaf[1]].join('.');
      keys.set(path, { key: leaf[1], owner, parent: stack.length ? `${owner}.${stack[stack.length - 1]}` : owner });
    }
  }
  return keys;
}

function sources() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name !== 'config') walk(p);
      } else if (/\.tsx?$/.test(p)) out.push(p);
    }
  };
  walk(join(root, 'src'));
  return out.filter((p) => p !== CONFIG);
}

const escapeRe = (x) => x.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&');

function readShapes({ key, owner, parent }) {
  const block = parent === owner ? escapeRe(owner) : `${escapeRe(owner)}\\.${escapeRe(parent.split('.').pop())}|\\b${escapeRe(parent.split('.').pop())}\\b`;
  return [
    new RegExp(`\\.${escapeRe(key)}\\b`),
    new RegExp(`\\["'\\\`]?${escapeRe(key)}\\b\\]?`),
    new RegExp(`\\{[^{}]*\\b${escapeRe(key)}\\b[^{}]*\\}\\s*=`),
    new RegExp(`(?:${block})\\s*\\[`),
    new RegExp(`Object\\.(?:keys|values|entries)\\(\\s*(?:${block})\\b`),
  ];
}

const keys = declaredKeys(readFileSync(CONFIG, 'utf8'));
const srcText = sources().map((p) => readFileSync(p, 'utf8')).join('\n');
const dead = [...keys.entries()].filter(([, where]) => {
  const shapes = readShapes(where);
  return !shapes.some((re) => re.test(srcText));
});

console.log(
  JSON.stringify(
    {
      configKeys: keys.size,
      scannedFiles: sources().length,
      unreachable: dead.length,
      keys: dead.map(([path]) => path),
    },
    null,
    1,
  ),
);
process.exit(dead.length > 0 ? 1 : 0);
