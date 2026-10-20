# Store submission kit

Everything needed to fill in the Chrome Web Store developer dashboard for version 3.4.1. Copy each block into the matching field. The same ZIP and most of the same text go to Microsoft Edge Add-ons; [section 6](#6-microsoft-edge-add-ons) covers what differs there.

## 1. Build the upload

```
npm run package
```

This writes `dist/image-size-checker-pro-3.4.1.zip`. It refuses to build if packaged files have uncommitted changes, if the manifest and `package.json` versions differ, or if the description is over 132 characters. Upload that ZIP under **Package**.

To refresh the store images after UI changes: `node scripts/store-assets.mjs`.

## 2. Store listing tab

**Name** (from the manifest): Image Size Checker Pro

**Summary** (from the manifest, 132 characters max):
Find heavy, oversized and distorted images on any page, then compress or resize them as drop-in replacements with the same filename.

**Category:** Developer Tools

**Language:** English

**Description** (plain text; the store does not render Markdown):

```
Heavy images are the most common reason a page loads slowly. Image Size Checker Pro shows you which images are too big, by how much, and fixes them without changing your markup.

AUDIT ANY PAGE
• File size, pixel dimensions and how each image is actually displayed
• Flags images over your size limit, images with far more pixels than they need, stretched or squashed images, and missing alt text
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
```

**Images:**

| Field | File |
|---|---|
| Store icon (128×128) | `icons/icon128.png` |
| Screenshots (1280×800) | `store/screenshot-1-report.png`, `store/screenshot-2-preview.png`, `store/screenshot-3-page.png` |
| Small promo tile (440×280) | `store/promo-small-440x280.png` |
| Marquee promo tile (1400×560) | `store/promo-marquee-1400x560.png` (optional; only used if Google features the extension) |

**Additional fields:**
- Homepage URL: https://github.com/r3hab-media/Image-Size-Checker-Pro
- Support URL: https://github.com/r3hab-media/Image-Size-Checker-Pro/issues

## 3. Privacy practices tab

**Single purpose** (one sentence describing the extension's narrow purpose):

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

**Privacy policy URL:**
https://github.com/r3hab-media/Image-Size-Checker-Pro/blob/main/PRIVACY.md

## 4. Distribution tab

- Visibility: **Public** (or **Unlisted** for a soft launch: only people with the link can install it)
- Regions: all regions
- Pricing: free

## 5. Before you press Submit

- [ ] Developer account registered at https://chrome.google.com/webstore/devconsole (one-time $5 fee) and contact email verified
- [ ] PR merged to `main`, so the privacy policy URL above works
- [ ] `npm test` passes and `npm run package` built the ZIP from committed code
- [ ] Loaded `dist/…zip` contents as an unpacked extension once and clicked through: scan, compress one image, ZIP, resize, preview, side panel
- [ ] Listing, privacy and distribution tabs filled in; no warnings shown in the dashboard
- [ ] Expect review to take a few days: access to all sites triggers a closer review

## After it is published

- Watch installs, weekly users and uninstalls under the item's **Analytics** tab.
- For each update: bump `version` in `manifest.json` and `package.json` (the store rejects a version it has already seen), run `npm test`, `npm run package`, and upload the new ZIP on the **Package** tab.
- Upload the same ZIP to Edge Add-ons too, so both stores carry the same version.

## 6. Microsoft Edge Add-ons

Edge takes the same ZIP as Chrome; there is no separate Edge build. Submit at https://partner.microsoft.com/dashboard/microsoftedge (register once as an Edge developer; it is free). The listing has these parts:

**Packages:** upload `dist/image-size-checker-pro-3.4.1.zip`.

**Availability:** Public; all markets.

**Properties:**
- Category: Developer tools
- Privacy policy: the extension does not collect personal information, but give the URL anyway: https://github.com/r3hab-media/Image-Size-Checker-Pro/blob/main/PRIVACY.md
- Website: https://github.com/r3hab-media/Image-Size-Checker-Pro
- Support contact: https://github.com/r3hab-media/Image-Size-Checker-Pro/issues
- Mature content: No

**Store listings (English):**

| Field | What to use |
|---|---|
| Description (250–10,000 characters) | The same description as in section 2 |
| Extension logo (1:1, 300×300 recommended) | `store/logo-300x300.png` |
| Small promotional tile (440×280) | `store/promo-small-440x280.png` |
| Large promotional tile (1400×560) | `store/promo-marquee-1400x560.png` |
| Screenshots (1280×800) | The same three screenshots as in section 2 |
| Search terms (up to 7, 30 characters each, 21 words total) | `image optimizer`, `compress images`, `image size`, `page speed`, `resize images`, `webp`, `seo audit` |

**Notes for certification** (on the Submit page):

```
No account or sign-in is needed. To test: open any web page with images (or click "Playground" in the popup for a built-in test page), click the toolbar button, and the popup lists every image with its file size and dimensions. Click "Compress" on an image to save a smaller copy with the same filename, or "Compress & Download All Compressible to ZIP" for a batch. "Resize" appears on images larger than their display size. The side panel button docks the same report in the Edge sidebar.

The extension needs access to all sites because it audits whichever page the user chooses, and those images are often hosted on other domains (CDNs). Pages are scanned only when the user opens the extension or presses its shortcut, unless they turn on auto-scan. Nothing is sent anywhere; all processing happens locally.
```

**Before you press Publish:**
- [ ] `npm test` also passes in Edge: `CHROME_PATH="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" npm test`
- [ ] Loaded the ZIP contents unpacked in Edge once and clicked through: scan, compress, ZIP, resize, preview, side panel
- [ ] Expect certification to take up to about a week
