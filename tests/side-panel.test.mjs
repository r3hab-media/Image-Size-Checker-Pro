// Toolbar popup (750px) and side panel (popup.html?panel=1): opening, tab following, and layout.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function panelPage(ctx, width = 750) {
  const panel = await ctx.browser.newPage();
  await panel.setViewport({ width, height: 700 });
  await panel.goto(`chrome-extension://${ctx.extId}/popup.html?panel=1`);
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
  'toolbar opens the 750px popup; the side panel is available separately': async (ctx) => {
    const page = await ctx.browser.newPage();
    await page.goto(`chrome-extension://${ctx.extId}/tests/blank.html`);
    // The service worker sets the behavior when it starts, which can be just after install.
    const res = await page.evaluate(async () => {
      let behavior;
      for (let i = 0; i < 30; i++) {
        behavior = await chrome.sidePanel.getPanelBehavior();
        if (!behavior.openPanelOnActionClick) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return { behavior, options: await chrome.sidePanel.getOptions({}), popup: await chrome.action.getPopup({}) };
    });
    await page.close();
    if (res.behavior.openPanelOnActionClick) throw new Error('toolbar click should open the popup, not the panel');
    if (!res.options.path || !res.options.path.endsWith('popup.html?panel=1')) throw new Error('panel path ' + res.options.path);
    if (!res.popup.endsWith('/popup.html')) throw new Error('action popup ' + res.popup);
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

  'popup is 750px wide with options collapsed, and the image list is visible without scrolling': async (ctx) => {
    const demo = await ctx.browser.newPage();
    await demo.goto(`chrome-extension://${ctx.extId}/demo-playground.html`);
    const tabId = await demo.evaluate(async () => (await chrome.tabs.getCurrent()).id);
    const popup = await ctx.browser.newPage();
    await popup.setViewport({ width: 750, height: 600 }); // Chrome's maximum popup height
    await popup.goto(`chrome-extension://${ctx.extId}/popup.html`);
    await popup.evaluate((id) => window.__iscPopup.ensureAndScan(true, id), tabId);
    const view = await popup.evaluate(() => {
      const list = document.getElementById('itemsList');
      const firstCard = document.querySelector('.item-card').getBoundingClientRect();
      return {
        bodyWidth: document.body.getBoundingClientRect().width,
        panelClass: document.documentElement.classList.contains('panel'),
        optionsOpen: document.getElementById('outputOptions').open,
        firstCardTop: firstCard.top,
        listScrollsInside: list.scrollHeight > list.clientHeight + 1,
        pageScrolls: document.documentElement.scrollHeight > window.innerHeight,
        sidePanelBtnVisible: !document.getElementById('openPanelBtn').hidden
      };
    });
    await Promise.all([demo.close(), popup.close()]);
    if (view.bodyWidth !== 750 || view.panelClass) throw new Error('popup width ' + JSON.stringify(view));
    if (view.optionsOpen) throw new Error('output options should start collapsed');
    if (!(view.firstCardTop < 420)) throw new Error('first image card starts too low: ' + view.firstCardTop);
    if (view.listScrollsInside || !view.pageScrolls) throw new Error('the page, not just the list, should scroll: ' + JSON.stringify(view));
    if (!view.sidePanelBtnVisible) throw new Error('popup should offer the side panel button');
  },

  'stale-copy banner shows only when the content script version does not match': async (ctx) => {
    const demo = await ctx.browser.newPage();
    await demo.goto(`chrome-extension://${ctx.extId}/demo-playground.html`);
    const tabId = await demo.evaluate(async () => (await chrome.tabs.getCurrent()).id);
    const popup = await ctx.browser.newPage();
    await popup.goto(`chrome-extension://${ctx.extId}/popup.html`);
    const res = await popup.evaluate(async (id) => {
      await window.__iscPopup.ensureAndScan(true, id);
      const banner = document.getElementById('staleBanner');
      const current = banner.classList.contains('hidden');
      window.__iscPopup.showStaleBanner(true);
      await new Promise((r) => setTimeout(r, 100));
      return {
        hiddenForCurrent: current,
        textWhenStale: banner.textContent,
        accessBannerHidden: document.getElementById('accessBanner').classList.contains('hidden'),
        scheme: navigator.userAgentData.brands.some((b) => b.brand === 'Microsoft Edge') ? 'edge' : 'chrome'
      };
    }, tabId);
    await Promise.all([demo.close(), popup.close()]);
    if (!res.hiddenForCurrent) throw new Error('banner shown for an up-to-date content script');
    if (!res.accessBannerHidden) throw new Error('site-access banner shown although all sites are allowed');
    // Names the extensions page of the browser it is running in (Chrome or Edge).
    if (!res.textWhenStale.includes(`Open ${res.scheme}://extensions`)) throw new Error('banner text: ' + res.textWhenStale);
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
  },

  'the side panel hides its own "Side panel" button; the popup shows it and Choose Folder': async (ctx) => {
    const display = (page, id) => page.evaluate((i) => getComputedStyle(document.getElementById(i)).display, id);
    const panel = await panelPage(ctx);
    const inPanel = await display(panel, 'openPanelBtn');
    await panel.close();
    const popup = await ctx.browser.newPage();
    await popup.goto(`chrome-extension://${ctx.extId}/popup.html`);
    const [inPopup, folder] = [await display(popup, 'openPanelBtn'), await display(popup, 'chooseFolderBtn')];
    await popup.close();
    if (inPanel !== 'none') throw new Error('side panel shows the side panel button: ' + inPanel);
    if (inPopup === 'none' || folder === 'none') throw new Error(`popup buttons: panel ${inPopup}, folder ${folder}`);
  }
};

