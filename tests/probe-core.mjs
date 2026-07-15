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
    // create adapter through the app's insert (it shares the singleton)
    g.insertById('cascade7');
    await new Promise((r) => setTimeout(r, 3000));
    const a = g.getAdapter();
    const m = a.module;
    log.push(['adapter', !!a, 'gameName', m.gameName, 'frames', a.frameCount]);
    log.push(['SDL2 keys', Object.keys(m.SDL2 || {}), 'ctx?', !!m.SDL2?.ctx, 'audioCtx', m.SDL2?.audioContext?.state]);
    const canvas = document.getElementById('emu-canvas');
    const ctx = canvas.getContext('2d');
    const sample = () => {
      const d = ctx.getImageData(0, 0, 240, 160).data;
      let nb = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 12) nb++;
      return nb;
    };
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      log.push(['poll', i, 'frames', a.frameCount, 'nonBlack', sample()]);
    }
    log.push(['calling resumeGame...']);
    try { m.resumeGame(); } catch (e) { log.push(['resumeGame err', String(e)]); }
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      log.push(['poll-after-resume', i, 'frames', a.frameCount, 'nonBlack', sample()]);
    }
    // try fast-forward / manual tick probes
    log.push(['isFF', typeof m.getFastForwardMultiplier === 'function' ? m.getFastForwardMultiplier() : 'n/a']);
    try { m.setFastForwardMultiplier(2); } catch (e) { log.push(['ff err', String(e)]); }
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      log.push(['poll-ff', i, 'frames', a.frameCount, 'nonBlack', sample()]);
    }
  });
  const out = await page.evaluate(() => window.__LOG__);
  for (const row of out) console.log(JSON.stringify(row));
  await browser.close();
} finally {
  preview.kill('SIGTERM');
  if (browser?.isConnected()) await browser.close().catch(() => {});
}
