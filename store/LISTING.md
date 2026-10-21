# Store submission kit

Everything needed to fill in the Chrome Web Store and Microsoft Edge Add-ons dashboards for version 3.5.0. Copy each block into the matching field. Both stores take the same ZIP and the same description.

Live listings:
- Chrome: https://chromewebstore.google.com/detail/image-size-checker-pro/ibcbajbelpfnngmeaelfbbojmocmacpa
- Edge: https://microsoftedge.microsoft.com/addons/detail/image-size-checker-pro/kdcdiekcbloocageafpcpihkgddlenab

Project site: https://r3hab-media.github.io/Image-Size-Checker-Pro/ (served from `docs/` on `main` by GitHub Pages).

## Character limits used

| Field | Chrome Web Store | Edge Add-ons |
|---|---|---|
| Name | 75 (manifest `name`) | from the manifest, read-only |
| Short description | 132 (manifest `description`, shown as the summary) | from the manifest `description`, read-only |
| Description | 16,000 | 250 minimum, 10,000 maximum |
| Search terms | none | up to 7 terms, 30 characters each, 21 words in total |

`npm run package` refuses to build when the manifest description is over 132 characters. The description below is about 2,000 characters, so it fits both stores.

## 1. Build the upload

On `main`, merged and pushed:

```
npm run release
```

This builds `dist/image-size-checker-pro-3.5.0.zip`, tags the commit `v3.5.0`, and publishes a GitHub Release with the ZIP attached, so every store upload is recorded with the exact code it came from. Upload that ZIP to both stores. Extra arguments go to `gh release create`, for example `npm run release -- --notes "One-line summary"`.

It refuses to run off `main`, with uncommitted changes, when `main` differs from `origin/main`, or when the tag already exists. The build itself (`npm run package`, which you can also run alone to try a build) refuses if the manifest and `package.json` versions differ or the description is over 132 characters. `npm test` fails if the manifest adds a permission, host permission or content-script match that the last release tag did not have, because that would disable the update for existing users until they accept the new warning.

To refresh the store images and the project site's images after UI changes: `node scripts/store-assets.mjs`.

## 2. Shared text

### Short description (both stores, from the manifest)

```
Check image size and compress images for page speed. Shows measured savings. Files keep the same name, format and dimensions.
```

### Description (both stores, plain text; neither store renders Markdown)

```
Image Size Checker Pro finds the images that hurt your page speed, LCP and Core Web Vitals, and helps you compress images without changing your markup. Savings are measured by really compressing each JPEG, PNG and WebP, and you get drop-in replacement files with the same name, format and dimensions.

AUDIT ANY PAGE
• File size, pixel dimensions and how each image is actually displayed
• Flags images over your size limit, images with far more pixels than they need, stretched or squashed images, and missing alt text
• Flags missing width and height (layout shift) and lazy-loaded images above the fold (slower LCP)
• Achievable savings are measured by really compressing each image, not guessed
• Badges and tooltips right on the page, or a clean report in the popup or side panel

COMPRESS AS DROP-IN REPLACEMENTS
• Same filename, same format, same pixel dimensions, so you can overwrite the original files
• PNG compression is lossless and pixel-exact
• JPEG and WebP keep high quality by default; preview before and after and pick the quality yourself
• Compress one image, or everything at once into a ZIP
• Save straight into a folder you choose (for example your site's images folder) or use the Save-As dialog

RESIZE FOR HOW IMAGES ARE DISPLAYED
• Creates 1x and 2x versions sized for the space each image fills, never upscaled
• Gives you ready-to-paste srcset markup

OPTIONAL EXTRAS
• WebP copies with <picture> markup
• Lossy PNG (256-color palette), used only when the result is visually near-identical
• Export the audit as CSV, JSON or a Markdown table

PRIVATE BY DESIGN
No accounts, no analytics, no tracking. Pages are scanned only when you ask (unless you turn on auto-scan), all processing happens in your browser, and files are saved only to your computer.

Optional keyboard shortcuts: pick your own keys to open the extension or show and hide the on-page badges.

Website, changelog and privacy policy: https://r3hab-media.github.io/Image-Size-Checker-Pro/
```

### What's new in 3.5.0 (for release notes and posts)

```
Image Size Checker Pro now has a project website with screenshots, install links, the changelog and the privacy policy. The store listing explains more clearly what makes it different: savings are measured by really compressing each image, and you get files with the same name, format and dimensions. How the extension works is unchanged, and your settings carry over.
```

## 3. Chrome Web Store

Dashboard: https://chrome.google.com/webstore/devconsole

### Package tab

Upload `dist/image-size-checker-pro-3.5.0.zip` (also attached to the `v3.5.0` GitHub Release).

### Store listing tab

- **Name and summary:** come from the manifest (section 2).
- **Description:** the description in section 2.
- **Category:** Developer Tools
- **Language:** English

**Images:**

| Field | File |
|---|---|
| Store icon (128×128) | `icons/icon128.png` |
| Screenshots (1280×800) | `store/screenshot-1-report.png`, `store/screenshot-2-preview.png`, `store/screenshot-3-page.png` |
| Small promo tile (440×280) | `store/promo-small-440x280.png` |
| Marquee promo tile (1400×560) | `store/promo-marquee-1400x560.png` (optional; only used if Google features the extension) |

**Additional fields:**
- Homepage URL: https://r3hab-media.github.io/Image-Size-Checker-Pro/
- Support URL: https://github.com/r3hab-media/Image-Size-Checker-Pro/issues

### Privacy practices tab

**Single purpose:**

```
Audit the images on the current web page for file size, dimensions, aspect ratio and alt text, and create smaller drop-in replacement files for them.
```

**Permission justifications:**

| Permission | Justification to paste |
|---|---|
| Host permission (`<all_urls>`) | The extension audits images on whatever page the user chooses to scan, and those images are often hosted on other domains (CDNs, image services). It needs access to all sites to read the page's images and to fetch the image files from their hosts to measure their real file size and compress them. Pages are only scanned when the user opens the extension or presses its shortcut, unless the user enables auto-scan in settings. |
| `scripting` | Injects the extension's own image scanner into the active tab when the user opens the popup, so pages loaded before the extension was installed or updated can be scanned without a reload. |
| `storage` | Saves the user's settings (size limit, overlay mode, thresholds) locally, and caches measured savings for the current browser session so they are not recalculated. |
| `downloads` | Saves the compressed and resized images, ZIP files and CSV/JSON reports the user asks for to the user's computer. |
| `sidePanel` | Lets the user open the same report in the browser's side panel so it stays visible while browsing. |
| `offscreen` | Image compression runs in an offscreen document so a batch job keeps running if the user closes the popup. |
| Remote code | Answer **No, I am not using remote code.** All JavaScript, fonts and images ship inside the package. |

**Data usage:** check none of the data-type boxes. The extension does not collect or transmit any user data; page and image data is processed locally and only for the feature the user invoked.

Then check all three certifications:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://r3hab-media.github.io/Image-Size-Checker-Pro/privacy.html

### Distribution tab

- Visibility: **Public**
- Regions: all regions
- Pricing: free

## 4. Microsoft Edge Add-ons

Dashboard: https://partner.microsoft.com/dashboard/microsoftedge

**Packages:** upload `dist/image-size-checker-pro-3.5.0.zip`, the same released ZIP as Chrome.

**Availability:** Public; all markets.

**Properties:**
- Category: Developer tools
- Website: https://r3hab-media.github.io/Image-Size-Checker-Pro/
- Support contact: https://github.com/r3hab-media/Image-Size-Checker-Pro/issues
- Mature content: No

**Privacy:** the same single purpose, permission justifications, remote code answer and data usage as the Chrome privacy practices tab (section 3). Privacy policy URL: https://r3hab-media.github.io/Image-Size-Checker-Pro/privacy.html

**Store listings (English):**

| Field | What to use |
|---|---|
| Description (250 to 10,000 characters) | The description in section 2 |
| Extension logo (1:1, 300×300 recommended) | `store/logo-300x300.png` |
| Small promotional tile (440×280) | `store/promo-small-440x280.png` |
| Large promotional tile (1400×560) | `store/promo-marquee-1400x560.png` |
| Screenshots (1280×800) | The same three screenshots as Chrome |
| Search terms (up to 7, 30 characters each, 21 words total) | `compress images`, `image size`, `image optimizer`, `webp`, `page speed`, `core web vitals`, `lcp` |

**Notes for certification** (on the Submit page):

```
Update from 3.4.1. This version changes the store description and adds a homepage link (homepage_url) to the project website. No permissions changed, and the extension works the same way.

No account or sign-in is needed. To test: open any web page with images (or click "Playground" in the popup for a built-in test page), click the toolbar button, and the popup lists every image with its file size and dimensions. Click "Compress" on an image to save a smaller copy with the same filename; a Save-As dialog opens for the file. "Compress & Download All Compressible" saves a batch as one ZIP. "Resize" appears on images larger than their display size. The side panel button docks the same report in the Edge sidebar.

The extension needs access to all sites because it audits whichever page the user chooses, and those images are often hosted on other domains (CDNs). Pages are scanned only when the user opens the extension or presses its shortcut, unless they turn on auto-scan. Nothing is sent anywhere; all processing happens locally.
```

## 5. Before you press Submit

- [ ] GitHub Pages is on (Settings, Pages, Deploy from a branch, `main`, `/docs`) and https://r3hab-media.github.io/Image-Size-Checker-Pro/ and `/privacy.html` load
- [ ] `npm test` passes, also in Edge: `CHROME_PATH="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" npm test`
- [ ] `npm run release` built the ZIP from `main`
- [ ] Loaded the ZIP contents unpacked once in Chrome and once in Edge and clicked through: scan, compress one image, ZIP, resize, preview, side panel
- [ ] Chrome: listing, privacy and distribution tabs filled in; no warnings shown in the dashboard
- [ ] Edge: properties, privacy and store listing filled in; certification notes pasted
- [ ] Expect review to take a few days on Chrome and up to seven business days on Edge

## After it is published

- Watch installs, weekly users and uninstalls under each store's analytics.
- For each update: bump `version` in `manifest.json` and `package.json` (the stores reject a version they have already seen), add a `CHANGELOG.md` entry, run `npm test`, merge to `main`, run `npm run release`, and upload the released ZIP to both stores. Never upload a ZIP that has no release.
