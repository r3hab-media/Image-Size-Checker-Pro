import { runJob, estimateItem } from './js/jobs.js';

// Runs compression jobs one at a time, independent of whether the side panel is open.
// User jobs always run before savings estimates, which are checked one image at a time so a
// click never waits behind a whole page of estimates.
const jobs = [];
const estimates = [];
let running = false;

function send(message) {
  chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
}

function report(job, state) {
  send({ type: 'JOB_UPDATE', job: { id: job.id, mode: job.mode, tabId: job.tabId, ...state } });
}

async function runNextJob(job) {
  report(job, { state: 'running', status: 'Starting…' });
  try {
    const done = await runJob(job, (partial) => report(job, { state: 'running', ...partial }));
    report(job, { state: 'done', ...done });
  } catch (err) {
    report(job, { state: 'error', status: `Error: ${err.message || err}` });
  }
}

async function runNextEstimate({ tabId, item, bytesPerPixel, lossyPng }) {
  let result;
  try {
    result = await estimateItem(item, tabId, bytesPerPixel, lossyPng);
  } catch (err) {
    result = { error: String(err.message || err) };
  }
  send({ type: 'ESTIMATE_UPDATE', tabId, url: item.url, cacheKey: item.cacheKey, result });
}

async function drain() {
  if (running) return;
  running = true;
  while (jobs.length || estimates.length) {
    if (jobs.length) await runNextJob(jobs.shift());
    else await runNextEstimate(estimates.shift());
  }
  running = false;
  send({ type: 'JOBS_IDLE' });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  if (msg.type === 'RUN_JOB') jobs.push(msg.job);
  if (msg.type === 'RUN_ESTIMATES') {
    for (const item of msg.items) estimates.push({ tabId: msg.tabId, item, bytesPerPixel: msg.bytesPerPixel, lossyPng: msg.lossyPng });
  }
  sendResponse({ ok: true }); // acknowledgement: the service worker retries if this never arrives
  drain();
  return false;
});
