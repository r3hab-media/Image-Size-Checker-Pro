// Generates the Chrome Web Store images in store/: 1280x800 screenshots and the 440x280 promo tile.
// It loads the unpacked extension in Chrome, captures the real popup on the built-in playground,
// and frames each capture with a caption. Set CHROME_PATH if Chrome is not in the default location.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'store');
const CHROME =
  process.env.CHROME_PATH ||
  {
    win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    linux: '/usr/bin/google-chrome'
  }[process.platform];

const fileUrl = (rel) => 'data:' + (rel.endsWith('.svg') ? 'image/svg+xml' : 'image/png') + ';base64,' + fs.readFileSync(path.join(ROOT, rel)).toString('base64');
const fontFace = (family, file, weight) =>
  `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${fs.readFileSync(path.join(ROOT, 'fonts', file)).toString('base64')}) format("woff2");font-weight:${weight}}`;
const FONTS =
  fontFace('Rubik', 'rubik-latin-wght-normal.woff2', '300 900') +
  fontFace('Space Mono', 'space-mono-latin-400-normal.woff2', 400) +
  fontFace('Space Mono', 'space-mono-latin-700-normal.woff2', 700);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  pipe: true,
  enableExtensions: true,
  headless: true,
  args: ['--no-first-run', '--no-default-browser-check']
});
const extId = await browser.installExtension(ROOT);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

// The playground page, scanned, with on-page badges.
const demo = await browser.newPage();
await demo.setViewport({ width: 1280, height: 800 });
await demo.goto(`chrome-extension://${extId}/demo-playground.html`);
await demo.waitForFunction(() => [...document.images].every((i) => i.complete));
const tabId = await demo.evaluate(async () => (await chrome.tabs.getCurrent()).id);

async function popupCapture(name, before) {
  const p = await browser.newPage();
  await p.setViewport({ width: 750, height: 600 });
  await p.goto(`chrome-extension://${extId}/popup.html`);
  await p.evaluate((id) => window.__iscPopup.ensureAndScan(true, id), tabId);
  await sleep(3000); // measured savings and fonts
  // The real label is chrome-extension://<random id>/..., which means nothing to store visitors.
  await p.evaluate(() => (document.getElementById('pageHostLabel').textContent = 'Built-in playground page'));
  if (before) await p.evaluate(before);
  await sleep(500);
  const file = path.join(OUT, `.capture-${name}.png`);
  await p.screenshot({ path: file });
  await p.close();
  return file;
}

const report = await popupCapture('report');
const preview = await popupCapture('preview', async () => {
  document.querySelector('.mini-btn[data-act="preview"]').click();
  const stats = document.getElementById('previewStats');
  for (let i = 0; i < 100 && !stats.dataset.after; i++) await new Promise((r) => setTimeout(r, 50));
});

await demo.bringToFront();
await sleep(800);
const pageShot = path.join(OUT, '.capture-page.png');
await demo.screenshot({ path: pageShot });

// Compose the store images.
const stage = await browser.newPage();
const b64 = (f) => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
const BASE = `${FONTS}
  *{box-sizing:border-box;margin:0}
  body{font-family:Rubik,sans-serif;color:#111;background:#eef0ff}
  .sticker{border:3px solid #111;border-radius:16px;box-shadow:6px 6px 0 #111;overflow:hidden;background:#fff}
  h1{font-size:46px;font-weight:800;line-height:1.08;letter-spacing:-0.02em}
  p{font-size:21px;line-height:1.45;color:#3d3d52;margin-top:18px}
  .tag{display:inline-block;padding:4px 14px;border:3px solid #111;border-radius:999px;font-weight:800;font-size:16px;margin-bottom:20px}`;

async function compose(name, width, height, html) {
  await stage.setViewport({ width, height, deviceScaleFactor: 1 });
  await stage.setContent(`<style>${BASE}</style>${html}`);
  await stage.evaluate(() => document.fonts.ready);
  await sleep(200);
  await stage.screenshot({ path: path.join(OUT, name) });
  console.log('store/' + name);
}

const shot = (img, tag, tagColor, title, body) => `
  <div style="width:1280px;height:800px;display:flex;align-items:center;gap:56px;padding:0 60px 0 70px">
    <div style="flex:1;min-width:0">
      <img src="${fileUrl('icons/logo.svg')}" style="width:84px;height:84px;margin:0 0 18px -8px">
      <div><span class="tag" style="background:${tagColor}">${tag}</span></div>
      <h1>${title}</h1>
      <p>${body}</p>
    </div>
    <div class="sticker" style="width:750px;height:600px;flex-shrink:0;transform:rotate(1deg)"><img src="${img}" style="display:block;width:750px;height:600px"></div>
  </div>`;

await compose(
  'screenshot-1-report.png',
  1280,
  800,
  shot(b64(report), 'Audit', '#ffd43b', 'See what every image really weighs', 'File size, pixel dimensions and how each image is displayed, with the savings measured by actually compressing it.')
);
await compose(
  'screenshot-2-preview.png',
  1280,
  800,
  shot(b64(preview), 'Compress', '#2bd67b', 'Smaller files, same name and format', 'Compare before and after, pick the quality, and save a drop-in replacement. Or compress everything into one ZIP.')
);
await compose(
  'screenshot-3-page.png',
  1280,
  800,
  `<div style="width:1280px;height:800px;padding:36px 48px;display:flex;flex-direction:column;gap:22px">
     <div style="display:flex;align-items:center;gap:18px">
       <img src="${fileUrl('icons/logo.svg')}" style="width:64px;height:64px">
       <h1 style="font-size:38px">Badges right on the page</h1>
       <span class="tag" style="background:#ff6fae;margin:0 0 0 auto">Inspect</span>
     </div>
     <div class="sticker" style="flex:1;min-height:0"><img src="${b64(pageShot)}" style="display:block;width:100%;height:100%;object-fit:cover;object-position:top"></div>
   </div>`
);
await compose(
  'promo-small-440x280.png',
  440,
  280,
  `<div style="width:440px;height:280px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:#ffd43b;border:4px solid #111">
     <img src="${fileUrl('icons/logo.svg')}" style="width:112px;height:112px">
     <div style="font-size:30px;font-weight:800;letter-spacing:-0.02em">Image Size Checker <span style="display:inline-block;font-size:15px;padding:2px 9px;border:3px solid #111;border-radius:999px;background:#ff6fae;transform:rotate(4deg);vertical-align:middle">PRO</span></div>
     <div style="font-size:16px;font-weight:600">Find heavy images. Shrink them in one click.</div>
   </div>`
);

for (const f of [report, preview, pageShot]) fs.unlinkSync(f);
await browser.close();
