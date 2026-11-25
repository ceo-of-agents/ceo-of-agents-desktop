// Shared contract between the main process and the renderer.
// The renderer never spawns processes: everything goes through the API below (see src/preload.ts).

import type { PlanUsage } from './usage';
export type { PlanUsage, UsageWindow } from './usage';
import type { SetupAnswers, SetupData, SetupFolderPick, SetupState } from './setup';

export type OrgId = string;

/** One org (an hq folder: a folder with org.yaml and CLAUDE.md) known to the app. */
export interface OrgSummary {
  id: OrgId;
  path: string;
  name: string;
  /** Display name of the chief of staff (cos.display_name in org.yaml), "Chief of Staff" if empty. */
  cosName: string;
  /** Number of parsed items in "Waiting on the CEO" (state.md). */
  waitingCount: number;
  lastOpened: string | null;
  /** False when the folder no longer exists or is no longer an hq. */
  available: boolean;
  /** `<mtimeMs>-<size>` of the org's icon file (`company/icon.png` in the hq), null when there is none or the org is unavailable. It changes when the icon does. */
  iconStamp: string | null;
}

/** The outcome of picking an org icon: saved, or why not. */
export type OrgIconResult = { ok: true } | { ok: false; error: 'tooLarge' | 'unsupported' | 'writeFailed' | 'notAFile' };
/** The outcome of picking the source image of an org icon: its bytes (base64) for the renderer to decode, or why not. */
export type OrgIconPick = { ok: true; mediaType: ImageMediaType; data: string } | { ok: false; error: 'tooLarge' | 'unsupported' | 'writeFailed' | 'notAFile' };

/** The CEO's voice file (plugin schema `voice/1`) as the editor and the Draft form read it. */
export interface VoiceInfo {
  /** Path in the hq: `ceo.voice` of org.yaml when set, else `company/ceo-voice.md`. */
  path: string;
  /** The file exists and was read. */
  exists: boolean;
  /** The file's text; empty when it does not exist or could not be read. */
  text: string;
  /** Version token of what was read: sha256 of the content, or `missing` when the file did not exist. `saveVoice` takes it back. */
  version: string;
  error?: 'invalidPath' | 'notMarkdown' | 'tooLarge' | 'unreadable';
}

/** The outcome of saving the voice file. */
export type VoiceSaveResult = { ok: true; version: string } | { ok: false; error: 'invalidPath' | 'notMarkdown' | 'tooLarge' | 'conflict' | 'writeFailed' };

export interface Department {
  id: string;
  /** Agent name, passed as `claude --agent <agent>`. */
  agent: string;
  /** display_name in org.yaml (persona or role name). */
  persona: string;
  /** Role from the CLAUDE.md routing table, else derived from the department id. */
  role: string;
}

export type Urgency = 'high' | 'normal' | 'low';

export interface WaitingItem {
  code: string;
  kind: 'A' | 'D' | 'T';
  urgency: Urgency | null;
  text: string;
  /** T items (company/todo.md): the free-text status after ". Status:", null when absent. */
  status?: string | null;
  since: string | null;
  /** Text after " [escalate: holding]" and similar tags is kept in text; this flags the tag. */
  escalate: boolean;
  /** Kind tag after the urgency (plugin 0.14.0+): {ok} approval, {do} a task for the user, {decide} a decision, {wait} a group heading. Null on older lines. */
  action: WaitingAction | null;
  /** A child item (plugin schemas state/1 and todo/1, "Parent and child items"): the code of its parent, the nearest top-level item above it. Absent on a top-level item, and on an orphan or wrongly indented child (it shows as a top-level item). */
  parent?: string;
  /** Options of the matching decision card (D items, when the card lists at least two lettered options). */
  options?: DecisionOption[];
  /** D items: the matching card of the decision queue (context, options, recommendation, who proposed it); absent when the queue has no card for the code. */
  card?: DecisionCard;
}

/** A decision card of `company/decision-queue.md`. Context and recommendation are Markdown source, empty when the card lacks the section. */
export interface DecisionCard {
  context: string;
  /** Every lettered option of the card (a card with one is still listed here). */
  options: DecisionOption[];
  recommendation: string;
  proposedBy: string | null;
  /** `escalate: holding` on the card. */
  escalate: boolean;
}

export interface DecisionOption {
  key: string;
  label: string;
}

/** `wait`: a parent kept as a group heading while its children are open; it asks nothing and is not counted. */
export type WaitingAction = 'ok' | 'do' | 'decide' | 'wait';

export interface UnparsedLine {
  unparsed: string;
}

export type WaitingEntry = WaitingItem | UnparsedLine;

export type InitiativeState = 'active' | 'paused' | 'done' | 'dropped' | 'unknown';

export interface Initiative {
  slug: string;
  title: string;
  state: InitiativeState;
  updated: string | null;
  goal: string;
  /** First paragraph of the `## State` section (prose); the lifecycle enum is `state`. */
  stateText: string;
  nextStep: string;
}

export interface OrgView {
  org: OrgSummary;
  departments: Department[];
  waiting: WaitingEntry[];
  initiatives: Initiative[];
  /** framework_version in org.yaml, null if missing. */
  frameworkVersion: string | null;
  /** org.yaml cannot be read and no earlier good read is known (the panel says so; the chart shows the error plate). While an earlier good read is known, `departments` is that one, as in the chart. */
  orgUnreadable?: boolean;
}

// ---------- org chart ----------

/** A worker type an agent may spawn: the name, the model it runs on and the first sentence of its description. */
export interface OrgChartWorker {
  name: string;
  /** Its own `model:` frontmatter, else derived from `models.workers` (one-down or same); null when neither gives one. */
  model: string | null;
  /** First sentence of the agent file's `description`; empty when missing. */
  description: string;
}

/** The tile of a department, from the optional `app-look.yaml` (spec section 6). */
export type DepartmentColour = 'neutral' | 'blue' | 'pink';
export interface DepartmentLook {
  /** A Lucide name from the allowed list, or null: the tile shows initials. */
  icon: string | null;
  colour: DepartmentColour;
}

export interface OrgChartDepartment {
  id: string;
  /** Agent name: the persona in lowercase, or the id (`agent` in org.yaml). */
  agent: string;
  /** `display_name`, else the id. */
  displayName: string;
  /** `from_catalog` (a catalog id, "custom" or "own"); empty when missing. */
  catalogRole: string;
  /** The department's own `model`, else `models.departments`, else null. */
  model: string | null;
  /** The agent file `.claude/agents/<agent>.md`: whether it exists and its frontmatter `name` and `model`. */
  agentFile: { found: boolean; name: string | null; model: string | null };
  /** The agent file's path inside the hq, for example `.claude/agents/max.md`. */
  agentPath: string;
  /** The worker types named in `Agent(...)` on the `tools:` line of its agent file. Empty: no `Agent` tool, no chips. */
  workers: OrgChartWorker[];
  /** From `app-look.yaml`; null: initials on the plain tile. */
  look: DepartmentLook | null;
}

/** The static shape of an org, read from org.yaml and `.claude/agents/`. Live status is `OrgChartLive`. */
export interface OrgChart {
  ceo: { roleId: string; displayName: string };
  cos: { displayName: string; model: string | null };
  departments: OrgChartDepartment[];
  /** `rule` is `models.workers` (for example "one-down"); `types` are the agent files that are not a department's (the chief of staff's helpers). */
  workers: { rule: string | null; types: OrgChartWorker[] };
  tiers: string[];
  /** Non-fatal issues, as plain sentences. */
  problems: string[];
  /** Fatal at first load: org.yaml is missing, unreadable or not valid. The chart is then empty. The parser detail only, for example `Line 23: bad indentation`. */
  error: string | null;
  /** org.yaml became unreadable after a good read: this chart is the last good one, and this is the detail of the failure. */
  staleError: string | null;
  /** ISO time of the last good read of org.yaml; null when there was none. */
  readAt: string | null;
}

export interface OrgChartLiveDepartment {
  /** A chat of this department has a turn in flight. */
  running: boolean;
  /** The open (or handing-over) chat of this department, if any. */
  openTabId: string | null;
  /** That chat is handing over to the chief of staff. */
  handingOver: boolean;
  /** A handoff of one of its chats is waiting for the chief of staff. */
  handoffWaiting: boolean;
}

/** What the app knows right now about the chart's nodes. Changes with chats, not with files. */
export interface OrgChartLive {
  cos: { busy: boolean; handoffsWaiting: number };
  /** By department id. */
  departments: Record<string, OrgChartLiveDepartment>;
}

// ---------- threads ----------

/** `cos`, a department tab (`tab:<id>`), or a "Create a new org" run (`setup:<runId>`, org id `setup`). */
export type ThreadId = 'cos' | `tab:${string}` | `setup:${string}`;

export type ThreadEntryKind =
  | 'user'
  | 'assistant'
  | 'tool' // a short "using <tool>" line
  | 'activity' // one summary of the steps of a finished turn, before the answer
  | 'handoff' // "<Persona> handed over: <title>"
  | 'system' // quiet app line, for example "Saved and sent to GitHub"
  | 'error'
  | 'session' // divider: a new Claude Code session starts here (text is empty; the label is built from `time`; `continued` for a session started because the context grew)
  | 'permission' // a resolved permission card, kept for the record
  | 'command'; // a command the user ran with "!" (text: the command; `command`: how it ended and its output)

/** How a command the user ran with "!" ended, and its output (cleaned, capped). */
export interface CommandRun {
  outcome: 'done' | 'failed' | 'timeout' | 'cancelled' | 'error';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** Why it could not start (outcome `error`). */
  error?: string;
}

/** A command the user runs with "!" that has not ended yet. */
export interface RunningCommand {
  id: string;
  command: string;
  startedAt: string;
}

/** An image attached to a message: base64 of the file's bytes, with no `data:` prefix. */
export interface ImageAttachment {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  data: string;
}
export type ImageMediaType = ImageAttachment['mediaType'];

/** A PDF sent inline with a message as a `document` content block: its title (the cleaned file name) and the base64 of its bytes, with no `data:` prefix. */
export interface DocumentAttachment {
  title: string;
  data: string;
}

/** An image of a user message in the thread log: the content hash (the file name in the app's image store) and its type. */
export interface ThreadImageRef {
  id: string;
  mediaType: string;
}

/** A file attached to a message (any type but the images the composer sends as image blocks): its name, declared type and bytes. */
export interface FileAttachment {
  name: string;
  mediaType: string;
  data: Uint8Array;
}

/** How a non-image attachment is told apart: pdf, video, audio or other (documents, spreadsheets, archives, anything else). */
export type AttachmentKind = 'pdf' | 'video' | 'audio' | 'other';

/** A file of a user message in the thread log: the id (the folder name in the app's file store), the cleaned name, the size and the kind. Never the bytes or the path. */
export interface ThreadFileRef {
  id: string;
  name: string;
  size: number;
  kind: AttachmentKind;
}

export interface ThreadEntry {
  id: string;
  kind: ThreadEntryKind;
  /** Who speaks, for user entries "You", for assistant entries the persona name. */
  author: string;
  text: string;
  time: string; // ISO 8601
  sessionId?: string;
  /** Divider ('session' entries only): the new session continues the chat (it started because the context grew), not a fresh start. */
  continued?: true;
  /** Activity entries: the steps of the turn. Older logs hold plain strings. */
  steps?: Array<string | ActivityStep>;
  /** Activity entries: how long the turn ran. */
  durationMs?: number;
  /** Assistant and activity entries: the resolved model id the turn ran on (from the init message). */
  model?: string;
  /** User entries: the images sent with the message (stored once in the app's image store, never in the log). */
  images?: ThreadImageRef[];
  /** User entries: the other files sent with the message (stored once in the app's file store, never in the log). */
  files?: ThreadFileRef[];
  /** Command entries: how the command ended and its output. */
  command?: CommandRun;
  /** Handoff entries: the note was written earlier in the chat, not in the handover turn ("Taken from an earlier note"). */
  earlierNote?: boolean;
  /** Error entries: a button the thread offers next to the error. `askNote`: ask the department to write its handoff note (a hand-over found none). */
  action?: 'askNote';
}

/** One step of a finished turn: a plain sentence, plus what a technical reader wants. */
export interface ActivityStep {
  text: string;
  /** The tool and its main argument, for example `Read · company/state.md`. */
  detail?: string;
  durationMs?: number;
  failed?: boolean;
}

export interface ThreadState {
  orgId: OrgId;
  threadId: ThreadId;
  busy: boolean;
  /** Handoffs from department tabs waiting for the CoS (CoS thread only). */
  handoffsWaiting: number;
  /** Tab ids of those handoffs, so the org chart can tell which department has one waiting (CoS thread only). */
  handoffTabs?: string[];
  /** What the turn in flight is doing; null when idle. */
  activity?: ThreadActivity | null;
  /** A background agent ended and the turn that reports on it has not ended yet (CoS thread; see ClaudeSession.reportPending). */
  reportPending?: boolean;
  /** Model (null: Claude Code default) and effort the next turn runs on. Set by the main process when known. */
  model?: string | null;
  effort?: EffortLevel;
  /** The user's choice for this chat (null: org default). */
  runChoice?: RunChoice;
  /** The chat's live process still runs on older values: the change applies from the next message. */
  runPending?: boolean;
  /** What "org default" means for this chat now. */
  runDefaults?: { model: string | null; effort: EffortLevel; /** The default is a model id the user pinned for this org (not a tier alias). */ pinned?: boolean; /** The default effort comes from the department's agent file, not from the org settings. */ effortFromAgent?: boolean };
  /** Model names offered in the picker (org.yaml models.tiers; empty: the app's own list). */
  modelTiers?: string[];
  /** The org's permission mode (the same for every chat of the org). */
  permissionMode?: PermissionMode;
  /** The resolved model id of the latest init message of this chat (null until one arrived). */
  resolvedModel?: string | null;
  /** Model ids the app has seen in init messages (any chat, any org), newest first. */
  seenModels?: string[];
  /** Commands the user runs with "!" in this chat that have not ended yet. */
  commands?: RunningCommand[];
  /** Handoff notes in inbox/ that wait for the chief of staff (CoS thread only): not the notes of open or handing-over chats, nor those already queued. */
  inbox?: InboxPendingNote[];
}

/** One unprocessed handoff note in inbox/: its path relative to the hq and the department it is from (persona when known, else its `from`; null when unknown). */
export interface InboxPendingNote {
  path: string;
  name: string | null;
}

/** A chat's own model and effort; null means "org default". */
export interface RunChoice {
  model: string | null;
  effort: EffortLevel | null;
}

export interface ThreadActivity {
  startedAt: string; // ISO 8601
  /** The step in progress, in plain language; null while thinking. */
  current: string | null;
  steps: number;
}

export interface ThreadInfo extends ThreadState {
  /** "<CoS name> (Chief of Staff)" or "<Persona> (<Role>)". */
  title: string;
  /** Name shown before each assistant message. */
  speaker: string;
  entries: ThreadEntry[];
  /** Text streamed so far for the turn in flight, not yet in entries. */
  streaming: string;
}

export type TabStatus = 'open' | 'handing-over' | 'closed';

export interface TabInfo {
  tabId: string;
  orgId: OrgId;
  agent: string;
  persona: string;
  role: string;
  status: TabStatus;
  openedAt: string;
  closedAt: string | null;
  /** The inbox/ note that covers this chat's work so far (written at hand-over, or during the chat by the department or one of its workers), relative to the hq; null when there is none. */
  notePath: string | null;
  /** The chat did work (a turn that used a tool) since it opened or since its last handoff note: the Hand over button is enabled and closing asks only when true. */
  pendingWork: boolean;
}

// ---------- permissions ----------

export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'plan';

export interface PermissionRequest {
  requestId: string;
  orgId: OrgId;
  threadId: ThreadId;
  toolName: string;
  input: unknown;
  /** One line for the card, for example "Write inbox/2026-11-17-note.md". */
  summary: string;
  /** The rule "Always allow" would add to .claude/settings.local.json, for example "Bash(npm test)". */
  rule: string;
}

export type PermissionDecision = 'allow' | 'always' | 'deny';

// ---------- prerequisites ----------

export interface ClaudeStatus {
  found: boolean;
  path: string | null;
  version: string | null;
  supported: boolean;
  /** Human-readable supported range, for example ">=2.1.326 <2.2.0". */
  range: string;
}

export interface GitStatus {
  found: boolean;
  version: string | null;
  /** xcode-select -p failed: the developer tools are missing. */
  devToolsMissing: boolean;
}

export type PluginInstallState = 'ok' | 'missing' | 'enabled-not-installed' | 'unknown';

export interface PluginStatus {
  state: PluginInstallState;
  installed: string | null;
  /** Latest published release, null if unknown (offline). */
  latest: string | null;
  /** installed < latest. */
  updateAvailable: boolean;
  /** framework_version in org.yaml. */
  hqFrameworkVersion: string | null;
  /** hqFrameworkVersion < installed. */
  orgUpdateAvailable: boolean;
  /** installed < the app's minimum supported plugin version. */
  belowMinimum: boolean;
  minimum: string;
  /** The fetch of the latest release failed or timed out (so `latest` is unknown). */
  latestCheckFailed: boolean;
  /** COA_PLUGIN_DIR is in use: the plugin comes from a folder, not from the marketplace. */
  dev: boolean;
}

export interface PrereqStatus {
  claude: ClaudeStatus;
  /** null while unknown (Claude Code missing). */
  signedIn: boolean | null;
  git: GitStatus;
  /** null when no org is open. */
  plugin: PluginStatus | null;
  checkedAt: string;
}

export interface SignInState {
  running: boolean;
  /** The URL Claude Code printed, shown as is. */
  url: string | null;
  error: string | null;
}

/** The app's own update (app-wide), from the latest GitHub release of the app's repo. */
export type AppUpdateState = 'idle' | 'dev' | 'available' | 'downloading' | 'ready' | 'error';
export interface AppUpdateStatus {
  state: AppUpdateState;
  /** The running app's version. */
  current: string;
  /** The newest released version that has a .dmg, null when not known. */
  latest: string | null;
  /** Short message (state `error`), else null. */
  error: string | null;
}

export type PluginUpdateStep = 'checking' | 'plugin' | 'restart' | 'cos';
export type PluginActionState = {
  running: boolean;
  action: 'install' | 'update' | null;
  error: string | null;
  /** The step of the one Update while it runs (null or absent otherwise). */
  step?: PluginUpdateStep | null;
  /** True on the final emit of a successful update. */
  done?: boolean;
};

// ---------- hq health ----------

export type HealthColor = 'green' | 'yellow' | 'orange' | 'red';

export interface HealthStatus {
  color: HealthColor;
  /** One sentence for the user. */
  sentence: string;
  hasRemote: boolean;
  ahead: number;
  behind: number;
  lastSyncAt: string | null;
  autoPushFailing: boolean;
  syncing: boolean;
  /**
   * Allow rules the app ignores because they are too broad (informational: never changes `color`), by file: `local` is the
   * git-ignored `.claude/settings.local.json` (can be cleaned up with `cleanUpIgnoredRules`), `project` the committed
   * `.claude/settings.json` (the hq's own: the app never changes it). Absent when both are empty.
   */
  droppedRules?: { local: string[]; project: string[] };
  /**
   * Allow rules that Claude Code itself reads from the hq's settings files (the app cannot filter them) and that would let
   * an Artifact publish/delete or an AskUserQuestion run with no card: a broad `Artifact` rule or any `AskUserQuestion`
   * rule. Same split as `droppedRules`; `cleanUpIgnoredRules` removes the `local` ones, the committed ones are only shown.
   * Not counted in `droppedRules`. Informational: never changes `color`. Absent when both are empty.
   */
  broadRules?: { local: string[]; project: string[] };
  /**
   * `claude -p` processes an earlier run of the app started in this org and left running (a crash, a force quit): found at
   * start from the app's process ledger. Presence makes a green indicator yellow; absent when there are none.
   */
  leftoverProcesses?: Array<{ pid: number; startedAt: number }>;
  /** Short last auto push error while auto push is failing (no secrets), else null. */
  pushError: string | null;
  /**
   * A problem between this hq and GitHub that needs hands (a retry cannot fix it): `diverged` when both sides have new
   * commits, `files` when the same files changed on both sides (a real conflict).
   */
  conflict?: 'diverged' | 'files';
}

// ---------- settings ----------

/** Reasoning effort levels of `claude --effort` (Claude Code 2.1.x). */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Where an effective value came from: the hq's local or shared Claude Code settings, the user's own, or the app default. */
export type SettingSource = 'hq-local' | 'hq' | 'user' | 'default';

/** Where the CoS model came from: the user's choice in the app, org.yaml, or the Claude Code default. */
export type ModelSource = 'override' | 'org-yaml' | 'default';

/** The settings of one org, as the app shows them (effective values and their sources). */
export interface Settings {
  permissionMode: PermissionMode;
  permissionModeSource: SettingSource;
  effort: EffortLevel;
  effortSource: SettingSource;
  /** The user's own choice of CoS model (settings.local.json), null when none. */
  model: string | null;
  /** The model the CoS runs on: the choice, else models.cos in org.yaml, else null (Claude Code default). */
  cosModel: string | null;
  cosModelSource: ModelSource;
  /** models.cos in org.yaml, null if not set. */
  orgYamlModel: string | null;
  /** Model tiers from org.yaml (models.tiers); empty when the hq does not list any. */
  modelTiers: string[];
  /** Model ids the app has seen in init messages, newest first (offered as pins). */
  seenModels: string[];
  autoPush: boolean;
  /** Minutes of inactivity after which the chief of staff starts a new session: 15, 30, 60, 120, 240, or 0 for never. */
  newSessionAfterMinutes: number;
  /** Context size (tokens) at which the chief of staff continues in a new session: 50000, 100000, 150000, 200000, 400000, or 0 for never. */
  renewSessionAtTokens: number;
  /** Contextual tips on for this org (a switch in Settings > General; saved by the app, not in the hq). */
  tips: boolean;
}

/** What the user can change. `model: null` removes the choice (back to org.yaml). */
export interface SettingsPatch {
  permissionMode?: PermissionMode;
  effort?: EffortLevel;
  model?: string | null;
  autoPush?: boolean;
  newSessionAfterMinutes?: number;
  renewSessionAtTokens?: number;
  tips?: boolean;
}

/** The contextual tip to show above the composer: in the chat language, placeholders filled. */
export interface Tip {
  id: string;
  text: string;
  /** What a click puts in the composer. */
  phrase: string;
}

// ---------- dispatches (department liveness) ----------

/**
 * `running`: the agent is working. `done`, `failed`, `stopped`: it ended (shown until the user has seen the chief of
 * staff's report, then the dispatch leaves the list). `unknown`: the app can no longer track it (the chief of staff's
 * process ended, or the app restarted while it was running).
 */
export type DispatchState = 'running' | 'done' | 'failed' | 'stopped' | 'unknown';

/** Who made a dispatch when it is not the chief of staff: a department chat (tab) thread. */
export interface DispatchBy {
  /** The thread the Agent call was made in (`tab:<tabId>`). */
  threadId: string;
  /** The dispatching department's id; null when the chat's agent is no department of the org. */
  departmentId: string | null;
  /** The dispatching department's persona. */
  name: string;
}

/**
 * One Agent tool call made by the chief of staff or by a department chat (read from that thread's stream). State only,
 * never content.
 */
export interface Dispatch {
  /**
   * The Agent tool call id in the thread's session. For an agent resumed with SendMessage that the app had lost track of,
   * the SendMessage call id.
   */
  id: string;
  /** The agent name as dispatched (`subagent_type`). */
  agent: string;
  /** The department id when the agent is one of the org's departments; null for a worker or helper (shown under the chief of staff). */
  departmentId: string | null;
  /** The department's persona, or the agent name for a helper. */
  name: string;
  /** The short task description of the dispatch (plain text, may be empty). */
  description: string;
  /** Started with `run_in_background` (the chief of staff's turn does not wait for it). */
  background: boolean;
  state: DispatchState;
  /** ISO times, from the app's clock. */
  startedAt: string;
  /** The latest sign of work: a sub-agent message or a progress event. */
  lastActivityAt: string;
  /** When it ended; null while running and for `unknown`. */
  endedAt: string | null;
  /** Claude Code's agent id (`task_id` of `task_started`): what a SendMessage resume of this agent is matched by. */
  agentId?: string;
  /** Set for a dispatch made in a department chat; absent for the chief of staff's own. */
  by?: DispatchBy;
}

/** One allow rule as the Settings window lists it. `dropped`: the app does not pass it to Claude Code (too broad), as `filterHqAllowRules` decides for sessions. */
export interface AllowRuleEntry {
  rule: string;
  dropped: boolean;
}

/** One deny rule: from the hq's settings files or from the user's own Claude Code settings. */
export interface DenyRuleEntry {
  rule: string;
  source: 'hq' | 'user';
}

/** The permission rules of one org, for the Settings window. */
export interface PermissionRules {
  /** `permissions.allow` of the hq's committed `.claude/settings.json` (read-only here). */
  hqAllow: AllowRuleEntry[];
  /** `permissions.allow` of the hq's `.claude/settings.local.json`: the rules saved with "Always allow" (removable). */
  savedAllow: AllowRuleEntry[];
  /** The hq's `permissions.deny` and the user's own (read-only here). */
  deny: DenyRuleEntry[];
}

/** Versions and place of one org, for the About section. A null is shown as unknown. */
export interface AboutInfo {
  appVersion: string;
  /** From the last prerequisite check. */
  claudeVersion: string | null;
  claudeRange: string | null;
  /** From what the app already knows for this org (no network call). */
  pluginInstalled: string | null;
  pluginLatest: string | null;
  /** framework_version in the org's org.yaml. */
  frameworkVersion: string | null;
  hqPath: string;
}

/** Why a department's chats run under the MCP lock, from its agent file's `tools:` line. */
export type McpLockReason = 'no-tools-line' | 'all-tools';

/** One department's connectors, read from org.yaml and its agent file. */
export interface ConnectorDepartment {
  id: string;
  displayName: string;
  agent: string;
  /** from_catalog is legal, finance or tax: read-only connector tools, named one by one. */
  advisory: boolean;
  /** `connectors` of the department in org.yaml (the grant, as decided). */
  granted: string[];
  /** The `mcp__` entries of the `tools:` line of its agent file (what the agent can use). */
  inAgentFile: string[];
  /**
   * Why the department's chats are locked (only the app's own server loads): `no-tools-line` (no line, an empty one, or no readable agent
   * file) or `all-tools` (an entry `*`, which gives every tool); null when its tools line limits it.
   */
  mcpLock: McpLockReason | null;
}

/** A server of the hq's own `.mcp.json` (its name only, never anything inside it) and the pattern that grants all its tools. */
export interface AvailableConnector {
  server: string;
  pattern: string;
}

/** A connector (MCP server) a chat of the org has loaded, from the `mcp_servers` of Claude Code's init message. Names are untrusted text. */
export interface LoadedConnector {
  name: string;
  /** `connected`, `failed`, `needs-auth`, `pending` or any other word Claude Code gives. */
  status: string;
  /** The config scope Claude Code reports: `project`, `local`, `user`, `claudeai`, `dynamic`, ... (null when absent). */
  source: string | null;
  /** The chats that loaded it: the chief of staff's name, or a department's display name. */
  chats: string[];
  /** How the deny rules cut its tools: all of them, some of them, or none. */
  block: { kind: 'all' | 'some'; rule: string } | null;
}

/** The connectors of one org for the Settings window: grants per department, the forbidden list, what this hq offers. Read only. */
export interface ConnectorsInfo {
  departments: ConnectorDepartment[];
  /** `accounts.forbidden_connectors` of org.yaml. */
  forbidden: string[];
  /** `forbidden_connectors` of the hq's accounts.local.yaml (this computer only): the patterns, never anything else in that file. */
  forbiddenLocal: string[];
  /** What is wrong with the forbidden lists (a bad accounts.local.yaml, an item that is not a pattern, a pattern that is no rule...): until it is fixed MCP is locked in the org's chats (`session.mcpLocked`). */
  forbiddenProblems: string[];
  /** Forbidden rules that differ from a known server only by case: Claude Code matches case-sensitively, so they do not apply (at most 20). */
  forbiddenWarnings: string[];
  /** Servers of the hq's `.mcp.json`, minus the forbidden ones. Never the user's or the account's connectors. */
  available: AvailableConnector[];
  /** Servers of the `.mcp.json` that cannot be granted because their name has a `.` (Claude Code rewrites it in tool names), minus the forbidden ones. */
  notGrantable: string[];
  /** What the org's chats load, from the init message of their processes (memory only). */
  session: {
    /** Some chat of the org has had an init, so `loaded` is real. */
    started: boolean;
    loaded: LoadedConnector[];
    /** Servers kept from starting by a whole-server forbidden pattern (`deniedMcpServers`). */
    keptOut: string[];
    /** A forbidden pattern covers every claude.ai connector, so they are turned off for the org's chats. */
    claudeAiOff: boolean;
    /** The forbidden patterns as deny rules (what chats get in `--disallowedTools` besides the hq's and the user's). */
    forbiddenRules: string[];
    /** The forbidden lists have a problem: chats run with `--strict-mcp-config` and claude.ai connectors off (only the app's own server loads). */
    mcpLocked: boolean;
  };
  /** A readable reason when org.yaml could not be read (the lists are then empty), else null. */
  error: string | null;
}

// ---------- events main -> renderer (one channel) ----------

export type AppEvent =
  | { type: 'orgs'; orgs: OrgSummary[]; activeOrgId: OrgId | null }
  | { type: 'org-view'; orgId: OrgId; view: OrgView }
  | { type: 'thread-entry'; orgId: OrgId; threadId: ThreadId; entry: ThreadEntry }
  | { type: 'thread-delta'; orgId: OrgId; threadId: ThreadId; text: string }
  | { type: 'thread-state'; state: ThreadState }
  | { type: 'tabs'; orgId: OrgId; tabs: TabInfo[] }
  | { type: 'org-chart'; orgId: OrgId; chart: OrgChart }
  | { type: 'menu'; command: 'close-tab' | 'org-chart' | 'settings' | 'new-session' | 'focus-waiting' }
  | { type: 'permission'; request: PermissionRequest }
  | { type: 'permission-resolved'; requestId: string }
  | { type: 'prereq'; orgId: OrgId | null; status: PrereqStatus }
  | { type: 'sign-in'; state: SignInState }
  | { type: 'plugin-action'; orgId: OrgId; state: PluginActionState }
  /** The app's own update status changed (app-wide). */
  | { type: 'app-update'; status: AppUpdateStatus }
  | { type: 'health'; orgId: OrgId; status: HealthStatus }
  | { type: 'settings'; orgId: OrgId; settings: Settings }
  | { type: 'notice'; orgId: OrgId | null; text: string }
  /** The org's dispatches changed (the whole list: running ones and ended ones not yet seen). */
  | { type: 'dispatches'; orgId: OrgId; dispatches: Dispatch[] }
  /** The connectors a chat of the org has loaded changed (a new init): the Settings view asks again with `getConnectors`. */
  | { type: 'connectors'; orgId: OrgId }
  /** A department's dispatch ended (done, failed or stopped): the renderer shows a toast. Not sent for helpers or for `unknown`. */
  | { type: 'dispatch-ended'; orgId: OrgId; dispatch: Dispatch }
  /** Plan usage changed (after any chat's model call, or a `/usage` read; app-wide). */
  | { type: 'usage'; usage: PlanUsage }
  /** The "Create a new org" wizard run changed (its thread events use org id `setup` and the run id as thread id). */
  | ({ type: 'setup-state' } & SetupState);

// ---------- API renderer -> main (exposed as window.coa) ----------

export interface CoaApi {
  listOrgs(): Promise<{ orgs: OrgSummary[]; activeOrgId: OrgId | null }>;
  /** The last plan usage Claude Code reported in this app run, or null before the first reply. Changes arrive as `usage` events. */
  getUsage(): Promise<PlanUsage | null>;
  /** Reads plan usage now with `claude -p /usage` (a local command: no model call). The new value arrives as a `usage` event. */
  refreshUsage(): Promise<'ok' | 'skipped' | 'unavailable' | 'failed' | 'off'>;
  /** Folder picker; finds the hq in or below the chosen folder. Returns null and a notice if none. */
  openOrgDialog(): Promise<OrgSummary | null>;
  /** Opens (activates) a known org: starts its watchers, pull, prerequisites. */
  activateOrg(orgId: OrgId): Promise<OrgView | null>;
  getOrgView(orgId: OrgId): Promise<OrgView | null>;
  /** The org chart read from org.yaml and `.claude/agents/`, with the live status of its nodes. Changes arrive as `org-chart` events. */
  getOrgChart(orgId: OrgId): Promise<{ chart: OrgChart; live: OrgChartLive }>;
  getThread(orgId: OrgId, threadId: ThreadId): Promise<ThreadInfo | null>;
  /** Sends a message. Text may be empty when at least one image or file is attached (`files`: any other file, see `src/shared/attachments.ts`); the main process validates the attachments again and drops the whole send when one fails. */
  send(orgId: OrgId, threadId: ThreadId, text: string, images?: ImageAttachment[], files?: FileAttachment[]): Promise<void>;
  /**
   * Runs `command` (the text after "!") as the user in the org's hq folder, after a native confirmation that shows it.
   * Resolves true once it started, false when the user declined; throws when it is refused (empty, too long, hidden
   * characters, one already running in this chat). The output comes as a `command` entry and goes with the next message.
   */
  runCommand(orgId: OrgId, threadId: ThreadId, command: string): Promise<boolean>;
  /** Stops a running command (id from `ThreadState.commands`). */
  cancelCommand(orgId: OrgId, threadId: ThreadId, id: string): Promise<void>;
  /** An image of a thread entry as a `data:` URL, or null when the id is not valid or the file is gone. */
  getImage(orgId: OrgId, id: string): Promise<string | null>;
  /** The org's icon (`company/icon.png` in its hq) as a `data:` URL, or null when there is none or it is not usable. */
  getOrgIcon(orgId: OrgId): Promise<string | null>;
  /** Opens a picker (PNG, JPEG or WebP), checks the choice is a regular file within the size cap and returns its bytes for the renderer to decode and resize. Null when the picker is cancelled. Nothing is written. */
  pickOrgIcon(orgId: OrgId): Promise<OrgIconPick | null>;
  /** Writes the 256 px square PNG the renderer made (base64, no `data:` prefix) to `company/icon.png` after validating it (PNG signature, size cap, dimensions). The new icon arrives with an `orgs` event. */
  saveOrgIcon(orgId: OrgId, png: string): Promise<OrgIconResult>;
  /** Deletes the org's icon file; ok also when there was none. */
  removeOrgIcon(orgId: OrgId): Promise<{ ok: boolean }>;
  /** The CEO's voice file in the hq (`ceo.voice` of org.yaml, default `company/ceo-voice.md`). Never throws; `exists` is false when there is none. */
  getVoice(orgId: OrgId): Promise<VoiceInfo>;
  /** Writes the voice file in the hq (atomic; creates the folders). Refused with `conflict` when the file changed since `expectedVersion` (the token `getVoice` gave). The app never commits or pushes it. */
  saveVoice(orgId: OrgId, text: string, expectedVersion: string): Promise<VoiceSaveResult>;
  listTabs(orgId: OrgId): Promise<TabInfo[]>;
  /** Ends an open department chat for good: its process is killed and it cannot be reopened or read. Rejects for the CoS and for a chat being handed over. */
  closeTab(orgId: OrgId, tabId: string): Promise<void>;
  /** Starts a chat with a department, or returns its open one (one open chat per department). */
  startTab(orgId: OrgId, agent: string): Promise<TabInfo>;
  handOver(orgId: OrgId, tabId: string): Promise<void>;
  /** `rule` is the user's edited rule for 'always'; the app checks it and keeps its own proposal if it is not valid. */
  respondPermission(requestId: string, decision: PermissionDecision, rule?: string): Promise<void>;
  /** Answers a pending AskUserQuestion card: one value per question, keyed by the question text. False when the answers do not fit. */
  answerQuestion(requestId: string, answers: Record<string, string>): Promise<boolean>;
  checkPrereqs(orgId: OrgId | null): Promise<PrereqStatus>;
  signIn(): Promise<void>;
  cancelSignIn(): Promise<void>;
  installPlugin(orgId: OrgId): Promise<void>;
  /** The app's own update status (checks GitHub at most once an hour; `force` skips that cache). Changes arrive as `app-update` events. */
  getAppUpdate(force?: boolean): Promise<AppUpdateStatus>;
  /** "Update app": downloads and stages the newest release, then asks the app to quit through the usual quit path (handover check, run guard). The new version is installed when the app exits. While one is staged, calling it again only asks to quit again. */
  updateApp(): Promise<void>;
  /** The one Update button: updates the plugin when it is behind, restarts the chats, then asks the chief of staff to apply the hq migrations. */
  updateOrg(orgId: OrgId): Promise<void>;
  openTerminal(): Promise<void>;
  getHealth(orgId: OrgId): Promise<HealthStatus>;
  /** Runs the automatic push now (the Retry button), then refreshes health. */
  retryPush(orgId: OrgId): Promise<void>;
  sync(orgId: OrgId): Promise<void>;
  /** Chat > New Session: the chief of staff's next message sent from idle starts a new Claude Code session. Resolves false when one is already requested. */
  newSession(orgId: OrgId): Promise<boolean>;
  /**
   * Removes the ignored allow rules from this org's `.claude/settings.local.json` only (the main process recomputes which
   * ones; it never touches `settings.json`), refreshes health and returns how many it removed. Rejects when the file is
   * missing or not valid JSON.
   */
  cleanUpIgnoredRules(orgId: OrgId): Promise<number>;
  /**
   * Stops one `claude -p` process an earlier app run left running in this org (SIGTERM to its process group, SIGKILL after 4 s).
   * The main process checks again that the pid is one the app started in this org; anything else resolves false.
   */
  stopLeftoverProcess(orgId: OrgId, pid: number): Promise<boolean>;
  /** Sets this chat's model and/or effort (a missing key stays, null is the org default). Applies from the next message. */
  setThreadRun(orgId: OrgId, threadId: ThreadId, choice: { model?: string | null; effort?: EffortLevel | null }): Promise<ThreadInfo | null>;
  getSettings(orgId: OrgId): Promise<Settings>;
  /** The contextual tips that apply to this org now (not dismissed), in display order (the first is the current tip); empty when none or tips are off. */
  getTips(orgId: OrgId): Promise<Tip[]>;
  /** "Got it" for one tip (hides it for good), saved per org by the app. */
  dismissTip(orgId: OrgId, tipId: string): Promise<void>;
  setSettings(orgId: OrgId, patch: SettingsPatch): Promise<Settings>;
  /** Restarts the org's chats once the current reply and queue are done, so new settings take effect. */
  applySettings(orgId: OrgId): Promise<void>;
  /** The org's allow and deny rules, for the Settings window. Works for any registered org, active or not. */
  getPermissionRules(orgId: OrgId): Promise<PermissionRules>;
  /** Removes exactly this rule from the hq's `.claude/settings.local.json` (a rule saved with Always allow); returns the lists after. */
  removeSavedRule(orgId: OrgId, rule: string): Promise<PermissionRules>;
  /** App, Claude Code, plugin and org versions of the org, for the About section. */
  getAbout(orgId: OrgId): Promise<AboutInfo>;
  /** Connectors granted per department, the forbidden ones and the servers of the hq's `.mcp.json`. Reads files only, never writes: a grant is asked of the chief of staff, who prepares a decision card. */
  getConnectors(orgId: OrgId): Promise<ConnectorsInfo>;
  /** The body of `initiatives/<slug>/status.md` without its frontmatter, for the readable view. Null for a bad slug, a missing, linked or oversize file. Never throws. */
  readInitiative(orgId: OrgId, slug: string): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  /** The catalog and approval gates of the installed plugin, for the "Create a new org" screens; `error` when the plugin is not installed or unreadable. */
  setupData(): Promise<SetupData | { error: string }>;
  /** Folder picker for the new org (can create a folder); null when cancelled. `ok` is false when the folder holds more than `.git` and `.claude/settings.json`. */
  pickSetupFolder(): Promise<SetupFolderPick | null>;
  /** Starts the setup wizard in `folder` with these answers (installs the plugin first when it is missing). Events: `thread-entry`, `thread-delta`, `thread-state` (org id `setup`, thread id `setup:<runId>`), `setup-state`, `permission`. */
  startSetup(answers: SetupAnswers, folder: string): Promise<{ runId: string } | { error: string }>;
  /** A message to the wizard (queued while it replies). */
  sendSetup(runId: string, text: string): Promise<void>;
  /** Ends the run: stops the process, forgets the answers file. The folder is left as it is. */
  stopSetup(runId: string): Promise<void>;
  /** Ends the run and adds the new hq (the folder) to the app's orgs; null when the folder holds no hq. */
  finishSetup(runId: string): Promise<OrgSummary | null>;
  /** The transcript of a run (for a reloaded window); null for an unknown run. Pending permission cards are sent again as events. */
  getSetupThread(runId: string): Promise<ThreadInfo | null>;
  /** The current state of a run; null for an unknown run. */
  getSetupState(runId: string): Promise<SetupState | null>;
  /** Tells the main process whether the focus view of "Waiting on you" can open (an org is open and something waits): enables or disables View > Waiting on you: focus view. */
  setWaitingFocusAvailable(available: boolean): Promise<void>;
  /** The chief of staff's dispatches of this org: running ones, and ended ones the user has not seen yet. */
  getDispatches(orgId: OrgId): Promise<Dispatch[]>;
  /** The user has seen these ended dispatches (and the chief of staff's report): they leave the list. Running ids are ignored. */
  ackDispatches(orgId: OrgId, ids: string[]): Promise<void>;
  onEvent(listener: (event: AppEvent) => void): () => void;
}
