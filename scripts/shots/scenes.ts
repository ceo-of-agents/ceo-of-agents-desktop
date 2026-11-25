// Scene data for the screenshot harness. Placeholder names only (orgs ACME, BOLT, KITE; chief of staff Ada;
// departments Max and Lena). The DOM steps (clicks) of each scene live next to its data, selectors in `sel` below:
// when the UI is restyled, update the selectors here and nowhere else.
import type {
  AboutInfo, AppEvent, ConnectorsInfo, Department, Dispatch, DepartmentLook, OrgChart, OrgChartDepartment, OrgChartLive, OrgChartWorker, HealthStatus, Initiative, OrgId, OrgSummary, OrgView, PermissionRules, PlanUsage, PrereqStatus, Settings, TabInfo, Tip, ThreadEntry, ThreadInfo, WaitingEntry,
} from '../../src/shared/types';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { readOrgChart } from '../../src/main/hq/org-chart';
import { t, tn } from '../../src/shared/strings';
import { EMPTY_FACTS, type SetupFacts, type SetupFolderPick } from '../../src/shared/setup';

// ---------- selectors (one place) ----------

export const sel = {
  healthButton: 'button[aria-label^="hq health"]',
  settingsButton: 'button[aria-label="Settings"]',
  appIdentity: '.app-identity',
  activitySummary: '.step-summary',
  replyButton: 'button',
  tab: '[role="tab"]',
  tabClose: '.tab-close',
  alertDialog: '[role="alertdialog"]',
  showMore: '.show-more',
  closedInitiativesToggle: '.group-toggle',
  panelToggle: '.panel-toggle',
  waitingApprove: '.item.waiting .btn.you',
  groupToggle: '.w-group > .group-toggle',
  focusNext: 'button[aria-label="Next item"]',
  unparsedReply: '.item.unparsed .btn',
  popover: '[role="dialog"]',
  toast: '.toast',
  permissionCard: '.card.permission',
  questionCard: '.card.question',
  live: '.turn-activity.live',
  composer: '.composer textarea',
  replyChip: '.reply-chip',
  prereqs: '.mark20',
  welcome: '.welcome',
  settingsView: '.settings-view',
  settingsTab: '.settings-tab',
  sidePanel: '.side-panel',
  orgIcon: '.org-icon',
  headButton: '.thread-head .btn',
  chartToggle: '.topbar button[aria-label="Open org chart"]',
  orgChart: '.org-chart',
  chartNode: '.oc-node',
  threadBody: '.thread-body',
  threadRow: '.thread-body .row-wrap[data-kind="assistant"]',
  jumpDot: '.jump-dot',
  focusOpen: 'button[aria-label="Open focus view"]',
  focusSheet: '.fv-sheet',
};

/** A DOM step. `click` waits for the element (matching `selector`, whose text or aria-label contains `text`) and clicks it. */
export type Step =
  | { click: { selector: string; text?: string; index?: number } }
  | { waitFor: string }
  | { scroll: { selector: string; to: 'top' | 'bottom' } }
  /** Presses Tab (real key events) from the start of the page until an element matching `selector` (and `text`) has keyboard focus. */
  | { focus: { selector: string; text?: string } }
  /** Moves the real mouse over the element (centre of the first match). */
  | { hover: { selector: string; text?: string } }
  /** Presses one key with real key events (an Electron key code such as 'Down' or 'Right'); focus must already be in the page, for example after a `focus` step. */
  | { press: string }
  /** Picks `value` in a <select> (React sees a change event). */
  | { select: { selector: string; value: string; index?: number } }
  /** Pastes or drops files on the element, as a user would (a real ClipboardEvent or DragEvent carrying File objects). `data` is base64. */
  | { files: { event: 'paste' | 'drop'; selector: string; items: Array<{ name: string; type: string; data: string }> } }
  /** Types `value` into an <input> (React sees an input event). */
  | { type: { selector: string; value: string; index?: number } }
  /** Sends one more event to the renderer, at this point of the steps (the scene's `events` all go out 500 ms after boot). */
  | { emit: AppEvent }
  | { wait: number };

export interface SceneState {
  orgs: OrgSummary[];
  activeOrgId: OrgId | null;
  views: Record<OrgId, OrgView>;
  /** Keyed `${orgId}|${threadId}`. */
  threads: Record<string, ThreadInfo>;
  tabs: Record<OrgId, TabInfo[]>;
  prereq: PrereqStatus;
  health: HealthStatus;
  settings: Settings;
  /** Settings of an org that differ from `settings` (`getSettings(orgId)`). */
  settingsByOrg?: Record<OrgId, Settings>;
  /** Permission rules (`getPermissionRules`), per org; none: empty lists. */
  rules?: Record<OrgId, PermissionRules>;
  /** Plan usage shown in the top bar (null or absent: "Usage unknown"). */
  usage?: PlanUsage | null;
  /** About (`getAbout`), per org; none: a plain default. */
  about?: Record<OrgId, AboutInfo>;
  /** Connectors (`getConnectors`), per org; none: empty lists. */
  connectors?: Record<OrgId, ConnectorsInfo>;
  /** Status pages for the readable view (`readInitiative`), keyed `<orgId>|<slug>`; none: not found. */
  initiativeFiles?: Record<string, string>;
  /** The listed call never resolves. */
  /** The org chart per org (`getOrgChart`); the live part is recomputed by the renderer from tabs and threads. */
  charts?: Record<OrgId, { chart: OrgChart; live: OrgChartLive }>;
  hang?: { listOrgs?: boolean; activateOrg?: boolean };
  /** The chief of staff's dispatches per org (`getDispatches`). */
  dispatches?: Record<OrgId, Dispatch[]>;
  /** Org icons by org, as data: URLs (`getOrgIcon`); the org's `iconStamp` must be set for the app to ask. */
  orgIcons?: Record<OrgId, string>;
  /** Images by id, as data: URLs (`getImage`). */
  images?: Record<string, string>;
  /** "Create a new org": what `setupData` and `pickSetupFolder` return (default: the plugin sample and an empty folder). */
  setup?: { dataError?: string; pick?: SetupFolderPick };
  /** The contextual tip (`getTips`) shown under Departments in the side panel (none: no tip, no box). */
  tip?: Tip | null;
}

export interface Scene {
  name: string;
  state: SceneState;
  /** Events emitted to onEvent listeners shortly after the renderer subscribes. */
  events?: AppEvent[];
  steps: Step[];
  /** Wait after the last step before the capture (ms); default set by the harness. */
  settleMs?: number;
  /** Window size in px (default 1280 x 820). */
  width?: number;
  height?: number;
  /**
   * A timed sequence (the animated media). `steps` run first and set the first state; then `timeline` plays in real time,
   * each step at `at` ms after the first frame, for `durationMs`. With SHOTS_FRAMES=1 the harness writes raw frames at `fps`
   * (see main.cjs, recordScene); without it, the last state is captured as one PNG, as for any scene.
   * A drawn mouse pointer glides to the targets of `hover` and `click` steps; `cursorStart` is where it begins (CSS px).
   */
  record?: { fps: number; durationMs: number; cursorStart?: [number, number] };
  timeline?: Array<{ at: number; step: Step }>;
}

// ---------- building blocks ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer): number => {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A small PNG of one colour, built here: the scenes never use a real screenshot. */
function solidPng(width: number, height: number, [r, g, b]: [number, number, number], pixel?: (x: number, y: number) => [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const raw = pixel
    ? Buffer.concat(Array.from({ length: height }, (_, y) => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, (_, x) => pixel(x, y)).flat())])))
    : Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const pngBase64 = (w: number, h: number, rgb: [number, number, number]): string => solidPng(w, h, rgb).toString('base64');

/** A made-up org icon: a violet square with a light disc and a dark centre, 256 px like the stored icon. */
const orgIconUrl = (): string => {
  const n = 256;
  const png = solidPng(n, n, [124, 92, 220], (x, y) => {
    const d = Math.hypot(x - n / 2, y - n / 2);
    if (d < 40) return [30, 27, 46];
    if (d < 96) return [236, 232, 250];
    return [124, 92, 220];
  });
  return `data:image/png;base64,${png.toString('base64')}`;
};

const ORG: OrgId = 'acme';
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;
const DAY = 86_400_000;
const dayStr = (daysAgo: number): string => {
  const d = new Date(Date.now() - daysAgo * DAY);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const orgSummary = (id: string, name: string, patch: Partial<OrgSummary> = {}): OrgSummary => ({
  id, path: `/tmp/${id}-hq`, name, cosName: 'Ada', waitingCount: 0, lastOpened: ago(MIN), available: true, iconStamp: null, ...patch,
});

const departments: Department[] = [
  { id: 'engineering', agent: 'max', persona: 'Max', role: 'Engineering' },
  { id: 'design-brand', agent: 'lena', persona: 'Lena', role: 'Design and brand' },
];

const emptyView = (org: OrgSummary, patch: Partial<OrgView> = {}): OrgView => ({
  org, departments: [], waiting: [], initiatives: [], frameworkVersion: '0.20.0', ...patch,
});

const initiative = (slug: string, title: string, state: Initiative['state'], daysAgo: number, nextStep: string): Initiative => ({
  slug, title, state, updated: dayStr(daysAgo), goal: `${title}: the goal in one line, long enough to be cut by the width of the side panel`, stateText: `${title} is moving: the first step is done and the second is under way.`, nextStep,
});

const initiatives: Initiative[] = [
  initiative('onboarding-flow', 'Onboarding flow for new orgs', 'active', 1, 'Max opens the PR for the welcome screen'),
  initiative('brand-refresh', 'Brand refresh', 'active', 3, 'Lena shares the new palette for review'),
  initiative('docs-cleanup', 'Docs cleanup', 'paused', 9, 'Resume after the release'),
  initiative('first-release', 'First release', 'done', 14, ''),
  initiative('old-landing', 'Old landing page', 'dropped', 30, ''),
];

const waitingFull: WaitingEntry[] = [
  { code: 'ACME-A1', kind: 'A', urgency: 'high', action: 'ok', escalate: false, since: dayStr(0), text: 'Merge pull request #12 (welcome screen) on acme/app.' },
  { code: 'ACME-A2', kind: 'A', urgency: 'normal', action: 'do', escalate: false, since: dayStr(3), text: 'Create the `acme/site` repository on GitHub and send us the link.' },
  {
    code: 'ACME-D1', kind: 'D', urgency: 'normal', action: 'decide', escalate: false, since: dayStr(12),
    text: 'Which hosting plan for the docs site?',
    options: [
      { key: 'a', label: 'Free tier, custom domain later' },
      { key: 'b', label: 'Paid tier now' },
      { key: 'c', label: 'Self-host on the team server' },
    ],
  },
  { code: 'ACME-D2', kind: 'D', urgency: 'low', action: 'decide', escalate: false, since: dayStr(3), text: 'Should the newsletter be weekly or monthly?' },
  { code: 'ACME-A3', kind: 'A', urgency: null, action: null, escalate: false, since: dayStr(0), text: 'Review the draft of the launch post.' },
  { unparsed: '- Something the app could not read as an item' },
];

/** Parent and child items: a parent with three children, a {wait} group heading with one, and a plain item. */
const waitingGroups: WaitingEntry[] = [
  { code: 'ACME-A4', kind: 'A', urgency: 'high', action: 'ok', escalate: false, since: dayStr(5), text: 'Launch the beta once the items below are done.' },
  { code: 'ACME-A5', kind: 'A', urgency: 'normal', action: 'ok', escalate: false, since: dayStr(5), parent: 'ACME-A4', text: 'Approve the store copy in `docs/beta-copy.md`.' },
  {
    code: 'ACME-D4', kind: 'D', urgency: 'normal', action: 'decide', escalate: false, since: dayStr(4), parent: 'ACME-A4',
    text: 'Decide the beta price, see decision queue.',
    options: [{ key: 'a', label: 'Free during the beta' }, { key: 'b', label: '5 euro a month' }],
  },
  { code: 'ACME-A6', kind: 'A', urgency: 'low', action: 'do', escalate: false, since: dayStr(2), parent: 'ACME-A4', text: 'Send the invite list to the first ten testers.' },
  { code: 'ACME-D3', kind: 'D', urgency: 'normal', action: 'wait', escalate: false, since: dayStr(9), text: 'Pricing model decided (decision 0012); follow-ups below.' },
  { code: 'ACME-A7', kind: 'A', urgency: 'low', action: 'do', escalate: false, since: dayStr(1), parent: 'ACME-D3', text: 'Update the price in the store console, Pricing > Edit.' },
  { code: 'ACME-A8', kind: 'A', urgency: 'normal', action: 'do', escalate: false, since: dayStr(3), text: 'Create the `acme/site` repository on GitHub and send us the link.' },
];

const tab = (tabId: string, agent: string, persona: string, role: string, patch: Partial<TabInfo> = {}): TabInfo => ({
  tabId, orgId: ORG, agent, persona, role, status: 'open', openedAt: ago(2 * DAY), closedAt: null, notePath: null, pendingWork: false, ...patch,
});

const entry = (id: string, kind: ThreadEntry['kind'], text: string, agoMs: number, patch: Partial<ThreadEntry> = {}): ThreadEntry => ({
  id, kind, author: kind === 'user' ? 'You' : kind === 'assistant' ? 'Ada' : '', text, time: ago(agoMs), ...patch,
});

const cosThread = (patch: Partial<ThreadInfo> = {}): ThreadInfo => ({
  orgId: ORG, threadId: 'cos', busy: false, handoffsWaiting: 0, activity: null,
  model: 'opus', effort: 'high', runChoice: { model: null, effort: null }, runDefaults: { model: 'opus', effort: 'high' }, modelTiers: ['opus', 'sonnet', 'haiku'], permissionMode: 'default',
  title: 'Ada (Chief of Staff)', speaker: 'Ada', entries: [], streaming: '', ...patch,
});

const tabThread = (tabId: string, who: string, role: string, patch: Partial<ThreadInfo> = {}): ThreadInfo => ({
  ...cosThread(), threadId: `tab:${tabId}`, title: `${who} (${role})`, speaker: who, ...patch,
});

const prereqOk: PrereqStatus = {
  claude: { found: true, path: '/usr/local/bin/claude', version: '2.1.330', supported: true, range: '>=2.1.326 <2.2.0' },
  signedIn: true,
  git: { found: true, version: '2.45.0', devToolsMissing: false },
  plugin: {
    state: 'ok', installed: '0.20.0', latest: '0.20.0', updateAvailable: false, hqFrameworkVersion: '0.20.0', orgUpdateAvailable: false,
    belowMinimum: false, minimum: '0.14.0', latestCheckFailed: false, dev: false,
  },
  checkedAt: ago(MIN),
};

const healthGreen: HealthStatus = {
  color: 'green', sentence: t('health.green'), hasRemote: true, ahead: 0, behind: 0, lastSyncAt: ago(5 * MIN),
  autoPushFailing: false, syncing: false, pushError: null,
};

const settingsBase: Settings = {
  permissionMode: 'default', permissionModeSource: 'hq-local', effort: 'high', effortSource: 'default', model: null, cosModel: 'opus',
  cosModelSource: 'org-yaml', orgYamlModel: 'opus', modelTiers: ['opus', 'sonnet', 'haiku'], seenModels: [], autoPush: true, newSessionAfterMinutes: 30, renewSessionAtTokens: 100000, tips: true,
};

const sampleRules: PermissionRules = {
  hqAllow: [
    { rule: 'Bash(npm test)', dropped: false },
    { rule: 'Edit(/docs/**)', dropped: false },
    { rule: 'Read(/docs/**)', dropped: false },
    { rule: 'Bash(rm *)', dropped: true },
  ],
  savedAllow: [
    { rule: 'Bash(git push origin feat/x)', dropped: false },
    { rule: 'Bash(npm run build *)', dropped: false },
  ],
  deny: [
    { rule: 'Bash(git push --force *)', source: 'hq' },
    { rule: 'Edit(/.env)', source: 'hq' },
    { rule: 'Bash(curl *)', source: 'user' },
  ],
};

/** One org (ACME), CoS thread given, panel filled with a few items. */
function base(thread: ThreadInfo, patch: Partial<SceneState> = {}, viewPatch: Partial<OrgView> = {}): SceneState {
  const acme = orgSummary(ORG, 'ACME');
  return {
    orgs: [acme],
    activeOrgId: ORG,
    views: { [ORG]: emptyView(acme, { departments, waiting: waitingFull.slice(0, 3), initiatives: initiatives.slice(0, 3), ...viewPatch }) },
    threads: { [`${ORG}|cos`]: thread },
    tabs: { [ORG]: [] },
    prereq: prereqOk,
    health: healthGreen,
    settings: settingsBase,
    ...patch,
  };
}

// ---------- the CoS conversation used by the thread scenes ----------

const replyMd = [
  'Here is where things stand on the **onboarding flow**:',
  '',
  'The welcome screen is ready for review. What is left:',
  '',
  '- Max opens the pull request for the welcome screen',
  '- Lena checks the copy against the voice rules in `company/voice.md`',
  '- You decide the hosting plan (see ACME-D1)',
  '',
  'The check Max runs before every PR looks like this:',
  '',
  '```sh',
  'npm run check',
  'git push origin feat/welcome',
  '```',
  '',
  'More detail is in the [roadmap notes](https://example.com/acme/roadmap).',
].join('\n');

const finishedTurn: ThreadEntry[] = [
  entry('e1', 'user', 'Where are we on the onboarding flow?', 30 * MIN),
  entry('e2', 'activity', t('activity.summary', { count: 5, time: '38 s' }), 29 * MIN, {
    steps: [
      { text: 'Reading state.md', detail: 'Read · company/state.md', durationMs: 1_000 },
      { text: 'Reading status.md', detail: 'Read · initiatives/onboarding-flow/status.md', durationMs: 2_000 },
      { text: 'Running a command', detail: 'Bash · git log', durationMs: 9_000 },
      { text: 'Checking GitHub', detail: 'Bash · gh issue', durationMs: 18_000 },
      { text: 'Searching the hq', detail: 'Grep · onboarding', durationMs: 8_000 },
    ],
    durationMs: 38_000,
  }),
  entry('e3', 'assistant', replyMd, 29 * MIN + 1000),
];

const runningEntries: ThreadEntry[] = [
  ...finishedTurn,
  entry('e4', 'user', 'Thanks. Anything blocking Lena this week?', 2 * MIN),
];

// Two Markdown tables: short columns beside one long text column (whole words must stay whole), and a table wider
// than the thread (it scrolls sideways instead of breaking words).
const tablesMd = [
  'Open items by code:',
  '',
  '| Code | Priority | Description |',
  '| --- | --- | --- |',
  '| ACME-A12 | normal | Merge the welcome screen pull request after Lena checks the copy against the voice rules, then tell the team in the weekly update so nobody is surprised by the new onboarding flow. |',
  '| ACME-D3 | high | Decide the hosting plan for the docs site before the release, because the custom domain needs a few days to be set up. |',
  '| ACME-A7 | low | Archive the old landing page. |',
  '',
  'And a wider one that does not fit the thread:',
  '',
  '| Code | Owner | Status | Priority | Opened | Updated | Due | Branch | Reviewer | Environment | Notes |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  '| ACME-A12 | Max | in review | normal | 2026-01-05 | 2026-01-09 | 2026-01-15 | feat/welcome-screen | Lena | staging | Waiting for the copy check |',
  '| ACME-D3 | Ada | open | high | 2026-01-06 | 2026-01-08 | 2026-01-12 | none | Max | production | Needs a decision |',
].join('\n');

// ---------- scenes ----------

const thread = (info: ThreadInfo): SceneState => base(info);

const healthScene = (name: string, health: HealthStatus): Scene => ({
  name,
  state: base(cosThread({ entries: finishedTurn }), { health }),
  steps: [{ click: { selector: sel.healthButton } }, { waitFor: sel.popover }],
});

const permissionRequest: AppEvent = {
  type: 'permission',
  request: {
    requestId: 'req-1', orgId: ORG, threadId: 'cos', toolName: 'Bash', input: { command: 'git push origin feat/x' },
    summary: 'Run: git push origin feat/x', rule: 'Bash(git push origin feat/x)',
  },
};

// What the main process builds for an Artifact publish: a plain summary and no "Always allow" proposal.
const artifactPermissionRequest: AppEvent = {
  type: 'permission',
  request: {
    requestId: 'req-2', orgId: ORG, threadId: 'cos', toolName: 'Artifact',
    input: { action: 'publish', file_path: '/work/report.html', title: 'Weekly report', icon: 'code' },
    summary: 'Publish the artifact "Weekly report"', rule: '',
  },
};

const questionRequest: AppEvent = {
  type: 'permission',
  request: {
    requestId: 'req-2', orgId: ORG, threadId: 'cos', toolName: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: 'Which release channel should the new build go to?', header: 'Channel', multiSelect: false,
          options: [
            { label: 'Beta (Recommended)', description: 'Testers get it first, easy to roll back' },
            { label: 'Stable', description: 'Everyone gets it right away' },
            { label: 'Internal only', description: 'Keep it to the team for now' },
          ],
        },
        {
          question: 'Which checks should run before it ships?', header: 'Checks', multiSelect: true,
          options: [
            { label: 'Lint', description: 'Style and type errors' },
            { label: 'Tests', description: 'The full test suite' },
            { label: 'Screenshots', description: 'Compare the main screens' },
          ],
        },
      ],
    },
    summary: 'Which release channel should the new build go to? (+1 more)', rule: '',
  },
};

const codeWrapMd = [
  'Here is the draft for the team update:',
  '',
  '```',
  'Hi team, quick update from ACME. The welcome screen is ready for review and Lena has checked the copy against the voice rules, so nothing blocks the release on the design side any more.',
  'Max will merge the pull request once the tests pass, and Ada will send the weekly summary to everyone on Friday, including the open decisions that still need an answer before the next planning session.',
  'If anything looks wrong, reply to this message and we will fix it before the end of the week, without waiting for the next release window to come around.',
  '```',
  '',
  'And the snippet:',
  '',
  '```ts',
  'function describeOpenItems(items: Item[]) {',
  '    if (items.length > 0) {',
  "        return items.map((item) => `${item.code} (${item.priority}): ${item.description} - owner ${item.owner}, due ${item.due}`).join('\\n');",
  '    }',
  '    return "";',
  '}',
  '```',
  '',
  'And a link with no spaces:',
  '',
  '```',
  'https://acme.example.com/docs/releases/2026/11/welcome-screen/review/checklist/ada-max-lena/final-copy-and-voice-rules-v2/index.html?ref=weekly-update&utm_source=thread&utm_medium=chat',
  '```',
].join('\n');

export function buildScenes(): Scene[] {
  const scenes: Scene[] = [];

  scenes.push({
    name: 'thread-live',
    state: {
      ...thread(cosThread({
        entries: runningEntries, busy: true,
        activity: { startedAt: ago(42_000), current: 'Reading state.md', steps: 3 },
      })),
      tip: { id: 'resume', text: 'Back after a pause? Ask for a summary of where things stand.', phrase: 'Resume' },
    },
    steps: [{ waitFor: sel.live }],
  });

  scenes.push({
    name: 'thread-table',
    state: thread(cosThread({ entries: [entry('t1', 'user', 'List the open items.', 3 * MIN), entry('t2', 'assistant', tablesMd, 2 * MIN)] })),
    steps: [{ wait: 400 }],
  });

  // Long lines in fenced code blocks wrap inside the bubble: prose, an indented snippet, a token with no spaces.
  // The narrow variants use the app's minimum window width (960 px, `minWidth` in src/main/index.ts).
  const codeWrapCos = thread(cosThread({ entries: [entry('t1', 'user', 'Draft the team update.', 3 * MIN), entry('t2', 'assistant', codeWrapMd, 2 * MIN)] }));
  const codeWrapDept = base(cosThread({ entries: finishedTurn }), {
    tabs: { [ORG]: [tab('t1', 'max', 'Max', 'Engineering')] },
    threads: {
      [`${ORG}|cos`]: cosThread({ entries: finishedTurn }),
      [`${ORG}|tab:t1`]: tabThread('t1', 'Max', 'Engineering', {
        entries: [entry('m1', 'user', 'Draft the team update.', 3 * MIN), entry('m2', 'assistant', codeWrapMd, 2 * MIN)],
      }),
    },
  });
  for (const [suffix, width] of [['', undefined], ['-narrow', 960]] as const) {
    scenes.push({ name: `thread-code-wrap${suffix}`, state: codeWrapCos, steps: [{ wait: 400 }], ...(width ? { width } : {}) });
    scenes.push({
      name: `dept-code-wrap${suffix}`, state: codeWrapDept,
      steps: [{ click: { selector: sel.tab, text: 'Max', index: 0 } }, { wait: 400 }], ...(width ? { width } : {}),
    });
  }

  scenes.push({
    name: 'thread-done-expanded',
    state: thread(cosThread({ entries: finishedTurn })),
    steps: [{ click: { selector: sel.activitySummary, index: -1 } }, { wait: 400 }],
  });

  scenes.push({
    name: 'thread-permission',
    state: thread(cosThread({
      entries: runningEntries, busy: true,
      activity: { startedAt: ago(42_000), current: 'Sending to GitHub', steps: 3 },
    })),
    events: [permissionRequest],
    steps: [{ waitFor: sel.permissionCard }],
  });

  scenes.push({
    name: 'thread-permission-artifact',
    state: thread(cosThread({
      entries: runningEntries, busy: true,
      activity: { startedAt: ago(42_000), current: 'Publishing the artifact Weekly report', steps: 3 },
    })),
    events: [artifactPermissionRequest],
    steps: [{ waitFor: sel.permissionCard }],
  });

  scenes.push({
    name: 'thread-question',
    state: thread(cosThread({
      entries: runningEntries, busy: true,
      activity: { startedAt: ago(42_000), current: 'Asking you a question', steps: 3 },
    })),
    events: [questionRequest],
    steps: [{ waitFor: sel.questionCard }],
  });

  scenes.push({
    name: 'thread-streaming',
    state: thread(cosThread({
      entries: runningEntries, busy: true,
      activity: { startedAt: ago(20_000), current: null, steps: 2 },
      streaming: 'Lena has one open question on the **palette**: the dark variant of the accent colour fails the contrast check, so she proposes two options and',
    })),
    steps: [{ waitFor: sel.live }],
  });

  // A thread longer than the window with a turn running: the live line's screen-reader copy once stretched the
  // window below the composer. The harness fails any scene whose document is taller than the window.
  const longThread = [0, 1, 2].flatMap((n) => finishedTurn.map((e) => ({ ...e, id: `${e.id}-${n}` })));
  scenes.push({
    name: 'thread-long-live',
    state: thread(cosThread({
      entries: [...longThread, ...runningEntries.map((e) => ({ ...e, id: `${e.id}-l` }))], busy: true,
      activity: { startedAt: ago(42_000), current: 'Reading state.md', steps: 3 },
    })),
    steps: [{ waitFor: sel.live }],
  });
  scenes.push({
    name: 'thread-long-streaming',
    state: thread(cosThread({
      entries: [...longThread, ...runningEntries.map((e) => ({ ...e, id: `${e.id}-s` }))], busy: true,
      activity: { startedAt: ago(20_000), current: null, steps: 2 },
      streaming: 'Lena has one open question on the **palette**: the dark variant of the accent colour fails the contrast check, so she proposes two options and',
    })),
    steps: [{ waitFor: sel.live }],
  });

  // The reader scrolled up while a reply arrived: "Jump to latest" with the new-content dot.
  scenes.push({
    name: 'thread-jump-latest',
    state: thread(cosThread({ entries: [...longThread, ...runningEntries.map((e) => ({ ...e, id: `${e.id}-j` }))] })),
    steps: [
      // The mock's getThread is async: scroll only once the entries are rendered, or the scroll lands on an empty box.
      { waitFor: sel.threadRow },
      { scroll: { selector: sel.threadBody, to: 'top' } },
      { wait: 300 },
      { emit: { type: 'thread-entry', orgId: ORG, threadId: 'cos', entry: entry('e-new', 'assistant', 'Nothing blocks Lena this week. She is waiting for your answer on **ACME-D1** before she starts the docs site.', 0) } },
      { waitFor: sel.jumpDot },
    ],
  });

  scenes.push({
    name: 'thread-error',
    state: thread(cosThread({
      entries: [
        entry('e1', 'user', 'Please open the issue for the welcome screen.', 5 * MIN),
        entry('e2', 'error', 'Could not reach GitHub: the request timed out.', 4 * MIN),
        entry('e3', 'user', 'Try again.', 3 * MIN),
        entry('e4', 'error', t('thread.processExited'), 2 * MIN),
      ],
    })),
    steps: [],
  });

  scenes.push({
    name: 'thread-failed',
    state: thread(cosThread({
      entries: [
        entry('e1', 'user', 'Please open the issue for the welcome screen.', 5 * MIN),
        entry('e2', 'activity', t('activity.summary', { count: 3, time: '12 s' }), 4 * MIN, {
          steps: [
            { text: 'Reading state.md', detail: 'Read · company/state.md', durationMs: 1_000 },
            { text: 'Checking GitHub', detail: 'Bash · gh issue', durationMs: 4_000 },
            { text: 'Opening an issue on GitHub', detail: 'Bash · gh issue', durationMs: 7_000, failed: true },
          ],
          durationMs: 12_000,
        }),
        entry('e3', 'error', 'Could not reach GitHub: the request timed out.', 4 * MIN - 1000),
      ],
    })),
    steps: [{ click: { selector: sel.activitySummary, index: -1 } }, { wait: 400 }],
  });

  scenes.push({
    name: 'thread-empty',
    state: thread(cosThread()),
    steps: [],
  });

  scenes.push({
    name: 'thread-reply',
    state: base(cosThread({ entries: finishedTurn }), {}, { waiting: waitingFull }),
    steps: [{ click: { selector: sel.replyButton, text: 'Reply', index: 0 } }, { waitFor: sel.replyChip }, { wait: 200 }],
  });

  scenes.push({
    name: 'composer-mode',
    state: thread(cosThread({ entries: finishedTurn, permissionMode: 'acceptEdits' })),
    steps: [],
  });

  // Switching to Auto mode asks first, inline under the composer.
  scenes.push({
    name: 'composer-auto-confirm',
    state: thread(cosThread({ entries: finishedTurn, permissionMode: 'acceptEdits' })),
    steps: [{ select: { selector: '.composer-foot select', value: 'auto', index: 2 } }, { waitFor: '.auto-confirm' }, { wait: 200 }],
  });

  scenes.push({
    name: 'composer-mode-pending',
    state: thread(cosThread({ entries: finishedTurn, permissionMode: 'plan', runPending: true })),
    steps: [],
  });

  // Two images pasted into the composer, then a file that is not an image dropped on it: the error line under the box.
  scenes.push({
    name: 'composer-images',
    state: thread(cosThread({ entries: finishedTurn })),
    steps: [
      { files: { event: 'paste', selector: sel.composer, items: [
        { name: 'first.png', type: 'image/png', data: pngBase64(96, 64, [56, 189, 248]) },
        { name: 'second.png', type: 'image/png', data: pngBase64(64, 96, [167, 139, 250]) },
      ] } },
      { files: { event: 'drop', selector: '.composer', items: [{ name: 'notes.txt', type: 'text/plain', data: Buffer.from('not an image').toString('base64') }] } },
      { waitFor: '.composer-error' },
      { wait: 200 },
    ],
  });

  // A user message with an image above its text, and a second one whose image is gone from the store.
  scenes.push({
    name: 'thread-image',
    state: base(
      cosThread({
        entries: [
          entry('i1', 'user', 'Here is the mock-up of the welcome screen. Does the spacing match the brand rules?', 4 * MIN, { images: [{ id: 'a'.repeat(64), mediaType: 'image/png' }] }),
          entry('i2', 'assistant', 'The **spacing** follows the 8 px grid. The heading is one step too large against the voice rules.', 3 * MIN),
          entry('i3', 'user', 'And this older one?', 2 * MIN, { images: [{ id: 'b'.repeat(64), mediaType: 'image/png' }] }),
        ],
      }),
      { images: { ['a'.repeat(64)]: `data:image/png;base64,${pngBase64(320, 200, [52, 211, 153])}` } },
    ),
    steps: [{ waitFor: '.msg-image' }, { wait: 300 }],
  });

  scenes.push({
    name: 'thread-handoff',
    state: thread(cosThread({
      entries: [
        entry('e1', 'user', 'Ask Max to prepare the release checklist.', 40 * MIN),
        entry('e2', 'handoff', t('thread.handoffCard', { persona: 'Max', title: 'Release checklist is ready for review' }), 5 * MIN),
        entry('e3', 'assistant', 'Max finished the **release checklist**. I filed it under `initiatives/first-release/` and added one item for you: ACME-A1.', 4 * MIN),
      ],
    })),
    steps: [],
  });

  scenes.push({
    name: 'panel-waiting',
    state: base(
      cosThread({ entries: finishedTurn }),
      {
        tabs: {
          [ORG]: [
            tab('t-old', 'max', 'Max', 'Engineering', { status: 'closed', openedAt: ago(9 * DAY), closedAt: ago(8 * DAY), notePath: 'inbox/2026-11-10-max-ci.md' }),
          ],
        },
      },
      { waiting: waitingFull, initiatives },
    ),
    steps: [],
  });

  // Rubric 6: keyboard focus (real Tab key events) and the hover state of a waiting card button.
  const focusState = base(cosThread({ entries: finishedTurn }), {}, { waiting: waitingFull });
  scenes.push({
    name: 'focus-waiting',
    state: focusState,
    steps: [{ focus: { selector: '.item.waiting .btn.you', text: 'Approve' } }],
  });
  scenes.push({
    name: 'hover-waiting',
    state: focusState,
    steps: [{ hover: { selector: '.item.waiting .btn.you', text: 'Approve' } }],
  });
  scenes.push({
    name: 'focus-tab',
    state: focusState,
    steps: [{ focus: { selector: sel.tab } }],
  });
  scenes.push({
    name: 'focus-org',
    state: focusState,
    steps: [{ focus: { selector: sel.orgIcon } }],
  });
  scenes.push({
    name: 'focus-button',
    state: base(cosThread({ entries: finishedTurn }), {
      tabs: { [ORG]: [tab('t1', 'max', 'Max', 'Engineering')] },
      threads: {
        [`${ORG}|cos`]: cosThread({ entries: finishedTurn }),
        [`${ORG}|tab:t1`]: tabThread('t1', 'Max', 'Engineering', { entries: [entry('m1', 'user', 'Fix the flaky test in the welcome screen.', 3 * MIN), entry('m2', 'assistant', 'Fixed. The test no longer depends on the clock.', 2 * MIN, { author: 'Max' })] }),
      },
    }),
    steps: [{ click: { selector: sel.tab, text: 'Max', index: 0 } }, { waitFor: sel.headButton }, { focus: { selector: sel.headButton } }],
  });

  // The side panel is taller than the window: a second shot scrolled to the bottom shows initiatives and departments.
  // Looked up by name: scenes added in between must not change what this shot shows.
  const panelScene = scenes.find((x) => x.name === 'panel-waiting')!;
  scenes.push({
    name: 'panel-lower',
    state: panelScene.state,
    steps: [{ click: { selector: sel.closedInitiativesToggle } }, { scroll: { selector: sel.sidePanel, to: 'bottom' } }, { wait: 300 }],
  });

  scenes.push({
    name: 'panel-hidden',
    state: panelScene.state,
    steps: [{ click: { selector: sel.panelToggle } }, { wait: 700 }],
  });

  // Departments: Max has an open chat that is running (teal dot), Lena is handing over; a closed chat (t3) shows nowhere.
  scenes.push({
    name: 'panel-departments',
    state: base(
      cosThread({ entries: finishedTurn }),
      {
        tabs: {
          [ORG]: [
            tab('t1', 'max', 'Max', 'Engineering', { openedAt: ago(40 * MIN) }),
            tab('t3', 'max', 'Max', 'Engineering', { status: 'closed', openedAt: ago(9 * DAY), closedAt: ago(8 * DAY), notePath: 'inbox/2026-11-10-max-ci.md' }),
            tab('t4', 'lena', 'Lena', 'Design and brand', { status: 'handing-over', openedAt: ago(5 * MIN) }),
          ],
        },
        threads: {
          [`${ORG}|cos`]: cosThread({ entries: finishedTurn }),
          [`${ORG}|tab:t1`]: tabThread('t1', 'Max', 'Engineering', { busy: true, activity: { startedAt: ago(30_000), current: 'Running the tests', steps: 2 } }),
          [`${ORG}|tab:t4`]: tabThread('t4', 'Lena', 'Design and brand'),
        },
      },
      { waiting: waitingFull.slice(0, 2), initiatives: initiatives.slice(0, 2) },
    ),
    steps: [{ scroll: { selector: sel.sidePanel, to: 'bottom' } }, { wait: 400 }],
  });

  // Long texts: a waiting item (3 lines, expanded by the first "Show more") and an initiative "Next" line (2 lines, still collapsed).
  scenes.push({
    name: 'panel-showmore',
    state: base(
      cosThread({ entries: finishedTurn }),
      {},
      {
        waiting: [{
          code: 'ACME-A9', kind: 'A', urgency: 'normal', action: 'ok', escalate: false, since: dayStr(5),
          text: 'Merge pull request #31 on acme/app. It changes the sign-in flow, adds two screens, removes the old token helper and touches the release script, so please read the description before you approve it, and check that the new copy matches the voice rules.',
        }],
        initiatives: [initiative('long', 'Launch week', 'active', 2, 'Max finishes the release checklist, Lena reviews the launch post and the landing page copy, then Ada schedules the announcement for Tuesday morning')],
      },
    ),
    steps: [{ click: { selector: sel.showMore, index: 0 } }, { wait: 400 }],
  });

  // Initiatives: the explainer, goal, state and next step, one fresh item, two not updated for more than 7 days (active, paused) with their button.
  const stale: Initiative[] = [
    initiative('onboarding-flow', 'Onboarding flow for new orgs', 'active', 1, 'Max opens the PR for the welcome screen'),
    initiative('brand-refresh', 'Brand refresh', 'active', 10, 'Lena shares the new palette for review'),
    initiative('docs-cleanup', 'Docs cleanup', 'paused', 9, 'Resume after the release'),
    initiative('first-release', 'First release', 'done', 14, ''),
  ];
  scenes.push({
    name: 'panel-initiatives',
    state: base(cosThread({ entries: finishedTurn }), {}, { waiting: [], initiatives: stale }),
    steps: [{ wait: 400 }],
  });
  // The title opens the status page in a dialog (frontmatter already stripped by readInitiative).
  scenes.push({
    name: 'panel-initiative-view',
    state: {
      ...base(cosThread({ entries: finishedTurn }), {}, { waiting: [], initiatives: stale }),
      initiativeFiles: {
        [`${ORG}|brand-refresh`]: '# Brand refresh\n\n## Goal\nA palette and a voice guide for the launch.\n\n## State\nThe palette is drafted. The voice guide waits for the review.\n\n## Next step\nLena shares the new palette for review.\n\n## Links\n- [Palette notes](https://example.com/palette)\n- `departments/design-brand/palette.md`\n',
      },
    },
    steps: [{ click: { selector: '.i-title', text: 'Brand refresh' } }, { waitFor: '[role="dialog"]' }, { wait: 400 }],
  });

  // A waiting card in its 4 s undo window: "Approving…", Undo and the bar shrinking.
  // An unparsed waiting line: its quiet Reply opens the chief of staff tab with the chip "Replying to:" and the raw line.
  scenes.push({
    name: 'panel-unparsed-reply',
    state: base(cosThread({ entries: finishedTurn }), {}, { waiting: waitingFull, initiatives }),
    steps: [{ click: { selector: sel.unparsedReply, text: 'Reply' } }, { waitFor: sel.replyChip }, { wait: 300 }],
  });

  // A decide item with an option label over 32 characters: the options are listed as text, each with an "Option a" button.
  scenes.push({
    name: 'panel-long-options',
    state: base(cosThread({ entries: finishedTurn }), {}, {
      waiting: [
        {
          code: 'ACME-D3', kind: 'D', urgency: 'high', action: 'decide', escalate: false, since: dayStr(2),
          text: 'How should we handle the launch announcement?',
          options: [
            { key: 'a', label: 'Announce on **launch day** with the full changelog and a short demo video' },
            { key: 'b', label: 'Announce a week later' },
            { key: 'c', label: 'Skip the announcement and only update the `README`' },
          ],
        },
        waitingFull[2],
      ],
      initiatives,
    }),
    steps: [{ wait: 300 }],
  });

  // Focus view of "Waiting on you": an {ok} item, a decide item with a long card, and the empty deck.
  const openFocus: Step[] = [{ click: { selector: sel.focusOpen } }, { waitFor: sel.focusSheet }, { wait: 400 }];
  scenes.push({
    name: 'waiting-focus-ok',
    state: base(cosThread({ entries: finishedTurn }), {}, { waiting: waitingFull, initiatives }),
    steps: openFocus,
  });
  const longCard: WaitingEntry = {
    code: 'ACME-D7', kind: 'D', urgency: 'high', action: 'decide', escalate: true, since: dayStr(7),
    text: 'Which hosting plan for the docs site? See https://github.com/acme/app/issues/41 for the traffic numbers and [the pricing page](https://example.com/pricing).',
    options: [
      { key: 'a', label: 'Free tier with a custom domain added later, once the launch is done and the traffic is known' },
      { key: 'b', label: 'Paid tier now, so the docs stay fast during the launch week and nobody has to migrate afterwards' },
      { key: 'c', label: 'Self-host on the team server' },
    ],
    card: {
      context: 'The docs site goes live with the launch.\n\n- Expected traffic: 2,000 visits a day for the first week.\n- The free tier caps at 1,000 visits a day.\n- Moving later means one afternoon of work and a short outage.\n\nThe team server has spare room but nobody is on call for it at night.',
      options: [
        { key: 'a', label: 'Free tier with a custom domain added later, once the launch is done and the traffic is known' },
        { key: 'b', label: 'Paid tier now, so the docs stay fast during the launch week and nobody has to migrate afterwards' },
        { key: 'c', label: 'Self-host on the team server' },
      ],
      recommendation: '(b): the cost is small next to an outage during the launch week.\n\nRevisit after a month with real traffic numbers.',
      proposedBy: 'Max',
      escalate: true,
    },
  };
  scenes.push({
    name: 'waiting-focus-decide',
    state: base(cosThread({ entries: finishedTurn }), {}, { waiting: [longCard, ...waitingFull.slice(0, 2)], initiatives }),
    steps: openFocus,
  });
  scenes.push({
    name: 'waiting-focus-empty',
    state: base(cosThread({ entries: finishedTurn }), {}, { waiting: [waitingFull[0]], initiatives }),
    steps: [...openFocus, { click: { selector: `${sel.focusSheet} .btn`, text: 'Approve' } }, { wait: 400 }],
  });

  // Parent and child items: groups collapsed with their child count, one expanded, and the focus view on a child.
  const groupsState = base(cosThread({ entries: finishedTurn }), {}, { waiting: waitingGroups, initiatives });
  scenes.push({
    name: 'panel-waiting-groups',
    state: groupsState,
    steps: [{ wait: 300 }],
  });
  scenes.push({
    name: 'panel-waiting-groups-open',
    state: groupsState,
    steps: [{ click: { selector: sel.groupToggle } }, { wait: 400 }],
  });
  scenes.push({
    name: 'waiting-focus-child',
    state: groupsState,
    steps: [...openFocus, { click: { selector: sel.focusNext } }, { wait: 400 }],
  });

  scenes.push({
    name: 'panel-undo',
    state: panelScene.state,
    steps: [{ click: { selector: sel.waitingApprove, text: 'Approve' } }, { wait: 1500 }],
    settleMs: 100,
  });

  scenes.push(healthScene('health-green', healthGreen));
  scenes.push(healthScene('health-syncing', {
    ...healthGreen, color: 'yellow', sentence: t('health.syncing.sentence'), ahead: 2, behind: 1, syncing: true,
  }));
  scenes.push(healthScene('health-yellow', {
    ...healthGreen, color: 'yellow', sentence: tn('health.yellow.ahead', 2), ahead: 2, behind: 0,
    droppedRules: { local: ['Bash(python *)', 'Bash(rm *)', 'WebFetch'], project: [] },
  }));
  // Ignored saved rules are informational: the indicator stays healthy. Collapsed: one line, Show and Clean up.
  const longRule = 'Bash(git -C /Users/someone/work/acme-hq log --since=2026-01-01 --pretty=format:%h --author=ada --no-merges -- company/state.md)';
  const ignored = {
    local: ['Bash(python *)', 'Bash(rm *)', 'WebFetch', longRule, 'Bash(sh -c *)', 'mcp__acme__send'],
    project: ['Bash(rm -rf build)', 'Bash(git push origin main)'],
  };
  const rulesHealth: HealthStatus = { ...healthGreen, droppedRules: ignored };
  scenes.push(healthScene('health-rules', rulesHealth));
  {
    const rules = healthScene('health-rules', rulesHealth);
    const pop = sel.popover;
    scenes.push({ ...rules, name: 'health-rules-shown', steps: [...rules.steps, { click: { selector: `${pop} button`, text: 'Show' } }, { wait: 300 }] });
    scenes.push({ ...rules, name: 'health-rules-confirm', steps: [...rules.steps, { click: { selector: `${pop} button`, text: 'Show' } }, { click: { selector: `${pop} button`, text: 'Clean up' } }, { wait: 300 }] });
  }
  // Processes an earlier run left running: the indicator is yellow ("Needs attention"), one line each with Stop.
  scenes.push(healthScene('health-leftover', {
    ...healthGreen, color: 'yellow', sentence: tn('health.yellow.leftover', 2),
    leftoverProcesses: [{ pid: 48213, startedAt: Date.now() - 95 * MIN }, { pid: 48260, startedAt: Date.now() - 4 * 24 * 60 * MIN }],
  }));
  scenes.push(healthScene('health-orange', {
    ...healthGreen, color: 'orange', sentence: t('health.orange'), hasRemote: false, lastSyncAt: null,
  }));
  scenes.push(healthScene('health-red', {
    ...healthGreen, color: 'red', sentence: t('health.red.conflict'), ahead: 3, behind: 2, conflict: 'files',
  }));
  // Both sides have new commits but no file conflicts: same action, its own wording.
  scenes.push(healthScene('health-diverged', {
    ...healthGreen, color: 'red', sentence: t('health.red.diverged'), ahead: 3, behind: 2, conflict: 'diverged',
  }));
  // After "Ask Ada to fix it": reopened, the button is disabled ("Sent to Ada") until her turn for it ends.
  {
    const diverged = healthScene('health-askfix-sent', { ...healthGreen, color: 'red', sentence: t('health.red.diverged'), ahead: 3, behind: 2, conflict: 'diverged' });
    scenes.push({
      ...diverged,
      steps: [...diverged.steps, { click: { selector: 'button', text: 'Ask Ada to fix it' } }, { wait: 300 }, { click: { selector: sel.healthButton } }, { waitFor: sel.popover }, { wait: 300 }],
    });
  }
  // A failing automatic push that a retry can fix: yellow, "Try again".
  scenes.push(healthScene('health-pushfail', {
    ...healthGreen, color: 'yellow', sentence: t('health.yellow.pushFailing', { reason: t('health.pushError.localChanges') }), ahead: 1, behind: 0,
    autoPushFailing: true, pushError: t('health.pushError.localChanges'),
  }));

  scenes.push({
    name: 'prereqs',
    state: base(cosThread(), {
      prereq: {
        ...prereqOk,
        signedIn: false,
        plugin: { ...prereqOk.plugin!, state: 'missing', installed: null, latest: '0.20.0', updateAvailable: false, hqFrameworkVersion: '0.20.0' },
      },
    }),
    steps: [{ waitFor: sel.prereqs }],
  });

  scenes.push({
    name: 'empty-org',
    state: (() => {
      const st = base(cosThread(), {}, { waiting: [], initiatives: [], departments: [] });
      const quiet = { ...st.orgs[0], waitingCount: 0 };
      return { ...st, orgs: [quiet], views: { [ORG]: { ...st.views[ORG], org: quiet } } };
    })(),
    steps: [],
  });

  scenes.push({
    name: 'welcome',
    state: { ...base(cosThread()), orgs: [], activeOrgId: null, views: {}, threads: {} },
    steps: [{ waitFor: sel.welcome }],
  });

  scenes.push({
    name: 'loading',
    state: { ...base(cosThread()), hang: { activateOrg: true } },
    steps: [],
  });

  scenes.push({
    name: 'loading-app',
    state: { ...base(cosThread()), hang: { listOrgs: true } },
    steps: [],
  });

  const tabsState = base(cosThread({ entries: finishedTurn }), {
      tabs: {
        [ORG]: [
          tab('t1', 'max', 'Max', 'Engineering'),
          tab('t2', 'lena', 'Lena', 'Design and brand', { status: 'handing-over' }),
        ],
      },
      threads: {
        [`${ORG}|cos`]: cosThread({ entries: finishedTurn }),
        [`${ORG}|tab:t1`]: tabThread('t1', 'Max', 'Engineering', {
          busy: true, activity: { startedAt: ago(75_000), current: 'Running the tests', steps: 6 },
          entries: [entry('m1', 'user', 'Fix the flaky test in the welcome screen.', 3 * MIN)],
          streaming: 'On it. I will rerun the suite and look at the failing case.',
        }),
        [`${ORG}|tab:t2`]: tabThread('t2', 'Lena', 'Design and brand', {
          entries: [
            entry('l1', 'user', 'We are done. Write your handoff note.', 2 * MIN),
          ],
        }),
      },
    });

  scenes.push({
    name: 'tabs',
    state: tabsState,
    steps: [{ click: { selector: sel.tab, text: 'Max', index: 0 } }],
  });

  // Closing a department chat that has not handed over asks first (the x, or Cmd+W): hand over, close without handover, cancel.
  // Max is idle with a short exchange; the busy variant adds the line about the reply being stopped.
  const closeState = (busy: boolean) =>
    base(cosThread({ entries: finishedTurn }), {
      tabs: { [ORG]: [tab('t1', 'max', 'Max', 'Engineering'), tab('t2', 'lena', 'Lena', 'Design and brand', { notePath: 'inbox/2026-11-10-lena-palette.md' })] },
      threads: {
        [`${ORG}|cos`]: cosThread({ entries: finishedTurn }),
        [`${ORG}|tab:t1`]: tabThread('t1', 'Max', 'Engineering', {
          entries: [entry('m1', 'user', 'Fix the flaky test in the welcome screen.', 3 * MIN), entry('m2', 'assistant', 'The test waited on a timer. I replaced it with an explicit wait.', 2 * MIN, { author: 'Max' })],
          ...(busy ? { busy: true, activity: { startedAt: ago(20_000), current: 'Running the tests', steps: 2 } } : {}),
        }),
        [`${ORG}|tab:t2`]: tabThread('t2', 'Lena', 'Design and brand'),
      },
    });
  scenes.push({
    name: 'tab-close-dialog',
    state: closeState(false),
    steps: [{ click: { selector: sel.tab, text: 'Max' } }, { click: { selector: sel.tabClose, index: 0 } }, { waitFor: sel.alertDialog }, { wait: 300 }],
  });
  scenes.push({
    name: 'tab-close-dialog-busy',
    state: closeState(true),
    steps: [{ click: { selector: sel.tab, text: 'Max' } }, { click: { selector: sel.tabClose, index: 0 } }, { waitFor: sel.alertDialog }, { wait: 300 }],
  });

  // ---------- the org chart ----------

  const helper = (name: string, description: string, model: string | null = 'sonnet'): OrgChartWorker => ({ name, model, description });
  const reader = helper('reader', 'Read-only helper for bulk reading and research.');
  const worker = helper('worker', 'Hands-on helper for edits, commands and drafts.');
  const chartDept = (id: string, agent: string, name: string, patch: Partial<OrgChartDepartment> = {}): OrgChartDepartment => ({
    id, agent, displayName: name, catalogRole: id, model: 'opus', agentFile: { found: true, name: agent, model: 'opus' },
    agentPath: `.claude/agents/${agent}.md`, workers: [reader], look: null, ...patch,
  });
  const lookOf = (icon: string | null, colour: DepartmentLook['colour']): DepartmentLook => ({ icon, colour });
  const max = chartDept('engineering', 'max', 'Max', { workers: [reader, worker], look: lookOf('code', 'blue') });
  const lena = chartDept('design-brand', 'lena', 'Lena', { look: lookOf('pen-tool', 'pink') });
  const extra: Array<[string, string, string, string, OrgChartDepartment['workers'], DepartmentLook | null]> = [
    ['legal', 'nora', 'Nora', 'Legal', [], lookOf('scale', 'neutral')],
    ['finance', 'otto', 'Otto', 'Finance', [], lookOf('wallet', 'neutral')],
    ['marketing', 'pia', 'Pia', 'Marketing', [reader], lookOf('megaphone', 'pink')],
    ['support', 'rex', 'Rex', 'Support', [reader, worker], lookOf('headphones', 'blue')],
    ['research', 'sam', 'Sam', 'Research', [reader], lookOf('flask-conical', 'neutral')],
    ['people', 'tia', 'Tia', 'People', [reader], null],
  ];
  const moreDepts = extra.map(([id, agent, name, , workers, look]) => chartDept(id, agent, name, { workers, look }));
  const moreRoles = extra.map(([id, agent, name, role]) => ({ id, agent, persona: name, role }) as Department);
  const chartOf = (depts: OrgChartDepartment[], patch: Partial<OrgChart> = {}): OrgChart => ({
    ceo: { roleId: 'ceo', displayName: '' },
    cos: { displayName: 'Ada', model: 'opus' },
    departments: depts,
    workers: { rule: 'one-down', types: [reader, worker] },
    tiers: ['opus', 'sonnet', 'haiku'],
    problems: [],
    error: null,
    staleError: null,
    readAt: new Date().toISOString(),
    ...patch,
  });
  const noLive: OrgChartLive = { cos: { busy: false, handoffsWaiting: 0 }, departments: {} };
  const chartScene = (name: string, chart: OrgChart, depts: Department[], patch: Partial<SceneState> = {}, steps: Step[] = [], viewPatch: Partial<OrgView> = {}): Scene => ({
    name,
    state: base(cosThread({ entries: finishedTurn }), { charts: { [ORG]: { chart, live: noLive } }, ...patch }, { departments: depts, waiting: waitingFull.slice(0, 2), ...viewPatch }),
    steps: [{ click: { selector: sel.chartToggle } }, { waitFor: sel.orgChart }, ...steps],
  });
  const panelClosed: Step[] = [{ click: { selector: sel.panelToggle } }, { wait: 700 }];

  // This org's real shape: the CEO, Ada (CoS) working, Max working, Lena with a handoff waiting for Ada; the app-look icons.
  const busyCos = cosThread({ busy: true, handoffsWaiting: 1, handoffTabs: ['t9'], activity: { startedAt: ago(40_000), current: 'Reading the handoff note', steps: 2 }, entries: finishedTurn });
  scenes.push(
    chartScene('org-chart', chartOf([max, lena]), departments, {
      tabs: { [ORG]: [tab('t1', 'max', 'Max', 'Engineering'), tab('t9', 'lena', 'Lena', 'Design and brand', { status: 'closed', closedAt: ago(2 * MIN) })] },
      threads: {
        [`${ORG}|cos`]: busyCos,
        [`${ORG}|tab:t1`]: tabThread('t1', 'Max', 'Engineering', { busy: true, activity: { startedAt: ago(75_000), current: 'Running the tests', steps: 6 } }),
      },
    }),
  );

  scenes.push(chartScene('org-chart-0', chartOf([]), []));

  // A sample org shape with invented names (fixture sample-org; Ada, Max and Nora are agent personas).
  const sampleDir = path.resolve(process.cwd(), 'test/fixtures/org-chart/sample-org');
  const sampleRoles: Department[] = [
    { id: 'engineering', agent: 'max', persona: 'Max', role: 'Engineering' },
    { id: 'design-brand', agent: 'nora', persona: 'Nora', role: 'Design and brand' },
  ];
  const sampleCos = (patch: Partial<ThreadInfo> = {}) => cosThread({ title: 'Ada (Chief of Staff)', speaker: 'Ada', ...patch });
  const sampleScene = (name: string, chart: OrgChart): Scene => {
    const s = chartScene(name, chart, sampleRoles, {
      orgs: [{ ...orgSummary(ORG, 'Acme'), cosName: 'Ada' }],
      tabs: { [ORG]: [tab('t1', 'max', 'Max', 'Engineering'), tab('t9', 'nora', 'Nora', 'Design and brand', { status: 'closed', closedAt: ago(2 * MIN) })] },
      threads: {
        [`${ORG}|cos`]: sampleCos({ busy: true, handoffsWaiting: 1, handoffTabs: ['t9'], activity: { startedAt: ago(40_000), current: 'Reading the handoff note', steps: 2 }, entries: finishedTurn }),
        [`${ORG}|tab:t1`]: tabThread('t1', 'Max', 'Engineering', { busy: true, activity: { startedAt: ago(75_000), current: 'Running the tests', steps: 6 } }),
      },
    }, [], {
      // The panel carries this org's names too, not the other scenes' placeholders.
      waiting: [
        { code: 'ACME-A1', kind: 'A', urgency: 'high', action: 'ok', escalate: false, since: dayStr(0), text: 'Merge the org chart pull request on the app repo.' },
        { code: 'ACME-D1', kind: 'D', urgency: 'normal', action: 'decide', escalate: false, since: dayStr(1), text: 'Which look do the department tiles get?' },
      ],
      initiatives: [initiative('micro-org-interface', 'Micro-org interface', 'active', 0, 'Review the live org chart.')],
    });
    return s;
  };
  const quietly = <T,>(fn: () => T): T => {
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      return fn();
    } finally {
      console.warn = warn;
    }
  };
  scenes.push(sampleScene('org-chart-sample', readOrgChart(sampleDir)));

  // The same fixture with an unparseable app-look.yaml: initials everywhere, no error in the UI (one console warning, silenced here).
  const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-shots-look-'));
  try {
    fs.cpSync(sampleDir, brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, 'departments', 'design-brand', 'app-look.yaml'), 'version: 1\ndepartments: [unclosed\n  engineering: {icon: code\n');
    scenes.push(sampleScene('org-chart-look-broken', quietly(() => readOrgChart(brokenDir))));
  } finally {
    fs.rmSync(brokenDir, { recursive: true, force: true });
  }

  const eight = [max, lena, ...moreDepts];
  const eightRoles = [...departments, ...moreRoles];
  scenes.push(chartScene('org-chart-8-panel', chartOf(eight), eightRoles));
  scenes.push(chartScene('org-chart-8-nopanel', chartOf(eight), eightRoles, {}, panelClosed));
  scenes.push(chartScene('org-chart-5', chartOf(eight.slice(0, 5)), eightRoles.slice(0, 5), {}, panelClosed));
  // 5 departments with the panel open: k = 4, so rows of 3 and 2.
  scenes.push(chartScene('org-chart-5-panel', chartOf(eight.slice(0, 5)), eightRoles.slice(0, 5)));

  // Helpers that do not fit the node's column: the model text goes first, then the extra chips fold into "+n".
  const crowded = [
    chartDept('engineering', 'max', 'Max', { workers: [helper('reader', 'Read-only helper.'), helper('worker', 'Hands-on helper.'), helper('scout', 'Looks around.', 'haiku')], look: lookOf('code', 'blue') }),
    chartDept('design-brand', 'lena', 'Lena', { workers: [helper('reader', 'Read-only helper.'), helper('worker', 'Hands-on helper.'), helper('scout', 'Looks around.', 'haiku'), helper('critic', 'Reviews drafts.'), helper('archivist', 'Files the notes.')], look: lookOf('pen-tool', 'pink') }),
    chartDept('legal', 'nora', 'Nora', { workers: [helper('reader', 'Read-only helper.'), helper('worker', 'Hands-on helper.')], look: lookOf('scale', 'neutral') }),
  ];
  scenes.push(chartScene('org-chart-chips-fold', chartOf(crowded), departments));

  // As the app behaves: with no good read yet the panel has no departments either (and says why); after a good read (stale) it keeps them.
  scenes.push(chartScene('org-chart-error', chartOf([], { error: 'Line 23: All mapping items must start at the same column', readAt: null }), [], {}, [], { orgUnreadable: true }));
  scenes.push(
    chartScene('org-chart-stale', chartOf([max, lena], { staleError: 'Line 23: All mapping items must start at the same column', readAt: new Date(Date.now() - 8 * MIN).toISOString() }), departments),
  );

  // Every status: Max working, Lena handing over, Nora handoff waiting, Otto chat open, Pia agent file missing; the CoS shows its waiting handoff.
  const liveDepts = [max, lena, chartDept('legal', 'nora', 'Nora', { workers: [], look: lookOf('scale', 'neutral') }), chartDept('finance', 'otto', 'Otto', { workers: [], look: lookOf('wallet', 'blue') }), chartDept('marketing', 'pia', 'Pia', { look: lookOf('megaphone', 'pink'), agentFile: { found: false, name: null, model: null } })];
  scenes.push(
    chartScene(
      'org-chart-live',
      chartOf(liveDepts),
      eightRoles.slice(0, 5),
      {
        tabs: {
          [ORG]: [
            tab('t1', 'max', 'Max', 'Engineering'),
            tab('t2', 'lena', 'Lena', 'Design and brand', { status: 'handing-over' }),
            tab('t3', 'nora', 'Nora', 'Legal', { status: 'closed', closedAt: ago(MIN) }),
            tab('t4', 'otto', 'Otto', 'Finance'),
          ],
        },
        threads: {
          [`${ORG}|cos`]: cosThread({ handoffsWaiting: 1, handoffTabs: ['t3'], busy: true, activity: { startedAt: ago(20_000), current: 'Reading the handoff note', steps: 1 }, entries: finishedTurn }),
          [`${ORG}|tab:t1`]: tabThread('t1', 'Max', 'Engineering', { busy: true, activity: { startedAt: ago(75_000), current: 'Running the tests', steps: 6 } }),
          [`${ORG}|tab:t2`]: tabThread('t2', 'Lena', 'Design and brand', { busy: true }),
          [`${ORG}|tab:t4`]: tabThread('t4', 'Otto', 'Finance'),
        },
      },
      panelClosed,
    ),
  );

  // Department liveness: what the chief of staff has dispatched (the elapsed time ticks from `startedAt`).
  const dispatch = (id: string, agent: string, departmentId: string | null, name: string, description: string, patch: Partial<Dispatch> = {}): Dispatch => ({
    id, agent, departmentId, name, description, background: true, state: 'running', startedAt: ago(2 * MIN + 5000), lastActivityAt: ago(8000), endedAt: null, ...patch,
  });
  const dispatchScene = (name: string, list: Dispatch[], patch: Partial<Scene> = {}): Scene => {
    const s = chartScene(name, chartOf([max, lena]), departments, { dispatches: { [ORG]: list } }, [{ waitFor: '.dp-status' }, { scroll: { selector: sel.sidePanel, to: 'bottom' } }, { wait: 300 }]);
    return { ...s, ...patch };
  };
  // One department working in the background, and a helper under the chief of staff.
  scenes.push(
    dispatchScene('dispatch-running', [
      dispatch('d1', 'max', 'engineering', 'Max', 'Fix the failing CI check'),
      dispatch('d2', 'reader', null, 'reader', 'Read the CI logs', { startedAt: ago(25_000) }),
    ]),
  );
  // Two tasks for the same department (the node says how many, the panel lists both), another department done.
  scenes.push(
    dispatchScene('dispatch-parallel', [
      dispatch('d1', 'max', 'engineering', 'Max', 'Fix the failing CI check'),
      dispatch('d2', 'max', 'engineering', 'Max', 'Update the dependency report', { startedAt: ago(40_000), background: false }),
      dispatch('d3', 'lena', 'design-brand', 'Lena', 'Draft the empty states', { state: 'unknown', lastActivityAt: ago(9 * MIN), startedAt: ago(10 * MIN) }),
    ]),
  );
  // A department finished: the toast (with its button) and the done row, until the user has seen the report.
  const finished = dispatch('d1', 'max', 'engineering', 'Max', 'Fix the failing CI check', { state: 'done', startedAt: ago(3 * MIN + 12_000), endedAt: ago(2000), lastActivityAt: ago(2000) });
  scenes.push(
    dispatchScene('dispatch-done', [finished], {
      events: [
        { type: 'dispatches', orgId: ORG, dispatches: [finished] },
        { type: 'dispatch-ended', orgId: ORG, dispatch: finished },
      ],
      steps: [{ click: { selector: sel.chartToggle } }, { waitFor: sel.orgChart }, { waitFor: sel.toast }, { scroll: { selector: sel.sidePanel, to: 'bottom' } }, { wait: 300 }],
    }),
  );

  // Max's node menu: one item, "Open chat" (starts a chat, or focuses the open one).
  scenes.push(
    chartScene('org-chart-menu-top', chartOf([max, lena]), departments, {}, [
      { click: { selector: '.oc-menu-btn', index: 0 } },
      { waitFor: '.oc-menu-item' },
      { wait: 300 },
    ]),
  );

  // Keyboard focus on a department node: the ring, the tooltip and the `···` button (shown while focus is inside).
  scenes.push(
    chartScene('org-chart-focus', chartOf([max, lena]), departments, {}, [
      { focus: { selector: '.oc-node[data-node="cos"]' } },
      { press: 'Down' },
      { wait: 700 },
    ]),
  );

  // Lena is handing over: the tab holds a spinner and the name; the sentence is in the tab tooltip and in her head bar.
  scenes.push({
    name: 'thread-handingover',
    state: tabsState,
    steps: [{ click: { selector: sel.tab, text: 'Lena' } }, { waitFor: '.head-handing' }],
  });

  // The Settings view (full window): General is the first section.
  scenes.push({
    name: 'settings',
    state: thread(cosThread({ entries: finishedTurn })),
    steps: [{ click: { selector: sel.settingsButton } }, { waitFor: sel.settingsView }, { wait: 300 }],
  });

  // Settings > General with an org icon set: the preview, the tile of the org switcher and Remove enabled.
  scenes.push({
    name: 'settings-org-icon',
    state: { ...thread(cosThread({ entries: finishedTurn })), orgs: [orgSummary(ORG, 'ACME', { iconStamp: '1700000000000-4096' })], orgIcons: { [ORG]: orgIconUrl() } },
    steps: [{ click: { selector: sel.settingsButton } }, { waitFor: sel.settingsView }, { wait: 300 }],
  });

  // The same confirm in Settings when the Auto mode radio is picked (Permissions section).
  scenes.push({
    name: 'settings-auto-confirm',
    state: thread(cosThread({ entries: finishedTurn })),
    steps: [
      { click: { selector: sel.settingsButton } }, { waitFor: sel.settingsView },
      { click: { selector: sel.settingsTab, text: 'Permissions' } }, { waitFor: 'label.radio' },
      { click: { selector: '.settings-view label.radio', text: 'Auto mode' } }, { waitFor: '.auto-confirm' }, { wait: 300 },
    ],
  });

  // Permissions: the mode, then the hq's allow rules (one dropped as too broad), the rules saved with Always allow, the denied ones.
  scenes.push({
    name: 'settings-permissions',
    state: {
      ...thread(cosThread({ entries: finishedTurn })),
      rules: { [ORG]: sampleRules },
    },
    steps: [
      { click: { selector: sel.settingsButton } }, { waitFor: sel.settingsView },
      { click: { selector: sel.settingsTab, text: 'Permissions' } }, { waitFor: '.rule-list' }, { wait: 300 },
    ],
  });

  // The same section scrolled to the bottom: the denied rules (hq and user), read-only.
  scenes.push({
    name: 'settings-permissions-lower',
    state: {
      ...thread(cosThread({ entries: finishedTurn })),
      rules: { [ORG]: sampleRules },
    },
    steps: [
      { click: { selector: sel.settingsButton } }, { waitFor: sel.settingsView },
      { click: { selector: sel.settingsTab, text: 'Permissions' } }, { waitFor: '.rule-list' },
      { scroll: { selector: '.settings-scroll', to: 'bottom' } }, { wait: 300 },
    ],
  });

  // Connectors: Max has two grants (one not yet in his agent file), Lena (advisory) none; the forbidden and the available lists.
  const connectors: ConnectorsInfo = {
    departments: [
      { id: 'engineering', displayName: 'Max', agent: 'max', advisory: false, granted: ['mcp__tracker__*', 'mcp__notes__search'], inAgentFile: ['mcp__tracker__*'], mcpLock: null },
      { id: 'legal', displayName: 'Lena', agent: 'lena', advisory: true, granted: [], inAgentFile: [], mcpLock: null },
    ],
    forbidden: ['mcp__mail__*'],
    forbiddenLocal: [],
    forbiddenProblems: [],
    forbiddenWarnings: [],
    available: [
      { server: 'notes', pattern: 'mcp__notes__*' }, { server: 'tracker', pattern: 'mcp__tracker__*' },
      { server: 'calendar', pattern: 'mcp__calendar__*' }, { server: 'files', pattern: 'mcp__files__*' },
    ],
    notGrantable: [],
    session: {
      started: true,
      loaded: [
        { name: 'tracker', status: 'connected', source: 'project', chats: ['Ada', 'Max'], block: null },
        { name: 'claude.ai Example', status: 'needs-auth', source: 'claudeai', chats: ['Ada'], block: { kind: 'some', rule: 'mcp__claude_ai_Example__send' } },
      ],
      keptOut: ['mail'],
      claudeAiOff: false,
      forbiddenRules: ['mcp__mail__*'],
      mcpLocked: false,
    },
    error: null,
  };
  scenes.push({
    name: 'settings-connectors',
    state: { ...thread(cosThread({ entries: finishedTurn })), connectors: { [ORG]: connectors } },
    steps: [
      { click: { selector: sel.settingsButton } }, { waitFor: sel.settingsView },
      { click: { selector: sel.settingsTab, text: 'Connectors' } }, { waitFor: '.conn-dept' }, { wait: 300 },
    ],
  });

  // Max's request form open: a connector picked and a reason typed, the send button enabled.
  scenes.push({
    name: 'settings-connectors-request',
    state: { ...thread(cosThread({ entries: finishedTurn })), connectors: { [ORG]: connectors } },
    steps: [
      { click: { selector: sel.settingsButton } }, { waitFor: sel.settingsView },
      { click: { selector: sel.settingsTab, text: 'Connectors' } }, { waitFor: '.conn-dept' },
      { click: { selector: '.conn-dept .btn', text: 'Request a connector', index: 0 } }, { waitFor: '.conn-form select' },
      { select: { selector: '.conn-form select', value: 'mcp__calendar__*' } },
      { type: { selector: '.conn-form input[type="text"]', value: 'Needs to read the release calendar to plan the next release.' } }, { wait: 300 },
    ],
  });

  // About: app, Claude Code, plugin and org versions (plugin latest unknown), read-only.
  scenes.push({
    name: 'settings-about',
    state: {
      ...thread(cosThread({ entries: finishedTurn })),
      about: { [ORG]: { appVersion: '0.1.0', claudeVersion: '2.1.330', claudeRange: '>=2.1.326 <2.2.0', pluginInstalled: '0.20.0', pluginLatest: null, frameworkVersion: '0.19.0', hqPath: '/tmp/acme-hq' } },
    },
    steps: [
      { click: { selector: sel.settingsButton } }, { waitFor: sel.settingsView },
      { click: { selector: sel.settingsTab, text: 'About' } }, { waitFor: '.about-list' }, { wait: 300 },
    ],
  });

  // The init message told the app the resolved model: the footer reads "Model: Opus 5.5" (full id in the tooltip), the turn's name line carries the id too.
  scenes.push({
    name: 'composer-model-resolved',
    state: thread(cosThread({
      entries: finishedTurn.map((e) => (e.kind === 'user' ? e : { ...e, model: 'claude-opus-5-5' })),
      resolvedModel: 'claude-opus-5-5', seenModels: ['claude-opus-5-5', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5'],
    })),
    steps: [{ waitFor: sel.composer }],
  });

  // A model pinned as the org default: the CoS model select lists the seen ids and the note says "Pinned for this org: Opus 5.5".
  scenes.push({
    name: 'settings-model-pinned',
    state: {
      ...thread(cosThread({ entries: finishedTurn, resolvedModel: 'claude-opus-5-5' })),
      settings: {
        ...settingsBase, model: 'claude-opus-5-5', cosModel: 'claude-opus-5-5', cosModelSource: 'override',
        seenModels: ['claude-opus-5-5', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5'],
      },
    },
    steps: [{ click: { selector: sel.settingsButton } }, { waitFor: sel.settingsView }, { wait: 300 }],
  });

  scenes.push({
    name: 'toast',
    state: thread(cosThread({ entries: finishedTurn })),
    events: [{ type: 'notice', orgId: ORG, text: t('notice.handedOver', { org: 'ACME', persona: 'Max' }) }],
    steps: [{ waitFor: sel.toast }],
  });

  const boltRail = orgSummary('bolt', 'BOLT');
  const kite = orgSummary('kite', 'KITE', { available: false, lastOpened: ago(30 * DAY) });
  const acmeRail = orgSummary(ORG, 'ACME');
  scenes.push({
    name: 'rail',
    state: {
      ...base(cosThread({ orgId: 'bolt', entries: finishedTurn })),
      orgs: [acmeRail, boltRail, kite],
      activeOrgId: 'bolt',
      views: {
        acme: emptyView(acmeRail),
        bolt: emptyView(boltRail, {
          departments,
          waiting: waitingFull.slice(0, 3).map((w) => ('code' in w ? { ...w, code: w.code.replace('ACME-', 'BOLT-') } : w)),
          initiatives: initiatives.slice(0, 3),
        }),
        kite: emptyView(kite),
      },
      threads: { 'bolt|cos': cosThread({ orgId: 'bolt', entries: finishedTurn }) },
      tabs: { acme: [], bolt: [], kite: [] },
    },
    steps: [],
  });

  // An org with its own icon in the rail (company/icon.png in its hq): the image replaces the initials; the other orgs keep theirs.
  const acmeIcon = orgSummary(ORG, 'ACME', { iconStamp: '1700000000000-4096' });
  scenes.push({
    name: 'rail-org-icon',
    state: {
      ...scenes.find((x) => x.name === 'rail')!.state,
      orgs: [acmeIcon, boltRail, kite],
      activeOrgId: 'bolt',
      orgIcons: { [ORG]: orgIconUrl() },
    },
    steps: [{ wait: 300 }],
  });

  // More orgs than fit the 820 px window (16 tiles of 48 px): the list scrolls and the app identity corner stays pinned at the bottom.
  const manyOrgs = [orgSummary(ORG, 'ACME'), orgSummary('bolt', 'BOLT'), ...Array.from({ length: 14 }, (_, i) => orgSummary(`org${i}`, `ORG ${String.fromCharCode(65 + i)}`))];
  scenes.push({
    name: 'rail-many-orgs',
    state: {
      ...scenes.find((x) => x.name === 'rail')!.state,
      orgs: manyOrgs,
      activeOrgId: 'bolt',
      views: Object.fromEntries(manyOrgs.map((o) => [o.id, emptyView(o)])),
      tabs: Object.fromEntries(manyOrgs.map((o) => [o.id, []])),
    },
    steps: [],
  });

  // Settings opened on the second of three orgs (the main window's org is BOLT); its settings differ from the others'.
  scenes.push({
    name: 'settings-org-switch',
    state: {
      ...scenes.find((x) => x.name === 'rail')!.state,
      settingsByOrg: { bolt: { ...settingsBase, effort: 'medium', effortSource: 'hq', permissionMode: 'acceptEdits', permissionModeSource: 'hq', model: 'sonnet', cosModel: 'sonnet', cosModelSource: 'override' } },
      rules: { bolt: sampleRules },
    },
    steps: [{ click: { selector: sel.settingsButton } }, { waitFor: sel.settingsView }, { wait: 300 }],
  });

  // ---------- "Create a new org" ----------
  {
    const empty = { ...base(cosThread()), orgs: [], activeOrgId: null, views: {}, threads: {} };
    const create = '.co-foot .btn.primary';
    const nextBtn: Step = { click: { selector: create } };
    const openCreate: Step[] = [{ waitFor: sel.welcome }, { click: { selector: '.welcome .btn', text: 'Create a new org' } }, { waitFor: '.co-view .co-title' }];
    const pickCard = (name: string, value: string): Step => ({ click: { selector: `input[name="${name}"][value="${value}"]` } });
    const fill = (id: string, value: string): Step => ({ type: { selector: `#${id}`, value } });
    // Every question answered by clicks and typing, like a user, up to the Summary (placeholder answers, nothing preselected by the app).
    const toSummary: Step[] = [
      { waitFor: '#co-language-chat' }, fill('co-language-chat', 'en'), pickCard('co-ceo-profile', 'non-technical'), nextBtn,
      { waitFor: 'input[name="co-org-purpose"]' }, pickCard('co-org-purpose', 'product'), nextBtn,
      { waitFor: '#co-org-name' }, fill('co-org-name', 'Acme Labs'), fill('co-org-id', 'ACME'), nextBtn,
      { waitFor: '#co-about-what' }, fill('co-about-what', 'A planner for small teams'), fill('co-about-why', 'Small teams lose track of work'), pickCard('co-about-stage', 'building'), nextBtn,
      { waitFor: '#co-language-files' }, fill('co-language-files', 'en'), nextBtn,
      { waitFor: 'input[type="checkbox"][value="engineering"]' }, { click: { selector: 'input[type="checkbox"][value="engineering"]' } }, nextBtn,
      { waitFor: '#co-names-cos' }, fill('co-names-cos', 'Ada'), fill('co-names-departments-engineering', 'Max'), fill('co-names-ceo', 'Grace'), nextBtn,
      { waitFor: 'input[name="co-gates"]' }, pickCard('co-gates', 'accept'), pickCard('co-destructive', 'deny'), nextBtn,
      { waitFor: 'input[name="co-models-cos"]' }, pickCard('co-models-cos', 'opus'), pickCard('co-models-departments', 'sonnet'), nextBtn,
      { waitFor: 'input[name="co-policy"]' }, pickCard('co-policy', 'none'), nextBtn,
      { waitFor: '#co-remote-hq' }, { click: { selector: '.co-field:has(#co-remote-hq) .co-check input' } }, pickCard('co-repos', 'none'), pickCard('co-roadmap', 'none'), pickCard('co-attribution', 'default'), nextBtn,
      { waitFor: '.co-sum' }, pickCard('co-enable_plugin', 'yes'),
    ];
    const toFolder: Step[] = [...toSummary, nextBtn, { waitFor: '#co-folder-change' }];
    const chooseFolder: Step[] = [{ click: { selector: '#co-folder-change' } }, { waitFor: '#co-folder-path' }];
    const emptyFolder: SetupFolderPick = { path: '/Users/me/Orgs/acme-hq', ok: true, entries: [] };
    const run = (facts: Partial<SetupFacts>, busy: boolean, extra: Partial<{ error: string | null; hqReady: boolean }> = {}): AppEvent => ({
      type: 'setup-state', runId: 'r1', busy, exited: false, hqReady: false, facts: { ...EMPTY_FACTS, ...facts }, answersFile: '/tmp/coa-setup-x/answers.yaml', error: null, ...extra,
    });
    const started: Step[] = [...toFolder, ...chooseFolder, nextBtn, { wait: 500 }];
    const assistant = (text: string): AppEvent => ({ type: 'thread-entry', orgId: 'setup', threadId: 'setup:r1', entry: { id: 'w1', kind: 'assistant', author: 'Setup', text, time: new Date().toISOString() } });

    scenes.push({
      name: 'add-menu',
      state: { ...base(cosThread()) },
      steps: [{ waitFor: '.org-icon.add' }, { click: { selector: '.org-icon.add' } }, { waitFor: '.add-menu' }, { wait: 300 }],
    });
    scenes.push({
      name: 'create-prereqs',
      state: { ...empty, setup: { dataError: 'The ceo-of-agents plugin is not installed, so the setup questions cannot be read.' } },
      steps: [...openCreate.slice(0, 2), { waitFor: '.co-view .prereqs' }],
    });
    scenes.push({ name: 'create-step', state: empty, steps: [...openCreate, { waitFor: '#co-language-chat' }] });
    scenes.push({ name: 'create-step-error', state: empty, steps: [...openCreate, { waitFor: '#co-language-chat' }, nextBtn, { waitFor: '.co-error' }] });
    scenes.push({ name: 'create-summary', state: empty, steps: [...openCreate, ...toSummary, { wait: 300 }], settleMs: 600 });
    scenes.push({
      name: 'create-folder-not-empty',
      state: { ...empty, setup: { pick: { path: '/Users/me/Orgs/acme', ok: false, entries: ['Documents', 'notes.txt', 'src', 'package.json', '.env', 'dist', 'README.md'] } } },
      steps: [...openCreate, ...toFolder, ...chooseFolder, { waitFor: '.co-entries' }],
    });
    scenes.push({
      name: 'create-running',
      state: { ...empty, setup: { pick: emptyFolder } },
      steps: [
        ...openCreate, ...started,
        { emit: { type: 'thread-state', state: { orgId: 'setup', threadId: 'setup:r1', busy: true, handoffsWaiting: 0, activity: { startedAt: new Date(Date.now() - 42_000).toISOString(), current: 'Writing company/state.md', steps: 3 } } } },
        { emit: run({ orgYaml: true, decisionRecord: true }, true) },
        { emit: { type: 'thread-entry', orgId: 'setup', threadId: 'setup:r1', entry: { id: 't1', kind: 'tool', author: '', text: 'Reading the answers file', time: new Date().toISOString() } } },
        { wait: 400 },
      ],
    });
    scenes.push({
      name: 'create-asking',
      state: { ...empty, setup: { pick: emptyFolder } },
      steps: [
        ...openCreate, ...started,
        { emit: assistant('Here is the summary of your org.\n\n- Acme Labs (ACME)\n- Departments: Engineering\n\nDo you confirm and want me to create the files?') },
        { emit: run({}, false) },
        { waitFor: '#co-reply' },
      ],
    });
    scenes.push({
      name: 'create-asking-nonempty',
      state: { ...empty, setup: { pick: emptyFolder } },
      steps: [
        ...openCreate, ...started,
        { emit: assistant('The directory is not empty: it holds notes.txt and a src folder. Do you want to continue generating into it?') },
        { emit: run({}, false) },
        { waitFor: '#co-reply' },
      ],
    });
    scenes.push({
      name: 'create-done-complete',
      state: { ...empty, setup: { pick: emptyFolder } },
      steps: [
        ...openCreate, ...started,
        { emit: assistant('Your hq is ready in /Users/me/Orgs/acme-hq.') },
        { emit: run({ orgYaml: true, decisionRecord: true, state: true, settings: true, pluginEnabled: true, commit: 'a1b2c3d', orgName: 'Acme Labs', cosName: 'Ada' }, false, { hqReady: true }) },
        { waitFor: '.co-checks' },
      ],
    });
    scenes.push({
      name: 'create-done',
      state: { ...empty, setup: { pick: emptyFolder } },
      steps: [
        ...openCreate, ...started,
        { emit: assistant('Your hq is ready in /Users/me/Orgs/acme-hq.') },
        { emit: run({ orgYaml: true, decisionRecord: true, state: true, settings: true, pluginEnabled: false, commit: 'a1b2c3d', orgName: 'Acme Labs', cosName: 'Ada' }, false, { hqReady: true }) },
        { waitFor: '.co-checks' },
      ],
    });
    scenes.push({
      name: 'create-failed',
      state: { ...empty, setup: { pick: emptyFolder } },
      steps: [
        ...openCreate, ...started,
        { emit: run({}, false, { error: 'The plugin reported invalid answers: departments[0].id must be kebab-case (see /Users/me/Orgs/acme-hq/org.yaml).' }) },
        { waitFor: '.co-verbatim' },
      ],
    });
  }


  // ---------- the shared media set (docs/media): 1440 x 900 CSS px, sample org only ----------
  // README of this folder, "Media set". Names: orgs ACME, BOLT, KITE; Ada, Max, Lena; codes ACME-*.
  {
    const MEDIA = { width: 1440, height: 900 } as const;
    const bolt = orgSummary('bolt', 'BOLT');
    const kiteOrg = orgSummary('kite', 'KITE');
    const usage: PlanUsage = {
      status: 'allowed', limitType: 'five_hour', resetsAt: new Date(Date.now() + 125 * MIN).toISOString(), at: new Date().toISOString(),
      windows: [
        { key: 'five_hour', utilization: 0.18, resetsAt: new Date(Date.now() + 125 * MIN).toISOString(), status: 'allowed' },
        { key: 'seven_day', utilization: 0.42, resetsAt: new Date(Date.now() + 76 * 3_600_000).toISOString(), status: 'allowed' },
      ],
    };
    /** ACME selected, BOLT and KITE below it in the rail, two usage chips, hq health green. */
    const mediaState = (info: ThreadInfo, patch: Partial<SceneState> = {}, viewPatch: Partial<OrgView> = {}): SceneState => {
      const b = base(info, patch, viewPatch);
      return {
        ...b,
        orgs: [b.orgs[0], bolt, kiteOrg],
        views: { ...b.views, bolt: emptyView(bolt), kite: emptyView(kiteOrg) },
        tabs: { ...b.tabs, bolt: [], kite: [] },
        usage,
      };
    };
    const a2: WaitingEntry = { code: 'ACME-A2', kind: 'A', urgency: 'normal', action: 'ok', escalate: false, since: dayStr(1), text: 'Merge the login fix: pull request #12 on acme/app.' };
    const d3: WaitingEntry = {
      code: 'ACME-D3', kind: 'D', urgency: 'high', action: 'decide', escalate: false, since: dayStr(2),
      text: 'How should we announce the launch?',
      options: [{ key: 'a', label: 'Announce on launch day' }, { key: 'b', label: 'Announce a week later' }, { key: 'c', label: 'Skip the announcement' }],
      card: {
        context: 'The login fix and the welcome screen ship together this week.\n\n- A launch-day post reaches the most people.\n- A week later gives the docs time to catch up.\n- Skipping it keeps the release quiet.',
        options: [
          { key: 'a', label: 'Announce on launch day, with a short demo and the changelog' },
          { key: 'b', label: 'Announce a week later, once the docs are updated' },
          { key: 'c', label: 'Skip the announcement and update the README only' },
        ],
        recommendation: '(a): the demo is ready and the docs update is small.\n\nRevisit if the release slips.',
        proposedBy: 'Max',
        escalate: false,
      },
    };
    const a4: WaitingEntry = { code: 'ACME-A4', kind: 'A', urgency: 'low', action: 'do', escalate: false, since: dayStr(0), parent: 'ACME-D3', text: 'Send the invite list to the first ten testers.' };
    const mediaInitiatives: Initiative[] = [
      initiative('onboarding-flow', 'Onboarding flow for new orgs', 'active', 1, 'Max opens the PR for the welcome screen'),
      initiative('brand-refresh', 'Brand refresh', 'active', 3, 'Lena shares the new palette for review'),
    ];
    const mediaReply = [
      'Here is where things stand on the **onboarding flow**:',
      '',
      '| Item | Owner | Status |',
      '| --- | --- | --- |',
      '| Welcome screen | Max | In review |',
      '| Copy check | Lena | Done |',
      '| Launch announcement | You | Waiting (ACME-D3) |',
      '',
      'Two things need you: the login fix to merge (ACME-A2) and the launch announcement (ACME-D3).',
    ].join('\n');
    const mediaTurn: ThreadEntry[] = [finishedTurn[0], finishedTurn[1], entry('e3', 'assistant', mediaReply, 29 * MIN + 1000)];
    const expandGroup: Step[] = [{ click: { selector: sel.groupToggle } }, { wait: 500 }];

    // M1: the main window, idle, side panel open.
    scenes.push({
      name: 'media-hero', ...MEDIA,
      state: mediaState(cosThread({ entries: mediaTurn }), {}, { departments, waiting: [a2, d3, a4], initiatives: mediaInitiatives }),
      steps: expandGroup,
    });

    // M2: the focus view on the decision (the first of three slides is the decision: it is the high-urgency item).
    scenes.push({
      name: 'media-focus-view', ...MEDIA,
      state: mediaState(cosThread({ entries: mediaTurn }), {}, { departments, waiting: [d3, a4, a2], initiatives: mediaInitiatives }),
      steps: [{ click: { selector: sel.focusOpen } }, { waitFor: sel.focusSheet }, { wait: 500 }],
    });

    // M3: a running turn waiting on a permission card.
    scenes.push({
      name: 'media-permission', ...MEDIA,
      state: mediaState(
        cosThread({
          entries: [...mediaTurn, entry('e4', 'user', 'Push the welcome screen branch to GitHub.', 2 * MIN)], busy: true,
          activity: { startedAt: ago(42_000), current: 'Sending to GitHub', steps: 3 },
        }),
        {}, { departments, waiting: [a2, d3, a4], initiatives: mediaInitiatives },
      ),
      events: [permissionRequest],
      steps: [{ waitFor: sel.permissionCard }, { wait: 400 }],
    });

    // M4: the org chart, Max working, Lena and Nora idle, one handoff waiting for Ada.
    const nora = chartDept('legal', 'nora', 'Nora', { workers: [], look: lookOf('scale', 'neutral') });
    const chartDepts: Department[] = [...departments, { id: 'legal', agent: 'nora', persona: 'Nora', role: 'Legal' }];
    scenes.push({
      name: 'media-org-chart', ...MEDIA,
      state: mediaState(
        cosThread({ entries: mediaTurn, handoffsWaiting: 1 }),
        {
          charts: { [ORG]: { chart: chartOf([max, lena, nora]), live: noLive } },
          tabs: { [ORG]: [tab('t1', 'max', 'Max', 'Engineering')], bolt: [], kite: [] },
          threads: {
            [`${ORG}|cos`]: cosThread({ entries: mediaTurn, handoffsWaiting: 1 }),
            [`${ORG}|tab:t1`]: tabThread('t1', 'Max', 'Engineering', { busy: true, activity: { startedAt: ago(75_000), current: 'Running the tests', steps: 6 } }),
          },
        },
        { departments: chartDepts, waiting: [a2, d3, a4], initiatives: mediaInitiatives },
      ),
      steps: [{ click: { selector: sel.chartToggle } }, { waitFor: sel.orgChart }, { wait: 700 }],
    });

    // M5: a chat with Max, the chief of staff tab beside it, Hand over enabled.
    const maxReply = [
      'Fixed. The button on the login page said `Sing in`; it now reads `Sign in`:',
      '',
      '```diff',
      '- <button>Sing in</button>',
      '+ <button>Sign in</button>',
      '```',
      '',
      'The tests pass. Say when you want to hand this over.',
    ].join('\n');
    scenes.push({
      name: 'media-department-chat', ...MEDIA,
      state: mediaState(
        cosThread({ entries: mediaTurn }),
        {
          tabs: { [ORG]: [tab('t1', 'max', 'Max', 'Engineering', { pendingWork: true, openedAt: ago(12 * MIN) })], bolt: [], kite: [] },
          threads: {
            [`${ORG}|cos`]: cosThread({ entries: mediaTurn }),
            [`${ORG}|tab:t1`]: tabThread('t1', 'Max', 'Engineering', {
              entries: [
                entry('m1', 'user', 'Fix the typo on the login page.', 6 * MIN),
                entry('m2', 'assistant', maxReply, 4 * MIN, { author: 'Max' }),
              ],
            }),
          },
        },
        { departments, waiting: [a2, d3, a4], initiatives: mediaInitiatives },
      ),
      steps: [{ click: { selector: sel.tab, text: 'Max', index: 0 } }, { waitFor: sel.headButton }, { wait: 500 }],
    });

    // M6: "Create a new org", first question.
    scenes.push({ ...scenes.find((x) => x.name === 'create-step')!, name: 'media-create-org', ...MEDIA });

    // G1: approve ACME-A2 with undo. The item leaves when the chief of staff has acted: here, an org-view event at 6.0 s.
    const approveState = mediaState(cosThread({ entries: mediaTurn }), {}, { departments, waiting: [a2, d3, a4], initiatives: mediaInitiatives });
    const acmeOrg = approveState.orgs[0];
    const afterApprove: OrgView = { ...approveState.views[ORG], waiting: [d3, a4], org: { ...acmeOrg, waitingCount: 2 } };
    scenes.push({
      name: 'media-approve', ...MEDIA,
      state: approveState,
      steps: expandGroup,
      record: { fps: 15, durationMs: 7500, cursorStart: [1240, 640] },
      timeline: [
        { at: 800, step: { hover: { selector: '.item.waiting', text: 'ACME-A2' } } },
        { at: 1500, step: { hover: { selector: '.item.waiting .btn.you', text: 'Approve' } } },
        { at: 2000, step: { click: { selector: '.item.waiting .btn.you', text: 'Approve' } } },
        { at: 6000, step: { emit: { type: 'orgs', orgs: [{ ...acmeOrg, waitingCount: 2 }, bolt, kiteOrg], activeOrgId: ORG } } },
        { at: 6000, step: { emit: { type: 'org-view', orgId: ORG, view: afterApprove } } },
        { at: 6400, step: { hover: { selector: sel.threadBody } } },
      ],
    });

    // G2: ask the chief of staff to route a task to engineering. Driven by mock events.
    const ask = 'Ask engineering to fix the typo on the login page';
    const reply = ["Sent to engineering. ", "I'll tell you when it's done."].join('').split(' ');
    // Times that must be "now" when the step runs (not when the scenes are built) are written '@now' (see emitScript in main.cjs).
    const NOW = '@now';
    const d1 = (state: Dispatch['state'], endedAt: string | null, startedAt = NOW): Dispatch => ({
      id: 'g2', agent: 'max', departmentId: 'engineering', name: 'Max', description: 'Fix the typo on the login page', background: true, state,
      startedAt, lastActivityAt: NOW, endedAt,
    });
    const cosState = (busy: boolean, handoffsWaiting: number, activity: ThreadInfo['activity']): AppEvent => ({
      type: 'thread-state', state: { orgId: ORG, threadId: 'cos', busy, handoffsWaiting, activity },
    });
    const dispatchTimeline: Array<{ at: number; step: Step }> = [];
    for (let i = 1; i <= ask.length; i++) dispatchTimeline.push({ at: 500 + Math.round((i * 2000) / ask.length) - 41, step: { type: { selector: sel.composer, value: ask.slice(0, i) } } });
    dispatchTimeline.push(
      { at: 2500, step: { click: { selector: '.composer button.send' } } },
      { at: 2520, step: { emit: { type: 'thread-entry', orgId: ORG, threadId: 'cos', entry: entry('g2-u', 'user', ask + '.', 0, { time: NOW }) } } },
      { at: 2540, step: { emit: cosState(true, 0, { startedAt: NOW, current: 'Reading state.md', steps: 1 }) } },
      { at: 3500, step: { emit: cosState(true, 0, { startedAt: '@now-1000', current: 'Sending to engineering', steps: 2 }) } },
      { at: 4500, step: { emit: { type: 'dispatches', orgId: ORG, dispatches: [d1('running', null)] } } },
      { at: 4500, step: { emit: cosState(true, 0, { startedAt: '@now-2000', current: 'Writing the reply', steps: 3 }) } },
    );
    reply.forEach((w, i) => dispatchTimeline.push({ at: 4600 + Math.round((i * 3300) / reply.length), step: { emit: { type: 'thread-delta', orgId: ORG, threadId: 'cos', text: (i ? ' ' : '') + w } } }));
    dispatchTimeline.push(
      { at: 8000, step: { emit: { type: 'thread-entry', orgId: ORG, threadId: 'cos', entry: entry('g2-s', 'activity', t('activity.summary', { count: 3, time: '6 s' }), 0, { steps: [{ text: 'Reading state.md', detail: 'Read · company/state.md', durationMs: 1_000 }, { text: 'Sending to engineering', detail: 'Agent · max', durationMs: 1_000 }, { text: 'Writing the reply', detail: '', durationMs: 3_500 }], durationMs: 6_000, time: NOW }) } } },
      { at: 8001, step: { emit: { type: 'thread-entry', orgId: ORG, threadId: 'cos', entry: entry('g2-a', 'assistant', "Sent to engineering. I'll tell you when it's done.", 0, { time: NOW }) } } },
      { at: 8002, step: { emit: cosState(false, 0, null) } },
      { at: 8500, step: { emit: { type: 'dispatches', orgId: ORG, dispatches: [d1('done', NOW, '@now-4000')] } } },
      { at: 8500, step: { emit: { type: 'thread-state', state: { orgId: ORG, threadId: 'cos', busy: false, handoffsWaiting: 1, handoffTabs: [], activity: null } } } },
    );
    scenes.push({
      name: 'media-dispatch', ...MEDIA,
      state: mediaState(cosThread({ entries: mediaTurn }), {}, { departments, waiting: [a2], initiatives: mediaInitiatives.slice(0, 1) }),
      steps: [{ waitFor: sel.composer }, { wait: 300 }],
      record: { fps: 15, durationMs: 11000 },
      timeline: dispatchTimeline,
    });
  }

  // The rail badge comes from the same parsed list as the "Waiting on you" panel (OrgManager.summaries): derive it from each scene's items.
  for (const s of scenes) {
    s.state.orgs = s.state.orgs.map((o) => {
      const view = s.state.views[o.id];
      if (!view) return o;
      const waitingCount = view.waiting.filter((w) => 'code' in w).length;
      const next = { ...o, waitingCount };
      view.org = next;
      return next;
    });
  }
  return scenes;
}

export const sceneNames = (): string[] => buildScenes().map((s) => s.name);
