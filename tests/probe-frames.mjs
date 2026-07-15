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

const preview = spawn('npx', ['vite', 'preview'], { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore' });
let browser;
try {
  await waitForServer(BASE);
  browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', (m) => console.log(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__GBA?.stateName, null, { timeout: 15000 });

  // Bypass the app flow: drive the adapter directly.
  const result = await page.evaluate(async () => {
    const { EmulatorAdapter } = await import('/src/core/EmulatorAdapter.ts').catch(() => ({}));
    return 'vite preview has no ts modules';
  }).catch((e) => String(e));
  console.log('skip ts import (expected on preview):', result);

  // Instead, use the app's own adapter factory via a manual insert, but watch pixels.
  await page.evaluate(async () => {
    window.__PIX__ = [];
    const canvas = document.getElementById('emu-canvas');
    const ctx = canvas.getContext('2d');
    const g = window.__GBA;
    // hook adapter creation
    const origInsert = g.insertById;
    g.insertById('cascade7');
    const t0 = performance.now();
    while (performance.now() - t0 < 14000) {
      await new Promise((r) => setTimeout(r, 1000));
      let nonBlack = -1;
      try {
        const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        nonBlack = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 12) nonBlack++;
      } catch (e) { nonBlack = -2; }
      window.__PIX__.push({
        t: Math.round(performance.now() - t0),
        state: g.stateName(),
        adapter: !!g.getAdapter(),
        frames: g.getAdapter()?.frameCount ?? -1,
        canvasW: canvas.width,
        nonBlack,
      });
    }
  });
  const pix = await page.evaluate(() => window.__PIX__);
  for (const row of pix) console.log(JSON.stringify(row));
  await browser.close();
} finally {
  preview.kill('SIGTERM');
  if (browser?.isConnected()) await browser.close().catch(() => {});
}
