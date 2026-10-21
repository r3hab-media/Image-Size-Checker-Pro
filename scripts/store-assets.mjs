// Generates the store images in store/: 1280x800 screenshots, the 440x280 and 1400x560 promo tiles,
// and the 300x300 logo that Edge Add-ons asks for (Chrome uses icons/icon128.png).
// It loads the unpacked extension in Chrome, captures the real popup on the built-in playground,
// and frames each capture with a caption. It then builds the project site's images in docs/img (see buildSiteImages).
// Set CHROME_PATH if Chrome is not in the default location. Pass --site-only to skip the captures and
// rebuild only docs/img from the committed store images.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'store');
const SITE = path.join(ROOT, 'docs', 'img');
// --site-only rebuilds the project site's images from the committed store images, without new captures.
const SITE_ONLY = process.argv.includes('--site-only');
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

// Composes HTML into an image file.
const stage = await browser.newPage();
const b64 = (f) => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
const BASE = `${FONTS}
  *{box-sizing:border-box;margin:0}
  body{font-family:Rubik,sans-serif;color:#111;background:#eef0ff}
  .sticker{border:3px solid #111;border-radius:16px;box-shadow:6px 6px 0 #111;overflow:hidden;background:#fff}
  h1{font-size:46px;font-weight:800;line-height:1.08;letter-spacing:-0.02em}
  p{font-size:21px;line-height:1.45;color:#3d3d52;margin-top:18px}
  .tag{display:inline-block;padding:4px 14px;border:3px solid #111;border-radius:999px;font-weight:800;font-size:16px;margin-bottom:20px}`;

async function compose(name, width, height, html, { transparent = false, dir = OUT } = {}) {
  await stage.setViewport({ width, height, deviceScaleFactor: 1 });
  await stage.setContent(`<style>${BASE}</style>${html}`);
  await stage.evaluate(() => document.fonts.ready);
  await sleep(200);
  const file = path.join(dir, name);
  await stage.screenshot({ path: file, omitBackground: transparent });
  console.log(path.relative(ROOT, file).split(path.sep).join('/'));
  return file;
}

if (!SITE_ONLY) {
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

// Marquee: only shown if Google features the extension. The popup is scaled to about 75% so it fits the 560px height.
await compose(
  'promo-marquee-1400x560.png',
  1400,
  560,
  `<div style="width:1400px;height:560px;display:flex;align-items:center;gap:40px;padding:0 70px 0 90px;background:#ffd43b;border:5px solid #111;overflow:hidden">
     <div style="flex:1;min-width:0">
       <div style="display:flex;align-items:center;gap:16px;margin-bottom:26px">
         <img src="${fileUrl('icons/logo.svg')}" style="width:96px;height:96px;margin-left:-10px">
         <div style="font-size:32px;font-weight:800;letter-spacing:-0.02em">Image Size Checker <span style="display:inline-block;font-size:16px;padding:2px 10px;border:3px solid #111;border-radius:999px;background:#ff6fae;transform:rotate(4deg);vertical-align:middle">PRO</span></div>
       </div>
       <h1 style="font-size:52px">Find heavy images.<br>Shrink them in one click.</h1>
       <p style="color:#111;font-size:22px">Same filename, same format, same dimensions. No accounts, no tracking.</p>
     </div>
     <div class="sticker" style="width:560px;height:448px;flex-shrink:0;transform:rotate(2deg);background:#fff"><img src="${b64(report)}" style="display:block;width:560px;height:448px"></div>
   </div>`
);

// Edge Add-ons store logo: 1:1, 300x300 recommended. The icon on a transparent background.
await compose(
  'logo-300x300.png',
  300,
  300,
  `<style>body{background:transparent}</style><img src="${fileUrl('icons/logo.svg')}" style="display:block;width:300px;height:300px">`,
  { transparent: true }
);

for (const f of [report, preview, pageShot]) fs.unlinkSync(f);
}

await buildSiteImages();
await browser.close();

// Project site images (docs/img): WebP copies of the store screenshots at three widths, the 1200x630
// share image for Open Graph and X cards, and the logo. The share image goes through the extension's
// own PNG optimizer, keeping the lossy result only when it is near-identical (36 dB PSNR).
async function buildSiteImages() {
  const { optimizePngLossless, optimizePngLossy } = await import('../js/png.js');
  fs.mkdirSync(SITE, { recursive: true });
  const kb = (n) => (n / 1024).toFixed(0) + ' KB';

  await stage.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await stage.setContent('<p>encode</p>');
  for (const name of ['screenshot-1-report', 'screenshot-2-preview', 'screenshot-3-page']) {
    for (const width of [640, 960, 1280]) {
      const webp = await stage.evaluate(async (src, width) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = width;
        c.height = Math.round((img.naturalHeight * width) / img.naturalWidth);
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, c.width, c.height);
        return c.toDataURL('image/webp', 0.82).split(',')[1];
      }, b64(path.join(OUT, name + '.png')), width);
      const file = path.join(SITE, `${name}-${width}.webp`);
      fs.writeFileSync(file, Buffer.from(webp, 'base64'));
      console.log(`docs/img/${name}-${width}.webp ${kb(fs.statSync(file).size)}`);
    }
  }

  const og = await compose(
    'og-image.png',
    1200,
    630,
    `<div style="width:1200px;height:630px;display:flex;align-items:center;gap:36px;padding:0 0 0 70px;background:#ffd43b;border:6px solid #111;overflow:hidden">
       <div style="flex:1;min-width:0">
         <div style="display:flex;align-items:center;gap:14px;margin-bottom:28px">
           <img src="${fileUrl('icons/logo.svg')}" style="width:88px;height:88px;margin-left:-8px">
           <div style="font-size:30px;font-weight:800;letter-spacing:-0.02em">Image Size Checker Pro</div>
         </div>
         <h1 style="font-size:54px">Compress images for page speed.</h1>
         <p style="color:#111;font-size:25px">Measured savings. Same name, format and dimensions. For Chrome and Edge.</p>
       </div>
       <div class="sticker" style="width:560px;height:452px;flex-shrink:0;position:relative;transform:rotate(2deg);margin-right:-40px">
         <img src="${b64(path.join(OUT, 'screenshot-1-report.png'))}" style="position:absolute;left:-353px;top:-75px;width:960px;height:600px;max-width:none">
       </div>
     </div>`,
    { dir: SITE }
  );
  const raw = new Uint8Array(fs.readFileSync(og));
  const lossless = await optimizePngLossless(raw);
  const lossy = await optimizePngLossy(raw, { minPsnr: 36 });
  const best = [raw, lossless, lossy?.bytes].filter(Boolean).reduce((a, b) => (b.length < a.length ? b : a));
  fs.writeFileSync(og, best);
  console.log(`docs/img/og-image.png ${kb(raw.length)} -> ${kb(best.length)}`);

  fs.copyFileSync(path.join(ROOT, 'icons', 'logo.svg'), path.join(SITE, 'logo.svg'));
  console.log('docs/img/logo.svg');
}
