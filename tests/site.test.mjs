// The project site in docs/ (GitHub Pages): links, images, page weight, share card, privacy text and layout.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const PAGES = ['docs/index.html', 'docs/privacy.html'];
const SITE = 'https://r3hab-media.github.io/Image-Size-Checker-Pro/';

const attrs = (html, tag) => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'gi'))].map((m) => m[0]);
const attr = (el, name) => el.match(new RegExp(`\\s${name}="([^"]*)"`, 'i'))?.[1];
const text = (s) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*|`/g, '')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

export const tests = {
  'every local link, image and stylesheet on the site exists': async () => {
    const missing = [];
    for (const page of PAGES) {
      const html = read(page);
      const refs = [
        ...[...html.matchAll(/\s(?:href|src)="([^"]+)"/g)].map((m) => m[1]),
        ...[...html.matchAll(/\ssrcset="([^"]+)"/g)].flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+/)[0]))
      ];
      for (let ref of refs) {
        if (/^(https?:|mailto:|#)/.test(ref)) continue;
        ref = ref.split('#')[0];
        const file = path.join(DOCS, ref === './' || ref === '' ? 'index.html' : ref);
        if (!fs.existsSync(file)) missing.push(`${page}: ${ref}`);
      }
    }
    if (missing.length) throw new Error('missing: ' + missing.join(', '));
  },

  'no scripts or third-party resources, only links out': async () => {
    for (const page of PAGES) {
      const html = read(page);
      if (/<script\b/i.test(html)) throw new Error(`${page} has a script`);
      if (/<iframe\b/i.test(html)) throw new Error(`${page} has an iframe`);
      for (const el of [...attrs(html, 'img'), ...attrs(html, 'link'), ...attrs(html, 'source')]) {
        if (/<link\b/i.test(el) && !/rel="(stylesheet|icon|preload)"/.test(el)) continue;
        const url = attr(el, 'src') || attr(el, 'href') || '';
        if (/^https?:/.test(url)) throw new Error(`${page} loads ${url}`);
      }
    }
    if (/@import|url\(\s*["']?https?:/i.test(read('docs/site.css'))) throw new Error('site.css loads a remote resource');
  },

  'images have alt text, dimensions, and only the first screenshot loads eagerly': async () => {
    for (const page of PAGES) {
      const imgs = attrs(read(page), 'img');
      imgs.forEach((img, i) => {
        if (attr(img, 'alt') === undefined) throw new Error(`${page}: img without alt: ${img}`);
        if (!attr(img, 'width') || !attr(img, 'height')) throw new Error(`${page}: img without width/height: ${img}`);
        const src = attr(img, 'src');
        if (src.includes('screenshot') && attr(img, 'alt').length < 40) throw new Error(`${page}: screenshot alt too short: ${src}`);
        if (src.includes('screenshot') && !src.endsWith('.webp')) throw new Error(`${page}: screenshot is not WebP: ${src}`);
        const firstShot = imgs.findIndex((x) => attr(x, 'src').includes('screenshot')) === i;
        if (src.includes('screenshot') && !firstShot && attr(img, 'loading') !== 'lazy') throw new Error(`${page}: below-fold screenshot not lazy: ${src}`);
        if (firstShot && attr(img, 'loading') === 'lazy') throw new Error(`${page}: the hero image is lazy (hurts LCP)`);
      });
    }
  },

  'the landing page stays under 300 KB at its largest image sizes': async () => {
    const html = read('docs/index.html');
    const files = new Set(['index.html', 'site.css']);
    for (const img of attrs(html, 'img')) {
      const set = attr(img, 'srcset');
      files.add(set ? set.split(',').pop().trim().split(/\s+/)[0] : attr(img, 'src'));
    }
    const total = [...files].reduce((n, f) => n + fs.statSync(path.join(DOCS, f)).size, 0);
    if (total > 300 * 1024) throw new Error(`landing page is ${(total / 1024).toFixed(0)} KB`);
  },

  'share card: Open Graph and X tags with a 1200x630 image': async () => {
    const html = read('docs/index.html');
    const meta = (key) => attrs(html, 'meta').find((m) => attr(m, 'property') === key || attr(m, 'name') === key);
    for (const key of ['og:title', 'og:description', 'og:url', 'og:image', 'og:image:alt', 'twitter:card', 'twitter:image', 'twitter:image:alt']) {
      if (!meta(key) || !attr(meta(key), 'content')) throw new Error('missing ' + key);
    }
    if (attr(meta('twitter:card'), 'content') !== 'summary_large_image') throw new Error('twitter:card');
    const image = attr(meta('og:image'), 'content');
    if (!image.startsWith(SITE)) throw new Error('og:image must be an absolute site URL: ' + image);
    const png = fs.readFileSync(path.join(DOCS, image.slice(SITE.length)));
    const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
    if (w !== 1200 || h !== 630) throw new Error(`og image is ${w}x${h}`);
    if (png.length > 300 * 1024) throw new Error(`og image is ${(png.length / 1024).toFixed(0)} KB`);
  },

  'the privacy page carries the same text as PRIVACY.md': async () => {
    const page = text(read('docs/privacy.html').split('<main')[1].split('</main>')[0].replace(/^[^>]*>/, ''));
    const paras = read('PRIVACY.md')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((l) => text(l.replace(/^#+\s*|^-\s*/, '')))
      .filter(Boolean);
    const missing = paras.filter((p) => !page.includes(p));
    if (missing.length) throw new Error('privacy.html is missing: ' + missing.join(' | '));
  },

  'user-facing text has no em dashes': async () => {
    for (const f of [...PAGES, 'CHANGELOG.md', 'store/LISTING.md', 'PRIVACY.md']) {
      if (read(f).includes('—')) throw new Error(`${f} has an em dash`);
    }
  },

  'the landing page fits a phone screen and shows focus outlines': async (ctx) => {
    const page = await ctx.browser.newPage();
    await page.setViewport({ width: 360, height: 740 });
    await page.goto(`${ctx.origin}/docs/index.html`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 0) throw new Error(`horizontal scroll of ${overflow}px at 360px`);
    await page.keyboard.press('Tab');
    const skip = await page.evaluate(() => ({
      text: document.activeElement.textContent,
      outline: getComputedStyle(document.activeElement).outlineStyle,
      top: document.activeElement.getBoundingClientRect().top
    }));
    if (skip.text !== 'Skip to content' || skip.outline === 'none' || skip.top < 0) throw new Error('skip link ' + JSON.stringify(skip));
    for (let i = 0; i < 3; i++) await page.keyboard.press('Tab');
    const btn = await page.evaluate(() => ({ text: document.activeElement.textContent, outline: getComputedStyle(document.activeElement).outlineWidth }));
    if (btn.text !== 'Add to Chrome' || btn.outline !== '3px') throw new Error('install button focus ' + JSON.stringify(btn));
    await page.close();
  }
};
