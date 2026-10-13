/**
 * GitHub Pages deployment check.
 *
 * Builds the app the way the Actions workflow does — a project page served from
 * `/<repository>/`, not from the domain root — serves `dist` under that prefix,
 * and then proves three things that silently break Pages deployments:
 *
 *   1. every asset the document asks for answers 200 (no root-absolute URLs);
 *   2. the game actually boots and starts a run from that sub-path;
 *   3. the manifest, the icons and the preloaded font resolve relatively, and
 *      the manifest parses with the icons it names present on disk.
 *
 * Usage: node tools/pages-check.mjs            (builds, serves, probes, exits)
 */
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = process.env.PAGES_BASE ?? '/sixfold/';
const PORT = Number(process.env.PAGES_PORT ?? 4180);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const URL_APP = `${ORIGIN}${BASE}`;

const require = createRequire(import.meta.url);
const npxRoot = path.join(homedir(), '.npm', '_npx');
/** @type {import('playwright').BrowserType} */
let chromium = null;
for (const candidate of [
  path.resolve(ROOT, 'node_modules/playwright'),
  ...(existsSync(npxRoot) ? readdir(npxRoot).map((d) => path.join(npxRoot, d, 'node_modules/playwright')) : []),
]) {
  if (!existsSync(path.join(candidate, 'package.json'))) continue;
  try {
    chromium = require(candidate).chromium;
    break;
  } catch {
    /* next candidate */
  }
}
if (!chromium) throw new Error('playwright is not resolvable (npm i -D playwright && npx playwright install chromium)');

function readdir(dir) {
  try {
    return require('node:fs').readdirSync(dir);
  } catch {
    return [];
  }
}

const results = [];
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}

console.log(`building with VITE_BASE_PATH=${BASE}`);
execFileSync('npm', ['run', 'build'], { cwd: ROOT, env: { ...process.env, VITE_BASE_PATH: BASE }, stdio: 'inherit' });

const html = readFileSync(path.join(ROOT, 'dist/index.html'), 'utf8');
// A project page is served from /<repository>/, so absolute-from-root URLs are
// only wrong when they ignore that prefix: `./`-relative (the default build,
// which also works from any path) or prefixed by the base are both fine.
const absolute = [...html.matchAll(/(?:href|src)="(\/[^"]+)"/g)].map((m) => m[1]);
const strays = absolute.filter((url) => !url.startsWith(BASE));
check(
  'every asset URL is relative or inside the Pages base',
  strays.length === 0,
  absolute.length ? (strays.length ? strays : `all ${absolute.length} prefixed with ${BASE}`) : 'all relative',
);
check('dist/.nojekyll present', existsSync(path.join(ROOT, 'dist/.nojekyll')));
check('dist/manifest.webmanifest present', existsSync(path.join(ROOT, 'dist/manifest.webmanifest')));

/*
 * The preview server is started as its own process group and killed by group, not by pid.
 *
 * It used to be `spawn('npx', ['vite', 'preview', …])` with a `server.kill()` on the way out — which signals
 * the *npx wrapper* and leaves `vite preview`, its grandchild, alive on the port. Four of those accumulated
 * on a two-core box and every browser gate that ran afterwards lost most of its throughput (a 154-second run
 * became 500+, then timed out). Running vite's own bin directly means the pid we hold is the server; the
 * process group is the belt so a wrapper, if one is ever needed again, cannot outlive this tool.
 */
const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const server = spawn(
  ...(existsSync(viteBin)
    ? [process.execPath, [viteBin, 'preview', '--host', '127.0.0.1', '--port', String(PORT)]]
    : ['npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT)]]),
  {
    cwd: ROOT,
    env: { ...process.env, VITE_BASE_PATH: BASE },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    detached: true,
  },
);
const stop = () => {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try {
      process.kill(-server.pid, signal);
    } catch {
      return; // group already gone
    }
    if (signal === 'SIGTERM') {
      try {
        const until = Date.now() + 1500;
        while (Date.now() < until) { /* let the group unwind */ }
      } catch { /* ignore */ }
    }
  }
};
process.on('exit', stop);

const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  try {
    const probe = await fetch(`${URL_APP}index.html`);
    if (probe.ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  hasTouch: true,
  isMobile: true,
});
const failures = [];
page.on('requestfailed', (request) => failures.push(`FAILED ${request.url()}`));
page.on('response', (response) => {
  if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
});
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});

await page.goto(URL_APP, { waitUntil: 'load' });
await page.waitForSelector('text=NEW WARDEN', { timeout: 40000 });
check('boots from the Pages sub-path', true, 'home screen rendered');

// The manifest, the icon set and the preloaded font, as the deployed page names them.
const manifestUrl = new URL('manifest.webmanifest', URL_APP).href;
const manifestRes = await fetch(manifestUrl);
const manifest = await manifestRes.json().catch(() => null);
check('manifest reachable + parses', manifestRes.ok && !!manifest, { status: manifestRes.status });
if (manifest) {
  const iconFiles = manifest.icons.map((icon) => icon.src);
  const onDisk = iconFiles.every((src) => existsSync(path.join(ROOT, 'dist', src)));
  check('every manifest icon exists in dist', onDisk, iconFiles);

/*
 * `dist` is filled from the working tree, so a git-ignored file ships perfectly from this machine and is
 * simply absent on GitHub: the Pages build checks out a clone, and `public/` in that clone has no icons to
 * copy. This is the only check here that looks at the repository rather than the build output, and it exists
 * because a blanket `*.png` ignore rule once hid public/icons/*.png and assets/brain-source.png — the local
 * build was green, the deployed page 404ed its apple-touch-icon and installed with no icons at all.
 */
const ignoredShipFiles = (() => {
  try {
    const out = execFileSync(
      'git',
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--', 'public', 'assets', 'src', 'index.html'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    return out.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return null; // not a git checkout (a tarball, a CI step without history): nothing to assert about the repo
  }
})();
check(
  'no file the app ships is git-ignored',
  ignoredShipFiles === null || ignoredShipFiles.length === 0,
  ignoredShipFiles === null
    ? 'skipped: not a git checkout'
    : ignoredShipFiles.length
      ? `ignored and would be missing from a clone: ${ignoredShipFiles.join(', ')} — public/ and assets/ are shipped input, not artefacts`
      : 'public/, assets/, src/ and index.html are all tracked',
);
  for (const src of iconFiles) {
    const res = await fetch(new URL(src, URL_APP).href);
    check(`icon served 200: ${src}`, res.ok && (await res.arrayBuffer()).byteLength > 500, res.status);
  }
  check('manifest is standalone + any-orientation', manifest.display === 'standalone' && manifest.orientation === 'any', {
    display: manifest.display,
    orientation: manifest.orientation,
  });
  check(
    'manifest start_url/scope are relative (sub-path safe)',
    manifest.start_url === './' && manifest.scope === './',
    { start_url: manifest.start_url, scope: manifest.scope },
  );
}
const fontMatch = html.match(/rel="preload" as="font"[^>]*href="([^"]+)"/);
if (fontMatch) {
  const res = await fetch(new URL(fontMatch[1], URL_APP).href);
  check('preloaded display font resolves', res.ok, `${fontMatch[1]} → ${res.status}`);
} else {
  check('preloaded display font resolves', false, 'no preload tag in dist/index.html');
}

// A real run, at the handheld plan, from the deployed build.
await page.click('text=NEW WARDEN');
await page.waitForSelector('text=THE VAULT');
await page.click('.slot-plinth:has-text("RAISE A WARDEN")');
await page.waitForSelector('text=CHOOSE YOUR FLAME');
await page.locator('button', { hasText: 'BIND AND BEGIN' }).click();
await page.waitForSelector('text=CREATE WARDEN');
await page.locator('button', { hasText: 'CREATE WARDEN' }).click();
await page.waitForSelector('text=STEP THROUGH');
await page.click('text=STEP THROUGH');
await page.waitForTimeout(6000);
const hud = await page.evaluate(() => ({
  wave: document.querySelector('.hud-tc .wave-number')?.textContent?.trim() ?? null,
  objective: document.querySelector('.objective-text')?.textContent?.trim() ?? null,
  canvas: (() => {
    const c = document.querySelector('canvas');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), buf: [c.width, c.height] };
  })(),
  overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
}));
check('production build plays at the handheld plan', Boolean(hud.canvas && hud.canvas.buf[0] <= 220 && hud.overflowX === 0), hud);

const bodyErrors = failures.filter((line) => !/favicon\.ico/.test(line));
check('no failed requests from the deployed page', bodyErrors.length === 0, bodyErrors.slice(0, 6));
const realConsole = consoleErrors.filter(
  (text) => !/AudioContext|autoplay|GPU stall|ReadPixels|WebGL/i.test(text),
);
check('no console errors beyond known harness noise', realConsole.length === 0, realConsole.slice(0, 4));

await page.screenshot({ path: path.join(ROOT, '../audit/pages-check.png') }).catch(() => undefined);
await browser.close();
stop();

console.log('');
for (const line of results) console.log(line);
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} Pages checks passed`);
process.exit(failed.length ? 1 : 0);
