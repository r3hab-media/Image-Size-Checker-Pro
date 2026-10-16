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

  if (job.mode === 'single') {
    const item = job.items[0];
    update({ status: `Compressing ${item.originalFilename}…` });
    const r = await compressItem(item, job);
    record(item, r);
    if (r.unchanged) return { status: `${item.originalFilename}: not changed — ${r.reason || 'already optimal'}`, results };
    const saved = await save(r.data, item.originalFilename, r.mime, job);
    return { status: saved.cancelled ? 'Save cancelled.' : `Saved ${saved.path} (-${r.savedPct}%)`, results };
  }

  // The same image can appear several times on a page; compress and package it once.
  const seen = new Set();
  const candidates = job.items.filter((i) => !seen.has(i.url) && seen.add(i.url));
  const entries = [];
  const usedNames = new Set();
  const skipped = [];
  const failed = [];
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
    if (r.unchanged) {
      skipped.push(item.originalFilename);
      continue;
    }
    totalBefore += r.beforeBytes;
    totalAfter += r.afterBytes;
    // Keep the exact original filename; on a clash use the URL folder path, then a numeric prefix.
    let name = safeZipPath(item.originalFilename);
    if (usedNames.has(name)) name = safeZipPath(item.relativePath || item.originalFilename);
    if (usedNames.has(name)) name = safeZipPath(`${idx + 1}_${item.originalFilename}`);
    usedNames.add(name);
    entries.push({ name, data: r.data });
  }

  const notes = [];
  if (skipped.length) notes.push(`${skipped.length} already optimal or format kept: ${skipped.join(', ')}`);
  if (failed.length) notes.push(`${failed.length} failed: ${failed.join(', ')}`);
  const suffix = notes.length ? ` · ${notes.join(' · ')}` : '';
  if (!entries.length) return { status: `Nothing to save${suffix}`, results };

  update({ status: 'Building ZIP…', results });
  const zipBytes = new Uint8Array(await makeZip(entries).arrayBuffer());
  let hostSlug = 'site';
  try {
    hostSlug = new URL(job.pageUrl).hostname.replace(/[^a-z0-9-]+/gi, '-') || 'site';
  } catch (_) {}
  const saved = await save(zipBytes, `${hostSlug}-optimized-images.zip`, 'application/zip', job);
  if (saved.cancelled) return { status: 'Save cancelled.', results };
  const pct = totalBefore > 0 ? Math.round(((totalBefore - totalAfter) / totalBefore) * 100) : 0;
  const files = `${entries.length} ${entries.length === 1 ? 'file' : 'files'}`;
  return { status: `Saved ZIP (${files}): ${formatBytes(totalBefore)} → ${formatBytes(totalAfter)} (-${pct}%)${suffix}`, results };
}
