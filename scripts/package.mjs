// Builds the Chrome Web Store upload: dist/image-size-checker-pro-<version>.zip.
// Only git-tracked runtime files are included (no tests, notes, store assets or node_modules),
// and the build fails if the manifest is not uploadable.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip } from '../js/zip.js';

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
for (const f of new Set(referenced)) if (!files.includes(f)) problems.push(`manifest references ${f}, which is not packaged`);

// Uncommitted changes would not match what was tested and reviewed.
const dirty = execFileSync('git', ['status', '--porcelain', '--', ...files], { cwd: ROOT, encoding: 'utf8' }).trim();
if (dirty && !process.argv.includes('--allow-dirty')) problems.push(`uncommitted changes in packaged files (use --allow-dirty to override):\n${dirty}`);

if (problems.length) {
  console.error('Cannot package:\n- ' + problems.join('\n- '));
  process.exit(1);
}

const zip = makeZip(files.map((name) => ({ name, data: new Uint8Array(read(name)) })));
const out = path.join(ROOT, 'dist', `image-size-checker-pro-${manifest.version}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from(await zip.arrayBuffer()));

console.log(`${path.relative(ROOT, out)}: ${files.length} files, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
for (const f of files) console.log('  ' + f);
