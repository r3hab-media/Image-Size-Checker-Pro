// Test runner: serves the repo over HTTP, launches real Chrome with the unpacked extension,
// and runs every tests/*.test.mjs file. Set CHROME_PATH to override the Chrome location.
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME =
  process.env.CHROME_PATH ||
  {
    win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    linux: '/usr/bin/google-chrome'
  }[process.platform];

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

// Routes registered by tests (e.g. fixture images with specific headers) take precedence over files.
const routes = new Map();
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = routes.get(url.pathname);
  if (route) return route(req, res);
  const file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404;
    return res.end('not found');
  }
  res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  pipe: true,
  enableExtensions: true,
  headless: process.env.HEADFUL ? false : true,
  args: ['--no-first-run', '--no-default-browser-check']
});
const extId = await browser.installExtension(ROOT);
const ctx = { browser, origin, extId, routes, root: ROOT };

const filter = process.argv[2];
const files = fs
  .readdirSync(path.join(ROOT, 'tests'))
  .filter((f) => f.endsWith('.test.mjs') && (!filter || f.includes(filter)))
  .sort();

let passed = 0;
let failed = 0;
for (const file of files) {
  const mod = await import(pathToFileURL(path.join(ROOT, 'tests', file)).href);
  console.log(`\n${file}`);
  for (const [name, fn] of Object.entries(mod.tests || {})) {
    if (process.argv[3] && !name.includes(process.argv[3])) continue;
    const started = Date.now();
    try {
      await fn(ctx);
      passed++;
      console.log(`  ✓ ${name} (${Date.now() - started}ms)`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${name}\n    ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 6).join('\n    ')}`);
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
