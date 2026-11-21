// Records the website half of the demo video with the system Chromium (headless).
//   node demo/record_web.js OUTDIR SESSION_ID
// Opens the live landing page, then the local dev web app signed in as Maya (dashboard + session).
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const OUT = path.resolve(process.argv[2] || 'out');
const SESSION_ID = process.argv[3];
const LIVE = 'https://downbeat-919f8.web.app';
const LOCAL = 'http://localhost:3000';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function smoothScroll(page, to, ms = 2500) {
  await page.evaluate(async ({ to, ms }) => {
    const from = window.scrollY, start = performance.now();
    await new Promise((done) => {
      const step = (now) => {
        const t = Math.min(1, (now - start) / ms), e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        window.scrollTo(0, from + (to - from) * e);
        t < 1 ? requestAnimationFrame(step) : done();
      };
      requestAnimationFrame(step);
    });
  }, { to, ms });
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--hide-scrollbars'] });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1.5,
    recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
  });
  await context.addInitScript(() => {
    if (location.hostname === 'localhost')
      localStorage.setItem('downbeat_dev_user', JSON.stringify({ uid: 'dev-user-maya', email: 'maya@downbeat.audio', displayName: 'Maya' }));
  });
  // Recording cosmetics: hide the local test-login badge and the Next.js dev-mode indicator
  await context.addInitScript(() => {
    const css = '[data-dev-badge],nextjs-portal{display:none!important}';
    document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); });
  });
  const page = await context.newPage();
  const marks = [];
  const t0 = Date.now();
  const mark = (name) => { marks.push({ t: (Date.now() - t0) / 1000, name }); console.log(marks.at(-1)); };

  mark('landing');
  await page.goto(LIVE, { waitUntil: 'networkidle' });
  await pause(3500);
  await smoothScroll(page, 500, 3000);
  await pause(2000);

  mark('dashboard');
  await page.goto(`${LOCAL}/dashboard`, { waitUntil: 'networkidle' });
  await pause(4500);

  mark('session');
  await page.goto(`${LOCAL}/session?id=${SESSION_ID}`, { waitUntil: 'networkidle' });
  await pause(4500);
  const height = await page.evaluate(() => document.body.scrollHeight);
  await smoothScroll(page, Math.min(height - 720, 520), 3500);
  await pause(4000);
  mark('agents');
  await smoothScroll(page, height - 720, 3500);
  await pause(5000);
  mark('end');

  const video = page.video();
  await context.close();
  await browser.close();
  fs.renameSync(await video.path(), path.join(OUT, 'web.webm'));
  fs.writeFileSync(path.join(OUT, 'web-marks.json'), JSON.stringify(marks, null, 1));
  console.log('recorded', path.join(OUT, 'web.webm'));
})();
