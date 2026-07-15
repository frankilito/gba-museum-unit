/**
 * Reproduce the slow-load framing bug: delay models/gba.glb by 3s and inspect
 * camera state + device bounds before/after load and after a resize.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const preview = spawn('npx', ['vite', 'preview'], { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore' });
let browser;
try {
  for (let i = 0; i < 40; i++) { try { const r = await fetch('http://127.0.0.1:5181/'); if (r.ok) break; } catch {} await sleep(250); }
  browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (e) => console.log('pageerror:', e.message));

  // throttle the GLB: hold the response for 3 seconds
  await page.route('**/models/gba.glb', async (route) => {
    await sleep(3000);
    await route.continue();
  });

  await page.goto('http://127.0.0.1:5181/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__GBA?.stateName, null, { timeout: 15000 });

  const dump = (tag) =>
    page.evaluate((t) => {
      const g = window.__GBA;
      const c = g.scene3d.camera;
      const box = { min: [0, 0, 0], max: [0, 0, 0], empty: true };
      try {
        const THREE = g.scene3d.camera.position.constructor;
        const b = new (Object.getPrototypeOf(g.scene3d.handheld.group).constructor)();
        // compute device bbox via Box3 from the group
        const box3 = g.scene3d.handheld.group;
        const bb = new (g.scene3d.handheld.group.constructor)();
        // simpler: project device center + bottom
        const v = new THREE(0, 0, 0);
        const project = (x, y, z) => {
          v.set(x, y, z).project(c);
          return { x: ((v.x * 0.5 + 0.5) * innerWidth).toFixed(0), y: ((-v.y * 0.5 + 0.5) * innerHeight).toFixed(0), z: v.z.toFixed(2) };
        };
        return {
          tag: t,
          camPos: c.position.toArray().map((n) => +n.toFixed(1)),
          camQuat: c.quaternion.toArray().map((n) => +n.toFixed(3)),
          layout: g.scene3d.layoutMode,
          rendererSize: g.scene3d.renderer.getSize(new THREE(0, 0, 0)).toArray(),
          canvasCss: [g.scene3d.canvas.clientWidth, g.scene3d.canvas.clientHeight],
          canvasAttr: [g.scene3d.canvas.width, g.scene3d.canvas.height],
          projDeviceCenter: project(0, 0, 0),
          projDeviceBottom: project(0, -42, 0),
          projDeviceTop: project(0, 55, 0),
        };
      } catch (e) {
        return { tag: t, error: String(e) };
      }
    }, tag);

  console.log(JSON.stringify(await dump('after __GBA ready (GLB still throttled)'), null, 1));
  await sleep(800);
  await page.screenshot({ path: 'tests/shots/probe-slow-before.png' });

  await page.waitForFunction(() => window.__GBA.scene3d.handheld.getButtonWorldPos('A') !== null, null, { timeout: 20000 });
  await sleep(1000);
  console.log(JSON.stringify(await dump('after GLB loaded + 1s'), null, 1));
  await page.screenshot({ path: 'tests/shots/probe-slow-loaded.png' });

  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await sleep(800);
  console.log(JSON.stringify(await dump('after resize'), null, 1));
  await page.screenshot({ path: 'tests/shots/probe-slow-resized.png' });
  await browser.close();
} finally {
  preview.kill('SIGTERM');
  if (browser?.isConnected()) await browser.close().catch(() => {});
}
