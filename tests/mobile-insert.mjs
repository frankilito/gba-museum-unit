/**
 * Mobile portrait drag-insert via CDP touch simulation (iPhone 13 context):
 * the portrait layout parks the pouch ~130mm in front of the slot (z≈134 vs
 * slot z≈−5.8), so a screen-space drag used to never enter the 3D snap
 * radius and every insert attempt bounced back. The depth assist in
 * CartridgeManager.dragMove must make the magnetic snap — and with it the
 * 20mm world insert threshold — physically reachable from a touch drag.
 *
 * Checks:
 *  - portrait layout, pouch parked in front of the slot (the depth gap)
 *  - CDP touch drag on cascade7 toward the slot projection engages the
 *    magnetic snap (cart world position within 20mm of the approach pose)
 *  - release → OFF → INSERTING → BOOTING → PLAYING in that exact order
 *  - a wrong-spot touch drop still springs back home without booting
 *  - no page errors
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

/** Wait until the eased camera settles (a projection stops moving). */
async function waitCameraSettled(page, timeout = 30000) {
  const t0 = Date.now();
  let prev = await page.evaluate(() => window.__GBA.cartScreenPos('cascade7'));
  while (Date.now() - t0 < timeout) {
    await sleep(450);
    const cur = await page.evaluate(() => window.__GBA.cartScreenPos('cascade7'));
    if (Math.hypot(cur.x - prev.x, cur.y - prev.y) < 0.75) return cur;
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
    viewport: { width: 390, height: 844 }, // iPhone 13 portrait
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__GBA?.stateName, null, { timeout: 15000 });

  const layout = await page.evaluate(() => ({
    mode: window.__GBA.scene3d.layoutMode,
    pouchZ: window.__GBA.carts.pouchGroup.position.z,
    state: window.__GBA.stateName(),
  }));
  log(layout.mode === 'portrait' && layout.state === 'OFF',
    `iPhone portrait: layout=${layout.mode}, state=${layout.state}`);
  log(layout.pouchZ > 100,
    `portrait: pouch parked in front of the slot (z=${layout.pouchZ.toFixed(0)} — the depth gap)`);

  // CDP touch injection — raw Input.dispatchTouchEvent, one finger.
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, x, y) =>
    cdp.send('Input.dispatchTouchEvent',
      type === 'touchEnd' ? { type, touchPoints: [] } : { type, touchPoints: [{ x, y, id: 1 }] });

  // record every FSM transition from here on
  await page.evaluate(() => {
    window.__SEQ = [];
    window.__GBA.fsm.onChange((to) => window.__SEQ.push(to));
  });

  // the camera eases into the portrait hero pose after load — wait for it,
  // otherwise a touch aimed at a stale projection misses the cart
  await waitCameraSettled(page);

  // ---------- wrong-spot touch drop springs back, no boot ----------
  const home0 = await page.evaluate(() => window.__GBA.cartScreenPos('cascade7'));
  await touch('touchStart', home0.x, home0.y);
  await page.waitForFunction(() => window.__GBA.carts.isDragging, null, { timeout: 8000 });
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', home0.x - i * 12, home0.y + i * 14); // down-left, away from the slot
    await sleep(40);
  }
  await touch('touchEnd');
  await sleep(1000);
  const wrong = await page.evaluate(() => ({
    state: window.__GBA.stateName(),
    back: window.__GBA.cartScreenPos('cascade7'),
  }));
  const wrongDelta = Math.hypot(wrong.back.x - home0.x, wrong.back.y - home0.y);
  log(wrong.state === 'OFF' && wrongDelta < 30,
    `portrait: wrong-spot touch drop springs back (Δ=${wrongDelta.toFixed(0)}px), no boot`);

  // ---------- real touch drag into the slot ----------
  const home = await page.evaluate(() => window.__GBA.cartScreenPos('cascade7'));
  await touch('touchStart', home.x, home.y);
  await page.waitForFunction(() => window.__GBA.carts.isDragging, null, { timeout: 8000 });

  let slot = await page.evaluate(() => window.__GBA.slotScreenPos());
  for (let i = 1; i <= 16; i++) {
    await touch('touchMove', home.x + ((slot.x - home.x) * i) / 16, home.y + ((slot.y - home.y) * i) / 16);
    await sleep(40);
  }
  await sleep(600); // camera push-in settles → projection shifts → re-aim
  slot = await page.evaluate(() => window.__GBA.slotScreenPos());
  const cur = await page.evaluate(() => window.__GBA.cartScreenPos('cascade7'));
  for (let i = 1; i <= 8; i++) {
    await touch('touchMove', cur.x + ((slot.x - cur.x) * i) / 8, cur.y + ((slot.y - cur.y) * i) / 8);
    await sleep(40);
  }
  await sleep(200);

  // magnetic snap: cart world position within the insert reach of the approach pose
  const snapDist = await page.evaluate(() => window.__GBA.cartDistToSlot('cascade7'));
  log(snapDist !== null && snapDist < 20,
    `portrait touch drag: magnetic snap engaged (cart ${snapDist?.toFixed(1)}mm from the approach pose)`);

  await touch('touchEnd');
  const booted = await page
    .waitForFunction(() => window.__GBA.stateName() === 'PLAYING', null, { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  const seq = await page.evaluate(() => window.__SEQ.join('>'));
  log(booted, `portrait touch drag: release into the snap zone boots the ROM (${seq || 'no transitions'})`);
  const seqArr = seq ? seq.split('>') : [];
  const order = ['INSERTING', 'BOOTING', 'PLAYING'];
  const idx = order.map((s) => seqArr.indexOf(s));
  log(idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1])),
    `state path INSERTING→BOOTING→PLAYING observed in order (${seq})`);
  await page.screenshot({ path: `${SHOTS}14-mobile-portrait-touch-insert.png` });

  log(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);

  await ctx.close();
  await browser.close();
} finally {
  preview.kill('SIGTERM');
  if (browser?.isConnected()) await browser.close().catch(() => {});
}

console.log(failures === 0 ? '\nMOBILE INSERT CHECKS PASSED' : `\n${failures} MOBILE INSERT CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
