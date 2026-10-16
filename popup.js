import { makeZip } from './js/zip.js';
import { getFolder, getWritableFolder, clearFolder } from './js/folder-store.js';

let currentState = null;
let activeFilter = 'all';
let searchQuery = '';
let sortMode = 'severity';
let activeTabId = null;
let overwriteExisting = false;
const compressedResults = new Map(); // image URL -> { beforeBytes, afterBytes, savedPct, note, width, height }

const els = {
  pageHostLabel: document.getElementById('pageHostLabel'),
  openDemoBtn: document.getElementById('openDemoBtn'),
  rescanBtn: document.getElementById('rescanBtn'),
  enabledToggle: document.getElementById('enabledToggle'),
  kpiTotal: document.getElementById('kpiTotal'),
  kpiBreakdown: document.getElementById('kpiBreakdown'),
  kpiWeight: document.getElementById('kpiWeight'),
  kpiDpr: document.getElementById('kpiDpr'),
  kpiSavings: document.getElementById('kpiSavings'),
  kpiTooLarge: document.getElementById('kpiTooLarge'),
  kpiIssueSplit: document.getElementById('kpiIssueSplit'),
  targetFolderLabel: document.getElementById('targetFolderLabel'),
  chooseFolderBtn: document.getElementById('chooseFolderBtn'),
  resetFolderBtn: document.getElementById('resetFolderBtn'),
  overwriteRow: document.getElementById('overwriteRow'),
  overwriteCheck: document.getElementById('overwriteCheck'),
  compressAllZipBtn: document.getElementById('compressAllZipBtn'),
  tooLargeCountBadge: document.getElementById('tooLargeCountBadge'),
  compressionStatus: document.getElementById('compressionStatus'),
  filterTabs: document.getElementById('filterTabs'),
  searchInput: document.getElementById('searchInput'),
  sortSelect: document.getElementById('sortSelect'),
  settingsBtn: document.getElementById('settingsBtn'),
  settingsDrawer: document.getElementById('settingsDrawer'),
  overlayModeSelect: document.getElementById('overlayModeSelect'),
  maxFileSizeInput: document.getElementById('maxFileSizeInput'),
  aspectToleranceInput: document.getElementById('aspectToleranceInput'),
  oversizeMultiplierInput: document.getElementById('oversizeMultiplierInput'),
  scanBgCheck: document.getElementById('scanBgCheck'),
  scanSvgCheck: document.getElementById('scanSvgCheck'),
  autoScanCheck: document.getElementById('autoScanCheck'),
  saveSettingsBtn: document.getElementById('saveSettingsBtn'),
  itemsList: document.getElementById('itemsList'),
  copyMdBtn: document.getElementById('copyMdBtn'),
  exportCsvBtn: document.getElementById('exportCsvBtn'),
  exportJsonBtn: document.getElementById('exportJsonBtn')
};

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

function base64ToUint8Array(base64) {
  const bin = atob(base64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function uint8ToDataUrl(bytes, mime) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return `data:${mime || 'application/octet-stream'};base64,${btoa(binary)}`;
}

// ---------- compression worker ----------

let worker = null;
let jobSeq = 0;
const pendingJobs = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker('js/worker.js', { type: 'module' });
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

// Runs off the main thread so large images do not freeze the popup.
function compressInWorker(buffer, options) {
  return new Promise((resolve, reject) => {
    const id = ++jobSeq;
    pendingJobs.set(id, { resolve, reject });
    getWorker().postMessage({ id, buffer, ...options }, [buffer]);
  });
}

// ---------- fetching ----------

async function fetchItemBuffer(item) {
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
    const resp = await sendToTab(activeTabId, { type: 'FETCH_BYTES_LOCAL', url });
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
function compressionTarget(item) {
  const pixels = (item.intrinsicW || 0) * (item.intrinsicH || 0);
  if (!pixels || !['JPEG', 'WEBP'].includes(item.format)) return 0;
  const bpp = (currentState?.settings?.bytesPerPixelTarget || 0.35) * (item.format === 'WEBP' ? 0.8 : 1);
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

// destination: a writable directory handle, or null for the Save-As dialog.
async function saveToTargetDestination(bytes, filename, mimeType, destination) {
  const baseName = filename.split('/').pop() || filename;
  const blob = new Blob([bytes], { type: mimeType || 'application/octet-stream' });

  if (destination && !destination.expired) {
    const name = overwriteExisting ? baseName : await uniqueName(destination, baseName);
    const fileHandle = await destination.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    return { ok: true, method: 'directory-handle', path: `${destination.name}/${name}` };
  }

  // The download runs in the service worker because the Save-As dialog can close this popup.
  const dlResp = await new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'TRIGGER_NATIVE_DOWNLOAD', dataUrl: uint8ToDataUrl(bytes, mimeType), filename: baseName, saveAs: true },
      (r) => {
        void chrome.runtime.lastError;
        resolve(r || { ok: false, error: 'No response from background' });
      }
    );
  });
  if (dlResp.ok) return { ok: true, method: 'chrome-downloads-save-as', path: baseName };
  if (dlResp.cancelled) return { ok: false, cancelled: true };

  // The downloads API failed for some other reason; fall back to a plain anchor download.
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = baseName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return { ok: true, method: 'anchor-fallback', path: baseName };
}

// Resolves the save destination at the start of a click (permission prompts need the user gesture).
async function resolveDestination() {
  const folder = await getWritableFolder();
  if (folder && folder.expired) {
    els.compressionStatus.textContent = `Access to /${folder.name}/ expired — using Save-As. Choose the folder again to restore it.`;
    return null;
  }
  return folder;
}

const KEPT_NOTES = new Set(['kept', 'kept-unsupported', 'kept-animated', 'kept-lossless', 'kept-color-profile']);

// Compress a single image keeping original dimensions, original format, and original filename
async function compressSingleItem(item) {
  const rawBuffer = await fetchItemBuffer(item);
  const beforeBytes = rawBuffer.byteLength;
  const result = await compressInWorker(rawBuffer, { quality: 92, target: compressionTarget(item) });

  const outBytes = new Uint8Array(result.buffer);
  const savedBytes = Math.max(0, beforeBytes - outBytes.length);
  const savedPct = beforeBytes > 0 ? Math.round((savedBytes / beforeBytes) * 100) : 0;
  const unchanged = KEPT_NOTES.has(result.note);

  compressedResults.set(item.url, {
    beforeBytes,
    afterBytes: outBytes.length,
    savedBytes,
    savedPct,
    note: result.note,
    reason: result.reason || '',
    width: result.width || item.intrinsicW,
    height: result.height || item.intrinsicH
  });

  return {
    filename: item.originalFilename,
    relativePath: item.relativePath || item.originalFilename,
    data: outBytes,
    mime: result.mime,
    beforeBytes,
    afterBytes: outBytes.length,
    savedBytes,
    savedPct,
    unchanged,
    note: result.note,
    reason: result.reason || ''
  };
}

// Strips anything that could escape the extraction folder when the ZIP is unpacked.
function safeZipPath(path) {
  return String(path)
    .split(/[\\/]+/)
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .map((seg) => seg.replace(/[\u0000-\u001f<>:"|?*]+/g, '_'))
    .join('/') || 'image';
}

// Batch compress all oversized images and package into a single ZIP keeping original filenames
async function compressAllTooLargeToZip() {
  if (!currentState || !currentState.items) return;
  const destination = await resolveDestination();

  // The same image can appear several times on a page; compress and package it once.
  const seenUrls = new Set();
  const candidates = currentState.items.filter((i) => {
    if (!i.isTooLarge || seenUrls.has(i.url)) return false;
    seenUrls.add(i.url);
    return true;
  });
  if (candidates.length === 0) {
    els.compressionStatus.textContent = 'No oversized images found!';
    return;
  }

  els.compressAllZipBtn.disabled = true;
  const zipEntries = [];
  const usedZipNames = new Set();
  const skipped = [];
  const failed = [];
  let totalBefore = 0;
  let totalAfter = 0;

  try {
    for (let idx = 0; idx < candidates.length; idx++) {
      const item = candidates[idx];
      els.compressionStatus.textContent = `Compressing ${idx + 1}/${candidates.length}: ${item.originalFilename}…`;
      let res;
      try {
        res = await compressSingleItem(item);
      } catch (err) {
        // One bad image (403, unsupported, corrupt) must not throw away the rest of the batch.
        failed.push(`${item.originalFilename} (${err.message || err})`);
        continue;
      }
      if (res.unchanged) {
        skipped.push(item.originalFilename);
        continue;
      }
      totalBefore += res.beforeBytes;
      totalAfter += res.afterBytes;

      // Keep the exact original filename; on a clash use the URL folder path, then a numeric prefix.
      let entryName = safeZipPath(res.filename);
      if (usedZipNames.has(entryName)) entryName = safeZipPath(res.relativePath);
      if (usedZipNames.has(entryName)) entryName = safeZipPath(`${idx + 1}_${res.filename}`);
      usedZipNames.add(entryName);
      zipEntries.push({ name: entryName, data: res.data });
      renderDashboard();
    }

    const notes = [];
    if (skipped.length) notes.push(`${skipped.length} already optimal or format kept`);
    if (failed.length) notes.push(`${failed.length} failed: ${failed.join(', ')}`);
    const suffix = notes.length ? ` · ${notes.join(' · ')}` : '';

    if (zipEntries.length === 0) {
      els.compressionStatus.textContent = `Nothing to save${suffix}`;
      return;
    }

    const zipBytes = new Uint8Array(await makeZip(zipEntries).arrayBuffer());
    const savedTotal = Math.max(0, totalBefore - totalAfter);
    const pctTotal = totalBefore > 0 ? Math.round((savedTotal / totalBefore) * 100) : 0;

    let hostSlug = 'site';
    try {
      hostSlug = new URL(currentState.pageUrl).hostname.replace(/[^a-z0-9-]+/gi, '-') || 'site';
    } catch (_) {}
    const saved = await saveToTargetDestination(zipBytes, `${hostSlug}-optimized-images.zip`, 'application/zip', destination);
    if (saved.cancelled) {
      els.compressionStatus.textContent = 'Save cancelled.';
    } else {
      els.compressionStatus.textContent = `Saved ZIP (${zipEntries.length} files): ${formatBytes(totalBefore)} → ${formatBytes(totalAfter)} (-${pctTotal}%)${suffix}`;
    }
  } catch (err) {
    els.compressionStatus.textContent = `Error: ${err.message || err}`;
  } finally {
    els.compressAllZipBtn.disabled = false;
    renderDashboard();
  }
}

// ---------- tab messaging ----------

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        resolve(null);
      } else {
        resolve(resp);
      }
    });
  });
}

async function ensureAndScan(forceRescan = false, tabId = null) {
  if (!tabId) {
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      els.itemsList.innerHTML = `<div class="empty-state">No active tab detected.</div>`;
      return;
    }
    tabId = tab.id;
  }
  activeTabId = tabId;

  const ensureResp = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'ENSURE_CONTENT_SCRIPT', tabId: activeTabId }, (r) =>
      resolve(r || { ok: false })
    );
  });

  if (!ensureResp.ok) {
    els.pageHostLabel.textContent = 'Restricted browser page';
    els.itemsList.innerHTML = `
      <div class="empty-state">
        Chrome blocks extensions from running on internal <code>chrome://</code> or Web Store pages.
        For local <code>file://</code> pages, enable “Allow access to file URLs” on the extension’s details page.<br/><br/>
        Click <strong>Playground</strong> above to open the built-in test page and try 1-click and ZIP image compression!
      </div>`;
    return;
  }

  const state = await sendToTab(activeTabId, { type: forceRescan ? 'SCAN_PAGE' : 'GET_STATE' });
  if (!state || !state.ok) {
    els.itemsList.innerHTML = `<div class="empty-state">Unable to read page images. Click Scan to retry.</div>`;
    return;
  }

  currentState = state;
  renderDashboard();
}

function populateSettingsInputs(s) {
  if (!s) return;
  els.enabledToggle.checked = Boolean(s.enabled);
  els.overlayModeSelect.value = s.overlayMode || 'all';
  els.maxFileSizeInput.value = s.maxFileSizeKB ?? 250;
  els.aspectToleranceInput.value = s.aspectRatioTolerancePct ?? 3.0;
  els.oversizeMultiplierInput.value = s.oversizeDprMultiplier ?? 1.6;
  els.scanBgCheck.checked = s.scanCssBackgrounds !== false;
  els.scanSvgCheck.checked = s.scanInlineSvgs !== false;
  els.autoScanCheck.checked = Boolean(s.autoScan);
}

function filterAndSortItems(items) {
  const q = searchQuery.trim().toLowerCase();

  const filtered = items.filter((item) => {
    if (activeFilter === 'toolarge' && !item.isTooLarge) return false;
    if (activeFilter === 'issues' && item.severity === 'ok') return false;
    if (
      activeFilter === 'aspect' &&
      !item.issues.some((i) => i.code === 'ASPECT_DISTORTED' || i.code === 'ASPECT_MASKED')
    ) {
      return false;
    }
    if (
      activeFilter === 'oversized' &&
      !item.issues.some((i) => i.code === 'OVERSIZED_DIMENSIONS' || i.code === 'UPSCALED_BLURRY')
    ) {
      return false;
    }
    if (activeFilter === 'alt' && !item.issues.some((i) => i.code === 'MISSING_ALT')) {
      return false;
    }

    if (q) {
      const hay = `${item.originalFilename} ${item.shortName} ${item.url} ${item.format} ${
        item.altText || ''
      } ${item.issues.map((i) => i.text).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const severityRank = { error: 3, warn: 2, ok: 1 };
  filtered.sort((a, b) => {
    if (sortMode === 'severity') {
      const diff = (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0);
      if (diff !== 0) return diff;
      return (b.fileSize || 0) - (a.fileSize || 0);
    }
    if (sortMode === 'size-desc') {
      return (b.fileSize || 0) - (a.fileSize || 0);
    }
    if (sortMode === 'aspect-desc') {
      return (b.aspectMismatchPct || 0) - (a.aspectMismatchPct || 0);
    }
    return 0;
  });

  return filtered;
}

function compressResultHtml(info) {
  if (!info) return '';
  if (KEPT_NOTES.has(info.note)) {
    return `<div class="compress-result-pill">ℹ️ Not changed: ${escapeHtml(info.reason || 'already optimal')}</div>`;
  }
  return `<div class="compress-result-pill">
      ✓ ${formatBytes(info.beforeBytes)} → <strong>${formatBytes(info.afterBytes)}</strong>
      (-${info.savedPct}% · ${info.width}×${info.height}px kept)
    </div>`;
}

function renderDashboard() {
  if (!currentState) return;
  const { summary, items, settings, pageUrl, dpr } = currentState;

  try {
    const u = new URL(pageUrl);
    els.pageHostLabel.textContent = u.hostname + u.pathname;
  } catch (_) {
    els.pageHostLabel.textContent = pageUrl || 'Active tab';
  }

  populateSettingsInputs(settings);

  const imgCount = items.filter((i) => i.kind === 'img').length;
  const bgCount = items.filter((i) => i.kind === 'bg').length;
  const svgCount = items.filter((i) => i.kind === 'svg').length;
  const tooLargeItems = items.filter((i) => i.isTooLarge);

  els.kpiTotal.textContent = String(summary.totalImages);
  els.kpiBreakdown.textContent = `${imgCount} IMG · ${bgCount} BG · ${svgCount} SVG`;
  els.kpiWeight.textContent = summary.totalWeightFormatted;
  els.kpiDpr.textContent = `Display DPR ${Number(dpr || 1).toFixed(1)}x`;
  els.kpiSavings.textContent = summary.totalSavingsFormatted;
  els.kpiTooLarge.textContent = String(tooLargeItems.length);
  els.kpiIssueSplit.textContent = `${summary.errorCount} critical · ${summary.warnCount} warn`;
  els.tooLargeCountBadge.textContent = String(tooLargeItems.length);
  els.compressAllZipBtn.disabled = tooLargeItems.length === 0;

  const visibleItems = filterAndSortItems(items);
  if (visibleItems.length === 0) {
    els.itemsList.innerHTML = `<div class="empty-state">No images match the current filter.</div>`;
    return;
  }

  els.itemsList.innerHTML = visibleItems
    .map((item) => {
      const canPreview = item.url && !item.url.startsWith('inline-');
      const thumbHtml = canPreview
        ? `<img src="${escapeHtml(item.url)}" alt="" loading="lazy" />`
        : `<span class="thumb-fallback">${escapeHtml(item.format)}</span>`;

      const statusLabel =
        item.severity === 'error' ? 'Error' : item.severity === 'warn' ? 'Warn' : 'OK';

      const compPillHtml = compressResultHtml(compressedResults.get(item.url));

      const issuesHtml =
        item.issues.length > 0
          ? `<div class="item-issues">
              ${item.issues
                .map(
                  (iss) =>
                    `<div class="issue-line ${iss.level === 'warn' ? 'warn' : ''}">• ${escapeHtml(
                      iss.text
                    )}</div>`
                )
                .join('')}
            </div>`
          : '';

      return `
        <div class="item-card status-${escapeHtml(item.severity)}" data-id="${escapeHtml(item.id)}">
          <div class="thumb-wrap">${thumbHtml}</div>
          <div class="item-body">
            <div class="item-header">
              <span class="item-name" title="Original Filename: ${escapeHtml(
                item.originalFilename
              )}">${escapeHtml(item.originalFilename)}</span>
              <div class="item-badges">
                <span class="badge fmt">${escapeHtml(item.format)}</span>
                <span class="badge status-${escapeHtml(item.severity)}">${statusLabel}</span>
              </div>
            </div>
            <div class="item-specs">
              <span><strong>Size:</strong> ${escapeHtml(item.fileSizeFormatted)} (≤ ${escapeHtml(
        item.recommendedFormatted
      )})</span>
              <span><strong>Rendered:</strong> ${item.renderedW}×${item.renderedH}px</span>
              <span><strong>Intrinsic:</strong> ${item.intrinsicW || '?'}×${
        item.intrinsicH || '?'
      }px</span>
              <span><strong>Ratio:</strong> ${
                item.aspectMismatchPct > 0 ? `${item.aspectMismatchPct}% diff` : 'Match'
              }</span>
            </div>
            ${compPillHtml}
            ${issuesHtml}
          </div>
          <div class="item-actions">
            <button class="mini-btn compress-btn" data-act="compress" data-id="${escapeHtml(
              item.id
            )}" title="Compress &amp; save ${escapeHtml(
        item.originalFilename
      )} keeping original dimensions &amp; format">🗜️ Compress</button>
            <button class="mini-btn" data-act="locate" data-id="${escapeHtml(
              item.id
            )}" title="Scroll to image on page">Locate</button>
            <button class="mini-btn" data-act="copy" data-url="${escapeHtml(
              item.url
            )}" title="Copy image URL">Copy</button>
          </div>
        </div>
      `;
    })
    .join('');

  els.itemsList.querySelectorAll('.mini-btn').forEach((btn) => {
    btn.addEventListener('click', () => onItemAction(btn));
  });
}

function flash(btn, text, restore, ms = 1200) {
  btn.textContent = text;
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = restore;
  }, ms);
}

async function onItemAction(btn) {
  const act = btn.getAttribute('data-act');
  const id = btn.getAttribute('data-id');
  if (act === 'compress' && currentState) {
    const targetItem = currentState.items.find((x) => x.id === id);
    if (!targetItem) return;
    const destination = await resolveDestination();
    btn.disabled = true;
    btn.textContent = 'Working…';
    try {
      const res = await compressSingleItem(targetItem);
      if (res.unchanged) {
        els.compressionStatus.textContent = `${res.filename}: not changed — ${res.reason || 'already optimal'}`;
      } else {
        const saved = await saveToTargetDestination(res.data, targetItem.originalFilename, res.mime, destination);
        els.compressionStatus.textContent = saved.cancelled
          ? 'Save cancelled.'
          : `Saved ${saved.path} (-${res.savedPct}%)`;
      }
      renderDashboard();
    } catch (err) {
      els.compressionStatus.textContent = `Error: ${err.message || err}`;
      flash(btn, 'Error', '🗜️ Compress', 1500);
    }
  } else if (act === 'locate' && activeTabId) {
    const resp = await sendToTab(activeTabId, { type: 'SCROLL_TO_IMAGE', id });
    if (!resp || !resp.ok) {
      els.compressionStatus.textContent = 'That image is no longer on the page — click Scan to refresh.';
    }
  } else if (act === 'copy') {
    const url = btn.getAttribute('data-url') || '';
    try {
      await navigator.clipboard.writeText(url);
      flash(btn, 'Copied', 'Copy', 1000);
    } catch (_) {
      flash(btn, 'Failed', 'Copy', 1000);
    }
  }
}

// ---------- target folder ----------

async function refreshFolderLabel() {
  const handle = await getFolder();
  if (handle) {
    els.targetFolderLabel.textContent = `/${handle.name}/`;
    els.resetFolderBtn.classList.remove('hidden');
    els.overwriteRow.classList.remove('hidden');
  } else {
    els.targetFolderLabel.textContent = 'Native OS Save-As Dialog';
    els.resetFolderBtn.classList.add('hidden');
    els.overwriteRow.classList.add('hidden');
  }
}

els.chooseFolderBtn.addEventListener('click', () => {
  // The native picker would close this popup, so it runs in its own small window.
  chrome.windows.create({ url: chrome.runtime.getURL('folder.html'), type: 'popup', width: 480, height: 260 });
});

els.resetFolderBtn.addEventListener('click', async () => {
  await clearFolder();
  await refreshFolderLabel();
  els.compressionStatus.textContent = 'Switched to Save-As prompt';
});

els.overwriteCheck.addEventListener('change', () => {
  overwriteExisting = els.overwriteCheck.checked;
  chrome.storage.local.set({ iscProOverwrite: overwriteExisting });
});

els.compressAllZipBtn.addEventListener('click', () => {
  compressAllTooLargeToZip();
});

els.rescanBtn.addEventListener('click', () => ensureAndScan(true, activeTabId));

els.openDemoBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('demo-playground.html') });
});

els.enabledToggle.addEventListener('change', async () => {
  if (!activeTabId) return;
  const state = await sendToTab(activeTabId, {
    type: 'UPDATE_SETTINGS',
    settings: { enabled: els.enabledToggle.checked }
  });
  if (state && state.ok) {
    currentState = state;
    renderDashboard();
  }
});

els.filterTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  els.filterTabs.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  btn.classList.add('active');
  activeFilter = btn.getAttribute('data-filter') || 'all';
  renderDashboard();
});

els.searchInput.addEventListener('input', () => {
  searchQuery = els.searchInput.value;
  renderDashboard();
});

els.sortSelect.addEventListener('change', () => {
  sortMode = els.sortSelect.value;
  renderDashboard();
});

els.settingsBtn.addEventListener('click', () => {
  els.settingsDrawer.classList.toggle('hidden');
});

els.saveSettingsBtn.addEventListener('click', async () => {
  if (!activeTabId) return;
  const newSettings = {
    enabled: els.enabledToggle.checked,
    overlayMode: els.overlayModeSelect.value,
    maxFileSizeKB: Number(els.maxFileSizeInput.value) || 250,
    aspectRatioTolerancePct: Number(els.aspectToleranceInput.value) || 3.0,
    oversizeDprMultiplier: Number(els.oversizeMultiplierInput.value) || 1.6,
    scanCssBackgrounds: els.scanBgCheck.checked,
    scanInlineSvgs: els.scanSvgCheck.checked,
    autoScan: els.autoScanCheck.checked
  };
  els.settingsDrawer.classList.add('hidden');
  const state = await sendToTab(activeTabId, { type: 'UPDATE_SETTINGS', settings: newSettings });
  if (state && state.ok) {
    currentState = state;
    renderDashboard();
  }
});

// ---------- exports ----------

function triggerDownload(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Page-controlled text (filenames, alt text) must not be able to run as a spreadsheet formula.
function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

const mdCell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

els.exportJsonBtn.addEventListener('click', () => {
  if (!currentState) return;
  triggerDownload(
    'image-audit-report.json',
    JSON.stringify(currentState, null, 2),
    'application/json'
  );
});

els.exportCsvBtn.addEventListener('click', () => {
  if (!currentState || !currentState.items) return;
  const headers = [
    'OriginalFilename',
    'Kind',
    'Format',
    'Severity',
    'TooLarge',
    'FileSizeBytes',
    'RecommendedBytes',
    'RenderedWxH',
    'IntrinsicWxH',
    'AspectMismatchPct',
    'ObjectFit',
    'AltText',
    'Issues',
    'URL'
  ];
  const rows = currentState.items.map((i) => [
    i.originalFilename,
    i.kind,
    i.format,
    i.severity,
    i.isTooLarge,
    i.fileSize,
    i.recommendedBytes,
    `${i.renderedW}x${i.renderedH}`,
    `${i.intrinsicW}x${i.intrinsicH}`,
    i.aspectMismatchPct,
    i.objectFit,
    i.altText ?? '',
    i.issues.map((x) => x.text).join(' | '),
    i.url
  ]);
  const csv = [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
  triggerDownload('image-audit-report.csv', csv, 'text/csv;charset=utf-8;');
});

els.copyMdBtn.addEventListener('click', async () => {
  if (!currentState || !currentState.items) return;
  const lines = [
    `### Image Audit Report — ${mdCell(currentState.pageTitle)}`,
    `- **Total Images:** ${currentState.summary.totalImages} (${currentState.summary.totalWeightFormatted})`,
    `- **Too Large / Compressible:** ${currentState.summary.tooLargeCount}`,
    `- **Issues Found:** ${currentState.summary.issueCount} (${currentState.summary.errorCount} critical, ${currentState.summary.warnCount} warnings)`,
    '',
    '| Original Filename | Format | Size (Target) | Rendered | Intrinsic | Aspect Diff | Issues |',
    '| :--- | :--- | :--- | :--- | :--- | :--- | :--- |'
  ];
  currentState.items.forEach((i) => {
    const iss = i.issues.map((x) => x.text).join('; ') || 'OK';
    lines.push(
      `| ${mdCell(i.originalFilename)} | ${mdCell(i.format)} | ${i.fileSizeFormatted} (≤${i.recommendedFormatted}) | ${i.renderedW}×${i.renderedH} | ${i.intrinsicW}×${i.intrinsicH} | ${i.aspectMismatchPct}% | ${mdCell(iss)} |`
    );
  });
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    els.copyMdBtn.textContent = 'Copied MD!';
  } catch (_) {
    els.copyMdBtn.textContent = 'Copy failed';
  }
  setTimeout(() => {
    els.copyMdBtn.textContent = 'Copy Markdown';
  }, 1400);
});

// The folder may be picked in another window while this popup stays open.
window.addEventListener('focus', refreshFolderLabel);

chrome.storage.local.get(['iscProOverwrite'], (res) => {
  overwriteExisting = Boolean(res && res.iscProOverwrite);
  els.overwriteCheck.checked = overwriteExisting;
});
refreshFolderLabel();
ensureAndScan(false);

// Exposed for the automated tests.
window.__iscPopup = { ensureAndScan, getState: () => currentState, compressAllTooLargeToZip, saveToTargetDestination };
