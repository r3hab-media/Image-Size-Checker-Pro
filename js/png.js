import { crc32 } from './crc32.js';

// Pure-JS PNG decode/re-encode so PNG optimization is bit-exact: no canvas premultiplied-alpha
// rounding, no color-space conversion, and 16-bit / low-bit-depth images keep their precision.

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// Ancillary chunks that affect how pixels display, so they must survive optimization.
// Text and timestamp chunks are dropped, as every PNG optimizer does.
const KEEP_CHUNKS = new Set(['iCCP', 'sRGB', 'gAMA', 'cHRM', 'cICP', 'mDCv', 'cLLi', 'pHYs', 'eXIf']);
// Chunks whose contents depend on the color type, so they are only kept when it is unchanged.
const TYPE_BOUND_CHUNKS = new Set(['sBIT', 'bKGD']);

const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2]
];

async function runStream(stream, data) {
  const result = new Response(stream.readable).arrayBuffer();
  const writer = stream.writable.getWriter();
  await writer.write(data);
  await writer.close();
  return new Uint8Array(await result);
}

export const deflate = (data) => runStream(new CompressionStream('deflate'), data);
export const inflate = (data) => runStream(new DecompressionStream('deflate'), data);

export function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function readChunks(bytes) {
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) throw new Error('Not a PNG file.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let pos = 8;
  while (pos + 12 <= bytes.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    if (pos + 12 + length > bytes.length) throw new Error('Truncated PNG chunk.');
    chunks.push({ type, data: bytes.subarray(pos + 8, pos + 8 + length) });
    pos += 12 + length;
    if (type === 'IEND') break;
  }
  return chunks;
}

export function isAnimatedPng(bytes) {
  try {
    return readChunks(bytes).some((c) => c.type === 'acTL');
  } catch (_) {
    return false;
  }
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Reverses PNG scanline filters in place. data holds rows of (1 + rowBytes) bytes; returns packed rows.
function unfilter(data, rowBytes, rows, bpp) {
  const out = new Uint8Array(rowBytes * rows);
  for (let y = 0; y < rows; y++) {
    const filter = data[y * (rowBytes + 1)];
    const src = y * (rowBytes + 1) + 1;
    const dst = y * rowBytes;
    const prev = dst - rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const x = data[src + i];
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const b = y > 0 ? out[prev + i] : 0;
      const c = y > 0 && i >= bpp ? out[prev + i - bpp] : 0;
      let v;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new Error('Invalid PNG filter type.');
      }
      out[dst + i] = v & 0xff;
    }
  }
  return out;
}

function readBits(row, index, bits) {
  if (bits === 8) return row[index];
  const bitPos = index * bits;
  return (row[bitPos >> 3] >> (8 - bits - (bitPos & 7))) & ((1 << bits) - 1);
}

function writeBits(row, index, bits, value) {
  const bitPos = index * bits;
  row[bitPos >> 3] |= value << (8 - bits - (bitPos & 7));
}

// Decodes to packed, non-interlaced, unfiltered scanlines in the image's own color type and bit depth.
export async function decodePng(bytes) {
  const chunks = readChunks(bytes);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('PNG is missing IHDR.');
  const hv = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, 13);
  const width = hv.getUint32(0);
  const height = hv.getUint32(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error('Unsupported PNG color type.');

  const idatParts = chunks.filter((c) => c.type === 'IDAT');
  let idatLen = 0;
  for (const p of idatParts) idatLen += p.data.length;
  const idat = new Uint8Array(idatLen);
  let off = 0;
  for (const p of idatParts) {
    idat.set(p.data, off);
    off += p.data.length;
  }
  const raw = await inflate(idat);

  const pixelBits = channels * bitDepth;
  const bpp = Math.max(1, pixelBits >> 3);
  const rowBytes = Math.ceil((width * pixelBits) / 8);
  let pixels;

  if (!interlace) {
    pixels = unfilter(raw, rowBytes, height, bpp);
  } else {
    pixels = new Uint8Array(rowBytes * height);
    let pos = 0;
    for (const [x0, y0, dx, dy] of ADAM7) {
      const pw = Math.ceil((width - x0) / dx);
      const ph = Math.ceil((height - y0) / dy);
      if (pw <= 0 || ph <= 0) continue;
      const passRowBytes = Math.ceil((pw * pixelBits) / 8);
      const passLen = (passRowBytes + 1) * ph;
      const pass = unfilter(raw.subarray(pos, pos + passLen), passRowBytes, ph, bpp);
      pos += passLen;
      for (let py = 0; py < ph; py++) {
        const srcRow = pass.subarray(py * passRowBytes, (py + 1) * passRowBytes);
        const dstRow = pixels.subarray((y0 + py * dy) * rowBytes, (y0 + py * dy + 1) * rowBytes);
        for (let px = 0; px < pw; px++) {
          const x = x0 + px * dx;
          if (pixelBits >= 8) {
            const n = pixelBits >> 3;
            dstRow.set(srcRow.subarray(px * n, px * n + n), x * n);
          } else {
            writeBits(dstRow, x, pixelBits, readBits(srcRow, px, pixelBits));
          }
        }
      }
    }
  }

  const plte = chunks.find((c) => c.type === 'PLTE');
  const trns = chunks.find((c) => c.type === 'tRNS');
  return {
    width,
    height,
    bitDepth,
    colorType,
    channels,
    rowBytes,
    pixels,
    plte: plte ? plte.data : null,
    trns: trns ? trns.data : null,
    ancillary: chunks.filter((c) => KEEP_CHUNKS.has(c.type) || TYPE_BOUND_CHUNKS.has(c.type))
  };
}

// Picks a filter per row by the minimum-sum-of-absolute-differences heuristic.
function filterAdaptive(pixels, rowBytes, rows, bpp) {
  const out = new Uint8Array((rowBytes + 1) * rows);
  const cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(rowBytes));
  const [c0, c1, c2, c3, c4] = cand;
  const cost = (v) => (v < 128 ? v : 256 - v);
  for (let y = 0; y < rows; y++) {
    const cur = y * rowBytes;
    const prev = cur - rowBytes;
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
    for (let i = 0; i < rowBytes; i++) {
      const x = pixels[cur + i];
      const a = i >= bpp ? pixels[cur + i - bpp] : 0;
      const b = y > 0 ? pixels[prev + i] : 0;
      const c = y > 0 && i >= bpp ? pixels[prev + i - bpp] : 0;
      c0[i] = x;
      s0 += cost(x);
      s1 += cost((c1[i] = (x - a) & 0xff));
      s2 += cost((c2[i] = (x - b) & 0xff));
      s3 += cost((c3[i] = (x - ((a + b) >> 1)) & 0xff));
      s4 += cost((c4[i] = (x - paeth(a, b, c)) & 0xff));
    }
    const sums = [s0, s1, s2, s3, s4];
    let best = 0;
    for (let f = 1; f < 5; f++) if (sums[f] < sums[best]) best = f;
    out[y * (rowBytes + 1)] = best;
    out.set(cand[best], y * (rowBytes + 1) + 1);
  }
  return out;
}

function filterNone(pixels, rowBytes, rows) {
  const out = new Uint8Array((rowBytes + 1) * rows);
  for (let y = 0; y < rows; y++) out.set(pixels.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
  return out;
}

function assemble(parts) {
  let total = 8;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  out.set(SIGNATURE, 0);
  let pos = 8;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

// Encodes packed scanlines; tries adaptive and no-filter and keeps the smaller (low-bit/indexed images
// usually compress best unfiltered).
export async function encodePng({ width, height, bitDepth, colorType, pixels, plte, trns, ancillary = [] }) {
  const channels = CHANNELS[colorType];
  const pixelBits = channels * bitDepth;
  const bpp = Math.max(1, pixelBits >> 3);
  const rowBytes = Math.ceil((width * pixelBits) / 8);

  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header[8] = bitDepth;
  header[9] = colorType;

  const head = [chunk('IHDR', header)];
  for (const c of ancillary) if (c.type !== 'eXIf') head.push(chunk(c.type, c.data));
  if (plte) head.push(chunk('PLTE', plte));
  if (trns && trns.length) head.push(chunk('tRNS', trns));
  const tail = [];
  for (const c of ancillary) if (c.type === 'eXIf') tail.push(chunk(c.type, c.data));
  tail.push(chunk('IEND', new Uint8Array(0)));

  const streams = [filterAdaptive(pixels, rowBytes, height, bpp)];
  if (colorType === 3 || bitDepth < 8) streams.push(filterNone(pixels, rowBytes, height));
  let best = null;
  for (const s of streams) {
    const z = await deflate(s);
    if (!best || z.length < best.length) best = z;
  }
  return assemble([...head, chunk('IDAT', best), ...tail]);
}

// Expands any 8-bit-or-palette image to RGBA8 so it can be re-packed into its smallest exact form.
function toRgba8(img) {
  const { width, height, bitDepth, colorType, channels, rowBytes, pixels, plte, trns } = img;
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  const pixelBits = channels * bitDepth;
  const grayKey = colorType === 0 && trns && trns.length >= 2 ? (trns[0] << 8) | trns[1] : -1;
  const rgbKey =
    colorType === 2 && trns && trns.length >= 6 ? [(trns[0] << 8) | trns[1], (trns[2] << 8) | trns[3], (trns[4] << 8) | trns[5]] : null;

  for (let y = 0, p = 0; y < height; y++) {
    const row = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);
    for (let x = 0; x < width; x++, p += 4) {
      if (colorType === 3) {
        const idx = readBits(row, x, pixelBits);
        rgba[p] = plte[idx * 3] ?? 0;
        rgba[p + 1] = plte[idx * 3 + 1] ?? 0;
        rgba[p + 2] = plte[idx * 3 + 2] ?? 0;
        rgba[p + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (colorType === 0) {
        const v = row[x];
        rgba[p] = rgba[p + 1] = rgba[p + 2] = v;
        rgba[p + 3] = v === grayKey ? 0 : 255;
      } else if (colorType === 4) {
        rgba[p] = rgba[p + 1] = rgba[p + 2] = row[x * 2];
        rgba[p + 3] = row[x * 2 + 1];
      } else if (colorType === 2) {
        const r = row[x * 3];
        const g = row[x * 3 + 1];
        const b = row[x * 3 + 2];
        rgba[p] = r;
        rgba[p + 1] = g;
        rgba[p + 2] = b;
        rgba[p + 3] = rgbKey && r === rgbKey[0] && g === rgbKey[1] && b === rgbKey[2] ? 0 : 255;
      } else {
        rgba.set(row.subarray(x * 4, x * 4 + 4), p);
      }
    }
  }
  return rgba;
}

// Builds an exact palette, or null when the image needs more than 256 colors.
// Translucent entries go first so the tRNS chunk can stay short.
function exactPalette(rgba) {
  const counts = new Map();
  for (let i = 0; i < rgba.length; i += 4) {
    const key = ((rgba[i] << 24) | (rgba[i + 1] << 16) | (rgba[i + 2] << 8) | rgba[i + 3]) >>> 0;
    if (!counts.has(key)) {
      if (counts.size === 256) return null;
      counts.set(key, true);
    }
  }
  const keys = [...counts.keys()].sort((a, b) => ((a & 0xff) === 255) - ((b & 0xff) === 255));
  const index = new Map(keys.map((k, i) => [k, i]));
  return { keys, index };
}

function packIndexed(rgba, width, height, pal) {
  const count = pal.keys.length;
  const bitDepth = count <= 2 ? 1 : count <= 4 ? 2 : count <= 16 ? 4 : 8;
  const rowBytes = Math.ceil((width * bitDepth) / 8);
  const pixels = new Uint8Array(rowBytes * height);
  for (let y = 0, p = 0; y < height; y++) {
    const row = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);
    for (let x = 0; x < width; x++, p += 4) {
      const key = ((rgba[p] << 24) | (rgba[p + 1] << 16) | (rgba[p + 2] << 8) | rgba[p + 3]) >>> 0;
      writeBits(row, x, bitDepth, pal.index.get(key));
    }
  }
  const plte = new Uint8Array(count * 3);
  let lastAlpha = -1;
  const alpha = new Uint8Array(count);
  pal.keys.forEach((k, i) => {
    plte[i * 3] = k >>> 24;
    plte[i * 3 + 1] = (k >>> 16) & 0xff;
    plte[i * 3 + 2] = (k >>> 8) & 0xff;
    alpha[i] = k & 0xff;
    if (alpha[i] !== 255) lastAlpha = i;
  });
  return { bitDepth, colorType: 3, pixels, plte, trns: lastAlpha >= 0 ? alpha.subarray(0, lastAlpha + 1) : null };
}

function packTruecolor(rgba, width, height) {
  let opaque = true;
  let gray = true;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] !== 255) opaque = false;
    if (rgba[i] !== rgba[i + 1] || rgba[i] !== rgba[i + 2]) gray = false;
    if (!opaque && !gray) break;
  }
  const channels = (gray ? 1 : 3) + (opaque ? 0 : 1);
  const colorType = gray ? (opaque ? 0 : 4) : opaque ? 2 : 6;
  const pixels = new Uint8Array(width * height * channels);
  for (let i = 0, o = 0; i < rgba.length; i += 4) {
    pixels[o++] = rgba[i];
    if (!gray) {
      pixels[o++] = rgba[i + 1];
      pixels[o++] = rgba[i + 2];
    }
    if (!opaque) pixels[o++] = rgba[i + 3];
  }
  return { bitDepth: 8, colorType, pixels, plte: null, trns: null };
}

// 16-bit samples whose high and low bytes match (e.g. 0x7f7f) are exactly representable in 8 bits.
function reduce16To8(img) {
  const { pixels } = img;
  for (let i = 0; i < pixels.length; i += 2) if (pixels[i] !== pixels[i + 1]) return null;
  const out = new Uint8Array(pixels.length / 2);
  for (let i = 0, o = 0; i < pixels.length; i += 2) out[o++] = pixels[i];
  let trns = img.trns;
  if (trns && trns.length >= 2) {
    // Transparent-key colors must also reduce exactly or the reduction is not lossless.
    const reduced = new Uint8Array(trns.length);
    for (let i = 0; i < trns.length; i += 2) {
      if (trns[i] !== trns[i + 1]) return null;
      reduced[i + 1] = trns[i];
    }
    trns = reduced;
  }
  return { ...img, bitDepth: 8, rowBytes: img.rowBytes / 2, pixels: out, trns };
}

// Returns the smallest bit-exact re-encoding of the PNG (or null if decoding fails).
export async function optimizePngLossless(bytes) {
  let img = await decodePng(bytes);
  const typeFree = img.ancillary.filter((c) => KEEP_CHUNKS.has(c.type));
  const candidates = [];

  // Same color type and depth, refiltered and de-interlaced.
  candidates.push(await encodePng({ ...img, ancillary: img.ancillary }));

  if (img.bitDepth === 16) {
    const reduced = reduce16To8(img);
    if (reduced) img = reduced;
    else return pickSmallest(candidates);
  }

  if (img.bitDepth === 8 || img.colorType === 3) {
    const rgba = toRgba8(img);
    const pal = exactPalette(rgba);
    if (pal) {
      candidates.push(await encodePng({ width: img.width, height: img.height, ...packIndexed(rgba, img.width, img.height, pal), ancillary: typeFree }));
    }
    candidates.push(await encodePng({ width: img.width, height: img.height, ...packTruecolor(rgba, img.width, img.height), ancillary: typeFree }));
  }
  return pickSmallest(candidates);
}

function pickSmallest(list) {
  return list.reduce((a, b) => (b.length < a.length ? b : a));
}

// Encodes fresh RGBA pixels (e.g. a resized image) in their smallest exact PNG form, keeping the
// source's color chunks. eXIf is dropped: the pixels were already rotated when they were decoded.
export async function encodeRgbaPng({ width, height, rgba, sourcePng }) {
  const ancillary = sourcePng ? readChunks(sourcePng).filter((c) => KEEP_CHUNKS.has(c.type) && c.type !== 'eXIf') : [];
  const candidates = [await encodePng({ width, height, ...packTruecolor(rgba, width, height), ancillary })];
  const pal = exactPalette(rgba);
  if (pal) candidates.push(await encodePng({ width, height, ...packIndexed(rgba, width, height, pal), ancillary }));
  return pickSmallest(candidates);
}

// Lossy option: quantizes to a 256-color palette (with dithering) and keeps the result only if it
// stays visually close to the source. Returns { bytes, colors, psnr } or { rejected, psnr } or null
// (when the image already fits a palette, so the lossless path is already optimal).
export async function optimizePngLossy(bytes, { minPsnr }) {
  const { quantize, psnr } = await import('./quantize.js');
  let img = await decodePng(bytes);
  if (img.bitDepth === 16) img = reduce16To8(img) || take16HighBytes(img);
  if (img.bitDepth !== 8 && img.colorType !== 3) return null;
  const rgba = toRgba8(img);
  if (exactPalette(rgba)) return null;

  const { palette, indices } = quantize(rgba, img.width, img.height);
  const approx = new Uint8Array(rgba.length);
  for (let p = 0; p < indices.length; p++) approx.set(palette.subarray(indices[p] * 4, indices[p] * 4 + 4), p * 4);
  const score = psnr(rgba, approx);
  if (score < minPsnr) return { rejected: true, psnr: score };

  // Same pixels the quantizer chose, re-packed through the exact-palette path (minimal bit depth,
  // translucent entries first for a short tRNS).
  const pal = exactPalette(approx);
  const ancillary = img.ancillary.filter((c) => KEEP_CHUNKS.has(c.type));
  const out = await encodePng({ width: img.width, height: img.height, ...packIndexed(approx, img.width, img.height, pal), ancillary });
  return { bytes: out, colors: pal.keys.length, psnr: score };
}

// Lossy-mode fallback for 16-bit images whose low bytes carry real precision.
function take16HighBytes(img) {
  const out = new Uint8Array(img.pixels.length / 2);
  for (let i = 0, o = 0; i < img.pixels.length; i += 2) out[o++] = img.pixels[i];
  let trns = null;
  if (img.trns && img.trns.length >= 2) {
    trns = new Uint8Array(img.trns.length);
    for (let i = 0; i < img.trns.length; i += 2) trns[i + 1] = img.trns[i];
  }
  return { ...img, bitDepth: 8, rowBytes: img.rowBytes / 2, pixels: out, trns };
}
