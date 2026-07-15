/**
 * Mobile landscape "grip mode" checks (iPhone-sized viewports, coarse pointer):
 *  - portrait PLAYING: a restrained rotate hint appears, dismissible
 *  - rotate to landscape: immersive grip view — device fills the width, LCD
 *    centered and much larger than the portrait layout, D-pad / A / B fully
 *    inside the viewport, pouch parked out of frame, exit chip visible
 *  - touch press on the physical A button produces down+up edges and 3D travel
 *  - upward drag on the exposed cartridge ejects → back to the normal layout
 *  - the EXIT GRIP chip leaves the immersive view without ejecting
 *  - rotating back to portrait restores the portrait layout
 *
 * Desktop viewports never resolve to 'grip' (covered by e2e/responsive runs).
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

/** Projected LCD panel height in CSS px (top vs bottom edge of the 3:2 plane). */
const LCD_HEIGHT_FN = () => {
  const g = window.__GBA;
  const lcd = g.scene3d.handheld.deviceGroup.getObjectByName('lcd');
  const top = lcd.localToWorld(lcd.position.clone().set(0, 39.33 / 2, 0));
  const bottom = lcd.localToWorld(lcd.position.clone().set(0, -39.33 / 2, 0));
  const t = g.scene3d.projectToScreen(top);
  const b = g.scene3d.projectToScreen(bottom);
  return Math.abs(b.y - t.y);
};

/** Wait until the eased camera settles (projected LCD height stops moving). */
async function waitCameraSettled(page, timeout = 30000) {
  const t0 = Date.now();
  let prev = await page.evaluate(LCD_HEIGHT_FN);
  while (Date.now() - t0 < timeout) {
    await sleep(450);
    const cur = await page.evaluate(LCD_HEIGHT_FN);
    if (Math.abs(cur - prev) < 0.75) return cur;
    prev = cur;
  }
  return prev;
}

const preview = spawn('npx', ['vite', 'preview'], { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore' });
let browser;
try {
  await waitForServer(BASE);
  browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });

  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, // iPhone 12/13/14 portrait
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__GBA?.stateName, null, { timeout: 15000 });

  const eligible = await page.evaluate(() => ({
    coarse: window.matchMedia('(pointer: coarse)').matches,
    device: window.__GBA.scene3d.gripEligibleDevice,
    layout: window.__GBA.scene3d.layoutMode,
  }));
  log(eligible.coarse && eligible.device && eligible.layout === 'portrait',
    `phone portrait: coarse pointer + grip-eligible device, layout=${eligible.layout}`);

  // ---------- portrait PLAYING: rotate hint appears ----------
  await page.evaluate(() => window.__GBA.insertById('cascade7'));
  await page.waitForFunction(() => window.__GBA.stateName() === 'PLAYING', null, { timeout: 30000 });
  await sleep(600);
  const hintShown = await page.evaluate(() => !document.getElementById('grip-hint').hidden);
  log(hintShown, 'portrait PLAYING: rotate-to-landscape hint shown');
  await page.screenshot({ path: `${SHOTS}12-mobile-portrait-hint.png` });

  // dismiss it — stays hidden for the session
  await page.click('#grip-hint-close');
  const hintGone = await page.evaluate(() => document.getElementById('grip-hint').hidden);
  log(hintGone, 'hint is dismissible (close button)');

  const lcdPortrait = await waitCameraSettled(page);

  // ---------- rotate to landscape: immersive grip view ----------
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForFunction(() => window.__GBA.scene3d.layoutMode === 'grip' && window.__GBA.scene3d.gripMode, null, { timeout: 10000 });
  const lcdGrip = await waitCameraSettled(page);

  const gripState = await page.evaluate(() => ({
    layout: window.__GBA.scene3d.layoutMode,
    grip: window.__GBA.scene3d.gripMode,
    pouchY: window.__GBA.carts.pouchGroup.position.y,
    chipVisible: !document.getElementById('grip-exit').hidden,
    hintHidden: document.getElementById('grip-hint').hidden,
  }));
  log(gripState.layout === 'grip' && gripState.grip, 'landscape PLAYING: grip layout active');
  log(gripState.pouchY < -100, `grip: cartridge pouch parked out of frame (y=${gripState.pouchY.toFixed(0)})`);
  log(gripState.chipVisible, 'grip: EXIT GRIP chip visible');
  log(gripState.hintHidden, 'grip: rotate hint stays hidden in landscape');

  const zonesParked = await page.evaluate(
    () => document.getElementById('touch-zones')?.classList.contains('grip-hidden') ?? true,
  );
  log(zonesParked, 'grip: touch assist zones park while playing on the 3D buttons');

  log(lcdGrip >= lcdPortrait * 1.5,
    `grip: LCD much larger than portrait layout (${lcdPortrait.toFixed(0)}px → ${lcdGrip.toFixed(0)}px, ×${(lcdGrip / lcdPortrait).toFixed(2)})`);

  // D-pad / A / B fully inside the viewport (thumb zones, nothing cropped)
  const btns = await page.evaluate(() => ({
    dpad: window.__GBA.buttonScreenPos('DPAD'),
    a: window.__GBA.buttonScreenPos('A'),
    b: window.__GBA.buttonScreenPos('B'),
  }));
  const inView = (p) => p && p.x >= 8 && p.x <= 836 && p.y >= 8 && p.y <= 382;
  log(inView(btns.dpad) && inView(btns.a) && inView(btns.b),
    `grip: D-pad/A/B fully in viewport (D=${btns.dpad.x.toFixed(0)},${btns.dpad.y.toFixed(0)} A=${btns.a.x.toFixed(0)},${btns.a.y.toFixed(0)} B=${btns.b.x.toFixed(0)},${btns.b.y.toFixed(0)})`);
  // thumb zones: D-pad on the left half, A/B on the right half
  log(btns.dpad.x < 844 / 2 && btns.a.x > 844 / 2 && btns.b.x > 844 / 2,
    'grip: D-pad left thumb zone, A/B right thumb zone');

  // screen texture still crisp: nearest filtering + real game imagery
  const crisp = await page.evaluate(() => {
    const mat = window.__GBA.scene3d.handheld.screenMaterial;
    return mat.map.magFilter === 1003 /* NearestFilter */ && window.__GBA.screenSample().unique >= 2;
  });
  log(crisp, 'grip: screen texture stays NearestFilter with live game imagery');
  await page.screenshot({ path: `${SHOTS}13-mobile-landscape-grip.png` });

  // ---------- touch press on the physical A button ----------
  await page.touchscreen.tap(btns.a.x, btns.a.y);
  await sleep(120);
  const tapEdges = await page.evaluate(() => {
    const f = window.__GBA.input.lastEdgeFrame;
    return f['A:down'] > 0 && f['A:up'] >= f['A:down'];
  });
  log(tapEdges, 'grip: touch tap on physical A produces down+up edges');

  // held press shows 3D travel feedback (mouse gives a holdable real pointer)
  await page.mouse.move(btns.a.x, btns.a.y);
  await page.mouse.down();
  const held = await page
    .waitForFunction(() => window.__GBA.scene3d.handheld.getButtonTravel().A > 0.1, null, { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  log(held, 'grip: held press on A shows 3D button travel');
  await page.mouse.up();

  // ---------- upward drag on the exposed cart ejects → normal layout ----------
  const cartPos = await page.evaluate(() => window.__GBA.cartScreenPos('cascade7'));
  await page.mouse.move(cartPos.x, cartPos.y);
  await page.mouse.down();
  for (let i = 1; i <= 9; i++) {
    await page.mouse.move(cartPos.x, cartPos.y - i * 10);
    await sleep(40);
  }
  await page.mouse.up();
  const ejected = await page
    .waitForFunction(() => window.__GBA.stateName() === 'OFF', null, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  log(ejected, 'grip: upward drag on the exposed cartridge ejects (→ OFF)');

  await waitCameraSettled(page);
  const afterEject = await page.evaluate(() => ({
    grip: window.__GBA.scene3d.gripMode,
    layout: window.__GBA.scene3d.layoutMode,
    pouchX: window.__GBA.carts.pouchGroup.position.x,
    chipHidden: document.getElementById('grip-exit').hidden,
    zonesBack: !document.getElementById('touch-zones')?.classList.contains('grip-hidden'),
  }));
  log(!afterEject.grip && Math.abs(afterEject.pouchX - 160) < 8 && afterEject.chipHidden && afterEject.zonesBack,
    `grip: eject returns to the normal layout (pouch x=${afterEject.pouchX.toFixed(0)}, chip hidden, zones back)`);

  // ---------- EXIT GRIP chip: leave the immersive view without ejecting ----------
  await page.evaluate(() => window.__GBA.insertById('cascade7'));
  await page.waitForFunction(() => window.__GBA.stateName() === 'PLAYING' && window.__GBA.scene3d.gripMode, null, { timeout: 30000 });
  await waitCameraSettled(page);
  await page.click('#grip-exit');
  await sleep(300);
  const exited = await page.evaluate(() => ({
    grip: window.__GBA.scene3d.gripMode,
    chipHidden: document.getElementById('grip-exit').hidden,
    state: window.__GBA.stateName(),
    pouchX: window.__GBA.carts.pouchGroup.position.x,
  }));
  log(!exited.grip && exited.chipHidden && exited.state === 'PLAYING' && Math.abs(exited.pouchX - 160) < 8,
    'grip: EXIT GRIP chip leaves the immersive view, game keeps running');
  const lcdAfterExit = await waitCameraSettled(page);
  log(lcdAfterExit < lcdGrip * 0.75,
    `grip: after exit the framing returns to the normal landscape play view (LCD ${lcdAfterExit.toFixed(0)}px)`);

  // ---------- rotate back to portrait ----------
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => window.__GBA.scene3d.layoutMode === 'portrait', null, { timeout: 10000 });
  const backPortrait = await page.evaluate(() => window.__GBA.scene3d.layoutMode);
  log(backPortrait === 'portrait', 'rotate back: portrait layout restored');

  log(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);

  await ctx.close();
  await browser.close();
} finally {
  preview.kill('SIGTERM');
  if (browser?.isConnected()) await browser.close().catch(() => {});
}

console.log(failures === 0 ? '\nMOBILE GRIP CHECKS PASSED' : `\n${failures} MOBILE GRIP CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
