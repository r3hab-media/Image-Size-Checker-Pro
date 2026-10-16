// Palette quantization for lossy PNG: reduces RGBA pixels to at most `maxColors` colors.
// Weighted median cut over a 5-bit-per-channel histogram, refined with k-means, then mapped with
// alpha-aware Floyd-Steinberg dithering. Written here (not libimagequant) to stay license-free.

const RGB_BITS = 5;
const A_BITS = 4;
const BINS = 1 << (RGB_BITS * 3 + A_BITS);

const binOf = (r, g, b, a) => ((r >> 3) << 14) | ((g >> 3) << 9) | ((b >> 3) << 4) | (a >> 4);

// Distance that ignores color differences the eye cannot see through transparency.
function distance(r1, g1, b1, a1, r2, g2, b2, a2) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  const da = a1 - a2;
  const weight = Math.max(a1, a2) / 255;
  return (dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11) * weight * 3 + da * da * 3;
}

// Pixels are quantized in three classes that never mix, so solid areas stay solid, transparent
// areas stay transparent, and soft edges stay soft: 0 = transparent, 1 = translucent, 2 = opaque.
const classOf = (a) => (a === 0 ? 0 : a === 255 ? 2 : 1);

function buildHistogram(rgba, cls) {
  const count = new Uint32Array(BINS);
  const sum = new Float64Array(BINS * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    if (classOf(a) !== cls) continue;
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    const bin = binOf(r, g, b, a);
    count[bin]++;
    sum[bin * 4] += r;
    sum[bin * 4 + 1] += g;
    sum[bin * 4 + 2] += b;
    sum[bin * 4 + 3] += a;
  }
  const bins = [];
  for (let k = 0; k < BINS; k++) {
    if (!count[k]) continue;
    const n = count[k];
    bins.push({ n, c: [sum[k * 4] / n, sum[k * 4 + 1] / n, sum[k * 4 + 2] / n, sum[k * 4 + 3] / n] });
  }
  return bins;
}

function boxStats(bins) {
  const min = [255, 255, 255, 255];
  const max = [0, 0, 0, 0];
  let n = 0;
  for (const bin of bins) {
    n += bin.n;
    for (let ch = 0; ch < 4; ch++) {
      if (bin.c[ch] < min[ch]) min[ch] = bin.c[ch];
      if (bin.c[ch] > max[ch]) max[ch] = bin.c[ch];
    }
  }
  return { min, max, n };
}

// Splits the box with the largest weighted spread at its weighted median, until maxColors boxes.
function medianCut(bins, maxColors) {
  let boxes = [{ bins, ...boxStats(bins) }];
  while (boxes.length < maxColors) {
    let best = -1;
    let bestScore = 0;
    let bestCh = 0;
    boxes.forEach((box, i) => {
      if (box.bins.length < 2) return;
      for (let ch = 0; ch < 4; ch++) {
        const score = (box.max[ch] - box.min[ch]) * Math.sqrt(box.n);
        if (score > bestScore) {
          bestScore = score;
          best = i;
          bestCh = ch;
        }
      }
    });
    if (best < 0) break;
    const box = boxes[best];
    const sorted = box.bins.slice().sort((x, y) => x.c[bestCh] - y.c[bestCh]);
    let acc = 0;
    let cut = 1;
    for (; cut < sorted.length - 1; cut++) {
      acc += sorted[cut - 1].n;
      if (acc >= box.n / 2) break;
    }
    const left = sorted.slice(0, cut);
    const right = sorted.slice(cut);
    boxes.splice(best, 1, { bins: left, ...boxStats(left) }, { bins: right, ...boxStats(right) });
  }
  return boxes.map((box) => {
    const c = [0, 0, 0, 0];
    for (const bin of box.bins) for (let ch = 0; ch < 4; ch++) c[ch] += bin.c[ch] * bin.n;
    return c.map((v) => v / box.n);
  });
}

function nearest(palette, r, g, b, a, from = 0, to = palette.length) {
  let best = from;
  let bestD = Infinity;
  for (let p = from; p < to; p++) {
    const c = palette[p];
    const d = distance(r, g, b, a, c[0], c[1], c[2], c[3]);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

// Moves each palette color to the weighted mean of the histogram bins closest to it.
function refine(palette, bins, iterations) {
  for (let it = 0; it < iterations; it++) {
    const sums = palette.map(() => [0, 0, 0, 0, 0]);
    for (const bin of bins) {
      const p = nearest(palette, bin.c[0], bin.c[1], bin.c[2], bin.c[3]);
      const s = sums[p];
      for (let ch = 0; ch < 4; ch++) s[ch] += bin.c[ch] * bin.n;
      s[4] += bin.n;
    }
    palette = palette.map((c, p) => (sums[p][4] ? sums[p].slice(0, 4).map((v) => v / sums[p][4]) : c));
  }
  return palette;
}

// Splits the color budget between classes: one entry for transparency, translucent edges get their
// share of pixels but at least 16 colors (they are few but visible), opaque pixels get the rest.
function budgets(counts, maxColors) {
  let left = maxColors - (counts[0] ? 1 : 0);
  if (!counts[1]) return [counts[0] ? 1 : 0, 0, left];
  if (!counts[2]) return [counts[0] ? 1 : 0, left, 0];
  const share = Math.round((left * counts[1]) / (counts[1] + counts[2]));
  const translucent = Math.min(left - 1, Math.max(16, share));
  return [counts[0] ? 1 : 0, translucent, left - translucent];
}

// Returns { palette: Uint8Array(n*4), indices: Uint8Array(w*h) } with dithering applied.
export function quantize(rgba, width, height, { maxColors = 256, dither = true } = {}) {
  const counts = [0, 0, 0];
  for (let i = 3; i < rgba.length; i += 4) counts[classOf(rgba[i])]++;
  const share = budgets(counts, maxColors);

  const palette = [];
  const range = [];
  for (let cls = 0; cls < 3; cls++) {
    const start = palette.length;
    if (cls === 0 && share[0]) palette.push([0, 0, 0, 0]);
    if (cls > 0 && share[cls]) {
      const bins = buildHistogram(rgba, cls);
      const colors = refine(medianCut(bins, share[cls]), bins, 3);
      for (const c of colors) {
        const rgbaColor = c.map((v) => Math.max(0, Math.min(255, Math.round(v))));
        rgbaColor[3] = cls === 2 ? 255 : Math.max(1, Math.min(254, rgbaColor[3]));
        palette.push(rgbaColor);
      }
    }
    range[cls] = [start, palette.length];
  }

  const indices = new Uint8Array(width * height);
  const cache = new Map();
  const lookup = (r, g, b, a, cls) => {
    const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
    let p = cache.get(key);
    if (p === undefined) {
      p = nearest(palette, r, g, b, a, range[cls][0], range[cls][1]);
      cache.set(key, p);
    }
    return p;
  };

  // Error diffusion rows (current and next), 4 channels each.
  let errCur = new Float32Array((width + 2) * 4);
  let errNext = new Float32Array((width + 2) * 4);
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  for (let y = 0; y < height; y++) {
    errNext.fill(0);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const e = (x + 1) * 4;
      const srcA = rgba[i + 3];
      const cls = classOf(srcA);
      // Alpha is only dithered within translucent pixels, and never pushed out of that class.
      const fixedAlpha = cls !== 1;
      const r = clamp(rgba[i] + (dither ? errCur[e] : 0));
      const g = clamp(rgba[i + 1] + (dither ? errCur[e + 1] : 0));
      const b = clamp(rgba[i + 2] + (dither ? errCur[e + 2] : 0));
      const a = fixedAlpha ? srcA : Math.max(1, Math.min(254, clamp(srcA + (dither ? errCur[e + 3] : 0))));
      const p = cls === 0 ? range[0][0] : lookup(r, g, b, a, cls);
      indices[y * width + x] = p;
      if (!dither || srcA === 0) continue;
      const c = palette[p];
      const err = [r - c[0], g - c[1], b - c[2], fixedAlpha ? 0 : a - c[3]];
      for (let ch = 0; ch < 4; ch++) {
        const v = err[ch];
        if (!v) continue;
        errCur[e + 4 + ch] += (v * 7) / 16;
        errNext[e - 4 + ch] += (v * 3) / 16;
        errNext[e + ch] += (v * 5) / 16;
        errNext[e + 4 + ch] += v / 16;
      }
    }
    [errCur, errNext] = [errNext, errCur];
  }

  const flat = new Uint8Array(palette.length * 4);
  palette.forEach((c, p) => flat.set(c, p * 4));
  return { palette: flat, indices };
}

// Peak signal-to-noise ratio (dB) between two RGBA buffers, with color weighted by alpha so that
// differences hidden by transparency do not count. Higher is closer; 40+ is visually near-identical.
export function psnr(a, b) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    const w = Math.max(a[i + 3], b[i + 3]) / 255;
    for (let ch = 0; ch < 3; ch++) {
      const d = (a[i + ch] - b[i + ch]) * w;
      sum += d * d;
    }
    const da = a[i + 3] - b[i + 3];
    sum += da * da;
    n += 4;
  }
  const mse = sum / n;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}
