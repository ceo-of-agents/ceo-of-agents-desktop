import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from 'react';
import type { SetupData, SetupFolderPick, SetupState } from '../shared/setup';
import { setupThreadId } from '../shared/setup';
import { t } from '../shared/strings';
import type { OrgSummary } from '../shared/types';
import { api } from './api';
import { CreateOrgStep } from './create-org/CreateOrgStep';
import { FolderStep } from './create-org/FolderStep';
import { Notice, type Errors } from './create-org/fields';
import { DoneView, FailedView } from './create-org/ResultViews';
import { RunView } from './create-org/RunView';
import { StepList } from './create-org/StepList';
import { firstInvalid, hasAnswers, keepListed, nextLabelKey, nextStep, prevStep, stepLabelKey, stepNumber } from './create-org-flow';
import { changePurposeOrLevel, emptyDraft, stepsFor, todos, toAnswers, validateStep, type Draft, type PurposePatch, type StepId } from './create-org-logic';
import { folderUntouched, lastAssistantText, problemStep, runPhase, runSteps } from './create-org-run';
import { X } from './icons';
import { initialState, reducer, threadKey } from './logic';
import { Button } from './ui/Button';
import { useDismiss, useFocusTrap } from './ui/hooks';
import { Modal } from './ui/Modal';
import { Presence } from './ui/Presence';

interface Props {
  open: boolean;
  /** Leaves the view (nothing is kept: answers live in memory only). */
  onClose(): void;
  /** The new hq was added to the app's orgs (`openCos`: also select it and open its chief of staff chat). */
  onFinished(org: OrgSummary, openCos: boolean): void;
}

/**
 * "Create a new org": a full-window view like Settings with the wizard's questions, a summary, a folder, then the run.
 * Questions, order and rules come from the plugin (see create-org-logic.ts); this file is the frame and the flow between the screens.
 */
export function CreateOrgView({ open, ...rest }: Props) {
  return (
    <Presence present={open} exitMs={120}>
      {(state) => <CreateOrgBody state={state} {...rest} />}
    </Presence>
  );
}

interface Run {
  runId: string;
  startedAt: number;
}

/** Step changes: the old step fades out (120 ms, 80 ms under reduced motion), then the new one comes in. */
const fadeMs = (): number => (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 80 : 120);

function CreateOrgBody({ state, onClose, onFinished }: Omit<Props, 'open'> & { state: 'open' | 'closed' }) {
  const open = state === 'open';
  const ref = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  // ---- before the run
  const [data, setData] = useState<SetupData | null>(null);
  const [prereqError, setPrereqError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [current, setCurrent] = useState<StepId>('language-profile');
  const [done, setDone] = useState<StepId[]>([]);
  const [attention, setAttention] = useState<StepId[]>([]);
  const [visited, setVisited] = useState<StepId[]>(['language-profile']);
  const [notes, setNotes] = useState<Partial<Record<StepId, string>>>({});
  const [errors, setErrors] = useState<Errors>({});
  const [fromSummary, setFromSummary] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [announce, setAnnounce] = useState({ text: '', n: 0 });
  const [confirm, setConfirm] = useState<'discard' | 'stop' | null>(null);
  const [pick, setPick] = useState<SetupFolderPick | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // ---- the run
  const [run, setRun] = useState<Run | null>(null);
  const [setupState, setSetupState] = useState<SetupState | null>(null);
  const [view, dispatch] = useReducer(reducer, initialState);
  const [replying, setReplying] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const runId = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const steps = useMemo(() => stepsFor(draft), [draft]);

  // ---- prerequisites: before step 1 the app checks what the run needs, so no answer is wasted
  const checkPrereqs = useCallback(() => {
    setPrereqError(null);
    setData(null);
    api()
      .setupData()
      .then((r) => ('error' in r ? setPrereqError(r.error) : setData(r)))
      .catch((e: unknown) => setPrereqError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(checkPrereqs, [checkPrereqs]);

  // ---- events of the run: its thread, permission cards and the folder facts
  useEffect(
    () =>
      api().onEvent((e) => {
        if (e.type === 'setup-state') {
          if (runId.current === null || e.runId === runId.current) setSetupState(e);
        } else if (e.type === 'thread-entry' || e.type === 'thread-delta') {
          if (e.orgId === 'setup') dispatch(e);
        } else if (e.type === 'thread-state') {
          if (e.state.orgId === 'setup') dispatch(e);
        } else if (e.type === 'permission') {
          if (e.request.orgId === 'setup') dispatch(e);
        } else if (e.type === 'permission-resolved') dispatch(e);
      }),
    [],
  );
  useEffect(() => () => clearTimeout(timer.current), []);

  const thread = run ? view.threads[threadKey('setup', setupThreadId(run.runId))] : undefined;
  const permissions = view.permissions.filter((p) => p.orgId === 'setup');
  const last = lastAssistantText(thread);
  const facts = setupState?.facts;
  const phase = !run ? null : replying ? 'working' : runPhase(setupState, last);
  useEffect(() => {
    if (setupState?.busy || setupState?.error) setReplying(false);
  }, [setupState?.busy, setupState?.error]);

  // The step a reported problem belongs to (Failed screen): it gets the orange "!" in the list, and Back to summary leads there.
  const failedText = phase === 'failed' ? (setupState?.error ?? last ?? '') : '';
  const failedStep = phase === 'failed' ? problemStep(failedText, steps) : null;

  // ---- leaving
  const stopRun = useCallback(async () => {
    const id = runId.current;
    runId.current = null;
    setRun(null);
    setSetupState(null);
    setReplying(false);
    if (id) await api().stopSetup(id).catch(() => undefined);
  }, []);

  const backToSummary = async () => {
    setConfirm(null);
    if (failedStep) {
      setAttention((a) => (a.includes(failedStep) ? a : [...a, failedStep]));
      setNotes((n) => ({ ...n, [failedStep]: t('createOrg.problemStep') }));
    }
    await stopRun();
    setCurrent('summary');
    setFromSummary(false);
  };

  const requestClose = () => {
    if (confirm) return;
    if (run && (phase === 'working' || phase === 'asking')) setConfirm('stop');
    else if (!run && hasAnswers(draft)) setConfirm('discard');
    else void leave();
  };

  /** Leaves the view; a hq that exists is added to the org rail first, even when a later check failed. */
  const leave = async () => {
    const id = runId.current;
    if (id && setupState?.hqReady) {
      const org = await api().finishSetup(id).catch(() => null);
      if (org) onFinished(org, false);
    } else if (id) await api().stopSetup(id).catch(() => undefined);
    onClose();
  };
  useDismiss(open && !confirm, requestClose);
  useFocusTrap(ref, open);

  // ---- moving between steps
  const focusFirstInvalid = () =>
    requestAnimationFrame(() => {
      const field = mainRef.current?.querySelector<HTMLElement>('.co-field[data-invalid="true"]');
      field?.querySelector<HTMLElement>('input, textarea, select, button')?.focus();
    });

  const go = (step: StepId) => {
    setErrors({});
    setLeaving(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setCurrent(step);
      setVisited((v) => (v.includes(step) ? v : [...v, step]));
      setLeaving(false);
      mainRef.current?.scrollTo?.({ top: 0 });
    }, fadeMs());
  };
  // Focus goes to each step's title when it opens.
  useEffect(() => {
    if (open && data && !leaving) titleRef.current?.focus();
  }, [open, data, current, run === null, leaving]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (fn: (d: Draft) => void) => {
    setDraft((d) => {
      const next = structuredClone(d);
      fn(next);
      return next;
    });
    setErrors({});
  };

  const changePurpose = (patch: PurposePatch) => {
    const r = changePurposeOrLevel(draft, patch);
    const listed = stepsFor(r.draft);
    setDraft(r.draft);
    setErrors({});
    setDone((d) => keepListed(d, listed));
    setVisited((v) => keepListed(v, listed));
    setAttention((a) => keepListed(r.affected && !a.includes(r.affected) ? [...a, r.affected] : a, listed));
    if (r.affected) setNotes((n) => ({ ...n, [r.affected as StepId]: t('createOrg.purposeChanged') }));
    if (listed.length !== steps.length) setAnnounce((a) => ({ text: t('createOrg.stepsChanged', { total: listed.length }), n: a.n + 1 }));
  };

  const next = () => {
    if (!data || leaving) return;
    if (current === 'folder') return void create();
    const errs = validateStep(current, draft, data);
    const count = Object.keys(errs).length;
    if (count > 0) {
      setErrors(errs);
      setAnnounce((a) => ({ text: t('createOrg.attention', { count }), n: a.n + 1 }));
      focusFirstInvalid();
      return;
    }
    setDone((d) => (d.includes(current) ? d : [...d, current]));
    setAttention((a) => a.filter((s) => s !== current));
    setNotes((n) => ({ ...n, [current]: undefined }));
    if (fromSummary && current !== 'summary') {
      setFromSummary(false);
      return go('summary');
    }
    if (current === 'summary') {
      const bad = firstInvalid(draft, data);
      if (bad) {
        setAttention((a) => (a.includes(bad.step) ? a : [...a, bad.step]));
        setFromSummary(true);
        go(bad.step);
        window.setTimeout(() => setErrors(bad.errors), fadeMs() + 20);
        return;
      }
    }
    const to = nextStep(steps, current);
    if (to) go(to);
  };

  const back = () => {
    const to = fromSummary ? 'summary' : prevStep(steps, current);
    setFromSummary(false);
    if (to) go(to);
  };

  const chooseFolder = async () => {
    const r = await api().pickSetupFolder();
    if (!r) return;
    setPick(r);
    setStartError(null);
    requestAnimationFrame(() => document.getElementById('co-folder-change')?.focus());
  };

  // ---- the run
  const begin = async () => {
    if (!data) return;
    if (!pick) {
      setStartError(t('createOrg.folderNeeded'));
      return;
    }
    if (!pick.ok) {
      focusFirstInvalid();
      return;
    }
    const bad = firstInvalid(draft, data);
    if (bad) {
      setAttention((a) => (a.includes(bad.step) ? a : [...a, bad.step]));
      go(bad.step);
      window.setTimeout(() => setErrors(bad.errors), fadeMs() + 20);
      return;
    }
    setStarting(true);
    setStartError(null);
    const r = await api()
      .startSetup(toAnswers(draft), pick.path)
      .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    setStarting(false);
    if ('error' in r) {
      setStartError(/not writable|EACCES|EPERM|permission/i.test(r.error) ? t('createOrg.notWritable') : r.error);
      return;
    }
    runId.current = r.runId;
    setRun({ runId: r.runId, startedAt: Date.now() });
    setReplying(false);
    api().getSetupThread(r.runId).then((info) => info && dispatch({ type: 'thread-loaded', info })).catch(() => undefined);
    api().getSetupState(r.runId).then((s) => s && setSetupState(s)).catch(() => undefined);
  };
  const create = () => void begin();

  const retry = async () => {
    await stopRun();
    await begin();
  };

  const send = (text: string) => {
    if (!run) return;
    setReplying(true);
    api().sendSetup(run.runId, text).catch(() => setReplying(false));
  };

  const open_ = async () => {
    if (!run) return;
    setOpening(true);
    setOpenError(null);
    const org = await api().finishSetup(run.runId).catch(() => null);
    setOpening(false);
    if (!org) {
      setOpenError(t('createOrg.openFailed', { folder: pick?.path ?? '' }));
      return;
    }
    runId.current = null;
    onFinished(org, true);
    onClose();
  };

  // ---- keys: Enter in a one-line field and Cmd+Enter anywhere mean Next
  const onKey = (e: KeyboardEvent) => {
    if (run || prereqError || e.nativeEvent.isComposing) return;
    const el = e.target as HTMLElement;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      next();
    } else if (e.key === 'Enter' && el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'text') {
      e.preventDefault();
      next();
    }
  };

  const total = steps.length;
  const name = facts?.orgName ?? draft.name.trim() ?? '';
  const stepFolder = pick?.path ?? '';
  const todoCount = todos(draft).length;
  const showSteps = data !== null && !prereqError;

  let main;
  if (prereqError) {
    main = (
      <div className="prereqs">
        <h1>{t('createOrg.prereqTitle')}</h1>
        <p className="muted">{t('createOrg.prereqText')}</p>
        <ul className="checklist">
          <li>
            <span className="mark20 failed" role="img" aria-label={t('prereq.status.failed')}>
              <X size={12} strokeWidth={3} />
            </span>
            <div className="check-body">
              <div className="error-text">{prereqError}</div>
            </div>
          </li>
        </ul>
        <div className="prereqs-foot">
          <Button onClick={checkPrereqs}>{t('prereq.checkAgain')}</Button>
        </div>
      </div>
    );
  } else if (!data) {
    main = (
      <p className="muted" role="status">
        {t('createOrg.loading')}
      </p>
    );
  } else if (run && phase && facts) {
    if (phase === 'done') {
      main = <DoneView name={name} cosName={facts.cosName ?? t('cos.role')} folder={stepFolder} facts={facts} todoCount={todoCount} message={last} error={openError} opening={opening} onOpen={() => void open_()} onSend={send} />;
    } else if (phase === 'failed') {
      main = <FailedView created={facts.orgYaml} text={failedText} answersFile={setupState?.answersFile ?? ''} folder={stepFolder} steps={runSteps(thread)} canRetry={folderUntouched(facts)} onRetry={() => void retry()} onBack={() => void backToSummary()} />;
    } else {
      main = <RunView name={name} phase={phase} startedAt={run.startedAt} facts={facts} thread={thread} message={last} permissions={permissions} onSend={send} onStop={() => setConfirm('stop')} />;
    }
  } else if (run) {
    main = (
      <RunView name={name} phase="working" startedAt={run.startedAt} facts={facts ?? { orgYaml: false, decisionRecord: false, state: false, settings: false, pluginEnabled: false, commit: null, orgName: null, cosName: null }} thread={thread} message={null} permissions={permissions} onSend={send} onStop={() => setConfirm('stop')} />
    );
  } else {
    const title = current === 'summary' ? t('createOrg.summaryTitle') : current === 'folder' ? t('createOrg.folderTitle') : t(stepLabelKey(current));
    main = (
      <div className={`co-step${leaving ? ' leaving' : ''}`} key={current}>
        <p className="co-stepcount" aria-live="polite">
          {t('createOrg.step', { n: stepNumber(steps, current), total })}
        </p>
        <h2 className="co-title" tabIndex={-1} ref={titleRef}>
          {title}
        </h2>
        {current === 'folder' && <p className="co-intro">{t('createOrg.folderText')}</p>}
        {notes[current] && <Notice>{notes[current]}</Notice>}
        {current === 'folder' ? (
          <FolderStep pick={pick} error={startError} reposGiven={draft.repos.mode === 'list' && draft.repos.items.length > 0} onChoose={() => void chooseFolder()} />
        ) : (
          <CreateOrgStep step={current} draft={draft} data={data} errors={errors} update={update} changePurpose={changePurpose} onEdit={(s) => {
            setFromSummary(true);
            go(s);
          }} />
        )}
      </div>
    );
  }

  const atStart = current === steps[0];
  return (
    <>
    <div ref={ref} className="co-view" data-state={state} role="dialog" aria-modal="true" aria-label={t('createOrg.title')} tabIndex={-1}>
      <header className="co-strip">
        <h2>{t('createOrg.title')}</h2>
        <button className="icon-btn" aria-label={t('createOrg.close')} onClick={requestClose}>
          <X />
        </button>
      </header>
      <div className="co-body">
        {showSteps && <StepList steps={steps} current={current} done={done} attention={failedStep && !attention.includes(failedStep) ? [...attention, failedStep] : attention} visited={visited} frozen={run !== null} onGo={(s) => { setFromSummary(false); go(s); }} />}
        <div className="co-main" ref={mainRef} onKeyDown={onKey}>
          <div className={`co-col${showSteps ? '' : ' alone'}`}>{main}</div>
        </div>
      </div>
      <span className="sr-only" aria-live="polite" key={announce.n}>
        {announce.text}
      </span>
      {showSteps && !run && (
        <footer className="co-foot">
          <div className="co-foot-inner">
            {!atStart || fromSummary ? <Button onClick={back}>{t('createOrg.back')}</Button> : <span />}
            <Button variant="primary" loading={starting} loadingLabel={t('createOrg.starting')} onClick={next}>
              {t(nextLabelKey(current, fromSummary))}
            </Button>
          </div>
        </footer>
      )}
    </div>
      <Modal open={confirm === 'discard'} onClose={() => setConfirm(null)} label={t('createOrg.discardTitle')} role="alertdialog">
        <h2>{t('createOrg.discardTitle')}</h2>
        <p>{t('createOrg.discardText')}</p>
        <div className="row end">
          <Button variant="primary" onClick={() => setConfirm(null)}>
            {t('createOrg.keepEditing')}
          </Button>
          <Button
            onClick={() => {
              setConfirm(null);
              onClose();
            }}
          >
            {t('createOrg.discard')}
          </Button>
        </div>
      </Modal>
      <Modal open={confirm === 'stop'} onClose={() => setConfirm(null)} label={t('createOrg.stopTitle')} role="alertdialog">
        <h2>{t('createOrg.stopTitle')}</h2>
        <p>{t('createOrg.stopText', { folder: stepFolder })}</p>
        <div className="row end">
          <Button variant="primary" onClick={() => setConfirm(null)}>
            {t('createOrg.keepGoing')}
          </Button>
          <Button onClick={() => void backToSummary()}>{t('createOrg.stop')}</Button>
        </div>
      </Modal>
    </>
  );
}
