// Optional lossy PNG (palette quantization) end to end: option, estimates, and saved output.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

let ready = false;
async function setup(ctx) {
  if (ready) return;
  ready = true;
  const maker = await ctx.browser.newPage();
  await maker.goto(`${ctx.origin}/tests/blank.html`);
  const b64 = await maker.evaluate(async () => {
    const h = await import('/tests/helpers.js');
    // Large soft-edged logo on transparency, like a cartoon avatar exported as PNG.
    const bytes = await h.canvasPng(1000, 1000, h.transparentLogo);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  });
  await maker.close();
  const png = Buffer.from(b64, 'base64');
  ctx.routes.set('/lp/logo.png', (req, res) => {
    res.setHeader('content-type', 'image/png');
    res.setHeader('content-length', png.length);
    res.end(req.method === 'HEAD' ? undefined : png);
  });
  ctx.routes.set('/lp/page.html', (req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><body><img src="/lp/logo.png" width="1000" height="1000" alt="Logo"></body>');
  });
  ctx.lossyFixtureSize = png.length;
}

// The option is a stored preference; leave it off so later test files start from the default.
const resetOption = (panel) => panel.evaluate(() => new Promise((r) => chrome.storage.local.remove('iscProLossyPng', r)));

let seq = 0;
async function open(ctx) {
  await setup(ctx);
  const url = `${ctx.origin}/lp/page.html?n=${++seq}`;
  const page = await ctx.browser.newPage();
  await page.goto(url);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  const panel = await ctx.browser.newPage();
  await panel.goto(`chrome-extension://${ctx.extId}/popup.html`);
  const tabId = await panel.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).id, url);
  await panel.evaluate(async (id) => {
    await new Promise((r) => chrome.storage.local.remove('iscProLossyPng', r));
    const { setFolder } = await import('/js/folder-store.js');
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });
    await setFolder(root);
    const box = document.getElementById('lossyPngCheck');
    if (box.checked) box.click();
    await window.__iscPopup.ensureAndScan(true, id);
  }, tabId);
  return { page, panel, tabId };
}

const measuredSavings = (panel) =>
  panel.evaluate(async () => {
    for (let i = 0; i < 150; i++) {
      if (document.getElementById('kpiSavingsSub').textContent.startsWith('Measured')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return document.querySelector('.estimate-pill')?.textContent || '';
  });

export const tests = {
  'lossy PNG is off by default; turning it on re-measures savings with a separate cache key': async (ctx) => {
    const { page, panel, tabId } = await open(ctx);
    const off = await measuredSavings(panel);
    await panel.evaluate(() => document.getElementById('lossyPngCheck').click());
    await sleep(100);
    const on = await measuredSavings(panel);
    const pct = (s) => Number((s.match(/-(\d+)%/) || [])[1] || 0);
    assert(pct(on) > pct(off) + 10, `lossy estimate should save clearly more: off "${off}" vs on "${on}"`);
    // The lossless result for the same image is still cached separately.
    const resp = await panel.evaluate(
      (id) =>
        new Promise((r) =>
          chrome.runtime.sendMessage(
            { type: 'START_ESTIMATE', tabId: id, items: window.__iscPopup.getState().items.filter((i) => i.needsCompression), lossyPng: false },
            r
          )
        ),
      tabId
    );
    assert(resp.pending === 0 && Object.keys(resp.cached).length === 1, 'lossless estimate should still be cached');
    await resetOption(panel);
    await Promise.all([page.close(), panel.close()]);
  },

  'compress with lossy PNG on saves a palette PNG and explains it': async (ctx) => {
    const { page, panel } = await open(ctx);
    const out = await panel.evaluate(async () => {
      document.getElementById('lossyPngCheck').click();
      const status = document.getElementById('compressionStatus');
      status.textContent = '';
      document.querySelector('.mini-btn[data-act="compress"]').click();
      for (let i = 0; i < 200 && !/^Saved|^Error/.test(status.textContent); i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 200));
      const root = await navigator.storage.getDirectory();
      const bytes = new Uint8Array(await (await (await root.getFileHandle('logo.png')).getFile()).arrayBuffer());
      const { decodePng } = await import('/js/png.js');
      const dec = await decodePng(bytes);
      return { size: bytes.length, colorType: dec.colorType, status: status.textContent, pill: document.querySelector('.compress-result-pill')?.textContent || '' };
    });
    assert(out.colorType === 3, 'expected a palette PNG, got color type ' + out.colorType);
    assert(out.size < ctx.lossyFixtureSize * 0.6, `size ${ctx.lossyFixtureSize} -> ${out.size}`);
    assert(/colors \(PSNR/.test(out.pill), 'pill should explain the reduction: ' + out.pill);
    await resetOption(panel);
    await Promise.all([page.close(), panel.close()]);
  }
};
