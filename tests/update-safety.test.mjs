// Updates must not disable existing installs or re-prompt users. Compare the manifest with the one in the
// latest release tag: no new permissions, host permissions or content-script matches, and the same name.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

function released() {
  const tag = git('tag', '--list', 'v*', '--sort=-v:refname').split('\n')[0];
  if (!tag) return null;
  return { tag, manifest: JSON.parse(git('show', `${tag}:manifest.json`)) };
}

const current = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const added = (now = [], before = []) => now.filter((p) => !before.includes(p));

export const tests = {
  'no new permissions, host permissions or content-script matches since the last release': async () => {
    const last = released();
    if (!last) return;
    const now = current();
    const problems = [
      ...added(now.permissions, last.manifest.permissions).map((p) => `permission ${p}`),
      ...added(now.host_permissions, last.manifest.host_permissions).map((p) => `host permission ${p}`),
      ...added(
        (now.content_scripts || []).flatMap((c) => c.matches),
        (last.manifest.content_scripts || []).flatMap((c) => c.matches)
      ).map((p) => `content-script match ${p}`)
    ];
    if (problems.length) throw new Error(`new since ${last.tag} (would re-prompt users): ${problems.join(', ')}`);
  },

  'name and key are unchanged since the last release, and the version went up': async () => {
    const last = released();
    if (!last) return;
    const now = current();
    if (now.name !== last.manifest.name) throw new Error(`name changed: ${now.name}`);
    if (now.key !== last.manifest.key) throw new Error('manifest key changed');
    const v = (s) => s.split('.').map(Number);
    const [a, b] = [v(now.version), v(last.manifest.version)];
    const cmp = a.map((n, i) => n - (b[i] || 0)).find((d) => d !== 0) || 0;
    if (cmp <= 0) throw new Error(`version ${now.version} is not above ${last.manifest.version} (${last.tag})`);
  },

  'homepage_url points at the project site': async () => {
    const url = current().homepage_url;
    if (url !== 'https://r3hab-media.github.io/Image-Size-Checker-Pro/') throw new Error('homepage_url ' + url);
  }
};
