/**
 * WebKit (Safari engine) smoke test: page loads, COI active, a ROM boots and
 * produces frames, no console errors. Run after `npm run build`.
 */
import { webkit } from 'playwright';
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
    } catch { /* not up */ }
    await sleep(250);
  }
  throw new Error('preview server did not start');
}

const preview = spawn('npx', ['vite', 'preview'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: 'ignore',
});

let failures = 0;
let browser;
try {
  await waitForServer(BASE);
  browser = await webkit.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__GBA && window.__GBA.stateName, null, { timeout: 20000 });

  const isolated = await page.evaluate(() => window.crossOriginIsolated);
  console.log(`${isolated ? 'PASS' : 'FAIL'}  webkit: cross-origin isolation`);
  if (!isolated) failures++;

  await page.evaluate(() => window.__GBA.insertById('cascade7'));
  const playing = await page
    .waitForFunction(() => window.__GBA.stateName() === 'PLAYING', null, { timeout: 40000 })
    .then(() => true)
    .catch(() => false);
  console.log(`${playing ? 'PASS' : 'FAIL'}  webkit: cascade7 boots to PLAYING`);
  if (!playing) failures++;

  if (playing) {
    await sleep(1500);
    const frames = await page.evaluate(async () => {
      const a = window.__GBA.getAdapter();
      const f0 = a.frameCount;
      await new Promise((r) => setTimeout(r, 1000));
      return a.frameCount - f0;
    });
    console.log(`${frames > 15 ? 'PASS' : 'FAIL'}  webkit: core frames advancing (${frames}/s)`);
    if (frames <= 15) failures++;
    const sample = await page.evaluate(() => window.__GBA.screenSample());
    console.log(`${sample.unique >= 2 ? 'PASS' : 'FAIL'}  webkit: screen imagery (${sample.unique} colors)`);
    if (sample.unique < 2) failures++;
  }

  await page.screenshot({ path: `${SHOTS}09-webkit.png` });
  const real = errors.filter((e) => !/favicon|deprecat/i.test(e));
  console.log(`${real.length === 0 ? 'PASS' : 'FAIL'}  webkit: console clean${real.length ? ': ' + real.slice(0, 3).join(' | ') : ''}`);
  if (real.length) failures++;

  await browser.close();
} finally {
  preview.kill('SIGTERM');
  if (browser?.isConnected()) await browser.close().catch(() => {});
}

console.log(failures === 0 ? '\nWEBKIT SMOKE PASSED' : `\n${failures} WEBKIT CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
