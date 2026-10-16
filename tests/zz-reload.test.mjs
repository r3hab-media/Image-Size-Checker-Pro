// Runs last: reinstalls the extension, which orphans the content script already in open tabs.
export const tests = {
  'open tabs keep working after the extension is reloaded (#33)': async (ctx) => {
    const page = await ctx.browser.newPage();
    await page.goto(`${ctx.origin}/tests/blank.html?reload`);
    await page.evaluate(() => {
      const img = new Image(200, 100);
      img.src = '/icons/icon128.png';
      img.alt = 'icon';
      document.body.appendChild(img);
      return img.decode();
    });

    const scanFrom = async (extId) => {
      const popup = await ctx.browser.newPage();
      await popup.goto(`chrome-extension://${extId}/tests/blank.html`);
      const res = await popup.evaluate(async (url) => {
        const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
        const ensure = await new Promise((r) => chrome.runtime.sendMessage({ type: 'ENSURE_CONTENT_SCRIPT', tabId: tab.id }, r));
        const scan = await new Promise((r) => chrome.tabs.sendMessage(tab.id, { type: 'SCAN_PAGE' }, (x) => r(x || { err: chrome.runtime.lastError?.message })));
        return { ensure, count: scan.items ? scan.items.length : scan.err };
      }, page.url());
      await popup.close();
      return res;
    };

    const before = await scanFrom(ctx.extId);
    if (before.count !== 1) throw new Error('initial scan: ' + JSON.stringify(before));

    await ctx.browser.uninstallExtension(ctx.extId);
    ctx.extId = await ctx.browser.installExtension(ctx.root);

    const after = await scanFrom(ctx.extId);
    if (after.count !== 1) throw new Error('scan after reload: ' + JSON.stringify(after));
    await page.close();
  }
};
