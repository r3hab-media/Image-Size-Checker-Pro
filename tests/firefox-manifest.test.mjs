// The Firefox manifest is generated from manifest.json; Chrome and Edge keep theirs as committed.
// (The Firefox build itself runs in Firefox with npm run test:firefox.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { firefoxManifest, FIREFOX_ID } from '../scripts/firefox-manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

export const tests = {
  'Firefox manifest: background scripts with the offscreen shim, sidebar, gecko settings': async () => {
    const m = manifest();
    const ff = firefoxManifest(m);
    const want = (cond, msg) => {
      if (!cond) throw new Error(msg);
    };
    want(JSON.stringify(ff.background) === JSON.stringify({ scripts: ['js/offscreen-shim.js', 'background.js'] }), 'background ' + JSON.stringify(ff.background));
    want(ff.sidebar_action?.default_panel === m.side_panel.default_path && ff.sidebar_action.open_at_install === false, 'sidebar_action');
    want(!ff.side_panel && !ff.minimum_chrome_version, 'Chrome-only keys left in');
    want(ff.permissions.join() === m.permissions.filter((p) => p !== 'sidePanel' && p !== 'offscreen').join(), 'permissions ' + ff.permissions);
    want(JSON.stringify(ff.host_permissions) === JSON.stringify(m.host_permissions), 'host permissions differ');
    const gecko = ff.browser_specific_settings.gecko;
    want(gecko.id === FIREFOX_ID && gecko.strict_min_version === '140.0', 'gecko ' + JSON.stringify(gecko));
    want(JSON.stringify(gecko.data_collection_permissions) === '{"required":["none"]}', 'data collection');
    want(ff.browser_specific_settings.gecko_android?.strict_min_version === '142.0', 'gecko_android');
    for (const k of ['name', 'version', 'description', 'homepage_url', 'action', 'icons', 'content_scripts', 'commands']) {
      want(JSON.stringify(ff[k]) === JSON.stringify(m[k]), `${k} differs`);
    }
  },

  'generating the Firefox manifest leaves manifest.json untouched': async () => {
    const m = manifest();
    const before = JSON.stringify(m);
    firefoxManifest(m);
    if (JSON.stringify(m) !== before) throw new Error('firefoxManifest mutated its input');
    if (!m.background.service_worker || m.browser_specific_settings) throw new Error('manifest.json has Firefox keys');
  }
};
