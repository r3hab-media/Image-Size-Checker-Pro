// Compression engine tests: run js/worker.js in a real Chrome page and check format preservation,
// bit-exact PNG output, metadata handling and the never-grow guarantee.

let page;
async function getPage({ browser, origin }) {
  if (!page) {
    page = await browser.newPage();
    await page.goto(`${origin}/tests/blank.html`);
    await page.evaluate(async () => {
      window.engine = await import('/js/worker.js');
      window.png = await import('/js/png.js');
      window.h = await import('/tests/helpers.js');
    });
  }
  return page;
}

const run = async (ctx, fn, ...args) => (await getPage(ctx)).evaluate(fn, ...args);

export const tests = {
  'noisy RGBA PNG with translucency is optimized bit-exactly and stays PNG': (ctx) =>
    run(ctx, async () => {
      const src = await h.canvasPng(300, 200, h.noisyTranslucent);
      const res = await engine.compressImageBuffer({ buffer: src.buffer.slice(0) });
      const out = new Uint8Array(res.buffer);
      if (engine.sniff(out) !== 'png') throw new Error('not png');
      await h.assertSamePixels(src, out);
    }),

  'PNG decoder matches Chrome on images using every filter type': (ctx) =>
    run(ctx, async () => {
      const used = new Set();
      const fixtures = [await h.storedPng(90, 60)];
      for (const [w, hh] of [[640, 400], [301, 157], [64, 64]]) fixtures.push(await h.canvasPng(w, hh, h.photoLike));
      for (const src of fixtures) {
        (await h.filtersUsed(src)).forEach((f) => used.add(f));
        await h.assertDecoderMatchesBrowser(src);
        const res = await engine.compressImageBuffer({ buffer: src.buffer.slice(0) });
        const out = new Uint8Array(res.buffer);
        (await h.filtersUsed(out)).forEach((f) => used.add(f));
        await h.assertBrowserPixelsEqual(src, out);
      }
      for (const f of [0, 1, 2, 3, 4]) if (!used.has(f)) throw new Error(`fixtures never exercised filter ${f}: ${[...used]}`);
    }),

  'store-mode PNG shrinks dramatically and is bit-exact (indexed)': (ctx) =>
    run(ctx, async () => {
      const src = await h.storedPng(360, 240);
      const res = await engine.compressImageBuffer({ buffer: src.buffer.slice(0) });
      const out = new Uint8Array(res.buffer);
      if (!(out.length < src.length / 10)) throw new Error(`expected >90% saving, got ${src.length} -> ${out.length}`);
      const dec = await png.decodePng(out);
      if (dec.colorType !== 3) throw new Error('expected indexed output, got type ' + dec.colorType);
      await h.assertSamePixels(src, out);
      // Cross-check against Chrome's own decoder for this opaque image.
      await h.assertBrowserPixelsEqual(src, out);
    }),

  '16-bit PNG keeps 16-bit precision': (ctx) =>
    run(ctx, async () => {
      const w = 64, hgt = 40;
      const pixels = new Uint8Array(w * hgt * 6);
      for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 7919) & 0xff;
      const src = await png.encodePng({ width: w, height: hgt, bitDepth: 16, colorType: 2, pixels });
      const res = await engine.compressImageBuffer({ buffer: src.buffer.slice(0) });
      const out = new Uint8Array(res.buffer);
      const dec = await png.decodePng(out);
      if (dec.bitDepth !== 16) throw new Error('lost 16-bit depth');
      await h.assertSamePixels(src, out);
    }),

  '16-bit PNG with redundant low bytes reduces to 8-bit exactly': (ctx) =>
    run(ctx, async () => {
      const w = 50, hgt = 30;
      const pixels = new Uint8Array(w * hgt * 8);
      for (let i = 0; i < pixels.length; i += 2) pixels[i] = pixels[i + 1] = (i * 31) & 0xff;
      const src = await png.encodePng({ width: w, height: hgt, bitDepth: 16, colorType: 6, pixels });
      const res = await engine.compressImageBuffer({ buffer: src.buffer.slice(0) });
      const out = new Uint8Array(res.buffer);
      if ((await png.decodePng(out)).bitDepth === 16) throw new Error('expected reduction to 8-bit');
      await h.assertSamePixels(src, out);
    }),

  'interlaced PNG decodes correctly and is de-interlaced losslessly': (ctx) =>
    run(ctx, async () => {
      const src = await h.interlacedPng(37, 23);
      const res = await engine.compressImageBuffer({ buffer: src.buffer.slice(0) });
      const out = new Uint8Array(res.buffer);
      await h.assertSamePixels(src, out);
      await h.assertBrowserPixelsEqual(src, out);
    }),

  'low bit-depth grayscale PNG round-trips': (ctx) =>
    run(ctx, async () => {
      const w = 33, hgt = 9;
      const rowBytes = Math.ceil((w * 2) / 8);
      const pixels = new Uint8Array(rowBytes * hgt);
      for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 37) & 0xff;
      const src = await png.encodePng({ width: w, height: hgt, bitDepth: 2, colorType: 0, pixels });
      const res = await engine.compressImageBuffer({ buffer: src.buffer.slice(0) });
      await h.assertSamePixels(src, new Uint8Array(res.buffer));
      await h.assertBrowserPixelsEqual(src, new Uint8Array(res.buffer));
    }),

  'PNG color chunks (iCCP, pHYs) are preserved; text chunks dropped': (ctx) =>
    run(ctx, async () => {
      const base = await h.storedPng(64, 64);
      const src = h.insertPngChunks(base, [
        ['gAMA', new Uint8Array([0, 0, 0xb1, 0x8f])],
        ['pHYs', new Uint8Array([0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1])],
        ['tEXt', new TextEncoder().encode('Comment\0hello')]
      ]);
      const res = await engine.compressImageBuffer({ buffer: src.buffer.slice(0) });
      const types = png.readChunks(new Uint8Array(res.buffer)).map((c) => c.type);
      if (!types.includes('gAMA') || !types.includes('pHYs')) throw new Error('lost color chunks: ' + types);
      if (types.includes('tEXt')) throw new Error('kept tEXt');
    }),

  'animated PNG is kept untouched': (ctx) =>
    run(ctx, async () => {
      const base = await h.storedPng(16, 16);
      const src = h.insertPngChunks(base, [['acTL', new Uint8Array(8)]]);
      const res = await engine.compressImageBuffer({ buffer: src.buffer.slice(0) });
      if (res.note !== 'kept-animated') throw new Error(res.note);
      if (new Uint8Array(res.buffer).length !== src.length) throw new Error('changed bytes');
    }),

  'GIF, BMP, AVIF, HEIC, ICO are kept in their original format (never converted)': (ctx) =>
    run(ctx, async () => {
      const samples = {
        gif: Uint8Array.from(atob('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='), (c) => c.charCodeAt(0)),
        bmp: h.makeBmp(8, 8),
        avif: h.ftyp('avif'),
        heic: h.ftyp('heic'),
        ico: new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0])
      };
      for (const [kind, bytes] of Object.entries(samples)) {
        const res = await engine.compressImageBuffer({ buffer: bytes.buffer.slice(0) });
        if (res.kind !== kind) throw new Error(`${kind} became ${res.kind}`);
        if (res.note !== 'kept-unsupported') throw new Error(`${kind}: ${res.note}`);
        const out = new Uint8Array(res.buffer);
        if (out.length !== bytes.length || out.some((v, i) => v !== bytes[i])) throw new Error(`${kind} bytes changed`);
      }
    }),

  'animated GIF reports kept-animated': (ctx) =>
    run(ctx, async () => {
      const gce = [0x21, 0xf9, 0x04, 0, 0, 0, 0, 0];
      const bytes = new Uint8Array([...new TextEncoder().encode('GIF89a'), 1, 0, 1, 0, 0, 0, 0, ...gce, ...gce, 0x3b]);
      const res = await engine.compressImageBuffer({ buffer: bytes.buffer });
      if (res.note !== 'kept-animated') throw new Error(res.note);
    }),

  'heavy JPEG gets smaller, stays JPEG at the same dimensions': (ctx) =>
    run(ctx, async () => {
      const src = await h.canvasBytes(1280, 720, h.photoLike, 'image/jpeg', 1.0);
      const res = await engine.compressImageBuffer({ buffer: src.buffer.slice(0) });
      const out = new Uint8Array(res.buffer);
      if (engine.sniff(out) !== 'jpeg') throw new Error('not jpeg');
      if (!(out.length < src.length * 0.7)) throw new Error(`weak saving ${src.length} -> ${out.length}`);
      const dims = await h.browserSize(out, 'image/jpeg');
      if (dims.width !== 1280 || dims.height !== 720) throw new Error('dimensions changed ' + JSON.stringify(dims));
    }),

  'JPEG keeps ICC + EXIF, and EXIF orientation is reset to match rotated pixels': (ctx) =>
    run(ctx, async () => {
      const plain = await h.canvasBytes(200, 100, h.photoLike, 'image/jpeg', 1.0);
      const src = h.jpegWithMetadata(plain, { orientation: 6 });
      const before = await h.browserSize(src, 'image/jpeg');
      const res = await engine.compressImageBuffer({ buffer: src.buffer.slice(0) });
      const out = new Uint8Array(res.buffer);
      const text = new TextDecoder('latin1').decode(out.subarray(0, 2000));
      if (!text.includes('ICC_PROFILE')) throw new Error('ICC lost');
      if (!text.includes('Exif')) throw new Error('EXIF lost');
      if (h.readOrientation(out) !== 1) throw new Error('orientation not reset: ' + h.readOrientation(out));
      const after = await h.browserSize(out, 'image/jpeg');
      if (before.width !== after.width || before.height !== after.height) {
        throw new Error(`displayed size changed ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
      }
    }),

  'JPEG target is honoured within the quality floor': (ctx) =>
    run(ctx, async () => {
      const src = await h.canvasBytes(800, 600, h.photoLike, 'image/jpeg', 1.0);
      const loose = await engine.compressImageBuffer({ buffer: src.buffer.slice(0) });
      const target = Math.round(new Uint8Array(loose.buffer).length * 0.8);
      const res = await engine.compressImageBuffer({ buffer: src.buffer.slice(0), target });
      const len = new Uint8Array(res.buffer).length;
      if (res.note === 'target' && len > target) throw new Error('claimed target but missed it');
      if (len > new Uint8Array(loose.buffer).length) throw new Error('target run produced a bigger file');
    }),

  'only an explicitly chosen quality may go below the quality floor': (ctx) =>
    run(ctx, async () => {
      const src = await h.canvasBytes(800, 600, h.photoLike, 'image/jpeg', 1.0);
      const floor = await engine.compressImageBuffer({ buffer: src.buffer.slice(0), quality: 50 });
      const chosen = await engine.compressImageBuffer({ buffer: src.buffer.slice(0), chosenQuality: 50 });
      const at82 = await engine.compressImageBuffer({ buffer: src.buffer.slice(0), chosenQuality: 82 });
      if (floor.buffer.byteLength !== at82.buffer.byteLength) throw new Error('quality 50 without choosing should clamp to 82');
      if (!(chosen.buffer.byteLength < at82.buffer.byteLength)) throw new Error('chosen 50 should be smaller than 82');
    }),

  'already-small JPEG is kept (never grows)': (ctx) =>
    run(ctx, async () => {
      const src = await h.canvasBytes(300, 200, h.photoLike, 'image/jpeg', 0.5);
      const res = await engine.compressImageBuffer({ buffer: src.buffer.slice(0) });
      if (res.note !== 'kept') throw new Error(res.note);
      if (new Uint8Array(res.buffer).length !== src.length) throw new Error('bytes changed');
    }),

  'lossy WebP is recompressed and stays WebP; lossless WebP is kept': (ctx) =>
    run(ctx, async () => {
      const lossy = await h.canvasBytes(800, 500, h.photoLike, 'image/webp', 1.0);
      const r1 = await engine.compressImageBuffer({ buffer: lossy.buffer.slice(0) });
      if (engine.sniff(new Uint8Array(r1.buffer)) !== 'webp') throw new Error('not webp');
      const lossless = h.fakeLosslessWebp();
      const r2 = await engine.compressImageBuffer({ buffer: lossless.buffer.slice(0) });
      if (r2.note !== 'kept-lossless') throw new Error('lossless webp: ' + r2.note);
    }),

  'SVG with a long prolog is detected; whitespace inside <text> survives': (ctx) =>
    run(ctx, async () => {
      const svg =
        '<?xml version="1.0" encoding="UTF-8"?>\n<!-- ' + 'x'.repeat(400) + ' -->\n' +
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">\n  <text x="0" y="5">A  <tspan>B</tspan> C</text>\n</svg>\n';
      const bytes = new TextEncoder().encode(svg);
      if (engine.sniff(bytes) !== 'svg') throw new Error('not sniffed as svg');
      const res = await engine.compressImageBuffer({ buffer: bytes.buffer });
      const out = new TextDecoder().decode(res.buffer);
      if (out.includes('xxxx')) throw new Error('comment not removed');
      if (!out.includes('A  <tspan>B</tspan> C')) throw new Error('text whitespace changed: ' + out);
    }),

  'SVG without text has inter-tag whitespace removed; CDATA untouched': (ctx) =>
    run(ctx, async () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg">\n  <rect width="1" height="1"/>\n  <g>\n    <circle r="1"/>\n  </g>\n</svg>';
      const res = await engine.compressImageBuffer({ buffer: new TextEncoder().encode(svg).buffer });
      const out = new TextDecoder().decode(res.buffer);
      if (out !== '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/><g><circle r="1"/></g></svg>') throw new Error(out);
      const withStyle = '<svg><style><![CDATA[ a  >  b { } <!-- not a comment --> ]]></style>\n<rect/></svg>';
      const res2 = await engine.compressImageBuffer({ buffer: new TextEncoder().encode(withStyle).buffer });
      if (!new TextDecoder().decode(res2.buffer).includes('<![CDATA[ a  >  b { } <!-- not a comment --> ]]>')) throw new Error('CDATA modified');
    }),

  'resize: JPEG keeps format and aspect ratio, and gets much smaller': (ctx) =>
    run(ctx, async () => {
      const src = await h.canvasBytes(800, 600, h.photoLike, 'image/jpeg', 0.9);
      const res = await engine.resizeImageBuffer({ buffer: src.buffer.slice(0), width: 200 });
      const out = new Uint8Array(res.buffer);
      if (engine.sniff(out) !== 'jpeg') throw new Error('not jpeg');
      const dims = await h.browserSize(out, 'image/jpeg');
      if (dims.width !== 200 || dims.height !== 150) throw new Error('dims ' + JSON.stringify(dims));
      if (!(out.length < src.length / 4)) throw new Error(`size ${src.length} -> ${out.length}`);
    }),

  'resize never upscales': (ctx) =>
    run(ctx, async () => {
      const src = await h.canvasBytes(300, 200, h.photoLike, 'image/jpeg', 0.9);
      const res = await engine.resizeImageBuffer({ buffer: src.buffer.slice(0), width: 2000 });
      if (res.width !== 300 || res.height !== 200) throw new Error(`${res.width}x${res.height}`);
    }),

  'resize: translucent PNG stays PNG with alpha and keeps color chunks': (ctx) =>
    run(ctx, async () => {
      const base = await h.canvasPng(400, 300, h.noisyTranslucent);
      const src = h.insertPngChunks(base, [['gAMA', new Uint8Array([0, 0, 0xb1, 0x8f])]]);
      const res = await engine.resizeImageBuffer({ buffer: src.buffer.slice(0), width: 100 });
      const out = new Uint8Array(res.buffer);
      const dec = await png.decodePng(out);
      if (dec.width !== 100 || dec.height !== 75) throw new Error(`${dec.width}x${dec.height}`);
      if (![4, 6, 3].includes(dec.colorType)) throw new Error('alpha dropped, color type ' + dec.colorType);
      if (!png.readChunks(out).some((c) => c.type === 'gAMA')) throw new Error('gAMA lost');
    }),

  'resize: JPEG keeps ICC/EXIF and comes out upright': (ctx) =>
    run(ctx, async () => {
      const plain = await h.canvasBytes(400, 200, h.photoLike, 'image/jpeg', 0.95);
      const src = h.jpegWithMetadata(plain, { orientation: 6 }); // displays as 200x400
      const res = await engine.resizeImageBuffer({ buffer: src.buffer.slice(0), width: 100 });
      const out = new Uint8Array(res.buffer);
      const text = new TextDecoder('latin1').decode(out.subarray(0, 2000));
      if (!text.includes('ICC_PROFILE') || !text.includes('Exif')) throw new Error('metadata lost');
      if (h.readOrientation(out) !== 1) throw new Error('orientation not reset');
      const dims = await h.browserSize(out, 'image/jpeg');
      if (dims.width !== 100 || dims.height !== 200) throw new Error('dims ' + JSON.stringify(dims));
    }),

  'WebP output: JPEG and translucent PNG convert, keep size/alpha': (ctx) =>
    run(ctx, async () => {
      const jpg = await h.canvasBytes(600, 400, h.photoLike, 'image/jpeg', 0.95);
      const r1 = await engine.resizeImageBuffer({ buffer: jpg.buffer.slice(0), width: 100000, outFormat: 'webp' });
      const o1 = new Uint8Array(r1.buffer);
      if (engine.sniff(o1) !== 'webp' || r1.kind !== 'webp') throw new Error('not webp');
      if (r1.width !== 600 || r1.height !== 400) throw new Error(`${r1.width}x${r1.height}`);
      if (!(o1.length < jpg.length)) throw new Error(`webp not smaller ${jpg.length} -> ${o1.length}`);

      const pngSrc = await h.canvasPng(200, 100, (c, w, hh) => {
        c.fillStyle = 'rgba(200, 30, 30, 0.5)';
        c.fillRect(0, 0, w / 2, hh);
      });
      const r2 = await engine.resizeImageBuffer({ buffer: pngSrc.buffer.slice(0), width: 100, outFormat: 'webp' });
      const bmp = await createImageBitmap(new Blob([r2.buffer], { type: 'image/webp' }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      c.getContext('2d').drawImage(bmp, 0, 0);
      const px = c.getContext('2d').getImageData(10, 10, 1, 1).data;
      const clear = c.getContext('2d').getImageData(90, 10, 1, 1).data;
      if (bmp.width !== 100 || Math.abs(px[3] - 128) > 6 || clear[3] !== 0) throw new Error(`alpha ${px[3]} / ${clear[3]}`);
    }),

  'resize refuses formats it cannot write back (GIF)': (ctx) =>
    run(ctx, async () => {
      const gif = Uint8Array.from(atob('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='), (c) => c.charCodeAt(0));
      let threw = false;
      try {
        await engine.resizeImageBuffer({ buffer: gif.buffer, width: 1 });
      } catch (_) {
        threw = true;
      }
      if (!threw) throw new Error('GIF resize should fail');
    }),

  'runs as a module Worker (the way the popup uses it)': (ctx) =>
    run(ctx, async () => {
      const src = await h.storedPng(100, 100);
      const worker = new Worker('/js/worker.js', { type: 'module' });
      const res = await new Promise((resolve) => {
        worker.onmessage = (e) => resolve(e.data);
        worker.postMessage({ id: 1, buffer: src.buffer }, [src.buffer]);
      });
      worker.terminate();
      if (!res.ok || res.kind !== 'png') throw new Error(JSON.stringify(res));
    })
};

