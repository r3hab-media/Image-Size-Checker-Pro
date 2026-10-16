// End-to-end tests: the unpacked extension running in Chrome against a local fixture site.
import zlib from 'node:zlib';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- fixtures (built in Node) ----------

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// Large, uncompressed RGBA PNG with few colors: compresses losslessly by >90%.
function heavyPng(w, h, seed = 0) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = ((Math.floor(x / 20) + Math.floor(y / 20) + seed) % 6) * 40;
      raw.set([v, 255 - v, (v * 3) & 255, 255], y * (w * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 0 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// Valid 1x1 GIF padded with comment blocks to ~300 KB, so it is flagged as too large.
function heavyGif() {
  const base = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
  const blocks = [Buffer.from([0x21, 0xfe])];
  for (let i = 0; i < 1200; i++) blocks.push(Buffer.from([255]), Buffer.alloc(255, 0x41));
  blocks.push(Buffer.from([0]));
  return Buffer.concat([base.subarray(0, base.length - 1), ...blocks, Buffer.from([0x3b])]);
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Fixture</title>
<style>
  img, div.bg { display:block; margin:8px; }
  .padded { width: 300px; height: 200px; padding: 10px; border: 4px solid #000; box-sizing: content-box; }
  .bg { width: 320px; height: 120px; background-size: cover; }
</style></head><body>
  <img id="heavyA" src="/fx/heavy.png" width="300" height="200" alt="Heavy A">
  <img id="heavyB" src="/fx/heavy.png" width="300" height="200" alt="Heavy B (same file)">
  <img id="gif" src="/fx/big.gif" width="100" height="100" alt="GIF">
  <img id="broken" src="/fx/flaky.png" width="300" height="200" alt="Fails on download">
  <img id="evilName" src="/fx/heavy2.png" data-filename="../../<img src=x onerror=&quot;window.__xss=1&quot;>.png" width="300" height="200" alt="x">
  <img id="decorative" src="/fx/small.png" width="300" height="200" alt="">
  <img id="noAlt" src="/fx/small.png" width="300" height="200">
  <img id="padded" class="padded" src="/fx/small.png" alt="padded">
  <img id="svgImg" src="/fx/icon.svg" style="width:200px;height:200px" alt="svg">
  <img id="cookie" src="/fx/private.png" width="300" height="200" alt="needs cookie">
  <div class="bg" id="twoBgs" style='background-image: url("/fx/bg%20(1).png"), url("/fx/small.png")'></div>
  <svg id="inlineSvg" width="200" height="60" viewBox="0 0 200 60"><!-- design-tool export comment --><text x="5" y="30">Hello  world</text></svg>
  <script>document.cookie = 'auth=1; path=/';</script>
</body></html>`;

let fixturesReady = false;
function installFixtures({ routes }) {
  if (fixturesReady) return;
  fixturesReady = true;
  const png = (buf) => (req, res) => {
    res.setHeader('content-type', 'image/png');
    res.setHeader('content-length', buf.length);
    res.end(req.method === 'HEAD' ? undefined : buf);
  };
  const heavy = heavyPng(600, 400);
  const heavy2 = heavyPng(600, 400, 3);
  const small = heavyPng(40, 30);
  const bg = heavyPng(500, 300, 1);
  const gif = heavyGif();
  routes.set('/fx/page.html', (req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(PAGE);
  });
  routes.set('/fx/heavy.png', png(heavy));
  routes.set('/fx/heavy2.png', png(heavy2));
  routes.set('/fx/small.png', png(small));
  // No Content-Length on HEAD, so the size must come from the Range probe.
  routes.set('/fx/bg%20(1).png', (req, res) => {
    res.setHeader('content-type', 'image/png');
    res.setHeader('accept-ranges', 'bytes');
    if (req.method === 'HEAD') return res.end();
    if (req.headers.range === 'bytes=0-0') {
      res.statusCode = 206;
      res.setHeader('content-range', `bytes 0-0/${bg.length}`);
      return res.end(bg.subarray(0, 1));
    }
    res.end(bg);
  });
  routes.set('/fx/big.gif', (req, res) => {
    res.setHeader('content-type', 'image/gif');
    res.setHeader('content-length', gif.length);
    res.end(req.method === 'HEAD' ? undefined : gif);
  });
  // HEAD reports a big file, but downloading it fails: a batch must survive this.
  let flakyServed = false;
  routes.set('/fx/flaky.png', (req, res) => {
    if (req.method === 'HEAD') {
      res.setHeader('content-type', 'image/png');
      res.setHeader('content-length', 500000);
      return res.end();
    }
    if (!flakyServed && req.headers['sec-fetch-dest'] === 'image') {
      flakyServed = true; // let the page itself render it once
      res.setHeader('content-type', 'image/png');
      return res.end(heavy);
    }
    res.statusCode = 500;
    res.end('boom');
  });
  routes.set('/fx/icon.svg', (req, res) => {
    res.setHeader('content-type', 'image/svg+xml');
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>');
  });
  routes.set('/fx/private.png', (req, res) => {
    if (!/auth=1/.test(req.headers.cookie || '')) {
      res.statusCode = 403;
      return res.end('forbidden');
    }
    png(heavy2)(req, res);
  });
}

// ---------- helpers ----------

let pageSeq = 0;
async function openFixture(ctx) {
  installFixtures(ctx);
  const page = await ctx.browser.newPage();
  // Unique URL per page so the tab can be found unambiguously while older tabs are still closing.
  await page.goto(`${ctx.origin}/fx/page.html?n=${++pageSeq}`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  return page;
}

async function tabIdOf(ctx, page) {
  const helper = await extPage(ctx, 'tests/blank.html');
  const url = page.url();
  const id = await helper.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);
  await helper.close();
  return id;
}

async function extPage(ctx, path) {
  const p = await ctx.browser.newPage();
  await p.goto(`chrome-extension://${ctx.extId}/${path}`);
  return p;
}

function sendToTab(page, tabId, message) {
  return page.evaluate(
    (id, msg) => new Promise((r) => chrome.tabs.sendMessage(id, msg, (x) => r(x ?? { err: chrome.runtime.lastError?.message }))),
    tabId,
    message
  );
}

async function scanned(ctx) {
  const page = await openFixture(ctx);
  const tabId = await tabIdOf(ctx, page);
  const popup = await extPage(ctx, 'popup.html');
  await popup.evaluate(async () => {
    await new Promise((r) => chrome.storage.local.remove(['iscProSettings', 'iscProOverwrite'], r));
  });
  const state = await sendToTab(popup, tabId, { type: 'SCAN_PAGE' });
  return { page, tabId, popup, state };
}

async function itemFor(page, state, selector) {
  const src = await page.$eval(selector, (el) => el.currentSrc || el.src || '');
  return state.items.find((i) => i.url === src);
}

function zipEntryNames(bytes) {
  const buf = Buffer.from(bytes);
  const names = [];
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let pos = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(pos + 28);
    names.push(buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8'));
    pos += 46 + nameLen + buf.readUInt16LE(pos + 30) + buf.readUInt16LE(pos + 32);
  }
  return names;
}

function zipEntrySizes(bytes) {
  const buf = Buffer.from(bytes);
  const sizes = {};
  let pos = 0;
  while (buf.readUInt32LE(pos) === 0x04034b50) {
    const size = buf.readUInt32LE(pos + 22);
    const nameLen = buf.readUInt16LE(pos + 26);
    const extraLen = buf.readUInt16LE(pos + 28);
    sizes[buf.subarray(pos + 30, pos + 30 + nameLen).toString('utf8')] = size;
    pos += 30 + nameLen + extraLen + size;
  }
  return sizes;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function closeAll(...pages) {
  for (const p of pages) await p.close().catch(() => {});
}

// ---------- tests ----------

export const tests = {
  'pages are not scanned (or images re-fetched) until asked': async (ctx) => {
    installFixtures(ctx);
    ctx.requests.length = 0;
    const page = await openFixture(ctx);
    await sleep(1500);
    const extFetches = ctx.requests.filter((r) => r.method === 'HEAD' || r.headers.range);
    assert(extFetches.length === 0, `extension fetched before any scan: ${extFetches.map((r) => r.method + ' ' + r.path)}`);
    assert(!(await page.$('#isc-pro-shadow-host')), 'overlay injected before any scan');
    await closeAll(page);
  },

  'scan finds images, de-duplicates nothing it should not, and sizes them': async (ctx) => {
    const { page, popup, state } = await scanned(ctx);
    assert(state.ok, 'scan failed');
    const kinds = state.items.map((i) => i.kind);
    assert(kinds.filter((k) => k === 'img').length === 10, `img count ${kinds.filter((k) => k === 'img').length}`);
    assert(kinds.includes('svg'), 'inline svg missing');
    const heavy = await itemFor(page, state, '#heavyA');
    assert(heavy.fileSize > 900000 && heavy.isTooLarge, `heavy size ${heavy.fileSize}`);
    await closeAll(page, popup);
  },

  'inline SVG has a real data: URL with the SVG namespace (#2)': async (ctx) => {
    const { page, popup, state } = await scanned(ctx);
    const svg = state.items.find((i) => i.kind === 'svg');
    assert(svg.url.startsWith('data:image/svg+xml'), `url ${svg.url.slice(0, 40)}`);
    assert(decodeURIComponent(svg.url).includes('xmlns="http://www.w3.org/2000/svg"'), 'missing xmlns');
    await closeAll(page, popup);
  },

  'every url() in a multi-background is found, including ones with parentheses (#27)': async (ctx) => {
    const { page, popup, state } = await scanned(ctx);
    const bgs = state.items.filter((i) => i.kind === 'bg');
    assert(bgs.length === 2, `bg count ${bgs.length}: ${bgs.map((b) => b.url)}`);
    const paren = bgs.find((b) => b.url.includes('bg%20(1).png'));
    assert(paren, 'url with parentheses not parsed: ' + bgs.map((b) => b.url));
    assert(paren.fileSize > 100000, `range-probe size ${paren.fileSize}`);
    assert(new Set(bgs.map((b) => b.id)).size === 2, 'bg ids collide');
    await closeAll(page, popup);
  },

  'sizes come from Range probe when HEAD has no Content-Length (#20/#21)': async (ctx) => {
    installFixtures(ctx);
    const popup = await extPage(ctx, 'tests/blank.html');
    ctx.requests.length = 0;
    // A query string the service worker has never cached, served by the Range-only route.
    const meta = await popup.evaluate((u) => new Promise((r) => chrome.runtime.sendMessage({ type: 'GET_IMAGE_META', url: u }, r)), `${ctx.origin}/fx/bg%20(1).png?fresh=${Date.now()}`);
    assert(meta.ok && meta.fileSize > 100000 && meta.source === 'range', 'meta ' + JSON.stringify(meta));
    const bgReqs = ctx.requests.filter((r) => r.path === '/fx/bg%20(1).png');
    assert(bgReqs.some((r) => r.headers.range === 'bytes=0-0'), 'no range probe');
    assert(!bgReqs.some((r) => r.method === 'GET' && !r.headers.range), 'full download despite range support');
    await closeAll(popup);
  },

  'cookie-protected images are sized via the credentialed retry (#26)': async (ctx) => {
    const { page, popup, state } = await scanned(ctx);
    const item = await itemFor(page, state, '#cookie');
    assert(item.fileSize > 0, 'size 0 for cookie-protected image');
    await closeAll(page, popup);
  },

  'filenames from data-filename are sanitized; tooltip does not execute page HTML (#17/#18)': async (ctx) => {
    const { page, tabId, popup, state } = await scanned(ctx);
    const evil = await itemFor(page, state, '#evilName');
    assert(!evil.originalFilename.includes('/') && !evil.originalFilename.includes('..'), `filename ${evil.originalFilename}`);
    assert(!/[<>"]/.test(evil.originalFilename), `unsafe chars ${evil.originalFilename}`);
    // Pinning renders the tooltip with the filename.
    await page.bringToFront(); // rAF and smooth scrolling are paused in background tabs
    await sendToTab(popup, tabId, { type: 'SCROLL_TO_IMAGE', id: evil.id });
    await sleep(1200);
    const xss = await page.evaluate(() => window.__xss);
    assert(xss === undefined, 'tooltip executed injected HTML');
    const title = await page.evaluate(() => document.getElementById('isc-pro-shadow-host').shadowRoot.querySelector('.isc-tt-title')?.textContent);
    assert(title === evil.originalFilename, `tooltip title ${title}`);
    await closeAll(page, popup);
  },

  'alt="" is decorative, missing alt is flagged (#24)': async (ctx) => {
    const { page, popup, state } = await scanned(ctx);
    const items = state.items.filter((i) => i.url.endsWith('/fx/small.png') && i.kind === 'img');
    const dec = [];
    for (const i of items) dec.push(i.issues.some((x) => x.code === 'MISSING_ALT'));
    assert(dec.filter(Boolean).length === 1, `MISSING_ALT on ${dec.filter(Boolean).length} of the small.png imgs (expected only #noAlt)`);
    await closeAll(page, popup);
  },

  'padding/border do not cause false aspect distortion (#22)': async (ctx) => {
    const { page, popup, state } = await scanned(ctx);
    const padded = state.items.filter((i) => i.url.endsWith('/fx/small.png') && i.kind === 'img').find((i) => i.altText === 'padded');
    assert(padded.renderedW === 300 && padded.renderedH === 200, `rendered ${padded.renderedW}x${padded.renderedH}`);
    // small.png is 40x30 (4:3) in a 3:2 box: genuinely distorted, and the % must use the content box.
    const expected = Number((Math.abs(300 / 200 - 40 / 30) / (40 / 30) * 100).toFixed(1));
    assert(padded.aspectMismatchPct === expected, `aspect ${padded.aspectMismatchPct} vs ${expected}`);
    await closeAll(page, popup);
  },

  'SVG in <img> is not flagged as upscaled/oversized (#23)': async (ctx) => {
    const { page, popup, state } = await scanned(ctx);
    const svg = await itemFor(page, state, '#svgImg');
    const codes = svg.issues.map((i) => i.code);
    assert(!codes.includes('UPSCALED_BLURRY') && !codes.includes('OVERSIZED_DIMENSIONS'), codes.join());
    await closeAll(page, popup);
  },

  'IDs are stable across rescans, so Locate keeps working (#5)': async (ctx) => {
    const { page, tabId, popup, state } = await scanned(ctx);
    const heavy = await itemFor(page, state, '#heavyA');
    await page.evaluate(() => document.body.appendChild(document.createElement('p')));
    await sleep(1200); // MutationObserver-driven rescan
    const again = await sendToTab(popup, tabId, { type: 'GET_STATE' });
    assert(again.items.some((i) => i.id === heavy.id), 'id changed after rescan');
    const resp = await sendToTab(popup, tabId, { type: 'SCROLL_TO_IMAGE', id: heavy.id });
    assert(resp.ok, 'locate failed after rescan');
    await closeAll(page, popup);
  },

  'concurrent scans do not interleave (#6)': async (ctx) => {
    const { page, tabId, popup } = await scanned(ctx);
    const results = await Promise.all([1, 2, 3, 4].map(() => sendToTab(popup, tabId, { type: 'SCAN_PAGE' })));
    const counts = results.map((r) => r.items.length);
    assert(new Set(counts).size === 1, `inconsistent results ${counts}`);
    const ids = results[3].items.map((i) => i.id);
    assert(new Set(ids).size === ids.length, 'duplicate ids');
    await closeAll(page, popup);
  },

  'hover tooltip stays open when moving onto it, and its button works (#29)': async (ctx) => {
    const { page, tabId, popup } = await scanned(ctx);
    await page.bringToFront();
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(300);
    const pill = await page.evaluate(() => {
      const r = document.getElementById('isc-pro-shadow-host').shadowRoot.querySelector('.isc-pill').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(pill.x, pill.y);
    await sleep(300);
    const tt = await page.evaluate(() => {
      const t = document.getElementById('isc-pro-shadow-host').shadowRoot.querySelector('.isc-tooltip');
      const r = t.getBoundingClientRect();
      return { visible: t.classList.contains('visible'), x: r.x + 20, y: r.y + 20 };
    });
    assert(tt.visible, 'tooltip not shown on pill hover');
    await page.mouse.move(tt.x, tt.y, { steps: 8 });
    await sleep(500);
    const still = await page.evaluate(() => document.getElementById('isc-pro-shadow-host').shadowRoot.querySelector('.isc-tooltip').classList.contains('visible'));
    assert(still, 'tooltip vanished when moving onto it');
    void tabId;
    await closeAll(page, popup);
  },

  'disabling inline SVG scanning in settings works (#4) and syncs to other tabs (#32)': async (ctx) => {
    const { page, tabId, popup } = await scanned(ctx);
    const other = await openFixture(ctx);
    const otherTab = await tabIdOf(ctx, other);
    await sendToTab(popup, otherTab, { type: 'SCAN_PAGE' });

    await popup.evaluate(async (id) => {
      await window.__iscPopup.ensureAndScan(true, id);
      document.getElementById('scanSvgCheck').checked = false;
      document.getElementById('saveSettingsBtn').click();
    }, tabId);
    await sleep(1500);
    const st = await sendToTab(popup, tabId, { type: 'GET_STATE' });
    assert(!st.items.some((i) => i.kind === 'svg'), 'svg still scanned in this tab');
    const st2 = await sendToTab(popup, otherTab, { type: 'GET_STATE' });
    assert(st2.settings.scanInlineSvgs === false, 'setting did not sync to other tab');
    assert(!st2.items.some((i) => i.kind === 'svg'), 'other tab did not rescan');
    await popup.evaluate(() => new Promise((r) => chrome.storage.local.remove('iscProSettings', r)));
    await closeAll(page, other, popup);
  },

  'batch ZIP: dedupes, skips kept formats, survives failures, sanitizes names (#3/#7/#18)': async (ctx) => {
    const { page, tabId, popup } = await scanned(ctx);
    // Use the origin-private file system as the "chosen folder" (always writable, inspectable).
    const result = await popup.evaluate(async (id) => {
      const { setFolder } = await import('/js/folder-store.js');
      const root = await navigator.storage.getDirectory();
      for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });
      await setFolder(root);
      await window.__iscPopup.ensureAndScan(true, id);
      await window.__iscPopup.compressAllTooLargeToZip();
      const status = document.getElementById('compressionStatus').textContent;
      const files = [];
      for await (const [name, h] of root.entries()) files.push({ name, bytes: Array.from(new Uint8Array(await (await h.getFile()).arrayBuffer())) });
      return { status, files };
    }, tabId);
    assert(result.files.length === 1, `files: ${result.files.map((f) => f.name)} / ${result.status}`);
    const names = zipEntryNames(result.files[0].bytes);
    assert(names.filter((n) => n.endsWith('heavy.png')).length === 1, `heavy.png entries: ${names}`);
    assert(!names.some((n) => n.endsWith('.gif')), 'GIF should be skipped (format kept)');
    assert(!names.some((n) => n.includes('..') || n.startsWith('/')), `unsafe names ${names}`);
    assert(/failed: flaky\.png/.test(result.status), `status should report the failure: ${result.status}`);
    assert(/already optimal or format kept/.test(result.status), `status should report skipped: ${result.status}`);
    await closeAll(page, popup);
  },

  'single compress of inline SVG and blob: image works; no silent overwrite (#2/#26/#31)': async (ctx) => {
    const { page, tabId, popup } = await scanned(ctx);
    await page.evaluate(async () => {
      const blob = await (await fetch('/fx/heavy2.png')).blob();
      const img = new Image(300, 200);
      img.id = 'blobImg';
      img.alt = 'blob';
      img.src = URL.createObjectURL(blob);
      document.body.prepend(img);
      await img.decode();
    });
    const out = await popup.evaluate(async (id) => {
      const { setFolder } = await import('/js/folder-store.js');
      const root = await navigator.storage.getDirectory();
      for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });
      await setFolder(root);
      await window.__iscPopup.ensureAndScan(true, id);
      const st = window.__iscPopup.getState();
      const click = async (item) => {
        document.querySelector(`.mini-btn[data-act="compress"][data-id="${item.id}"]`).click();
        for (let i = 0; i < 100 && !/Saved|Error|not changed/.test(document.getElementById('compressionStatus').textContent); i++) {
          await new Promise((r) => setTimeout(r, 100));
        }
        const s = document.getElementById('compressionStatus').textContent;
        document.getElementById('compressionStatus').textContent = '';
        return s;
      };
      const svg = st.items.find((i) => i.kind === 'svg');
      const blobItem = st.items.find((i) => i.url.startsWith('blob:'));
      const statuses = [await click(svg), await click(blobItem), await click(blobItem)];
      const files = {};
      for await (const [name, h] of root.entries()) files[name] = await (await h.getFile()).text();
      return { statuses, names: Object.keys(files).sort(), svgText: Object.entries(files).find(([n]) => n.endsWith('.svg'))?.[1] };
    }, tabId);
    assert(out.statuses.every((s) => s.startsWith('Saved')), `statuses ${out.statuses}`);
    assert(out.svgText && out.svgText.includes('Hello  world'), 'svg text whitespace lost');
    const pngs = out.names.filter((n) => n.endsWith('.png'));
    assert(pngs.length === 2 && pngs.some((n) => / \(1\)\.png$/.test(n)), `expected uniquified second save, got ${out.names}`);
    await closeAll(page, popup);
  },

  'Playground page is reachable from the popup': async (ctx) => {
    const demo = await extPage(ctx, 'demo-playground.html');
    await sleep(800);
    const tabId = await tabIdOf(ctx, demo);
    const popup = await extPage(ctx, 'popup.html');
    const st = await sendToTab(popup, tabId, { type: 'SCAN_PAGE' });
    assert(st && st.ok && st.items.length >= 6, `playground scan: ${st && st.items && st.items.length}`);

    // The playground's descriptions promise these results; check them.
    const out = await popup.evaluate(async (id) => {
      const { setFolder } = await import('/js/folder-store.js');
      const root = await navigator.storage.getDirectory();
      for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });
      await setFolder(root);
      await window.__iscPopup.ensureAndScan(true, id);
      await window.__iscPopup.compressAllTooLargeToZip();
      const files = [];
      for await (const [, h] of root.entries()) files.push(Array.from(new Uint8Array(await (await h.getFile()).arrayBuffer())));
      return { status: document.getElementById('compressionStatus').textContent, zip: files[0] };
    }, tabId);
    assert(out.zip, `no zip: ${out.status}`);
    const sizes = zipEntrySizes(out.zip);
    assert(sizes['hero-dashboard.png'] < 20 * 1024, `hero-dashboard.png ${sizes['hero-dashboard.png']}`);
    const jpgBefore = st.items.find((i) => i.originalFilename === 'product-feature.jpg').fileSize;
    assert(sizes['product-feature.jpg'] < jpgBefore * 0.7, `product-feature.jpg ${jpgBefore} -> ${sizes['product-feature.jpg']}`);
    await closeAll(demo, popup);
  }
};
