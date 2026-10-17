// Image Size Checker Pro — Content Script & Non-Destructive Shadow DOM Overlay Engine
(() => {
  if (window.__ISC_PRO_LOADED__) {
    return;
  }
  window.__ISC_PRO_LOADED__ = true;

  const DEFAULT_SETTINGS = {
    enabled: true,
    autoScan: false, // scan every page on load; otherwise only after the popup or shortcut asks
    overlayMode: 'all', // 'all' | 'issues' | 'hover' | 'off'
    maxFileSizeKB: 250,
    aspectRatioTolerancePct: 3.0,
    oversizeDprMultiplier: 1.6,
    bytesPerPixelTarget: 0.35,
    scanCssBackgrounds: true,
    scanInlineSvgs: true,
    minDimensionPx: 24
  };
  const SCAN_KEYS = ['maxFileSizeKB', 'aspectRatioTolerancePct', 'oversizeDprMultiplier', 'bytesPerPixelTarget', 'scanCssBackgrounds', 'scanInlineSvgs', 'minDimensionPx'];
  const ANALYZE_CONCURRENCY = 6;
  const HOVER_GRACE_MS = 250;

  let settings = { ...DEFAULT_SETTINGS };
  let active = false; // set once something asks for a scan; until then the page is left alone
  let analyzedItems = [];
  let elementMap = new Map();
  const itemByElement = new WeakMap();
  const elementIds = new WeakMap();
  let elementIdCounter = 0;
  const metaCache = new Map();
  let hoveredItemId = null;
  let pinnedItemId = null;
  let highlightedItemId = null;
  let hoverClearTimer = null;
  let scanTimer = null;
  let rafPending = false;
  let runningScan = null;
  let queuedScan = null;

  let hostEl = null;
  let shadowRoot = null;
  let badgesLayer = null;
  let tooltipEl = null;
  let tooltipItemId = null;
  const overlayNodes = new Map(); // item id -> { box, pill, key }

  function runtimeAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatBytes(bytes) {
    if (bytes === null || bytes === undefined || isNaN(bytes) || bytes <= 0) return '0 KB';
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(2)} MB`;
  }

  function simplifyRatio(w, h) {
    if (!w || !h) return 'N/A';
    const ratio = w / h;
    const commonRatios = [
      [1, 1, '1:1'],
      [16, 9, '16:9'],
      [9, 16, '9:16'],
      [4, 3, '4:3'],
      [3, 4, '3:4'],
      [3, 2, '3:2'],
      [2, 3, '2:3'],
      [21, 9, '21:9'],
      [5, 4, '5:4'],
      [4, 5, '4:5'],
      [2, 1, '2:1'],
      [1, 2, '1:2']
    ];
    for (const [rw, rh, label] of commonRatios) {
      if (Math.abs(ratio - rw / rh) < 0.025) {
        return `${label} (${ratio.toFixed(2)})`;
      }
    }
    return `${ratio.toFixed(2)}:1`;
  }

  // Bumped when the scan payload changes, so the panel can tell when a tab runs an older copy.
  const CONTENT_VERSION = 2;
  const COMPRESSIBLE_FORMATS = new Set(['PNG', 'JPEG', 'WEBP', 'SVG']);
  const WEIGHT_CODES = new Set(['FILE_OVER_CAP', 'FILE_OVER_RECOMMENDED', 'LEGACY_FORMAT']);
  const KNOWN_EXT = /\.(avif|webp|png|jpe?g|gif|svg|bmp|ico)$/i;

  function urlPath(url) {
    return (url || '').split('?')[0].split('#')[0];
  }

  function detectFormat(url, mimeType, kind) {
    if (kind === 'svg') return 'SVG';
    const m = (mimeType || '').toLowerCase();
    if (m.includes('avif')) return 'AVIF';
    if (m.includes('webp')) return 'WEBP';
    if (m.includes('svg')) return 'SVG';
    if (m.includes('png')) return 'PNG';
    if (m.includes('jpeg') || m.includes('jpg')) return 'JPEG';
    if (m.includes('gif')) return 'GIF';
    if (m.includes('bmp')) return 'BMP';
    if (m.includes('icon')) return 'ICO';

    const u = (url || '').toLowerCase();
    if (u.startsWith('data:image/')) {
      const sub = u.slice(11).split(/[;,]/)[0];
      const known = { 'svg+xml': 'SVG', jpeg: 'JPEG', jpg: 'JPEG', png: 'PNG', gif: 'GIF', webp: 'WEBP', avif: 'AVIF', bmp: 'BMP' };
      return known[sub] || 'IMG';
    }
    const extMatch = urlPath(u).match(KNOWN_EXT);
    if (extMatch) {
      const ext = extMatch[1].toUpperCase();
      return ext === 'JPG' ? 'JPEG' : ext;
    }
    return kind === 'bg' ? 'CSS-BG' : 'IMG';
  }

  function defaultExtForFormat(format) {
    const f = (format || '').toUpperCase();
    const map = { PNG: 'png', WEBP: 'webp', SVG: 'svg', GIF: 'gif', AVIF: 'avif', BMP: 'bmp', ICO: 'ico' };
    return map[f] || 'jpg';
  }

  // Makes one path segment safe on every OS: no separators, reserved characters, or dot-only names.
  function sanitizeSegment(name) {
    const clean = String(name)
      .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 120);
    return clean || '';
  }

  // Extract exact original filename (preserving original extension, never adding -compressed)
  function extractOriginalFilename(url, kind, format, index, el) {
    const ext = defaultExtForFormat(format);
    const withExt = (base) => (/\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.${ext}`);

    const dataFilename = el && el.getAttribute && el.getAttribute('data-filename');
    if (dataFilename) {
      const base = sanitizeSegment(dataFilename.split(/[\\/]/).pop());
      if (base) return { filename: withExt(base), relativePath: withExt(base) };
    }

    if (url && !url.startsWith('data:') && !url.startsWith('blob:')) {
      try {
        const u = new URL(url, window.location.href);
        const segs = u.pathname
          .split('/')
          .filter(Boolean)
          .map((s) => {
            try {
              return sanitizeSegment(decodeURIComponent(s));
            } catch (_) {
              return sanitizeSegment(s);
            }
          })
          .filter(Boolean);
        if (segs.length > 0) {
          const base = withExt(segs[segs.length - 1]);
          const relativePath = [...segs.slice(0, -1), base].join('/');
          return { filename: base, relativePath };
        }
      } catch (_) {}
    }

    const rawId = (el && el.id) || (el && el.getAttribute && (el.getAttribute('alt') || el.getAttribute('aria-label'))) || `${kind}-${index}`;
    const cleanSlug =
      String(rawId)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || `image-${index}`;
    const filename = withExt(cleanSlug);
    return { filename, relativePath: filename };
  }

  function computeRecommendedBytes(renderedW, renderedH, format, cfg) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const targetPixels = Math.max(1, renderedW * dpr) * Math.max(1, renderedH * dpr);

    let bpp = Number(cfg.bytesPerPixelTarget) || 0.35;
    if (format === 'AVIF') bpp *= 0.65;
    else if (format === 'WEBP') bpp *= 0.8;
    else if (format === 'SVG') bpp *= 0.4;
    else if (format === 'PNG') bpp *= 1.15;

    const dynamicBudget = Math.round(targetPixels * bpp);
    const minFloor = 12 * 1024;
    const hardCap = (Number(cfg.maxFileSizeKB) || 250) * 1024;
    return Math.max(minFloor, Math.min(dynamicBudget, hardCap));
  }

  function getPerformanceResourceSize(url) {
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) return 0;
    try {
      const entries = performance.getEntriesByName(url, 'resource');
      if (entries && entries.length > 0) {
        // encodedBodySize is the real file size; transferSize includes headers, so it is not used.
        // Entries also exist for failed loads (a 404 page's body), which say nothing about the image.
        const last = entries[entries.length - 1];
        if (last.responseStatus >= 400) return 0;
        if (last.encodedBodySize > 0) return last.encodedBodySize;
      }
    } catch (_) {}
    return 0;
  }

  function computeDataUriMeta(url) {
    const commaIdx = url.indexOf(',');
    const header = commaIdx > -1 ? url.slice(5, commaIdx) : '';
    const body = commaIdx > -1 ? url.slice(commaIdx + 1) : '';
    const mimeMatch = header.match(/^([^;]+)/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
    const isBase64 = header.includes(';base64');
    let fileSize;
    if (isBase64) {
      const clean = body.replace(/\s+/g, '');
      fileSize = Math.floor((clean.length * 3) / 4) - (clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0);
    } else {
      try {
        fileSize = new Blob([decodeURIComponent(body)]).size;
      } catch (_) {
        fileSize = new Blob([body]).size;
      }
    }
    return { ok: true, fileSize: Math.max(0, fileSize), mimeType };
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      if (!runtimeAlive()) return resolve(null);
      try {
        chrome.runtime.sendMessage(message, (resp) => {
          void chrome.runtime.lastError;
          resolve(resp || null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  async function fetchBlobLocally(url) {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.blob();
  }

  async function lookupMeta(url) {
    if (!url) return { ok: false, fileSize: 0, mimeType: '' };
    if (url.startsWith('data:')) return computeDataUriMeta(url);
    // blob: URLs belong to the page, so only this script (not the extension's service worker) can read them.
    if (url.startsWith('blob:')) {
      try {
        const blob = await fetchBlobLocally(url);
        return { ok: true, fileSize: blob.size, mimeType: blob.type };
      } catch (_) {
        return { ok: false, fileSize: 0, mimeType: '' };
      }
    }
    const resp = await sendRuntimeMessage({ type: 'GET_IMAGE_META', url });
    return resp || { ok: false, fileSize: 0, mimeType: '' };
  }

  function askMeta(url) {
    if (!metaCache.has(url)) {
      if (metaCache.size > 1000) metaCache.delete(metaCache.keys().next().value);
      metaCache.set(url, lookupMeta(url));
    }
    return metaCache.get(url);
  }

  function loadOffscreenDimensions(url) {
    return new Promise((resolve) => {
      if (!url) {
        resolve({ width: 0, height: 0 });
        return;
      }
      const img = new Image();
      const timer = setTimeout(() => resolve({ width: 0, height: 0 }), 2500);
      img.onload = () => {
        clearTimeout(timer);
        resolve({ width: img.naturalWidth || 0, height: img.naturalHeight || 0 });
      };
      img.onerror = () => {
        clearTimeout(timer);
        resolve({ width: 0, height: 0 });
      };
      img.src = url;
    });
  }

  // Layout size of the box the image paints into. Unlike getBoundingClientRect this excludes borders
  // (and padding for <img>) and ignores CSS transforms, so aspect and DPR math use the real slot size.
  function paintBoxSize(el, computed, kind, rect) {
    if (!(el instanceof HTMLElement) || !el.offsetWidth) {
      return { w: Math.round(rect.width), h: Math.round(rect.height) };
    }
    const px = (v) => parseFloat(v) || 0;
    let w = el.offsetWidth - px(computed.borderLeftWidth) - px(computed.borderRightWidth);
    let h = el.offsetHeight - px(computed.borderTopWidth) - px(computed.borderBottomWidth);
    if (kind === 'img') {
      w -= px(computed.paddingLeft) + px(computed.paddingRight);
      h -= px(computed.paddingTop) + px(computed.paddingBottom);
    }
    return { w: Math.max(0, Math.round(w)), h: Math.max(0, Math.round(h)) };
  }

  function serializeSvg(svg) {
    try {
      // XMLSerializer adds the SVG namespace that inline <svg> in HTML usually omits; without it the
      // saved .svg file would not render.
      return new XMLSerializer().serializeToString(svg);
    } catch (_) {
      return svg.outerHTML || '';
    }
  }

  function stableElementId(el) {
    let id = elementIds.get(el);
    if (!id) {
      id = `isc-item-${++elementIdCounter}`;
      elementIds.set(el, id);
    }
    return id;
  }

  async function analyzeCandidate(candidate, index) {
    const { el, kind, url, bgIndex } = candidate;
    const rect = el.getBoundingClientRect();
    const computed = window.getComputedStyle(el);
    const objectFit = computed.objectFit || 'fill';
    const { w: renderedW, h: renderedH } = paintBoxSize(el, computed, kind, rect);

    let intrinsicW = 0;
    let intrinsicH = 0;
    let fileSize = 0;
    let mimeType = '';
    let altText = '';
    let loadingAttr = '';
    let hasDimensionAttrs = true;
    let isInPicture = false;
    let isDecorative = false;
    let itemUrl = url;

    if (kind === 'img') {
      intrinsicW = el.naturalWidth || 0;
      intrinsicH = el.naturalHeight || 0;
      altText = el.getAttribute('alt');
      isDecorative = altText === '' || el.getAttribute('role') === 'presentation' || el.getAttribute('aria-hidden') === 'true';
      loadingAttr = (el.getAttribute('loading') || 'eager').toLowerCase();
      hasDimensionAttrs =
        (el.hasAttribute('width') && el.hasAttribute('height')) ||
        Boolean(computed.aspectRatio && computed.aspectRatio !== 'auto');
      isInPicture = Boolean(el.closest('picture'));
    } else if (kind === 'svg') {
      const vb = el.viewBox && el.viewBox.baseVal;
      intrinsicW = Math.round((vb && vb.width) || renderedW);
      intrinsicH = Math.round((vb && vb.height) || renderedH);
      const svgMarkup = serializeSvg(el);
      fileSize = new Blob([svgMarkup]).size;
      mimeType = 'image/svg+xml';
      itemUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgMarkup)}`;
      altText = el.getAttribute('aria-label') || el.querySelector('title')?.textContent || '';
    } else if (kind === 'bg') {
      const dims = await loadOffscreenDimensions(url);
      intrinsicW = dims.width;
      intrinsicH = dims.height;
      altText = el.getAttribute('aria-label') || '';
    }

    if (kind !== 'svg' && url) {
      fileSize = getPerformanceResourceSize(url);
      // Only hit the network when the timing API had no size, or the URL alone cannot tell the format.
      if (!fileSize || !KNOWN_EXT.test(urlPath(url))) {
        const meta = await askMeta(url);
        if (!fileSize && meta.fileSize > 0) fileSize = meta.fileSize;
        if (meta.mimeType) mimeType = meta.mimeType;
      }
    }

    const format = detectFormat(itemUrl, mimeType, kind);
    const isSvgFormat = format === 'SVG';
    const { filename, relativePath } = extractOriginalFilename(kind === 'svg' ? '' : url, kind, format, index, el);
    const recommendedBytes = computeRecommendedBytes(renderedW, renderedH, format, settings);

    let aspectMismatchPct = 0;
    const renderedRatio = renderedW > 0 && renderedH > 0 ? renderedW / renderedH : 0;
    const intrinsicRatio = intrinsicW > 0 && intrinsicH > 0 ? intrinsicW / intrinsicH : 0;
    if (renderedRatio > 0 && intrinsicRatio > 0 && kind !== 'svg') {
      aspectMismatchPct = Number(
        (Math.abs(renderedRatio - intrinsicRatio) / intrinsicRatio * 100).toFixed(1)
      );
    }

    const dpr = window.devicePixelRatio || 1;
    const idealMaxW = Math.round(renderedW * dpr * (Number(settings.oversizeDprMultiplier) || 1.6));
    const idealMaxH = Math.round(renderedH * dpr * (Number(settings.oversizeDprMultiplier) || 1.6));

    const issues = [];
    let severity = 'ok';
    let isTooLarge = false;

    const promoteSeverity = (level) => {
      if (level === 'error') severity = 'error';
      else if (level === 'warn' && severity === 'ok') severity = 'warn';
    };

    const hardCapBytes = (Number(settings.maxFileSizeKB) || 250) * 1024;
    let savingsBytes = 0;
    if (fileSize > 0) {
      if (fileSize > hardCapBytes) {
        isTooLarge = true;
        savingsBytes = Math.max(0, fileSize - recommendedBytes);
        issues.push({
          code: 'FILE_OVER_CAP',
          level: 'error',
          text: `File size (${formatBytes(fileSize)}) exceeds ${settings.maxFileSizeKB} KB cap. Optimal target: ~${formatBytes(recommendedBytes)}.`
        });
        promoteSeverity('error');
      } else if (fileSize > recommendedBytes * 1.35 && fileSize > 35 * 1024) {
        isTooLarge = true;
        savingsBytes = Math.max(0, fileSize - recommendedBytes);
        issues.push({
          code: 'FILE_OVER_RECOMMENDED',
          level: 'error',
          text: `Heavy for display size: ${formatBytes(fileSize)} vs. ~${formatBytes(recommendedBytes)} recommended.`
        });
        promoteSeverity('error');
      }
    }

    const tol = Number(settings.aspectRatioTolerancePct) || 3.0;
    if (aspectMismatchPct > tol && kind === 'img' && !isSvgFormat) {
      // object-fit: none and scale-down crop/letterbox rather than stretch, just like cover/contain.
      if (objectFit === 'cover' || objectFit === 'contain' || objectFit === 'scale-down' || objectFit === 'none') {
        issues.push({
          code: 'ASPECT_MASKED',
          level: 'warn',
          text: `Aspect ratio differs by ${aspectMismatchPct}% (${simplifyRatio(intrinsicW, intrinsicH)} vs ${simplifyRatio(renderedW, renderedH)}), cropped/fitted via object-fit: ${objectFit}.`
        });
        promoteSeverity('warn');
      } else {
        issues.push({
          code: 'ASPECT_DISTORTED',
          level: 'error',
          text: `Distorted aspect ratio (${aspectMismatchPct}% mismatch): intrinsic ${simplifyRatio(intrinsicW, intrinsicH)} stretched into ${simplifyRatio(renderedW, renderedH)}.`
        });
        promoteSeverity('error');
      }
    }

    // SVGs scale without loss, so their declared size says nothing about being over- or under-sized.
    if (
      kind !== 'svg' &&
      !isSvgFormat &&
      intrinsicW > 0 &&
      renderedW > 0 &&
      intrinsicW > idealMaxW &&
      intrinsicH > idealMaxH &&
      intrinsicW * intrinsicH - renderedW * renderedH * dpr * dpr > 150000
    ) {
      const oversizeFactor = (intrinsicW / (renderedW * dpr)).toFixed(1);
      if (fileSize > 30 * 1024) isTooLarge = true;
      issues.push({
        code: 'OVERSIZED_DIMENSIONS',
        level: fileSize > 80 * 1024 ? 'error' : 'warn',
        text: `Intrinsic resolution (${intrinsicW}×${intrinsicH}) is ${oversizeFactor}× larger than needed for ${renderedW}×${renderedH} @${dpr}x DPR.`
      });
      promoteSeverity(fileSize > 80 * 1024 ? 'error' : 'warn');
    }

    if (
      kind === 'img' &&
      !isSvgFormat &&
      intrinsicW > 0 &&
      renderedW > 48 &&
      intrinsicW < renderedW * 0.85
    ) {
      issues.push({
        code: 'UPSCALED_BLURRY',
        level: 'warn',
        text: `Upscaled image: ${intrinsicW}×${intrinsicH}px stretched to ${renderedW}×${renderedH}px (may appear blurry).`
      });
      promoteSeverity('warn');
    }

    if (
      (format === 'PNG' || format === 'JPEG') &&
      fileSize > 55 * 1024
    ) {
      isTooLarge = true;
      issues.push({
        code: 'LEGACY_FORMAT',
        level: 'warn',
        text: format === 'PNG'
          ? `Unoptimized PNG (${formatBytes(fileSize)}) — can likely be compressed losslessly.`
          : `Heavy JPEG (${formatBytes(fileSize)}) — can likely be re-encoded smaller at high quality.`
      });
      promoteSeverity('warn');
    }

    if (kind === 'img') {
      // alt="" is the correct markup for decorative images, so only a missing attribute is flagged.
      if (altText === null && !isDecorative) {
        issues.push({
          code: 'MISSING_ALT',
          level: 'warn',
          text: 'Missing alt attribute (accessibility & SEO issue). Use alt="" if the image is decorative.'
        });
        promoteSeverity('warn');
      }
      if (!hasDimensionAttrs) {
        issues.push({
          code: 'CLS_RISK',
          level: 'warn',
          text: 'Missing explicit width/height attributes or CSS aspect-ratio (can cause layout shift / CLS).'
        });
        promoteSeverity('warn');
      }
      // Position in the document's first screen, regardless of how far the user has scrolled.
      const docTop = rect.top + window.scrollY;
      const inInitialViewport = docTop < window.innerHeight && rect.bottom + window.scrollY > 0;
      if (inInitialViewport && loadingAttr === 'lazy' && renderedW * renderedH > 40000) {
        issues.push({
          code: 'LCP_LAZY',
          level: 'warn',
          text: 'Above-the-fold image uses loading="lazy", which can delay Largest Contentful Paint (LCP).'
        });
        promoteSeverity('warn');
      }
    }

    // Compression only helps a heavy file in a format we can re-encode; oversized dimensions need resizing.
    const weightIssue = issues.some((i) => WEIGHT_CODES.has(i.code));
    const needsCompression = weightIssue && COMPRESSIBLE_FORMATS.has(format);
    const needsResize = issues.some((i) => i.code === 'OVERSIZED_DIMENSIONS');

    const baseId = stableElementId(el);
    const id = bgIndex ? `${baseId}-bg${bgIndex}` : baseId;
    const item = {
      id,
      kind,
      url: itemUrl || `inline-${kind}-${index}`,
      shortName: filename,
      originalFilename: filename,
      relativePath,
      format,
      fileSize,
      fileSizeFormatted: formatBytes(fileSize),
      recommendedBytes,
      recommendedFormatted: formatBytes(recommendedBytes),
      savingsBytes,
      savingsFormatted: savingsBytes > 0 ? formatBytes(savingsBytes) : '0 KB',
      isTooLarge,
      needsCompression,
      needsResize,
      renderedW,
      renderedH,
      intrinsicW,
      intrinsicH,
      dpr: Number(dpr.toFixed(2)),
      renderedRatioLabel: simplifyRatio(renderedW, renderedH),
      intrinsicRatioLabel: simplifyRatio(intrinsicW, intrinsicH),
      aspectMismatchPct,
      objectFit,
      altText: altText ?? null,
      isDecorative,
      loadingAttr,
      isInPicture,
      severity,
      issues
    };

    return { item, el };
  }

  function isTooSmall(rect, minPx) {
    return rect.width < 1 || rect.height < 1 || (rect.width < minPx && rect.height < minPx);
  }

  // Parses every url(...) in a computed background-image (which Chrome serializes as url("...")).
  function extractCssUrls(value) {
    const urls = [];
    const re = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)/g;
    let m;
    while ((m = re.exec(value))) {
      const raw = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
      if (raw) urls.push(raw);
    }
    return urls;
  }

  function collectCandidates() {
    const list = [];
    const seenEls = new Set();
    const minPx = Number(settings.minDimensionPx) || 24;

    document.querySelectorAll('img').forEach((img) => {
      if (seenEls.has(img)) return;
      const rect = img.getBoundingClientRect();
      if (isTooSmall(rect, minPx)) return;
      const style = window.getComputedStyle(img);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return;
      const url = img.currentSrc || img.src || img.getAttribute('data-src') || '';
      seenEls.add(img);
      list.push({ el: img, kind: 'img', url });
    });

    if (settings.scanInlineSvgs) {
      document.querySelectorAll('svg').forEach((svg) => {
        if (seenEls.has(svg)) return;
        if (hostEl && hostEl.contains(svg)) return;
        // Nested <svg> elements are part of their outer graphic.
        if (svg.parentElement && svg.parentElement.closest('svg')) return;
        const rect = svg.getBoundingClientRect();
        if (isTooSmall(rect, minPx)) return;
        const style = window.getComputedStyle(svg);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        seenEls.add(svg);
        list.push({ el: svg, kind: 'svg', url: '' });
      });
    }

    if (settings.scanCssBackgrounds) {
      document.querySelectorAll('body, body *').forEach((el) => {
        if (seenEls.has(el) || el === hostEl) return;
        if (!(el instanceof HTMLElement)) return;
        const bg = window.getComputedStyle(el).backgroundImage;
        if (!bg || bg === 'none' || !bg.includes('url(')) return;
        const urls = extractCssUrls(bg).filter((u) => !(u.startsWith('data:image/svg+xml') && u.length < 200));
        if (!urls.length) return;
        const rect = el.getBoundingClientRect();
        if (isTooSmall(rect, minPx)) return;
        seenEls.add(el);
        urls.forEach((url, i) => {
          const absolute = url.startsWith('data:') ? url : new URL(url, document.baseURI).href;
          list.push({ el, kind: 'bg', url: absolute, bgIndex: i });
        });
      });
    }

    return list;
  }

  function ensureShadowDom() {
    if (hostEl && document.documentElement.contains(hostEl)) return;

    hostEl = document.createElement('div');
    hostEl.id = 'isc-pro-shadow-host';
    hostEl.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;overflow:visible;';
    shadowRoot = hostEl.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
      }
      * {
        box-sizing: border-box;
      }
      .isc-layer {
        position: fixed;
        inset: 0;
        pointer-events: none;
        overflow: hidden;
      }
      .isc-box {
        position: fixed;
        pointer-events: none;
        border-radius: 4px;
        transition: transform 0.12s ease, opacity 0.15s ease;
      }
      .isc-box.status-error {
        outline: 2px solid rgba(239, 68, 68, 0.92);
        box-shadow: inset 0 0 0 1px rgba(239, 68, 68, 0.35), 0 0 0 2px rgba(15, 23, 42, 0.35);
      }
      .isc-box.status-warn {
        outline: 2px dashed rgba(245, 158, 11, 0.92);
        box-shadow: 0 0 0 2px rgba(15, 23, 42, 0.3);
      }
      .isc-box.status-ok {
        outline: 1.5px solid rgba(16, 185, 129, 0.75);
      }
      .isc-box.pulse-focus {
        outline: 4px solid #38bdf8 !important;
        box-shadow: 0 0 0 6px rgba(56, 189, 248, 0.35), 0 0 28px rgba(56, 189, 248, 0.85) !important;
      }
      .isc-pill {
        position: absolute;
        top: 4px;
        left: 4px;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 2px 7px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
        line-height: 1.35;
        letter-spacing: 0.01em;
        color: #f8fafc;
        background: rgba(15, 23, 42, 0.9);
        border: 1px solid rgba(255, 255, 255, 0.18);
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
        pointer-events: auto;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
        backdrop-filter: blur(6px);
      }
      .isc-pill:hover {
        transform: scale(1.04);
      }
      .isc-pill .dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .isc-pill.status-error {
        background: rgba(127, 29, 29, 0.94);
        border-color: rgba(252, 165, 165, 0.45);
      }
      .isc-pill.status-error .dot {
        background: #f87171;
        box-shadow: 0 0 6px #ef4444;
      }
      .isc-pill.status-warn {
        background: rgba(120, 53, 15, 0.94);
        border-color: rgba(253, 211, 77, 0.45);
      }
      .isc-pill.status-warn .dot {
        background: #fbbf24;
      }
      .isc-pill.status-ok {
        background: rgba(6, 78, 59, 0.92);
        border-color: rgba(110, 231, 183, 0.4);
      }
      .isc-pill.status-ok .dot {
        background: #34d399;
      }
      .isc-tooltip {
        position: fixed;
        width: 340px;
        background: rgba(15, 23, 42, 0.97);
        color: #f1f5f9;
        border: 1px solid rgba(148, 163, 184, 0.28);
        border-radius: 10px;
        padding: 11px 12px;
        box-shadow: 0 14px 34px rgba(0, 0, 0, 0.52);
        font-size: 12px;
        line-height: 1.4;
        pointer-events: auto;
        z-index: 2147483647;
        backdrop-filter: blur(10px);
        display: none;
      }
      .isc-tooltip.visible {
        display: block;
      }
      .isc-tt-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        padding-bottom: 7px;
        margin-bottom: 8px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.18);
      }
      .isc-tt-title {
        font-weight: 700;
        font-size: 12px;
        color: #f8fafc;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 195px;
      }
      .isc-tt-badges {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .isc-tag {
        padding: 1px 6px;
        border-radius: 4px;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
      }
      .isc-tag.fmt {
        background: rgba(56, 189, 248, 0.18);
        color: #38bdf8;
        border: 1px solid rgba(56, 189, 248, 0.35);
      }
      .isc-tag.status-error {
        background: rgba(239, 68, 68, 0.22);
        color: #fca5a5;
      }
      .isc-tag.status-warn {
        background: rgba(245, 158, 11, 0.22);
        color: #fde68a;
      }
      .isc-tag.status-ok {
        background: rgba(16, 185, 129, 0.22);
        color: #6ee7b7;
      }
      .isc-tt-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px 10px;
        margin-bottom: 8px;
      }
      .isc-metric {
        background: rgba(30, 41, 59, 0.72);
        border: 1px solid rgba(148, 163, 184, 0.14);
        border-radius: 6px;
        padding: 5px 7px;
      }
      .isc-metric-label {
        font-size: 10px;
        color: #94a3b8;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      .isc-metric-val {
        font-size: 12px;
        font-weight: 600;
        color: #f8fafc;
        margin-top: 1px;
      }
      .isc-metric-sub {
        font-size: 10px;
        color: #cbd5e1;
      }
      .isc-issues {
        margin: 6px 0 0;
        padding: 6px 8px;
        border-radius: 6px;
        background: rgba(127, 29, 29, 0.32);
        border: 1px solid rgba(248, 113, 113, 0.3);
      }
      .isc-issues.warn-only {
        background: rgba(120, 53, 15, 0.32);
        border-color: rgba(251, 191, 36, 0.3);
      }
      .isc-issue-item {
        font-size: 11px;
        color: #fecaca;
        margin: 2px 0;
        display: flex;
        align-items: flex-start;
        gap: 5px;
      }
      .isc-issues.warn-only .isc-issue-item {
        color: #fde68a;
      }
      .isc-tt-footer {
        margin-top: 8px;
        padding-top: 6px;
        border-top: 1px solid rgba(148, 163, 184, 0.16);
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 10px;
        color: #94a3b8;
      }
      .isc-tt-actions {
        display: flex;
        gap: 5px;
      }
      .isc-btn {
        background: rgba(56, 189, 248, 0.16);
        color: #38bdf8;
        border: 1px solid rgba(56, 189, 248, 0.35);
        border-radius: 4px;
        padding: 2px 7px;
        font-size: 10px;
        font-weight: 600;
        cursor: pointer;
      }
      .isc-btn:hover {
        background: rgba(56, 189, 248, 0.28);
      }
    `;

    badgesLayer = document.createElement('div');
    badgesLayer.className = 'isc-layer';

    tooltipEl = document.createElement('div');
    tooltipEl.className = 'isc-tooltip';
    // Keep the tooltip open while the pointer is on it so its buttons can be clicked.
    tooltipEl.addEventListener('mouseenter', () => clearTimeout(hoverClearTimer));
    tooltipEl.addEventListener('mouseleave', () => scheduleHoverClear());

    shadowRoot.appendChild(style);
    shadowRoot.appendChild(badgesLayer);
    shadowRoot.appendChild(tooltipEl);
    overlayNodes.clear();
    tooltipItemId = null;
    document.documentElement.appendChild(hostEl);
  }

  function setHover(id) {
    clearTimeout(hoverClearTimer);
    if (hoveredItemId !== id) {
      hoveredItemId = id;
      scheduleOverlayPositionUpdate();
    }
  }

  function scheduleHoverClear() {
    clearTimeout(hoverClearTimer);
    hoverClearTimer = setTimeout(() => {
      if (hoveredItemId !== null) {
        hoveredItemId = null;
        scheduleOverlayPositionUpdate();
      }
    }, HOVER_GRACE_MS);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      // Clipboard API is unavailable on insecure (http) pages; fall back to execCommand.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (_) {}
      ta.remove();
      return ok;
    }
  }

  async function openUrl(url) {
    // Chrome blocks opening data: URLs in a new tab, so open those as blob: URLs instead.
    if (url.startsWith('data:')) {
      const blob = await (await fetch(url)).blob();
      const blobUrl = URL.createObjectURL(blob);
      window.open(blobUrl, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } else {
      window.open(url, '_blank', 'noopener');
    }
  }

  function renderTooltipContent(item) {
    const statusLabel =
      item.severity === 'error' ? 'Needs Fix' : item.severity === 'warn' ? 'Warning' : 'Optimized';

    const issuesHtml =
      item.issues.length > 0
        ? `<div class="isc-issues ${item.severity === 'warn' ? 'warn-only' : ''}">
            ${item.issues
              .map(
                (iss) =>
                  `<div class="isc-issue-item"><span>${iss.level === 'error' ? '●' : '▲'}</span><span>${escapeHtml(iss.text)}</span></div>`
              )
              .join('')}
          </div>`
        : '';

    const altLabel = item.kind === 'img' ? (item.isDecorative ? 'Decorative' : item.altText ? 'Alt OK' : 'Missing Alt') : item.kind.toUpperCase();

    tooltipEl.innerHTML = `
      <div class="isc-tt-header">
        <div class="isc-tt-title" title="${escapeHtml(item.originalFilename)}">${escapeHtml(item.originalFilename)}</div>
        <div class="isc-tt-badges">
          <span class="isc-tag fmt">${escapeHtml(item.format)}</span>
          <span class="isc-tag status-${escapeHtml(item.severity)}">${statusLabel}</span>
        </div>
      </div>
      <div class="isc-tt-grid">
        <div class="isc-metric">
          <div class="isc-metric-label">File Weight</div>
          <div class="isc-metric-val">${escapeHtml(item.fileSizeFormatted)}</div>
          <div class="isc-metric-sub">Target: ≤ ${escapeHtml(item.recommendedFormatted)}</div>
        </div>
        <div class="isc-metric">
          <div class="isc-metric-label">Dimensions (Px)</div>
          <div class="isc-metric-val">${item.renderedW}×${item.renderedH}</div>
          <div class="isc-metric-sub">Intrinsic: ${item.intrinsicW || '?'}×${item.intrinsicH || '?'}</div>
        </div>
        <div class="isc-metric">
          <div class="isc-metric-label">Aspect Ratio</div>
          <div class="isc-metric-val">${escapeHtml(item.renderedRatioLabel)}</div>
          <div class="isc-metric-sub">${
            item.aspectMismatchPct > 0 ? `${item.aspectMismatchPct}% diff (${escapeHtml(item.objectFit)})` : 'Exact match'
          }</div>
        </div>
        <div class="isc-metric">
          <div class="isc-metric-label">Alt & Loading</div>
          <div class="isc-metric-val">${altLabel}</div>
          <div class="isc-metric-sub">${
            item.kind === 'img' ? `loading="${escapeHtml(item.loadingAttr)}"` : `DPR ${item.dpr}x`
          }</div>
        </div>
      </div>
      ${issuesHtml}
      <div class="isc-tt-footer">
        <span>${pinnedItemId === item.id ? '📌 Pinned (click badge to unpin)' : 'Click badge to pin details'}</span>
        <div class="isc-tt-actions">
          <button class="isc-btn" data-action="copy-url">Copy URL</button>
          ${item.url && !item.url.startsWith('inline-') ? `<button class="isc-btn" data-action="open-url">Open</button>` : ''}
        </div>
      </div>
    `;

    tooltipEl.querySelectorAll('.isc-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const act = btn.getAttribute('data-action');
        if (act === 'copy-url') {
          const ok = await copyText(item.url);
          btn.textContent = ok ? 'Copied!' : 'Copy failed';
          setTimeout(() => {
            btn.textContent = 'Copy URL';
          }, 1200);
        } else if (act === 'open-url') {
          openUrl(item.url).catch(() => {});
        }
      });
    });
  }

  function positionTooltip(anchorRect) {
    const ttW = 340;
    const ttH = tooltipEl.offsetHeight || 210;
    const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - ttW - 8));
    let top = anchorRect.bottom + 8;
    if (top + ttH > window.innerHeight - 8) {
      top = Math.max(8, anchorRect.top - ttH - 8);
    }
    tooltipEl.style.left = `${Math.round(left)}px`;
    tooltipEl.style.top = `${Math.round(top)}px`;
  }

  function createOverlayNode(item) {
    const box = document.createElement('div');
    const pill = document.createElement('div');
    pill.addEventListener('mouseenter', () => setHover(item.id));
    pill.addEventListener('mouseleave', () => scheduleHoverClear());
    pill.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      pinnedItemId = pinnedItemId === item.id ? null : item.id;
      tooltipItemId = null; // force the pinned/unpinned footer text to refresh
      renderOverlays();
    });
    box.appendChild(pill);
    return { box, pill, key: '' };
  }

  // Updates overlay boxes in place (rather than rebuilding them) so the element under the pointer
  // survives re-renders and hover state stays stable.
  function renderOverlays() {
    ensureShadowDom();
    if (!badgesLayer) return;

    const visible = new Set();
    let activeTooltipItem = null;
    let activeTooltipRect = null;
    const showAny = settings.enabled && settings.overlayMode !== 'off';

    for (const item of showAny ? analyzedItems : []) {
      const el = elementMap.get(item.id);
      if (!el || !document.documentElement.contains(el)) continue;

      if (settings.overlayMode === 'issues' && item.severity === 'ok' && highlightedItemId !== item.id) {
        continue;
      }

      const rect = el.getBoundingClientRect();
      if (
        rect.bottom < 0 ||
        rect.top > window.innerHeight ||
        rect.right < 0 ||
        rect.left > window.innerWidth ||
        rect.width < 16 ||
        rect.height < 16
      ) {
        continue;
      }

      const isActiveItem = hoveredItemId === item.id || pinnedItemId === item.id || highlightedItemId === item.id;
      if (settings.overlayMode === 'hover' && !isActiveItem) continue;

      let node = overlayNodes.get(item.id);
      if (!node) {
        node = createOverlayNode(item);
        overlayNodes.set(item.id, node);
      }
      const ratioFlag = item.aspectMismatchPct > settings.aspectRatioTolerancePct ? ' · ⚠️ Ratio' : '';
      const key = `${item.severity}|${highlightedItemId === item.id}|${item.fileSizeFormatted}|${item.renderedW}x${item.renderedH}${ratioFlag}`;
      if (node.key !== key) {
        node.key = key;
        node.box.className = `isc-box status-${item.severity}${highlightedItemId === item.id ? ' pulse-focus' : ''}`;
        node.pill.className = `isc-pill status-${item.severity}`;
        node.pill.innerHTML = `<span class="dot"></span><span>${escapeHtml(item.fileSizeFormatted)} · ${item.renderedW}×${item.renderedH}${ratioFlag}</span>`;
      }
      node.box.style.left = `${Math.round(rect.left)}px`;
      node.box.style.top = `${Math.round(rect.top)}px`;
      node.box.style.width = `${Math.round(rect.width)}px`;
      node.box.style.height = `${Math.round(rect.height)}px`;
      if (node.box.parentNode !== badgesLayer) badgesLayer.appendChild(node.box);
      visible.add(item.id);

      if (pinnedItemId === item.id || (!pinnedItemId && hoveredItemId === item.id)) {
        activeTooltipItem = item;
        activeTooltipRect = rect;
      }
    }

    for (const [id, node] of overlayNodes) {
      if (!visible.has(id)) node.box.remove();
    }

    if (activeTooltipItem && activeTooltipRect) {
      if (tooltipItemId !== activeTooltipItem.id) {
        renderTooltipContent(activeTooltipItem);
        tooltipItemId = activeTooltipItem.id;
      }
      tooltipEl.classList.add('visible');
      positionTooltip(activeTooltipRect);
    } else if (tooltipEl) {
      tooltipEl.classList.remove('visible');
      tooltipItemId = null;
    }
  }

  function scheduleOverlayPositionUpdate() {
    if (rafPending || !active) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      renderOverlays();
    });
  }

  async function mapLimit(list, limit, fn) {
    const out = new Array(list.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
      while (next < list.length) {
        const i = next++;
        out[i] = await fn(list[i], i);
      }
    });
    await Promise.all(workers);
    return out;
  }

  async function performScan() {
    ensureShadowDom();
    const candidates = collectCandidates();
    const analyzed = await mapLimit(candidates, ANALYZE_CONCURRENCY, (c, i) => analyzeCandidate(c, i + 1));

    const nextMap = new Map();
    for (const { item, el } of analyzed) {
      nextMap.set(item.id, el);
      if (!item.id.includes('-bg')) itemByElement.set(el, item); // hover maps to an element's first image
    }
    elementMap = nextMap;
    analyzedItems = analyzed.map((a) => a.item);
    tooltipItemId = null;
    renderOverlays();
    updateBadge();
    return getSummaryPayload();
  }

  // Scans never overlap: a request during a scan queues exactly one follow-up scan, and every
  // caller gets the result of a scan that started after its request.
  function runFullScan() {
    active = true;
    startObserving();
    if (queuedScan) return queuedScan;
    if (runningScan) {
      queuedScan = runningScan.then(() => {
        queuedScan = null;
        return startScan();
      });
      return queuedScan;
    }
    return startScan();
  }

  function startScan() {
    runningScan = performScan().finally(() => {
      runningScan = null;
    });
    return runningScan;
  }

  function updateBadge() {
    const issueCount = analyzedItems.filter((i) => i.severity !== 'ok').length;
    sendRuntimeMessage({
      type: 'UPDATE_BADGE',
      issueCount,
      totalCount: analyzedItems.length,
      enabled: settings.enabled
    });
  }

  function getSummaryPayload() {
    const totalWeight = analyzedItems.reduce((acc, item) => acc + (item.fileSize || 0), 0);
    const totalSavings = analyzedItems.reduce((acc, item) => acc + (item.savingsBytes || 0), 0);
    const errorCount = analyzedItems.filter((i) => i.severity === 'error').length;
    const warnCount = analyzedItems.filter((i) => i.severity === 'warn').length;
    const tooLargeCount = analyzedItems.filter((i) => i.isTooLarge).length;
    const compressibleCount = analyzedItems.filter((i) => i.needsCompression).length;
    const oversizedCount = analyzedItems.filter((i) => i.needsResize).length;

    return {
      ok: true,
      contentVersion: CONTENT_VERSION,
      pageUrl: window.location.href,
      pageTitle: document.title || window.location.hostname,
      dpr: window.devicePixelRatio || 1,
      settings,
      summary: {
        totalImages: analyzedItems.length,
        totalWeight,
        totalWeightFormatted: formatBytes(totalWeight),
        totalSavings,
        totalSavingsFormatted: formatBytes(totalSavings),
        errorCount,
        warnCount,
        issueCount: errorCount + warnCount,
        tooLargeCount,
        compressibleCount,
        oversizedCount
      },
      items: analyzedItems
    };
  }

  function onMouseOver(e) {
    if (!active || !settings.enabled || pinnedItemId) return;
    const target = e.target;
    if (!target || !(target instanceof Element)) return;
    const item = itemByElement.get(target);
    if (item) setHover(item.id);
  }

  function onMouseOut(e) {
    if (!active || !settings.enabled || pinnedItemId) return;
    const target = e.target;
    if (!target || !(target instanceof Element)) return;
    const item = itemByElement.get(target);
    if (item && hoveredItemId === item.id) scheduleHoverClear();
  }

  const observer = new MutationObserver((mutations) => {
    if (!active || !settings.enabled) return;
    let relevant = false;
    for (const m of mutations) {
      if (hostEl && (m.target === hostEl || hostEl.contains(m.target))) continue;
      if (m.type === 'attributes') {
        relevant = true;
        break;
      }
      // Our own overlay host being (re)attached is not a page change.
      if ([...m.addedNodes].some((n) => n !== hostEl)) {
        relevant = true;
        break;
      }
    }
    if (relevant) {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(() => {
        runFullScan();
      }, 650);
    }
  });
  let observing = false;

  function startObserving() {
    if (observing) return;
    observing = true;
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset']
    });
  }

  function applySettings(next) {
    const before = settings;
    settings = { ...DEFAULT_SETTINGS, ...next };
    return SCAN_KEYS.some((k) => before[k] !== settings[k]);
  }

  function persistSettings() {
    try {
      chrome.storage?.local?.set?.({ iscProSettings: settings });
    } catch (_) {}
  }

  function onMessage(msg, _sender, sendResponse) {
    if (!msg || !msg.type) return false;

    if (msg.type === 'PING') {
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'SCAN_PAGE') {
      runFullScan().then((payload) => sendResponse(payload));
      return true;
    }

    if (msg.type === 'GET_STATE') {
      if (!active || analyzedItems.length === 0) {
        runFullScan().then((payload) => sendResponse(payload));
        return true;
      }
      sendResponse(getSummaryPayload());
      return false;
    }

    if (msg.type === 'UPDATE_SETTINGS') {
      applySettings({ ...settings, ...(msg.settings || {}) });
      persistSettings();
      runFullScan().then((payload) => sendResponse(payload));
      return true;
    }

    if (msg.type === 'TOGGLE_OVERLAY') {
      if (!active) {
        // First press on a page that has not been scanned yet shows the overlay.
        settings.enabled = true;
        persistSettings();
        runFullScan().then((payload) => sendResponse(payload));
        return true;
      }
      settings.enabled = !settings.enabled;
      persistSettings();
      renderOverlays();
      updateBadge();
      sendResponse(getSummaryPayload());
      return false;
    }

    if (msg.type === 'SCROLL_TO_IMAGE') {
      const el = elementMap.get(msg.id);
      if (el && document.documentElement.contains(el)) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        highlightedItemId = msg.id;
        pinnedItemId = msg.id;
        tooltipItemId = null;
        renderOverlays();
        setTimeout(() => {
          if (highlightedItemId === msg.id) {
            highlightedItemId = null;
            renderOverlays();
          }
        }, 2600);
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false });
      }
      return false;
    }

    // Reads page-owned blob: URLs (which the extension's service worker cannot) for compression.
    if (msg.type === 'FETCH_BYTES_LOCAL') {
      fetchBlobLocally(msg.url)
        .then((blob) => blob.arrayBuffer())
        .then((buf) => {
          const bytes = new Uint8Array(buf);
          let binary = '';
          for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          sendResponse({ ok: true, base64: btoa(binary) });
        })
        .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
      return true;
    }

    return false;
  }

  // Keeps every tab in sync when settings change in another tab or in the popup.
  function onStorageChanged(changes, area) {
    if (area !== 'local' || !changes.iscProSettings) return;
    const next = changes.iscProSettings.newValue || {};
    if (JSON.stringify({ ...DEFAULT_SETTINGS, ...next }) === JSON.stringify(settings)) return;
    const needsRescan = applySettings(next);
    if (!active) {
      if (settings.autoScan) runFullScan();
      return;
    }
    if (needsRescan) runFullScan();
    else {
      renderOverlays();
      updateBadge();
    }
  }

  document.addEventListener('mouseover', onMouseOver, { passive: true });
  document.addEventListener('mouseout', onMouseOut, { passive: true });
  window.addEventListener('scroll', scheduleOverlayPositionUpdate, { passive: true, capture: true });
  window.addEventListener('resize', scheduleOverlayPositionUpdate, { passive: true });
  if (runtimeAlive()) {
    chrome.runtime.onMessage.addListener(onMessage);
    chrome.storage?.onChanged?.addListener(onStorageChanged);
  }

  if (runtimeAlive() && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['iscProSettings'], (res) => {
      if (res && res.iscProSettings) applySettings(res.iscProSettings);
      if (settings.autoScan && !active) runFullScan();
    });
  } else {
    runFullScan();
  }
})();
