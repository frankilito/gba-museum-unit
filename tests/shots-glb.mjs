/**
 * GLB acceptance screenshots (standalone): spawns vite preview, waits for the
 * GLB to load, boots a game, and shoots front/back/top/edgeR/edgeL/buttonsCU/
 * wireframe + hero/playing into tests/shots/glb-*.png.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = 'http://127.0.0.1:5181/';
const SHOTS = new URL('./shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

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
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`console.${m.type()}:`, m.text());
  });

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__GBA && window.__GBA.stateName, null, { timeout: 15000 });
  // wait for the GLB: button hit meshes exist once parts are attached
  const glbLoaded = await page
    .waitForFunction(() => window.__GBA.scene3d.handheld.getButtonWorldPos('A') !== null, null, { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  console.log('GLB loaded:', glbLoaded);
  const btnPos = await page.evaluate(() => {
    const h = window.__GBA.scene3d.handheld;
    const p = h.getButtonWorldPos('A');
    return { A: p ? { x: p.x.toFixed(1), y: p.y.toFixed(1), z: p.z.toFixed(1) } : null };
  });
  console.log('btnA world pos:', JSON.stringify(btnPos));

  await sleep(800);
  await page.screenshot({ path: `${SHOTS}glb-hero.png` });

  // boot a game for the playing/front shots
  await page.evaluate(() => window.__GBA.insertById('gbarcade'));
  await page.waitForFunction(() => window.__GBA.stateName() === 'PLAYING', null, { timeout: 30000 });
  await sleep(2500);
  await page.screenshot({ path: `${SHOTS}glb-playing.png` });

  const setCam = (pos, target) =>
    page.evaluate(
      ({ pos, target }) => {
        window.__GBA.scene3d.cameraOverride = { pos, target };
      },
      { pos, target },
    );

  // front (straight-on, slightly above)
  await setCam({ x: 0, y: 20, z: 430 }, { x: 0, y: 5, z: 5 });
  await sleep(150);
  await page.screenshot({ path: `${SHOTS}glb-front.png` });

  // buttons close-up (A/B + dpad + seams)
  await setCam({ x: -30, y: 30, z: 190 }, { x: 5, y: 5, z: 10 });
  await sleep(150);
  await page.screenshot({ path: `${SHOTS}glb-buttonsCU.png` });

  // top edge / slot with the cart inserted
  await setCam({ x: 0, y: 200, z: 130 }, { x: 0, y: 38, z: 0 });
  await sleep(150);
  await page.screenshot({ path: `${SHOTS}glb-top.png` });

  // right edge (power slider)
  await setCam({ x: 300, y: 30, z: 120 }, { x: 66, y: 5, z: 0 });
  await sleep(150);
  await page.screenshot({ path: `${SHOTS}glb-edgeR.png` });

  // left edge
  await setCam({ x: -300, y: 30, z: 120 }, { x: -66, y: 5, z: 0 });
  await sleep(150);
  await page.screenshot({ path: `${SHOTS}glb-edgeL.png` });

  // back (battery cover) — the upright back faces −Z; hide carts for clarity
  await page.evaluate(() => {
    window.__GBA.carts.group.visible = false;
  });
  await setCam({ x: -60, y: 60, z: -300 }, { x: 0, y: -5, z: -8 });
  await sleep(150);
  await page.screenshot({ path: `${SHOTS}glb-back.png` });
  await page.evaluate(() => {
    window.__GBA.carts.group.visible = true;
  });

  // wireframe hero
  await page.evaluate(() => {
    const root = window.__GBA.scene3d.handheld.group;
    root.traverse((o) => {
      if (o.isMesh && o.name !== 'lcd' && !o.geometry.attributes.position) return;
      if (o.isMesh && o.name !== 'lcd' && o.material && 'wireframe' in o.material) {
        o.userData._wf = o.material.wireframe;
        o.material.wireframe = true;
      }
    });
  });
  await setCam({ x: -260, y: 80, z: 420 }, { x: 0, y: 5, z: 0 });
  await sleep(150);
  await page.screenshot({ path: `${SHOTS}glb-wireframe.png` });
  await page.evaluate(() => {
    const root = window.__GBA.scene3d.handheld.group;
    root.traverse((o) => {
      if (o.isMesh && o.userData._wf !== undefined) {
        o.material.wireframe = o.userData._wf;
        delete o.userData._wf;
      }
    });
    window.__GBA.scene3d.cameraOverride = null;
  });

  console.log('done');
  await browser.close();
} finally {
  preview.kill('SIGTERM');
  if (browser?.isConnected()) await browser.close().catch(() => {});
}
