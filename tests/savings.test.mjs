// Measured savings: compressible vs oversized split, background dry runs, and their cache.
import zlib from 'node:zlib';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
// Uncompressed PNG with few colors: lossless optimization shrinks it enormously.
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

let ready = false;
async function setup(ctx) {
  if (ready) return;
  ready = true;
  // A noisy, low-quality JPEG: heavy enough to be flagged, but re-encoding at >= q82 only grows it.
  const maker = await ctx.browser.newPage();
  await maker.goto(`${ctx.origin}/tests/blank.html`);
  const jpegB64 = await maker.evaluate(async () => {
    const c = new OffscreenCanvas(1400, 1000);
    const ctx2 = c.getContext('2d');
    const img = ctx2.createImageData(1400, 1000);
    let s = 1;
    for (let i = 0; i < img.data.length; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      img.data[i] = i % 4 === 3 ? 255 : s >> 16;
    }
    ctx2.putImageData(img, 0, 0);
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.6 })).arrayBuffer());
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  });
  await maker.close();
  const jpeg = Buffer.from(jpegB64, 'base64');
  const png = storedPng(500, 300);
  const gif = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
  const big = (buf, type) => (req, res) => {
    res.setHeader('content-type', type);
    res.setHeader('content-length', buf.length);
    res.end(req.method === 'HEAD' ? undefined : buf);
  };
  ctx.routes.set('/sv/heavy.png', big(png, 'image/png'));
  ctx.routes.set('/sv/optimal.jpg', big(jpeg, 'image/jpeg'));
  ctx.routes.set('/sv/anim.gif', big(Buffer.concat([gif.subarray(0, gif.length - 1), Buffer.alloc(400000, 0), Buffer.from([0x3b])]), 'image/gif'));
  ctx.routes.set('/sv/page.html', (req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><body>
      <img src="/sv/heavy.png" width="500" height="300" alt="heavy">
      <img src="/sv/optimal.jpg" width="700" height="500" alt="optimal">
      <img src="/sv/anim.gif" width="100" height="100" alt="gif">
    </body>`);
  });
  ctx.jpegSize = jpeg.length;
}

async function openPanelOn(ctx, url) {
  const page = await ctx.browser.newPage();
  await page.goto(url);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  const panel = await ctx.browser.newPage();
  await panel.goto(`chrome-extension://${ctx.extId}/popup.html`);
  const tabId = await panel.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).id, url);
  await panel.evaluate((id) => window.__iscPopup.ensureAndScan(true, id), tabId);
  return { page, panel, tabId };
}

async function waitMeasured(panel) {
  for (let i = 0; i < 100; i++) {
    const sub = await panel.$eval('#kpiSavingsSub', (el) => el.textContent);
    if (sub.startsWith('Measured')) return;
    await sleep(100);
  }
  throw new Error('estimates never finished');
}

let pageSeq = 0;

export const tests = {
  'scan splits compressible from non-compressible formats': async (ctx) => {
    await setup(ctx);
    const { page, panel } = await openPanelOn(ctx, `${ctx.origin}/sv/page.html?n=${++pageSeq}`);
    const st = await panel.evaluate(() => window.__iscPopup.getState());
    const by = (alt) => st.items.find((i) => i.altText === alt);
    assert(by('heavy').needsCompression, 'heavy PNG should be compressible');
    assert(by('optimal').needsCompression, 'heavy JPEG should be compressible (until measured)');
    assert(by('gif').isTooLarge && !by('gif').needsCompression, 'GIF is too large but not compressible');
    assert(st.summary.compressibleCount === 2, `compressibleCount ${st.summary.compressibleCount}`);
    await Promise.all([page.close(), panel.close()]);
  },

  'savings KPI is measured, and cards say whether compression helps': async (ctx) => {
    await setup(ctx);
    const { page, panel } = await openPanelOn(ctx, `${ctx.origin}/sv/page.html?n=${++pageSeq}`);
    await waitMeasured(panel);
    const view = await panel.evaluate(() => ({
      savings: document.getElementById('kpiSavings').textContent,
      pills: [...document.querySelectorAll('.estimate-pill')].map((p) => p.textContent.trim()),
      zipCount: document.getElementById('tooLargeCountBadge').textContent
    }));
    assert(view.pills.some((p) => p.startsWith('💡 Compression can save')), `no saving hint: ${view.pills}`);
    assert(view.pills.some((p) => p.startsWith("ℹ️ Compression can't shrink this")), `no can't-shrink hint: ${view.pills}`);
    // Only the PNG is worth zipping once the JPEG is measured as already optimal.
    assert(view.zipCount === '1', `zip count ${view.zipCount}`);
    const kb = parseFloat(view.savings);
    assert(kb > 300 && /KB|MB/.test(view.savings), `savings ${view.savings}`);
    await Promise.all([page.close(), panel.close()]);
  },

  'estimates are cached: a second scan needs no new dry runs': async (ctx) => {
    await setup(ctx);
    const url = `${ctx.origin}/sv/page.html?n=${++pageSeq}`;
    const first = await openPanelOn(ctx, url);
    await waitMeasured(first.panel);
    const resp = await first.panel.evaluate(async (id) => {
      const st = window.__iscPopup.getState();
      const items = st.items.filter((i) => i.needsCompression);
      return new Promise((r) => chrome.runtime.sendMessage({ type: 'START_ESTIMATE', tabId: id, items }, r));
    }, first.tabId);
    assert(resp.ok && resp.pending === 0, `expected all cached, got ${JSON.stringify({ pending: resp.pending })}`);
    assert(Object.keys(resp.cached).length === 2, `cached ${Object.keys(resp.cached).length}`);
    await Promise.all([first.page.close(), first.panel.close()]);
  },

  'a user job runs before queued estimates': async (ctx) => {
    await setup(ctx);
    // Many distinct URLs (query strings) so estimates queue up behind each other.
    const items = Array.from({ length: 12 }, (_, i) => ({
      url: `${ctx.origin}/sv/heavy.png?q=${Date.now()}-${i}`,
      fileSize: 600000 + i,
      format: 'PNG',
      originalFilename: `h${i}.png`,
      intrinsicW: 500,
      intrinsicH: 300
    }));
    const panel = await ctx.browser.newPage();
    await panel.goto(`chrome-extension://${ctx.extId}/tests/blank.html`);
    const order = await panel.evaluate(async (list) => {
      const events = [];
      chrome.runtime.onMessage.addListener((m) => {
        if (m.type === 'ESTIMATE_UPDATE' && m.tabId === -7) events.push('estimate');
        if (m.type === 'JOB_UPDATE' && m.job.tabId === -7 && m.job.state === 'done') events.push('job');
      });
      await new Promise((r) => chrome.runtime.sendMessage({ type: 'START_ESTIMATE', tabId: -7, items: list }, r));
      await new Promise((r) => setTimeout(r, 30));
      const { setFolder } = await import('/js/folder-store.js');
      await setFolder(await navigator.storage.getDirectory());
      await new Promise((r) =>
        chrome.runtime.sendMessage(
          { type: 'START_JOB', job: { mode: 'single', items: [{ ...list[0], url: list[0].url + '&job' }], tabId: -7, pageUrl: 'http://x/', destination: 'folder', overwrite: true } },
          r
        )
      );
      for (let i = 0; i < 150 && !events.includes('job'); i++) await new Promise((r) => setTimeout(r, 100));
      return events;
    }, items);
    await panel.close();
    const jobAt = order.indexOf('job');
    assert(jobAt !== -1, 'job never finished: ' + order);
    assert(jobAt <= 2, `job waited behind ${jobAt} estimates: ${order}`);
  }
};
