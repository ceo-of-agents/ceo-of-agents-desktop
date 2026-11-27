import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { EffortLevel, InboxPendingNote, PermissionDecision, PermissionMode, PermissionRequest, SettingsPatch, TabStatus, ThreadEntry, ThreadId, ThreadInfo } from '../shared/types';
import { ASK_USER_QUESTION, isQuestionRequest } from '../shared/questions';
import { QuestionCard } from './QuestionCard';
import { t } from '../shared/strings';
import { api } from './api';
import { ComposerFiles, MessageFiles, hasVideo } from './ComposerFiles';
import { ComposerThumbs, MessageImages } from './ComposerImages';
import { MAX_IMAGES, imageProblemText, type ImageProblem } from '../shared/images';
import { MAX_FILES, fileProblemText, screenFiles } from '../shared/attachments';
import { draftBytes, draftFiles, readAttachment, splitFiles, type DraftFile } from './composer-files';
import { draftText, useDraftText } from './draft-text';
import { dragHasFiles, draftImages, imageFilesFromPaste, ipcErrorText, readImageFile, restoreAfterRejectedSend, screenCandidates, type DraftImage } from './composer-images';
import { AlertCircle, ArrowDown, ArrowRightLeft, ArrowUp, Check, ChevronRight, Paperclip, X } from './icons';
import { CopyButton } from './CopyButton';
import { DraftCopy, DraftForm } from './DraftForm';
import { draftResults, type DraftResult } from '../shared/voice';
import { AutoModeConfirm } from './AutoModeConfirm';
import { PERMISSION_MODES, needsAutoConfirm, chatEffortOptions, chatEffortShown, chatModelOptions, chatModeShown, chatModelShown, chatModelTip, elapsedLabel, livePhase, runLabel, runPendingNote, stepsLabel, turnModelTip, withDaySeparators } from './logic';
import { InlineMarkdown, Markdown } from './Markdown';
import { stripMarkdown } from './markdown-safety';
import {
  activitySummary, bumpSentCount, clockTime, commandOf, commandStatus, errorAction, errorReason, groupRows, isProcessExited, lastUserText, mergeLeaving, normalizeSteps, readSentCount,
  replyMessage, sessionDividerLabel, showHint, stepDuration, type GroupedRow, type Leaving, type ReplyTarget,
} from './thread-logic';
import { Button } from './ui/Button';
import { Fold } from './ui/Fold';
import { LogoMark } from './ui/LogoMark';
import { useDelayed } from './ui/hooks';
import { Presence } from './ui/Presence';
import { keyTargetOf, nestedScrollerConsumes, scrollKeyIntent, wheelIntent, type Intent } from './scroll-intent';
import { createStickToBottom, type ScrollMetrics, type StickState } from './stick-to-bottom';
import { Spinner } from './ui/Spinner';
import { Tooltip } from './ui/Tooltip';

// ---------- small hooks ----------

/** The current time, ticking every second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** `value`, but changing at most once every `ms` (for text a screen reader announces). */
function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const last = useRef(Date.now());
  useEffect(() => {
    const id = setTimeout(
      () => {
        last.current = Date.now();
        setShown(value);
      },
      Math.max(0, last.current + ms - Date.now()),
    );
    return () => clearTimeout(id);
  }, [value, ms]);
  return shown;
}

const LEAVE_MS = 220;

/** The list, plus the items that just left it (marked `leaving` for `LEAVE_MS`) so they can collapse. */
function useLeaving<T>(items: T[], keyOf: (item: T) => string): Leaving<T>[] {
  const [rows, setRows] = useState<Leaving<T>[]>(() => items.map((item) => ({ item, leaving: false })));
  const keyRef = useRef(keyOf);
  keyRef.current = keyOf;
  useEffect(() => {
    setRows((prev) => {
      const next = mergeLeaving(prev, items, keyRef.current);
      return next.length === prev.length && next.every((n, i) => n.item === prev[i].item && n.leaving === prev[i].leaving) ? prev : next;
    });
  }, [items]);
  const anyLeaving = rows.some((r) => r.leaving);
  useEffect(() => {
    if (!anyLeaving) return;
    const id = setTimeout(() => setRows((prev) => prev.filter((r) => !r.leaving)), LEAVE_MS);
    return () => clearTimeout(id);
  }, [anyLeaving]);
  // Until the effect has merged a new item, show it already (no one-frame gap).
  const known = new Set(rows.map((r) => keyOf(r.item)));
  return [...rows, ...items.filter((i) => !known.has(keyOf(i))).map((item) => ({ item, leaving: false }))];
}

// ---------- messages ----------

function NameLine({ name, time, you, model }: { name: string; time: string; you: boolean; model?: string }) {
  const nameEl = <span className={`name ${you ? 'you' : 'sys'}`}>{name}</span>;
  return (
    <div className="name-line">
      {model ? <Tooltip label={turnModelTip(model)} placement="top">{nameEl}</Tooltip> : nameEl}
      {time && <time className="when">{time}</time>}
    </div>
  );
}

/** The Hand over button: disabled, with a tooltip that says why, until the department has done some work. */
export function HandOverButton({ pendingWork, cosName, persona, onClick }: { pendingWork: boolean; cosName: string; persona: string; onClick(): void }) {
  const btn = (
    <Button variant="primary" disabled={!pendingWork} onClick={onClick}>
      {t('thread.handOver', { cosName })}
    </Button>
  );
  if (pendingWork) return btn;
  return (
    <Tooltip label={t('dept.handOverNoWork', { persona })} placement="bottom">
      <span>{btn}</span>
    </Tooltip>
  );
}

/**
 * The banner above the chief of staff's composer: handoff notes wait in inbox/. The button sends one "process the inbox"
 * message: it stays disabled from the first click until the thread turns busy (or the send fails), so a double click sends once.
 */
export function InboxBanner({ notes, cosName, disabled, busy, onAsk }: { notes: InboxPendingNote[]; cosName: string; disabled: boolean; busy: boolean; onAsk(): Promise<unknown> | void }) {
  const [asked, setAsked] = useState(false);
  // The ref guards two clicks that arrive before the next render; the state disables the button.
  const sent = useRef(false);
  useEffect(() => {
    if (busy) {
      sent.current = false;
      setAsked(false);
    }
  }, [busy]);
  if (notes.length === 0) return null;
  const click = () => {
    if (sent.current || disabled || busy) return;
    sent.current = true;
    setAsked(true);
    Promise.resolve(onAsk()).catch(() => {
      sent.current = false;
      setAsked(false);
    });
  };
  return (
    <div className="inbox-banner" role="status">
      <span className="inbox-banner-text">
        {t(notes.length === 1 ? 'cos.inbox.waiting.one' : 'cos.inbox.waiting.many', {
          count: notes.length,
          names: [...new Set(notes.map((n) => n.name ?? t('cos.inbox.unknown')))].join(', '),
        })}
      </span>
      <Button variant="quiet" small disabled={disabled || busy || asked} onClick={click}>
        {t('cos.inbox.ask', { cosName })}
      </Button>
    </div>
  );
}

function ErrorPlate({ text, action, persona, onRetry, onStart, onAskNote }: { text: string; action: 'retry' | 'start' | 'askNote' | null; persona: string; onRetry(): void; onStart(): void; onAskNote(): void }) {
  return (
    <div className="plate error" role="group" aria-label={t('thread.errorLabel')}>
      <span className="err-mark" aria-hidden="true">
        !
      </span>
      <span className="plate-text">{errorReason(text)}</span>
      {action && (
        <Button variant="quiet" small onClick={action === 'retry' ? onRetry : action === 'askNote' ? onAskNote : onStart}>
          {action === 'retry' ? t('activity.retry') : action === 'askNote' ? t('dept.askNote', { persona }) : t('error.startAgain')}
        </Button>
      )}
    </div>
  );
}

/** A finished turn: "6 steps · 0:42", unfolding into the list of steps. */
function TurnSummary({ entry, fresh }: { entry: ThreadEntry; fresh: boolean }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const steps = normalizeSteps(entry.steps);
  return (
    <div className={`turn-activity done${fresh ? ' fresh' : ''}`}>
      <button type="button" className="step-summary" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((o) => !o)}>
        <ChevronRight size={10} className="chev" />
        <span className="tabular">{activitySummary(entry)}</span>
      </button>
      <Fold open={open} id={listId}>
        <ul className="step-list">
          {steps.map((step, i) => (
            <li key={i} className={`step${step.failed ? ' failed' : ''}`}>
              {step.failed ? <AlertCircle size={12} className="step-icon" /> : <Check size={12} className="step-icon" />}
              <span className="step-text">{step.text}</span>
              {step.detail && <code className="step-detail">{step.detail}</code>}
              <span className="step-ms tabular">{stepDuration(step.durationMs)}</span>
            </li>
          ))}
        </ul>
      </Fold>
    </div>
  );
}

interface EntryProps {
  entry: ThreadEntry;
  orgId: string;
  speaker: string;
  first: boolean;
  fresh: boolean;
  /** The summary of the turn that wrote this message: shown between the name line and the text. */
  activity?: ThreadEntry;
  /** The action of an error line, when it has one. */
  action: 'retry' | 'start' | 'askNote' | null;
  /** The draft this assistant message holds (the answer to a Draft request): it gets Copy buttons. */
  draft?: DraftResult;
  onRetry(): void;
  onStart(): void;
  onAskNote(): void;
}

function Entry({ entry, orgId, speaker, first, fresh, activity, action, draft, onRetry, onStart, onAskNote }: EntryProps) {
  const enter = fresh ? ' enter' : '';
  switch (entry.kind) {
    case 'user':
      return (
        <div className={`msg user${first ? '' : ' cont'}${enter}`}>
          {first ? <NameLine name={entry.author || speaker} time={clockTime(entry.time)} you /> : <time className="when hover">{clockTime(entry.time)}</time>}
          {entry.images && entry.images.length > 0 && <MessageImages orgId={orgId} images={entry.images} />}
          {entry.files && entry.files.length > 0 && <MessageFiles files={entry.files} />}
          {entry.text && <div className="plate-user">{entry.text}</div>}
        </div>
      );
    case 'assistant':
      return (
        // With a summary the swap from the live line is the summary's own 180 ms fade; the text was already on screen.
        <div className={`msg assistant${first ? '' : ' cont'}${activity ? '' : enter}`}>
          {first ? <NameLine name={entry.author || speaker} time={clockTime(entry.time)} you={false} model={entry.model} /> : <time className="when hover">{clockTime(entry.time)}</time>}
          {activity && <TurnSummary entry={activity} fresh={fresh} />}
          <div className="text md">
            <Markdown text={entry.text} />
          </div>
          {entry.text && (
            <div className="msg-actions">
              <CopyButton text={entry.text} label={t('copy.message')} />
            </div>
          )}
          {draft && <DraftCopy draft={draft} />}
        </div>
      );
    case 'activity':
      // A turn that wrote no message (it failed or said nothing): the summary still sits under the name line.
      return (
        <div className={`msg assistant${enter}`}>
          <NameLine name={speaker} time={clockTime(entry.time)} you={false} model={entry.model} />
          <TurnSummary entry={entry} fresh={fresh} />
        </div>
      );
    case 'system':
      if (isProcessExited(entry)) return <ErrorPlate text={entry.text} action={action} persona={speaker} onRetry={onRetry} onStart={onStart} onAskNote={onAskNote} />;
      return <div className="line system">{entry.text}</div>;
    case 'session':
      return (
        <div className="day-sep session-sep">
          <span>{sessionDividerLabel(entry)}</span>
        </div>
      );
    case 'error':
      return <ErrorPlate text={entry.text} action={action} persona={speaker} onRetry={onRetry} onStart={onStart} onAskNote={onAskNote} />;
    case 'handoff':
      return (
        <div className={`card handoff${enter}`}>
          <ArrowRightLeft className="handoff-icon" />
          <span className="handoff-title">
            <InlineMarkdown text={entry.text} />
            {entry.earlierNote && <span className="handoff-earlier">{t('cos.handoff.earlierNote')}</span>}
          </span>
        </div>
      );
    case 'permission':
      return <div className="line system">{t('thread.permissionResolved', { text: entry.text })}</div>;
    case 'command':
      return <CommandEntry entry={entry} fresh={fresh} />;
    default:
      return null;
  }
}

/** A command the user ran with "!": marked as the user's, with its output and how it ended. */
function CommandEntry({ entry, fresh }: { entry: ThreadEntry; fresh: boolean }) {
  const run = entry.command;
  const output = run ? [run.stdout.replace(/\n$/, ''), run.stderr.replace(/\n$/, '')].filter(Boolean).join('\n') : '';
  return (
    <div className={`msg user command${fresh ? ' enter' : ''}`}>
      <NameLine name={entry.author} time={clockTime(entry.time)} you />
      <div className="plate-command">
        <div className="command-by">{t('command.ranBy')}</div>
        <pre className="command-line">! {entry.text}</pre>
        <pre className="command-output">{output || t('command.noOutput')}</pre>
        {run && (
          <div className={`command-status ${run.outcome}`}>
            {commandStatus(run)}
            {run.truncated ? ` · ${t('command.truncated')}` : ''}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- message list ----------

/** Above this many rows the list renders only the rows near the viewport; a shorter chat renders them all. */
export const VIRTUAL_MIN_ROWS = 80;
const VIRTUAL_OVERSCAN = 8;

const rowKey = (r: GroupedRow): string => (r.type === 'day' ? `day-${r.day}` : r.type === 'tools' ? `tools-${r.id}` : r.entry.id);
const estimateRow = (r: GroupedRow): number => (r.type === 'day' ? 76 : r.type === 'tools' ? 34 : r.entry.kind === 'assistant' ? 220 : 72);

interface MessageListProps {
  rows: GroupedRow[];
  /** The Draft answers by entry id (they get Copy buttons). */
  drafts: Map<string, DraftResult>;
  orgId: string;
  speaker: string;
  /** The last entry of the thread: only it carries an error's action. */
  lastId: string | undefined;
  /** "Try again" is offered (the last message is the user's and the chat is idle). */
  retryOffered: boolean;
  canAskNote: boolean;
  isFresh(id: string): boolean;
  onRetry(): void;
  onStart(): void;
  onAskNote(): void;
  /** The scroll box the virtual list measures against (null until it is mounted). */
  scrollEl: HTMLElement | null;
}

function MessageRow({ r, p }: { r: GroupedRow; p: MessageListProps }) {
  if (r.type === 'day') {
    return (
      <div className="day-sep">
        <span>{new Date(r.time).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</span>
      </div>
    );
  }
  if (r.type === 'tools') {
    return (
      <div className="turn-activity done">
        <span className="step-summary static tabular">{stepsLabel(r.count)}</span>
      </div>
    );
  }
  const action = r.entry.id === p.lastId ? errorAction(r.entry, p.retryOffered) : null;
  return (
    <div className={`row-wrap ${r.gap}`} data-kind={r.entry.kind}>
      <Entry
        entry={r.entry}
        orgId={p.orgId}
        speaker={p.speaker}
        first={r.first}
        fresh={p.isFresh(r.entry.id)}
        activity={r.activity}
        draft={p.drafts.get(r.entry.id)}
        // Only the latest error in a thread carries the action ("Try again" / "Start again"): an older error plate has none, whatever its text.
        action={action === 'askNote' && !p.canAskNote ? null : action}
        onRetry={p.onRetry}
        onStart={p.onStart}
        onAskNote={p.onAskNote}
      />
    </div>
  );
}

/** Only the rows near the viewport are in the DOM; each sits in an absolutely placed box that the virtualizer measures. */
function VirtualRows(p: MessageListProps) {
  const { rows } = p;
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => p.scrollEl,
    estimateSize: (i) => estimateRow(rows[i]),
    overscan: VIRTUAL_OVERSCAN,
    // A chat that just opened starts at its bottom (the scroll box is not known yet): begin past the end, the box clamps it. A list that
    // grows past the threshold while the box is there keeps the reader where they are.
    initialOffset: () => (p.scrollEl ? p.scrollEl.scrollTop : rows.reduce((n, r) => n + estimateRow(r), 0)),
    getItemKey: (i) => rowKey(rows[i]),
  });
  const lastRow = rows[rows.length - 1];
  return (
    <div className="vlist" style={{ height: virt.getTotalSize() }} data-last={lastRow?.type === 'entry' ? lastRow.entry.kind : undefined}>
      {virt.getVirtualItems().map((v) => {
        const prev = rows[v.index - 1];
        return (
          <div
            key={v.key}
            ref={virt.measureElement}
            data-index={v.index}
            className="vrow"
            data-first={v.index === 0 ? '' : undefined}
            data-after={prev?.type === 'entry' ? prev.entry.kind : undefined}
            style={{ transform: `translateY(${v.start}px)` }}
          >
            <MessageRow r={rows[v.index]} p={p} />
          </div>
        );
      })}
    </div>
  );
}

/** The thread's rows. Memoized: its props stay the same while the user types, so a keystroke renders no message. */
const MessageList = memo(function MessageList(p: MessageListProps) {
  if (p.rows.length > VIRTUAL_MIN_ROWS) return <VirtualRows {...p} />;
  return (
    <>
      {p.rows.map((r) => (
        <MessageRow key={rowKey(r)} r={r} p={p} />
      ))}
    </>
  );
});

/** The live line of the turn in flight: what it is doing now and for how long. Folds into a summary row when the turn ends. */
function LiveLine({ thread, permissionPending, questionPending }: { thread: ThreadInfo; permissionPending: boolean; questionPending: boolean }) {
  const now = useNow(true);
  const delayed = useDelayed(true, 300);
  const { phase, text } = livePhase({ permissionPending, questionPending, streaming: thread.streaming, current: thread.activity?.current });
  const announced = useThrottled(text, 2000);
  // "Thinking" only shows after 300 ms, so a quick reply never flashes it.
  if (phase === 'thinking' && !delayed) return null;
  const elapsed = elapsedLabel(thread.activity?.startedAt, now);
  return (
    <div className="turn-slot">
    <div className="turn-activity live" data-phase={phase}>
      {phase === 'permission' || phase === 'question' ? <span className="ring" aria-hidden="true" /> : <Spinner delay={0} />}
      <span className="live-text" key={text} aria-hidden="true">
        {text}
      </span>
      <span className="sr-only" aria-live="polite">
        {announced}
      </span>
      {elapsed && <span className="live-time tabular">{elapsed}</span>}
    </div>
    </div>
  );
}

// ---------- permission card ----------

/** `onOpenSettings` is left out where there is no org yet (the Create a new org run): the Settings link is not shown. */
export function PermissionCard({ request, onOpenSettings }: { request: PermissionRequest; onOpenSettings?(): void }) {
  const [rule, setRule] = useState(request.rule);
  const respond = (d: PermissionDecision) => void api().respondPermission(request.requestId, d, d === 'always' ? rule : undefined);
  // An AskUserQuestion call that did not parse lands here: Allow would answer nothing, so the one way out is to have Claude ask in the chat.
  if (request.toolName === ASK_USER_QUESTION) {
    return (
      <div className="card permission">
        <div className="card-title">{t('permission.title')}</div>
        <div className="card-summary">{t('permission.question.unreadableNote')}</div>
        <div className="row">
          <Button variant="you" small onClick={() => respond('deny')}>
            {t('permission.question.askInChat')}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="card permission">
      <div className="card-title">{t('permission.title')}</div>
      <div className="card-summary">{request.summary}</div>
      {request.rule && (
        <div className="rule">
          <label className="muted small" htmlFor={`rule-${request.requestId}`}>
            {t('permission.ruleLabel')}
          </label>
          <input id={`rule-${request.requestId}`} className="rule-input" type="text" value={rule} spellCheck={false} onChange={(e) => setRule(e.target.value)} />
        </div>
      )}
      <div className="row">
        <Button variant="you" small onClick={() => respond('allow')}>
          {t('permission.allow')}
        </Button>
        {request.rule && (
          <Button variant="you-outline" small onClick={() => respond('always')}>
            {t('permission.always')}
          </Button>
        )}
        <Button small onClick={() => respond('deny')}>
          {t('permission.deny')}
        </Button>
      </div>
      {onOpenSettings && (
        <button className="link-btn small" onClick={onOpenSettings}>
          {t('permission.settingsLink')}
        </button>
      )}
    </div>
  );
}

// ---------- composer ----------

const MAX_COMPOSER_PX = 8 * 22 + 6; // eight lines of 22 px plus the textarea's own padding

/** The composer's text box. It reads and writes the chat's draft in `draftText`, so a keystroke renders this and its two neighbours below, not the thread. */
function DraftBox({ draftKey, inputRef, reply, disabled, placeholder, onTyped, onSubmit, onEscape }: {
  draftKey: string;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  reply: ReplyTarget | null;
  disabled: boolean;
  placeholder: string;
  onTyped(): void;
  onSubmit(): void;
  onEscape(): void;
}) {
  const text = useDraftText(draftKey);
  // The box grows with the text, one to eight lines.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_PX)}px`;
  }, [inputRef, text, reply]);
  return (
    <textarea
      ref={inputRef}
      rows={1}
      value={text}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => {
        draftText.set(draftKey, e.target.value);
        onTyped();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          onSubmit();
        } else if (e.key === 'Escape' && reply) {
          e.preventDefault();
          onEscape();
        }
      }}
    />
  );
}

/** The send button: ready when the text or an attachment is there. */
function SendButton({ draftKey, hasAttachments, canWrite, onClick }: { draftKey: string; hasAttachments: boolean; canWrite: boolean; onClick(): void }) {
  const hasContent = useDraftText(draftKey).trim() !== '' || hasAttachments;
  return (
    <button type="button" className={`send${hasContent ? ' ready' : ''}`} aria-label={t('thread.send')} disabled={!canWrite || !hasContent} onClick={onClick}>
      <ArrowUp />
    </button>
  );
}

/** The line at the left of the composer foot: the command hint while the text starts with "!", else the usual hint (`otherHint`). */
function ComposerHint({ draftKey, canWrite, name, otherHint }: { draftKey: string; canWrite: boolean; name: string; otherHint: string }) {
  const text = useDraftText(draftKey);
  return <span className="hint">{canWrite && commandOf(text) !== null ? t('composer.commandHint', { name }) : otherHint}</span>;
}

/** A picker in the footer: the face reads "Model: Opus"; the native menu behind it lists the options (the current one has the check). */
function QuietSelect({ label, shown, tip, value, disabled, onChange, children }: { label: string; shown: string; tip?: string; value: string; disabled: boolean; onChange(value: string): void; children: React.ReactNode }) {
  const el = (
    <span className={`quiet-select${disabled ? ' disabled' : ''}`}>
      <span className="quiet-face" aria-hidden="true">
        {shown}
        <ChevronRight size={12} className="quiet-chev" />
      </span>
      <select aria-label={label} disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </span>
  );
  return tip ? <Tooltip label={tip} placement="top">{el}</Tooltip> : el;
}

interface Props {
  orgId: string;
  threadId: ThreadId;
  title: string;
  thread: ThreadInfo | undefined;
  speakerFallback: string;
  isCos: boolean;
  cosName: string;
  tabStatus: TabStatus | null;
  persona: string;
  permissions: PermissionRequest[];
  /** The waiting item being replied to (chief of staff only); shown as a chip in the composer. */
  reply: ReplyTarget | null;
  focusNonce: number;
  /** A tip was clicked (chief of staff only): when `nonce` is new, the box takes focus and selects `selStart`..`selEnd` (the text is already in `draftText`). */
  insertRequest?: { nonce: number; selStart: number; selEnd: number } | null;
  /** The insert request was applied: the app drops it, so a later mount of this chat does not apply it again. */
  onInsertDone?(): void;
  onClearReply(): void;
  /** Puts a reply chip back (after a refused send). */
  onRestoreReply(target: ReplyTarget): void;
  /** The chat did work since it opened or since its last handoff (the Hand over button is enabled). */
  pendingWork: boolean;
  onHandOver(): void;
  /** Opens this org's Settings (the permission card links to it). */
  onOpenSettings(): void;
  /** Writes an org setting (the footer's mode select); App handles a failure with a toast. */
  onSetSettings(patch: SettingsPatch): void;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function ThreadView(p: Props) {
  const { thread } = p;
  // Switching the org to Auto mode waits for this inline confirm.
  const [confirmAuto, setConfirmAuto] = useState(false);
  const entries = useMemo(() => thread?.entries ?? [], [thread?.entries]);
  const rows = useMemo(() => groupRows(withDaySeparators(entries)), [entries]);
  const drafts = useMemo(() => draftResults(entries), [entries]);
  const [draftOpen, setDraftOpen] = useState(false);
  const handingOver = p.tabStatus === 'handing-over';
  const speaker = stripMarkdown(thread?.speaker || p.speakerFallback);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // The scroll box as state too, so the virtual list gets it once it is mounted.
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null);
  const setBody = useCallback((el: HTMLDivElement | null) => {
    bodyRef.current = el;
    setBodyEl(el);
  }, []);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Follows the end while the reader is at the bottom (see stick-to-bottom.ts); the state it exposes drives the Jump button.
  const [stick] = useState(createStickToBottom);
  const [view, setView] = useState<StickState>(() => stick.state());
  const [sent, setSent] = useState(() => readSentCount(storage()));
  const permissions = useLeaving(p.permissions, (r) => r.requestId);
  // Images waiting in the composer: kept per chat while another tab is shown (the view is remounted per chat), like the text draft.
  const draftKey = `${p.orgId}|${p.threadId}`;
  const [imgs, setImgs] = useState<DraftImage[]>(() => draftImages.get(draftKey));
  const imgsRef = useRef(imgs);
  imgsRef.current = imgs;
  // The other files waiting in the composer, kept the same way.
  const [fls, setFls] = useState<DraftFile[]>(() => draftFiles.get(draftKey));
  const flsRef = useRef(fls);
  flsRef.current = fls;
  const fileInput = useRef<HTMLInputElement>(null);
  // The chip as it is now, for the catch of a refused send (the closure of `submit` holds the value from the click). The text is read from `draftText`.
  const nowRef = useRef({ reply: p.reply });
  nowRef.current = { reply: p.reply };
  const nowInsert = useRef<{ selStart: number; selEnd: number; done?(): void } | null>(null);
  nowInsert.current = p.insertRequest ? { selStart: p.insertRequest.selStart, selEnd: p.insertRequest.selEnd, done: p.onInsertDone } : null;
  const imgSeq = useRef(0);
  const [imgError, setImgError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  useEffect(() => draftImages.set(draftKey, imgs), [draftKey, imgs]);
  useEffect(() => draftFiles.set(draftKey, fls), [draftKey, fls]);

  // Messages that were there when the thread first showed do not animate; later ones do.
  const baseline = useRef<Set<string> | null>(null);
  if (baseline.current === null && thread) baseline.current = new Set(entries.map((e) => e.id));

  const syncView = useCallback(() => {
    const next = stick.state();
    setView((v) => (v.pinned === next.pinned && v.hasNew === next.hasNew ? v : next));
  }, [stick]);

  // The controller decides; the view applies. `act` runs one controller call on the scroll box and scrolls to what comes back.
  const act = useCallback(
    (call: (m: ScrollMetrics) => number | null, smooth = false) => {
      const el = bodyRef.current;
      if (!el) return;
      const top = call({ scrollHeight: el.scrollHeight, scrollTop: el.scrollTop, clientHeight: el.clientHeight });
      if (top !== null) el.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
      syncView();
    },
    [syncView],
  );
  // The box or the content changed size without anything new to read (a fold opening, a reflow, the window resizing): follow when pinned.
  const reflow = useCallback(() => act((m) => stick.onContentChange(m, { newContent: false })), [act, stick]);

  // New entries, a turn starting or ending, a permission card, streaming text: follow before the next paint. Only more entries, more
  // permission cards or longer streaming text count as new content (the dot); the other triggers here do not.
  const seen = useRef({ threadId: p.threadId, entries: 0, permissions: 0, streaming: 0 });
  const streamingText = thread?.streaming;
  useLayoutEffect(() => {
    const prev = seen.current;
    const now = { threadId: p.threadId, entries: entries.length, permissions: permissions.length, streaming: streamingText?.length ?? 0 };
    seen.current = now;
    const newContent = prev.threadId === now.threadId && (now.entries > prev.entries || now.permissions > prev.permissions || now.streaming > prev.streaming);
    act((m) => stick.onContentChange(m, { newContent }));
  }, [act, stick, p.threadId, entries.length, streamingText, thread?.busy, permissions.length]);

  // Growth the list above does not see: inside the last message (a re-rendered Markdown block), the live line showing up after its
  // delay, folds opening, the window resizing. The content box and the scroll box both report their size.
  useEffect(() => {
    const body = bodyRef.current;
    const content = contentRef.current;
    if (!body || !content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(reflow);
    ro.observe(content);
    ro.observe(body);
    return () => ro.disconnect();
  }, [reflow]);

  // Another thread: start at its bottom.
  useLayoutEffect(() => {
    stick.reset();
    act((m) => stick.onSend(m));
  }, [p.threadId, stick, act]);

  useEffect(() => {
    if (p.focusNonce > 0) inputRef.current?.focus();
  }, [p.focusNonce, p.threadId]);

  // A clicked tip: the text is in the box already; focus it and select the "..." part (or put the cursor at the end).
  const insertNonce = p.insertRequest?.nonce;
  useEffect(() => {
    const req = nowInsert.current;
    if (!req) return;
    const id = requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(req.selStart, req.selEnd);
      }
      nowInsert.current?.done?.();
    });
    return () => cancelAnimationFrame(id);
  }, [insertNonce]);

  const onScroll = () => act((m) => { stick.onUserScroll(m); return null; });
  // The reader means to go up: unpin before the scroll event lands, so the next content change does not pull them back. If the thread has
  // not moved two frames later (a nested scroller took the wheel, a key went to something else), the intent is dropped. One check at a time.
  const settleFrames = useRef<number[]>([]);
  const cancelSettle = useCallback(() => {
    for (const id of settleFrames.current) cancelAnimationFrame(id);
    settleFrames.current = [];
  }, []);
  const intentUp = () => {
    const el = bodyRef.current;
    if (!el) return;
    act((m) => { stick.onUserIntentUp(m); return null; });
    if (settleFrames.current.length > 0) return;
    const startTop = el.scrollTop;
    const first = requestAnimationFrame(() => {
      const second = requestAnimationFrame(() => {
        settleFrames.current = [];
        act((m) => stick.onIntentSettled(m, startTop));
      });
      settleFrames.current = [second];
    });
    settleFrames.current = [first];
  };
  const intentDown = () => act((m) => { stick.onUserIntentDown(m); return null; });
  const intent = (i: Intent | null) => {
    if (i === 'up') intentUp();
    else if (i === 'down') intentDown();
  };
  useEffect(() => cancelSettle, [cancelSettle]);
  const touchY = useRef(0);

  const canWrite = !handingOver;
  const hasAttachments = imgs.length > 0 || fls.length > 0;
  // Screens the files (type, size, count), reads the accepted ones and adds them to the composer; the first problem shows as one line under the box.
  // PNG, JPEG, GIF and WebP go as images (thumbnails); every other file goes as a file (chip).
  const addFiles = (all: File[]) => {
    if (!canWrite || all.length === 0) return;
    const { images, others } = splitFiles(all);
    let firstProblem = '';
    if (images.length > 0) {
      const { accepted, problem } = screenCandidates(imgsRef.current.length, images);
      if (problem) firstProblem = imageProblemText(problem);
      void Promise.all(accepted.map((i) => readImageFile(images[i]))).then((results) => {
        const got: DraftImage[] = [];
        let bad: ImageProblem | null = null;
        for (const r of results) {
          if (typeof r === 'string') bad = bad ?? r;
          else got.push({ key: `img${++imgSeq.current}`, attachment: r });
        }
        if (bad && !problem) setImgError(imageProblemText(bad));
        if (got.length > 0) setImgs((cur) => [...cur, ...got].slice(0, MAX_IMAGES));
      });
    }
    if (others.length > 0) {
      const { accepted, problem } = screenFiles(flsRef.current.length, draftBytes(flsRef.current), others);
      if (problem && !firstProblem) firstProblem = fileProblemText(problem);
      void Promise.all(accepted.map((i) => readAttachment(others[i]))).then((results) => {
        const got: DraftFile[] = [];
        let unreadable = false;
        for (const r of results) {
          if (r) got.push({ key: `file${++imgSeq.current}`, attachment: r });
          else unreadable = true;
        }
        if (unreadable && !problem) setImgError(fileProblemText({ code: 'format', name: '' }));
        if (got.length > 0) setFls((cur) => [...cur, ...got].slice(0, MAX_FILES));
      });
    }
    setImgError(firstProblem);
  };
  const submit = () => {
    const typed = draftText.get(draftKey);
    const text = typed.trim();
    if ((!text && !hasAttachments) || !canWrite) return;
    // "!" runs a command as the user (the main process confirms first): images and the reply chip stay for the next message.
    const command = commandOf(text);
    if (command !== null) {
      const draft = typed;
      void api()
        .runCommand(p.orgId, p.threadId, command)
        .then((started) => {
          if (started && draftText.get(draftKey) === draft) draftText.set(draftKey, '');
          if (started) act((m) => stick.onSend(m));
        })
        .catch((e: unknown) => setImgError(ipcErrorText(e)));
      return;
    }
    const message = p.reply ? (text ? replyMessage(p.reply, text) : replyMessage(p.reply, '').trimEnd()) : text;
    const sending = imgs.map((i) => i.attachment);
    const sendingFiles = fls;
    // A refused send (the main process checks the images and files again) shows its reason and gives back the text, images, files and reply chip.
    void api()
      .send(p.orgId, p.threadId, message, sending.length > 0 ? sending : undefined, sendingFiles.length > 0 ? sendingFiles.map((f) => f.attachment) : undefined)
      .catch((e: unknown) => {
        if (sending.length === 0 && sendingFiles.length === 0) throw e;
        // Give back what was sent (text, images, reply chip), each part only if that part is empty now.
        const back = restoreAfterRejectedSend(
          { text: typed, images: imgs, reply: p.reply },
          { text: draftText.get(draftKey), images: imgsRef.current, reply: nowRef.current.reply },
        );
        setImgError(ipcErrorText(e));
        setImgs(back.images);
        if (flsRef.current.length === 0) setFls(sendingFiles);
        if (back.text !== draftText.get(draftKey)) draftText.set(draftKey, back.text);
        if (back.reply && back.reply !== nowRef.current.reply) p.onRestoreReply(back.reply);
      });
    setImgs([]);
    setFls([]);
    setImgError('');
    draftText.set(draftKey, '');
    if (p.reply) p.onClearReply();
    setSent(bumpSentCount(storage()));
    act((m) => stick.onSend(m));
  };

  const lastEntry = entries[entries.length - 1];
  const retryText = canWrite && !thread?.busy ? lastUserText(entries) : null;
  const retry = () => {
    if (retryText) {
      act((m) => stick.onSend(m));
      void api().send(p.orgId, p.threadId, retryText);
    }
  };
  // "Ask {persona} to write it" (under a hand-over that found no note): only in an open, idle chat that can be written to.
  const canAskNote = !p.isCos && p.tabStatus === 'open' && canWrite && !thread?.busy;
  const askNote = () => {
    if (!canAskNote) return;
    act((m) => stick.onSend(m));
    void api().send(p.orgId, p.threadId, t('dept.msg.askNote', { cosName: p.cosName }));
  };
  // The message list is memoized: it gets these callbacks as stable functions that call the latest closures.
  const latest = useRef({ retry, askNote });
  latest.current = { retry, askNote };
  const onRetry = useCallback(() => latest.current.retry(), []);
  const onAskNote = useCallback(() => latest.current.askNote(), []);
  const onStart = useCallback(() => inputRef.current?.focus(), []);
  const isFresh = useCallback((id: string) => baseline.current !== null && !baseline.current.has(id), []);
  const fillDraft = (text: string) => {
    draftText.set(draftKey, text);
    inputRef.current?.focus();
  };

  // The Draft form sends one message to this same chat; the agent that has the context writes the draft (nothing is sent outward).
  const sendDraft = (text: string) => {
    setDraftOpen(false);
    act((m) => stick.onSend(m));
    void api().send(p.orgId, p.threadId, text).catch((e: unknown) => setImgError(ipcErrorText(e)));
  };

  const showFootRun = thread?.runDefaults;
  const handoffs = p.isCos && thread ? thread.handoffsWaiting : 0;
  const empty = !!thread && entries.length === 0 && !thread.streaming && !thread.busy;
  const inbox = p.isCos ? thread?.inbox ?? [] : [];
  const askInbox = () => {
    act((m) => stick.onSend(m));
    return api().send(p.orgId, p.threadId, t('cos.msg.processInbox'));
  };
  const showHead = !p.isCos && (canWrite || handingOver);
  const placeholder = handingOver ? t('thread.handingOverPlaceholder') : t('thread.placeholder', { name: speaker || stripMarkdown(p.title) });

  return (
    <section
      className="thread"
      onDragEnter={(e) => {
        if (!dragHasFiles(e.dataTransfer.types)) return;
        e.preventDefault();
        setDragOver(canWrite);
      }}
      onDragOver={(e) => {
        if (!dragHasFiles(e.dataTransfer.types)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = canWrite ? 'copy' : 'none';
        if (canWrite && !dragOver) setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={(e) => {
        if (!dragHasFiles(e.dataTransfer.types)) return;
        e.preventDefault();
        setDragOver(false);
        addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {showHead && (
        <div className="thread-head">
          {handingOver ? (
            <span className="head-handing">
              <Spinner />
              {t('tab.handingOver', { cosName: p.cosName })}
            </span>
          ) : (
            <HandOverButton pendingWork={p.pendingWork} cosName={p.cosName} persona={p.persona} onClick={p.onHandOver} />
          )}
        </div>
      )}

      <div className="thread-scroll">
        <div
          className="thread-body"
          ref={setBody}
          onScroll={onScroll}
          onWheel={(e) => intent(wheelIntent(e.deltaX, e.deltaY, !!bodyRef.current && nestedScrollerConsumes(e.target, bodyRef.current, e.deltaY)))}
          onTouchStart={(e) => { touchY.current = e.touches[0]?.clientY ?? 0; }}
          onTouchMove={(e) => {
            const y = e.touches[0]?.clientY ?? 0;
            if (y > touchY.current) intentUp(); // the finger moves down: the content goes up
            else if (y < touchY.current) intentDown();
            touchY.current = y;
          }}
          onKeyDown={(e) => {
            if (!e.defaultPrevented) intent(scrollKeyIntent(e.key, e.shiftKey, keyTargetOf(e.target)));
          }}
        >
          <div className="thread-content" ref={contentRef}>
            {empty && (
              <div className="thread-empty">
                <LogoMark size={40} />
                <h3>{t('thread.empty', { name: speaker })}</h3>
                {p.isCos && canWrite && (
                  <div className="suggestions">
                    {[1, 2, 3].map((n) => (
                      <Button key={n} variant="quiet" onClick={() => fillDraft(t(`thread.suggest.${n}`))}>
                        {t(`thread.suggest.${n}`)}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <MessageList
              rows={rows}
              drafts={drafts}
              orgId={p.orgId}
              speaker={speaker}
              lastId={lastEntry?.id}
              retryOffered={retryText !== null}
              canAskNote={canAskNote}
              isFresh={isFresh}
              onRetry={onRetry}
              onStart={onStart}
              onAskNote={onAskNote}
              scrollEl={bodyEl}
            />
            {thread?.commands?.map((c) => (
              <div key={c.id} className="row-wrap new">
                <div className="msg user command">
                  <div className="plate-command">
                    <div className="command-by">{t('command.ranBy')}</div>
                    <pre className="command-line">! {c.command}</pre>
                    <div className="command-status running">
                      <Spinner delay={0} />
                      {t('command.running')}
                      <Button variant="quiet" onClick={() => void api().cancelCommand(p.orgId, p.threadId, c.id)}>
                        {t('command.stop')}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
            {(thread?.busy || thread?.streaming) && (
              <div className="row-wrap new live-row">
                <div className={`msg assistant${thread.streaming ? ' streaming' : ''}`}>
                  <NameLine name={speaker} time="" you={false} />
                  {thread.busy && <LiveLine
                      thread={thread}
                      permissionPending={permissions.some((x) => !x.leaving && !isQuestionRequest(x.item))}
                      questionPending={permissions.some((x) => !x.leaving && isQuestionRequest(x.item))}
                    />}
                  {thread.streaming && (
                    <div className="text md">
                      <Markdown text={thread.streaming} />
                    </div>
                  )}
                </div>
              </div>
            )}
            {permissions.map(({ item, leaving }) => (
              <div key={item.requestId} className="row-wrap new">
                <Fold open={!leaving} className="perm-fold">
                  {isQuestionRequest(item) ? <QuestionCard request={item} /> : <PermissionCard request={item} onOpenSettings={p.onOpenSettings} />}
                </Fold>
              </div>
            ))}
            {handingOver && <div className="line system">{t('thread.handingOver', { persona: stripMarkdown(p.persona) })}</div>}
          </div>
        </div>
        <Presence present={!view.pinned} exitMs={120}>
          {(state) => {
            const label = view.hasNew ? t('thread.jumpLatestNew') : t('thread.jumpLatest');
            return (
              <Tooltip label={label} placement="top">
                <button type="button" className="jump" data-state={state} aria-label={label} onClick={() => act((m) => stick.jump(m), true)}>
                  <ArrowDown />
                  {view.hasNew && <span className="jump-dot" aria-hidden="true" />}
                </button>
              </Tooltip>
            );
          }}
        </Presence>
      </div>

      <InboxBanner notes={inbox} cosName={p.cosName} disabled={!canWrite} busy={!!thread?.busy} onAsk={askInbox} />

      <div className="composer-wrap">
        <div
          className={`composer${canWrite ? '' : ' disabled'}${dragOver ? ' dragover' : ''}`}
          onPaste={(e) => {
            if (!canWrite) return;
            const files = imageFilesFromPaste(e.clipboardData.items);
            if (files.length === 0) return; // plain text (or nothing we take): the textarea pastes as usual
            e.preventDefault();
            addFiles(files);
          }}
        >
          {p.reply && (
            <div className="reply-chip">
              {p.reply.code && <span className="sr-only">{t('composer.replyingTo')}</span>}
              {p.reply.code ? <code className="reply-code">{p.reply.code}</code> : <span className="reply-label">{t('composer.replyingTo')}</span>}
              {p.reply.text && <span className="reply-text">{p.reply.text}</span>}
              <button type="button" className="reply-close" aria-label={t('composer.removeReply')} onClick={() => { p.onClearReply(); inputRef.current?.focus(); }}>
                <X size={16} />
              </button>
            </div>
          )}
          <ComposerThumbs
            images={imgs}
            onRemove={(key) => {
              setImgs((cur) => cur.filter((i) => i.key !== key));
              setImgError('');
              inputRef.current?.focus();
            }}
          />
          <ComposerFiles
            files={fls}
            onRemove={(key) => {
              setFls((cur) => cur.filter((f) => f.key !== key));
              setImgError('');
              inputRef.current?.focus();
            }}
          />
          <div className="composer-row">
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              tabIndex={-1}
              aria-label={t('composer.attachInput')}
              onChange={(e) => {
                addFiles(Array.from(e.target.files ?? []));
                e.target.value = '';
                inputRef.current?.focus();
              }}
            />
            <Tooltip label={t('composer.attach')} placement="top">
              <button type="button" className="attach" aria-label={t('composer.attach')} disabled={!canWrite} onClick={() => fileInput.current?.click()}>
                <Paperclip />
              </button>
            </Tooltip>
            <DraftBox
              draftKey={draftKey}
              inputRef={inputRef}
              reply={p.reply}
              disabled={!canWrite}
              placeholder={placeholder}
              onTyped={() => setImgError('')}
              onSubmit={submit}
              onEscape={p.onClearReply}
            />
            <SendButton draftKey={draftKey} hasAttachments={hasAttachments} canWrite={canWrite} onClick={submit} />
          </div>
        </div>
        {hasVideo(fls) && <p className="composer-note">{t('composer.videoHint')}</p>}
        {imgError && (
          <p className="composer-error" role="alert">
            {imgError}
          </p>
        )}
        <DraftForm open={draftOpen} name={speaker || stripMarkdown(p.title)} isCos={p.isCos} orgId={p.orgId} onSubmit={sendDraft} onCancel={() => setDraftOpen(false)} />
        {confirmAuto && (
          <AutoModeConfirm
            onConfirm={() => {
              setConfirmAuto(false);
              p.onSetSettings({ permissionMode: 'auto' });
            }}
            onCancel={() => setConfirmAuto(false)}
          />
        )}
        <div className="composer-foot">
          {/* The hint gives way first: it hides while a change waits for the next message, and shrinks before the pickers. */}
          <ComposerHint
            draftKey={draftKey}
            canWrite={canWrite}
            name={speaker || stripMarkdown(p.title)}
            otherHint={canWrite && showHint(sent) && !runPendingNote(thread) ? t('composer.hint') : ''}
          />
          <span className="foot-right">
            <Tooltip label={t('draft.tip')} placement="top">
              <Button small disabled={!canWrite} onClick={() => setDraftOpen(true)}>
                {t('draft.button')}
              </Button>
            </Tooltip>
            {handoffs > 0 && <span className="chip teal">{handoffs === 1 ? t('thread.handoffWaiting') : t('thread.handoffsWaiting', { count: handoffs })}</span>}
            {showFootRun && thread?.runDefaults ? (
              <>
                <QuietSelect
                  label={t('thread.model.label')}
                  shown={chatModelShown(thread.runChoice?.model, thread.runDefaults.model, thread.resolvedModel)}
                  tip={chatModelTip(thread.runChoice?.model, thread.runDefaults.model, thread.resolvedModel)}
                  disabled={handingOver}
                  value={thread.runChoice?.model ?? ''}
                  onChange={(v) => void api().setThreadRun(p.orgId, p.threadId, { model: v || null })}
                >
                  {chatModelOptions({ defaultModel: thread.runDefaults.model, defaultPinned: thread.runDefaults.pinned, tiers: thread.modelTiers, current: thread.runChoice?.model, seen: thread.seenModels, resolved: thread.resolvedModel }).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </QuietSelect>
                <QuietSelect
                  label={t('thread.effort.label')}
                  shown={chatEffortShown(thread.runChoice?.effort, thread.runDefaults.effort)}
                  disabled={handingOver}
                  value={thread.runChoice?.effort ?? ''}
                  onChange={(v) => void api().setThreadRun(p.orgId, p.threadId, { effort: (v || null) as EffortLevel | null })}
                >
                  {chatEffortOptions(thread.runDefaults.effort, thread.runDefaults.effortFromAgent).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </QuietSelect>
                <QuietSelect
                  label={t('thread.mode.label')}
                  shown={chatModeShown(thread.permissionMode)}
                  disabled={handingOver}
                  value={thread.permissionMode ?? 'default'}
                  onChange={(v) => {
                    const next = v as PermissionMode;
                    if (needsAutoConfirm(thread.permissionMode, next)) setConfirmAuto(true);
                    else p.onSetSettings({ permissionMode: next });
                  }}
                >
                  {PERMISSION_MODES.map((m) => (
                    <option key={m} value={m} title={t(`settings.mode.${m}.hint`)}>
                      {t(`settings.mode.${m}`)}
                    </option>
                  ))}
                </QuietSelect>
                {runPendingNote(thread) && <span className="muted small">{runPendingNote(thread)}</span>}
              </>
            ) : (
              runLabel(thread?.model, thread?.effort) && <span className="muted small">{runLabel(thread?.model, thread?.effort)}</span>
            )}
          </span>
        </div>
      </div>
    </section>
  );
}
