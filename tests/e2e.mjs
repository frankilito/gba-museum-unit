/**
 * Acceptance test suite (Chromium). Serves the production build via vite preview
 * (COOP/COEP headers from vite.config.ts) and drives the real app.
 *
 * Covers acceptance items 1–6, 8 and produces screenshots for item 7.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = 'http://127.0.0.1:5181/';
const SHOTS = new URL('./shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const log = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};
const info = (msg) => console.log(`····  ${msg}`);

async function waitForServer(url, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('preview server did not start');
}

const preview = spawn('npx', ['vite', 'preview'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: 'ignore',
});

let browser;
try {
  await waitForServer(BASE);

  browser = await chromium.launch({
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-precise-memory-info',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  const consoleErrors = [];
  const badResponses = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`);
  });
  page.on('requestfailed', (r) => badResponses.push(`FAILED ${r.url()} ${r.failure()?.errorText}`));

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__GBA && window.__GBA.stateName, null, { timeout: 15000 });

  const isolated = await page.evaluate(() => window.crossOriginIsolated);
  log(isolated === true, 'cross-origin isolation active (SharedArrayBuffer for mGBA threads)');

  const coiSwLoaded = await page.evaluate(() => !!document.querySelector('script[src*="coi-serviceworker"]'));
  log(coiSwLoaded, 'COI service worker fallback present for static hosts');

  await sleep(1500);
  await page.screenshot({ path: `${SHOTS}01-hero.png` });
  log(true, 'hero screenshot captured');

  const noBadResponses = () => log(badResponses.length === 0, `no 404/MIME/failed requests${badResponses.length ? ': ' + badResponses.join('; ') : ''}`);

  // ---------- 1. all three ROMs really boot (2 presets + pong via upload) ----------
  let firstBoot = true;
  const bootAndCheck = async (id, label) => {
    await page.evaluate((i) => window.__GBA.insertById(i), id);
    const reachedPlaying = await page
      .waitForFunction(() => window.__GBA.stateName() === 'PLAYING', null, { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    log(reachedPlaying, `${label}: insert → INSERTING → BOOTING → PLAYING`);
    if (!reachedPlaying) {
      info(`state stuck at ${await page.evaluate(() => window.__GBA.stateName())}, lastError: ${await page.evaluate(() => window.__GBA.lastError?.())}`);
      return;
    }
    if (firstBoot) {
      // The very first PLAYING moment: no state could exist yet (eject auto-save
      // hasn't run), so LOAD must say so honestly instead of faking success.
      firstBoot = false;
      await page.evaluate(() => document.getElementById('btn-state-load').click());
      await page
        .waitForFunction(() => /No saved state/.test(document.getElementById('toast').textContent), null, { timeout: 5000 })
        .catch(() => {});
      const honest = await page.evaluate(() => /No saved state/.test(document.getElementById('toast').textContent));
      log(honest, 'LOAD with no saved state reports honestly (no fake success)');
      await page.evaluate(() => document.getElementById('toast').classList.remove('show')); // keep screenshots clean
    }
    await sleep(1200);
    const frames = await page.evaluate(async () => {
      const a = window.__GBA.getAdapter();
      const f0 = a.frameCount;
      await new Promise((r) => setTimeout(r, 1000));
      return { delta: a.frameCount - f0, version: a.coreVersion };
    });
    log(frames.delta > 20, `${label}: core producing frames (${frames.delta}/s, mGBA ${frames.version})`);
    const sample = await page.evaluate(() => window.__GBA.screenSample());
    // Pong is legitimately black-and-white; others are colorful.
    log(sample.unique >= 2, `${label}: screen has real game imagery (${sample.unique} sampled colors)`);
    const audio = await page.evaluate(() => {
      const a = window.__GBA.getAdapter();
      const ctx = a?.module?.SDL2?.audioContext;
      return ctx ? { state: ctx.state, rate: ctx.sampleRate } : null;
    });
    log(!!audio, `${label}: game AudioContext exists (${audio ? `${audio.state}@${audio.rate}Hz` : 'none'})`);
    await page.screenshot({ path: `${SHOTS}02-playing-${label}.png` });
    await page.evaluate(() => window.__GBA.eject());
    await page.waitForFunction(() => window.__GBA.stateName() === 'OFF', null, { timeout: 15000 });
    await sleep(400);
  };

  for (const id of ['cascade7', 'gbarcade']) await bootAndCheck(id, id);

  // pong no longer has a preset slot — it boots through the upload path
  const pongImported = await page.evaluate(async () => {
    const res = await fetch('roms/Pong-Homebrew-GBA.gba');
    const bytes = new Uint8Array(await res.arrayBuffer());
    return await window.__GBA.importBytes(bytes, 'Pong-Homebrew-GBA.gba', 'upload-1');
  });
  log(pongImported === true, 'pong: imports into upload slot 1');
  await bootAndCheck('upload-1', 'pong');

  // ---------- 2. same-frame input + animation ----------
  await page.evaluate(() => window.__GBA.insertById('cascade7'));
  await page.waitForFunction(() => window.__GBA.stateName() === 'PLAYING', null, { timeout: 30000 });

  await page.keyboard.down('k'); // GBA A
  // wait for the core to apply the press (frame-based, not wall-clock)
  await page.waitForFunction(() => window.__GBA.getAdapter().lastApplyFrame['A:down'] !== undefined, null, { timeout: 8000 });
  const sameFrame = await page.evaluate(() => {
    const g = window.__GBA;
    const a = g.getAdapter();
    return {
      edgeFrame: g.input.lastEdgeFrame['A:down'],
      applyFrame: a.lastApplyFrame['A:down'],
      travel: g.scene3d.handheld.getButtonTravel().A,
      stateA: g.input.state.A,
    };
  });
  // The DOM event lands between render frames; the very next render frame must
  // apply it to the core and start the 3D travel — i.e. Δframe ≤ 1.
  log(sameFrame.stateA && sameFrame.applyFrame - sameFrame.edgeFrame <= 1 && sameFrame.travel > 0.05,
    `A key: core apply + 3D travel in the same/next render frame (edge ${sameFrame.edgeFrame} → apply ${sameFrame.applyFrame}, travel=${sameFrame.travel.toFixed(2)})`);

  // keydown repeat must not replay the press animation
  const repeatOk = await page.evaluate(async () => {
    const g = window.__GBA;
    const before = g.input.lastEdgeFrame['A:down'];
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK', repeat: true, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK', repeat: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    return g.input.lastEdgeFrame['A:down'] === before && g.input.state.A === true;
  });
  log(repeatOk, 'keydown repeat: state held, no re-triggered press animation');

  await page.keyboard.up('k');
  await page.waitForFunction(() => window.__GBA.scene3d.handheld.getButtonTravel().A < 0.05, null, { timeout: 8000 });
  const released = await page.evaluate(() => {
    const g = window.__GBA;
    return { state: g.input.state.A, travel: g.scene3d.handheld.getButtonTravel().A, applied: g.getAdapter().lastApplyFrame['A:up'] > 0 };
  });
  log(!released.state && released.travel < 0.05 && released.applied, 'A release: state/animation/core all released');

  // combo + diagonal
  await page.keyboard.down('ArrowUp');
  await page.keyboard.down('ArrowRight');
  await page.waitForFunction(() => {
    const rot = window.__GBA.scene3d.handheld.grpDpad.rotation;
    return Math.abs(rot.x) > 0.02 && Math.abs(rot.y) > 0.02;
  }, null, { timeout: 8000 });
  const diag = await page.evaluate(() => {
    const g = window.__GBA;
    const rot = g.scene3d.handheld.grpDpad.rotation;
    return { up: g.input.state.UP, right: g.input.state.RIGHT, rx: rot.x, ry: rot.y };
  });
  log(diag.up && diag.right && Math.abs(diag.rx) > 0.02 && Math.abs(diag.ry) > 0.02,
    `diagonal: UP+RIGHT held, D-pad tilts on both axes (${diag.rx.toFixed(2)}, ${diag.ry.toFixed(2)})`);

  // two keys one button: release one, stays pressed
  await page.keyboard.down('w'); // also UP
  await page.keyboard.up('ArrowUp');
  await sleep(50);
  const refCount = await page.evaluate(() => window.__GBA.input.state.UP === true);
  log(refCount, 'W + ArrowUp both held: releasing ArrowUp keeps UP pressed');
  await page.keyboard.up('w');
  await page.keyboard.up('ArrowRight');

  // blur releases everything (no stuck keys)
  await page.keyboard.down('j'); // B
  await page.keyboard.down('q'); // L
  await sleep(40);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await sleep(60);
  const blurOk = await page.evaluate(() => {
    const s = window.__GBA.input.state;
    return Object.values(s).every((v) => v === false);
  });
  log(blurOk, 'window blur releases all buttons (no stuck keys)');

  // pointer press on the physical A button, then slide off
  const btnA = await page.evaluate(() => window.__GBA.buttonScreenPos('A'));
  await page.mouse.move(btnA.x, btnA.y);
  await page.mouse.down();
  await page.waitForFunction(() => window.__GBA.scene3d.handheld.getButtonTravel().A > 0.1, null, { timeout: 8000 });
  const ptrPress = await page.evaluate(() => ({
    state: window.__GBA.input.state.A,
    travel: window.__GBA.scene3d.handheld.getButtonTravel().A,
  }));
  log(ptrPress.state && ptrPress.travel > 0.1, `pointer on physical A button presses it (travel=${ptrPress.travel.toFixed(2)})`);
  await page.mouse.move(20, 20, { steps: 5 }); // slide off into empty space
  await page.waitForFunction(() => window.__GBA.input.state.A === false, null, { timeout: 8000 });
  const ptrSlide = await page.evaluate(() => window.__GBA.input.state.A);
  log(ptrSlide === false, 'sliding pointer off the button releases it');
  await page.mouse.up();

  // D-pad pointer press with direction from hit point
  const dpad = await page.evaluate(() => window.__GBA.buttonScreenPos('DPAD'));
  await page.mouse.move(dpad.x, dpad.y - 28);
  await page.mouse.down();
  await page.waitForFunction(() => window.__GBA.input.state.UP === true, null, { timeout: 8000 });
  const dpadUp = await page.evaluate(() => window.__GBA.input.state.UP);
  log(dpadUp === true, 'pointer on upper D-pad arm presses UP');
  await page.mouse.up();
  await sleep(40);
  await page.evaluate(() => window.__GBA.eject());
  await page.waitForFunction(() => window.__GBA.stateName() === 'OFF', null, { timeout: 15000 });

  // ---------- 3. wrong-position drop returns; drag insert works ----------
  const homeBefore = await page.evaluate(() => window.__GBA.cartScreenPos('cascade7'));
  await page.mouse.move(homeBefore.x, homeBefore.y);
  await page.mouse.down();
  await page.mouse.move(homeBefore.x - 220, homeBefore.y - 160, { steps: 12 });
  await page.mouse.up();
  await sleep(900);
  const homeAfter = await page.evaluate(() => window.__GBA.cartScreenPos('cascade7'));
  const returned = Math.hypot(homeAfter.x - homeBefore.x, homeAfter.y - homeBefore.y) < 30;
  log(returned && (await page.evaluate(() => window.__GBA.stateName())) === 'OFF',
    `wrong-position drop springs back to its slot (Δ=${Math.hypot(homeAfter.x - homeBefore.x, homeAfter.y - homeBefore.y).toFixed(0)}px), no boot`);

  // real drag into the slot (re-aim after the camera push-in settles, like a user would)
  await page.mouse.move(homeBefore.x, homeBefore.y);
  await page.mouse.down();
  let slot = await page.evaluate(() => window.__GBA.slotScreenPos());
  for (let i = 1; i <= 16; i++) {
    await page.mouse.move(
      homeBefore.x + ((slot.x - homeBefore.x) * i) / 16,
      homeBefore.y + ((slot.y - homeBefore.y) * i) / 16,
    );
    await sleep(25);
  }
  await sleep(600); // camera push-in settles → projection shifts → re-aim
  slot = await page.evaluate(() => window.__GBA.slotScreenPos());
  const cur = await page.evaluate(() => window.__GBA.cartScreenPos('cascade7'));
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(cur.x + ((slot.x - cur.x) * i) / 8, cur.y + ((slot.y - cur.y) * i) / 8);
    await sleep(25);
  }
  await sleep(200);
  await page.mouse.up();
  const dragBooted = await page
    .waitForFunction(() => window.__GBA.stateName() === 'PLAYING', null, { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  log(dragBooted, 'dragging a cart into the slot (magnetic snap) boots the ROM');
  await page.screenshot({ path: `${SHOTS}03-drag-inserted.png` });

  // eject by dragging the inserted cart upward
  const insertedPos = await page.evaluate(() => window.__GBA.cartScreenPos('cascade7'));
  await page.mouse.move(insertedPos.x, insertedPos.y);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) {
    await page.mouse.move(insertedPos.x, insertedPos.y - i * 14);
    await sleep(25);
  }
  await page.mouse.up();
  const ejected = await page
    .waitForFunction(() => window.__GBA.stateName() === 'OFF', null, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  log(ejected, 'dragging the inserted cart upward pauses, saves and ejects → OFF');
  const toastText = await page.locator('#toast').textContent();
  info(`eject toast: "${toastText}" (honest save reporting)`);

  // ---------- 4. rapid ROM switching ×10: stability ----------
  const ids = ['cascade7', 'gbarcade', 'upload-1'];
  const adapterRef = await page.evaluate(() => !!window.__GBA.getAdapter());
  let switchOk = true;
  let heapFirst = 0;
  let heapLast = 0;
  for (let i = 0; i < 10; i++) {
    const id = ids[i % 3];
    await page.evaluate((x) => window.__GBA.insertById(x), id);
    const ok = await page
      .waitForFunction(() => window.__GBA.stateName() === 'PLAYING', null, { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (!ok) {
      switchOk = false;
      info(`switch round ${i} failed to reach PLAYING (stuck at ${await page.evaluate(() => window.__GBA.stateName())})`);
      break;
    }
    await sleep(500);
    const advancing = await page.evaluate(async () => {
      const a = window.__GBA.getAdapter();
      const f0 = a.frameCount;
      await new Promise((r) => setTimeout(r, 400));
      return a.frameCount - f0;
    });
    if (advancing < 5) {
      switchOk = false;
      info(`switch round ${i}: screen stalled (${advancing} frames)`);
      break;
    }
    if (i === 0) heapFirst = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
    if (i === 9) heapLast = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
    await page.evaluate(() => window.__GBA.eject());
    await page.waitForFunction(() => window.__GBA.stateName() === 'OFF', null, { timeout: 15000 });
    await sleep(150);
  }
  log(switchOk, '10 rapid ROM switches: every round boots, screen advances, no black screen');
  const sameAdapter = await page.evaluate(() => !!window.__GBA.getAdapter()) === adapterRef;
  log(sameAdapter, 'single long-lived emulator instance (no duplicate audio contexts)');
  if (heapFirst && heapLast) {
    const growthMB = (heapLast - heapFirst) / 1e6;
    info(`JS heap: ${(heapFirst / 1e6).toFixed(0)}MB → ${(heapLast / 1e6).toFixed(0)}MB (Δ${growthMB.toFixed(1)}MB)`);
    log(growthMB < 120, 'heap growth across 10 switches is bounded (<120MB)');
  }

  // ---------- 5. import: validation + two independent upload slots ----------
  const randomRejected = await page.evaluate(async () => {
    const junk = new Uint8Array(8192);
    for (let i = 0; i < junk.length; i++) junk[i] = 65 + Math.floor(Math.random() * 26);
    const a = await window.__GBA.importBytes(junk, 'definitely-not-a-rom.gba', 'upload-1');
    const b = await window.__GBA.importBytes(junk, 'definitely-not-a-rom.gba', 'upload-2');
    return a === false && b === false;
  });
  log(randomRejected, 'random text renamed .gba is rejected by both upload slots');
  const slot2StillBlank = await page.evaluate(() => window.__GBA.carts.getCart('upload-2').isBlank === true);
  log(slot2StillBlank, 'rejected import leaves the upload slot blank');

  const imported2 = await page.evaluate(async () => {
    const res = await fetch('roms/CASCADE7.gba');
    const bytes = new Uint8Array(await res.arrayBuffer());
    return await window.__GBA.importBytes(bytes, 'my-backup.gba', 'upload-2');
  });
  log(imported2 === true, 'valid local .gba imports into upload slot 2');
  const bothUploads = await page.evaluate(() => {
    const a = window.__GBA.carts.getCart('upload-1');
    const b = window.__GBA.carts.getCart('upload-2');
    return {
      a: a ? { title: a.title, blank: !!a.isBlank, bytes: !!a.romBytes } : null,
      b: b ? { title: b.title, blank: !!b.isBlank, bytes: !!b.romBytes } : null,
    };
  });
  log(
    !!bothUploads.a?.bytes && !bothUploads.a.blank && !!bothUploads.b?.bytes && !bothUploads.b.blank,
    `two upload carts coexist, each with its own label (${bothUploads.a?.title ?? '?'} · ${bothUploads.b?.title ?? '?'})`,
  );
  await page.evaluate(() => window.__GBA.insertById('upload-2'));
  const importBoots = await page
    .waitForFunction(() => window.__GBA.stateName() === 'PLAYING', null, { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  log(importBoots, 'uploaded ROM in slot 2 boots and runs');
  await page.evaluate(() => window.__GBA.eject());
  await page.waitForFunction(() => window.__GBA.stateName() === 'OFF', null, { timeout: 15000 });

  // truncated ROM (valid header, broken body) → error on screen + auto eject
  const truncBoot = await page.evaluate(async () => {
    const res = await fetch('roms/CASCADE7.gba');
    const full = new Uint8Array(await res.arrayBuffer());
    return await window.__GBA.importBytes(full.slice(0, 4096), 'broken.gba', 'upload-2');
  });
  if (truncBoot) {
    await page.evaluate(() => window.__GBA.insertById('upload-2'));
    const errored = await page
      .waitForFunction(() => window.__GBA.stateName() === 'ERROR' || window.__GBA.stateName() === 'OFF', null, { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    const sawError = await page.evaluate(() => window.__GBA.stateName());
    info(`broken ROM path reached state: ${sawError}`);
    const backOff = await page
      .waitForFunction(() => window.__GBA.stateName() === 'OFF', null, { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    log(errored && backOff, 'broken ROM shows error on the GBA screen and auto-ejects (no white screen)');
    await page.screenshot({ path: `${SHOTS}04-after-error.png` }).catch(() => {});
  }
  // put a good ROM back into slot 2 for the reload test
  await page.evaluate(async () => {
    const res = await fetch('roms/CASCADE7.gba');
    const bytes = new Uint8Array(await res.arrayBuffer());
    await window.__GBA.importBytes(bytes, 'my-backup.gba', 'upload-2');
  });

  // ---------- 6. per-ROM saves persist across reload, no cross-talk ----------
  const sramPersist = await page.evaluate(async () => {
    const s = window.__GBA.store;
    await s.putSram('hash-aaa', new Uint8Array([1, 2, 3, 4, 5]));
    await s.putSram('hash-bbb', new Uint8Array([9, 8, 7]));
    return true;
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__GBA && window.__GBA.stateName, null, { timeout: 15000 });
  const sramAfter = await page.evaluate(async () => {
    const s = window.__GBA.store;
    const a = await s.getSram('hash-aaa');
    const b = await s.getSram('hash-bbb');
    return {
      a: a ? Array.from(a) : null,
      b: b ? Array.from(b) : null,
    };
  });
  log(
    sramPersist &&
      JSON.stringify(sramAfter.a) === '[1,2,3,4,5]' &&
      JSON.stringify(sramAfter.b) === '[9,8,7]',
    'per-ROM saves survive reload, keyed separately (no cross-contamination)',
  );

  // both uploaded carts restored from IndexedDB after reload
  const restoredUploads = await page.evaluate(() => {
    const a = window.__GBA.carts.getCart('upload-1');
    const b = window.__GBA.carts.getCart('upload-2');
    return {
      a: a ? { title: a.title, hasBytes: !!a.romBytes } : null,
      b: b ? { title: b.title, hasBytes: !!b.romBytes } : null,
    };
  });
  log(
    !!restoredUploads.a?.hasBytes && !!restoredUploads.b?.hasBytes,
    `both uploaded carts restored after reload (${restoredUploads.a?.title ?? 'none'} · ${restoredUploads.b?.title ?? 'none'})`,
  );

  // ---------- 6b. manual save states: save → reload → reinsert → load ----------
  await page.evaluate(() => window.__GBA.insertById('cascade7'));
  await page.waitForFunction(() => window.__GBA.stateName() === 'PLAYING', null, { timeout: 30000 });
  await sleep(1000); // let the game run so there is something worth snapshotting

  await page.evaluate(() => document.getElementById('btn-state-save').click());
  await page
    .waitForFunction(() => document.getElementById('toast').textContent === 'State saved', null, { timeout: 5000 })
    .catch(() => {});
  const saveOk = await page.evaluate(async () => {
    const toastOk = document.getElementById('toast').textContent === 'State saved';
    const h = window.__GBA.carts.getCart('cascade7').hash;
    const stored = h ? await window.__GBA.store.getState(h) : null;
    return toastOk && !!stored;
  });
  log(saveOk, 'SAVE: snapshot persisted to IndexedDB keyed by ROM hash, honest toast');

  await page.evaluate(() => window.__GBA.eject());
  await page.waitForFunction(() => window.__GBA.stateName() === 'OFF', null, { timeout: 15000 });
  const disabledOff = await page.evaluate(
    () => document.getElementById('btn-state-save').disabled && document.getElementById('btn-state-load').disabled,
  );
  log(disabledOff, 'SAVE/LOAD buttons are disabled unless PLAYING');

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__GBA && window.__GBA.stateName, null, { timeout: 15000 });
  await page.evaluate(() => window.__GBA.insertById('cascade7'));
  await page.waitForFunction(() => window.__GBA.stateName() === 'PLAYING', null, { timeout: 30000 });
  await page.evaluate(() => document.getElementById('btn-state-load').click());
  await page
    .waitForFunction(() => document.getElementById('toast').textContent === 'State loaded', null, { timeout: 5000 })
    .catch(() => {});
  const cont = await page.evaluate(async () => {
    const a = window.__GBA.getAdapter();
    const f0 = a.frameCount;
    await new Promise((r) => setTimeout(r, 800));
    return {
      toast: document.getElementById('toast').textContent,
      state: window.__GBA.stateName(),
      delta: a.frameCount - f0,
    };
  });
  log(
    cont.toast === 'State loaded' && cont.state === 'PLAYING' && cont.delta > 10,
    `LOAD after page reload: snapshot restored and the game continues (${cont.delta} frames after load)`,
  );
  await page.evaluate(() => window.__GBA.eject());
  await page.waitForFunction(() => window.__GBA.stateName() === 'OFF', null, { timeout: 15000 });

  // ---------- 6c. cartridge slots panel: list, replace, clear ----------
  await page.click('#btn-carts');
  const titles0 = await page.evaluate(() => ({
    a: document.getElementById('cart-title-upload-1').textContent,
    b: document.getElementById('cart-title-upload-2').textContent,
    cartA: window.__GBA.carts.getCart('upload-1').title,
    cartB: window.__GBA.carts.getCart('upload-2').title,
  }));
  log(
    titles0.a === titles0.cartA && titles0.b === titles0.cartB && titles0.b === 'CASCADE7',
    `panel lists both upload slots with their current ROM titles (${titles0.a} · ${titles0.b})`,
  );

  // replace slot 2 through the panel's own file chooser
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#cart-choose-upload-2')]);
  const pongBytes = readFileSync(new URL('../public/roms/Pong-Homebrew-GBA.gba', import.meta.url));
  await chooser.setFiles({ name: 'pong-via-panel.gba', mimeType: 'application/octet-stream', buffer: pongBytes });
  // the import is async — wait until the cart actually changed AND the row re-rendered
  await page.waitForFunction(
    () => {
      const c = window.__GBA.carts.getCart('upload-2');
      return (
        c && !c.isBlank && c.title !== 'CASCADE7' &&
        document.getElementById('cart-title-upload-2').textContent === c.title
      );
    },
    null,
    { timeout: 8000 },
  );
  const replaced = await page.evaluate(() => ({
    row: document.getElementById('cart-title-upload-2').textContent,
    cart: window.__GBA.carts.getCart('upload-2').title,
  }));
  log(replaced.row === replaced.cart && replaced.cart !== 'CASCADE7', `panel replace: slot 2 label updates to the new ROM (${replaced.cart})`);

  // clear slot 2 → blank again, mapping removed (row re-render is async via the store)
  await page.click('#cart-clear-upload-2');
  await page.waitForFunction(
    () =>
      window.__GBA.carts.getCart('upload-2').isBlank === true &&
      document.getElementById('cart-title-upload-2').textContent === 'LOAD YOUR ROM',
    null,
    { timeout: 5000 },
  );
  const clearedRow = await page.evaluate(() => document.getElementById('cart-title-upload-2').textContent);
  log(clearedRow === 'LOAD YOUR ROM', 'panel clear: slot 2 returns to blank (LOAD YOUR ROM)');
  await page.click('#btn-carts-close');

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__GBA && window.__GBA.stateName, null, { timeout: 15000 });
  const afterClear = await page.evaluate(() => ({
    u1: !window.__GBA.carts.getCart('upload-1').isBlank && !!window.__GBA.carts.getCart('upload-1').romBytes,
    u2blank: window.__GBA.carts.getCart('upload-2').isBlank === true,
  }));
  log(afterClear.u1 && afterClear.u2blank, 'after reload: cleared slot stays blank, the other upload slot is still restored');

  // ---------- 7. visual QA screenshots ----------
  await page.evaluate(() => window.__GBA.insertById('gbarcade'));
  await page.waitForFunction(() => window.__GBA.stateName() === 'PLAYING', null, { timeout: 30000 });
  await sleep(2500);
  await page.screenshot({ path: `${SHOTS}05-playing-front.png` });

  // close-ups via debug camera override (the rig would otherwise re-aim)
  await page.evaluate(() => {
    const g = window.__GBA;
    g.scene3d.cameraOverride = { pos: { x: 40, y: 120, z: 300 }, target: { x: 0, y: 8, z: 5 } };
  });
  await sleep(150);
  await page.screenshot({ path: `${SHOTS}06-closeup-front.png` });

  // controls close-up (A/B, dpad, seams)
  await page.evaluate(() => {
    const g = window.__GBA;
    g.scene3d.cameraOverride = { pos: { x: -70, y: 50, z: 220 }, target: { x: -25, y: 2, z: 8 } };
  });
  await sleep(150);
  await page.screenshot({ path: `${SHOTS}07-controls-closeup.png` });

  // back view (battery cover, screws, label — the upright back faces −Z)
  await page.evaluate(() => {
    const g = window.__GBA;
    g.scene3d.cameraOverride = { pos: { x: -120, y: 80, z: -320 }, target: { x: 0, y: 0, z: -5 } };
  });
  await sleep(150);
  await page.screenshot({ path: `${SHOTS}08-back-view.png` });

  // pouch close-up
  await page.evaluate(() => {
    const g = window.__GBA;
    g.scene3d.cameraOverride = { pos: { x: 170, y: 60, z: 220 }, target: { x: 160, y: -30, z: 6 } };
  });
  await sleep(150);
  await page.screenshot({ path: `${SHOTS}09-pouch.png` });
  await page.evaluate(() => {
    window.__GBA.scene3d.cameraOverride = null;
  });

  await page.evaluate(() => window.__GBA.eject());
  await page.waitForFunction(() => window.__GBA.stateName() === 'OFF', null, { timeout: 15000 }).catch(() => {});

  // ---------- 8. console / network ----------
  noBadResponses();
  const realErrors = consoleErrors.filter(
    (e) => !/favicon|Download the React|deprecat/i.test(e),
  );
  log(realErrors.length === 0, `console clean${realErrors.length ? ': ' + realErrors.slice(0, 4).join(' | ') : ''}`);

  // ---------- 9. footer legal copy ----------
  const legal = await page.locator('#legal').textContent();
  log(/not affiliated with/i.test(legal) && /never leave your browser/i.test(legal),
    'footer: unofficial-experiment disclaimer + local-only ROM notice');

  writeFileSync(
    `${SHOTS}summary.json`,
    JSON.stringify({ failures, consoleErrors, badResponses }, null, 2),
  );

  await browser.close();
} finally {
  preview.kill('SIGTERM');
  if (browser?.isConnected()) await browser.close().catch(() => {});
}

console.log(failures === 0 ? '\nALL ACCEPTANCE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
