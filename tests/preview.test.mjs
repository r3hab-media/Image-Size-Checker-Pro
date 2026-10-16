// Before/after preview with a quality slider, and saving at the chosen quality.
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
    const bytes = await h.canvasBytes(1000, 750, h.photoLike, 'image/jpeg', 1.0);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  });
  await maker.close();
  const jpeg = Buffer.from(b64, 'base64');
  ctx.routes.set('/pv/photo.jpg', (req, res) => {
    res.setHeader('content-type', 'image/jpeg');
    res.setHeader('content-length', jpeg.length);
    res.end(req.method === 'HEAD' ? undefined : jpeg);
  });
  ctx.routes.set('/pv/page.html', (req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><body>
      <img src="/pv/photo.jpg" width="1000" height="750" alt="Photo">
      <img src="/icons/icon128.png" width="128" height="128" alt="Icon">
    </body>`);
  });
}

let seq = 0;
async function open(ctx) {
  await setup(ctx);
  const url = `${ctx.origin}/pv/page.html?n=${++seq}`;
  const page = await ctx.browser.newPage();
  await page.goto(url);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  const panel = await ctx.browser.newPage();
  await panel.setViewport({ width: 750, height: 800 });
  await panel.goto(`chrome-extension://${ctx.extId}/popup.html`);
  const tabId = await panel.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).id, url);
  await panel.evaluate(async (id) => {
    const { setFolder } = await import('/js/folder-store.js');
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });
    await setFolder(root);
    await window.__iscPopup.ensureAndScan(true, id);
  }, tabId);
  return { page, panel };
}

// Sets the quality slider and waits for the re-encode to report its size.
const setQuality = (panel, q) =>
  panel.evaluate(async (value) => {
    const stats = document.getElementById('previewStats');
    stats.dataset.after = '';
    const range = document.getElementById('qualityRange');
    range.value = String(value);
    range.dispatchEvent(new Event('input'));
    for (let i = 0; i < 100 && !stats.dataset.after; i++) await new Promise((r) => setTimeout(r, 50));
    return Number(stats.dataset.after);
  }, q);

const openPhotoPreview = (panel) =>
  panel.evaluate(async () => {
    document.querySelector('.mini-btn[data-act="preview"]').click();
    const stats = document.getElementById('previewStats');
    for (let i = 0; i < 100 && !stats.dataset.after; i++) await new Promise((r) => setTimeout(r, 50));
    return !document.getElementById('previewModal').classList.contains('hidden');
  });

export const tests = {
  'Preview is offered for JPEG/WebP only': async (ctx) => {
    const { page, panel } = await open(ctx);
    const names = await panel.evaluate(() =>
      [...document.querySelectorAll('.mini-btn[data-act="preview"]')].map((b) => b.closest('.item-card').querySelector('.item-name').textContent)
    );
    assert(names.join() === 'photo.jpg', 'preview buttons on: ' + names);
    await Promise.all([page.close(), panel.close()]);
  },

  'quality slider re-encodes live; split slider clips the compressed layer': async (ctx) => {
    const { page, panel } = await open(ctx);
    assert(await openPhotoPreview(panel), 'modal did not open');
    const at92 = await setQuality(panel, 92);
    const at50 = await setQuality(panel, 50);
    assert(at92 > 0 && at50 > 0 && at50 < at92, `sizes q92=${at92} q50=${at50}`);
    const clip = await panel.evaluate(() => {
      const split = document.getElementById('splitRange');
      split.value = '30';
      split.dispatchEvent(new Event('input'));
      return document.getElementById('afterImg').style.clipPath;
    });
    assert(clip === 'inset(0px 0px 0px 30%)', 'clip ' + clip);
    await Promise.all([page.close(), panel.close()]);
  },

  'saving uses the chosen quality (saved size matches the preview)': async (ctx) => {
    const { page, panel } = await open(ctx);
    await openPhotoPreview(panel);
    const previewBytes = await setQuality(panel, 60);
    const saved = await panel.evaluate(async () => {
      const status = document.getElementById('compressionStatus');
      status.textContent = '';
      document.getElementById('previewSaveBtn').click();
      for (let i = 0; i < 150 && !/^Saved|^Error/.test(status.textContent); i++) await new Promise((r) => setTimeout(r, 100));
      const root = await navigator.storage.getDirectory();
      const file = await (await root.getFileHandle('photo.jpg')).getFile();
      return { size: file.size, status: status.textContent, hidden: document.getElementById('previewModal').classList.contains('hidden') };
    });
    assert(saved.hidden, 'modal should close on save');
    // The saved file also carries the original's metadata segments, so allow that small difference.
    assert(Math.abs(saved.size - previewBytes) < 64, `saved ${saved.size} vs preview ${previewBytes} (${saved.status})`);
    await Promise.all([page.close(), panel.close()]);
  },

  'Escape closes the preview': async (ctx) => {
    const { page, panel } = await open(ctx);
    await openPhotoPreview(panel);
    await panel.keyboard.press('Escape');
    await sleep(100);
    const hidden = await panel.evaluate(() => document.getElementById('previewModal').classList.contains('hidden'));
    assert(hidden, 'still open');
    await Promise.all([page.close(), panel.close()]);
  }
};
