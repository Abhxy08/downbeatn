// Renders the title cards (1920x1080 PNG) for the demo video.  node demo/render_cards.js OUTDIR
const { chromium } = require('playwright-core');
const path = require('path');

const OUT = path.resolve(process.argv[2] || 'out');
const cards = {
  intro: `<div class="kicker">Google Buildathon</div>
          <h1>DownBeat</h1>
          <p class="lead">Make music together, live, from any DAW.</p>
          <p class="sub">Shared MIDI clip · Live audio · Google AI agents</p>`,
  jam: `<div class="kicker">Part 1</div><h2>Two producers, two laptops</h2>
        <p class="lead">Maya and Leo each run the DownBeat plugin and join one session.</p>`,
  web: `<div class="kicker">Part 2</div><h2>The session on the web</h2>
        <p class="lead">Who is online, who did what, and every AI report — in the browser.</p>`,
  outro: `<h1>DownBeat</h1>
          <p class="lead">downbeat-919f8.web.app</p>
          <p class="sub">JUCE plugin (VST3 · AU · Standalone) · Cloud Run · Firestore · Gemini · Lyria RealTime</p>`,
};

const page = (body) => `<!doctype html><html><head><style>
  html,body{margin:0;width:1920px;height:1080px;background:#0b0f17;color:#e2e8f0;font-family:'Google Sans',sans-serif}
  body{display:flex;flex-direction:column;justify-content:center;padding:0 180px;box-sizing:border-box;
       background:radial-gradient(1200px 700px at 80% 20%,rgba(56,189,248,.16),transparent 60%),
                  radial-gradient(900px 600px at 10% 90%,rgba(99,102,241,.18),transparent 60%),#0b0f17}
  .kicker{color:#38bdf8;font-size:30px;letter-spacing:.18em;text-transform:uppercase;margin-bottom:24px}
  h1{font-size:150px;margin:0;letter-spacing:-.03em;font-weight:700}
  h2{font-size:96px;margin:0;letter-spacing:-.02em;font-weight:700}
  .lead{font-size:52px;color:#cbd5e1;margin:32px 0 0}
  .sub{font-size:32px;color:#94a3b8;margin:28px 0 0}
  .bar{position:absolute;left:180px;bottom:120px;width:240px;height:8px;border-radius:4px;background:linear-gradient(90deg,#38bdf8,#6366f1)}
</style></head><body>${body}<div class="bar"></div></body></html>`;

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
  const p = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  for (const [name, body] of Object.entries(cards)) {
    await p.setContent(page(body), { waitUntil: 'load' });
    await p.screenshot({ path: path.join(OUT, `card-${name}.png`) });
  }
  await browser.close();
  console.log('cards rendered');
})();
