# Live checks

Scripts that drive the built app (`npm run build` first) with Playwright's Electron driver against the real, unmodified Claude Code. They are run by hand; `npm test` does not run them.

Rules (see `CLAUDE.md`):
- Only against copies of an hq in a temp folder with the git remote removed; a local bare repo as remote for push checks. `COA_SOURCE_HQ` names the hq the `a-` scripts clone read-only.
- Always set `COA_SCAN_ROOT` (or `ROOT` / `B_ROOT`) to the temp folder holding the copies and a fresh `COA_USER_DATA` (or `B_UD`).
- Plugin install, update and sign-in only with an empty `CLAUDE_CONFIG_DIR` (`CFG`), and `BROWSER=/usr/bin/true`. Never complete a login.
- Chat checks: `COA_MODEL=haiku`, short prompts, and `COA_PLUGIN_DIR` pointing at an installed plugin folder (read-only) when the copy does not have the plugin installed for its path.
- Screenshots go to `SHOTS` (default: a temp folder).

| Script | What it checks | Uses Claude turns |
|---|---|---|
| `smoke.mjs` | the app starts, scans, shows the org view | no |
| `send-one.mjs` | one CoS message, streaming, reply | 1 |
| `crash-probe.mjs` | Settings open/close then a message, repeated (renderer stability) | `ROUNDS` |
| `a-prereqs.mjs` | prerequisites screen, plugin enabled but not installed, Install | no |
| `a-signin.mjs` | Sign in shows only Claude Code's URL, Cancel leaves no process | no |
| `a-fakeclaude.mjs` | unsupported Claude Code version message | no |
| `a-pluginver.mjs` | plugin version below the app minimum | no |
| `a-pluginsigned.mjs` | `MODE=update`: "available" label and Update; `MODE=org`: "Org update available" (plugin commands routed to an empty config, `REAL_CLAUDE` for the rest) | no |
| `a-org.mjs`, `a-org1.mjs` | org update available, two orgs, last used org reopens | no |
| `a-health.mjs` | hq health colours, auto push, Sync, behind, push failure, conflict | no |
| `b-12.mjs` | CoS header, streaming, day separator, queue | 2 |
| `b-3.mjs` | resume after restart; `DAY_BACK=1`: new session each day | 1 |
| `b-5.mjs` | permission cards: Always allow writes the rule, Deny | 2 |
| `b-67.mjs` | Waiting on you (file watch, Approve, Answer), Initiatives Close | 2 |
| `b-8.mjs` | department tab, hand over, handoff waiting badge, read-only past chat | 3 |
| `b-9.mjs` | two orgs in parallel, separate processes and logs | 2 |
