// Resize for display: srcset variants, filenames, snippets, and which images offer it.
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
      portrait: b64(await h.canvasBytes(1000, 1000, h.photoLike, 'image/jpeg', 0.92)),
      logo: b64(await h.canvasBytes(1000, 1000, h.noisyTranslucent, 'image/png')),
      mid: b64(await h.canvasBytes(700, 350, h.photoLike, 'image/jpeg', 0.92))
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
  ctx.routes.set('/rz/portrait.jpg', serve(files.portrait, 'image/jpeg'));
  ctx.routes.set('/rz/logo.png', serve(files.logo, 'image/png'));
  ctx.routes.set('/rz/hero-bg.jpg', serve(files.portrait, 'image/jpeg'));
  ctx.routes.set('/rz/mid.jpg', serve(files.mid, 'image/jpeg'));
  const gif = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
  ctx.routes.set('/rz/anim.gif', (req, res) => {
    res.setHeader('content-type', 'image/gif');
    res.end(gif);
  });
  ctx.routes.set('/rz/page.html', (req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><body>
      <img src="/rz/portrait.jpg" width="230" height="230" alt='Jared "the" portrait'>
      <img src="/rz/logo.png" width="44" height="44" alt="Logo">
      <img src="/rz/mid.jpg" width="400" height="200" alt="Mid">
      <img src="/rz/anim.gif" width="30" height="30" alt="gif">
      <div id="hero" style="width:230px;height:230px;background:url(/rz/hero-bg.jpg) center/cover"></div>
    </body>`);
  });
}

let seq = 0;
async function open(ctx) {
  await setup(ctx);
  const url = `${ctx.origin}/rz/page.html?n=${++seq}`;
  const page = await ctx.browser.newPage();
  await page.goto(url);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  const panel = await ctx.browser.newPage();
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

// Lists the chosen (OPFS) folder with each image's decoded dimensions.
const listFolder = (panel) =>
  panel.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const out = {};
    for await (const [name, h] of root.entries()) {
      const file = await h.getFile();
      if (/\.(jpg|png)$/.test(name)) {
        const bmp = await createImageBitmap(file);
        out[name] = { w: bmp.width, h: bmp.height, type: file.type || name.split('.').pop() };
      } else out[name] = { text: await file.text() };
    }
    return out;
  });

export const tests = {
  'Resize is offered only for oversized PNG/JPEG/WebP images': async (ctx) => {
    const { page, panel } = await open(ctx);
    const view = await panel.evaluate(() => ({
      count: document.getElementById('resizeCountBadge').textContent,
      buttons: [...document.querySelectorAll('.mini-btn[data-act="resize"]')].map((b) => b.closest('.item-card').querySelector('.item-name').textContent)
    }));
    assert(view.count === '4', `resize count ${view.count}`);
    assert(view.buttons.sort().join() === 'hero-bg.jpg,logo.png,mid.jpg,portrait.jpg', `buttons on ${view.buttons}`);
    await Promise.all([page.close(), panel.close()]);
  },

  'single resize writes 1x/2x files named name-Ww with correct sizes and a working snippet': async (ctx) => {
    const { page, panel } = await open(ctx);
    const result = await panel.evaluate(async () => {
      const card = [...document.querySelectorAll('.item-card')].find((c) => c.querySelector('.item-name').textContent === 'portrait.jpg');
      card.querySelector('[data-act="resize"]').click();
      for (let i = 0; i < 100 && !document.querySelector('.snippet'); i++) await new Promise((r) => setTimeout(r, 100));
      return { snippet: document.querySelector('.snippet')?.textContent, status: document.getElementById('compressionStatus').textContent };
    });
    const files = await listFolder(panel);
    assert(files['portrait-230w.jpg']?.w === 230 && files['portrait-230w.jpg'].h === 230, 'portrait-230w.jpg ' + JSON.stringify(files));
    assert(files['portrait-460w.jpg']?.w === 460, 'portrait-460w.jpg ' + JSON.stringify(files));
    assert(
      result.snippet ===
        '<img src="/rz/portrait-460w.jpg" srcset="/rz/portrait-230w.jpg 230w, /rz/portrait-460w.jpg 460w" sizes="230px" width="230" height="230" alt="Jared &quot;the&quot; portrait">',
      'snippet: ' + result.snippet
    );
    assert(/Saved 2 files/.test(result.status), result.status);
    await Promise.all([page.close(), panel.close()]);
  },

  'when 2x would exceed the original, the original file serves 2x in the srcset': async (ctx) => {
    const { page, panel } = await open(ctx);
    const snippet = await panel.evaluate(async () => {
      const card = [...document.querySelectorAll('.item-card')].find((c) => c.querySelector('.item-name').textContent === 'mid.jpg');
      card.querySelector('[data-act="resize"]').click();
      for (let i = 0; i < 100 && !document.querySelector('.snippet'); i++) await new Promise((r) => setTimeout(r, 100));
      return document.querySelector('.snippet')?.textContent;
    });
    const files = await listFolder(panel);
    assert(files['mid-400w.jpg']?.w === 400 && files['mid-400w.jpg'].h === 200, JSON.stringify(files));
    assert(!Object.keys(files).some((n) => n.startsWith('mid-800w')), 'must not upscale');
    assert(snippet.includes('srcset="/rz/mid-400w.jpg 400w, /rz/mid.jpg 700w"'), snippet);
    await Promise.all([page.close(), panel.close()]);
  },

  'CSS background images get an image-set() snippet instead of srcset': async (ctx) => {
    const { page, panel } = await open(ctx);
    const snippet = await panel.evaluate(async () => {
      const card = [...document.querySelectorAll('.item-card')].find((c) => c.querySelector('.item-name').textContent === 'hero-bg.jpg');
      card.querySelector('[data-act="resize"]').click();
      for (let i = 0; i < 100 && !document.querySelector('.snippet'); i++) await new Promise((r) => setTimeout(r, 100));
      return document.querySelector('.snippet')?.textContent;
    });
    assert(
      snippet ===
        'background-image: url("/rz/hero-bg-230w.jpg");\nbackground-image: image-set(url("/rz/hero-bg-230w.jpg") 1x, url("/rz/hero-bg-460w.jpg") 2x);',
      'snippet: ' + snippet
    );
    await Promise.all([page.close(), panel.close()]);
  },

  'batch resize writes every variant plus srcset-snippets.html': async (ctx) => {
    const { page, panel } = await open(ctx);
    const status = await panel.evaluate(async () => {
      await window.__iscPopup.resizeAllOversized();
      return document.getElementById('compressionStatus').textContent;
    });
    const files = await listFolder(panel);
    const names = Object.keys(files).sort();
    assert(
      names.join() === 'hero-bg-230w.jpg,hero-bg-460w.jpg,logo-44w.png,logo-88w.png,mid-400w.jpg,portrait-230w.jpg,portrait-460w.jpg,srcset-snippets.html',
      'files: ' + names
    );
    assert(files['logo-88w.png'].w === 88, 'logo 2x width');
    const html = files['srcset-snippets.html'].text;
    assert((html.match(/<img /g) || []).length === 3 && html.includes('image-set('), 'snippets file: ' + html);
    assert(/Saved 7 files/.test(status), status);
    await Promise.all([page.close(), panel.close()]);
  }
};
