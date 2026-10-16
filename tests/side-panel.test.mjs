// Side panel: opened from the toolbar, follows the active tab, and lays out at any panel width.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function panelPage(ctx, width = 750) {
  const panel = await ctx.browser.newPage();
  await panel.setViewport({ width, height: 700 });
  await panel.goto(`chrome-extension://${ctx.extId}/popup.html`);
  return panel;
}

async function waitForPanelUrl(panel, expected, timeout = 5000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    last = await panel.evaluate(() => window.__iscPopup.getState()?.pageUrl);
    if (last === expected) return;
    await sleep(100);
  }
  throw new Error(`panel shows ${last}, expected ${expected}`);
}

export const tests = {
  'toolbar button opens the side panel (no popup)': async (ctx) => {
    const page = await ctx.browser.newPage();
    await page.goto(`chrome-extension://${ctx.extId}/tests/blank.html`);
    // The service worker sets the behavior when it starts, which can be just after install.
    const res = await page.evaluate(async () => {
      let behavior;
      for (let i = 0; i < 30; i++) {
        behavior = await chrome.sidePanel.getPanelBehavior();
        if (behavior.openPanelOnActionClick) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return { behavior, options: await chrome.sidePanel.getOptions({}), popup: await chrome.action.getPopup({}) };
    });
    await page.close();
    if (!res.behavior.openPanelOnActionClick) throw new Error('openPanelOnActionClick not set');
    if (!res.options.path || !res.options.path.endsWith('popup.html')) throw new Error('panel path ' + res.options.path);
    if (res.popup) throw new Error('action still has a popup: ' + res.popup);
  },

  'panel follows tab switches and navigations': async (ctx) => {
    const panel = await panelPage(ctx);
    const a = await ctx.browser.newPage();
    const urlA = `${ctx.origin}/tests/blank.html?tabA`;
    await a.goto(urlA);
    await a.bringToFront();
    await waitForPanelUrl(panel, urlA);

    const b = await ctx.browser.newPage();
    const urlB = `${ctx.origin}/tests/blank.html?tabB`;
    await b.goto(urlB);
    await b.bringToFront();
    await waitForPanelUrl(panel, urlB);

    await a.bringToFront();
    await waitForPanelUrl(panel, urlA);

    const urlA2 = `${ctx.origin}/tests/blank.html?tabA-navigated`;
    await a.goto(urlA2);
    await waitForPanelUrl(panel, urlA2);

    await Promise.all([a.close(), b.close(), panel.close()]);
  },

  'layout has no horizontal overflow from 320px to 750px': async (ctx) => {
    const demo = await ctx.browser.newPage();
    await demo.goto(`chrome-extension://${ctx.extId}/demo-playground.html`);
    const tabId = await demo.evaluate(async () => (await chrome.tabs.getCurrent()).id);
    for (const width of [320, 400, 600, 750]) {
      const panel = await panelPage(ctx, width);
      await panel.evaluate((id) => window.__iscPopup.ensureAndScan(true, id), tabId);
      const overflow = await panel.evaluate(() => {
        const doc = document.documentElement;
        const wide = [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > doc.clientWidth + 1);
        return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, offenders: wide.slice(0, 3).map((el) => el.className || el.tagName) };
      });
      await panel.close();
      if (overflow.scrollWidth > overflow.clientWidth || overflow.offenders.length) {
        throw new Error(`overflow at ${width}px: ${JSON.stringify(overflow)}`);
      }
    }
    await demo.close();
  }
};
