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
  page.on('console', (m) => console.log(`[${m.type()}] ${m.text().slice(0, 160)}`));

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
    const ctx = m.SDL2?.audioContext;
    log.push(['audioCtx state', ctx?.state, 'rate', ctx?.sampleRate]);
    log.push(['frames', a.frameCount]);
    // try resuming audio context
    try { await ctx.resume(); log.push(['after resume()', ctx.state]); } catch (e) { log.push(['resume err', String(e)]); }
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 800));
      log.push(['poll', i, 'frames', a.frameCount, 'audio', ctx.state]);
    }
    // probe: ScriptProcessorNode actually firing?
    const sp = m.SDL2?.audio?.scriptProcessorNode;
    log.push(['scriptProcessorNode', !!sp, 'bufferSize', sp?.bufferSize]);
  });
  const out = await page.evaluate(() => window.__LOG__);
  for (const row of out) console.log(JSON.stringify(row));
  await browser.close();
} finally {
  preview.kill('SIGTERM');
  if (browser?.isConnected()) await browser.close().catch(() => {});
}
