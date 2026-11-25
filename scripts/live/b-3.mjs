// Check 3: relaunch with same user data; thread reloads; resume answers from context. Also check 4 when DAY_BACK=1.
import { start, send, shot, body, waitIdle } from './b-lib.mjs';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
const sess = () => execSync(`cat ${process.env.B_UD}/orgs/*/sessions.json`).toString().replace(/\s+/g, ' ');
console.log('SESSIONS before:', sess());
const { app, page } = await start();
console.log('RELOADED BODY:\n' + (await body(page)));
await shot(page, process.env.SHOT_NAME + '-reloaded');
await send(page, process.env.MSG);
console.log('idle:', await waitIdle(page));
console.log('BODY AFTER:\n' + (await body(page)));
await shot(page, process.env.SHOT_NAME + '-after');
console.log('SESSIONS after:', sess());
await app.close();
