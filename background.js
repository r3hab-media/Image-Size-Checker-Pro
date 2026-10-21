// Image Size Checker Pro — Background Service Worker (Manifest V3)
// Resolves cross-origin image file weights without CORS blocks, triggers native OS Save-As
// downloads, and manages per-tab badges.

const metaCache = new Map();
const MAX_CACHE_ENTRIES = 500;

function setCache(url, data) {
  if (metaCache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = metaCache.keys().next().value;
    metaCache.delete(firstKey);
  }
  metaCache.set(url, data);
}

function inferMimeFromUrl(url) {
  try {
    const clean = url.split('?')[0].split('#')[0].toLowerCase();
    if (clean.endsWith('.avif')) return 'image/avif';
    if (clean.endsWith('.webp')) return 'image/webp';
    if (clean.endsWith('.png')) return 'image/png';
    if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg';
    if (clean.endsWith('.gif')) return 'image/gif';
    if (clean.endsWith('.svg')) return 'image/svg+xml';
    if (clean.endsWith('.bmp')) return 'image/bmp';
    if (clean.endsWith('.ico')) return 'image/x-icon';
  } catch (_) {}
  return '';
}

function dataUriMeta(url) {
  const commaIdx = url.indexOf(',');
  const header = commaIdx > -1 ? url.slice(5, commaIdx) : '';
  const body = commaIdx > -1 ? url.slice(commaIdx + 1) : '';
  const mimeMatch = header.match(/^([^;]+)/);
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/unknown';
  let byteLength;
  if (header.includes(';base64')) {
    const clean = body.replace(/\s+/g, '');
    byteLength = Math.floor((clean.length * 3) / 4) - (clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0);
  } else {
    try {
      byteLength = new Blob([decodeURIComponent(body)]).size;
    } catch (_) {
      byteLength = new Blob([body]).size;
    }
  }
  return { ok: true, fileSize: Math.max(0, byteLength), mimeType, source: 'data-uri' };
}

const mimeOf = (resp) => (resp.headers.get('content-type') || '').split(';')[0].trim();

// Cheapest first: HEAD, then a 1-byte Range request (Content-Range carries the total size),
// and only then a full download.
async function probeSize(url, credentials) {
  let mimeType = '';
  let reachable = false;
  try {
    const head = await fetch(url, { method: 'HEAD', cache: 'force-cache', credentials });
    if (head.ok) {
      reachable = true;
      mimeType = mimeOf(head) || mimeType;
      const cl = Number(head.headers.get('content-length'));
      if (cl > 0) return { ok: true, fileSize: cl, mimeType, source: 'head' };
    }
  } catch (_) {}

  try {
    const ranged = await fetch(url, { headers: { Range: 'bytes=0-0' }, cache: 'force-cache', credentials });
    if (ranged.status === 206) {
      const total = Number((ranged.headers.get('content-range') || '').split('/')[1]);
      mimeType = mimeOf(ranged) || mimeType;
      ranged.body?.cancel().catch(() => {});
      if (total > 0) return { ok: true, fileSize: total, mimeType, source: 'range' };
    } else if (ranged.ok) {
      // Server ignored the Range header and is sending the whole file; just measure it.
      mimeType = mimeOf(ranged) || mimeType;
      const blob = await ranged.blob();
      return { ok: true, fileSize: blob.size, mimeType: mimeType || blob.type, source: 'get-blob' };
    }
  } catch (_) {}

  if (!reachable) return null;
  const full = await fetch(url, { cache: 'force-cache', credentials });
  if (!full.ok) return null;
  const blob = await full.blob();
  return { ok: true, fileSize: blob.size, mimeType: mimeOf(full) || blob.type, source: 'get-blob' };
}

async function fetchImageMeta(url) {
  if (!url || typeof url !== 'string') {
    return { ok: false, fileSize: 0, mimeType: '' };
  }
  if (url.startsWith('data:')) return dataUriMeta(url);
  if (metaCache.has(url)) return metaCache.get(url);
  // Without host access (site access "on click" or "specific sites"), the fetch would only fail
  // with a CORS error, so don't make it.
  const origin = new URL(url).origin;
  if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }).catch(() => false))) {
    return { ok: false, fileSize: 0, mimeType: inferMimeFromUrl(url), error: 'no-site-access' };
  }

  // Anonymous first (cache-friendly); retry with cookies for images that need a session.
  for (const credentials of ['omit', 'include']) {
    try {
      const res = await probeSize(url, credentials);
      if (res) {
        if (!res.mimeType) res.mimeType = inferMimeFromUrl(url);
        setCache(url, res);
        return res;
      }
    } catch (_) {}
  }
  return { ok: false, fileSize: 0, mimeType: inferMimeFromUrl(url) };
}

// Firefox refuses data: URLs in downloads.download. Its background is a page, so it gets a blob: URL
// instead, released once the download has finished. Chrome's service worker has no
// URL.createObjectURL and accepts data: URLs, so it keeps them.
async function downloadableUrl(url) {
  if (!url.startsWith('data:') || typeof URL.createObjectURL !== 'function') return { url, release() {} };
  const blobUrl = URL.createObjectURL(await (await fetch(url)).blob());
  return { url: blobUrl, release: () => setTimeout(() => URL.revokeObjectURL(blobUrl), 1000) };
}

// Resolves once the user has saved or cancelled, so callers can report what really happened.
function waitForDownload(downloadId) {
  return new Promise((resolve) => {
    const listener = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
        chrome.downloads.onChanged.removeListener(listener);
        if (delta.state.current === 'complete') {
          resolve({ ok: true, downloadId });
        } else {
          chrome.downloads.search({ id: downloadId }, ([item]) => {
            const cancelled = item && /CANCEL/i.test(item.error || '');
            resolve({ ok: false, cancelled, error: item ? item.error : 'Download interrupted' });
          });
        }
      }
    };
    chrome.downloads.onChanged.addListener(listener);
    chrome.downloads.search({ id: downloadId }, ([item]) => {
      if (item && item.state === 'complete') {
        chrome.downloads.onChanged.removeListener(listener);
        resolve({ ok: true, downloadId });
      }
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === 'GET_IMAGE_META') {
    fetchImageMeta(message.url)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, fileSize: 0, mimeType: '', error: String(err) }));
    return true;
  }

  if (message.type === 'TRIGGER_NATIVE_DOWNLOAD') {
    // Runs here rather than in the popup because the Save-As dialog can close the popup.
    downloadableUrl(message.dataUrl)
      .then(({ url, release }) =>
        chrome.downloads.download(
          {
            url,
            filename: message.filename,
            saveAs: message.saveAs !== false,
            conflictAction: 'uniquify'
          },
          (downloadId) => {
            if (chrome.runtime.lastError || downloadId === undefined) {
              release();
              const error = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Download failed';
              sendResponse({ ok: false, cancelled: /cancel/i.test(error), error });
            } else {
              waitForDownload(downloadId).then((result) => {
                release();
                sendResponse(result);
              });
            }
          }
        )
      )
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (message.type === 'UPDATE_BADGE') {
    const tabId = sender?.tab?.id || message.tabId;
    if (tabId) {
      const { issueCount, totalCount, enabled } = message;
      if (!enabled) {
        chrome.action.setBadgeText({ tabId, text: 'OFF' });
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#64748b' });
      } else if (issueCount > 0) {
        chrome.action.setBadgeText({ tabId, text: String(issueCount) });
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#ef4444' });
      } else if (totalCount > 0) {
        chrome.action.setBadgeText({ tabId, text: 'OK' });
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#10b981' });
      } else {
        chrome.action.setBadgeText({ tabId, text: '' });
      }
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'ENSURE_CONTENT_SCRIPT') {
    const tabId = message.tabId;
    if (!tabId) {
      sendResponse({ ok: false, error: 'Missing tabId' });
      return false;
    }
    chrome.tabs.sendMessage(tabId, { type: 'PING' }, (pingResp) => {
      if (!chrome.runtime.lastError && pingResp && pingResp.ok) {
        sendResponse({ ok: true, alreadyInjected: true });
      } else {
        chrome.scripting.executeScript(
          {
            target: { tabId },
            files: ['content.js']
          },
          () => {
            if (chrome.runtime.lastError) {
              sendResponse({
                ok: false,
                error: chrome.runtime.lastError.message || 'Cannot inject into this page'
              });
            } else {
              sendResponse({ ok: true, injectedNow: true });
            }
          }
        );
      }
    });
    return true;
  }

  return false;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-inspector') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_OVERLAY' }, () => {
        void chrome.runtime.lastError;
      });
    }
  }
});

// The toolbar button opens the 750px popup; the side panel is opened from its "Side panel" button.
// This setting persists, so it must be switched back off for installs that had it on.
// Firefox has no sidePanel API (it uses sidebar_action), so skip it there.
if (chrome.sidePanel) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

// ---------- background compression jobs (run in an offscreen document) ----------

let creatingOffscreen = null;
let closingOffscreen = null;
let activeJobs = 0;
let jobCounter = 0;

async function ensureOffscreen() {
  // hasDocument() is already true while a document is still loading, and still true while one is
  // closing; wait out both so work is never sent to a document that cannot receive it.
  if (creatingOffscreen) return creatingOffscreen;
  if (closingOffscreen) await closingOffscreen;
  if (await chrome.offscreen.hasDocument()) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS', 'BLOBS'],
      justification: 'Compress images in the background so batches keep running after the side panel closes.'
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

// Delivers work to the offscreen document, which acknowledges it; retries (after a pause) with a fresh
// document if the message was lost (e.g. the document closed in between).
async function sendToOffscreen(message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 250 * attempt));
    await ensureOffscreen();
    const acked = await new Promise((resolve) =>
      chrome.runtime.sendMessage({ target: 'offscreen', ...message }, (resp) => {
        void chrome.runtime.lastError;
        resolve(Boolean(resp && resp.ok));
      })
    );
    if (acked) return;
  }
  throw new Error('Background compression is unavailable');
}

function closeOffscreenIfIdle() {
  if (activeJobs > 0 || pendingEstimates > 0 || creatingOffscreen || closingOffscreen) return;
  closingOffscreen = chrome.offscreen
    .closeDocument()
    .catch(() => {})
    .finally(() => {
      closingOffscreen = null;
    });
}

// The latest job and per-image results for each tab, so a reopened panel can show them.
async function storeJobUpdate(job) {
  const jobKey = `iscJob:${job.tabId}`;
  const resultsKey = `iscResults:${job.tabId}`;
  const stored = await chrome.storage.session.get([resultsKey]);
  const results = { ...(stored[resultsKey] || {}), ...(job.results || {}) };
  const { results: _omit, ...summary } = job;
  await chrome.storage.session.set({ [jobKey]: summary, [resultsKey]: results });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === 'START_JOB') {
    const job = { ...message.job, id: `${Date.now()}-${++jobCounter}` };
    activeJobs++;
    storeJobUpdate({ id: job.id, mode: job.mode, tabId: job.tabId, state: 'queued', status: 'Queued…' })
      .then(() => sendToOffscreen({ type: 'RUN_JOB', job }))
      .then(() => sendResponse({ ok: true, jobId: job.id }))
      .catch((err) => {
        activeJobs--;
        sendResponse({ ok: false, error: String(err.message || err) });
      });
    return true;
  }

  if (message.type === 'JOB_UPDATE') {
    if (message.job.state === 'done' || message.job.state === 'error') activeJobs = Math.max(0, activeJobs - 1);
    storeJobUpdate(message.job);
    return false;
  }

  if (message.type === 'JOBS_IDLE') {
    // Free the offscreen document's memory once nothing is queued.
    closeOffscreenIfIdle();
    return false;
  }

  // Offscreen documents cannot reach tabs, so page-owned blob: images are read through here.
  if (message.type === 'FETCH_TAB_BYTES') {
    chrome.tabs.sendMessage(message.tabId, { type: 'FETCH_BYTES_LOCAL', url: message.url }, (resp) => {
      void chrome.runtime.lastError;
      sendResponse(resp || { ok: false, error: 'Page is no longer available' });
    });
    return true;
  }

  return false;
});

// ---------- savings estimates (dry-run compression, cached by URL + size) ----------

const ESTIMATE_CACHE_KEY = 'iscEstimates';
const MAX_ESTIMATES = 500;
let pendingEstimates = 0;
// Lossy PNG changes the result, so it is part of the key.
const estimateKey = (item, lossyPng) => `${lossyPng ? 'L' : ''}|${item.fileSize}|${item.url}`;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === 'START_ESTIMATE') {
    (async () => {
      const cache = (await chrome.storage.session.get(ESTIMATE_CACHE_KEY))[ESTIMATE_CACHE_KEY] || {};
      const cached = {};
      const todo = [];
      for (const item of message.items) {
        const hit = cache[estimateKey(item, message.lossyPng)];
        if (hit) cached[item.url] = hit;
        else todo.push({ ...item, cacheKey: estimateKey(item, message.lossyPng) });
      }
      if (todo.length) {
        pendingEstimates += todo.length;
        try {
          await sendToOffscreen({ type: 'RUN_ESTIMATES', tabId: message.tabId, items: todo, bytesPerPixel: message.bytesPerPixel, lossyPng: message.lossyPng });
        } catch (err) {
          pendingEstimates -= todo.length;
          throw err;
        }
      }
      sendResponse({ ok: true, cached, pending: todo.length });
    })().catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (message.type === 'ESTIMATE_UPDATE') {
    pendingEstimates = Math.max(0, pendingEstimates - 1);
    if (!message.result.error) {
      chrome.storage.session.get(ESTIMATE_CACHE_KEY).then((stored) => {
        const cache = stored[ESTIMATE_CACHE_KEY] || {};
        const keys = Object.keys(cache);
        if (keys.length >= MAX_ESTIMATES) delete cache[keys[0]];
        cache[message.cacheKey] = message.result;
        return chrome.storage.session.set({ [ESTIMATE_CACHE_KEY]: cache });
      });
    }
    return false;
  }

  return false;
});

// ---------- folder access window (Chrome's permission prompt can't run in the toolbar popup) ----------

const accessWindows = new Map(); // window id -> job id

chrome.runtime.onMessage.addListener((message) => {
  if (!message || !message.type) return false;
  if (message.type === 'NEED_FOLDER_ACCESS') {
    chrome.windows
      .create({ url: chrome.runtime.getURL(`folder.html?grant=${encodeURIComponent(message.jobId)}`), type: 'popup', width: 480, height: 280, focused: true })
      .then((win) => accessWindows.set(win.id, message.jobId))
      .catch(() => {
        chrome.runtime.sendMessage({ type: 'FOLDER_ACCESS_RESULT', jobId: message.jobId, granted: false }, () => void chrome.runtime.lastError);
      });
  }
  if (message.type === 'FOLDER_ACCESS_RESULT') {
    for (const [winId, jobId] of accessWindows) if (jobId === message.jobId) accessWindows.delete(winId);
  }
  return false;
});

// Closing the window without answering counts as "not granted", so the job never waits forever.
chrome.windows.onRemoved.addListener((winId) => {
  const jobId = accessWindows.get(winId);
  if (jobId === undefined) return;
  accessWindows.delete(winId);
  chrome.runtime.sendMessage({ type: 'FOLDER_ACCESS_RESULT', jobId, granted: false }, () => void chrome.runtime.lastError);
});
