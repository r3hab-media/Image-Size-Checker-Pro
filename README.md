# Image Size Checker Pro

A Manifest V3 Chrome extension that audits the images on a page and compresses them as **drop-in replacements**: same file format, same pixel dimensions, same filename.

## What it checks

For every `<img>`, CSS `background-image` and inline `<svg>` on the page:

- File weight vs. a budget for its displayed size and a hard cap (default 250 KB)
- Intrinsic vs. displayed resolution (oversized or upscaled images)
- Aspect-ratio distortion (or cropping via `object-fit`)
- Missing `alt` (an empty `alt=""` is treated as decorative and not flagged)
- Missing `width`/`height` (layout-shift risk) and `loading="lazy"` above the fold (LCP risk)

Results appear as badges on the page and in the popup, with CSV, JSON and Markdown export.

Pages are scanned when you open the popup or press **Alt+Shift+I**. Turn on **Auto-scan every page I visit** in settings to scan every page automatically (this makes the extension request each page's images again).

## How compression works

| Format | What happens |
| --- | --- |
| PNG | **Lossless.** Pixels are bit-identical (including alpha and 16-bit depth). Re-filtered, re-compressed, and reduced to a palette or fewer channels when that is exact. Color chunks (ICC, gamma, EXIF orientation) are kept; text chunks are dropped. |
| SVG | **Lossless.** Comments removed; whitespace between tags removed only when no text depends on it. |
| JPEG | **High-quality lossy re-encode** (quality 82–96). ICC color profile and EXIF/XMP are kept. |
| WebP (lossy) | **High-quality lossy re-encode.** Lossless, animated, or color-profiled WebP files are left unchanged. |
| GIF, BMP, ICO, AVIF, HEIC, animated PNG | **Left unchanged.** The browser cannot re-encode these without changing the file type. |

A result is only used when it is smaller than the original; otherwise the original is reported as already optimal and nothing is saved.

## Saving

- **Default:** each save opens the native Save-As dialog.
- **Choose Folder…** opens a small window where you pick a folder on disk (for example your site's `public/images/`). The folder is remembered until you click **Use Save-As**. If Chrome's access to the folder lapses, you are asked again or the extension falls back to Save-As.
- Existing files are not overwritten unless you tick **Overwrite files with the same name** (otherwise a copy such as `hero (1).png` is written).
- **Compress & Download All Too Large to ZIP** bundles every flagged image. Images that fail to download, or that are already optimal, are skipped and listed in the status line; the rest of the batch still completes.

## Load locally in Chrome

1. Open `chrome://extensions/` and enable **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Open the extension's **Playground** button for a built-in test page.

For `file://` pages, enable **Allow access to file URLs** on the extension's details page.

## Development

`npm install` then `npm test` runs the test suite in your installed Chrome (set `CHROME_PATH` if it is not in the default location; `HEADFUL=1` shows the browser). The tests load the unpacked extension and cover the compression engine (including pixel-exact PNG checks against Chrome's own decoder), scanning, the overlay, settings, and batch ZIP export.

## Known limitations

- Keep the popup open while a batch is compressing; closing it stops the batch.
- Images inside iframes are not scanned.
- Inline SVGs are saved as their markup only; styles applied by the page's CSS are not included.
