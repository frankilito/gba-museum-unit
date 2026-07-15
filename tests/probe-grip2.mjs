/** Dev probe: dump grip framing projections (not a registered check). */
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

const LCD_HEIGHT_FN = () => {
  const g = window.__GBA;
  const lcd = g.scene3d.handheld.deviceGroup.getObjectByName('lcd');
  const top = lcd.localToWorld(lcd.position.clone().set(0, 39.33 / 2, 0));
  const bottom = lcd.localToWorld(lcd.position.clone().set(0, -39.33 / 2, 0));
  const t = g.scene3d.projectToScreen(top);
  const b = g.scene3d.projectToScreen(bottom);
  return Math.abs(b.y - t.y);
};

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
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__GBA?.stateName, null, { timeout: 15000 });

  // insert in portrait, watch the cinematic
  await page.evaluate(() => window.__GBA.insertById('cascade7'));
  await sleep(300);
  const cine = await page.evaluate(() => ({
    active: window.__GBA.scene3d.gripCineActive,
    roll: window.__GBA.scene3d.gripCineRoll,
    done: window.__GBA.scene3d.gripCineDone,
    session: window.__GBA.scene3d.gripSessionActive,
  }));
  console.log('cinematic after insert:', JSON.stringify(cine));
  await page.waitForFunction(() => window.__GBA.stateName() === 'PLAYING', null, { timeout: 30000 });
  const lcdPortrait = await waitCameraSettled(page);
  console.log('lcdPortrait', lcdPortrait.toFixed(1));

  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForFunction(() => window.__GBA.scene3d.gripMode, null, { timeout: 10000 });
  await page.evaluate(() => window.__GBA.scene3d.refit()); // snap the rig — deterministic geometry under SwiftShader
  await sleep(200);
  const lcdGrip = await page.evaluate(LCD_HEIGHT_FN);
  console.log('lcdGrip', lcdGrip.toFixed(1), 'x' + (lcdGrip / lcdPortrait).toFixed(2));

  const dump = await page.evaluate(() => ({
    bounds: window.__GBA.deviceScreenBounds(),
    dpad: window.__GBA.buttonScreenPos('DPAD'),
    a: window.__GBA.buttonScreenPos('A'),
    b: window.__GBA.buttonScreenPos('B'),
    start: window.__GBA.buttonScreenPos('START'),
    select: window.__GBA.buttonScreenPos('SELECT'),
    l: window.__GBA.buttonScreenPos('L'),
    r: window.__GBA.buttonScreenPos('R'),
    cart: window.__GBA.cartScreenPos('cascade7'),
    slot: window.__GBA.slotScreenPos(),
    pouch: (() => { const p = window.__GBA.carts.pouchGroup.position; return { x: p.x, y: p.y, z: p.z }; })(),
    cineRoll: window.__GBA.scene3d.gripCineRoll,
    cineActive: window.__GBA.scene3d.gripCineActive,
  }));
  console.log(JSON.stringify(dump, null, 1));

  // eject (mouse up-drag), stay in grip, then open the drawer
  await page.mouse.move(dump.cart.x, Math.max(dump.cart.y, 2));
  await page.mouse.down();
  for (let i = 1; i <= 9; i++) {
    await page.mouse.move(dump.cart.x, Math.max(dump.cart.y, 2) - i * 10);
    await sleep(40);
  }
  await page.mouse.up();
  await page.waitForFunction(() => window.__GBA.stateName() === 'OFF', null, { timeout: 15000 });
  const postEject = await page.evaluate(() => ({
    state: window.__GBA.stateName(),
    grip: window.__GBA.scene3d.gripMode,
    pouchX: window.__GBA.carts.pouchGroup.position.x,
  }));
  console.log('postEject:', JSON.stringify(postEject));

  // edge swipe → drawer
  await page.mouse.move(842, 200);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(842 - i * 24, 200);
    await sleep(30);
  }
  await page.mouse.up();
  await sleep(200);
  const drawer = await page.evaluate(() => ({
    open: window.__GBA.carts.drawerOpen,
    pouchX: window.__GBA.carts.pouchGroup.position.x,
    slot: window.__GBA.slotScreenPos(),
    cart: window.__GBA.cartScreenPos('cascade7'),
  }));
  console.log('drawer after swipe:', JSON.stringify(drawer));
  await page.waitForFunction(() => window.__GBA.carts.pouchGroup.position.x < 6, null, { timeout: 20000 }).catch(() => console.log('POUCH SLIDE TIMEOUT'));
  await page.evaluate(() => window.__GBA.scene3d.refit()); // snap the drawer-open camera nudge
  await sleep(200);
  const drawer2 = await page.evaluate(() => ({
    pouchX: window.__GBA.carts.pouchGroup.position.x,
    slot: window.__GBA.slotScreenPos(),
    cartC7: window.__GBA.cartScreenPos('cascade7'),
    cartGB: window.__GBA.cartScreenPos('gbarcade'),
    cartU1: window.__GBA.cartScreenPos('upload-1'),
  }));
  console.log('drawer settled:', JSON.stringify(drawer2));

  // ---------- CDP touch drag from the drawer into the top slot ----------
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, x, y) =>
    cdp.send('Input.dispatchTouchEvent',
      type === 'touchEnd' ? { type, touchPoints: [] } : { type, touchPoints: [{ x, y, id: 1 }] });
  const home = await page.evaluate(() => window.__GBA.cartScreenPos('cascade7'));
  console.log('drag from', JSON.stringify(home));
  await touch('touchStart', home.x, home.y);
  await page.waitForFunction(() => window.__GBA.carts.isDragging, null, { timeout: 8000 });
  const aim = await page.evaluate(() => {
    const s = window.__GBA.slotScreenPos();
    return { x: Math.min(Math.max(s.x, 20), 824), y: 2 };
  });
  for (let i = 1; i <= 16; i++) {
    await touch('touchMove', home.x + ((aim.x - home.x) * i) / 16, home.y + ((aim.y - home.y) * i) / 16);
    await sleep(40);
  }
  // hold at the top edge and keep nudging so the snap can contract
  for (let i = 0; i < 14; i++) {
    await touch('touchMove', aim.x + (i % 2 === 0 ? 3 : -3), 2);
    await sleep(40);
  }
  const snapDist = await page.evaluate(() => window.__GBA.cartDistToSlot('cascade7'));
  console.log('snapDist after drawer drag:', snapDist?.toFixed(1));
  await touch('touchEnd');
  const booted = await page
    .waitForFunction(() => window.__GBA.stateName() === 'PLAYING', null, { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  console.log('grip drag-insert booted:', booted);
  const postInsert = await page.evaluate(() => ({
    grip: window.__GBA.scene3d.gripMode,
    drawerOpen: window.__GBA.carts.drawerOpen,
    cineActive: window.__GBA.scene3d.gripCineActive,
    pouchX: window.__GBA.carts.pouchGroup.position.x,
  }));
  console.log('postInsert:', JSON.stringify(postInsert));

  await ctx.close();
  await browser.close();
} finally {
  preview.kill('SIGTERM');
  if (browser?.isConnected()) await browser.close().catch(() => {});
}
