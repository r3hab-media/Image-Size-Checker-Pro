// Before/after preview: re-encodes one image at a chosen quality, live, so the user can judge
// lossy compression before saving. Runs in its own worker in the panel (it is interactive and
// needs no background survival); saving goes through the normal background job.
import { fetchItemBuffer } from './jobs.js';

const $ = (id) => document.getElementById(id);
const els = {
  modal: $('previewModal'),
  title: $('previewTitle'),
  compare: $('compare'),
  before: $('beforeImg'),
  after: $('afterImg'),
  splitLine: $('splitLine'),
  split: $('splitRange'),
  quality: $('qualityRange'),
  qualityVal: $('qualityVal'),
  stats: $('previewStats'),
  save: $('previewSaveBtn'),
  zoom: $('previewZoomBtn'),
  close: $('previewCloseBtn')
};

const PREVIEW_FORMATS = new Set(['JPEG', 'WEBP']);
export const canPreview = (item) => PREVIEW_FORMATS.has(item.format);

let worker = null;
let seq = 0;
const pending = new Map();
function encode(buffer, chosenQuality) {
  if (!worker) {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      pending.delete(e.data.id);
      if (p) (e.data.ok ? p.resolve : p.reject)(e.data.ok ? e.data : new Error(e.data.error));
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, buffer: buffer.slice(0), chosenQuality }, []);
  });
}

const formatBytes = (bytes) => {
  if (!bytes || bytes <= 0) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(kb >= 100 ? 0 : 1)} KB` : `${(kb / 1024).toFixed(2)} MB`;
};

let session = null; // { raw, beforeUrl, afterUrl, token, onSave }

function setSplit() {
  els.after.style.clipPath = `inset(0 0 0 ${els.split.value}%)`;
  els.splitLine.style.left = `${els.split.value}%`;
}

function close() {
  if (!session) return;
  URL.revokeObjectURL(session.beforeUrl);
  if (session.afterUrl) URL.revokeObjectURL(session.afterUrl);
  session = null;
  els.modal.classList.add('hidden');
  els.compare.classList.remove('zoom');
  els.before.removeAttribute('src');
  els.after.removeAttribute('src');
}

let debounce = null;
function scheduleEncode() {
  const q = Number(els.quality.value);
  els.qualityVal.textContent = String(q);
  els.save.textContent = `Save at quality ${q}`;
  clearTimeout(debounce);
  debounce = setTimeout(() => runEncode(q), 120);
}

async function runEncode(q) {
  if (!session) return;
  const token = ++session.token;
  els.save.disabled = true;
  els.stats.textContent = 'Encoding…';
  try {
    const res = await encode(session.raw, q);
    if (!session || token !== session.token) return; // a newer quality was picked meanwhile
    if (session.afterUrl) URL.revokeObjectURL(session.afterUrl);
    session.afterUrl = URL.createObjectURL(new Blob([res.buffer], { type: res.mime }));
    els.after.src = session.afterUrl;
    const before = session.raw.byteLength;
    const after = res.buffer.byteLength;
    els.stats.dataset.after = String(after);
    els.stats.dataset.note = res.note;
    if (res.note === 'kept') {
      els.stats.textContent = `${formatBytes(before)} — this quality would not be smaller; the original would be kept`;
      els.save.disabled = true;
    } else {
      els.stats.textContent = `${formatBytes(before)} → ${formatBytes(after)} (-${Math.round(((before - after) / before) * 100)}%)`;
      els.save.disabled = false;
    }
  } catch (err) {
    if (session && token === session.token) els.stats.textContent = `Error: ${err.message || err}`;
  }
}

// onSave(quality) is called when the user saves; the caller starts the background job.
export async function openPreview(item, { tabId, onSave }) {
  close();
  els.title.textContent = item.originalFilename;
  els.stats.textContent = 'Loading…';
  els.stats.dataset.after = '';
  els.save.disabled = true;
  els.modal.classList.remove('hidden');
  const raw = await fetchItemBuffer(item, tabId);
  session = { raw, beforeUrl: URL.createObjectURL(new Blob([raw])), afterUrl: null, token: 0, onSave };
  els.before.src = session.beforeUrl;
  els.quality.value = '92';
  setSplit();
  scheduleEncode();
  els.close.focus();
}

els.split.addEventListener('input', setSplit);
els.quality.addEventListener('input', scheduleEncode);
els.zoom.addEventListener('click', () => els.compare.classList.toggle('zoom'));
els.close.addEventListener('click', close);
els.modal.addEventListener('click', (e) => {
  if (e.target === els.modal) close();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && session) close();
});
els.save.addEventListener('click', () => {
  if (!session) return;
  const { onSave } = session;
  const q = Number(els.quality.value);
  close();
  onSave(q);
});
