import { chromium } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';

for (const headless of [true, false]) {
  const browser = await chromium.launch({
    headless,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.setContent('<html><body>audio probe</body></html>');
  const result = await page.evaluate(async () => {
    const ctx = new AudioContext();
    await ctx.resume();
    const sp = ctx.createScriptProcessor(1024, 0, 1);
    let callbacks = 0;
    sp.onaudioprocess = () => callbacks++;
    const osc = ctx.createOscillator();
    osc.connect(ctx.destination);
    sp.connect(ctx.destination);
    osc.start();
    const t0 = ctx.currentTime;
    await new Promise((r) => setTimeout(r, 1000));
    return { state: ctx.state, callbacks, timeAdvanced: ctx.currentTime - t0 };
  });
  console.log(`headless=${headless}`, JSON.stringify(result));
  await browser.close();
}
