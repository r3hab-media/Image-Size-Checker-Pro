// Firefox only (listed before background.js in the Firefox manifest's background.scripts).
// Firefox has no chrome.offscreen API, but its background is an event page with a DOM, so the same
// offscreen.html runs in a hidden iframe there. The iframe is its own extension context, so the
// runtime messages between background.js and offscreen.js work exactly as they do in Chrome.
if (!chrome.offscreen) {
  let frame = null;
  let loading = null;
  chrome.offscreen = {
    async hasDocument() {
      return Boolean(frame);
    },
    createDocument({ url }) {
      if (loading) return loading;
      loading = new Promise((resolve, reject) => {
        frame = document.createElement('iframe');
        // load fires after offscreen.js (a module script) has run and registered its listener.
        frame.addEventListener('load', () => resolve(), { once: true });
        frame.addEventListener('error', () => reject(new Error('Could not load ' + url)), { once: true });
        frame.src = chrome.runtime.getURL(url);
        (document.body || document.documentElement).appendChild(frame);
      }).finally(() => {
        loading = null;
      });
      return loading;
    },
    async closeDocument() {
      frame?.remove();
      frame = null;
    }
  };
}
