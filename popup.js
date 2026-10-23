import { KEPT_NOTES, RESIZABLE_FORMATS, variantWidths } from './js/jobs.js';
import { canPreview, openPreview } from './js/preview.js';
import { getFolder, clearFolder } from './js/folder-store.js';

// The side panel loads popup.html?panel=1; the toolbar popup is a fixed 750px wide.
const IS_PANEL = new URLSearchParams(location.search).has('panel');
if (IS_PANEL) document.documentElement.classList.add('panel');
// The same code ships to Chrome, Edge and Firefox; name the right browser where the user has to find
// one of its pages. Edge redirects chrome:// links, but its users know them as edge://.
const IS_FIREFOX = /\bFirefox\//.test(navigator.userAgent);
const IS_EDGE =
  !IS_FIREFOX && (navigator.userAgentData?.brands?.some((b) => b.brand === 'Microsoft Edge') ?? /\bEdg\//.test(navigator.userAgent));
const BROWSER_NAME = IS_FIREFOX ? 'Firefox' : IS_EDGE ? 'Edge' : 'Chrome';
const BROWSER_SCHEME = IS_EDGE ? 'edge' : 'chrome';
const INTERNAL_SCHEME = IS_FIREFOX ? 'about:' : `${BROWSER_SCHEME}://`;
const STORE_NAME = IS_FIREFOX ? 'Firefox Add-ons' : IS_EDGE ? 'Edge Add-ons' : 'Chrome Web Store';
// Firefox has no File System Access API, so it always saves through the Save-As dialog.
const CAN_PICK_FOLDER = typeof window.showDirectoryPicker === 'function';
// Must match CONTENT_VERSION in content.js.
const EXPECTED_CONTENT_VERSION = 2;

let currentState = null;
let activeFilter = 'all';
let searchQuery = '';
let sortMode = 'severity';
let activeTabId = null;
let overwriteExisting = false;
let webpCopies = false;
let lossyPng = false;
const compressedResults = new Map(); // image URL -> { beforeBytes, afterBytes, savedPct, note, width, height }

const els = {
  pageHostLabel: document.getElementById('pageHostLabel'),
  openDemoBtn: document.getElementById('openDemoBtn'),
  openPanelBtn: document.getElementById('openPanelBtn'),
  staleBanner: document.getElementById('staleBanner'),
  accessBanner: document.getElementById('accessBanner'),
  grantAccessBtn: document.getElementById('grantAccessBtn'),
  outputOptionsSummary: document.getElementById('outputOptionsSummary'),
  rescanBtn: document.getElementById('rescanBtn'),
  enabledToggle: document.getElementById('enabledToggle'),
  kpiTotal: document.getElementById('kpiTotal'),
  kpiBreakdown: document.getElementById('kpiBreakdown'),
  kpiWeight: document.getElementById('kpiWeight'),
  kpiDpr: document.getElementById('kpiDpr'),
  kpiSavings: document.getElementById('kpiSavings'),
  kpiSavingsSub: document.getElementById('kpiSavingsSub'),
  kpiTooLarge: document.getElementById('kpiTooLarge'),
  kpiIssueSplit: document.getElementById('kpiIssueSplit'),
  targetFolderLabel: document.getElementById('targetFolderLabel'),
  chooseFolderBtn: document.getElementById('chooseFolderBtn'),
  resetFolderBtn: document.getElementById('resetFolderBtn'),
  overwriteRow: document.getElementById('overwriteRow'),
  overwriteCheck: document.getElementById('overwriteCheck'),
  webpCheck: document.getElementById('webpCheck'),
  lossyPngCheck: document.getElementById('lossyPngCheck'),
  compressAllZipBtn: document.getElementById('compressAllZipBtn'),
  resizeAllBtn: document.getElementById('resizeAllBtn'),
  resizeCountBadge: document.getElementById('resizeCountBadge'),
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

// Builds an element. Attribute values and string children are set as plain data, never parsed as HTML,
// so values from the scanned page (filenames, URLs, alt text) are safe here. Null, false and '' children
// are skipped and arrays are flattened.
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value != null && value !== false) node.setAttribute(name, value);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false && c !== ''));
  return node;
}

function showEmptyState(...content) {
  els.itemsList.replaceChildren(el('div', { class: 'empty-state' }, ...content));
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

// ---------- compression jobs (run in the background offscreen document) ----------

const jobWaiters = new Map(); // job id -> resolve, for callers that await completion

// No permission prompt here: Chrome's prompt would close this popup and kill the click. If the
// folder grant has lapsed, the background job opens a small window to ask for it.
async function resolveDestination() {
  return (await getFolder()) ? 'folder' : 'saveas';
}

// Hands a job to the service worker; it keeps running if this panel closes.
async function startJob(mode, items, options = {}) {
  const allowed = await withSiteAccess(items);
  if (!allowed.length) {
    els.compressionStatus.textContent = 'Error: this extension has no access to the site hosting that image — click "Allow on all sites" above.';
    return null;
  }
  items = allowed;
  const destination = await resolveDestination();
  const job = {
    mode,
    items,
    tabId: activeTabId,
    pageUrl: currentState.pageUrl,
    bytesPerPixel: currentState.settings?.bytesPerPixelTarget,
    destination,
    overwrite: overwriteExisting,
    webp: webpCopies,
    lossyPng,
    ...options
  };
  const resp = await new Promise((resolve) =>
    chrome.runtime.sendMessage({ type: 'START_JOB', job }, (r) => {
      void chrome.runtime.lastError;
      resolve(r || { ok: false, error: 'Background service unavailable' });
    })
  );
  if (!resp.ok) {
    els.compressionStatus.textContent = `Error: ${resp.error}`;
    return null;
  }
  setJobRunning(true);
  return new Promise((resolve) => jobWaiters.set(resp.jobId, resolve));
}

function setJobRunning(running) {
  els.compressAllZipBtn.dataset.running = running ? '1' : '';
  els.compressAllZipBtn.disabled = running || zipCandidates().length === 0;
  els.resizeAllBtn.disabled = running || resizeCandidates().length === 0;
}

const jobRunning = () => els.compressAllZipBtn.dataset.running === '1';

// Oversized PNG/JPEG/WebP images that have at least one smaller variant to generate.
function resizeCandidates() {
  if (!currentState) return [];
  return uniqueByUrl(currentState.items.filter(isResizable));
}

const isResizable = (item) => item.needsResize && RESIZABLE_FORMATS.has(item.format) && variantWidths(item).length > 0;

async function resizeAllOversized() {
  const items = resizeCandidates();
  if (!items.length) return;
  return startJob('resize', items);
}

function applyJob(job, results) {
  if (!job) return;
  els.compressionStatus.textContent = job.status || '';
  for (const [url, r] of Object.entries(results || {})) compressedResults.set(url, r);
  const finished = job.state === 'done' || job.state === 'error';
  setJobRunning(!finished);
  if (finished) renderDashboard();
}

function resolveJobWaiter(job) {
  if (job.state !== 'done' && job.state !== 'error') return;
  const resolve = jobWaiters.get(job.id);
  if (resolve) {
    jobWaiters.delete(job.id);
    resolve(job);
  }
}

// Shows the last job and results for this tab, e.g. after reopening the panel mid-batch.
async function restoreJobState(tabId) {
  const keys = [`iscJob:${tabId}`, `iscResults:${tabId}`];
  const stored = await chrome.storage.session.get(keys);
  if (tabId !== activeTabId) return;
  applyJob(stored[keys[0]], stored[keys[1]]);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'JOB_UPDATE') return false;
  // The panel may now show another tab; callers waiting on this job still need to hear it finished.
  resolveJobWaiter(msg.job);
  if (msg.job.tabId === activeTabId) applyJob(msg.job, msg.job.results);
  return false;
});

// Batch compress all oversized images into a single ZIP; resolves when the job finishes.
async function compressAllTooLargeToZip() {
  if (!currentState || !currentState.items) return;
  const items = zipCandidates();
  if (items.length === 0) {
    els.compressionStatus.textContent = 'No oversized images found!';
    return;
  }
  return startJob('zip', items);
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

function resetDashboard() {
  currentState = null;
  estimates.clear();
  els.pageHostLabel.textContent = 'Scanning active tab...';
  els.kpiTotal.textContent = '0';
  els.kpiBreakdown.textContent = '0 IMG · 0 BG · 0 SVG';
  els.kpiWeight.textContent = '0 KB';
  els.kpiSavings.textContent = '0 KB';
  els.kpiTooLarge.textContent = '0';
  els.kpiIssueSplit.textContent = '0 critical · 0 warn';
  els.tooLargeCountBadge.textContent = '0';
  els.compressAllZipBtn.disabled = true;
  els.compressionStatus.textContent = '';
  showEmptyState('Scanning images on this page...');
}

async function ensureAndScan(forceRescan = false, tabId = null) {
  if (!tabId) {
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      showEmptyState('No active tab detected.');
      return;
    }
    tabId = tab.id;
  }
  if (tabId !== activeTabId) resetDashboard();
  activeTabId = tabId;

  const ensureResp = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'ENSURE_CONTENT_SCRIPT', tabId }, (r) =>
      resolve(r || { ok: false })
    );
  });
  // The panel may have moved to another tab while this one was being checked.
  if (tabId !== activeTabId) return;

  if (!ensureResp.ok) {
    els.pageHostLabel.textContent = 'Restricted browser page';
    showEmptyState(
      `${BROWSER_NAME} blocks extensions from running on internal `,
      el('code', {}, INTERNAL_SCHEME),
      ` or ${STORE_NAME} pages. For local `,
      el('code', {}, 'file://'),
      ' pages, enable “Allow access to file URLs” on the extension’s details page.',
      el('br'),
      el('br'),
      'Click ',
      el('strong', {}, 'Playground'),
      ' above to open the built-in test page and try 1-click and ZIP image compression!'
    );
    return;
  }

  const state = await sendToTab(tabId, { type: forceRescan ? 'SCAN_PAGE' : 'GET_STATE' });
  if (tabId !== activeTabId) return;
  if (!state || !state.ok) {
    showEmptyState('Unable to read page images. Click Scan to retry.');
    return;
  }

  currentState = state;
  showStaleBanner(state.contentVersion !== EXPECTED_CONTENT_VERSION);
  renderDashboard();
  restoreJobState(tabId);
  requestEstimates(tabId);
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

function resizeResult(item, info) {
  if (!info || !info.variants) return null;
  const files = info.variants.map((v) => `${v.name} (${v.width}×${v.height}, ${formatBytes(v.bytes)})`).join(' · ');
  return el('div', { class: 'resize-result' }, `📐 Created ${files} `, snippet(`resize|${item.url}`, info.snippet));
}

// key is the compressedResults key the snippet is stored under.
function snippet(key, text) {
  return [
    el('pre', { class: 'snippet' }, text),
    el('button', { class: 'mini-btn', 'data-act': 'copy-snippet', 'data-key': key }, 'Copy snippet')
  ];
}

// The result pill(s) after compressing, or null if this image has not been compressed yet.
function compressResult(item, info) {
  if (!info) return null;
  const webp =
    info.webp &&
    el('div', { class: 'resize-result' }, `🌐 WebP copy ${info.webp.name} (${formatBytes(info.webp.bytes)}) `, snippet(item.url, info.snippet));
  if (KEPT_NOTES.has(info.note)) {
    return [el('div', { class: 'compress-result-pill' }, `ℹ️ Not changed: ${info.reason || 'already optimal'}`), webp];
  }
  const lossyNote = info.note === 'compressed-lossy' ? ` · ${info.reason}` : '';
  return [
    el(
      'div',
      { class: 'compress-result-pill' },
      `✓ ${formatBytes(info.beforeBytes)} → `,
      el('strong', {}, formatBytes(info.afterBytes)),
      ` (-${info.savedPct}% · ${info.width}×${info.height}px kept${lossyNote})`
    ),
    webp
  ];
}

// ---------- measured savings (background dry-run compression) ----------

const estimates = new Map(); // image URL -> { beforeBytes, afterBytes, savedPct, unchanged, reason } or { error }

function uniqueByUrl(list) {
  const seen = new Set();
  return list.filter((i) => !seen.has(i.url) && seen.add(i.url));
}

const compressibleItems = () => (currentState ? uniqueByUrl(currentState.items.filter((i) => i.needsCompression)) : []);

// Images worth putting in the ZIP: compressible, minus those a dry run proved can't shrink.
function zipCandidates() {
  // With WebP copies on, an already-optimal PNG/JPEG can still gain a smaller WebP version.
  return compressibleItems().filter((i) => !estimates.get(i.url)?.unchanged || (webpCopies && (i.format === 'PNG' || i.format === 'JPEG')));
}

async function requestEstimates(tabId) {
  const items = await withSiteAccess(compressibleItems());
  if (!items.length) return;
  const resp = await new Promise((resolve) =>
    chrome.runtime.sendMessage(
      { type: 'START_ESTIMATE', tabId, items, bytesPerPixel: currentState.settings?.bytesPerPixelTarget, lossyPng },
      (r) => {
        void chrome.runtime.lastError;
        resolve(r);
      }
    )
  );
  if (tabId !== activeTabId || !resp || !resp.ok) return;
  for (const [url, result] of Object.entries(resp.cached)) estimates.set(url, result);
  renderDashboard();
}

function renderSavingsKpi() {
  const items = compressibleItems();
  let saved = 0;
  let measured = 0;
  for (const item of items) {
    const e = estimates.get(item.url);
    if (!e) continue;
    measured++;
    if (!e.error) saved += Math.max(0, e.beforeBytes - e.afterBytes);
  }
  els.kpiSavings.textContent = formatBytes(saved);
  els.kpiSavingsSub.textContent =
    measured < items.length ? `Measuring ${measured}/${items.length}…` : items.length ? 'Measured by test compression' : 'Nothing to compress';
}

function estimatePill(item) {
  const pill = (text) => el('div', { class: 'estimate-pill' }, text);
  const e = estimates.get(item.url);
  if (e && !e.error) {
    if (e.unchanged) return pill(`ℹ️ Compression can't shrink this: ${e.reason || 'already optimal'}`);
    return pill(`💡 Compression can save ${formatBytes(e.beforeBytes - e.afterBytes)} (-${e.savedPct}%)`);
  }
  if (item.needsResize && !item.needsCompression) {
    return pill(`ℹ️ Only resizing would make this lighter (its pixel dimensions are larger than displayed)${isResizable(item) ? ' — use Resize.' : '.'}`);
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'ESTIMATE_UPDATE' && msg.tabId === activeTabId) {
    estimates.set(msg.url, msg.result);
    renderDashboard();
  }
  return false;
});

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
  const zipItems = zipCandidates();

  els.kpiTotal.textContent = String(summary.totalImages);
  els.kpiBreakdown.textContent = `${imgCount} IMG · ${bgCount} BG · ${svgCount} SVG`;
  els.kpiWeight.textContent = summary.totalWeightFormatted;
  els.kpiDpr.textContent = `Display DPR ${Number(dpr || 1).toFixed(1)}x`;
  renderSavingsKpi();
  els.kpiTooLarge.textContent = String(tooLargeItems.length);
  els.kpiIssueSplit.textContent = `${summary.compressibleCount ?? 0} compressible · ${summary.oversizedCount ?? 0} oversized px`;
  els.tooLargeCountBadge.textContent = String(zipItems.length);
  els.compressAllZipBtn.disabled = zipItems.length === 0 || jobRunning();
  const resizeItems = resizeCandidates();
  els.resizeCountBadge.textContent = String(resizeItems.length);
  els.resizeAllBtn.disabled = resizeItems.length === 0 || jobRunning();

  const visibleItems = filterAndSortItems(items);
  if (visibleItems.length === 0) {
    showEmptyState('No images match the current filter.');
    return;
  }

  els.itemsList.replaceChildren(...visibleItems.map(itemCard));

  els.itemsList.querySelectorAll('.mini-btn').forEach((btn) => {
    btn.addEventListener('click', () => onItemAction(btn));
  });
}

function itemCard(item) {
  const hasThumb = item.url && !item.url.startsWith('inline-');
  const statusLabel = item.severity === 'error' ? 'Error' : item.severity === 'warn' ? 'Warn' : 'OK';
  const spec = (label, value) => el('span', {}, el('strong', {}, label), ` ${value}`);
  const button = (act, title, label, cls = '') =>
    el('button', { class: `mini-btn${cls}`, 'data-act': act, 'data-id': item.id, title }, label);

  return el(
    'div',
    { class: `item-card status-${item.severity}`, 'data-id': item.id },
    el(
      'div',
      { class: 'thumb-wrap' },
      hasThumb ? el('img', { src: item.url, alt: '', loading: 'lazy' }) : el('span', { class: 'thumb-fallback' }, item.format)
    ),
    el(
      'div',
      { class: 'item-body' },
      el(
        'div',
        { class: 'item-header' },
        el('span', { class: 'item-name', title: `Original Filename: ${item.originalFilename}` }, item.originalFilename),
        el(
          'div',
          { class: 'item-badges' },
          el('span', { class: 'badge fmt' }, item.format),
          el('span', { class: `badge status-${item.severity}` }, statusLabel)
        )
      ),
      el(
        'div',
        { class: 'item-specs' },
        spec('Size:', `${item.fileSizeFormatted} (≤ ${item.recommendedFormatted})`),
        spec('Rendered:', `${item.renderedW}×${item.renderedH}px`),
        spec('Intrinsic:', `${item.intrinsicW || '?'}×${item.intrinsicH || '?'}px`),
        spec('Ratio:', item.aspectMismatchPct > 0 ? `${item.aspectMismatchPct}% diff` : 'Match')
      ),
      compressResult(item, compressedResults.get(item.url)) ?? estimatePill(item),
      resizeResult(item, compressedResults.get(`resize|${item.url}`)),
      item.issues.length > 0 &&
        el(
          'div',
          { class: 'item-issues' },
          item.issues.map((iss) => el('div', { class: `issue-line ${iss.level === 'warn' ? 'warn' : ''}` }, `• ${iss.text}`))
        )
    ),
    el(
      'div',
      { class: 'item-actions' },
      button('compress', `Compress & save ${item.originalFilename} keeping original dimensions & format`, 'Compress', ' compress-btn'),
      isResizable(item) &&
        button(
          'resize',
          `Create ${variantWidths(item).map((w) => w + 'px').join(' and ')} wide versions plus a srcset snippet`,
          'Resize',
          ' resize-btn'
        ),
      canPreview(item) && button('preview', 'Compare original and compressed side by side and pick the quality', 'Preview'),
      button('locate', 'Scroll to image on page', 'Locate'),
      el('button', { class: 'mini-btn', 'data-act': 'copy', 'data-url': item.url, title: 'Copy image URL' }, 'Copy')
    )
  );
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
    btn.disabled = true;
    btn.textContent = 'Working…';
    const job = await startJob('single', [targetItem]);
    if (!job || job.state === 'error') flash(btn, 'Error', 'Compress', 1500);
  } else if (act === 'resize' && currentState) {
    const targetItem = currentState.items.find((x) => x.id === id);
    if (!targetItem) return;
    btn.disabled = true;
    btn.textContent = 'Working…';
    const job = await startJob('resize', [targetItem]);
    if (!job || job.state === 'error') flash(btn, 'Error', 'Resize', 1500);
  } else if (act === 'preview' && currentState) {
    const targetItem = currentState.items.find((x) => x.id === id);
    if (!targetItem) return;
    openPreview(targetItem, {
      tabId: activeTabId,
      onSave: (quality) => startJob('single', [targetItem], { chosenQuality: quality })
    }).catch((err) => {
      els.compressionStatus.textContent = `Preview failed: ${err.message || err}`;
    });
  } else if (act === 'copy-snippet') {
    const snippet = compressedResults.get(btn.getAttribute('data-key'))?.snippet || '';
    try {
      await navigator.clipboard.writeText(snippet);
      flash(btn, 'Copied', 'Copy snippet', 1000);
    } catch (_) {
      flash(btn, 'Failed', 'Copy snippet', 1000);
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

els.chooseFolderBtn.hidden = !CAN_PICK_FOLDER;
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

els.webpCheck.addEventListener('change', () => {
  webpCopies = els.webpCheck.checked;
  chrome.storage.local.set({ iscProWebp: webpCopies });
  renderDashboard();
});

els.lossyPngCheck.addEventListener('change', () => {
  lossyPng = els.lossyPngCheck.checked;
  chrome.storage.local.set({ iscProLossyPng: lossyPng });
  // Estimates depend on this option, so measure again.
  estimates.clear();
  renderDashboard();
  if (currentState) requestEstimates(activeTabId);
});

els.resizeAllBtn.addEventListener('click', () => {
  resizeAllOversized();
});

els.compressAllZipBtn.addEventListener('click', () => {
  compressAllTooLargeToZip();
});

els.rescanBtn.addEventListener('click', () => ensureAndScan(true, activeTabId));

els.openPanelBtn.hidden = IS_PANEL;
els.openPanelBtn.addEventListener('click', async () => {
  // Firefox: the sidebar must open synchronously inside the click, before any await.
  const sidePanel = chrome.sidePanel;
  if (!sidePanel && globalThis.browser?.sidebarAction) {
    browser.sidebarAction.open();
    window.close();
    return;
  }
  const win = await chrome.windows.getCurrent();
  await sidePanel.open({ windowId: win.id });
  window.close();
});

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

chrome.storage.local.get(['iscProOverwrite', 'iscProWebp', 'iscProLossyPng'], (res) => {
  overwriteExisting = Boolean(res && res.iscProOverwrite);
  els.overwriteCheck.checked = overwriteExisting;
  webpCopies = Boolean(res && res.iscProWebp);
  els.webpCheck.checked = webpCopies;
  lossyPng = Boolean(res && res.iscProLossyPng);
  els.lossyPngCheck.checked = lossyPng;
  updateOptionsSummary();
  renderDashboard();
});
refreshFolderLabel();
ensureAndScan(false);

// ---------- follow the active tab (the side panel stays open while browsing) ----------

const ownPageUrl = location.href.split('#')[0];
let panelWindowId = null;
chrome.windows.getCurrent().then((w) => {
  panelWindowId = w.id;
});

async function followTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.url === ownPageUrl) return; // when opened as a tab (tests), ignore ourselves
  if (panelWindowId !== null && tab.windowId !== panelWindowId) return;
  ensureAndScan(false, tabId);
}

chrome.tabs.onActivated.addListener(({ tabId }) => followTab(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId !== activeTabId) return;
  if (info.status === 'loading' && info.url) resetDashboard();
  // A navigation replaces the page (and its content script state), so scan the new page.
  if (info.status === 'complete') ensureAndScan(false, tabId);
});

// Exposed for the automated tests.
window.__iscPopup = { ensureAndScan, getState: () => currentState, compressAllTooLargeToZip, resizeAllOversized, showStaleBanner };

// Chrome keeps running the content script (and service worker) the extension was loaded with until
// it is reloaded, while the panel's own files are read fresh from disk. Say so instead of showing
// wrong numbers.
function showStaleBanner(stale) {
  els.staleBanner.classList.toggle('hidden', !stale);
  els.staleBanner.textContent = stale
    ? IS_FIREFOX
      ? 'This tab is running an older copy of the extension, so some numbers may be missing. Refresh this page.'
      : `This tab is running an older copy of the extension, so some numbers may be missing. Open ${BROWSER_SCHEME}://extensions, click Reload on Image Size Checker Pro, then refresh this page.`
    : '';
}

function updateOptionsSummary() {
  const on = [];
  if (webpCopies) on.push('WebP copies');
  if (lossyPng) on.push('lossy PNG');
  if (overwriteExisting && !els.overwriteRow.classList.contains('hidden')) on.push('overwrite');
  els.outputOptionsSummary.textContent = on.length ? `· ${on.join(' · ')} on` : '';
}
for (const box of [els.webpCheck, els.lossyPngCheck, els.overwriteCheck]) box.addEventListener('change', updateOptionsSummary);

// ---------- site access ----------
// With Chrome's site access set to "on click" or "specific sites", host access for other sites
// (CDNs, Google, …) is withheld and fetching their images fails with CORS errors. Detect that,
// offer to grant it, and skip images we may not fetch instead of logging failed requests.
const originAccess = new Map();
function hasSiteAccess(url) {
  if (!/^https?:/i.test(url)) return Promise.resolve(true); // data:, blob: and inline images
  const origin = new URL(url).origin;
  if (!originAccess.has(origin)) originAccess.set(origin, chrome.permissions.contains({ origins: [`${origin}/*`] }).catch(() => false));
  return originAccess.get(origin);
}

async function withSiteAccess(items) {
  const ok = await Promise.all(items.map((i) => hasSiteAccess(i.url)));
  return items.filter((_, k) => ok[k]);
}

async function checkSiteAccess() {
  const all = await chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => true);
  els.accessBanner.classList.toggle('hidden', all);
}

els.grantAccessBtn.addEventListener('click', async () => {
  try {
    await chrome.permissions.request({ origins: ['<all_urls>'] });
  } catch (_) {}
  originAccess.clear();
  checkSiteAccess();
});
checkSiteAccess();

// ---------- keyboard shortcuts ----------
// The extension ships with no default keys (a default can silently override a website's own
// shortcut, or lose to another extension). Show whatever the user assigned on the browser's shortcuts
// page, which is the only place keys can be set.
const SHORTCUTS_PAGE = `${BROWSER_SCHEME}://extensions/shortcuts`;
const shortcutEls = {
  set: document.getElementById('shortcutSet'),
  key: document.getElementById('shortcutKey'),
  btn: document.getElementById('shortcutBtn'),
  toggleLabel: document.getElementById('enabledToggleLabel')
};

async function renderShortcuts() {
  const commands = await chrome.commands.getAll().catch(() => []);
  const keyFor = (name) => commands.find((c) => c.name === name)?.shortcut || '';
  const open = keyFor('_execute_action');
  shortcutEls.set.classList.toggle('hidden', !open);
  shortcutEls.key.textContent = open;
  shortcutEls.btn.textContent = open ? 'Change' : 'Set a shortcut';
  shortcutEls.btn.classList.toggle('is-link', Boolean(open));
  const toggle = keyFor('toggle-inspector');
  shortcutEls.toggleLabel.title = 'Show or hide the on-page image badges' + (toggle ? ` (${toggle})` : '');
}

// Firefox keeps shortcuts in the Add-ons Manager, which only this API can open.
shortcutEls.btn.addEventListener('click', () =>
  chrome.commands.openShortcutSettings ? chrome.commands.openShortcutSettings() : chrome.tabs.create({ url: SHORTCUTS_PAGE })
);
// Chrome has no event for shortcut changes; the side panel stays open, so re-read on return.
window.addEventListener('focus', renderShortcuts);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && renderShortcuts());
shortcutEls.btn.title = IS_FIREFOX
  ? 'Choose a keyboard shortcut in the Firefox Add-ons Manager'
  : `Choose a keyboard shortcut on ${BROWSER_NAME}'s shortcuts page`;
renderShortcuts();
