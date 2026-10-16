// JPEG marker helpers: lets a canvas re-encode keep the original's color profile and EXIF/XMP.

function segments(bytes) {
  const list = [];
  let pos = 2;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) break;
    const marker = bytes[pos + 1];
    if (marker === 0xff) {
      pos++;
      continue;
    }
    // Standalone markers carry no length.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      pos += 2;
      continue;
    }
    const length = (bytes[pos + 2] << 8) | bytes[pos + 3];
    list.push({ marker, start: pos, end: pos + 2 + length, data: bytes.subarray(pos + 4, pos + 2 + length) });
    if (marker === 0xda) break; // entropy-coded data follows SOS
    pos += 2 + length;
  }
  return list;
}

const startsWith = (data, text) => {
  for (let i = 0; i < text.length; i++) if (data[i] !== text.charCodeAt(i)) return false;
  return true;
};

export function readJpegInfo(bytes) {
  const segs = segments(bytes);
  const sof = segs.find((s) => s.marker >= 0xc0 && s.marker <= 0xcf && s.marker !== 0xc4 && s.marker !== 0xc8 && s.marker !== 0xcc);
  const components = sof ? sof.data[5] : 3;
  const icc = segs.filter((s) => s.marker === 0xe2 && startsWith(s.data, 'ICC_PROFILE\0'));
  const exif = segs.find((s) => s.marker === 0xe1 && startsWith(s.data, 'Exif\0\0'));
  const xmp = segs.filter((s) => s.marker === 0xe1 && startsWith(s.data, 'http://ns.adobe.com/'));
  // ICC header bytes 16-19 name the profile's color space; only an RGB profile is valid for our RGB output.
  let iccIsRgb = false;
  if (icc.length) {
    const first = icc.find((s) => s.data[12] === 1) || icc[0];
    const header = first.data.subarray(14);
    iccIsRgb = startsWith(header.subarray(16), 'RGB ');
  }
  return { components, icc, iccIsRgb, exif, xmp };
}

// Returns a copy of the EXIF APP1 segment with the Orientation tag forced to 1, because the pixels
// we re-encode have already been rotated by the decoder.
function exifWithUprightOrientation(seg, bytes) {
  const copy = bytes.slice(seg.start, seg.end);
  const tiff = 10; // FF E1 len(2) "Exif\0\0"
  const le = copy[tiff] === 0x49;
  const view = new DataView(copy.buffer);
  const u16 = (o) => view.getUint16(o, le);
  const u32 = (o) => view.getUint32(o, le);
  try {
    const ifd0 = tiff + u32(tiff + 4);
    const count = u16(ifd0);
    for (let i = 0; i < count; i++) {
      const entry = ifd0 + 2 + i * 12;
      if (u16(entry) === 0x0112) view.setUint16(entry + 8, 1, le);
    }
  } catch (_) {}
  return copy;
}

// Splices the source's APP1 (EXIF/XMP) and, when safe, APP2 (ICC) segments into a freshly encoded JPEG,
// replacing whatever metadata segments the encoder wrote.
export function transplantJpegMetadata(source, encoded, { keepIcc }) {
  const src = readJpegInfo(source);
  const outSegs = segments(encoded);
  const firstNonApp = outSegs.find((s) => !(s.marker >= 0xe0 && s.marker <= 0xef));
  if (!firstNonApp) return encoded;

  const jfif = outSegs.find((s) => s.marker === 0xe0);
  const inserts = [];
  if (jfif) inserts.push(encoded.subarray(jfif.start, jfif.end));
  if (src.exif) inserts.push(exifWithUprightOrientation(src.exif, source));
  for (const s of src.xmp) inserts.push(source.subarray(s.start, s.end));
  if (keepIcc) for (const s of src.icc) inserts.push(source.subarray(s.start, s.end));

  const rest = encoded.subarray(firstNonApp.start);
  let total = 2 + rest.length;
  for (const p of inserts) total += p.length;
  const out = new Uint8Array(total);
  out[0] = 0xff;
  out[1] = 0xd8;
  let pos = 2;
  for (const p of inserts) {
    out.set(p, pos);
    pos += p.length;
  }
  out.set(rest, pos);
  return out;
}
