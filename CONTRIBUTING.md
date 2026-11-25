# Contributing

1. Read `CLAUDE.md` (stack, layout, hard rules).
2. Branch from `main`; keep changes small.
3. Run `npm run check` (eslint, type check, unit tests). Everything must be green.
4. Live checks against Claude Code: only on a copy of an hq in a temp folder with the git remote removed, with `COA_USER_DATA` set to a temp folder and `COA_MODEL=haiku`. Plugin install, update and sign-in only with an empty `CLAUDE_CONFIG_DIR`.
5. Before committing fixtures, scrub personal data (paths, names, ids) and grep for it.
6. Commit messages: `<type>: short message`. Open a PR to `main` that says what and why, with a short demo script.
