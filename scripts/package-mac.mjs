// Local, unsigned Mac build: out/CEO of Agents.app and out/CEO of Agents-<version>.dmg. No dependencies.
// The app is ad-hoc signed only (editing the bundle breaks Electron's signature and Apple Silicon refuses
// unsigned binaries). This is NOT a Developer ID signature and the app is not notarized.
// The main executable and the helper apps keep their Electron names: Electron finds its helpers by name.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const APP_NAME = 'CEO of Agents';
const BUNDLE_ID = 'io.github.iamgiolaga.ceo-of-agents';
const ICON_SOURCE = 'assets/icon/icon.icns';

const sh = (cmd, args, stdio = 'inherit') => execFileSync(cmd, args, { stdio });
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

const electronApp = 'node_modules/electron/dist/Electron.app';
if (!existsSync(electronApp)) {
  throw new Error('node_modules/electron/dist/Electron.app is missing. Run: node node_modules/electron/install.js');
}
if (!existsSync(ICON_SOURCE)) throw new Error(`${ICON_SOURCE} is missing. Run: node scripts/render-icon.mjs`);

console.log('1/6 build');
sh('node', ['scripts/build.mjs']);

const out = 'out';
const appDir = join(out, `${APP_NAME}.app`);
const contents = join(appDir, 'Contents');
const resources = join(contents, 'Resources');
rmSync(appDir, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

console.log('2/6 copy Electron.app and the app');
sh('ditto', [electronApp, appDir]);
const appRes = join(resources, 'app');
mkdirSync(appRes, { recursive: true });
cpSync('dist', join(appRes, 'dist'), { recursive: true });
writeFileSync(
  join(appRes, 'package.json'),
  JSON.stringify({ name: pkg.name, productName: pkg.productName ?? APP_NAME, version: pkg.version, main: pkg.main }, null, 2) + '\n',
);

console.log('3/6 icon');
rmSync(join(resources, 'electron.icns'), { force: true });
cpSync(ICON_SOURCE, join(resources, 'icon.icns'));

console.log('4/6 Info.plist');
const plist = join(contents, 'Info.plist');
const set = (key, value) => sh('plutil', ['-replace', key, '-string', value, plist]);
set('CFBundleName', APP_NAME);
set('CFBundleDisplayName', APP_NAME);
set('CFBundleIdentifier', BUNDLE_ID);
set('CFBundleShortVersionString', pkg.version);
set('CFBundleVersion', pkg.version);
set('CFBundleIconFile', 'icon.icns');

console.log('5/6 ad-hoc sign (not a Developer ID signature)');
sh('codesign', ['--force', '--deep', '--sign', '-', appDir]);
sh('codesign', ['--verify', '--deep', '--strict', appDir]);

console.log('6/6 disk image (unsigned)');
const staging = join(out, 'dmg-staging');
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
sh('ditto', [appDir, join(staging, `${APP_NAME}.app`)]);
symlinkSync('/Applications', join(staging, 'Applications'));
const dmg = join(out, `${APP_NAME}-${pkg.version}.dmg`);
rmSync(dmg, { force: true });
sh('hdiutil', ['create', '-volname', APP_NAME, '-srcfolder', staging, '-ov', '-format', 'UDZO', dmg]);
rmSync(staging, { recursive: true, force: true });

console.log(`done:\n  ${appDir}\n  ${dmg}`);
