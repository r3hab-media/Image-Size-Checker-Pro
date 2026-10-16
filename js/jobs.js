// Compression jobs. Runs in the offscreen document so a batch keeps going after the side panel
// closes. Offscreen documents only get chrome.runtime, so downloads and tab access go through
// the service worker.
import { makeZip } from './zip.js';
import { getFolder } from './folder-store.js';

export const KEPT_NOTES = new Set(['kept', 'kept-unsupported', 'kept-animated', 'kept-lossless', 'kept-color-profile']);

function sendRuntime(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (r) => {
      void chrome.runtime.lastError;
      resolve(r || null);
    });
  });
}

function base64ToUint8Array(base64) {
  const bin = atob(base64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function uint8ToDataUrl(bytes, mime) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${mime || 'application/octet-stream'};base64,${btoa(binary)}`;
}

// ---------- compression worker ----------

let worker = null;
let jobSeq = 0;
const pendingJobs = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const job = pendingJobs.get(e.data.id);
      if (!job) return;
      pendingJobs.delete(e.data.id);
      if (e.data.ok) job.resolve(e.data);
      else job.reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      for (const job of pendingJobs.values()) job.reject(new Error(e.message || 'Compression worker crashed'));
      pendingJobs.clear();
      worker = null;
    };
  }
  return worker;
}

function compressInWorker(buffer, options) {
  return new Promise((resolve, reject) => {
    const id = ++jobSeq;
    pendingJobs.set(id, { resolve, reject });
    getWorker().postMessage({ id, buffer, ...options }, [buffer]);
  });
}

// ---------- fetching ----------

async function fetchItemBuffer(item, tabId) {
  if (!item || !item.url || item.url.startsWith('inline-')) throw new Error('This image has no downloadable source.');
  const url = item.url;

  if (url.startsWith('data:')) {
    const commaIdx = url.indexOf(',');
    const header = commaIdx > -1 ? url.slice(5, commaIdx) : '';
    const body = commaIdx > -1 ? url.slice(commaIdx + 1) : '';
    if (header.includes(';base64')) return base64ToUint8Array(body).buffer;
    return new TextEncoder().encode(decodeURIComponent(body)).buffer;
  }

  // blob: URLs belong to the page, so the content script has to read them.
  if (url.startsWith('blob:')) {
    const resp = await sendRuntime({ type: 'FETCH_TAB_BYTES', tabId, url });
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'Could not read blob image from the page');
    return base64ToUint8Array(resp.base64).buffer;
  }

  // Extension pages may fetch any host the extension has permission for, without CORS.
  let lastError = null;
  for (const credentials of ['omit', 'include']) {
    try {
      const resp = await fetch(url, { cache: 'force-cache', credentials });
      if (resp.ok) return await resp.arrayBuffer();
      lastError = new Error(`HTTP ${resp.status} fetching image`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Could not download image');
}

// Budget for the file at its own (preserved) pixel size. The page-level "recommended" size is for the
// displayed size, which a same-dimension re-encode can never reach.
function compressionTarget(item, bytesPerPixel) {
  const pixels = (item.intrinsicW || 0) * (item.intrinsicH || 0);
  if (!pixels || !['JPEG', 'WEBP'].includes(item.format)) return 0;
  const bpp = (bytesPerPixel || 0.35) * (item.format === 'WEBP' ? 0.8 : 1);
  return Math.max(12 * 1024, Math.round(pixels * bpp));
}

// ---------- saving ----------

async function uniqueName(dir, name) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 0; n < 1000; n++) {
    const candidate = n === 0 ? name : `${stem} (${n})${ext}`;
    try {
      await dir.getFileHandle(candidate);
    } catch (err) {
      if (err && err.name === 'NotFoundError') return candidate;
      throw err;
    }
  }
  throw new Error('Too many files with the same name');
}

async function writableFolder() {
  const handle = await getFolder();
  if (!handle) return null;
  try {
    if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return handle;
  } catch (_) {}
  return null;
}

// destination 'folder' writes into the chosen folder; otherwise the Save-As dialog is used.
async function save(bytes, filename, mimeType, { destination, overwrite }) {
  const baseName = filename.split('/').pop() || filename;
  if (destination === 'folder') {
    const dir = await writableFolder();
    if (!dir) throw new Error('Lost access to the target folder — choose it again.');
    const name = overwrite ? baseName : await uniqueName(dir, baseName);
    const fileHandle = await dir.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(new Blob([bytes], { type: mimeType || 'application/octet-stream' }));
    await writable.close();
    return { ok: true, path: `${dir.name}/${name}` };
  }
  const resp = await sendRuntime({ type: 'TRIGGER_NATIVE_DOWNLOAD', dataUrl: uint8ToDataUrl(bytes, mimeType), filename: baseName, saveAs: true });
  if (resp && resp.ok) return { ok: true, path: baseName };
  if (resp && resp.cancelled) return { ok: false, cancelled: true };
  throw new Error((resp && resp.error) || 'Download failed');
}

// Strips anything that could escape the extraction folder when the ZIP is unpacked.
function safeZipPath(path) {
  return (
    String(path)
      .split(/[\\/]+/)
      .filter((seg) => seg && seg !== '.' && seg !== '..')
      .map((seg) => seg.replace(/[\u0000-\u001f<>:"|?*]+/g, '_'))
      .join('/') || 'image'
  );
}

const formatBytes = (bytes) => {
  if (!bytes || bytes <= 0) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(kb >= 100 ? 0 : 1)} KB` : `${(kb / 1024).toFixed(2)} MB`;
};

async function compressItem(item, job) {
  const raw = await fetchItemBuffer(item, job.tabId);
  const beforeBytes = raw.byteLength;
  const res = await compressInWorker(raw, { quality: 92, target: compressionTarget(item, job.bytesPerPixel) });
  const data = new Uint8Array(res.buffer);
  return {
    data,
    mime: res.mime,
    beforeBytes,
    afterBytes: data.length,
    savedPct: beforeBytes > 0 ? Math.round((Math.max(0, beforeBytes - data.length) / beforeBytes) * 100) : 0,
    unchanged: KEPT_NOTES.has(res.note),
    note: res.note,
    reason: res.reason || '',
    width: res.width || item.intrinsicW,
    height: res.height || item.intrinsicH
  };
}

// ---------- resize for display (srcset variants) ----------

export const RESIZABLE_FORMATS = new Set(['PNG', 'JPEG', 'WEBP']);

function resizeInWorker(buffer, width) {
  return compressInWorker(buffer, { op: 'resize', width });
}

const escAttr = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function variantName(filename, width) {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? `${filename.slice(0, dot)}-${width}w${filename.slice(dot)}` : `${filename}-${width}w`;
}

// Directory of the image on its site (e.g. "/assets/img/"), so snippets can be pasted as-is.
function urlDir(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1);
  } catch (_) {}
  return '';
}

// 1x and 2x of the displayed width, keeping only sizes smaller than the original.
export function variantWidths(item) {
  const w = item.renderedW;
  if (!w || !item.intrinsicW) return [];
  return [...new Set([w, w * 2])].filter((v) => v < item.intrinsicW);
}

const MIME_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const mimeOfPath = (p) => MIME_BY_EXT[(p.split('.').pop() || '').toLowerCase()] || '';
const swapExt = (name, ext) => `${name.replace(/\.[^.]+$/, '')}.${ext}`;

// WebP copies are only worth making from formats that are not already WebP.
const wantsWebp = (job, item) => Boolean(job.webp) && (item.format === 'PNG' || item.format === 'JPEG');

// Markup for the files produced. fallback/webp are [{ path, width }] smallest first; a single entry
// means "same size as the original". Images get <img srcset> (inside <picture> when there is WebP);
// CSS backgrounds get image-set(), since srcset does not apply to them.
function buildSnippet(item, fallback, webp = []) {
  const w = item.renderedW || item.intrinsicW;
  const h = Math.round((w * item.intrinsicH) / item.intrinsicW);
  const multi = fallback.length > 1 || webp.length > 1;

  if (item.kind === 'bg') {
    const density = (s) => (multi ? ` ${Math.round((s.width / w) * 100) / 100}x` : '');
    const typed = webp.length > 0;
    const entry = (s) => `url("${s.path}")${typed ? ` type("${mimeOfPath(s.path)}")` : ''}${density(s)}`;
    return `background-image: url("${fallback[0].path}");\nbackground-image: image-set(${[...webp, ...fallback].map(entry).join(', ')});`;
  }

  const srcsetOf = (list) => list.map((s) => `${s.path} ${s.width}w`).join(', ');
  const largest = fallback[fallback.length - 1].path;
  const dims = `width="${w}" height="${h}" alt="${escAttr(item.altText || '')}"`;
  const img =
    fallback.length > 1
      ? `<img src="${escAttr(largest)}" srcset="${escAttr(srcsetOf(fallback))}" sizes="${w}px" ${dims}>`
      : `<img src="${escAttr(largest)}" ${dims}>`;
  if (!webp.length) return img;
  const source =
    webp.length > 1
      ? `<source type="image/webp" srcset="${escAttr(srcsetOf(webp))}" sizes="${w}px">`
      : `<source type="image/webp" srcset="${escAttr(webp[0].path)}">`;
  return `<picture>\n  ${source}\n  ${img}\n</picture>`;
}

// Same-size WebP copy of an image, kept only when it is smaller than the best other version.
async function webpCopy(item, job, bestBytes) {
  if (!wantsWebp(job, item)) return null;
  try {
    const raw = await fetchItemBuffer(item, job.tabId); // served from cache after the first fetch
    const res = await webpInWorker(raw, item.intrinsicW || Number.MAX_SAFE_INTEGER);
    const data = new Uint8Array(res.buffer);
    return data.length < bestBytes ? { name: swapExt(item.originalFilename, 'webp'), data, mime: 'image/webp' } : null;
  } catch (_) {
    return null; // the WebP copy is optional; never fail the main job over it
  }
}

function pictureSnippet(item, webp) {
  const dir = urlDir(item.url);
  return buildSnippet(item, [{ path: `${dir}${item.originalFilename}`, width: item.intrinsicW }], [{ path: `${dir}${webp.name}`, width: item.intrinsicW }]);
}

function snippetsFile(name, snippets) {
  return { name, data: new TextEncoder().encode(`<!-- snippets from Image Size Checker Pro -->\n${snippets.join('\n\n')}\n`) };
}

function webpInWorker(buffer, width) {
  return compressInWorker(buffer, { op: 'resize', width, outFormat: 'webp' });
}

async function writeToFolder(dir, name, data, mime, overwrite) {
  const finalName = overwrite ? name : await uniqueName(dir, name);
  const handle = await dir.getFileHandle(finalName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(new Blob([data], { type: mime || 'application/octet-stream' }));
  await writable.close();
  return finalName;
}

async function runResizeJob(job, update) {
  const seen = new Set();
  const candidates = job.items.filter((i) => !seen.has(i.url) && seen.add(i.url));
  const folder = job.destination === 'folder' ? await writableFolder() : null;
  if (job.destination === 'folder' && !folder) throw new Error('Lost access to the target folder — choose it again.');

  const results = {};
  const zipEntries = [];
  const snippets = [];
  const failed = [];
  let fileCount = 0;

  for (let idx = 0; idx < candidates.length; idx++) {
    const item = candidates[idx];
    update({ status: `Resizing ${idx + 1}/${candidates.length}: ${item.originalFilename}…`, results });
    try {
      const widths = variantWidths(item);
      if (!widths.length) throw new Error('already no larger than it is displayed');
      const raw = await fetchItemBuffer(item, job.tabId);
      const emit = async (name, res) => {
        const data = new Uint8Array(res.buffer);
        const finalName = folder ? await writeToFolder(folder, name, data, res.mime, job.overwrite) : name;
        if (!folder) zipEntries.push({ name: safeZipPath(name), data });
        fileCount++;
        return { name: finalName, width: res.width, height: res.height, bytes: data.length };
      };

      const variants = [];
      for (const width of widths) {
        const res = await resizeInWorker(raw.slice(0), width);
        variants.push(await emit(variantName(item.originalFilename, res.width), res));
      }
      // When 2x would be at least the original size, the original itself serves high-density screens.
      const originalServes2x = !widths.some((v) => v >= item.renderedW * 2);
      const dir = urlDir(item.url);
      const fallback = variants.map((v) => ({ path: `${dir}${v.name}`, width: v.width }));
      if (originalServes2x) fallback.push({ path: `${dir}${item.originalFilename}`, width: item.intrinsicW });

      const webp = [];
      if (wantsWebp(job, item)) {
        const webpWidths = originalServes2x ? [...widths, item.intrinsicW] : widths;
        for (const width of webpWidths) {
          const res = await webpInWorker(raw.slice(0), width);
          const v = await emit(variantName(swapExt(item.originalFilename, 'webp'), res.width), res);
          variants.push(v);
          webp.push({ path: `${dir}${v.name}`, width: v.width });
        }
      }

      const snippet = buildSnippet(item, fallback, webp);
      snippets.push(`<!-- ${item.originalFilename} (${item.intrinsicW}×${item.intrinsicH}, shown at ${item.renderedW}px) -->\n${snippet}`);
      results[`resize|${item.url}`] = { note: 'resized', beforeBytes: raw.byteLength, variants, snippet };
    } catch (err) {
      failed.push(`${item.originalFilename} (${err.message || err})`);
    }
  }

  const failNote = failed.length ? ` · ${failed.length} failed: ${failed.join(', ')}` : '';
  if (!fileCount) return { status: `Nothing resized${failNote}`, results };

  const snippetsEntry = snippetsFile('srcset-snippets.html', snippets);
  const files = `${fileCount} ${fileCount === 1 ? 'file' : 'files'}`;
  if (folder) {
    if (candidates.length > 1) await writeToFolder(folder, snippetsEntry.name, snippetsEntry.data, 'text/html', job.overwrite);
    return { status: `Saved ${files} to ${folder.name ? `/${folder.name}/` : 'the target folder'}${failNote}`, results };
  }
  zipEntries.push(snippetsEntry);
  const zipBytes = new Uint8Array(await makeZip(zipEntries).arrayBuffer());
  const zipName =
    candidates.length === 1
      ? `${candidates[0].originalFilename.replace(/\.[^.]+$/, '')}-resized.zip`
      : `${hostSlugOf(job.pageUrl)}-resized-images.zip`;
  const saved = await save(zipBytes, zipName, 'application/zip', job);
  if (saved.cancelled) return { status: 'Save cancelled.', results };
  return { status: `Saved ZIP (${files} + srcset snippets)${failNote}`, results };
}

function hostSlugOf(pageUrl) {
  try {
    return new URL(pageUrl).hostname.replace(/[^a-z0-9-]+/gi, '-') || 'site';
  } catch (_) {
    return 'site';
  }
}

// Dry run used for the savings estimate: compresses without saving and reports the real result.
export async function estimateItem(item, tabId, bytesPerPixel) {
  const r = await compressItem(item, { tabId, bytesPerPixel });
  return { beforeBytes: r.beforeBytes, afterBytes: r.afterBytes, savedPct: r.savedPct, note: r.note, reason: r.reason, unchanged: r.unchanged };
}

// Runs one job, reporting progress through update(partialState).
// job: { id, mode: 'single' | 'zip', items, pageUrl, tabId, bytesPerPixel, destination, overwrite }
export async function runJob(job, update) {
  const results = {}; // url -> per-image result shown in the panel
  const record = (item, r) => {
    results[item.url] = { beforeBytes: r.beforeBytes, afterBytes: r.afterBytes, savedPct: r.savedPct, note: r.note, reason: r.reason, width: r.width, height: r.height };
  };

  if (job.mode === 'resize') return runResizeJob(job, update);

  if (job.mode === 'single') {
    const item = job.items[0];
    update({ status: `Compressing ${item.originalFilename}…` });
    const r = await compressItem(item, job);
    record(item, r);
    const webp = await webpCopy(item, job, r.afterBytes);
    if (webp) Object.assign(results[item.url], { webp: { name: webp.name, bytes: webp.data.length }, snippet: pictureSnippet(item, webp) });
    if (r.unchanged && !webp) return { status: `${item.originalFilename}: not changed — ${r.reason || 'already optimal'}`, results };

    const files = [];
    if (!r.unchanged) files.push({ name: item.originalFilename, data: r.data, mime: r.mime });
    if (webp) files.push(webp);
    const pct = r.unchanged ? '' : ` (-${r.savedPct}%)`;
    if (files.length === 1 || job.destination === 'folder') {
      const paths = [];
      for (const f of files) {
        const saved = await save(f.data, f.name, f.mime, job);
        if (saved.cancelled) return { status: 'Save cancelled.', results };
        paths.push(saved.path);
      }
      return { status: `Saved ${paths.join(' + ')}${pct}`, results };
    }
    // Several files and no target folder: one ZIP instead of several Save-As dialogs.
    const zip = makeZip([...files.map((f) => ({ name: safeZipPath(f.name), data: f.data })), snippetsFile('picture-snippets.html', [results[item.url].snippet])]);
    const saved = await save(new Uint8Array(await zip.arrayBuffer()), swapExt(item.originalFilename, 'zip'), 'application/zip', job);
    return { status: saved.cancelled ? 'Save cancelled.' : `Saved ZIP (${files.map((f) => f.name).join(' + ')})${pct}`, results };
  }

  // The same image can appear several times on a page; compress and package it once.
  const seen = new Set();
  const candidates = job.items.filter((i) => !seen.has(i.url) && seen.add(i.url));
  const entries = [];
  const usedNames = new Set();
  const skipped = [];
  const failed = [];
  const pictureSnippets = [];
  let totalBefore = 0;
  let totalAfter = 0;

  for (let idx = 0; idx < candidates.length; idx++) {
    const item = candidates[idx];
    update({ status: `Compressing ${idx + 1}/${candidates.length}: ${item.originalFilename}…`, results });
    let r;
    try {
      r = await compressItem(item, job);
    } catch (err) {
      // One bad image (403, unsupported, corrupt) must not throw away the rest of the batch.
      failed.push(`${item.originalFilename} (${err.message || err})`);
      continue;
    }
    record(item, r);
    const webp = await webpCopy(item, job, r.afterBytes);
    if (r.unchanged && !webp) {
      skipped.push(item.originalFilename);
      continue;
    }
    // Keep the exact original filename; on a clash use the URL folder path, then a numeric prefix.
    const zipName = (filename, relative) => {
      let name = safeZipPath(filename);
      if (usedNames.has(name)) name = safeZipPath(relative || filename);
      if (usedNames.has(name)) name = safeZipPath(`${idx + 1}_${filename}`);
      usedNames.add(name);
      return name;
    };
    if (!r.unchanged) {
      totalBefore += r.beforeBytes;
      totalAfter += r.afterBytes;
      entries.push({ name: zipName(item.originalFilename, item.relativePath), data: r.data });
    }
    if (webp) {
      entries.push({ name: zipName(webp.name, item.relativePath && swapExt(item.relativePath, 'webp')), data: webp.data });
      const snippet = pictureSnippet(item, webp);
      Object.assign(results[item.url], { webp: { name: webp.name, bytes: webp.data.length }, snippet });
      pictureSnippets.push(`<!-- ${item.originalFilename} -->\n${snippet}`);
    }
  }
  if (pictureSnippets.length) entries.push(snippetsFile('picture-snippets.html', pictureSnippets));

  const notes = [];
  if (skipped.length) notes.push(`${skipped.length} already optimal or format kept: ${skipped.join(', ')}`);
  if (failed.length) notes.push(`${failed.length} failed: ${failed.join(', ')}`);
  const suffix = notes.length ? ` · ${notes.join(' · ')}` : '';
  if (!entries.length) return { status: `Nothing to save${suffix}`, results };

  update({ status: 'Building ZIP…', results });
  const zipBytes = new Uint8Array(await makeZip(entries).arrayBuffer());
  const saved = await save(zipBytes, `${hostSlugOf(job.pageUrl)}-optimized-images.zip`, 'application/zip', job);
  if (saved.cancelled) return { status: 'Save cancelled.', results };
  const pct = totalBefore > 0 ? Math.round(((totalBefore - totalAfter) / totalBefore) * 100) : 0;
  const files = `${entries.length} ${entries.length === 1 ? 'file' : 'files'}`;
  return { status: `Saved ZIP (${files}): ${formatBytes(totalBefore)} → ${formatBytes(totalAfter)} (-${pct}%)${suffix}`, results };
}
