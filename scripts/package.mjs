// Builds the store uploads:
// - dist/image-size-checker-pro-<version>.zip for the Chrome Web Store and Edge Add-ons (manifest.json as is)
// - dist/image-size-checker-pro-<version>-firefox.zip for Firefox Add-ons (manifest from scripts/firefox-manifest.mjs),
//   plus the same files unpacked in dist/firefox/ for about:debugging and npm run test:firefox.
// Only git-tracked runtime files are included (no tests, notes, store assets or node_modules),
// and the build fails if the manifest is not uploadable.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip } from '../js/zip.js';
import { firefoxManifest, FIREFOX_ONLY_FILES } from './firefox-manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f));

// Runtime files: the manifest, top-level pages/scripts/styles, and these folders.
const INCLUDE_DIRS = ['js/', 'icons/', 'fonts/'];
const INCLUDE_TOP = /^(manifest\.json|[^/]+\.(html|js|css))$/;

const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
const files = tracked.filter((f) => INCLUDE_TOP.test(f) || INCLUDE_DIRS.some((d) => f.startsWith(d))).sort();

const manifest = JSON.parse(read('manifest.json'));
const pkg = JSON.parse(read('package.json'));
const problems = [];

if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3');
if (manifest.version !== pkg.version) problems.push(`manifest version ${manifest.version} != package.json version ${pkg.version}`);
if (manifest.name.length > 75) problems.push(`name is ${manifest.name.length} characters (max 75)`);
if (manifest.description.length > 132) problems.push(`description is ${manifest.description.length} characters (max 132)`);

// Every file the manifest points at must be in the package.
const referenced = [
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  manifest.action?.default_popup,
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  ...(manifest.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])])
]
  .filter(Boolean)
  .map((f) => f.split('?')[0]);
for (const f of new Set([...referenced, ...FIREFOX_ONLY_FILES])) if (!files.includes(f)) problems.push(`manifest references ${f}, which is not packaged`);

// Uncommitted changes would not match what was tested and reviewed.
const dirty = execFileSync('git', ['status', '--porcelain', '--', ...files], { cwd: ROOT, encoding: 'utf8' }).trim();
if (dirty && !process.argv.includes('--allow-dirty')) problems.push(`uncommitted changes in packaged files (use --allow-dirty to override):\n${dirty}`);

if (problems.length) {
  console.error('Cannot package:\n- ' + problems.join('\n- '));
  process.exit(1);
}

async function writeZip(name, entries) {
  const out = path.join(ROOT, 'dist', name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(await makeZip(entries).arrayBuffer()));
  console.log(`dist/${name}: ${entries.length} files, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
}

// Chrome and Edge: the manifest exactly as committed, without the Firefox-only shim.
const chromeFiles = files.filter((f) => !FIREFOX_ONLY_FILES.includes(f));
await writeZip(`image-size-checker-pro-${manifest.version}.zip`, chromeFiles.map((name) => ({ name, data: new Uint8Array(read(name)) })));

// Firefox: same files, generated manifest.
const ffManifest = new TextEncoder().encode(JSON.stringify(firefoxManifest(manifest), null, 2) + '\n');
const ffEntries = files.map((name) => ({ name, data: name === 'manifest.json' ? ffManifest : new Uint8Array(read(name)) }));
await writeZip(`image-size-checker-pro-${manifest.version}-firefox.zip`, ffEntries);
const ffDir = path.join(ROOT, 'dist', 'firefox');
fs.rmSync(ffDir, { recursive: true, force: true });
for (const { name, data } of ffEntries) {
  fs.mkdirSync(path.dirname(path.join(ffDir, name)), { recursive: true });
  fs.writeFileSync(path.join(ffDir, name), data);
}

for (const f of files) console.log('  ' + f + (FIREFOX_ONLY_FILES.includes(f) ? ' (Firefox only)' : ''));
