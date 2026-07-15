/** Dev probe: is the rAF loop stalling after rotate/eject/swipe? */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = 'http://127.0.0.1:5181/';
async function waitForServer(url, t = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('server down');
}

const preview = spawn('npx', ['vite', 'preview'], { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore' });
let browser;
try {
  await waitForServer(BASE);
  browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__GBA?.stateName, null, { timeout: 15000 });
  await page.evaluate(() => {
    window.__raf = 0;
    (function cnt() { window.__raf++; requestAnimationFrame(cnt); })();
  });
  const rafRate = async (label) => {
    const a = await page.evaluate(() => window.__raf);
    await sleep(1000);
    const b = await page.evaluate(() => window.__raf);
    console.log(label, `raf/s=${b - a}`, 'pouchX=', await page.evaluate(() => window.__GBA.carts.pouchGroup.position.x.toFixed(1)));
  };

  await page.evaluate(() => window.__GBA.insertById('cascade7'));
  await page.waitForFunction(() => window.__GBA.stateName() === 'PLAYING', null, { timeout: 30000 });
  await rafRate('playing-portrait');
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForFunction(() => window.__GBA.scene3d.gripMode, null, { timeout: 10000 });
  for (let i = 0; i < 4; i++) await rafRate(`post-rotate-${i}`);

  // eject
  const cart = await page.evaluate(() => window.__GBA.cartScreenPos('cascade7'));
  await page.mouse.move(cart.x, Math.max(cart.y, 2));
  await page.mouse.down();
  for (let i = 1; i <= 9; i++) { await page.mouse.move(cart.x, Math.max(cart.y, 2) - i * 10); await sleep(40); }
  await page.mouse.up();
  await page.waitForFunction(() => window.__GBA.stateName() === 'OFF', null, { timeout: 15000 });
  for (let i = 0; i < 3; i++) await rafRate(`post-eject-${i}`);

  // swipe drawer open
  await page.mouse.move(842, 200);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) { await page.mouse.move(842 - i * 24, 200); await sleep(30); }
  await page.mouse.up();
  console.log('drawerOpen:', await page.evaluate(() => window.__GBA.carts.drawerOpen));
  for (let i = 0; i < 12; i++) await rafRate(`drawer-${i}`);

  await ctx.close();
  await browser.close();
} finally {
  preview.kill('SIGTERM');
  if (browser?.isConnected()) await browser.close().catch(() => {});
}
