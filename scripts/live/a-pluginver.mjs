// Check 5: older installed plugin version in the empty config.
import { open, text, shot, waitText, sleep } from './a-lib.mjs';
const { app, page } = await open({ COA_SCAN_ROOT: process.env.ROOT, CLAUDE_CONFIG_DIR: process.env.CFG });
await sleep(8000);
console.log('C5 body:', await text(page));
await shot(page, '5-pluginver');
await app.close();
