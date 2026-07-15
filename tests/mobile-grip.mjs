/**
 * Mobile landscape "grip mode" v2 checks (iPhone-sized viewports, coarse pointer):
 *
 *  - insert on a phone starts the grip session immediately: zoom + 90°-roll
 *    cinematic (assertable via gripCineActive/gripCineRoll), once per session
 *  - the grip framing is full-bleed: device projection covers viewport width
 *    ≥98% and height ≥100% (no background paper), D-pad/A/B stay inside the
 *    thumb zones, LCD much larger than the portrait layout
 *  - pouch parks off the right screen edge; a leftward edge swipe slides it
 *    in as a cart drawer (camera nudges the slot to the top screen edge);
 *    a rightward swipe slides it back out
 *  - cart swap never leaves grip: eject keeps the framing, drawer drag into
 *    the top slot boots the next ROM (magnetic snap reachable), drawer
 *    auto-closes on insert, no second cinematic
 *  - upward drag (56 CSS px) on the exposed cartridge ejects; EXIT GRIP chip
 *    leaves the immersive view; rotation cycle re-immerses
 *  - prefers-reduced-motion skips the cinematic entirely (no roll, direct)
 *
 * Desktop viewports never resolve to 'grip' and never start a session
 * (covered by e2e/responsive runs).
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

const preview = spawn('npx', ['vite', 'preview'], { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore' });
let browser;

/** Wait for n animation frames (camera goals refresh once per frame; refit() snaps to them). */
const waitFrames = (page, n = 3) =>
  page.evaluate(
    (count) =>
      new Promise((resolve) => {
        let c = 0;
        const tick = () => {
          c += 1;
          if (c >= count) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    n,
  );

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

  // ---------- insert triggers the transition cinematic immediately ----------
  await page.evaluate(() => window.__GBA.insertById('cascade7'));
  await sleep(350);
  const cine0 = await page.evaluate(() => ({
    active: window.__GBA.scene3d.gripCineActive,
    roll: window.__GBA.scene3d.gripCineRoll,
    done: window.__GBA.scene3d.gripCineDone,
    session: window.__GBA.scene3d.gripSessionActive,
  }));
  log(cine0.session, 'insert on a phone starts the grip session at INSERTING');
  log(cine0.active && cine0.roll > 0.5,
    `cinematic playing right after insert: camera rolling about the view axis (roll=${(cine0.roll * 180 / Math.PI).toFixed(0)}°)`);
  await page.screenshot({ path: `${SHOTS}15-grip-cinematic.png` });

  await page.waitForFunction(() => window.__GBA.stateName() === 'PLAYING', null, { timeout: 30000 });
  const cineEnd = await page
    .waitForFunction(() => !window.__GBA.scene3d.gripCineActive && window.__GBA.scene3d.gripCineRoll === 0, null, { timeout: 20000 })
    .then(() => true).catch(() => false);
  log(cineEnd && cine0.done, 'cinematic completes (roll eases back to 0°, marked done = plays once)');

  // ---------- portrait PLAYING: rotate hint appears, dismissible ----------
  await sleep(400);
  const hintShown = await page.evaluate(() => !document.getElementById('grip-hint').hidden);
  log(hintShown, 'portrait PLAYING: rotate-to-landscape hint shown (orientation lock fallback)');
  await page.screenshot({ path: `${SHOTS}12-mobile-portrait-hint.png` });
  await page.click('#grip-hint-close');
  const hintGone = await page.evaluate(() => document.getElementById('grip-hint').hidden);
  log(hintGone, 'hint is dismissible (close button)');

  await waitFrames(page);
  await page.evaluate(() => window.__GBA.scene3d.refit());
  const lcdPortrait = await page.evaluate(LCD_HEIGHT_FN);

  // ---------- rotate to landscape: full-bleed grip view ----------
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForFunction(() => window.__GBA.scene3d.layoutMode === 'grip' && window.__GBA.scene3d.gripMode, null, { timeout: 10000 });
  await waitFrames(page);
  await page.evaluate(() => window.__GBA.scene3d.refit()); // snap the rig: deterministic geometry under SwiftShader
  await sleep(200);
  const lcdGrip = await page.evaluate(LCD_HEIGHT_FN);

  const gripState = await page.evaluate(() => ({
    layout: window.__GBA.scene3d.layoutMode,
    grip: window.__GBA.scene3d.gripMode,
    cineActive: window.__GBA.scene3d.gripCineActive,
    cineDone: window.__GBA.scene3d.gripCineDone,
    pouchX: window.__GBA.carts.pouchGroup.position.x,
    homeCartX: window.__GBA.cartScreenPos('gbarcade').x,
    chipVisible: !document.getElementById('grip-exit').hidden,
    hintHidden: document.getElementById('grip-hint').hidden,
  }));
  log(gripState.layout === 'grip' && gripState.grip, 'landscape PLAYING: grip layout active');
  log(!gripState.cineActive && gripState.cineDone, 'grip entry after rotation does NOT replay the cinematic');
  log(gripState.pouchX > 120 && gripState.homeCartX > 844,
    `grip: pouch parked off the right screen edge (pouch x=${gripState.pouchX.toFixed(0)}, home cart at screen x=${gripState.homeCartX.toFixed(0)})`);
  log(gripState.chipVisible, 'grip: EXIT GRIP chip visible');
  log(gripState.hintHidden, 'grip: rotate hint stays hidden in landscape');

  const zonesParked = await page.evaluate(
    () => document.getElementById('touch-zones')?.classList.contains('grip-hidden') ?? true,
  );
  log(zonesParked, 'grip: touch assist zones park while playing on the 3D buttons');

  // full-bleed: device projection covers the viewport on both axes
  const bounds = await page.evaluate(() => window.__GBA.deviceScreenBounds());
  const coverW = (bounds.maxX - bounds.minX) / 844;
  const coverH = (bounds.maxY - bounds.minY) / 390;
  log(bounds.minX <= 8.44 && bounds.maxX >= 835.6 && coverW >= 0.98,
    `grip full-bleed: device projection covers ≥98% of viewport width (${(coverW * 100).toFixed(0)}%, edges ${bounds.minX.toFixed(0)}..${bounds.maxX.toFixed(0)} of 844)`);
  log(bounds.minY <= 0 && bounds.maxY >= 390 && coverH >= 1.0,
    `grip full-bleed: device projection covers ≥100% of viewport height (${(coverH * 100).toFixed(0)}%, edges ${bounds.minY.toFixed(0)}..${bounds.maxY.toFixed(0)} of 390 — no background paper)`);

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
  log(btns.dpad.x < 844 / 2 && btns.a.x > 844 / 2 && btns.b.x > 844 / 2,
    'grip: D-pad left thumb zone, A/B right thumb zone');

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

  await page.mouse.move(btns.a.x, btns.a.y);
  await page.mouse.down();
  const held = await page
    .waitForFunction(() => window.__GBA.scene3d.handheld.getButtonTravel().A > 0.1, null, { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  log(held, 'grip: held press on A shows 3D button travel');
  await page.mouse.up();

  // ---------- upward drag on the exposed cart ejects — and STAYS in grip ----------
  const cartPos = await page.evaluate(() => window.__GBA.cartScreenPos('cascade7'));
  const grabY = Math.min(Math.max(cartPos.y, 2), 20);
  await page.mouse.move(cartPos.x, grabY);
  await page.mouse.down();
  for (let i = 1; i <= 9; i++) {
    await page.mouse.move(cartPos.x, grabY - i * 10);
    await sleep(40);
  }
  await page.mouse.up();
  const ejected = await page
    .waitForFunction(() => window.__GBA.stateName() === 'OFF', null, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  log(ejected, 'grip: upward drag on the exposed cartridge ejects (→ OFF)');

  const afterEject = await page.evaluate(() => ({
    grip: window.__GBA.scene3d.gripMode,
    pouchX: window.__GBA.carts.pouchGroup.position.x,
    chipVisible: !document.getElementById('grip-exit').hidden,
    zonesHidden: document.getElementById('touch-zones')?.classList.contains('grip-hidden') ?? false,
  }));
  log(afterEject.grip && afterEject.pouchX > 120 && afterEject.chipVisible && afterEject.zonesHidden,
    'grip: eject STAYS in the immersive grip view (cart swap never leaves grip)');

  // ---------- right-edge swipe summons the cart drawer ----------
  const swipe = async (fromX, toX, y = 200) => {
    await page.mouse.move(fromX, y);
    await page.mouse.down();
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(fromX + ((toX - fromX) * i) / steps, y);
      await sleep(30);
    }
    await page.mouse.up();
  };
  await swipe(842, 698); // leftward from the right edge
  await sleep(200);
  const drawerOpened = await page.evaluate(() => window.__GBA.carts.drawerOpen);
  log(drawerOpened, 'grip: leftward swipe from the right edge summons the cart drawer');
  await page.waitForFunction(() => window.__GBA.carts.pouchGroup.position.x < 6, null, { timeout: 25000 });
  await waitFrames(page);
  await page.evaluate(() => window.__GBA.scene3d.refit()); // snap the drawer-open camera nudge
  await sleep(200);
  const drawerState = await page.evaluate(() => ({
    slot: window.__GBA.slotScreenPos(),
    cart: window.__GBA.cartScreenPos('cascade7'),
    open: window.__GBA.carts.drawerOpen,
  }));
  log(drawerState.slot.y > -90 && drawerState.slot.y < 60,
    `grip drawer: camera nudge brings the slot projection to the top screen edge (y=${drawerState.slot.y.toFixed(0)})`);
  log(drawerState.cart.x > 8 && drawerState.cart.x < 836 && drawerState.cart.y > 8 && drawerState.cart.y < 382,
    `grip drawer: pouch carts grabbable on screen (cascade7 at ${drawerState.cart.x.toFixed(0)},${drawerState.cart.y.toFixed(0)})`);
  await page.screenshot({ path: `${SHOTS}16-grip-pouch-swipe.png` });

  // a rightward swipe slides the drawer back out. It must start on space
  // where nothing is claimable — a drag beginning ON a cart moves the cart
  // instead (that is the swap gesture). Find a free point by raycast probing.
  const freePt = await page.evaluate(() => {
    const g = window.__GBA;
    for (let y = 16; y < 380; y += 16) {
      for (let x = 16; x < 500; x += 16) {
        const ndc = g.scene3d.ndcFromClient(x, y);
        if (g.carts.pickCart(ndc)) continue;
        if (g.scene3d.raycast(ndc, g.scene3d.handheld.buttonHitMeshes).length > 0) continue;
        return { x, y };
      }
    }
    return null;
  });
  log(freePt !== null, `grip drawer: found cart-free space for the dismiss swipe (${freePt?.x},${freePt?.y})`);
  await swipe(freePt.x, freePt.x + 240, freePt.y);
  await sleep(200);
  const drawerClosed = await page.evaluate(() => !window.__GBA.carts.drawerOpen);
  log(drawerClosed, 'grip: rightward swipe slides the drawer back out');
  // … and a second leftward swipe brings it back for the swap
  await swipe(842, 698);
  await page.waitForFunction(() => window.__GBA.carts.drawerOpen, null, { timeout: 8000 });
  await page.waitForFunction(() => window.__GBA.carts.pouchGroup.position.x < 6, null, { timeout: 25000 });
  await waitFrames(page);
  await page.evaluate(() => window.__GBA.scene3d.refit());
  await sleep(200);

  // ---------- CDP touch drag from the drawer into the top slot (stays in grip) ----------
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, x, y) =>
    cdp.send('Input.dispatchTouchEvent',
      type === 'touchEnd' ? { type, touchPoints: [] } : { type, touchPoints: [{ x, y, id: 1 }] });

  // wait for the cart projection to stop moving (slide-in / return tweens)
  let home = await page.evaluate(() => window.__GBA.cartScreenPos('cascade7'));
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const p = await page.evaluate(() => window.__GBA.cartScreenPos('cascade7'));
    if (Math.hypot(p.x - home.x, p.y - home.y) < 3) { home = p; break; }
    home = p;
  }
  await touch('touchStart', home.x, home.y);
  await page.waitForFunction(() => window.__GBA.carts.isDragging, null, { timeout: 8000 });
  const aimTop = async () => {
    const s = await page.evaluate(() => window.__GBA.slotScreenPos());
    return { x: Math.min(Math.max(s.x, 20), 824), y: 2 };
  };
  let aim = await aimTop();
  for (let i = 1; i <= 16; i++) {
    await touch('touchMove', home.x + ((aim.x - home.x) * i) / 16, home.y + ((aim.y - home.y) * i) / 16);
    await sleep(40);
  }
  await sleep(500); // camera push-in (drag focus) settles → re-aim like the portrait suite
  aim = await aimTop();
  const cur = await page.evaluate(() => window.__GBA.cartScreenPos('cascade7'));
  for (let i = 1; i <= 8; i++) {
    await touch('touchMove', cur.x + ((aim.x - cur.x) * i) / 8, cur.y + ((aim.y - cur.y) * i) / 8);
    await sleep(40);
  }
  for (let i = 0; i < 12; i++) { // hold at the top edge, keep nudging so the snap contracts
    await touch('touchMove', aim.x + (i % 2 === 0 ? 3 : -3), 2);
    await sleep(40);
  }
  const snapDist = await page.evaluate(() => window.__GBA.cartDistToSlot('cascade7'));
  log(snapDist !== null && snapDist < 20,
    `grip drawer drag: magnetic snap engages at the top slot (cart ${snapDist?.toFixed(1)}mm from the approach pose)`);

  await touch('touchEnd');
  await sleep(150);
  const noSecondCine = await page.evaluate(() => ({
    active: window.__GBA.scene3d.gripCineActive,
    grip: window.__GBA.scene3d.gripMode,
  }));
  log(!noSecondCine.active && noSecondCine.grip, 'grip insert: no second cinematic, framing never leaves grip');
  const booted = await page
    .waitForFunction(() => window.__GBA.stateName() === 'PLAYING', null, { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  log(booted, 'grip drawer drag: release into the snap zone boots the ROM (swap completed inside grip)');
  const drawerGone = await page
    .waitForFunction(() => !window.__GBA.carts.drawerOpen && window.__GBA.carts.pouchGroup.position.x > 120, null, { timeout: 25000 })
    .then(() => true).catch(() => false);
  log(drawerGone, 'grip: successful insert slides the drawer back off the right edge');

  // ---------- EXIT GRIP chip: leave the immersive view without ejecting ----------
  await waitFrames(page);
  await page.evaluate(() => window.__GBA.scene3d.refit());
  await sleep(150);
  await page.click('#grip-exit');
  await sleep(300);
  const exited = await page.evaluate(() => ({
    grip: window.__GBA.scene3d.gripMode,
    chipHidden: document.getElementById('grip-exit').hidden,
    state: window.__GBA.stateName(),
    pouchX: window.__GBA.carts.pouchGroup.position.x,
    zonesBack: !document.getElementById('touch-zones')?.classList.contains('grip-hidden'),
  }));
  log(!exited.grip && exited.chipHidden && exited.state === 'PLAYING' && Math.abs(exited.pouchX - 160) < 8 && exited.zonesBack,
    'grip: EXIT GRIP chip leaves the immersive view (normal landscape play layout, game keeps running)');
  const lcdAfterExit = await page
    .waitForFunction((th) => {
      const g = window.__GBA;
      const lcd = g.scene3d.handheld.deviceGroup.getObjectByName('lcd');
      const top = lcd.localToWorld(lcd.position.clone().set(0, 39.33 / 2, 0));
      const bottom = lcd.localToWorld(lcd.position.clone().set(0, -39.33 / 2, 0));
      return Math.abs(g.scene3d.projectToScreen(bottom).y - g.scene3d.projectToScreen(top).y) < th;
    }, lcdGrip * 0.75, { timeout: 30000 })
    .then(async () => page.evaluate(LCD_HEIGHT_FN))
    .catch(() => null);
  log(lcdAfterExit !== null,
    `grip: after exit the framing returns to the normal landscape play view (LCD ${lcdAfterExit?.toFixed(0) ?? 'still ' + lcdGrip.toFixed(0)}px)`);

  // ---------- rotation cycle re-immerses (opt-out resets off the grip context) ----------
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => window.__GBA.scene3d.layoutMode === 'portrait', null, { timeout: 10000 });
  await page.setViewportSize({ width: 844, height: 390 });
  const reImmersed = await page
    .waitForFunction(() => window.__GBA.scene3d.gripMode, null, { timeout: 10000 })
    .then(() => true).catch(() => false);
  log(reImmersed, 'rotation cycle: portrait → landscape re-immerses the grip view');

  log(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await ctx.close();

  // ---------- prefers-reduced-motion: cinematic skipped entirely ----------
  const ctx2 = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
    reducedMotion: 'reduce',
  });
  const page2 = await ctx2.newPage();
  const errors2 = [];
  page2.on('pageerror', (e) => errors2.push(e.message));
  await page2.goto(BASE, { waitUntil: 'load' });
  await page2.waitForFunction(() => window.__GBA?.stateName, null, { timeout: 15000 });
  await page2.evaluate(() => window.__GBA.insertById('cascade7'));
  await sleep(400);
  const rmCine = await page2.evaluate(() => ({
    active: window.__GBA.scene3d.gripCineActive,
    done: window.__GBA.scene3d.gripCineDone,
    roll: window.__GBA.scene3d.gripCineRoll,
    session: window.__GBA.scene3d.gripSessionActive,
  }));
  log(rmCine.session && rmCine.done && !rmCine.active && rmCine.roll === 0,
    'reduced-motion: grip session starts but the roll/zoom cinematic is skipped (direct arrival)');
  await page2.waitForFunction(() => window.__GBA.stateName() === 'PLAYING', null, { timeout: 30000 });
  await page2.setViewportSize({ width: 844, height: 390 });
  await page2.waitForFunction(() => window.__GBA.scene3d.gripMode, null, { timeout: 10000 });
  await waitFrames(page2);
  await page2.evaluate(() => window.__GBA.scene3d.refit());
  await sleep(200);
  const rm = await page2.evaluate(() => ({
    bounds: window.__GBA.deviceScreenBounds(),
    roll: window.__GBA.scene3d.gripCineRoll,
  }));
  const rmCoverW = (rm.bounds.maxX - rm.bounds.minX) / 844;
  const rmCoverH = (rm.bounds.maxY - rm.bounds.minY) / 390;
  log(rm.roll === 0 && rm.bounds.minX <= 8.44 && rm.bounds.maxX >= 835.6 && rm.bounds.minY <= 0 && rm.bounds.maxY >= 390,
    `reduced-motion: full-bleed grip framing without any roll (${(rmCoverW * 100).toFixed(0)}% × ${(rmCoverH * 100).toFixed(0)}% coverage)`);
  log(errors2.length === 0, `no page errors (reduced-motion)${errors2.length ? ': ' + errors2.join(' | ') : ''}`);
  await ctx2.close();

  await browser.close();
} finally {
  preview.kill('SIGTERM');
  if (browser?.isConnected()) await browser.close().catch(() => {});
}

console.log(failures === 0 ? '\nMOBILE GRIP CHECKS PASSED' : `\n${failures} MOBILE GRIP CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
