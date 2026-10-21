// Smoke test for the Firefox build (npm run test:firefox). Builds dist/firefox/, installs it in Firefox
// as a temporary add-on over WebDriver BiDi, and checks the parts that differ from Chrome: the offscreen
// shim (savings are measured in a hidden iframe in the background page), the popup's Firefox UI, and
// downloads from the background page. Set FIREFOX_PATH if Firefox is not in the default location;
// HEADFUL=1 shows the browser. The Chrome suite (npm test) does not need Firefox.
import puppeteer from 'puppeteer-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { FIREFOX_ID } from '../scripts/firefox-manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIREFOX =
  process.env.FIREFOX_PATH ||
  {
    win32: 'C:/Program Files/Mozilla Firefox/firefox.exe',
    darwin: '/Applications/Firefox.app/Contents/MacOS/firefox',
    linux: '/usr/bin/firefox'
  }[process.platform];
const UUID = '0b6d1c1e-5b1f-4d63-9a5e-1c0de15c0001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'package.mjs'), '--allow-dirty'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
const EXT_DIR = path.join(ROOT, 'dist', 'firefox');

// Uncompressed PNG with few colors: lossless optimization shrinks it enormously.
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function storedPng(w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([(x >> 4) * 30, (y >> 4) * 30, 90, 255], y * (w * 4 + 1) + 1 + x * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}

const png = storedPng(500, 300);
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/heavy.png')) {
    res.setHeader('content-type', 'image/png');
    res.setHeader('content-length', png.length);
    return res.end(req.method === 'HEAD' ? undefined : png);
  }
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><title>ff</title><body><img src="/heavy.png" width="500" height="300" alt="heavy"></body>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'isc-ff-'));
const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: FIREFOX,
  headless: !process.env.HEADFUL,
  // A separate instance, even when the user's own Firefox is open. System access lets WebDriver BiDi
  // run scripts in moz-extension:// pages.
  args: ['--no-remote', '--new-instance', '--remote-allow-system-access'],
  extraPrefsFirefox: {
    'extensions.webextensions.uuids': JSON.stringify({ [FIREFOX_ID]: UUID }),
    'browser.download.dir': downloads,
    'browser.download.folderList': 2,
    'browser.download.useDownloadDir': true
  }
});

// Firefox loads moz-extension:// pages but never reports the navigation as finished over BiDi,
// so wait for the popup's own test API instead.
async function openExtensionPage(page, url) {
  await page.goto(url, { timeout: 3000 }).catch(() => {});
  await page.waitForFunction(() => window.__iscPopup && document.getElementById('shortcutBtn').textContent.trim());
}

let failed = 0;
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`  ✓ ${name} (${Date.now() - t0}ms)`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n    ${String(err.stack || err).split('\n').slice(0, 3).join('\n    ')}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

try {
  const id = await browser.installExtension(EXT_DIR);
  assert(id === FIREFOX_ID, 'installed as ' + id);
  const base = `moz-extension://${UUID}`;
  console.log(`firefox-smoke (${await browser.version()})`);

  const site = await browser.newPage();
  await site.goto(`${origin}/page.html`);
  const popup = await browser.newPage();
  await popup.setViewport({ width: 750, height: 600 });
  await openExtensionPage(popup, `${base}/popup.html`);

  await test('the manifest is the Firefox one', async () => {
    const m = await popup.evaluate(() => chrome.runtime.getManifest());
    assert(m.background.scripts?.[0]?.endsWith('/js/offscreen-shim.js') && !m.background.service_worker, 'background ' + JSON.stringify(m.background));
    assert(m.sidebar_action?.default_panel?.endsWith('/popup.html?panel=1'), 'sidebar_action');
    assert(!m.permissions.includes('offscreen') && !m.permissions.includes('sidePanel'), 'permissions ' + m.permissions);
    assert(m.browser_specific_settings.gecko.data_collection_permissions.required[0] === 'none', 'data collection');
  });

  await test('scan, then savings are measured in the background (offscreen shim, worker, fetch)', async () => {
    const tabId = await popup.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).id, `${origin}/page.html`);
    await popup.evaluate((tid) => window.__iscPopup.ensureAndScan(true, tid), tabId);
    const st = await popup.evaluate(() => window.__iscPopup.getState());
    assert(st?.items?.length === 1 && st.items[0].fileSize === png.length, 'scan ' + JSON.stringify(st?.items?.map((i) => i.fileSize)));
    let sub = '';
    for (let i = 0; i < 150 && !sub.startsWith('Measured'); i++) {
      await sleep(100);
      sub = await popup.$eval('#kpiSavingsSub', (el) => el.textContent);
    }
    assert(sub.startsWith('Measured'), 'savings never measured: ' + sub);
    const savings = await popup.$eval('#kpiSavings', (el) => el.textContent);
    assert(parseFloat(savings) > 100, 'savings ' + savings);
  });

  await test('popup: no folder picker, side panel opens the sidebar, Firefox names', async () => {
    const view = await popup.evaluate(() => ({
      folder: getComputedStyle(document.getElementById('chooseFolderBtn')).display,
      panel: getComputedStyle(document.getElementById('openPanelBtn')).display,
      sidebar: typeof browser.sidebarAction?.open,
      shortcuts: typeof chrome.commands.openShortcutSettings,
      title: document.getElementById('shortcutBtn').title
    }));
    assert(view.folder === 'none', 'Choose Folder is shown');
    assert(view.panel !== 'none', 'side panel button is hidden');
    assert(view.sidebar === 'function' && view.shortcuts === 'function', JSON.stringify(view));
    assert(view.title.includes('Firefox'), 'shortcut title ' + view.title);
  });

  await test('the sidebar page hides the side panel button', async () => {
    const panel = await browser.newPage();
    await openExtensionPage(panel, `${base}/popup.html?panel=1`);
    const shown = await panel.evaluate(() => getComputedStyle(document.getElementById('openPanelBtn')).display);
    await panel.close();
    assert(shown === 'none', 'display ' + shown);
  });

  await test('the background page saves a 1 MB data: URL download', async () => {
    const bytes = 1024 * 1024;
    const resp = await popup.evaluate(
      (n) =>
        new Promise((resolve) => {
          const data = 'data:application/octet-stream;base64,' + btoa('x'.repeat(n));
          chrome.runtime.sendMessage({ type: 'TRIGGER_NATIVE_DOWNLOAD', dataUrl: data, filename: 'isc-ff-test.bin', saveAs: false }, resolve);
        }),
      bytes
    );
    assert(resp?.ok, 'download ' + JSON.stringify(resp));
    const file = path.join(downloads, 'isc-ff-test.bin');
    for (let i = 0; i < 50 && !fs.existsSync(file); i++) await sleep(100);
    assert(fs.existsSync(file) && fs.statSync(file).size === bytes, 'file not saved');
  });
} finally {
  await browser.close();
  server.close();
  fs.rmSync(downloads, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
