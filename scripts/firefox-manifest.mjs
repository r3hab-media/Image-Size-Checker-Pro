// Derives the Firefox manifest from manifest.json at build time, so Chrome and Edge keep theirs
// unchanged and there is one codebase. Differences:
// - background: Firefox runs background scripts in an event page, not a service worker. The offscreen
//   shim gives it chrome.offscreen (a hidden iframe), so background.js runs unchanged.
// - side panel: Firefox has sidebar_action instead of the sidePanel API.
// - offscreen and sidePanel permissions do not exist in Firefox.
// - browser_specific_settings.gecko: the add-on ID (permanent once published on AMO) and the
//   data collection declaration that AMO requires for new add-ons (Firefox 140+).
// - browser_specific_settings.gecko_android: the add-on is desktop only, but without this key AMO applies
//   the desktop minimum to Firefox for Android too, and Android only supports data_collection_permissions
//   from 142.
export const FIREFOX_ID = 'image-size-checker-pro@r3hab-media.github.io';
export const FIREFOX_MIN_VERSION = '140.0';
export const FIREFOX_ANDROID_MIN_VERSION = '142.0';
export const FIREFOX_ONLY_FILES = ['js/offscreen-shim.js'];

export function firefoxManifest(manifest) {
  const m = structuredClone(manifest);
  m.background = { scripts: ['js/offscreen-shim.js', manifest.background.service_worker] };
  m.permissions = m.permissions.filter((p) => p !== 'sidePanel' && p !== 'offscreen');
  if (m.side_panel) {
    m.sidebar_action = {
      default_panel: m.side_panel.default_path,
      default_title: m.name,
      default_icon: m.action.default_icon,
      open_at_install: false
    };
    delete m.side_panel;
  }
  delete m.minimum_chrome_version;
  m.browser_specific_settings = {
    gecko: {
      id: FIREFOX_ID,
      strict_min_version: FIREFOX_MIN_VERSION,
      data_collection_permissions: { required: ['none'] }
    },
    gecko_android: { strict_min_version: FIREFOX_ANDROID_MIN_VERSION }
  };
  return m;
}
