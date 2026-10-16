import { optimizePngLossless, isAnimatedPng, encodeRgbaPng } from './png.js';
import { readJpegInfo, transplantJpegMetadata } from './jpeg-meta.js';

// Drop-in replacement rules: the output always keeps the original format and pixel dimensions.
// PNG and SVG are optimized losslessly. JPEG and WebP are re-encoded at high quality (lossy),
// and the result is only used when it is actually smaller.
const DEFAULT_QUALITY = 92;
const MIN_QUALITY = 82; // never drop below high visual quality
const MAX_QUALITY = 96;
const TARGET_STEPS = 6;

// ---------- file type detection ----------

const ascii = (b, from, to) => String.fromCharCode(...b.subarray(from, to));

export function sniff(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') return 'png';
  if (ascii(b, 0, 4) === 'GIF8') return 'gif';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'ico';
  if (ascii(b, 4, 8) === 'ftyp') {
    const brands = ascii(b, 8, Math.min(b.length, 64));
    if (brands.includes('avif') || brands.includes('avis')) return 'avif';
    if (/hei|hev|mif1|msf1/.test(brands)) return 'heic';
  }
  // SVG may start with a BOM, XML prolog, comments or a DOCTYPE before the <svg> root.
  const head = new TextDecoder().decode(b.subarray(0, Math.min(b.length, 4096))).replace(/^﻿/, '').trimStart();
  if (head.startsWith('<') && /<svg[\s>]/i.test(head)) return 'svg';
  return null;
}

function webpChunks(b) {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const list = [];
  let pos = 12;
  while (pos + 8 <= b.length) {
    const type = ascii(b, pos, pos + 4);
    const size = view.getUint32(pos + 4, true);
    list.push(type);
    pos += 8 + size + (size & 1);
  }
  return list;
}

function isAnimatedGif(b) {
  let frames = 0;
  for (let i = 0; i < b.length - 2; i++) {
    // Count graphic control extensions; more than one means more than one frame.
    if (b[i] === 0x21 && b[i + 1] === 0xf9 && b[i + 2] === 0x04 && ++frames > 1) return true;
  }
  return false;
}

const MIME = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  heic: 'image/heic',
  svg: 'image/svg+xml'
};

// Formats the browser cannot re-encode without changing the file type.
const UNSUPPORTED_REASON = {
  gif: 'GIF cannot be re-encoded as GIF in the browser; original kept so the file type does not change.',
  bmp: 'BMP cannot be compressed without converting it; original kept so the file type does not change.',
  ico: 'ICO files are kept as-is.',
  avif: 'AVIF cannot be re-encoded in the browser; original kept (AVIF is already highly compressed).',
  heic: 'HEIC cannot be decoded or re-encoded in Chrome; original kept.'
};

// ---------- encoders ----------

async function encodeCanvas(canvas, type, quality) {
  const blob = await canvas.convertToBlob({ type, quality: quality / 100 });
  return blob.type === type ? new Uint8Array(await blob.arrayBuffer()) : null;
}

// Binary searches quality in [MIN_QUALITY..maxQ] for the highest quality that fits the target.
async function fitToTarget(encodeAt, target, maxQ) {
  let lo = MIN_QUALITY;
  let hi = maxQ;
  let fit = null;
  let smallest = null;
  for (let i = 0; i < TARGET_STEPS && lo <= hi; i++) {
    const q = Math.round((lo + hi) / 2);
    const out = await encodeAt(q);
    if (!out) break;
    if (!smallest || out.length < smallest.length) smallest = out;
    if (out.length <= target) {
      fit = out;
      lo = q + 1;
    } else {
      hi = q - 1;
    }
  }
  return fit ? { out: fit, met: true } : { out: smallest, met: false };
}

async function encodeLossy(canvas, type, q, goal) {
  const probe = await encodeCanvas(canvas, type, q);
  if (!probe) return { out: null, missed: false };
  if (!goal || probe.length <= goal) return { out: probe, missed: false };
  const fit = await fitToTarget((v) => encodeCanvas(canvas, type, v), goal, q - 1);
  const out = fit.out && fit.out.length < probe.length ? fit.out : probe;
  return { out, missed: !fit.met };
}

async function drawToCanvas(bytes, kind, colorSpaceConversion) {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: MIME[kind] }), { colorSpaceConversion });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return { canvas, ...size };
}

// Lossless SVG cleanup: strips comments, and inter-tag whitespace only when no element depends on it.
export function optimizeSvg(bytes) {
  let text = new TextDecoder().decode(bytes).replace(/^﻿/, '');
  const kept = [];
  const protect = (m) => `\u0000${kept.push(m) - 1}\u0000`;
  text = text.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, protect);
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  const whitespaceMatters = /<(text|tspan|textPath|style|script|pre|foreignObject|title|desc)\b|xml:space\s*=\s*["']preserve/i.test(text);
  if (!whitespaceMatters) text = text.replace(/>\s+</g, '><');
  text = text.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]).trim();
  const out = new TextEncoder().encode(text);
  return out.length < bytes.length ? out : bytes;
}

// ---------- job ----------

function result(out, kind, extra) {
  return {
    buffer: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength),
    kind,
    mime: MIME[kind] || 'application/octet-stream',
    from: kind,
    width: 0,
    height: 0,
    ...extra
  };
}

export async function compressImageBuffer({ buffer, quality = DEFAULT_QUALITY, target = 0 }) {
  const bytes = new Uint8Array(buffer);
  const kind = sniff(bytes);
  if (!kind) throw new Error('Unsupported image format.');

  if (UNSUPPORTED_REASON[kind]) {
    if (kind === 'gif' && isAnimatedGif(bytes)) return result(bytes, kind, { note: 'kept-animated', reason: 'Animated GIF kept as-is.' });
    return result(bytes, kind, { note: 'kept-unsupported', reason: UNSUPPORTED_REASON[kind] });
  }
  if (kind === 'png' && isAnimatedPng(bytes)) return result(bytes, kind, { note: 'kept-animated', reason: 'Animated PNG kept as-is.' });

  if (kind === 'svg') {
    const out = optimizeSvg(bytes);
    return result(out, kind, { note: out.length < bytes.length ? 'compressed' : 'kept' });
  }

  const q = Number.isFinite(quality) ? Math.min(MAX_QUALITY, Math.max(MIN_QUALITY, Math.round(quality))) : DEFAULT_QUALITY;
  const goal = Number.isFinite(target) && target > 0 ? Math.round(target) : 0;
  let out = null;
  let note = 'compressed';
  let width = 0;
  let height = 0;

  if (kind === 'png') {
    out = await optimizePngLossless(bytes);
  } else if (kind === 'webp') {
    const chunks = webpChunks(bytes);
    if (chunks.includes('ANIM')) return result(bytes, kind, { note: 'kept-animated', reason: 'Animated WebP kept as-is.' });
    if (chunks.includes('VP8L')) {
      return result(bytes, kind, { note: 'kept-lossless', reason: 'Lossless WebP kept; re-encoding would add compression artifacts.' });
    }
    if (chunks.includes('ICCP')) {
      return result(bytes, kind, { note: 'kept-color-profile', reason: 'WebP with an embedded color profile kept to avoid color shifts.' });
    }
    const drawn = await drawToCanvas(bytes, kind, 'default');
    ({ width, height } = drawn);
    const enc = await encodeLossy(drawn.canvas, 'image/webp', q, goal);
    out = enc.out;
    if (goal) note = enc.missed ? 'target-missed' : 'target';
  } else if (kind === 'jpeg') {
    const info = readJpegInfo(bytes);
    // Keep the original ICC profile when it describes RGB data; decode without conversion so the
    // pixel values still match that profile. CMYK/gray sources are converted to sRGB instead.
    const keepIcc = info.icc.length > 0 && info.iccIsRgb && info.components === 3;
    const drawn = await drawToCanvas(bytes, kind, keepIcc ? 'none' : 'default');
    ({ width, height } = drawn);
    const enc = await encodeLossy(drawn.canvas, 'image/jpeg', q, goal);
    out = enc.out && transplantJpegMetadata(bytes, enc.out, { keepIcc });
    if (goal) note = enc.missed ? 'target-missed' : 'target';
  }

  // Never allow the output to grow larger than the original file.
  if (!out || out.length >= bytes.length) {
    return result(bytes, kind, { note: 'kept', reason: 'Already optimal; re-encoding would not make it smaller.', width, height });
  }
  return result(out, kind, { note, target: goal, width, height });
}

const RESIZE_QUALITY = 85;
// PNGs are usually sharp-edged graphics, which show lossy artifacts sooner than photos.
const WEBP_FROM_PNG_QUALITY = 90;

// Resizes to `width` (height keeps the intrinsic aspect ratio) in the original format, for srcset
// variants. Never upscales. Color data is kept the same way as compression keeps it.
// outFormat 'webp' instead writes a WebP copy (converted to sRGB, since it carries no profile).
export async function resizeImageBuffer({ buffer, width, quality, outFormat }) {
  const bytes = new Uint8Array(buffer);
  const kind = sniff(bytes);
  if (!['jpeg', 'png', 'webp'].includes(kind)) {
    throw new Error(`${(kind || 'This').toUpperCase()} images can't be resized without changing their format.`);
  }
  if ((kind === 'png' && isAnimatedPng(bytes)) || (kind === 'webp' && webpChunks(bytes).includes('ANIM'))) {
    throw new Error('Animated images are not resized.');
  }

  const toWebp = outFormat === 'webp';
  const q = quality ?? (toWebp && kind === 'png' ? WEBP_FROM_PNG_QUALITY : RESIZE_QUALITY);

  // PNG color chunks and RGB JPEG ICC profiles are carried over, so decode those without conversion.
  let keepIcc = kind === 'png' && !toWebp;
  if (kind === 'jpeg' && !toWebp) {
    const info = readJpegInfo(bytes);
    keepIcc = info.icc.length > 0 && info.iccIsRgb && info.components === 3;
  }
  const blob = new Blob([bytes], { type: MIME[kind] });
  const probe = await createImageBitmap(blob); // natural size after EXIF orientation
  const origWidth = probe.width;
  const origHeight = probe.height;
  probe.close();

  const w = Math.max(1, Math.min(Math.round(width), origWidth));
  const h = Math.max(1, Math.round((origHeight * w) / origWidth));
  const bitmap = await createImageBitmap(blob, {
    resizeWidth: w,
    resizeHeight: h,
    resizeQuality: 'high',
    colorSpaceConversion: keepIcc ? 'none' : 'default',
    premultiplyAlpha: 'none'
  });
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  let out;
  if (toWebp || kind === 'webp') {
    out = await encodeCanvas(canvas, 'image/webp', q);
    if (!out) throw new Error('This browser cannot save WebP files.');
  } else if (kind === 'png') {
    const { data } = ctx.getImageData(0, 0, w, h);
    out = await encodeRgbaPng({ width: w, height: h, rgba: new Uint8Array(data.buffer), sourcePng: bytes });
  } else {
    out = transplantJpegMetadata(bytes, await encodeCanvas(canvas, 'image/jpeg', q), { keepIcc });
  }
  return result(out, toWebp ? 'webp' : kind, { note: 'resized', width: w, height: h, origWidth, origHeight });
}

if (typeof self !== 'undefined' && typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = async (event) => {
    const { id } = event.data;
    try {
      const res = await (event.data.op === 'resize' ? resizeImageBuffer : compressImageBuffer)(event.data);
      self.postMessage({ id, ok: true, ...res }, [res.buffer]);
    } catch (err) {
      const message = err && err.message ? err.message : 'Could not compress this image.';
      self.postMessage({ id, ok: false, error: message });
    }
  };
}
