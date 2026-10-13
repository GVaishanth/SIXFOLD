/**
 * Pause-menu loadout probe.
 *
 * Proves the five things that make "edit the element loadout from the pause card" safe:
 * the route exists, the simulation is frozen while the editor is up, the edit reaches the
 * live scene, health is preserved, and Escape from the editor returns to a *paused* run
 * rather than a running one: `npm run audit:pausemenu`, with a dev server on :5173.
 *
 * It sits beside `audit:camera` and `audit:progression` rather than inside `verify`, because it
 * needs a browser — the type system cannot see that the pause card stopped offering a route to the
 * editor, and a check that only compiles the code would prove nothing about a button.
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
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

const OUT = '/home/user/audit';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const out = [];
const check = (name, ok, detail = '') => out.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);

/** Everything the scene and the store agree on, read in one round trip. */
const readState = () =>
  page.evaluate(() => {
    const g = window.__sixfoldGame;
    const scene = g?.scene.getScene('GameplayScene');
    const p = scene?.player;
    let stored = null;
    for (const key of Object.keys(localStorage)) {
      const raw = localStorage.getItem(key) ?? '';
      if (raw.includes('"loadout"')) {
        try {
          const json = JSON.parse(raw);
          // The vault is { slots: [SaveData | null, …] } — the record for the active
          // warden is the first written slot, which is where `loadout` actually lives.
          const record = (json.slots ?? []).find(Boolean) ?? json.state?.data ?? json.data ?? json;
          stored = record?.loadout?.slots ?? null;
        } catch {
          /* unreadable slot, ignore */
        }
        break;
      }
    }
    return {
      screen: document.querySelector('.game-layer')?.className ?? '',
      hasScene: Boolean(scene),
      frozen: scene?.frozen ?? null,
      timePaused: scene?.time?.paused ?? null,
      zoom: scene?.cameras?.main?.zoom ?? null,
      hp: p ? Math.round(p.hp) : null,
      maxHp: p ? Math.round(p.maxHp) : null,
      slots: p?.slots ?? null,
      activeSlot: p?.activeSlot ?? null,
      autoSlots: scene?.autoCast?.summary?.()?.map((s) => s.element) ?? null,
      stored,
    };
  });

const dialogText = () =>
  page.evaluate(() => document.querySelector('[role="dialog"][aria-label="Paused"]')?.innerText ?? '');

const clickIf = async (label) => {
  const b = page.locator('.overlay-card button', { hasText: label });
  if ((await b.count()) > 0) {
    await b.first().click();
    return true;
  }
  return false;
};

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'load' });
await page.waitForSelector('text=NEW WARDEN', { timeout: 40000 });
await page.click('text=NEW WARDEN');
await page.waitForSelector('text=THE VAULT');
await page.click('.slot-plinth:has-text("RAISE A WARDEN")');
await page.waitForSelector('text=CHOOSE YOUR FLAME');
await page.locator('button', { hasText: 'BIND AND BEGIN' }).click();
await page.waitForSelector('text=CREATE WARDEN');
await page.locator('button', { hasText: 'CREATE WARDEN' }).click();
await page.waitForSelector('text=STEP THROUGH', { timeout: 20000 });

/* a run, wounded on purpose so "health preserved" cannot pass by being full */
await page.locator('button', { hasText: 'STEP THROUGH' }).click();
await page.waitForTimeout(2600);
const beforeWound = await readState();
check('run is live', beforeWound.hasScene && beforeWound.hp !== null, `hp ${beforeWound.hp}/${beforeWound.maxHp}`);
await page.evaluate(() => {
  const scene = window.__sixfoldGame.scene.getScene('GameplayScene');
  scene.player.hp = Math.max(1, Math.round(scene.player.maxHp * 0.62));
});
const before = await readState();
check('player wounded for the test', before.hp < before.maxHp, `hp ${before.hp}/${before.maxHp}`);

/* 1. the pause card, reached the way a touch player reaches it */
await page.locator('.hud-menu-btn').click();
await page.waitForTimeout(320);
let card = await dialogText();
check('MENU opens the pause card', card.includes('PAUSED'));
check('pause card offers ELEMENTS', card.includes('ELEMENTS'));

/* 2. the elements tab now edits instead of pointing at the hub */
await clickIf('ELEMENTS');
await page.waitForTimeout(220);
card = await dialogText();
check('elements tab routes into the editor', card.includes('EDIT LOADOUT'), card.replace(/\n+/g, ' | '));
check('the old "go to the hub" dead end is gone', !/from the hub/i.test(card));

/* 3. the editor opens over a frozen simulation and says so */
await clickIf('EDIT LOADOUT');
await page.waitForTimeout(420);
const onLoadout = await page.locator('h1.title-xl', { hasText: 'LOADOUT' }).count();
const note = await page.locator('.live-run-note').count();
const frozenIn = await readState();
check('loadout editor is on screen', onLoadout === 1);
check('the live-run band is shown', note === 1);
check('the simulation is frozen while it is up', frozenIn.frozen === true && frozenIn.timePaused === true,
  `frozen ${frozenIn.frozen}, time.paused ${frozenIn.timePaused}`);
await page.screenshot({ path: path.join(OUT, 'pause-loadout-editor.png') });

/* 4. a real edit — move the element in hand to another slot — reaches the live
   scene and the save. A fresh warden has one unlocked element, so the chooser is
   the only path that can change anything, and it is the path the hub invented the
   "already in the rig" note for. */
const fireBefore = (before.slots ?? []).findIndex((s) => s);
await page.locator('.slot-drop').nth(2).click();
await page.waitForTimeout(280);
const chooser = page.locator('[role="dialog"][aria-label^="Choose an element for slot"]');
const chooserOpen = (await chooser.count()) === 1;
check('the slot chooser opened beside the slot', chooserOpen);
if (chooserOpen) {
  await chooser.locator('.chooser-item', { hasText: 'FIRE' }).first().click();
}
await page.waitForTimeout(340);
const afterEdit = await readState();
const fireAfter = (afterEdit.slots ?? []).findIndex((s) => s);
check('the scene loadout moved under the edit', fireAfter === 2 && fireBefore !== 2,
  `slot ${fireBefore + 1} → ${fireAfter + 1}`);
const filled = (afterEdit.slots ?? []).filter(Boolean).length;
check('the save agrees with the scene', JSON.stringify(afterEdit.stored) === JSON.stringify(afterEdit.slots),
  `stored ${JSON.stringify(afterEdit.stored)}`);
const ratioBefore = before.hp / before.maxHp;
const ratioAfter = afterEdit.hp / afterEdit.maxHp;
check('health is preserved (ratio-preserving applyStats)',
  Math.abs(ratioBefore - ratioAfter) < 0.06 && afterEdit.hp > 0,
  `hp ${before.hp}/${before.maxHp} → ${afterEdit.hp}/${afterEdit.maxHp}, ratio ${ratioBefore.toFixed(3)} → ${ratioAfter.toFixed(3)}`);
check('the aimed slot follows the element, not the index', afterEdit.activeSlot === fireAfter,
  `activeSlot ${afterEdit.activeSlot}, fire at ${fireAfter}`);
check('nothing is left in the vacated slot', (afterEdit.slots ?? [])[fireBefore] === null,
  JSON.stringify(afterEdit.slots));
check('the support rig is empty because nothing else is equipped',
  Array.isArray(afterEdit.autoSlots) && afterEdit.autoSlots.length === filled - 1,
  `auto ${JSON.stringify(afterEdit.autoSlots)} of ${filled} equipped`);

/* 5. BACK lands on the pause card, on the tab the player left */
await page.locator('button', { hasText: 'BACK' }).click();
await page.waitForTimeout(360);
card = await dialogText();
// The MENU button hides while an overlay is open (that is its own fix from §H), so
// its absence here is the proof we are back in the run with the card up — the editor
// heading being gone is the other half.
const editorClosed = (await page.locator('h1.title-xl', { hasText: 'LOADOUT' }).count()) === 0;
const menuHidden = (await page.locator('.hud-menu-btn').count()) === 0;
check('BACK returns to the paused run', card.includes('PAUSED') && editorClosed && menuHidden,
  `editor closed ${editorClosed}, MENU hidden ${menuHidden}`);
check('and to the elements tab, not the root', card.includes('EDIT LOADOUT'));

/* 6. Escape inside the editor closes the editor without un-pausing the run */
await clickIf('EDIT LOADOUT');
await page.waitForTimeout(320);
await page.keyboard.press('Escape');
await page.waitForTimeout(380);
const afterEsc = await readState();
card = await dialogText();
const editorStillOpen = await page.locator('h1.title-xl', { hasText: 'LOADOUT' }).count();
check('Escape closed the editor', editorStillOpen === 0);
check('Escape left the run paused, not running', card.includes('PAUSED') && afterEsc.frozen === true,
  `frozen ${afterEsc.frozen}, time.paused ${afterEsc.timePaused}`);

/* 7. Escape on the play screen still toggles both ways — first out of the
   elements tab, since the tab bar has no RESUME of its own. */
await clickIf('BACK');
await page.waitForTimeout(220);
await clickIf('RESUME');
await page.waitForTimeout(300);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const escPause = await readState();
const escCard = await dialogText();
check('Escape from play pauses', escCard.includes('PAUSED') && escPause.frozen === true, `frozen ${escPause.frozen}`);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const escResume = await readState();
check('and un-pauses', (await dialogText()) === '' && escResume.frozen === false, `frozen ${escResume.frozen}`);

/* 8. the zoom base survived all of that (the §H4 fault class, on the pause edges) */
check('camera zoom is at its base after four freeze edges', Math.abs(escResume.zoom - 1) < 1e-6,
  `zoom ${escResume.zoom}`);
check('no console errors', errors.length === 0, errors.slice(0, 2).join(' / '));

console.log(out.join('\n'));
const failed = out.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${out.length - failed}/${out.length} checks passed`);
await browser.close();
process.exit(failed ? 1 : 0);
