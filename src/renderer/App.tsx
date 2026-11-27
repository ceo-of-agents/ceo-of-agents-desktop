import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { OrgId, OrgSummary, SettingsPatch, TabInfo, ThreadId } from '../shared/types';
import { t } from '../shared/strings';
import { byId } from '../shared/own';
import { countAsks } from '../shared/waiting';
import { api } from './api';
import { affectsSessions, ASK_FIX_GRACE_MS, askFixNext, ipcReason, settingsTarget, closeDecision, closeTargetFor, runCloseChoice, type CloseChoice, claimAskFix, fixHqMessage, initialState, isBlocking, isWaitingItem, nextTabId, permissionsFor, reducer, tabActivity, threadKey, visibleTabsOf, type AskFixPending, type Notice } from './logic';
import { NO_DISPATCHES, tabHasRunningDispatches } from './dispatch-logic';
import { draftFiles } from './composer-files';
import { draftImages } from './composer-images';
import { draftText } from './draft-text';
import { CreateOrgView } from './CreateOrgView';
import { Loading } from './Loading';
import { OrgChartView } from './OrgChartView';
import { cosClick, departmentClick, type ChartAction } from './org-chart-logic';
import { buildOrgChartLive } from '../shared/org-chart-live';
import { stripMarkdown } from './markdown-safety';
import { isPanelShortcut, loadPanelHidden, savePanelHidden } from './panel-logic';
import { Prereqs } from './Prereqs';
import { ABOUT_SECTION, SettingsView } from './SettingsView';
import { SidePanel } from './SidePanel';
import { TabItem } from './TabItem';
import { useTip } from './TipCard';
import { phraseInsertion } from './tip-logic';
import { Sidebar, Welcome } from './Sidebar';
import { railNoticeText, removeOrgIconNotice, setOrgIcon } from './org-icon-actions';
import type { OrgIconNotice } from './settings-logic';
import { WaitingFocus } from './WaitingFocus';
import { ThreadView } from './ThreadView';
import { Toasts } from './Toasts';
import { TopBar } from './TopBar';
import { closeChart, currentChat, isChartOpen, openChart, tabOrder, toggleChart, type ChartOpen } from './view-logic';
import { useDispatchAck } from './useDispatchAck';
import { useFocusOrg } from './useFocusOrg';
import { Button } from './ui/Button';
import { CloseChatDialog } from './CloseChatDialog';
import type { ReplyTarget } from './thread-logic';

const tabThread = (tabId: string): ThreadId => `tab:${tabId}`;
/** An ISO time as ms, null when missing or unreadable. */
const timeOf = (iso: string | undefined): number | null => {
  const n = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(n) ? n : null;
};

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  // The last chat shown, per org (the tab strip holds chats only). The Org chart is a view over it: chartOpen, per org.
  const [selected, setSelected] = useState<Record<OrgId, string>>({});
  const [chartOpen, setChartOpen] = useState<ChartOpen>({});
  const [focusNonce, setFocusNonce] = useState(0);
  // A clicked tip: the selection to apply in the chief of staff's box once it is shown (ThreadView focuses it and clears the request).
  const [insertRequest, setInsertRequest] = useState<{ nonce: number; selStart: number; selEnd: number } | null>(null);
  // The waiting item the user is replying to, per org: shown as a chip in the chief of staff composer.
  const [replyTargets, setReplyTargets] = useState<Record<OrgId, ReplyTarget | null>>({});
  // "Ask the chief of staff to fix it" sent and not handled yet, per org: the button stays disabled meanwhile.
  const [askFix, setAskFix] = useState<Record<OrgId, AskFixPending | null>>({});
  const [askFixTick, setAskFixTick] = useState(0);
  // Set at once on a click, before the state above has updated: two fast clicks cannot both send.
  const askFixClaimed = useRef(new Set<OrgId>());
  // The Settings view shows one org's settings (its own org switcher; the main window's org stays). settingsFor stays set while
  // the view animates out; settingsOpen is what the user sees.
  const [settingsFor, setSettingsFor] = useState<OrgId | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The "Create a new org" view.
  const [createOpen, setCreateOpen] = useState(false);
  // The section the view opens on (the identity corner of the rail opens About); a new opening sets it again.
  const [settingsSection, setSettingsSection] = useState<string | undefined>(undefined);
  const stripRef = useRef<HTMLDivElement>(null);
  const [applying, setApplying] = useState(false);
  const requested = useRef(new Set<string>());
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  // The department chat the user is closing without a handover yet: the dialog (hand over, close, cancel) is open for it.
  const [closeAsk, setCloseAsk] = useState<{ orgId: OrgId; tabId: string } | null>(null);
  // Orgs whose view could not be loaded: they show the normal layout instead of the loading placeholders.
  const [viewFailed, setViewFailed] = useState<Record<OrgId, boolean>>({});
  // The CEO node asks the side panel to open "Waiting on you" and scroll to it.
  const [revealWaiting, setRevealWaiting] = useState(0);
  const [panelHiddenState, setPanelHiddenState] = useState<Record<OrgId, boolean>>({});

  const loadThread = useCallback((orgId: OrgId, threadId: ThreadId) => {
    api().getThread(orgId, threadId).then((info) => info && dispatch({ type: 'thread-loaded', info })).catch(() => undefined);
  }, []);

  const refreshPrereqs = useCallback((orgId: OrgId | null) => {
    api().checkPrereqs(orgId).then((status) => dispatch({ type: 'prereq', orgId, status })).catch(() => undefined);
  }, []);

  const loadOrg = useCallback(
    async (orgId: OrgId) => {
      const c = api();
      dispatch({ type: 'set-active', orgId });
      const view = await c.activateOrg(orgId).catch(() => null);
      if (view) dispatch({ type: 'org-view', orgId, view });
      else setViewFailed((f) => ({ ...f, [orgId]: true }));
      requested.current.add(threadKey(orgId, 'cos'));
      loadThread(orgId, 'cos');
      c.getOrgChart(orgId).then(({ chart }) => dispatch({ type: 'org-chart', orgId, chart })).catch(() => undefined);
      c.listTabs(orgId).then((tabs) => dispatch({ type: 'tabs', orgId, tabs })).catch(() => undefined);
      c.getDispatches(orgId).then((dispatches) => dispatch({ type: 'dispatches', orgId, dispatches })).catch(() => undefined);
      refreshPrereqs(orgId);
      c.getHealth(orgId).then((status) => dispatch({ type: 'health', orgId, status })).catch(() => undefined);
    },
    [loadThread, refreshPrereqs],
  );

  useEffect(() => {
    const off = api().onEvent((e) => dispatch(e));
    void (async () => {
      void api()
        .getUsage()
        .then((usage) => usage && dispatch({ type: 'usage', usage }))
        .catch(() => undefined);
      void api()
        .getAppUpdate()
        .then((status) => dispatch({ type: 'app-update', status }))
        .catch(() => undefined);
      const { orgs, activeOrgId } = await api().listOrgs();
      dispatch({ type: 'orgs', orgs, activeOrgId });
      if (activeOrgId) await loadOrg(activeOrgId);
    })();
    return off;
  }, [loadOrg]);

  // Loads one org's settings by its registry path: the org need not be active.
  const loadSettings = useCallback((id: OrgId) => {
    api().getSettings(id).then((settings) => dispatch({ type: 'settings', orgId: id, settings })).catch(() => undefined);
  }, []);

  // Opens on the org given (the main window's org); switching in the view only changes settingsFor.
  const openSettings = useCallback((id: OrgId, section?: string) => {
    setSettingsSection(section);
    setSettingsFor(id);
    setSettingsOpen(true);
    loadSettings(id);
  }, [loadSettings]);

  // One path for every settings write (Settings modal and the composer footer): a failure, for example an hq
  // settings.local.json that is not valid JSON, shows a toast naming the file and the reason; nothing else changes.
  const changeSettings = (id: OrgId, patch: SettingsPatch) => {
    api()
      .setSettings(id, patch)
      .then((settings) => {
        dispatch({ type: 'settings', orgId: id, settings });
        if (affectsSessions(patch)) dispatch({ type: 'settings-pending', orgId: id, pending: true });
      })
      .catch((e: unknown) => {
        const org = state.orgs.find((o) => o.id === id)?.name ?? id;
        dispatch({ type: 'notice', orgId: id, text: t('notice.settingsFailed', { org, file: settingsTarget(patch), reason: ipcReason(e) }) });
      });
  };

  const applySettings = (id: OrgId) => {
    setApplying(true);
    api()
      .applySettings(id)
      .then(() => {
        dispatch({ type: 'settings-pending', orgId: id, pending: false });
        // The header shows the model and effort the chats now run on.
        for (const key of Object.keys(state.threads)) {
          const th = state.threads[key];
          if (th.orgId === id) loadThread(id, th.threadId);
        }
      })
      .catch(() => undefined)
      .finally(() => setApplying(false));
  };

  const orgId = state.activeOrgId;
  // The focus view of "Waiting on you": the org it is open for, null when closed; closed on any org change.
  const [focusOrg, setFocusOrg] = useFocusOrg(orgId);
  const data = orgId ? state.orgData[orgId] : undefined;
  // Clears a pending "Ask to fix" when the chief of staff turn that handles it ends (or it never starts: grace time).
  useEffect(() => {
    let changed = false;
    const next: Record<OrgId, AskFixPending | null> = {};
    for (const [id, p] of Object.entries(askFix)) {
      const cos = state.threads[threadKey(id, 'cos')];
      const n = askFixNext(p, !!cos?.busy, timeOf(cos?.activity?.startedAt), Date.now());
      if (n !== p) changed = true;
      if (!n) askFixClaimed.current.delete(id);
      next[id] = n;
    }
    if (changed) setAskFix(next);
    if (!Object.values(next).some((p) => p && !p.sawTurn)) return;
    const id = setTimeout(() => setAskFixTick((n) => n + 1), ASK_FIX_GRACE_MS);
    return () => clearTimeout(id);
  }, [askFix, state.threads, askFixTick]);

  const orgSummary = state.orgs.find((o) => o.id === orgId);
  const cosName = data?.view?.org.cosName ?? orgSummary?.cosName ?? t('cos.role');
  const tabs = useMemo(() => data?.tabs ?? [], [data?.tabs]);
  // The org's parsed waiting items: the focus view's deck, and what enables its button and menu item.
  const waitingItems = useMemo(() => (data?.view?.waiting ?? []).filter(isWaitingItem), [data?.view?.waiting]);
  const askCount = useMemo(() => countAsks(data?.view?.waiting ?? []), [data?.view?.waiting]);
  const focusAvailable = !!orgId && askCount > 0;
  useEffect(() => {
    void api().setWaitingFocusAvailable(focusAvailable).catch(() => undefined);
  }, [focusAvailable]);
  const panelHidden = orgId ? panelHiddenState[orgId] ?? loadPanelHidden(localStorage, orgId) : false;

  // Visible tabs: the open chats and the ones handing over.
  const visibleTabs: TabInfo[] = useMemo(() => visibleTabsOf(tabs), [tabs]);

  const current = currentChat(orgId ? selected[orgId] : undefined, visibleTabs);
  const showChart = !!orgId && isChartOpen(chartOpen, orgId);
  const [tip, dismissTip, nextTip, tipCount] = useTip(orgId ?? '', !!orgId);

  // Load the thread of any visible tab we have not asked for yet.
  useEffect(() => {
    if (!orgId) return;
    for (const tab of visibleTabs) {
      const key = threadKey(orgId, tabThread(tab.tabId));
      if (!requested.current.has(key)) {
        requested.current.add(key);
        loadThread(orgId, tabThread(tab.tabId));
      }
    }
  }, [visibleTabs, orgId, loadThread]);

  // The images kept in a composer are freed when its chat ends (closed or handed over) or its org leaves the list.
  const knownOrgs = useRef(new Set<OrgId>());
  useEffect(() => {
    const ids = new Set(state.orgs.map((o) => o.id));
    for (const id of knownOrgs.current) if (!ids.has(id)) {
        draftImages.deleteOrg(id);
        draftFiles.deleteOrg(id);
        draftText.deleteOrg(id);
      }
    knownOrgs.current = ids;
  }, [state.orgs]);
  useEffect(() => {
    for (const [id, data] of Object.entries(state.orgData)) {
      for (const tab of data?.tabs ?? []) if (tab.status === 'closed') {
          draftImages.delete(threadKey(id, tabThread(tab.tabId)));
          draftFiles.delete(threadKey(id, tabThread(tab.tabId)));
          draftText.delete(threadKey(id, tabThread(tab.tabId)));
        }
    }
  }, [state.orgData]);

  const select = (id: OrgId, threadId: string) => {
    setSelected((s) => ({ ...s, [id]: threadId }));
    setChartOpen((c) => closeChart(c, id));
  };

  // Ended dispatches leave the list once the user has seen the chief of staff's report (see dispatch-logic.ts).
  const dispatches = data?.dispatches ?? NO_DISPATCHES;
  const mainShowsThread = !!data && !(data.prereq && isBlocking(data.prereq)) && (!!data.view || !!(orgId && viewFailed[orgId]));
  // A finished dispatch waits for the report on it too (a turn Claude Code starts by itself, shown as an aside), at most
  // REPORT_WAIT_MS: a report that never comes does not block the ack. It counts as seen in the thread that made it, when that thread is shown (the org chart view shows none).
  const shownThread = orgId && !showChart && mainShowsThread ? state.threads[threadKey(orgId, current)] : undefined;
  useDispatchAck(orgId, dispatches, !showChart && mainShowsThread ? current : null, !!shownThread?.busy, !!shownThread?.reportPending);

  // Live status of the chart's nodes comes from the thread states and tabs the renderer already holds.
  const chart = data?.chart ?? null;
  const chartLive = useMemo(
    () => (orgId && chart ? buildOrgChartLive(chart.departments, tabs, (id) => state.threads[threadKey(orgId, id)]) : null),
    [orgId, chart, tabs, state.threads],
  );

  // Arrow keys, Home and End move between tabs (the selected tab is the one in the tab order).
  const onTabKey = (e: React.KeyboardEvent) => {
    if (!orgId) return;
    const next = nextTabId(tabOrder(visibleTabs), current, e.key);
    if (!next || next === current) return;
    e.preventDefault();
    select(orgId, next);
    requestAnimationFrame(() => stripRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus());
  };

  const focusStrip = () => requestAnimationFrame(() => stripRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus());

  // Closing asks first when the chat has not handed over (closeDecision). `force` is the user's choice in a dialog: close now.
  const closeTab = (tabId: string, force = false) => {
    if (!orgId) return;
    const threadId = tabThread(tabId);
    const tab = visibleTabs.find((x) => x.tabId === tabId);
    if (!tab || tab.status !== 'open') return;
    const decision = force ? 'close' : closeDecision(tab, !!state.threads[threadKey(orgId, threadId)]?.busy || tabHasRunningDispatches(dispatches, tabId));
    setConfirmClose(null);
    if (decision === 'ask-handover') {
      setCloseAsk({ orgId, tabId });
      return;
    }
    if (decision === 'confirm-busy') {
      setConfirmClose(tabId);
      return;
    }
    // Gone at once; the main process kills the chat's process and confirms with a tabs event.
    dispatch({ type: 'tab-upsert', tab: { ...tab, status: 'closed' } });
    if (current === threadId) select(orgId, 'cos');
    // If the close is refused, ask the main process what the tabs really are (the chat may have ended meanwhile).
    api()
      .closeTab(orgId, tabId)
      .catch(() => api().listTabs(orgId).then((list) => dispatch({ type: 'tabs', orgId, tabs: list })).catch(() => undefined));
  };

  const chooseClose = (choice: CloseChoice) => {
    const ask = closeAsk;
    setCloseAsk(null);
    focusStrip();
    if (!ask) return;
    // A hand-over shows in the tab (spinner) and the tab goes when it is done; the selection then goes back to the chief of staff.
    if (choice === 'close') closeTab(ask.tabId, true);
    else runCloseChoice(choice, api(), ask.orgId, ask.tabId)?.catch(() => undefined);
  };

  // Hide or show the whole side panel (top bar button and Cmd+Option+S); the choice is remembered per org.
  const togglePanel = useCallback(() => {
    if (!orgId) return;
    const next = !(panelHiddenState[orgId] ?? loadPanelHidden(localStorage, orgId));
    savePanelHidden(localStorage, orgId, next);
    setPanelHiddenState((h) => ({ ...h, [orgId]: next }));
  }, [orgId, panelHiddenState]);
  const panelShortcut = useRef(togglePanel);
  panelShortcut.current = togglePanel;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPanelShortcut(e)) return;
      e.preventDefault();
      panelShortcut.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Cmd+W comes from the application menu; the handler always sees the latest state.
  const menuClose = useRef<() => void>(() => undefined);
  menuClose.current = () => {
    // With Settings open, Cmd+W closes it (like a preferences window) and leaves the tabs alone.
    if (settingsOpen) {
      setSettingsOpen(false);
      return;
    }
    if (createOpen) return;
    // With the Org chart open, Cmd+W closes it and shows the last chat again.
    if (showChart && orgId) {
      setChartOpen((c) => closeChart(c, orgId));
      return;
    }
    const tabId = closeTargetFor(current, visibleTabs);
    if (tabId) closeTab(tabId);
  };
  const menuChart = useRef<() => void>(() => undefined);
  menuChart.current = () => {
    // From Settings it opens the chart (it does not close it); otherwise it toggles.
    if (orgId) setChartOpen((c) => (settingsOpen ? openChart(c, orgId) : toggleChart(c, orgId)));
    setSettingsOpen(false);
  };
  // Escape closes the Org chart. A menu or dialog that handles Escape stops it at the document, so it never reaches this
  // window listener; Settings has its own Escape.
  const escapeChart = useRef<(e: KeyboardEvent) => void>(() => undefined);
  escapeChart.current = (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || settingsOpen || !showChart || !orgId) return;
    setChartOpen((c) => closeChart(c, orgId));
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => escapeChart.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const menuSettings = useRef<() => void>(() => undefined);
  menuSettings.current = () => {
    if (orgId && !settingsOpen) openSettings(orgId);
  };
  const menuFocusWaiting = useRef<() => void>(() => undefined);
  menuFocusWaiting.current = () => {
    if (orgId && askCount > 0 && !settingsOpen) setFocusOrg(orgId);
  };
  const menuNewSession = useRef<() => void>(() => undefined);
  menuNewSession.current = () => {
    if (orgId) void api().newSession(orgId);
  };
  useEffect(
    () =>
      api().onEvent((e) => {
        if (e.type !== 'menu') return;
        if (e.command === 'close-tab') menuClose.current();
        else if (e.command === 'org-chart') menuChart.current();
        else if (e.command === 'settings') menuSettings.current();
        else if (e.command === 'new-session') menuNewSession.current();
        else if (e.command === 'focus-waiting') menuFocusWaiting.current();
      }),
    [],
  );

  const chat = async (agent: string) => {
    if (!orgId) return;
    const tab = await api().startTab(orgId, agent);
    dispatch({ type: 'tab-upsert', tab });
    select(orgId, tabThread(tab.tabId));
  };

  const runChartAction = (a: ChartAction, name: string) => {
    if (!orgId) return;
    if (a.kind === 'cos') {
      // The chief of staff node: the chat, with the cursor in the composer.
      select(orgId, 'cos');
      setFocusNonce((n) => n + 1);
    } else if (a.kind === 'focus') select(orgId, tabThread(a.tabId));
    else {
      chat(a.agent).catch((e: unknown) => {
        dispatch({ type: 'notice', orgId, text: t('orgChart.chatFailed', { name, reason: ipcReason(e) }) });
      });
    }
  };

  // "Ask {cosName} to fix it": one request at a time per org, sent to the chief of staff tab (the health popover and the org chart share it).
  const sendAskFix = (message: string) => {
    if (!orgId || !orgSummary || !claimAskFix(askFixClaimed.current, orgId, !!askFix[orgId])) return;
    select(orgId, 'cos');
    setAskFix((a) => ({ ...a, [orgId]: { sentAt: Date.now(), sawTurn: false } }));
    api()
      .send(orgId, 'cos', message)
      .catch((e: unknown) => {
        askFixClaimed.current.delete(orgId);
        setAskFix((a) => ({ ...a, [orgId]: null }));
        dispatch({ type: 'notice', orgId, text: t('notice.askFixFailed', { org: orgSummary.name, cosName, reason: e instanceof Error ? e.message : String(e) }) });
      });
  };

  // The CEO node: open the side panel if it is hidden, then "Waiting on you" is expanded and scrolled to.
  const showWaiting = () => {
    // With something waiting, the CEO node opens the focus view; with nothing, it reveals the panel section.
    if (orgId && askCount > 0) {
      setFocusOrg(orgId);
      return;
    }
    if (panelHidden) togglePanel();
    setRevealWaiting((n) => n + 1);
  };

  // Reply and Answer open the chief of staff tab with the item as a chip in the composer; the draft is kept.
  const answerFromFocus = (code: string | null, text?: string) => {
    // The focus view closes first; the composer takes focus once its own focus return is done.
    setFocusOrg(null);
    setTimeout(() => answer(code, text), 0);
  };
  const answer = (code: string | null, text?: string) => {
    if (!orgId) return;
    select(orgId, 'cos');
    setReplyTargets((r) => ({ ...r, [orgId]: { code, text: text ?? '' } }));
    setFocusNonce((n) => n + 1);
  };

  // A tip's phrase is addressed to the chief of staff: switch to that chat (this closes the chart), put the phrase in its box
  // (after any text already there; never sent) and ask ThreadView to focus and select.
  const insertTipPhrase = (phrase: string) => {
    if (!orgId) return;
    select(orgId, 'cos');
    const ins = phraseInsertion(phrase, draftText.get(threadKey(orgId, 'cos')));
    draftText.set(threadKey(orgId, 'cos'), ins.text);
    setInsertRequest((r) => ({ nonce: (r?.nonce ?? 0) + 1, selStart: ins.selStart, selEnd: ins.selEnd }));
  };

  const addOrg = async () => {
    const org = await api().openOrgDialog();
    if (org) {
      const { orgs } = await api().listOrgs();
      dispatch({ type: 'orgs', orgs, activeOrgId: org.id });
      await loadOrg(org.id);
    }
  };

  // The new hq is in the app's orgs: refresh the rail and, for "Open {cosName}", select it and open its chief of staff chat.
  const orgCreated = async (org: OrgSummary, openCos: boolean) => {
    const { orgs } = await api().listOrgs();
    dispatch({ type: 'orgs', orgs, activeOrgId: openCos ? org.id : orgId });
    if (openCos) {
      select(org.id, 'cos');
      await loadOrg(org.id);
    }
  };

  const askTab = closeAsk ? visibleTabs.find((x) => x.tabId === closeAsk.tabId) : undefined;

  // The rail's icon menu: the same actions as Settings, the outcome as one toast.
  const iconAction = async (id: OrgId, run: () => Promise<OrgIconNotice | null>) => {
    const n = await run();
    if (!n) return;
    const name = stripMarkdown(state.orgs.find((o) => o.id === id)?.name ?? '');
    dispatch({ type: 'notice', orgId: id, text: railNoticeText(n, name) });
  };
  const onDone = useCallback((id: number) => dispatch({ type: 'notice-dismiss', id }), []);
  // A toast's button: the org's chief of staff thread (switching org first when the toast is about another one).
  const onToastAction = (n: Notice) => {
    dispatch({ type: 'notice-dismiss', id: n.id });
    if (!n.orgId || n.action?.kind !== 'focus-cos') return;
    select(n.orgId, 'cos');
    if (n.orgId !== orgId) void loadOrg(n.orgId);
  };

  let main;
  if (state.loaded && state.orgs.length === 0) {
    main = <Welcome onOpen={() => void addOrg()} onCreate={() => setCreateOpen(true)} />;
  } else if (!orgId || !orgSummary) {
    main = <Loading />;
  } else if (data?.prereq && isBlocking(data.prereq)) {
    main = <Prereqs orgId={orgId} prereq={data.prereq} signIn={state.signIn} pluginAction={data.pluginAction} onRecheck={() => refreshPrereqs(orgId)} />;
  } else if (!data?.view && !viewFailed[orgId]) {
    main = <Loading name={orgSummary.name} />;
  } else {
    const view = data?.view ?? null;
    const threadId = current as ThreadId;
    const tab = current === 'cos' ? null : visibleTabs.find((x) => tabThread(x.tabId) === current) ?? null;
    const key = threadKey(orgId, threadId);
    main = (
      <>
        <TopBar
          orgId={orgId}
          name={orgSummary.name}
          health={data?.health ?? null}
          plugin={data?.prereq?.plugin ?? null}
          appUpdate={state.appUpdate}
          pluginAction={data?.pluginAction ?? null}
          usage={state.usage}
          cosName={cosName}
          onRetryPlugin={() => refreshPrereqs(orgId)}
          panelHidden={panelHidden}
          waitingCount={askCount}
          onTogglePanel={togglePanel}
          askFixPending={!!askFix[orgId]}
          onAskFix={() => {
            const kind = data?.health?.conflict;
            if (kind) sendAskFix(fixHqMessage(kind));
          }}
          chartOpen={showChart}
          onToggleChart={() => setChartOpen((c) => toggleChart(c, orgId))}
        />
        <div className="org-body">
          <div className="center-col">
            <div className="tab-strip" role="tablist" ref={stripRef} onKeyDown={onTabKey}>
              <TabItem
                id="cos"
                active={current === 'cos'}
                busy={!!state.threads[threadKey(orgId, 'cos')]?.busy}
                tip={tabActivity(state.threads[threadKey(orgId, 'cos')])}
                title={t('tab.title', { name: cosName, role: t('cos.role') })}
                onSelect={() => select(orgId, 'cos')}
              />
              {visibleTabs.map((x) => {
                const id = tabThread(x.tabId);
                const th = state.threads[threadKey(orgId, id)];
                return (
                  <TabItem
                    key={x.tabId}
                    id={id}
                    active={current === id}
                    busy={!!th?.busy}
                    tip={x.status === 'handing-over' ? t('tab.handingOver', { cosName }) : tabActivity(th)}
                    title={t('tab.title', { name: x.persona, role: x.role })}
                    handingOver={x.status === 'handing-over'}
                    closeLabel={x.status === 'handing-over' ? undefined : t('tab.close', { persona: stripMarkdown(x.persona) })}
                    onSelect={() => select(orgId, id)}
                    onClose={() => closeTab(x.tabId)}
                  />
                );
              })}
            </div>
            {tab && confirmClose === tab.tabId && (
              <div className="confirm-bar" role="alertdialog" aria-label={t('tab.confirmBusy', { persona: stripMarkdown(tab.persona) })}>
                <span>{t('tab.confirmBusy', { persona: stripMarkdown(tab.persona) })}</span>
                <Button onClick={() => closeTab(tab.tabId, true)}>{t('tab.confirmStop')}</Button>
                <Button onClick={() => setConfirmClose(null)}>{t('tab.confirmCancel')}</Button>
              </div>
            )}
            {showChart ? (
              <OrgChartView
                onBack={() => {
                  setChartOpen((c) => closeChart(c, orgId));
                  focusStrip();
                }}
                chart={chart}
                live={chartLive}
                cosName={cosName}
                orgPath={orgSummary.path}
                waitingCount={askCount}
                roles={byId((view?.departments ?? []).map((d) => [d.id, d.role]))}
                tabs={tabs}
                askFixPending={!!askFix[orgId]}
                onAskFix={sendAskFix}
                dispatches={dispatches}
                onCos={() => runChartAction(cosClick(), cosName)}
                onCeo={showWaiting}
                onDepartment={(d) => runChartAction(departmentClick(d, chartLive, tabs), chart?.departments.find((x) => x.id === d.id)?.displayName ?? d.agent)}
                onChat={(agent) => runChartAction({ kind: 'start', agent }, chart?.departments.find((x) => x.agent === agent)?.displayName ?? agent)}
              />
            ) : (
            <ThreadView
              key={key}
              orgId={orgId}
              threadId={threadId}
              title={tab ? t('tab.title', { name: tab.persona, role: tab.role }) : t('tab.title', { name: cosName, role: t('cos.role') })}
              thread={state.threads[key]}
              speakerFallback={tab ? tab.persona : cosName}
              isCos={!tab}
              cosName={cosName}
              tabStatus={tab?.status ?? null}
              persona={tab?.persona ?? ''}
              permissions={permissionsFor(state, orgId, threadId)}
              reply={tab ? null : replyTargets[orgId] ?? null}
              onClearReply={() => setReplyTargets((r) => ({ ...r, [orgId]: null }))}
              onRestoreReply={(target) => setReplyTargets((r) => ({ ...r, [orgId]: target }))}
              focusNonce={focusNonce}
              insertRequest={tab ? null : insertRequest}
              onInsertDone={() => setInsertRequest(null)}
              pendingWork={!!tab?.pendingWork}
              onHandOver={() => tab && void api().handOver(orgId, tab.tabId)}
              onSetSettings={(patch) => changeSettings(orgId, patch)}
              onOpenSettings={() => openSettings(orgId)}
            />
            )}
          </div>
          <SidePanel
            orgId={orgId}
            cosName={cosName}
            waiting={view?.waiting ?? []}
            initiatives={view?.initiatives ?? []}
            departments={view?.departments ?? []}
            orgUnreadable={view?.orgUnreadable}
            tabs={tabs}
            busyTabIds={visibleTabs.filter((x) => state.threads[threadKey(orgId, tabThread(x.tabId))]?.busy).map((x) => x.tabId)}
            cosBusy={!!state.threads[threadKey(orgId, 'cos')]?.busy}
            cosTurnStartedAt={timeOf(state.threads[threadKey(orgId, 'cos')]?.activity?.startedAt)}
            hidden={panelHidden}
            onAnswer={answer}
            onChat={(agent) => void chat(agent)}
            onOpenChart={() => setChartOpen((c) => openChart(c, orgId))}
            looks={byId((chart?.departments ?? []).map((d) => [d.id, d.look]))}
            dispatches={dispatches}
            revealWaiting={revealWaiting}
            onOpenFocus={() => setFocusOrg(orgId)}
            tip={tip}
            onUseTip={insertTipPhrase}
            onDismissTip={dismissTip}
            onNextTip={nextTip}
            tipCount={tipCount}
          />
        </div>
      </>
    );
  }

  return (
    <div className="app">
      <Sidebar
        orgs={state.orgs}
        activeOrgId={orgId}
        onSelect={(id) => void loadOrg(id)}
        onAdd={() => void addOrg()}
        onCreate={() => setCreateOpen(true)}
        onSettings={() => orgId && openSettings(orgId)}
        onAbout={() => orgId && openSettings(orgId, ABOUT_SECTION)}
        onSetIcon={(id) => void iconAction(id, () => setOrgIcon(id))}
        onRemoveIcon={(id) => void iconAction(id, () => removeOrgIconNotice(id))}
      />
      <main className="main">{main}</main>
      {settingsFor && (
        <SettingsView
          open={settingsOpen}
          initialSection={settingsSection}
          orgs={state.orgs}
          orgId={settingsFor}
          activeOrgId={orgId ?? null}
          settings={state.orgData[settingsFor]?.settings ?? null}
          pending={state.orgData[settingsFor]?.settingsPending ?? false}
          applying={applying}
          onOrg={(id) => {
            setSettingsFor(id);
            loadSettings(id);
          }}
          onChange={(patch) => changeSettings(settingsFor, patch)}
          onApply={() => applySettings(settingsFor)}
          onSessionChange={() => dispatch({ type: 'settings-pending', orgId: settingsFor, pending: true })}
          onError={(text) => dispatch({ type: 'notice', orgId: settingsFor, text })}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      <CreateOrgView open={createOpen} onClose={() => setCreateOpen(false)} onFinished={(org, openCos) => void orgCreated(org, openCos)} />
      {closeAsk && closeAsk.orgId === orgId && askTab && (
        <CloseChatDialog
          open
          persona={stripMarkdown(askTab.persona)}
          cosName={cosName}
          busy={!!state.threads[threadKey(closeAsk.orgId, tabThread(closeAsk.tabId))]?.busy}
          onChoose={chooseClose}
        />
      )}
      {orgId && (
        <WaitingFocus
          key={orgId}
          open={focusOrg === orgId}
          orgId={orgId}
          items={waitingItems}
          onClose={() => setFocusOrg(null)}
          onReply={answerFromFocus}
        />
      )}
      <Toasts notices={state.notices} onDone={onDone} onAction={onToastAction} />
    </div>
  );
}
