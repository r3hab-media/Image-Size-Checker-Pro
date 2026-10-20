// Publishes a GitHub Release for the version in manifest.json: builds the store ZIP from main,
// tags that commit v<version>, and attaches the ZIP, so every store upload is recorded with the
// exact code it came from. Upload the ZIP this prints to both stores.
// Extra arguments go to `gh release create`, e.g. npm run release -- --notes "One-line summary".
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts }).trim();
const fail = (msg) => {
  console.error('Cannot release: ' + msg);
  process.exit(1);
};

// Only released code from main, exactly as pushed, so the tag matches what reviewers can see.
if (run('git', ['branch', '--show-current']) !== 'main') fail('switch to main first');
if (run('git', ['status', '--porcelain'])) fail('commit or stash your changes first');
run('git', ['fetch', '--quiet', '--tags', 'origin']);
const head = run('git', ['rev-parse', 'HEAD']);
if (head !== run('git', ['rev-parse', 'origin/main'])) fail('main is not in sync with origin/main (pull or push first)');

const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const tag = `v${version}`;
if (run('git', ['tag', '--list', tag])) fail(`${tag} already exists; bump the version in manifest.json and package.json`);

// The package script checks the manifest and refuses uncommitted runtime files.
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'package.mjs')], { cwd: ROOT, stdio: 'inherit' });
const zip = path.join('dist', `image-size-checker-pro-${version}.zip`);

execFileSync(
  'gh',
  ['release', 'create', tag, zip, '--target', head, '--title', version, '--generate-notes', ...process.argv.slice(2)],
  { cwd: ROOT, stdio: 'inherit' }
);
run('git', ['fetch', '--quiet', '--tags', 'origin']);
console.log(`\nReleased ${tag} at ${head.slice(0, 7)}. Upload ${zip} to the Chrome Web Store and Edge Add-ons.`);
