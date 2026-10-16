// Optional WebP copies with <picture> / image-set() markup.
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

let ready = false;
async function setup(ctx) {
  if (ready) return;
  ready = true;
  const maker = await ctx.browser.newPage();
  await maker.goto(`${ctx.origin}/tests/blank.html`);
  const files = await maker.evaluate(async () => {
    const h = await import('/tests/helpers.js');
    const b64 = (bytes) => {
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin);
    };
    return {
      photo: b64(await h.canvasBytes(1000, 1000, h.photoLike, 'image/jpeg', 0.95)),
      // At q75 re-encoding as JPEG (q82+) cannot shrink it, but a WebP copy can (measured: 75 KB -> 60 KB).
      optimal: b64(await h.canvasBytes(1200, 900, h.photoLike, 'image/jpeg', 0.75))
    };
  });
  await maker.close();
  const serve = (b64, type) => {
    const buf = Buffer.from(b64, 'base64');
    return (req, res) => {
      res.setHeader('content-type', type);
      res.setHeader('content-length', buf.length);
      res.end(req.method === 'HEAD' ? undefined : buf);
    };
  };
  ctx.routes.set('/wp/photo.jpg', serve(files.photo, 'image/jpeg'));
  ctx.routes.set('/wp/hero.jpg', serve(files.photo, 'image/jpeg'));
  ctx.routes.set('/wp/optimal.jpg', serve(files.optimal, 'image/jpeg'));
  ctx.routes.set('/wp/page.html', (req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><body>
      <img src="/wp/photo.jpg" width="230" height="230" alt="Photo">
      <img src="/wp/optimal.jpg" width="1200" height="900" alt="Optimal">
      <div style="width:230px;height:230px;background:url(/wp/hero.jpg) center/cover"></div>
    </body>`);
  });
}

let seq = 0;
async function open(ctx, { webp }) {
  await setup(ctx);
  const url = `${ctx.origin}/wp/page.html?n=${++seq}`;
  const page = await ctx.browser.newPage();
  await page.goto(url);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  const panel = await ctx.browser.newPage();
  await panel.goto(`chrome-extension://${ctx.extId}/popup.html`);
  const tabId = await panel.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).id, url);
  await panel.evaluate(
    async (id, on) => {
      const { setFolder } = await import('/js/folder-store.js');
      const root = await navigator.storage.getDirectory();
      for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });
      await setFolder(root);
      await window.__iscPopup.ensureAndScan(true, id);
      const box = document.getElementById('webpCheck');
      if (box.checked !== on) box.click();
    },
    tabId,
    webp
  );
  return { page, panel };
}

// Clicks a card action and waits for the job's final status.
const act = (panel, name, action) =>
  panel.evaluate(
    async (n, a) => {
      const status = document.getElementById('compressionStatus');
      status.textContent = '';
      const card = [...document.querySelectorAll('.item-card')].find((c) => c.querySelector('.item-name').textContent === n);
      card.querySelector(`[data-act="${a}"]`).click();
      for (let i = 0; i < 150 && !/^(Saved|Error|Nothing|.*not changed)/.test(status.textContent); i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 200));
      const updated = [...document.querySelectorAll('.item-card')].find((c) => c.querySelector('.item-name').textContent === n);
      return { status: status.textContent, snippets: [...updated.querySelectorAll('.snippet')].map((s) => s.textContent) };
    },
    name,
    action
  );

const folderNames = (panel) =>
  panel.evaluate(async () => {
    const names = [];
    for await (const name of (await navigator.storage.getDirectory()).keys()) names.push(name);
    return names.sort();
  });

export const tests = {
  'resize with WebP on: WebP variants and a <picture> snippet': async (ctx) => {
    const { page, panel } = await open(ctx, { webp: true });
    const res = await act(panel, 'photo.jpg', 'resize');
    const names = await folderNames(panel);
    assert(names.join() === 'photo-230w.jpg,photo-230w.webp,photo-460w.jpg,photo-460w.webp', 'files: ' + names);
    const expected = [
      '<picture>',
      '  <source type="image/webp" srcset="/wp/photo-230w.webp 230w, /wp/photo-460w.webp 460w" sizes="230px">',
      '  <img src="/wp/photo-460w.jpg" srcset="/wp/photo-230w.jpg 230w, /wp/photo-460w.jpg 460w" sizes="230px" width="230" height="230" alt="Photo">',
      '</picture>'
    ].join('\n');
    assert(res.snippets.includes(expected), 'snippet: ' + res.snippets.join('\n---\n'));
    await Promise.all([page.close(), panel.close()]);
  },

  'compress with WebP on: same-size WebP copy and <picture> snippet': async (ctx) => {
    const { page, panel } = await open(ctx, { webp: true });
    const res = await act(panel, 'photo.jpg', 'compress');
    const names = await folderNames(panel);
    assert(names.join() === 'photo.jpg,photo.webp', 'files: ' + names);
    assert(/Saved .*photo\.jpg \+ .*photo\.webp/.test(res.status), res.status);
    const expected = '<picture>\n  <source type="image/webp" srcset="/wp/photo.webp">\n  <img src="/wp/photo.jpg" width="230" height="230" alt="Photo">\n</picture>';
    assert(res.snippets.includes(expected), 'snippet: ' + res.snippets);
    await Promise.all([page.close(), panel.close()]);
  },

  'already-optimal JPEG still gets a WebP copy (and only that)': async (ctx) => {
    const { page, panel } = await open(ctx, { webp: true });
    const res = await act(panel, 'optimal.jpg', 'compress');
    const names = await folderNames(panel);
    assert(names.join() === 'optimal.webp', 'files: ' + names + ' / ' + res.status);
    await Promise.all([page.close(), panel.close()]);
  },

  'CSS background resize with WebP: typed image-set()': async (ctx) => {
    const { page, panel } = await open(ctx, { webp: true });
    const res = await act(panel, 'hero.jpg', 'resize');
    const expected =
      'background-image: url("/wp/hero-230w.jpg");\nbackground-image: image-set(' +
      'url("/wp/hero-230w.webp") type("image/webp") 1x, url("/wp/hero-460w.webp") type("image/webp") 2x, ' +
      'url("/wp/hero-230w.jpg") type("image/jpeg") 1x, url("/wp/hero-460w.jpg") type("image/jpeg") 2x);';
    assert(res.snippets.includes(expected), 'snippet: ' + res.snippets);
    await Promise.all([page.close(), panel.close()]);
  },

  'WebP is off by default: no .webp files or <picture>': async (ctx) => {
    const { page, panel } = await open(ctx, { webp: false });
    const res = await act(panel, 'photo.jpg', 'compress');
    const names = await folderNames(panel);
    assert(names.join() === 'photo.jpg', 'files: ' + names);
    assert(!res.snippets.length, 'unexpected snippet');
    await Promise.all([page.close(), panel.close()]);
  }
};
