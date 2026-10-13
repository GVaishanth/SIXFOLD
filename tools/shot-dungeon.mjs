#!/usr/bin/env node
/*
 * What the dungeon actually looks like, in a browser, at the size the game runs.
 *
 * `derive:cortex` renders a plan and `audit:cortex` measures a data file, and both can be true while the
 * player walks a strip — that is precisely the fault this project was asked to fix ("the dungeon still looks
 * like a strip"). So this script starts the game, enters a run, holds a key for a second, and writes
 * `audit/cortex/in-game.png` next to a JSON of what the scene reported about itself. It is deliberately not a
 * gate: nothing here passes or fails, it is the picture and the numbers a human judges.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.SIXFOLD_URL ?? 'http://127.0.0.1:5173/';
const OUT = process.argv[2] ?? path.resolve(import.meta.dirname, '..', '..', 'audit', 'cortex');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clickText = async (label) => {
  const btn = page.locator(`button:has-text("${label}")`);
  if (await btn.count()) await btn.first().click({ timeout: 4000 }).catch(() => undefined);
  await sleep(400);
};
await page.goto(BASE, { waitUntil: 'load' });
await sleep(1000);
if (await page.locator('text=NEW WARDEN').count()) {
  await clickText('NEW WARDEN');
  const plinth = page.locator('.slot-plinth:has-text("RAISE A WARDEN")');
  if (await plinth.count()) await plinth.first().click().catch(() => undefined);
  await sleep(300);
  await clickText('BIND AND BEGIN');
  await clickText('CREATE WARDEN');
}
await page
  .waitForFunction(() => Array.from(document.querySelectorAll('button')).some((b) => /WALK THE STRIP/.test(b.textContent || '')), null, { timeout: 15000 })
  .catch(() => undefined);
await clickText('WALK THE STRIP');
await sleep(2400);
await page.waitForSelector('canvas', { timeout: 15000 });
await sleep(2600);

const scene = await page.evaluate(() => {
  const game = window.__sixfoldGame ?? window.game;
  const scene = game?.scene?.getScene('DungeonScene');
  if (!scene) return { error: 'no dungeon scene', keys: Object.keys(game?.scene?.keys ?? {}) };
  const plan = scene.plan;
  return {
    width: plan.width,
    height: plan.height,
    cellWidth: plan.cellWidth,
    cells: plan.chunkCount,
    walls: plan.walls?.length ?? 0,
    spawn: plan.spawn ?? null,
    route: plan.route?.length ?? 0,
    sites: plan.cells.reduce((n, c) => n + c.sites.length, 0),
    player: scene.player ? { x: Math.round(scene.player.x), y: Math.round(scene.player.y) } : null,
    layer: plan.layerAt && scene.player ? plan.layerAt(scene.player.x, scene.player.y) : -1,
    camera: {
      x: Math.round(scene.cameras.main.scrollX),
      y: Math.round(scene.cameras.main.scrollY),
      zoom: scene.cameras.main.zoom,
      bounds: scene.cameras.main._bounds
        ? { x: Math.round(scene.cameras.main._bounds.x), w: Math.round(scene.cameras.main._bounds.width) }
        : null,
    },
  };
});
fs.writeFileSync(path.join(OUT, 'in-game.json'), `${JSON.stringify(scene, null, 2)}\n`);
await page.screenshot({ path: path.join(OUT, 'in-game.png') });

// Then walk: hold right for a second, then up, so the picture shows the map rather than the spawn tile.
await page.keyboard.down('ArrowRight');
await sleep(1100);
await page.keyboard.up('ArrowRight');
await page.keyboard.down('ArrowUp');
await sleep(900);
await page.keyboard.up('ArrowUp');
await sleep(500);
const moved = await page.evaluate(() => {
  const game = window.__sixfoldGame ?? window.game;
  const scene = game?.scene?.getScene('DungeonScene');
  const plan = scene?.plan;
  return scene?.player
    ? {
        x: Math.round(scene.player.x),
        y: Math.round(scene.player.y),
        layer: plan?.layerAt ? plan.layerAt(scene.player.x, scene.player.y) : -1,
      }
    : null;
});
fs.writeFileSync(path.join(OUT, 'in-game-after-walk.json'), `${JSON.stringify({ ...scene, moved }, null, 2)}\n`);
await page.screenshot({ path: path.join(OUT, 'in-game-walking.png') });

// And the whole organ, zoomed out, so the silhouette can be judged as a shape.
await page.evaluate(() => {
  const game = window.__sixfoldGame ?? window.game;
  const s = game?.scene?.getScene('DungeonScene');
  if (!s) return;
  s.cameras.main.setBounds(0, 0, s.plan.width, s.plan.height);
  s.cameras.main.centerOn(s.plan.width / 2, s.plan.height / 2);
  s.cameras.main.setZoom(Math.min(1280 / s.plan.width, 800 / s.plan.height) * 0.92);
});
await sleep(600);
await page.screenshot({ path: path.join(OUT, 'in-game-overview.png') });

console.log(JSON.stringify({ scene, moved, consoleErrors: errors.slice(0, 5) }, null, 2));
await browser.close();
