# Handoff

Updated 2026-10-17 15:34 (USMST)
Branch main (clean, in sync with origin/main at 97cc990)

## Goal
Image Size Checker Pro is a Manifest V3 Chrome/Edge extension. It audits page images (size, dimensions, aspect, alt, CLS/LCP) and fixes them: lossless/high-quality compression in the original format, resizing for display with srcset snippets, optional WebP and lossy PNG. Work follows a phased roadmap, one feature branch per change. The user uses it on their own sites (jarednewnam.com, scottsdaleaz.gov) in Chrome and Edge.

## Current State
- Version 3.3.1. PRs #1–#10 are merged into main. `npm test`: 78/78, three consecutive full runs before each merge.
- Phases 0–2 of the roadmap are done. Phase 3 has not started.
- Work stopped mid-conversation. The user asked whether Edge's Downloads path matches Chrome's. Answer given: each browser has its own download location setting; both default to the Windows Downloads folder. I then offered two things, **not yet approved or started**:
  1. run the test suite against Edge;
  2. add a third save option, "Save straight to my Downloads folder" (chrome.downloads, `saveAs: false`, optional subfolder).
- The user hit Chrome's folder-picker block on `D:\` ("Can't open this folder because it contains system files"). This is Chromium's File System Access blocklist for drive roots and system folders; it can't be overridden. Workarounds: pick a subfolder, use Save-As, or the proposed Downloads option.
- Needs manual verification by the user (it can't be automated):
  - the real Chrome permission prompt inside the new "Allow access" window (PR #10);
  - the "Allow on all sites" banner when site access is restricted;
  - Save-As including cancel;
  - the ZIP downloads that go through Save-As;
  - the real toolbar click.
- The user's Chrome showed CORS errors for `https://www.gstatic.com/...translate_24dp.png`. Assumed cause: site access set to "On click"/"specific sites". I verified extension fetches succeed with full access. PR #10 adds detection and skips the blocked fetches.

## Decisions Made
- **Main UI is a fixed 750px toolbar popup** (user requirement). The side panel is optional via a "⇥ Side panel" button and loads `popup.html?panel=1` (fluid). Rejected: side panel as default, because Chrome controls its width (~440px) and the user rejected it.
- **The whole page scrolls**, with a sticky topbar/footer. Output options (overwrite, WebP, lossy PNG) sit in a collapsed `<details>`. Reason: the user said the image list was "functionally useless" when squeezed.
- **Original format is always preserved.** GIF/BMP/ICO/AVIF/HEIC and animated images are kept unchanged. Rejected: converting under the original filename (old bug).
- **PNG is bit-exact** via a pure-JS PNG decoder/encoder (`js/png.js`), not canvas, because canvas premultiplies alpha and converts color.
- **JPEG/WebP:** quality 92, floor 82. Only the preview's explicit `chosenQuality` may go down to 40. ICC/EXIF are kept; EXIF orientation is reset to 1.
- **Resize naming** (chosen by the user): `name-<width>w.ext`, 1x and 2x of the displayed width, never upscaling. CSS backgrounds get `image-set()`.
- **Lossy PNG** uses an in-house quantizer (`js/quantize.js`). Rejected libimagequant because it's GPL. It's kept only if smaller and ≥36 dB PSNR. Alpha classes (transparent/translucent/opaque) are quantized separately.
- **Compression runs in an offscreen document** (`offscreen.html/js`, `js/jobs.js`), driven by the service worker, so jobs survive the popup closing. User jobs take priority over savings estimates.
- **The popup never calls `requestPermission`**, because Chrome's prompt closes the popup. The background job opens `folder.html?grant=<jobId>` when the folder grant has lapsed.
- Pages are only scanned when asked (popup/shortcut), unless the "Auto-scan every page" setting is on.
- Not recommended: color picker/palette features from competitors.

## Files and Locations
- Repo: https://github.com/r3hab-media/Image-Size-Checker-Pro (`origin`). The old remote `cos-origin` (cos-jnewnam) is kept.
- `manifest.json`: v3.3.1. Permissions: scripting, storage, downloads, sidePanel, offscreen, `<all_urls>`. `action.default_popup: popup.html`; `side_panel.default_path: popup.html?panel=1`.
- `background.js`: size lookups (HEAD → Range → GET, cookie retry, skips hosts without access); downloads with cancel detection; badge; offscreen lifecycle (waits for create/close, ack + retry); estimates cache (session storage, key includes lossy flag); folder-access window orchestration; `setPanelBehavior({openPanelOnActionClick:false})`.
- `content.js`: scan engine and overlay. Stable IDs, serialized scans, `needsCompression`/`needsResize`, `CONTENT_VERSION = 2` (popup expects 2; mismatch shows the stale banner).
- `popup.html/js/css`: UI. Test API `window.__iscPopup` (ensureAndScan, getState, compressAllTooLargeToZip, resizeAllOversized, showStaleBanner).
- `offscreen.html/js`: job + estimate queues.
- `folder.html/js`: pick mode, and grant mode (`?grant=`).
- `js/jobs.js`: fetch, compress, resize, WebP, ZIP, save, folder access wait.
- `js/worker.js`: engine (compressImageBuffer, resizeImageBuffer with outFormat 'webp').
- `js/png.js`: PNG codec, lossless/lossy optimizers, encodeRgbaPng.
- `js/quantize.js`: quantizer + psnr.
- `js/jpeg-meta.js`: JPEG metadata transplant.
- `js/zip.js`, `js/crc32.js`: store-only ZIP.
- `js/folder-store.js`: IndexedDB folder handle, plus a **test hook** `setSimulatedPermission`.
- `js/preview.js`: before/after modal.
- `tests/*.test.mjs`, `tests/run.mjs`, `tests/helpers.js`: Puppeteer suite.
- `README.md`: documents all features.
- Memory: `C:\Users\jared\.claude\projects\d--Personal-Projects-Image-Size-Checker-Pro\memory\` (`isc-pro-backlog.md` roadmap, `isc-ui-width.md`).
- Scratch probes: `C:\Users\jared\AppData\Local\Temp\claude\d--Personal-Projects-Image-Size-Checker-Pro\76fdce26-0c8a-406c-bce7-233e7fbe7858\scratchpad\harness\` (not part of the repo).

## What Failed
- Automating Chrome's native folder picker: `page.waitForFileChooser` → `ProtocolError: Protocol error (DOM.resolveNode): Either nodeId or backendNodeId must be specified.` (The FS Access picker has no input element.)
- Getting a real folder handle via CDP `Input.dispatchDragEvent` drop in headless: it hung with no drop event.
- `chrome.permissions.remove` to simulate withheld site access: "You cannot remove required permissions."
- Shell edits with backticks or `\n` inside `node -e "..."` got mangled by bash several times. Write a `.cjs` script file to `$TEMP` and run it, or use the Edit tool.
- Files are CRLF after checkout (git autocrlf). String replacements must normalize `\r\n` first.
- Never `git checkout -- <file>` to undo a mutation test on uncommitted work: that wiped `content.js` once. Back up to the scratchpad and copy back.

## Next Steps
1. Get the user's answer on the two pending offers: (a) run `npm test` against Edge with `CHROME_PATH="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"` (verify the path exists first); (b) add a "Save straight to my Downloads folder" destination (chrome.downloads, `saveAs:false`, optional subfolder, works in Chrome and Edge, sidesteps the drive-root block and the Allow window).
2. Follow the per-change workflow for whichever is approved: branch → implement → targeted tests → full suite ×3 → commit → push → `gh pr create` → `gh pr merge --merge --delete-branch` → pull main.
3. Ask the user for results of the manual checks listed under Current State.
4. Phase 3 (deeper audit), best-first: real LCP via PerformanceObserver + fetchpriority/preload suggestions; srcset/sizes correctness; below-fold images not lazy; mobile DPR simulation; delivery checks (Cache-Control, gzip SVG, WebP negotiation); ICC display + alt-text quality.
5. Phase 4: right-click inspect/compress; SPA navigation + iframes; shareable HTML report; multi-page/sitemap audit.
6. Phase 5: Web Store readiness (permission justifications, privacy policy, listing assets); optional AVIF via wasm.

## Open Questions
- Run the suite on Edge? — needs user input.
- Add the "Save straight to Downloads" option, and its default subfolder name? — needs user input.
- Does the real permission prompt in the Allow window work, and does Chrome offer "Allow on every visit"? — needs user input (manual test).
- Start Phase 3 now, or after manual testing? — needs user input.

## Constraints and Preferences
- The main UI must be the 750px popup, and the image list must get most of the height. Check a 750×600 screenshot before shipping UI changes.
- One feature branch per update. Test, commit/push, PR, merge. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Test before moving on. Run the full suite three times before merging, and mutation-check new tests where practical.
- Report honestly what was and wasn't verified (native dialogs can't be automated).
- After extension files change, the user must reload the extension at chrome://extensions and refresh tabs. The stale banner warns about this.

## Commands and Setup
- `npm install` (puppeteer-core devDependency), then `npm test`, or `npm test <file-filter> <test-name-filter>`.
- Env: `CHROME_PATH` (defaults to `C:/Program Files/Google/Chrome/Application/chrome.exe`); `HEADFUL=1` to watch.
- The runner loads the unpacked extension via CDP `installExtension`, serves the repo plus test routes on 127.0.0.1, and has a 90s protocol timeout. A full run takes ~2–4 minutes; use `run_in_background` for ×3 runs.
- GitHub CLI is logged in as r3hab-media.
