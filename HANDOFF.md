# Handoff

Updated 2026-10-21
Stacked branches, all pushed: `feat/3.5.0-listing` (PR #20 → main) → `feat/landing-page` (PR #21) → `feat/firefox` (PR #23). Separate: `chore/mit-license` (PR #22 → main). None are merged. `main` is at f4f5e61 (3.4.1).

## Goal
Image Size Checker Pro is a Manifest V3 extension, live on Chrome and Edge at 3.4.1. It audits page images and compresses them as drop-in replacements (same name, format and dimensions). Release 3.5.0 is a promotion update:
- search-tuned store text
- a GitHub Pages landing page and changelog
- an MIT license
- a new Firefox build for a first Firefox Add-ons listing

Store links:
- Chrome: https://chromewebstore.google.com/detail/image-size-checker-pro/ibcbajbelpfnngmeaelfbbojmocmacpa
- Edge: https://microsoftedge.microsoft.com/addons/detail/image-size-checker-pro/kdcdiekcbloocageafpcpihkgddlenab
- Site: https://r3hab-media.github.io/Image-Size-Checker-Pro/

## Current State
- **Version 3.5.0.** It's a minor bump: new listing text, homepage link, website and Firefox build. One UI fix; otherwise behavior is unchanged in Chrome and Edge.
- **PR #20:**
  - new manifest description (125 characters) and `homepage_url`
  - the privacy link points to the Pages copy
  - `store/LISTING.md` rewritten, `CHANGELOG.md` added
  - `tests/update-safety.test.mjs` added
- **PR #21:** the `docs/` site (index, privacy, CSS, WebP images, 1200×630 share image), `store-assets.mjs --site-only`, `tests/site.test.mjs`.
- **PR #22:** `LICENSE` (MIT, Jared Newnam 2026) and a License section in the README.
- **PR #23 (Firefox):**
  - `scripts/firefox-manifest.mjs` and `js/offscreen-shim.js`
  - `npm run package` builds both ZIPs plus `dist/firefox/`
  - `npm run test:firefox` added
  - popup and background guards
  - a downloads fix: Firefox needs `blob:` URLs, not `data:`
  - a `[hidden]` CSS fix, Firefox listing text, and the release script now attaches both ZIPs
- **Tests:**
  - `npm test`: 96/96 in Chrome
  - `npm run test:firefox`: 5/5 in Firefox 158
  - `web-ext lint` on the Firefox build: 0 errors, 0 warnings (AMO flagged 10 on the first upload: innerHTML, sidePanel/offscreen calls and the Android minimum; fixed on `fix/firefox-lint-warnings`)
- **Permissions are unchanged from 3.4.1** in the Chrome and Edge manifest. There's no storage key change and no migration.
- **GitHub Pages is on, but serving `main` from `/` (root).** It must be switched to `main` `/docs` once #20 and #21 are merged, or the site URL will show the README instead of the landing page.

## Decisions Made
- **One description for Chrome and Edge** (Edge allows 250 to 10,000 characters). Firefox gets a slightly different text: Save-As only, sidebar, shortcuts in the Add-ons Manager.
- **Firefox uses the same code with a generated manifest:**
  - `background.scripts: [js/offscreen-shim.js, background.js]`
  - `sidebar_action` (from `side_panel.default_path`)
  - `sidePanel` and `offscreen` permissions dropped
  - `browser_specific_settings.gecko`: id `image-size-checker-pro@r3hab-media.github.io` (**permanent once on AMO**), `strict_min_version` 140.0, `data_collection_permissions: {required: ["none"]}`
  - desktop only
- **Offscreen shim:** in Firefox's event-page background, `chrome.offscreen` is polyfilled with a hidden iframe of `offscreen.html`. The iframe is a separate extension context, so the existing runtime messaging works unchanged.
- **Firefox rejects `data:` URLs in `downloads.download`.** The error is "Access denied for URL data:...", confirmed in Firefox 158. `background.js` converts them to `blob:` URLs when `URL.createObjectURL` exists (Firefox's page). Chrome's service worker keeps `data:` URLs.
- **No Choose Folder in Firefox** (no `showDirectoryPicker`). Saves always go through Save-As.
- **`[hidden] { display: none !important }` in popup.css.** Without it, `.icon-btn`'s `inline-flex` beat the attribute, and the side panel showed its own "Side panel" button in Chrome and Edge too. That's a real bug, now fixed and tested.
- **The site:** system fonts, WebP-only screenshots, no scripts, and a privacy page kept in sync with `PRIVACY.md` by a test. No Firefox install button until there's an AMO URL.

## Files and Locations
- `store/LISTING.md`:
  - limits table for Chrome, Edge and Firefox
  - shared text and what's new
  - Chrome, Edge and Firefox sections, including the AMO description and reviewer notes
  - the checklist
- `scripts/package.mjs` builds both ZIPs. `scripts/firefox-manifest.mjs` generates the Firefox manifest. `scripts/release.mjs` attaches both ZIPs to the GitHub release.
- `tests/firefox-smoke.mjs` (`npm run test:firefox`):
  - launches Firefox with `--no-remote --new-instance --remote-allow-system-access`
  - fixes the add-on UUID via the `extensions.webextensions.uuids` pref
  - opens `moz-extension://` pages with `goto` and then waits for `window.__iscPopup`
- `tests/firefox-manifest.test.mjs` and `tests/update-safety.test.mjs` are part of `npm test`.
- Memory: `C:\Users\jared\.claude\projects\d--Personal-Projects-Image-Size-Checker-Pro\memory\`

## What Failed
- **The first Firefox launch made Firefox apply a pending update (156 → 158).** While the updater ran, `firefox.exe` was missing and spawning failed with EBUSY. Wait for `updater.exe` to exit.
- **WebDriver BiDi refuses to navigate to `moz-extension://`** and can't run scripts there without `--remote-allow-system-access`. With the flag, the page loads, but `goto` never resolves, so the test catches the timeout and waits for the page's own test API.
- **Firefox reports manifest URLs normalized to full `moz-extension://` URLs** in `getManifest()`. Compare with `endsWith`.
- **Headless Firefox can't show a Save-As picker.** `saveAs: true` fails with "An unexpected error occurred". The smoke test downloads with `saveAs: false`; the real Save-As dialog has to be checked by hand.
- **Shell quoting kept breaking inline `node -e` edits** (quotes and `\n` inside heredocs). Use `.cjs` files or the Edit tool.
- Files are CRLF after checkout, so normalize `\r\n` in scripted edits. Never `git checkout -- <file>` to undo a mutation test.

## Next Steps
1. User: review and merge in order: #20, then #21 (retarget it to `main` after #20), then #23, and #22 at any time.
2. After #21 is merged: switch Pages to `main` `/docs`. Check the site and `/privacy.html`, then check the share card in LinkedIn Post Inspector and an X post preview.
3. Manual Firefox check:
   - load `dist/firefox/manifest.json` at `about:debugging#/runtime/this-firefox`
   - compress one image (Save-As dialog), ZIP, resize, preview
   - sidebar button
   - Set a shortcut (opens the Add-ons Manager)
   - the "Allow on all sites" banner if site access is revoked in `about:addons`
4. On `main`: `npm run release` (attaches both ZIPs), upload to Chrome, Edge and AMO, and paste the text from `store/LISTING.md`.
5. When the AMO listing is live: add its URL to `store/LISTING.md`, README and an install button on `docs/index.html`.
6. Open items:
   - **Em dash in the playground title.** `demo-playground.html` has one, and it shows in `store/screenshot-3-page.png`. Fixing it means regenerating the store screenshots.
   - **Firefox event-page idle risk.** A single compression that takes over about 30 seconds with no messages could be suspended. It wasn't seen in testing.
7. Older backlog (Phase 3 audits and onward) is unchanged; see the memory file `isc-pro-backlog.md`.

## Open Questions
- Is the `<all_urls>` manifest on `main` exactly what's live? (Assumed yes.)
- Should I switch Pages to `/docs` via `gh api`, or will the user do it in Settings?

## Constraints and Preferences
- No new required permissions or host permissions in updates. Don't change the name, ID or key. Storage key changes need an `onInstalled` "update" migration plus a test.
- The Chrome and Edge `manifest.json` stays as committed; Firefox differences live only in `scripts/firefox-manifest.mjs`.
- User-facing writing: plain short sentences, no em dashes, no hype words.
- The main UI is the 750px popup. Check a 750×600 screenshot before shipping UI changes.
- One feature branch per update, then test, commit, push and PR. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Run the full suite three times before merging. Don't run `npm run release` unless asked.

## Commands and Setup
- `npm install`, then `npm test` (or `npm test <file-filter> <test-name-filter>`). Set `CHROME_PATH` for Edge; `HEADFUL=1` to watch.
- `npm run test:firefox` needs Firefox 140+ (set `FIREFOX_PATH` if it's elsewhere).
- `npm run package` builds the Chrome/Edge ZIP, the Firefox ZIP and `dist/firefox/`. `npm run release` tags and publishes both (on `main` only).
- `node scripts/store-assets.mjs` regenerates the store and site images; `--site-only` rebuilds just `docs/img`.
- `npx web-ext@8 lint --source-dir dist/firefox` runs AMO's validator locally.
