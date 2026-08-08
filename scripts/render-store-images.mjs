#!/usr/bin/env node
// Renders the App Store / driver images from the HTML designs in scripts/design/
// with a headless Chromium (via playwright-core, which drives the browser through
// the DevTools protocol so the viewport is exactly the requested size — a plain
// `chromium --window-size --screenshot` reserves ~87px of chrome and leaks the
// page background at the bottom). The vw-based layouts scale crisply to every size.
//
// Chromium is located via CHROME_BIN, else the first build under
// PLAYWRIGHT_BROWSERS_PATH (defaults to /opt/pw-browsers). This is a manual,
// one-off tool — the generated PNGs are committed, so CI never needs Chromium.
//
//   node scripts/render-store-images.mjs

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const design = path.join(__dirname, 'design');

function findChrome() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (fs.existsSync(base)) {
    for (const dir of fs.readdirSync(base)) {
      const p = path.join(base, dir, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('Chromium not found. Set CHROME_BIN to a Chromium/Chrome binary.');
}

const jobs = [
  { html: 'app-image.html',   out: 'assets/images/small.png',  w: 250,  h: 175 },
  { html: 'app-image.html',   out: 'assets/images/large.png',  w: 500,  h: 350 },
  { html: 'app-image.html',   out: 'assets/images/xlarge.png', w: 1000, h: 700 },
  { html: 'driver-tile.html?glyph=server', out: 'drivers/server/assets/images/small.png',  w: 75,   h: 75 },
  { html: 'driver-tile.html?glyph=server', out: 'drivers/server/assets/images/large.png',  w: 500,  h: 500 },
  { html: 'driver-tile.html?glyph=server', out: 'drivers/server/assets/images/xlarge.png', w: 1000, h: 1000 },
  { html: 'driver-tile.html?glyph=user',   out: 'drivers/user/assets/images/small.png',    w: 75,   h: 75 },
  { html: 'driver-tile.html?glyph=user',   out: 'drivers/user/assets/images/large.png',    w: 500,  h: 500 },
  { html: 'driver-tile.html?glyph=user',   out: 'drivers/user/assets/images/xlarge.png',   w: 1000, h: 1000 },
  { html: 'driver-tile.html?glyph=player', out: 'drivers/player/assets/images/small.png',  w: 75,   h: 75 },
  { html: 'driver-tile.html?glyph=player', out: 'drivers/player/assets/images/large.png',  w: 500,  h: 500 },
  { html: 'driver-tile.html?glyph=player', out: 'drivers/player/assets/images/xlarge.png', w: 1000, h: 1000 },
  // Widget gallery previews: 1024x1024, transparent background, one distinct
  // mockup per widget (store guideline 1.9).
  { html: 'widget-preview.html?widget=server_overview&theme=light', out: 'widgets/server_overview/preview-light.png', w: 1024, h: 1024, transparent: true },
  { html: 'widget-preview.html?widget=server_overview&theme=dark',  out: 'widgets/server_overview/preview-dark.png',  w: 1024, h: 1024, transparent: true },
  { html: 'widget-preview.html?widget=now_playing&theme=light',     out: 'widgets/now_playing/preview-light.png',     w: 1024, h: 1024, transparent: true },
  { html: 'widget-preview.html?widget=now_playing&theme=dark',      out: 'widgets/now_playing/preview-dark.png',      w: 1024, h: 1024, transparent: true },
  { html: 'widget-preview.html?widget=recently_added&theme=light',  out: 'widgets/recently_added/preview-light.png',  w: 1024, h: 1024, transparent: true },
  { html: 'widget-preview.html?widget=recently_added&theme=dark',   out: 'widgets/recently_added/preview-dark.png',   w: 1024, h: 1024, transparent: true },
];

// Optional filter: `node scripts/render-store-images.mjs <substring>` renders
// only the jobs whose output path contains the substring (e.g. a widget id).
const filter = process.argv[2];
const selected = filter ? jobs.filter((j) => j.out.includes(filter)) : jobs;
if (!selected.length) {
  console.error(`No jobs match filter "${filter}".`);
  process.exit(1);
}

const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
try {
  for (const job of selected) {
    const [file, query] = job.html.split('?');
    const url = pathToFileURL(path.join(design, file)).href + (query ? '?' + query : '');
    const page = await browser.newPage({ viewport: { width: job.w, height: job.h }, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: 'networkidle' });
    const out = path.join(root, job.out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await page.screenshot({
      path: out,
      clip: { x: 0, y: 0, width: job.w, height: job.h },
      omitBackground: job.transparent === true,
    });
    await page.close();
    console.log('wrote', job.out, `(${job.w}x${job.h})`);
  }
} finally {
  await browser.close();
}
console.log('Done.');
