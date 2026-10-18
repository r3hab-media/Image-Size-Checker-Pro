# Image Size Checker Pro

A Manifest V3 Chrome extension that audits the images on a page and compresses them as **drop-in replacements**: same file format, same pixel dimensions, same filename.

## What it checks

For every `<img>`, CSS `background-image` and inline `<svg>` on the page:

- File weight vs. a budget for its displayed size and a hard cap (default 250 KB)
- Intrinsic vs. displayed resolution (oversized or upscaled images)
- Aspect-ratio distortion (or cropping via `object-fit`)
- Missing `alt` (an empty `alt=""` is treated as decorative and not flagged)
- Missing `width`/`height` (layout-shift risk) and `loading="lazy"` above the fold (LCP risk)

Results appear as badges on the page and in the 750px popup (click the toolbar button), with CSV, JSON and Markdown export. Click **⇥ Side panel** to dock it in Chrome's side panel instead, where it stays open while you browse and follows the active tab.

Pages are scanned when you open the popup or side panel, or press **Alt+Shift+I**. Turn on **Auto-scan every page I visit** in settings to scan every page automatically (this makes the extension request each page's images again).

## How compression works

| Format | What happens |
| --- | --- |
| PNG | **Lossless.** Pixels are bit-identical (including alpha and 16-bit depth). Re-filtered, re-compressed, and reduced to a palette or fewer channels when that is exact. Color chunks (ICC, gamma, EXIF orientation) are kept; text chunks are dropped. |
| SVG | **Lossless.** Comments removed; whitespace between tags removed only when no text depends on it. |
| JPEG | **High-quality lossy re-encode** (quality 82–96). ICC color profile and EXIF/XMP are kept. |
| WebP (lossy) | **High-quality lossy re-encode.** Lossless, animated, or color-profiled WebP files are left unchanged. |
| GIF, BMP, ICO, AVIF, HEIC, animated PNG | **Left unchanged.** The browser cannot re-encode these without changing the file type. |

**Allow lossy PNG** (off by default) also tries reducing PNGs to a 256-color palette with dithering, much like TinyPNG. Transparent, translucent and opaque pixels are quantized separately, so solid areas stay solid and soft edges stay soft. The result is used only when it is smaller and measures at least 36 dB PSNR against the original (visually near-identical); photo-like PNGs that would band keep the lossless result. On a 1000×1000 cartoon avatar this took a PNG from 519 KB to 164 KB, where lossless managed 510 KB.

For JPEG and WebP, **🔍 Preview** opens a before/after comparison: drag the split slider, toggle **1:1** to inspect actual pixels, and move the **Quality** slider (40–96) to see the resulting size live. **Save at quality N** saves at exactly that quality; this is the only way to go below the automatic minimum of 82.

A result is only used when it is smaller than the original; otherwise the original is reported as already optimal and nothing is saved.

After each scan, the compressible images are test-compressed in the background (your own compress and ZIP clicks always go first). **Achievable Savings** is the measured total, and each image card says whether compression will help. "Too Large" is split into *compressible* (a heavy PNG, JPEG, WebP or SVG) and *oversized px* (pixel dimensions larger than displayed, which only resizing can fix).

## Resizing for display

Compression keeps pixel dimensions. For images whose pixels are larger than they are displayed ("oversized px"), **Resize** (per image) or **Resize All Oversized** creates versions at 1x and 2x the displayed width, in the original format, named `name-<width>w.ext` (for example `logo-44w.png` and `logo-88w.png`). Images are never upscaled; if 2x would be at least the original size, the original file is used for 2x.

Each resize comes with a snippet to paste into your page, using the image's path on your site:

```html
<img src="/assets/img/photo-460w.jpg" srcset="/assets/img/photo-230w.jpg 230w, /assets/img/photo-460w.jpg 460w" sizes="230px" width="230" height="230" alt="…">
```

CSS background images get an `image-set()` snippet instead. With a target folder the files are written there; otherwise they are saved as a ZIP that includes `srcset-snippets.html`. The `sizes` value assumes a fixed display width, so adjust it for fluid layouts.

## Optional WebP copies

Tick **Also create WebP copies with `<picture>` markup** to add a `.webp` version next to each compressed or resized PNG/JPEG (kept only when it is smaller), plus markup that serves it to browsers that support WebP and falls back to the original format:

```html
<picture>
  <source type="image/webp" srcset="/assets/img/photo.webp">
  <img src="/assets/img/photo.jpg" width="230" height="230" alt="…">
</picture>
```

CSS backgrounds get `image-set()` with `type()` entries. Even an already-optimal JPEG can gain a WebP copy this way. WebP copies are converted to sRGB (they carry no color profile).

## Saving

- **Default:** each save opens the native Save-As dialog.
- **Choose Folder…** opens a small window where you pick a folder on disk (for example your site's `public/images/`). The folder is remembered until you click **Use Save-As**. If Chrome's access to the folder lapses, you are asked again or the extension falls back to Save-As.
- Existing files are not overwritten unless you tick **Overwrite files with the same name** (otherwise a copy such as `hero (1).png` is written).
- Compression runs in the background, so you can close the popup or side panel, or switch tabs, while a batch runs; reopen it on that tab to see the result.
- **Compress & Download All Compressible to ZIP** bundles every compressible image that the test run showed can shrink. Images that fail to download are listed in the status line; the rest of the batch still completes.

## Load locally in Chrome

1. Open `chrome://extensions/` and enable **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Open the extension's **Playground** button for a built-in test page.

For `file://` pages, enable **Allow access to file URLs** on the extension's details page.

## Development

`npm install` then `npm test` runs the test suite in your installed Chrome (set `CHROME_PATH` if it is not in the default location; `HEADFUL=1` shows the browser). The tests load the unpacked extension and cover the compression engine (including pixel-exact PNG checks against Chrome's own decoder), scanning, the overlay, settings, and batch ZIP export.

`npm run package` builds the Chrome Web Store upload, `dist/image-size-checker-pro-<version>.zip`, from committed runtime files only. `node scripts/store-assets.mjs` regenerates the store screenshots and promo tile in `store/`. The listing text, permission justifications and submission checklist are in [store/LISTING.md](store/LISTING.md).

## Privacy

The extension has no servers, accounts, analytics or tracking. See [PRIVACY.md](PRIVACY.md).

## Known limitations

- Images inside iframes are not scanned.
- Inline SVGs are saved as their markup only; styles applied by the page's CSS are not included.

## Credits

The popup uses [Rubik](https://github.com/googlefonts/rubik) and [Space Mono](https://github.com/googlefonts/spacemono), bundled in `fonts/` under the SIL Open Font License 1.1 (see `fonts/*-OFL.txt`).
