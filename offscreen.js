import { runJob } from './js/jobs.js';

// Runs compression jobs one at a time, independent of whether the side panel is open.
// Progress goes to the service worker, which stores it for the panel.
const queue = [];
let running = false;

function report(job, state) {
  chrome.runtime.sendMessage({ type: 'JOB_UPDATE', job: { id: job.id, mode: job.mode, tabId: job.tabId, ...state } }, () => {
    void chrome.runtime.lastError;
  });
}

async function drain() {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift();
    report(job, { state: 'running', status: 'Starting…' });
    try {
      const done = await runJob(job, (partial) => report(job, { state: 'running', ...partial }));
      report(job, { state: 'done', ...done });
    } catch (err) {
      report(job, { state: 'error', status: `Error: ${err.message || err}` });
    }
  }
  running = false;
  chrome.runtime.sendMessage({ type: 'JOBS_IDLE' }, () => void chrome.runtime.lastError);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.target === 'offscreen' && msg.type === 'RUN_JOB') {
    queue.push(msg.job);
    drain();
  }
  return false;
});
