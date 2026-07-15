/**
 * Slow-network first-paint framing test (Chromium).
 *
 * Reproduces the public cold-cache path by holding models/gba.glb for 2.5s,
 * then asserts at three desktop viewports:
 *   1. before the GLB is ready the camera sits at the safe hero pose
 *      (display stand projects inside the viewport) and the LOADING chip shows;
 *   2. after the GLB is ready + refit, the whole device (top edge, stand foot,
 *      both sides) projects inside the viewport and the chip is gone.
 *
 * Run: node tests/slowload.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = 'http://127.0.0.1:5181/';
const SHOTS = new URL('./shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const VIEWPORTS = [
  { width: 1400, height: 900 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
];

let failures = 0;
const log = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};

const preview = spawn('npx', ['vite', 'preview'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: 'ignore',
});

let browser;
try {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(BASE);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await sleep(250);
  }

  browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });

  for (const vp of VIEWPORTS) {
    const tag = `${vp.width}x${vp.height}`;
    const page = await browser.newPage({ viewport: vp });
    page.on('pageerror', (e) => console.log('pageerror:', e.message));

    // hold the GLB for 2.5s — the rest of the app boots normally
    await page.route('**/models/gba.glb', async (route) => {
      await sleep(2500);
      await route.continue();
    });

    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__GBA?.stateName, null, { timeout: 15000 });

    // ---- phase 1: GLB still in flight → safe pose + loading chip ----
    await sleep(600);
    const during = await page.evaluate(() => {
      const g = window.__GBA;
      const chip = document.getElementById('boot-status');
      return {
        loaded: g.scene3d.handheld.getButtonWorldPos('A') !== null,
        chipShown: !!chip && !chip.classList.contains('done'),
        standFoot: g.scene3d.projectToScreen(new g.scene3d.camera.position.constructor(0, -43.5, 0)),
      };
    });
    log(!during.loaded, `${tag}: GLB still loading after first paint (throttle active)`);
    log(during.chipShown, `${tag}: LOADING chip visible before the model is ready`);
    log(
      during.standFoot.y > 0 && during.standFoot.y < vp.height && during.standFoot.x > 0 && during.standFoot.x < vp.width,
      `${tag}: safe hero pose while loading — stand foot in frame (${during.standFoot.x.toFixed(0)}, ${during.standFoot.y.toFixed(0)})`,
    );

    // ---- phase 2: GLB ready + refit → full device in frame ----
    await page.waitForFunction(() => window.__GBA.scene3d.handheld.getButtonWorldPos('A') !== null, null, { timeout: 20000 });
    await sleep(1200); // refit + a few frames

    const after = await page.evaluate(() => {
      const g = window.__GBA;
      const V = g.scene3d.camera.position.constructor;
      const p = (x, y, z) => g.scene3d.projectToScreen(new V(x, y, z));
      return {
        chipHidden: document.getElementById('boot-status')?.classList.contains('done') ?? true,
        top: p(0, 52, 0), // top edge of the shell
        foot: p(0, -46, 0), // stand foot on the floor
        left: p(-74, 5, 0), // left edge of the shell
        right: p(74, 5, 0), // right edge of the shell
        camPos: g.scene3d.camera.position.toArray().map((n) => +n.toFixed(0)),
      };
    });
    const inFrameX = (s) => s.x > vp.width * 0.03 && s.x < vp.width * 0.97;
    const inFrameY = (s) => s.y > vp.height * 0.02 && s.y < vp.height * 0.98;
    log(after.chipHidden, `${tag}: LOADING chip hidden once the model is ready`);
    log(
      inFrameY(after.top) && inFrameY(after.foot),
      `${tag}: device fully in frame vertically (top y=${after.top.y.toFixed(0)}, foot y=${after.foot.y.toFixed(0)} of ${vp.height})`,
    );
    log(
      inFrameX(after.left) && inFrameX(after.right),
      `${tag}: device fully in frame horizontally (left x=${after.left.x.toFixed(0)}, right x=${after.right.x.toFixed(0)} of ${vp.width})`,
    );
    await page.screenshot({ path: `${SHOTS}slowload-${tag}.png` });
    await page.close();
  }

  await browser.close();
} finally {
  preview.kill('SIGTERM');
  if (browser?.isConnected()) await browser.close().catch(() => {});
}

console.log(failures === 0 ? '\nSLOW-LOAD FRAMING: ALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
