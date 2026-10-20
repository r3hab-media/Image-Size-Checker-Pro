// Keyboard shortcuts (no default keys; the footer shows what the user assigned) and the privacy link.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function popupPage(ctx) {
  const popup = await ctx.browser.newPage();
  await popup.setViewport({ width: 750, height: 600 });
  await popup.goto(`chrome-extension://${ctx.extId}/popup.html`);
  await popup.waitForFunction(() => document.getElementById('shortcutBtn').textContent.trim() !== '');
  return popup;
}

const footer = (popup) =>
  popup.evaluate(() => ({
    setHidden: document.getElementById('shortcutSet').classList.contains('hidden'),
    key: document.getElementById('shortcutKey').textContent,
    btn: document.getElementById('shortcutBtn').textContent,
    btnIsLink: document.getElementById('shortcutBtn').classList.contains('is-link'),
    toggleTitle: document.getElementById('enabledToggleLabel').title
  }));

export const tests = {
  'commands ship with no default keys': async (ctx) => {
    const popup = await popupPage(ctx);
    const commands = await popup.evaluate(() => chrome.runtime.getManifest().commands);
    await popup.close();
    const names = Object.keys(commands).sort().join(',');
    if (names !== '_execute_action,toggle-inspector') throw new Error('unexpected commands: ' + names);
    for (const [name, c] of Object.entries(commands)) {
      if (c.suggested_key) throw new Error(`${name} has a default key: ${JSON.stringify(c.suggested_key)}`);
      if (!c.description) throw new Error(`${name} needs a description for chrome://extensions/shortcuts`);
    }
  },

  'with no shortcut, the footer offers "Set a shortcut", which opens the browser\'s shortcuts page': async (ctx) => {
    const popup = await popupPage(ctx);
    const view = await footer(popup);
    if (!view.setHidden || view.btn !== 'Set a shortcut' || view.btnIsLink) throw new Error('footer ' + JSON.stringify(view));
    if (view.toggleTitle !== 'Show or hide the on-page image badges') throw new Error('toggle title ' + view.toggleTitle);
    // The same package runs in Chrome and Edge; the button names the browser it is running in.
    const { title, isEdge } = await popup.evaluate(() => ({
      title: document.getElementById('shortcutBtn').title,
      isEdge: navigator.userAgentData.brands.some((b) => b.brand === 'Microsoft Edge')
    }));
    if (title !== `Choose a keyboard shortcut on ${isEdge ? 'Edge' : 'Chrome'}'s shortcuts page`) throw new Error('button title ' + title);

    const opened = ctx.browser.waitForTarget((t) => /^(chrome|edge):\/\/extensions\/shortcuts/.test(t.url()), { timeout: 5000 });
    await popup.click('#shortcutBtn');
    const target = await opened;
    await Promise.all([popup.close(), target.page().then((p) => p && p.close())]);
  },

  'an assigned shortcut is shown, with a "Change" link, and refreshes when the page regains focus': async (ctx) => {
    const popup = await popupPage(ctx);
    // Chrome has no API to assign keys, so stand in for the user setting them on the shortcuts page.
    await popup.evaluate(() => {
      chrome.commands.getAll = async () => [
        { name: '_execute_action', shortcut: 'Alt+Shift+K', description: 'Open Image Size Checker Pro' },
        { name: 'toggle-inspector', shortcut: 'Ctrl+Shift+Y', description: 'Show or hide the on-page image badges' }
      ];
      window.dispatchEvent(new Event('focus'));
    });
    await sleep(100);
    const view = await footer(popup);
    await popup.close();
    if (view.setHidden || view.key !== 'Alt+Shift+K') throw new Error('key not shown ' + JSON.stringify(view));
    if (view.btn !== 'Change' || !view.btnIsLink) throw new Error('change link ' + JSON.stringify(view));
    if (!view.toggleTitle.includes('(Ctrl+Shift+Y)')) throw new Error('toggle title ' + view.toggleTitle);
  },

  'settings link to the privacy policy in a new tab': async (ctx) => {
    const popup = await popupPage(ctx);
    const link = await popup.evaluate(() => {
      const a = document.querySelector('#settingsDrawer a.privacy-link');
      return a && { href: a.href, target: a.target, rel: a.rel, text: a.textContent };
    });
    await popup.close();
    if (!link) throw new Error('no privacy link in settings');
    if (link.href !== 'https://github.com/r3hab-media/Image-Size-Checker-Pro/blob/main/PRIVACY.md') throw new Error('href ' + link.href);
    if (link.target !== '_blank' || !link.rel.includes('noopener')) throw new Error('link ' + JSON.stringify(link));
  }
};
