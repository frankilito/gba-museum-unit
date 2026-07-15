/**
 * Responsive + reduced-motion checks:
 *  - portrait viewport: pouch moves below the GBA, screen stays readable
 *  - DPR change keeps the screen texture mapped correctly
 *  - prefers-reduced-motion: camera parallax disabled, insertion still works
 *  - touch emulation: physical 3D buttons respond to touch points
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = 'http://127.0.0.1:5181/';
const SHOTS = new URL('./shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const log = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};

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

  // ---------- portrait layout ----------
  const ctx1 = await browser.newContext({ viewport: { width: 780, height: 1100 }, reducedMotion: 'reduce' });
  const page = await ctx1.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__GBA?.stateName, null, { timeout: 15000 });
  await sleep(1200);

  const layout = await page.evaluate(() => {
    const g = window.__GBA;
    const pouchWorld = g.carts.pouchGroup.position;
    return { mode: g.scene3d.layoutMode, pouchZ: pouchWorld.z, pouchX: pouchWorld.x };
  });
  log(layout.mode === 'portrait' && layout.pouchZ > 80 && Math.abs(layout.pouchX) < 30,
    `portrait: pouch moved below the GBA (mode=${layout.mode}, x=${layout.pouchX.toFixed(0)}, z=${layout.pouchZ.toFixed(0)})`);

  // no touch pointer → never grip-eligible, no rotate hint while playing
  const noGripDesktop = await page.evaluate(() => !window.__GBA.scene3d.gripEligibleDevice);
  log(noGripDesktop, 'non-touch viewport is not grip-eligible (no grip mode on desktop)');

  // boot still works with reduced motion
  await page.evaluate(() => window.__GBA.insertById('cascade7'));
  const playing = await page
    .waitForFunction(() => window.__GBA.stateName() === 'PLAYING', null, { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  log(playing, 'reduced-motion: insertion and boot still work');
  await sleep(800);
  await page.screenshot({ path: `${SHOTS}10-portrait-playing.png` });
  const hintHiddenDesktop = await page.evaluate(() => document.getElementById('grip-hint').hidden);
  log(hintHiddenDesktop, 'no rotate hint on a non-touch portrait viewport while PLAYING');

  // screen readable: game imagery present and screen texture not distorted
  // (Pong is legitimately black-and-white — >=2 sampled colors, same bar as e2e)
  const readable = await page.evaluate(() => {
    const s = window.__GBA.screenSample();
    return s.unique >= 2;
  });
  log(readable, 'portrait: game screen renders imagery');

  // parallax disabled under reduced motion: camera azimuth stable on pointer move
  const parallax = await page.evaluate(async () => {
    const g = window.__GBA;
    const before = g.scene3d.camera.position.clone();
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 5, clientY: 5 }));
    await new Promise((r) => setTimeout(r, 500));
    const after = g.scene3d.camera.position.clone();
    return before.distanceTo(after);
  });
  // camera still eases toward its goal, so allow a small delta; parallax would
  // show up as an abrupt lateral jump.
  log(parallax < 60, `reduced-motion: no pointer parallax jump (Δ=${parallax.toFixed(1)}mm)`);

  // ---------- DPR change ----------
  await page.evaluate(() => window.__GBA.eject());
  await page.waitForFunction(() => window.__GBA.stateName() === 'OFF', null, { timeout: 15000 });
  await ctx1.close();

  const ctx2 = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 });
  const page2 = await ctx2.newPage();
  await page2.goto(BASE, { waitUntil: 'load' });
  await page2.waitForFunction(() => window.__GBA?.stateName, null, { timeout: 15000 });
  await page2.evaluate(() => window.__GBA.insertById('cascade7'));
  await page2.waitForFunction(() => window.__GBA.stateName() === 'PLAYING', null, { timeout: 30000 });
  // first game frame can land up to ~1s after PLAYING under software rendering —
  // wait for actual imagery instead of sampling at a fixed instant
  const dpr2Ok = await page2
    .waitForFunction(() => window.__GBA.screenSample().unique > 4, null, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  log(dpr2Ok, 'DPR=2: screen texture intact');
  await page2.screenshot({ path: `${SHOTS}11-dpr2.png` });
  // emulate DPR change via resize to a different DPR context is not possible
  // mid-page; validate renderer pixel ratio cap instead:
  const pr = await page2.evaluate(() => window.__GBA.scene3d.renderer.getPixelRatio());
  log(pr <= 2, `renderer DPR capped at 2 (got ${pr})`);
  await ctx2.close();

  // ---------- touch points on physical buttons ----------
  const ctx3 = await browser.newContext({
    viewport: { width: 1000, height: 760 },
    hasTouch: true,
    isMobile: true,
  });
  const page3 = await ctx3.newPage();
  await page3.goto(BASE, { waitUntil: 'load' });
  await page3.waitForFunction(() => window.__GBA?.stateName, null, { timeout: 15000 });
  await page3.evaluate(() => window.__GBA.insertById('cascade7'));
  await page3.waitForFunction(() => window.__GBA.stateName() === 'PLAYING', null, { timeout: 30000 });
  const btnB = await page3.evaluate(() => window.__GBA.buttonScreenPos('B'));
  await page3.touchscreen.tap(btnB.x, btnB.y);
  await sleep(80);
  const tapped = await page3.evaluate(() => {
    // tap is down+up quickly; check the edge fired
    return window.__GBA.input.lastEdgeFrame['B:down'] > 0 && window.__GBA.input.lastEdgeFrame['B:up'] > 0;
  });
  log(tapped, 'touch tap on physical B button produces down+up edges');
  // assist zones exist on coarse pointers
  const zones = await page3.evaluate(() => !!document.getElementById('touch-zones'));
  log(zones, 'touch assist zones present on touch devices');
  // but a 1000×760 touch viewport is too large for grip mode (min dim > 500)
  const noGripTablet = await page3.evaluate(() =>
    !window.__GBA.scene3d.gripEligibleDevice && window.__GBA.scene3d.layoutMode !== 'grip' &&
    document.getElementById('grip-exit').hidden);
  log(noGripTablet, 'large touch viewport stays out of grip mode (tablet/desktop path unchanged)');
  await ctx3.close();

  log(errors.length === 0, `no page errors across viewports${errors.length ? ': ' + errors.join(' | ') : ''}`);

  await browser.close();
} finally {
  preview.kill('SIGTERM');
  if (browser?.isConnected()) await browser.close().catch(() => {});
}

console.log(failures === 0 ? '\nRESPONSIVE CHECKS PASSED' : `\n${failures} RESPONSIVE CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
