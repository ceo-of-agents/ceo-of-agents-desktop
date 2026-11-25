# App icon

- `icon.svg`: the master, 1024 x 1024. Edit only by replacing it with a new master.
- `icon-16.svg`: the pixel-fitted 16 x 16 variant, drawn separately from the master. Used only for the 16 x 16 file (`icon_16x16.png`); the 32 px @2x and every other size come from the master. It follows any change to the master: redraw it when the master changes.
- `icon-1024.png`: render of the master. `scripts/build.mjs` copies it to `dist/` and `npm start` uses it for the Dock icon.
- `icon.icns`: all macOS sizes (16 to 1024, plus @2x), each rendered directly from an SVG (16 x 16 from `icon-16.svg`, the rest from `icon.svg`). `npm run package:mac` copies it into the app bundle.

Regenerate both after a new master: `node scripts/render-icon.mjs` (or `npm run icon`). It uses Electron's Chromium offscreen (no window, no extra dependency) and `iconutil`.
