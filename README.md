# CEO of Agents (desktop app)

A macOS desktop app to run an AI-agent organisation, "CEO of Agents", through a chat with a chief of staff: one continuous thread with the chief of staff, department chats that end with a handoff, "Waiting on you" and "Initiatives" panels read from your hq (the git folder that holds the organisation), and an hq health indicator.

The app runs your own installed, unmodified Claude Code with your own login and never handles credentials.

Status: milestone 1. Mac only. Existing orgs only (no onboarding yet).

## Requirements
- macOS, Node.js 20 or later (to build from source).
- Claude Code installed, in the supported range (see `SUPPORTED_CLAUDE` in `src/main/config.ts`), and signed in with your own account.
- git (Apple's developer tools).
- `gh` (GitHub CLI), signed in, for in-app updates.
- An existing ceo-of-agents hq (a folder with `org.yaml` and `CLAUDE.md`).

## Install
Download the latest `.dmg` from the releases of `ceo-of-agents/ceo-of-agents-desktop` and drag "CEO of Agents" to Applications.

The app is ad-hoc signed and not notarized, so macOS Gatekeeper blocks the first open of a browser download: open it once (macOS says "Not Opened"; choose Done), then System Settings > Privacy & Security > Security > "Open Anyway" next to "CEO of Agents". Alternative in Terminal: `xattr -dr com.apple.quarantine "/Applications/CEO of Agents.app"`.

## Run from source
```sh
npm install
npm start
```

To build a local app and disk image (unsigned): `npm run package:mac`, output in `out/`.

See `CLAUDE.md` for the architecture and `CONTRIBUTING.md` for how to work on it.

## License

MIT. See [LICENSE](LICENSE).
