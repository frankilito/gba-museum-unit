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

  await page.evaluate(async () => {
    const log = [];
    window.__LOG__ = log;
    const g = window.__GBA;
    g.insertById('cascade7');
    await new Promise((r) => setTimeout(r, 4000));
    const a = g.getAdapter();
    const m = a.module;
    const canvas = document.getElementById('emu-canvas');

    // cross-context readback: copy via drawImage into a temp 2d canvas
    const tmp = document.createElement('canvas');
    tmp.width = 240; tmp.height = 160;
    const tctx = tmp.getContext('2d');
    const sample = () => {
      tctx.clearRect(0, 0, 240, 160);
      tctx.drawImage(canvas, 0, 0, 240, 160);
      const d = tctx.getImageData(0, 0, 240, 160).data;
      let nb = 0;
      const colors = new Set();
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] + d[i + 1] + d[i + 2] > 12) nb++;
        if (i % 4000 === 0) colors.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      }
      return { nb, colors: colors.size };
    };

    log.push(['gameName', m.gameName, 'frames', a.frameCount, 'canvasCtxType', (() => { try { return canvas.getContext('2d') ? '2d' : 'not-2d'; } catch { return 'err'; } })()]);
    log.push(['Module.ctx?', !!m.ctx, 'SDL2 keys', Object.keys(m.SDL2 || {})]);
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      log.push(['poll', i, 'frames', a.frameCount, JSON.stringify(sample())]);
    }
    // core-side screenshot: independent of canvas
    try {
      m.screenshot('probe.png');
      const files = m.FS.readdir('/data/screenshots');
      log.push(['screenshots dir', files]);
      const png = m.FS.readFile('/data/screenshots/probe.png');
      log.push(['png bytes', png.length]);
      // decode PNG via browser
      const blob = new Blob([png], { type: 'image/png' });
      const bmp = await createImageBitmap(blob);
      const t2 = document.createElement('canvas');
      t2.width = bmp.width; t2.height = bmp.height;
      const c2 = t2.getContext('2d');
      c2.drawImage(bmp, 0, 0);
      const d = c2.getImageData(0, 0, bmp.width, bmp.height).data;
      let nb = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 12) nb++;
      log.push(['screenshot decode', bmp.width + 'x' + bmp.height, 'nonBlack', nb]);
    } catch (e) {
      log.push(['screenshot err', String(e)]);
    }
    // runtime responsiveness
    try { log.push(['ffm', m.getFastForwardMultiplier()]); } catch (e) { log.push(['ffm err', String(e)]); }
    try { m.resumeGame(); log.push(['resumeGame ok']); } catch (e) { log.push(['resumeGame err', String(e)]); }
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      log.push(['poll2', i, 'frames', a.frameCount, JSON.stringify(sample())]);
    }
  });
  const out = await page.evaluate(() => window.__LOG__);
  for (const row of out) console.log(JSON.stringify(row));
  await browser.close();
} finally {
  preview.kill('SIGTERM');
  if (browser?.isConnected()) await browser.close().catch(() => {});
}
