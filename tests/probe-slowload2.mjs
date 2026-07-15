/**
 * Simulate the public cold-cache path: strip COOP/COEP headers (forces the
 * COI service worker register+reload) and slow the whole connection via CDP.
 * Dumps camera/device state every second.
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
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('console.error:', m.text().slice(0, 160)); });

  const mode = process.argv[2] ?? 'sw';
  if (mode === 'sw') {
    // strip isolation headers → coi-serviceworker must register + reload (cold public host)
    await page.route('**/*', (route) => {
      if (route.request().resourceType() === 'document') {
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: undefined,
          path: undefined,
          headers: {},
        }).catch(async () => {
          const res = await route.fetch();
          await route.fulfill({ response: res, headers: { ...res.headers(), 'cross-origin-opener-policy': '', 'cross-origin-embedder-policy': '' } });
        });
        return;
      }
      route.continue();
    });
    // simpler & robust: fulfill document from fetch with stripped headers
    await page.unroute('**/*');
    await page.route('**/*', async (route) => {
      const res = await route.fetch();
      const headers = { ...res.headers() };
      delete headers['cross-origin-opener-policy'];
      delete headers['cross-origin-embedder-policy'];
      await route.fulfill({ response: res, headers });
    });
    // hold the GLB for 3s on top
    await page.route('**/models/gba.glb', async (route) => { await sleep(3000); await route.continue(); });
  } else if (mode === 'cdp') {
    const client = await ctx.newCDPSession(page);
    await client.send('Network.enable');
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 400,
      downloadThroughput: (1.5 * 1024 * 1024) / 8, // 1.5 Mbps
      uploadThroughput: (750 * 1024) / 8,
    });
  }

  await page.goto('http://127.0.0.1:5181/', { waitUntil: 'load' });

  const dump = (tag) =>
    page.evaluate((t) => {
      const g = window.__GBA;
      if (!g) return { tag: t, boot: false };
      const c = g.scene3d.camera;
      const loaded = g.scene3d.handheld.getButtonWorldPos('A') !== null;
      // device world bbox via Box3-like scan of glb root
      let bb = null;
      const root = g.scene3d.handheld.group.getObjectByName('gba-glb');
      if (root) {
        const V = g.scene3d.camera.position.constructor;
        const p = new V();
        root.updateMatrixWorld(true);
        let minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9;
        root.traverse((o) => {
          if (!o.isMesh || !o.geometry?.attributes?.position) return;
          const pos = o.geometry.attributes.position;
          for (let i = 0; i < pos.count; i += 97) {
            p.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
            if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
            if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
          }
        });
        bb = { min: [minX, minY, minZ].map((n) => +n.toFixed(1)), max: [maxX, maxY, maxZ].map((n) => +n.toFixed(1)) };
      }
      const project = (x, y, z) => {
        const v = new (g.scene3d.camera.position.constructor)(x, y, z).project(c);
        return { x: +((v.x * 0.5 + 0.5) * innerWidth).toFixed(0), y: +((-v.y * 0.5 + 0.5) * innerHeight).toFixed(0) };
      };
      return {
        tag: t,
        isolated: window.crossOriginIsolated,
        loaded,
        camPos: c.position.toArray().map((n) => +n.toFixed(1)),
        layout: g.scene3d.layoutMode,
        deviceBbox: bb,
        projCenter: project(0, 0, 0),
        projBottom: project(0, -42, 0),
      };
    }, tag);

  for (let s = 2; s <= 12; s += 2) {
    await sleep(2000);
    console.log(JSON.stringify(await dump(`t=${s}s`)));
  }
  await page.screenshot({ path: `tests/shots/probe-slow2-final.png` });
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await sleep(800);
  await page.screenshot({ path: `tests/shots/probe-slow2-resized.png` });
  console.log('done mode=' + mode);
  await ctx.close();
} finally {
  preview.kill('SIGTERM');
  if (browser?.isConnected()) await browser.close().catch(() => {});
}
