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
  page.on('console', (m) => console.log(`[${m.type()}] ${m.text().slice(0, 200)}`));
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

    // 1) is the core thread responsive? saveState interrupts the thread
    try {
      const ok = m.saveState(0);
      const files = m.FS.readdir('/data/states');
      let size = -1;
      for (const f of files) {
        if (f.endsWith('.ss0')) size = m.FS.readFile('/data/states/' + f).length;
      }
      log.push(['saveState(0)', ok, 'stateFileSize', size]);
    } catch (e) {
      log.push(['saveState err', String(e)]);
    }

    // 2) quit + threadedVideo:true + reload
    try {
      m.quitGame();
      m.setCoreSettings({ threadedVideo: true });
      const romPath = m.gameName;
      const ok = m.loadGame(romPath);
      log.push(['reload with threadedVideo:true', ok]);
      await new Promise((r) => setTimeout(r, 3000));
      log.push(['frames after threadedVideo reload', a.frameCount]);
      m.screenshot('p2.png');
      const png = m.FS.readFile('/data/screenshots/p2.png');
      const blob = new Blob([png], { type: 'image/png' });
      const bmp = await createImageBitmap(blob);
      const t2 = document.createElement('canvas');
      t2.width = bmp.width; t2.height = bmp.height;
      const c2 = t2.getContext('2d');
      c2.drawImage(bmp, 0, 0);
      const d = c2.getImageData(0, 0, bmp.width, bmp.height).data;
      let nb = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 12) nb++;
      log.push(['threadedVideo screenshot', bmp.width + 'x' + bmp.height, 'nonBlack', nb]);
    } catch (e) {
      log.push(['threadedVideo err', String(e)]);
    }

    // 3) quit + timestepSync:false
    try {
      m.quitGame();
      m.setCoreSettings({ threadedVideo: false, timestepSync: false });
      const ok = m.loadGame(m.gameName);
      log.push(['reload with timestepSync:false', ok]);
      await new Promise((r) => setTimeout(r, 3000));
      log.push(['frames after timestepSync:false', a.frameCount]);
    } catch (e) {
      log.push(['timestep err', String(e)]);
    }
  });
  const out = await page.evaluate(() => window.__LOG__);
  for (const row of out) console.log(JSON.stringify(row));
  await browser.close();
} finally {
  preview.kill('SIGTERM');
  if (browser?.isConnected()) await browser.close().catch(() => {});
}
