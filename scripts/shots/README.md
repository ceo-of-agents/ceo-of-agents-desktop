# Screenshot harness

Renders the real renderer UI (`dist/renderer`, built from `src/renderer`) with a mocked `window.coa` into PNGs, one per scene, 1280 x 820 at scale factor 1 (a scene may set its own `width` and `height` in `scenes.ts`; `SHOTS_SCALE=2` renders at 2x). For design review and before/after checks of a restyle. It runs no Claude Code, no git, no network and touches no real data.

## No visible window

- `main.cjs` calls `app.dock?.hide()` first thing: no Dock icon.
- Every window is `new BrowserWindow({ show: false, webPreferences: { offscreen: true, ... } })`: it is rendered to a buffer and captured with `capturePage()`; it is never shown, never takes focus. The window is destroyed after each scene.
- `userData` is a throwaway temp folder, so nothing of the real app (settings, localStorage) is read or written.
- Do not replace this with Playwright's Electron driver (`scripts/live/`): it opens visible windows.

## Run

```
SHOTS=/some/folder node scripts/shots/shoot.mjs [--no-build] [scene ...]     # or: SHOTS=... npm run shots -- [scene ...]
REDUCED=1 SHOTS=/other/folder node scripts/shots/shoot.mjs                   # prefers-reduced-motion: reduce (files end in -reduced.png)
```

- `SHOTS` (required): output folder.
- No scene names: all scenes. `--no-build`: skip `scripts/build.mjs` (use it when `dist/` is current).
- Exit code is non-zero when a scene fails (selector not found within 6 s, wrong size) or its PNG is blank (one colour).
- If a capture is blank on your machine, GPU is already disabled (`--disable-gpu`); set `SHOTS_DISABLE_GPU=0` to turn that off.

## How it works

- `scenes.ts`: scene data (placeholder names: orgs ACME, BOLT, KITE, chief of staff Ada, departments Max and Lena; the `org-chart-sample` and `org-chart-look-broken` scenes use the invented names from the `sample-org` fixture) and the DOM steps of each scene. All selectors are in the `sel` object at the top: when the UI is restyled, update them there. The UI is driven only through the `CoaApi` contract, events (`AppEvent`) and a few clicks (`click`, `waitFor`, `scroll`, `wait`, `focus`, `press`, `hover`, `select`, `type` steps). `emit` sends one more `AppEvent` at that point of the steps (through the mock's `emit`; a scene's `events` all go out 500 ms after boot, before any step). `select` sets a `<select>` value and sends a bubbling `change` (React handles it like a user pick); `type` sets an `<input>` or `<textarea>` value and sends a bubbling `input` event. `focus` presses Tab with real key events (the page is told it has focus, as the offscreen window never does); `press` sends one more real key (an Electron key code such as `Down`) after a `focus`; `hover` moves the real mouse. `files` pastes or drops files on an element with a real `ClipboardEvent` or `DragEvent` (a `DataTransfer` of `File` objects built in the page).
- localStorage is cleared before each scene, so a remembered panel state never leaks into the next one.
- `mock-api.ts`: a full `CoaApi` backed by a scene, typed against `src/shared/types.ts` (a contract change is a type error under `npm run typecheck`). Writes are no-ops that resolve. A scene's `events` are emitted 500 ms after the renderer subscribes with `onEvent`.
- `preload.ts`: exposes the mock as `window.coa` with `contextBridge`, like `src/preload.ts`. The scene comes from `--shots-scene=<name>`.
- `shoot.mjs` builds the app, bundles `preload.ts` and `scenes.ts` into `dist/shots/` and starts Electron with `main.cjs`.

## Media set (`docs/media/`)

The screenshots, GIFs and MP4 clips of the README come from the `media-*` scenes (1440 x 900 CSS px, sample org only). Run from the repo root, with `T` a scratch folder outside the repo; needs `ffmpeg` with libx264:

```
T=$(mktemp -d)
SHOTS=$T/png SHOTS_SCALE=2 node scripts/shots/shoot.mjs media-hero media-focus-view media-permission media-org-chart media-department-chat media-create-org media-approve media-dispatch
SHOTS=$T/frames SHOTS_SCALE=1 SHOTS_FRAMES=1 node scripts/shots/shoot.mjs --no-build media-approve media-dispatch
node scripts/shots/encode.mjs $T/png $T/frames docs/media [--posters <folder>]
```

- `media-hero` -> `hero.png`, `media-focus-view` -> `focus-view.png`, `media-permission` -> `permission.png`, `media-org-chart` -> `org-chart.png`, `media-department-chat` -> `department-chat.png`, `media-create-org` -> `create-org.png`.
- `media-approve` and `media-dispatch` have a `record` setting and a `timeline` (steps at fixed times, mock events through `emit`; `'@now'` and `'@now-<ms>'` in an event become the time the step runs). They give `<name>.gif`, `<name>.mp4` and `<name>-still.png` (last state at 2x). An offscreen window draws no mouse pointer, so recorded scenes draw one that follows `hover` and `click` steps.
- `encode.mjs` adds a 1 px `#334155` border, optimises the PNGs (lossless) and encodes the GIFs (15 fps, loop forever) and MP4s (H.264, yuv420p, no audio).
- Scale 2 uses the DevTools device metrics override and `Page.captureScreenshot`: an offscreen window ignores Chromium's scale switch.
- Check every output by eye before committing: only the sample org's names, no real paths or accounts.

## Scenes

| Scene | Shows |
|---|---|
| `rail-many-orgs` | 16 orgs in the rail: the list scrolls under the "My orgs" header, the app identity corner stays pinned above Settings |
| `rail-org-icon` | Org with its own icon (`company/icon.png`) in the rail, replacing the initials; the other orgs keep theirs |
| `settings-org-icon` | Settings > General with an org icon: the preview row (Choose image, Remove) and the icon in the org switcher tile |
| `thread-live` | CoS thread: Markdown reply, finished turn with a 5-step summary, running turn (Reading state.md, 3 steps) |
| `thread-table` | Two Markdown tables in a reply: short Code and Priority columns beside one long Description column (whole words in the short columns), and a wide 11-column table that scrolls sideways |
| `thread-code-wrap`, `thread-code-wrap-narrow` | CoS reply with fenced code blocks: a long prose draft, an indented snippet with a long line, a URL with no spaces; all wrap inside the bubble, no sideways scroll, text clear of the copy button. The narrow variant is 960 px wide (the app's minimum) |
| `dept-code-wrap`, `dept-code-wrap-narrow` | The same reply in Max's department chat, at 1280 and 960 px |
| `thread-done-expanded` | Same thread idle, the last activity summary expanded |
| `thread-permission` | Running turn waiting on a permission card (`git push origin feat/x`, rule proposal) |
| `thread-permission-artifact` | The same, for an Artifact publish: the plain sentence (`Publish the artifact "Weekly report"`), no rule input and no Always allow button |
| `thread-question` | Running turn waiting on a question card (one single choice with a recommended option, one multi-select) |
| `thread-streaming` | Assistant text streaming in |
| `thread-jump-latest` | Long CoS thread scrolled to the top while a reply arrives (an `emit` step): the "Jump to latest" button with its teal new-content dot |
| `thread-error` | Error plate and the "Claude Code stopped unexpectedly" plate with Start again |
| `thread-failed` | A failed turn: step list unfolded with a failed step, error plate with Try again |
| `thread-empty` | Empty CoS thread: mark, title and three suggestions |
| `thread-reply` | Reply picked on a waiting item: the chip inside the composer |
| `composer-mode` | Footer with three pickers (Model, Effort, Mode: Accept edits) |
| `composer-auto-confirm` | Mode set to Auto mode in the footer: the inline confirm (Cancel focused), the select still on the old mode |
| `settings-auto-confirm` | The same confirm in the Settings view (Permissions section) after picking the Auto mode radio |
| `composer-mode-pending` | Mode changed to Plan mode while the chat runs: the "Applies from your next message" note |
| `composer-images` | Two thumbnails (coloured rectangles, PNGs built in `scenes.ts`) pasted into the composer with their remove buttons, then a text file dropped on the box: the inline error line under it |
| `thread-image` | A user message with an image above its text in the CoS thread, and one whose image is not in the store ("Image not available") |
| `thread-handoff` | Handoff card followed by the CoS reply |
| `panel-waiting` | "Waiting on you": one item of each kind (ok high, do, decide with options a/b/c, decide without, untagged, unparsed) |
| `panel-waiting-groups` | "Waiting on you" with parent and child items: a high parent collapsed with "3 items below", a `{wait}` group heading (GROUP chip, no buttons) with "1 item below", a plain item; the header counts the asks, children included, the heading left out |
| `panel-waiting-groups-open` | The same, the first parent expanded: its three children nested under a rail, each with its own kind chip and buttons |
| `panel-hidden` | The whole side panel hidden from the top bar toggle: the toggle shows the violet badge with the waiting count |
| `panel-departments` | Departments: Max with a running chat (teal dot), Lena handing over; a closed chat shows nowhere |
| `panel-showmore` | A long waiting text expanded by "Show more" and a long initiative "Next" line still clamped to 2 lines |
| `panel-unparsed-reply` | Reply on the unparsed waiting line: the chip "Replying to:" with the raw line |
| `panel-long-options` | A decide item with option labels over 32 characters: listed as text, each with an "Option a" button |
| `waiting-focus-ok` | The focus view of "Waiting on you" opened from the header button: the first item ({ok}, high), position "1 of 5", Approve, Decline, Reply, the hint |
| `waiting-focus-child` | The focus view on a child item: "Under ACME-A4" above its text, its own Approve and Decline; the parent's slide before it said "3 items under this one" |
| `waiting-focus-decide` | The focus view on a decide item with a long card: Context (list), all three options in full with RECOMMENDED on b, Recommendation, "Proposed by Max" with the HOLDING chip, link chips (issue, host); the body scrolls under the fixed header and footer |
| `waiting-focus-empty` | The only item approved from the focus view: the empty state with a Close button, and the undo strip ("Approving ACME-A1…") in the footer |
| `panel-undo` | A waiting card 1.5 s into its 4 s undo window: "Approving…", Undo, the shrinking bar |
| `panel-lower` | Same panel scrolled down: initiatives (2 in progress, 1 on hold, 2 closed, shown) |
| `panel-initiatives` | The "Initiatives" section alone: the explainer, goal, state and next step per item, and two items (active, on hold) with "Not updated for N days" and "Ask Ada for an update" |
| `panel-initiative-view` | The title of an initiative clicked: its status page (`readInitiative`) in a dialog with a close button |
| `health-green`, `health-syncing`, `health-yellow`, `health-orange`, `health-red`, `health-diverged`, `health-askfix-sent`, `health-pushfail` | The health popover open in each state (ignored rules in a needs-sync popover, a conflict and a divergence with "Ask Ada to fix it" in red, that button disabled after a click, a failing auto push with "Try again") |
| `health-rules` | Healthy indicator, popover with the one line "8 saved permission rules are ignored", collapsed: Show and Clean up |
| `health-rules-shown` | The same list shown: "Saved on this computer" (long rule cut with an ellipsis, full text in the tooltip) and "From the hq's committed settings" with the chief of staff note and no Clean up |
| `health-rules-confirm` | The inline confirm after Clean up: "Remove 6 ignored rules from this org's local settings?", Cancel focused |
| `prereqs` | Prerequisites screen: Claude Code OK, not signed in, git OK, plugin missing |
| `empty-org` | Org with an empty thread, nothing waiting, no initiatives or departments |
| `welcome` | No orgs at all: "Create a new org" (primary) and "Open an existing org" |
| `add-menu` | The rail's "+" opened: the two-item menu ("Create a new org", "Open an existing org") |
| `create-prereqs` | "Create a new org" when the plugin data cannot be read (`setupData` returns an error): the prerequisites pattern, no steps |
| `create-step` | Step 1 of the wizard (Language and profile): step list, "Step 1 of 13", fixed footer without Back |
| `create-step-error` | Next pressed on step 1 with nothing answered: inline errors under both questions |
| `create-summary` | The Summary after answering every step by clicks and typing (a product company; the hq remote deferred): blocks with Edit, to-dos, the plugin question |
| `create-folder-not-empty` | The folder step with a folder that holds 7 entries: the error, five entries and "+2 more" |
| `create-running` | A run in progress: "Creating Acme Labs", the activity line, elapsed time, two of four milestones ticked from folder facts |
| `create-asking` | The wizard waits for an answer: its message verbatim, the reply box, Yes (primary), No, Send |
| `create-done` | "Acme Labs is ready": check list from the folder facts (plugin not installed with the command, first version saved), "Open Ada" |
| `create-failed` | "The org was not created": the wizard's text verbatim, the answers file, the terminal fallback, Try again, Back to summary |
| `loading` | Org selected, its view never resolves |
| `loading-app` | The org list never resolves (the "Loading" text) |
| `thread-handingover` | Lena's tab selected while she hands over: spinner and name in the tab, "Handing over to Ada" in the head bar |
| `focus-button`, `focus-waiting`, `focus-tab`, `focus-org` | Keyboard focus ring (focus-visible) on the head "Hand over" button, a waiting card's Approve, the first tab and the org tile. Real Tab key events (`sendInputEvent`) from the start of the page until the target has focus |
| `hover-waiting` | Real mouse move over a waiting card's Approve button |
| `org-chart` | The live org chart (opened from the top bar's Network button, side panel open): this org's shape, You, Ada working with one handoff waiting (her node shows the handoff, the higher status), Max working, Lena with a handoff waiting for Ada, the `app-look.yaml` icons and colours, the legend. The live marks are computed by the renderer from the scene's tabs and threads |
| `org-chart-0` | No departments: the dashed stem and the "No departments yet" placeholder, the shorter first legend line |
| `org-chart-8-panel`, `org-chart-8-nopanel` | 8 departments, side panel open (k = 4: rows of 4 and 4, the chip rows stay in their 200 px column, also in the last column) and closed (k = 5: rows of 4 and 4), trunk and buses, the legend on the trunk |
| `org-chart-5-panel` | 5 departments with the side panel open: k = 4, so rows of 3 and 2 |
| `org-chart-sample` | A sample org shape with invented names, read with `readOrgChart` from `test/fixtures/org-chart/sample-org/` (Ada, Max and Nora are agent personas, not people), with its `app-look.yaml` |
| `org-chart-look-broken` | The same fixture with an unparseable `app-look.yaml`, copied to a temp folder for the scene: initials on every tile and no error in the UI |
| `org-chart-chips-fold` | Helpers that do not fit the node's column: the model text is dropped first, then the extra chips fold into a "+n" chip |
| `org-chart-menu-top` | Max's node menu: its one item, "Open chat" |
| `org-chart-5` | 5 departments, panel closed: still tree mode (k = 5) |
| `org-chart-error` | `org.yaml` unreadable at first load: the error plate with the parser detail and "Ask Ada to fix it"; the side panel has no departments and says "org.yaml could not be read." |
| `org-chart-stale` | `org.yaml` unreadable after a good read: the plate pinned above the last good chart ("Showing the org as of hh:mm") |
| `org-chart-live` | Every status: Max working, Lena handing over, Nora handoff waiting, Otto chat open, Pia agent file missing; Ada's node shows her waiting handoff |
| `org-chart-focus` | Keyboard focus on Max's node (real Tab, then ArrowDown): the focus ring, the tooltip, the `···` button |
| `tabs` | CoS tab plus Max running, Lena handing over; running tab selected |
| `tab-close-dialog`, `tab-close-dialog-busy` | The x on Max's tab (not handed over): the close dialog with "Hand over to Ada" (focused), "Close without handover" and "Cancel"; the busy variant adds "Its current reply will be stopped." |
| `dispatch-running` | Department liveness: Max has one task running in the background (pulsing dot, short description, elapsed time) and a helper (`reader`) runs under Ada's node; the panel row lists the task |
| `dispatch-parallel` | Two tasks running for Max ("2 tasks working" with the oldest time on the node, one line each in the panel) and one `unknown` task for Lena ("Unknown", tooltip explains) |
| `dispatch-done` | A finished task: the toast "Max finished: ..." with its button, the done mark and the duration on the node and in the panel row |
| `settings` | The Settings view (full window, replaces the chat area): the org switcher and the sections in the 220 px left column, General selected (default effort, default CoS model, auto push, the "applies from the next message" line) |
| `settings-permissions` | Settings, Permissions: mode radios, "Allowed by this hq" (one rule marked "Ignored by the app: too broad"), "Saved with Always allow" with a Remove button on each, "Denied" from the hq and from the user, read-only |
| `settings-permissions-lower` | The same section scrolled to the bottom: the "Denied" list, hq rules and the user's own (marked as such), no buttons |
| `settings-about` | Settings, About: app, Claude Code (and its supported range), plugin installed and latest (latest unknown), the org's framework version, the hq folder |
| `settings-connectors` | Settings, Connectors: the three muted lines (requests go to the chief of staff, chats run without connectors, no user or account connectors listed), Max with two chips (one marked "not in agent file") and Lena (advisory, "Read-only tools only", none granted), "Forbidden for this org", "Available in this hq" |
| `settings-connectors-request` | The same section with Max's "Request a connector" form open: a connector picked, a reason typed, "Send to Ada" enabled |
| `settings-org-switch` | Settings opened on the second of the three orgs (ACME, BOLT, KITE; the main window's org is BOLT): the switcher shows BOLT and General shows that org's own values |
| `composer-model-resolved` | Footer under the composer reads "Model: Opus 5.5" (the resolved id from the init message; the full id is in the tooltip). A native menu does not render in shots, so the option list is covered by unit tests |
| `settings-model-pinned` | Settings, General, with a model pinned as the org default: the note reads "Pinned for this org: Opus 5.5" |
| `toast` | A notice toast (the handoff toast) |
| `rail` | Three orgs in the rail, second active with badge 3, third unavailable |
