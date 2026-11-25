// Renders assets/icon/icon.svg to icon-1024.png and icon.icns with Electron's Chromium (no extra dependency).
// Every size is drawn straight from an SVG: the 16 x 16 size from the pixel-fitted assets/icon/icon-16.svg (drawn at its
// own size, never downsampled), every other size from the master. No window is ever shown. Usage: node scripts/render-icon.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const SVG = resolve('assets/icon/icon.svg');
const SVG_16 = resolve('assets/icon/icon-16.svg');
const OUT_1024 = resolve('assets/icon/icon-1024.png');
const OUT_ICNS = resolve('assets/icon/icon.icns');
const ICONSET = [
  [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'], [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'], [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
];

if (process.versions.electron) {
  // Electron main process.
  const { app, BrowserWindow } = await import('electron');
  const { readFileSync, writeFileSync: write } = await import('node:fs');
  app.dock?.hide();
  app.whenReady().then(async () => {
    const jobs = JSON.parse(process.env.ICON_JOBS); // [{ size, file, svg }]
    const win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { offscreen: true } });
    await win.loadURL('data:text/html,<html></html>');
    for (const { size, file, svg } of jobs) {
      const dataUrl = 'data:image/svg+xml;base64,' + readFileSync(svg).toString('base64');
      const png = await win.webContents.executeJavaScript(`new Promise((ok, fail) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas'); c.width = c.height = ${size};
          const g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
          g.drawImage(img, 0, 0, ${size}, ${size}); ok(c.toDataURL('image/png'));
        };
        img.onerror = () => fail(new Error('svg load failed'));
        img.src = ${JSON.stringify(dataUrl)};
      })`);
      write(file, Buffer.from(png.split(',')[1], 'base64'));
    }
    app.quit();
  }).catch((e) => { console.error(e); app.exit(1); });
} else {
  for (const f of [SVG, SVG_16]) if (!existsSync(f)) throw new Error(`${f} is missing`);
  const electron = createRequire(import.meta.url)('electron'); // path to the binary
  const tmp = mkdtempSync(join(tmpdir(), 'coa-icon-'));
  try {
    const iconset = join(tmp, 'icon.iconset');
    mkdirSync(iconset);
    // Only the 16 x 16 file takes the pixel-fitted variant; its @2x (32 px) keeps the master.
    const jobs = ICONSET.map(([size, name]) => ({ size, file: join(iconset, name), svg: name === 'icon_16x16.png' ? SVG_16 : SVG }));
    jobs.push({ size: 1024, file: OUT_1024, svg: SVG });
    const self = resolve(process.argv[1]);
    execFileSync(electron, [self], { stdio: 'inherit', env: { ...process.env, ICON_JOBS: JSON.stringify(jobs) } });
    for (const j of jobs) if (!existsSync(j.file)) throw new Error(`render failed: ${j.file}`);
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', OUT_ICNS]);
    console.log(`wrote ${OUT_1024}\nwrote ${OUT_ICNS}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
