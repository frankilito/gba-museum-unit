import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = 'http://127.0.0.1:5181/';
async function waitForServer(url, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
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
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}\n${e.stack}`));
  page.on('requestfailed', (r) => console.log(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400) console.log(`[${r.status()}] ${r.url()}`); });

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__GBA?.stateName, null, { timeout: 15000 });
  console.log('--- app ready, state:', await page.evaluate(() => window.__GBA.stateName()));

  // watch state transitions
  await page.evaluate(() => {
    window.__STATES__ = [];
    window.__GBA.fsm.onChange((to, from) => window.__STATES__.push(`${from}->${to}`));
  });

  await page.evaluate(() => window.__GBA.insertById('cascade7'));
  for (let i = 0; i < 12; i++) {
    await sleep(2000);
    const s = await page.evaluate(() => ({
      state: window.__GBA.stateName(),
      transitions: window.__STATES__,
      hasAdapter: !!window.__GBA.getAdapter(),
    }));
    console.log(`t+${(i + 1) * 2}s`, JSON.stringify(s));
    if (s.state === 'PLAYING' || (i > 3 && s.state === 'OFF' && s.transitions.length > 2)) break;
  }
  await page.screenshot({ path: new URL('./shots/debug-boot.png', import.meta.url).pathname });
  await browser.close();
} finally {
  preview.kill('SIGTERM');
  if (browser?.isConnected()) await browser.close().catch(() => {});
}
