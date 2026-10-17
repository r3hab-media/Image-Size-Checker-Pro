import { setFolder, getFolder, requestFolderPermission } from './js/folder-store.js';

// Folder pickers and permission prompts run in this small window rather than the toolbar popup:
// the native dialog takes focus, and Chrome closes the popup (and everything running in it) when
// that happens.
const params = new URLSearchParams(location.search);
const grantJobId = params.get('grant');

if (!grantJobId) {
  const status = document.getElementById('status');
  document.getElementById('pickBtn').addEventListener('click', async () => {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      await setFolder(handle);
      status.textContent = `Saved: /${handle.name}/ — you can close this window.`;
      setTimeout(() => window.close(), 1500);
    } catch (err) {
      status.textContent = err && err.name === 'AbortError' ? 'No folder chosen.' : `Could not use that folder: ${err.message || err}`;
    }
  });
} else {
  document.getElementById('pickMode').classList.add('hidden');
  document.getElementById('grantMode').classList.remove('hidden');
  const status = document.getElementById('grantStatus');
  const allowBtn = document.getElementById('allowBtn');
  const answer = (granted) =>
    chrome.runtime.sendMessage({ type: 'FOLDER_ACCESS_RESULT', jobId: grantJobId, granted }, () => void chrome.runtime.lastError);

  getFolder().then((handle) => {
    if (handle) document.getElementById('grantFolderName').textContent = `/${handle.name}/`;
  });

  // Keep this window open until the job finishes: the grant lasts while an extension page is open.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'JOB_UPDATE' && msg.job.id === grantJobId) {
      if (msg.job.state === 'done' || msg.job.state === 'error') {
        status.textContent = msg.job.status;
        setTimeout(() => window.close(), 1800);
      } else if (msg.job.status) {
        status.textContent = msg.job.status;
      }
    }
    return false;
  });

  allowBtn.addEventListener('click', async () => {
    const handle = await getFolder();
    if (!handle) {
      status.textContent = 'No folder is chosen any more.';
      answer(false);
      return;
    }
    const state = await requestFolderPermission(handle);
    allowBtn.disabled = true;
    if (state === 'granted') {
      status.textContent = 'Saving…';
      answer(true);
    } else {
      status.textContent = 'Access was not allowed, so nothing was saved.';
      answer(false);
      setTimeout(() => window.close(), 1800);
    }
  });
}
