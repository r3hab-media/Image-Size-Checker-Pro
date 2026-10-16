// Browser-side fixture builders and pixel comparators used by the tests.
import { decodePng, deflate, chunk, readChunks } from '/js/png.js';

export async function canvasBytes(w, h, draw, mime, quality) {
  const c = new OffscreenCanvas(w, h);
  draw(c.getContext('2d'), w, h);
  const blob = await c.convertToBlob({ type: mime, quality });
  return new Uint8Array(await blob.arrayBuffer());
}

export const canvasPng = (w, h, draw) => canvasBytes(w, h, draw, 'image/png');

export function noisyTranslucent(ctx, w, h) {
  const img = ctx.createImageData(w, h);
  let seed = 7;
  for (let i = 0; i < img.data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    img.data[i] = seed >> 16;
  }
  ctx.putImageData(img, 0, 0);
}

// UI-style graphic: flat colors with antialiased edges and text (thousands of colors, few real ones).
export function antialiasedGraphic(ctx, w, h) {
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, w, h);
  const colors = ['#0ea5e9', '#f97316', '#10b981', '#6366f1', '#ef4444', '#0f172a'];
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = colors[i % colors.length];
    ctx.beginPath();
    ctx.arc((i * 97) % w, (i * 61) % h, 8 + (i % 5) * 6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 28px sans-serif';
  ctx.fillText('Lossy PNG test 123', 20, h / 2);
  ctx.strokeStyle = '#6366f1';
  ctx.lineWidth = 3;
  ctx.strokeRect(10.5, 10.5, w - 21, h - 21);
}

export function opaqueNoise(ctx, w, h) {
  const img = ctx.createImageData(w, h);
  let seed = 3;
  for (let i = 0; i < img.data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    img.data[i] = i % 4 === 3 ? 255 : seed >> 16;
  }
  ctx.putImageData(img, 0, 0);
}

// Antialiased shapes on a transparent background, like a logo with soft edges.
export function transparentLogo(ctx, w, h) {
  ctx.clearRect(0, 0, w, h);
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#7c3aed');
  g.addColorStop(1, '#2563eb');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, w / 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#facc15';
  ctx.font = 'bold 60px sans-serif';
  ctx.fillText('ISC', w / 4, h / 2 + 20);
}

export async function decodeRgba(bytes) {
  const img = await decodePng(bytes);
  if (img.bitDepth !== 8 && img.colorType !== 3) throw new Error('decodeRgba expects 8-bit or palette PNGs');
  const c = await canonical(bytes);
  return Uint8Array.from(c.data, (v) => v >> 8);
}

export async function psnrBetween(a, b) {
  const { psnr } = await import('/js/quantize.js');
  return psnr(await decodeRgba(a), await decodeRgba(b));
}

export function photoLike(ctx, w, h) {
  const g = ctx.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, Math.max(w, h));
  g.addColorStop(0, '#0f766e');
  g.addColorStop(0.5, '#0284c7');
  g.addColorStop(1, '#1e1b4b');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 600; i++) {
    ctx.fillStyle = `rgba(${(i * 47) % 255}, ${(i * 93) % 255}, ${(i * 151) % 255}, 0.3)`;
    ctx.beginPath();
    ctx.arc((i * 137) % w, (i * 89) % h, 6 + (i % 28), 0, Math.PI * 2);
    ctx.fill();
  }
}

function assemble(parts) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const total = parts.reduce((n, p) => n + p.length, 8);
  const out = new Uint8Array(total);
  out.set(sig);
  let pos = 8;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

function ihdr(w, h, bitDepth, colorType, interlace = 0) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  d[8] = bitDepth;
  d[9] = colorType;
  d[12] = interlace;
  return chunk('IHDR', d);
}

// Uncompressed (stored-deflate) RGBA PNG with 8 colors, like the playground's heavy PNG.
export async function storedPng(w, h) {
  const stride = w * 4 + 1;
  const raw = new Uint8Array(stride * h);
  const palette = [[15, 23, 42], [30, 41, 59], [56, 189, 248], [16, 185, 129], [248, 250, 252], [99, 102, 241], [245, 158, 11], [239, 68, 68]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = palette[(Math.floor(x / 24) + Math.floor(y / 24)) % 8];
      raw.set([...c, 255], y * stride + 1 + x * 4);
    }
  }
  const blocks = [];
  for (let i = 0; i < raw.length; i += 65535) {
    const part = raw.subarray(i, i + 65535);
    const last = i + 65535 >= raw.length ? 1 : 0;
    blocks.push(new Uint8Array([last, part.length & 0xff, part.length >> 8, ~part.length & 0xff, (~part.length >> 8) & 0xff]), part);
  }
  let s1 = 1, s2 = 0;
  for (const b of raw) {
    s1 = (s1 + b) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  const adler = ((s2 << 16) | s1) >>> 0;
  const z = assembleRaw([new Uint8Array([0x78, 0x01]), ...blocks, new Uint8Array([adler >>> 24, (adler >> 16) & 0xff, (adler >> 8) & 0xff, adler & 0xff])]);
  return assemble([ihdr(w, h, 8, 6), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))]);
}

function assembleRaw(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

// Adam7-interlaced opaque RGB PNG with noise, built pass by pass with filter type 0.
export async function interlacedPng(w, h) {
  const px = (x, y) => [(x * 37 + y * 11) & 0xff, (x * 5 + y * 101) & 0xff, (x * y + 3) & 0xff];
  const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  const rows = [];
  for (const [x0, y0, dx, dy] of passes) {
    for (let y = y0; y < h; y += dy) {
      const row = [0];
      for (let x = x0; x < w; x += dx) row.push(...px(x, y));
      if (row.length > 1) rows.push(...row);
    }
  }
  const z = await deflate(new Uint8Array(rows));
  return assemble([ihdr(w, h, 8, 2, 1), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))]);
}

export function insertPngChunks(png, list) {
  const chunks = readChunks(png);
  const parts = [];
  for (const c of chunks) {
    parts.push(chunk(c.type, c.data));
    if (c.type === 'IHDR') for (const [t, d] of list) parts.push(chunk(t, d));
  }
  return assemble(parts);
}

// Normalizes any PNG to 16-bit RGBA samples so two encodings can be compared exactly.
async function canonical(bytes) {
  const img = await decodePng(bytes);
  const { width, height, bitDepth, colorType, channels, rowBytes, pixels, plte, trns } = img;
  const max = (1 << bitDepth) - 1;
  const sample = (row, i) => {
    if (bitDepth === 16) return (row[i * 2] << 8) | row[i * 2 + 1];
    if (bitDepth === 8) return row[i];
    const bit = i * bitDepth;
    return (row[bit >> 3] >> (8 - bitDepth - (bit & 7))) & max;
  };
  const scale = (v) => Math.round((v * 65535) / max);
  const key = trns && colorType !== 3 ? Array.from({ length: trns.length / 2 }, (_, i) => (trns[i * 2] << 8) | trns[i * 2 + 1]) : null;
  const out = new Uint16Array(width * height * 4);
  for (let y = 0, p = 0; y < height; y++) {
    const row = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);
    for (let x = 0; x < width; x++, p += 4) {
      const s = Array.from({ length: channels }, (_, c) => sample(row, x * channels + c));
      let r, g, b, a = 65535;
      if (colorType === 3) {
        const i = s[0];
        [r, g, b] = [plte[i * 3] * 257, plte[i * 3 + 1] * 257, plte[i * 3 + 2] * 257];
        if (trns && i < trns.length) a = trns[i] * 257;
      } else if (colorType === 0 || colorType === 4) {
        r = g = b = scale(s[0]);
        if (colorType === 4) a = scale(s[1]);
        else if (key && s[0] === key[0]) a = 0;
      } else {
        [r, g, b] = [scale(s[0]), scale(s[1]), scale(s[2])];
        if (colorType === 6) a = scale(s[3]);
        else if (key && s[0] === key[0] && s[1] === key[1] && s[2] === key[2]) a = 0;
      }
      out.set([r, g, b, a], p);
    }
  }
  return { width, height, data: out };
}

export async function assertSamePixels(a, b) {
  const [ca, cb] = await Promise.all([canonical(a), canonical(b)]);
  if (ca.width !== cb.width || ca.height !== cb.height) throw new Error(`size ${ca.width}x${ca.height} vs ${cb.width}x${cb.height}`);
  for (let i = 0; i < ca.data.length; i++) {
    if (ca.data[i] !== cb.data[i]) throw new Error(`pixel mismatch at sample ${i}: ${ca.data[i]} vs ${cb.data[i]}`);
  }
}

async function browserPixels(bytes, type) {
  const bmp = await createImageBitmap(new Blob([bytes], { type }));
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height).data;
}

export async function assertBrowserPixelsEqual(a, b, type = 'image/png') {
  const [pa, pb] = await Promise.all([browserPixels(a, type), browserPixels(b, type)]);
  if (pa.length !== pb.length) throw new Error('browser size mismatch');
  for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) throw new Error(`browser pixel mismatch at ${i}`);
}

// Checks our PNG decoder against Chrome's for an opaque image (alpha 255, so no premultiply rounding).
export async function assertDecoderMatchesBrowser(bytes) {
  const [ours, theirs] = await Promise.all([canonical(bytes), browserPixels(bytes, 'image/png')]);
  for (let i = 0; i < theirs.length; i++) {
    if (ours.data[i] >> 8 !== theirs[i]) throw new Error(`decoder mismatch at sample ${i}: ${ours.data[i] >> 8} vs ${theirs[i]}`);
  }
}

export function filtersUsed(bytes) {
  return decodeFilters(bytes);
}

async function decodeFilters(bytes) {
  const { inflate } = await import('/js/png.js');
  const chunks = readChunks(bytes);
  const head = chunks.find((c) => c.type === 'IHDR').data;
  const v = new DataView(head.buffer, head.byteOffset);
  const w = v.getUint32(0), h = v.getUint32(4);
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[head[9]];
  const rowBytes = Math.ceil((w * ch * head[8]) / 8);
  const raw = await inflate(assembleRaw(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const used = new Set();
  for (let y = 0; y < h; y++) used.add(raw[y * (rowBytes + 1)]);
  return [...used].sort();
}

export async function browserSize(bytes, type) {
  const bmp = await createImageBitmap(new Blob([bytes], { type }));
  return { width: bmp.width, height: bmp.height };
}

export function makeBmp(w, h) {
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const size = 54 + rowSize * h;
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  b[0] = 0x42;
  b[1] = 0x4d;
  v.setUint32(2, size, true);
  v.setUint32(10, 54, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, w, true);
  v.setInt32(22, h, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, 24, true);
  return b;
}

export function ftyp(brand) {
  const b = new Uint8Array(32);
  new DataView(b.buffer).setUint32(0, 24);
  b.set(new TextEncoder().encode('ftyp' + brand + '\0\0\0\0' + brand + 'mif1'), 4);
  return b;
}

export function fakeLosslessWebp() {
  const b = new Uint8Array(40);
  const v = new DataView(b.buffer);
  b.set(new TextEncoder().encode('RIFF'), 0);
  v.setUint32(4, 32, true);
  b.set(new TextEncoder().encode('WEBPVP8L'), 8);
  v.setUint32(16, 20, true);
  return b;
}

function segment(marker, payload) {
  const s = new Uint8Array(4 + payload.length);
  s[0] = 0xff;
  s[1] = marker;
  s[2] = (payload.length + 2) >> 8;
  s[3] = (payload.length + 2) & 0xff;
  s.set(payload, 4);
  return s;
}

// Inserts an EXIF APP1 (with an Orientation tag) and an RGB ICC APP2 right after SOI.
export function jpegWithMetadata(jpeg, { orientation }) {
  const exif = new Uint8Array(6 + 8 + 2 + 12 + 4);
  exif.set(new TextEncoder().encode('Exif\0\0'), 0);
  const t = new DataView(exif.buffer, 6);
  exif.set([0x4d, 0x4d, 0, 42], 6);
  t.setUint32(4, 8);
  t.setUint16(8, 1);
  t.setUint16(10, 0x0112);
  t.setUint16(12, 3);
  t.setUint32(14, 1);
  t.setUint16(18, orientation);
  const profile = new Uint8Array(128);
  new DataView(profile.buffer).setUint32(0, 128);
  profile.set(new TextEncoder().encode('mntrRGB XYZ '), 12);
  profile.set(new TextEncoder().encode('acsp'), 36);
  const icc = new Uint8Array(14 + profile.length);
  icc.set(new TextEncoder().encode('ICC_PROFILE\0'), 0);
  icc[12] = 1;
  icc[13] = 1;
  icc.set(profile, 14);
  const segs = [segment(0xe1, exif), segment(0xe2, icc)];
  return assembleRaw([jpeg.subarray(0, 2), ...segs, jpeg.subarray(2)]);
}

export function readOrientation(jpeg) {
  let pos = 2;
  while (pos < jpeg.length && jpeg[pos] === 0xff) {
    const marker = jpeg[pos + 1];
    const len = (jpeg[pos + 2] << 8) | jpeg[pos + 3];
    if (marker === 0xe1 && String.fromCharCode(...jpeg.subarray(pos + 4, pos + 8)) === 'Exif') {
      const tiff = pos + 10;
      const le = jpeg[tiff] === 0x49;
      const v = new DataView(jpeg.buffer, jpeg.byteOffset);
      const ifd = tiff + v.getUint32(tiff + 4, le);
      const n = v.getUint16(ifd, le);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (v.getUint16(e, le) === 0x0112) return v.getUint16(e + 8, le);
      }
    }
    if (marker === 0xda) break;
    pos += 2 + len;
  }
  return null;
}
