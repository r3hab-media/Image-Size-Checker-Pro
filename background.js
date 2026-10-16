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
    chrome.downloads.download(
      {
        url: message.dataUrl,
        filename: message.filename,
        saveAs: message.saveAs !== false,
        conflictAction: 'uniquify'
      },
      (downloadId) => {
        if (chrome.runtime.lastError || downloadId === undefined) {
          const error = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Download failed';
          sendResponse({ ok: false, cancelled: /cancel/i.test(error), error });
        } else {
          waitForDownload(downloadId).then(sendResponse);
        }
      }
    );
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

// The toolbar button opens the side panel, which stays open while browsing (unlike a popup).
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
