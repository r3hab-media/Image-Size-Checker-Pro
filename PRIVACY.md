# Privacy Policy: Image Size Checker Pro

Last updated: October 17, 2026

Image Size Checker Pro is a browser extension that measures the images on web pages and creates smaller copies of them. This policy explains what the extension accesses and what it does with it.

## The short version

The extension does not collect, sell or share any personal data. It has no servers, no accounts, no analytics and no tracking. Everything it does happens in your browser, and everything it creates is saved to your own computer.

## What the extension accesses, and why

**The images on pages you scan.** When you open the extension (or press its keyboard shortcut, or turn on "Auto-scan every page I visit"), it reads the images on the current page: their addresses, file names, dimensions, alt text and how they are displayed. This is used only to show you the report in the extension and the badges on the page.

**The image files themselves.** To measure each image's file size and to compress or resize it, the extension downloads the image from the website that hosts it, the same way the page itself loads it. If a site only serves an image to signed-in visitors, the extension retries the request with your browser's existing cookies for that site so it can read the image. These requests go only to the sites that host the images. Nothing is sent anywhere else.

**Your settings.** Your preferences (size limit, overlay mode and similar options) are stored with the browser's extension storage on your computer. Temporary results, such as measured savings, are kept only for the current browser session.

**Your chosen folder.** If you pick a folder to save compressed images into, the browser stores a reference to that folder on your computer so the extension can save there again. You can switch back to the Save-As dialog at any time.

**Downloads.** Compressed and resized images, ZIP files and reports (CSV, JSON, Markdown) are saved only to your computer, where you choose.

## What the extension does not do

- It does not send page content, image files, browsing history or any other data to the developer or to any third party.
- It does not use analytics, advertising or tracking code.
- It does not load code from the internet; all of its code ships inside the extension.
- It does not sell or transfer data, and does not use data for anything other than the features described above.

## Permissions

- **Access to all websites:** needed to read images on whatever page you scan, and to fetch image files from any site or image host (such as a CDN) to measure and compress them.
- **scripting:** adds the image scanner to the current tab when you open the extension.
- **storage:** saves your settings on your computer.
- **downloads:** saves compressed images, ZIP files and reports to your computer.
- **sidePanel:** lets you open the extension in the browser's side panel.
- **offscreen:** runs image compression in the background so it keeps going if you close the popup.

## Changes to this policy

If the extension's handling of data changes, this policy will be updated and the "Last updated" date changed. A change that adds any data collection would be described in the extension's release notes before it ships.

## Contact

Questions about this policy: open an issue at https://github.com/r3hab-media/Image-Size-Checker-Pro/issues
