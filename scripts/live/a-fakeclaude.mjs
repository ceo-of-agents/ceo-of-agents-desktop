// Check 4: unsupported Claude Code version. Usage: ROOT=.. node a-fakeclaude.mjs
import fs from 'node:fs';
import { mk, open, text, shot, waitText } from './a-lib.mjs';
const d = mk(); const bin = `${d}/claude`;
fs.writeFileSync(bin, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.2.5 (Claude Code)"; exit 0; fi\nexit 1\n', { mode: 0o755 });
const { app, page } = await open({ COA_SCAN_ROOT: process.env.ROOT, CLAUDE_CONFIG_DIR: mk(), COA_CLAUDE_BIN: bin });
await waitText(page, /not supported|Before we start/);
await new Promise((r) => setTimeout(r, 3000));
console.log('C4 body:', await text(page));
await shot(page, '4-unsupported');
await app.close();
