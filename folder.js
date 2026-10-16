import { setFolder } from './js/folder-store.js';

// The directory picker runs in this window rather than the popup, because the native dialog
// takes focus and Chrome closes the popup (losing the handle) when that happens.
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
