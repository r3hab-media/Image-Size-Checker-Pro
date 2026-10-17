// Saving into the chosen folder when Chrome's folder grant has lapsed. The real grant can only be
// given through Chrome's own prompt (which tests cannot click), so these tests use the folder
// store's simulated-permission hook; everything else (popup, background job, access window,
// file write) is the real code path.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

let seq = 0;
async function setup(ctx, permission) {
  const demo = await ctx.browser.newPage();
  await demo.goto(`chrome-extension://${ctx.extId}/demo-playground.html?fa=${++seq}`);
  const tabId = await demo.evaluate(async () => (await chrome.tabs.getCurrent()).id);
  const popup = await ctx.browser.newPage();
  await popup.goto(`chrome-extension://${ctx.extId}/popup.html`);
  await popup.evaluate(
    async (id, perm) => {
      const store = await import('/js/folder-store.js');
      const root = await navigator.storage.getDirectory();
      for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });
      await store.setFolder(root);
      await store.setSimulatedPermission(perm);
      await window.__iscPopup.ensureAndScan(true, id);
    },
    tabId,
    permission
  );
  return { demo, popup };
}

// Clicks Compress on the playground's heavy PNG; resolves with the access window page if one opens.
async function clickCompress(ctx, popup) {
  const windowTarget = ctx.browser.waitForTarget((t) => t.url().includes('folder.html?grant='), { timeout: 8000 }).catch(() => null);
  await popup.evaluate(() => {
    document.getElementById('compressionStatus').textContent = '';
    const card = [...document.querySelectorAll('.item-card')].find((c) => c.querySelector('.item-name').textContent === 'hero-dashboard.png');
    card.querySelector('[data-act="compress"]').click();
  });
  const target = await windowTarget;
  return target ? target.page() : null;
}

const waitStatus = (popup, re) =>
  popup.evaluate(async (source) => {
    const pattern = new RegExp(source);
    const el = document.getElementById('compressionStatus');
    for (let i = 0; i < 150 && !pattern.test(el.textContent); i++) await new Promise((r) => setTimeout(r, 100));
    return el.textContent;
  }, re.source);

const folderFiles = (popup) =>
  popup.evaluate(async () => {
    const names = [];
    for await (const name of (await navigator.storage.getDirectory()).keys()) names.push(name);
    return names;
  });

async function cleanup(popup, ...pages) {
  await popup.evaluate(async () => (await import('/js/folder-store.js')).setSimulatedPermission(null)).catch(() => {});
  for (const p of [popup, ...pages]) await p.close().catch(() => {});
}

export const tests = {
  'lapsed folder grant: an access window opens, Allow saves the file, the window closes': async (ctx) => {
    const { demo, popup } = await setup(ctx, 'prompt');
    const win = await clickCompress(ctx, popup);
    assert(win, 'no access window opened');
    const waiting = await waitStatus(popup, /Waiting for access/);
    assert(/Waiting for access/.test(waiting), 'popup should say it is waiting: ' + waiting);
    await win.waitForSelector('#allowBtn');
    await win.click('#allowBtn');
    const status = await waitStatus(popup, /^Saved|^Error/);
    assert(/^Saved/.test(status), 'status: ' + status);
    assert((await folderFiles(popup)).includes('hero-dashboard.png'), 'file not written');
    await sleep(2500);
    assert(win.isClosed(), 'access window should close itself after saving');
    await cleanup(popup, demo);
  },

  'denied folder access: nothing is saved and the reason is shown': async (ctx) => {
    const { demo, popup } = await setup(ctx, 'denied');
    const win = await clickCompress(ctx, popup);
    assert(win, 'no access window opened');
    await win.waitForSelector('#allowBtn');
    await win.click('#allowBtn');
    const status = await waitStatus(popup, /^Error/);
    assert(/Folder access was not granted/.test(status), 'status: ' + status);
    assert(!(await folderFiles(popup)).length, 'nothing should be written');
    await cleanup(popup, demo, win);
  },

  'closing the access window without answering ends the job instead of hanging': async (ctx) => {
    const { demo, popup } = await setup(ctx, 'prompt');
    const win = await clickCompress(ctx, popup);
    assert(win, 'no access window opened');
    await win.close();
    const status = await waitStatus(popup, /^Error/);
    assert(/Folder access was not granted/.test(status), 'status: ' + status);
    await cleanup(popup, demo);
  },

  'a still-valid folder grant saves directly with no access window': async (ctx) => {
    const { demo, popup } = await setup(ctx, null);
    const win = await clickCompress(ctx, popup);
    assert(!win, 'no window should open when access is already granted');
    const status = await waitStatus(popup, /^Saved|^Error/);
    assert(/^Saved/.test(status), 'status: ' + status);
    await cleanup(popup, demo);
  }
};
