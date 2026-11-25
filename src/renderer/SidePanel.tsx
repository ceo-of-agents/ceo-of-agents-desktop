import { createContext, Fragment, useCallback, type ReactNode, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Department, DepartmentLook, Dispatch, Initiative, TabInfo, Tip, WaitingEntry, WaitingItem } from '../shared/types';
import { t } from '../shared/strings';
import { own } from '../shared/own';
import { DeptTile } from './DeptTile';
import { DepartmentDispatches } from './DispatchIndicator';
import { InitiativeCard } from './InitiativeCard';
import { InitiativeView } from './InitiativeView';
import { dispatchesOfDepartment, NO_DISPATCHES } from './dispatch-logic';
import { Check, ChevronRight, Maximize2, Network } from './icons';
import { InlineMarkdown } from './Markdown';
import { stripMarkdown } from './markdown-safety';
import {
  defaultPanelState, groupInitiatives, isUntagged, isWaitingItem, loadPanelState, savePanelState,
  type PanelSection, type PanelState,
} from './logic';
import { groupWaiting, mergeLeaving, type LeavingRow, type WaitingGroup } from './panel-logic';
import { asksTheCeo } from '../shared/waiting';
import { pendingStore } from './pending-send';
import { WaitingCard } from './WaitingCard';
import { Button } from './ui/Button';
import { Fold } from './ui/Fold';
import { Tooltip } from './ui/Tooltip';
import { TipCard } from './TipCard';

interface Props {
  orgId: string;
  cosName: string;
  waiting: WaitingEntry[];
  initiatives: Initiative[];
  departments: Department[];
  /** org.yaml cannot be read and there is no earlier good read: the list is empty for that reason (the chart shows the error). */
  orgUnreadable?: boolean;
  tabs: TabInfo[];
  /** Ids of the department chats whose turn is running. */
  busyTabIds: string[];
  /** The chief of staff's turn is running. */
  cosBusy: boolean;
  /** When the chief of staff's current turn started (ms), null when idle. */
  cosTurnStartedAt: number | null;
  /** The whole panel is hidden (the top bar toggle): it stays mounted so it can animate. */
  hidden: boolean;
  /** Reply or Answer on a waiting item; `code` is null for a line the app could not parse (the raw line is the target). */
  onAnswer(code: string | null, text?: string): void;
  /** Starts a chat with the department, or focuses its open one. */
  onChat(agent: string): void;
  /** Opens the Org chart view (in place of the thread). */
  onOpenChart(): void;
  /** The tile of each department from `app-look.yaml`, by department id (missing: initials). */
  looks: Record<string, DepartmentLook | null>;
  /** The chief of staff's dispatches of this org (running ones and ended ones not yet seen); shown under each department's row. */
  dispatches?: Dispatch[];
  /** Changes when the CEO node of the org chart asks to show "Waiting on you": the section opens and scrolls into view. */
  revealWaiting: number;
  /** The icon button of the Waiting header: opens the focus view. */
  onOpenFocus?(): void;
  /** The org's current contextual tip (null: none; the box is then not rendered). */
  tip?: Tip | null;
  /** The tip text was clicked: the phrase goes to the chief of staff's message box (never sent). */
  onUseTip?(phrase: string): void;
  /** "Got it" on the tip: dismisses it for good and shows the next one. */
  onDismissTip?(id: string): void;
  /** "Next tip": shows the next applicable tip. Hidden when `tipCount` is 1. */
  onNextTip?(): void;
  /** How many tips apply (the "Next tip" button shows from 2). */
  tipCount?: number;
}

interface PanelCtx {
  orgId: string;
  open: PanelState;
  toggle(section: PanelSection): void;
  expanded: Record<string, boolean>;
  toggleExpanded(key: string): void;
}

// Created in SidePanel: sections read the org id, their open state and the expanded items from here.
const PanelContext = createContext<PanelCtx>({ orgId: '', open: defaultPanelState(), toggle: () => {}, expanded: {}, toggleExpanded: () => {} });

const sectionId = (orgId: string, section: PanelSection) => `panel-${orgId}-${section}`;

const Chevron = ({ open }: { open: boolean }) => <ChevronRight size={10} strokeWidth={2} className={`chev${open ? ' open' : ''}`} />;

/** Section header (5.8): a button with a chevron, the title in mono capitals and the count. "Waiting on you" is violet with a badge. */
function SectionHead({ section, title, count, you, action }: { section: PanelSection; title: string; count: number; you?: boolean; action?: ReactNode }) {
  const { orgId, open, toggle } = useContext(PanelContext);
  const isOpen = open[section];
  return (
    <h4 className={`section-title${action ? ' has-action' : ''}`}>
      <button className={`section-head${you ? ' you' : ''}`} aria-expanded={isOpen} aria-controls={sectionId(orgId, section)} onClick={() => toggle(section)}>
        <Chevron open={isOpen} />
        <span className="section-name">{title}</span>
        {you ? (
          count > 0 && (
            <span className="count-badge" key={count} aria-live="polite">
              {count}
            </span>
          )
        ) : (
          <span className="count">{count}</span>
        )}
      </button>
      {action}
    </h4>
  );
}

/** The body of a section: folds away when the section is collapsed. */
function Section({ section, children }: { section: PanelSection; children: ReactNode }) {
  const { orgId, open } = useContext(PanelContext);
  return (
    <Fold open={open[section]} id={sectionId(orgId, section)}>
      {children}
    </Fold>
  );
}

const keyOfItem = (w: WaitingItem) => w.code;
const keyOfGroup = (g: WaitingGroup) => g.item.code;

/** Rows of a list whose removed items stay for 340 ms (fade 120 + fold 220), marked `leaving`, so their card can collapse out. */
function useLeavingRows<T>(items: T[], keyOf: (x: T) => string): LeavingRow<T>[] {
  const [rows, setRows] = useState<LeavingRow<T>[]>(() => mergeLeaving([], items, keyOf));
  const merged = useMemo(() => mergeLeaving(rows, items, keyOf), [rows, items, keyOf]);
  useLayoutEffect(() => {
    if (merged.length !== rows.length || merged.some((r, i) => r.key !== rows[i].key || r.leaving !== rows[i].leaving || r.item !== rows[i].item)) setRows(merged);
    if (!merged.some((r) => r.leaving)) return;
    const id = setTimeout(() => setRows((cur) => cur.filter((r) => !r.leaving)), 340);
    return () => clearTimeout(id);
  }, [merged, rows]);
  return merged;
}

/** The cards of one waiting item, each in its slot so it can collapse out when it leaves. */
function WaitingRow({ r, orgId, cosName, onAnswer }: { r: LeavingRow<WaitingGroup>; orgId: string; cosName: string; onAnswer: Props['onAnswer'] }) {
  const { expanded, toggleExpanded } = useContext(PanelContext);
  const { item, children: kids } = r.item;
  return (
    <div className="card-slot" data-leaving={r.leaving}>
      <div className="card-slot-inner">
        <WaitingCard
          item={item}
          orgId={orgId}
          cosName={cosName}
          expanded={!!expanded[`w:${r.key}`]}
          onToggleExpanded={() => toggleExpanded(`w:${r.key}`)}
          leaving={r.leaving}
          onAnswer={onAnswer}
          group={kids.length > 0 ? { count: kids.length, open: !!expanded[`g:${r.key}`], onToggle: () => toggleExpanded(`g:${r.key}`), children: <WaitingChildren kids={kids} orgId={orgId} cosName={cosName} onAnswer={onAnswer} /> } : undefined}
        />
      </div>
    </div>
  );
}

/** The child cards of a parent, in the order of the hq file, each with its own actions. */
function WaitingChildren({ kids, orgId, cosName, onAnswer }: { kids: WaitingItem[]; orgId: string; cosName: string; onAnswer: Props['onAnswer'] }) {
  const { expanded, toggleExpanded } = useContext(PanelContext);
  const rows = useLeavingRows(kids, keyOfItem);
  return (
    <>
      {rows.map((r) => (
        <div className="card-slot" data-leaving={r.leaving} key={r.key}>
          <div className="card-slot-inner">
            <WaitingCard
              item={r.item}
              orgId={orgId}
              cosName={cosName}
              expanded={!!expanded[`w:${r.key}`]}
              onToggleExpanded={() => toggleExpanded(`w:${r.key}`)}
              leaving={r.leaving}
              onAnswer={onAnswer}
            />
          </div>
        </div>
      ))}
    </>
  );
}

function Waiting({ orgId, cosName, cosBusy, cosTurnStartedAt, waiting, onAnswer, onOpenFocus }: Pick<Props, 'orgId' | 'cosName' | 'cosBusy' | 'cosTurnStartedAt' | 'waiting' | 'onAnswer' | 'onOpenFocus'>) {
  const items = useMemo(() => waiting.filter(isWaitingItem), [waiting]);
  const groups = useMemo(() => groupWaiting(items), [items]);
  const asking = useMemo(() => items.filter(asksTheCeo).length, [items]);
  const unparsed = waiting.filter((w) => !isWaitingItem(w));
  const merged = useLeavingRows(groups, keyOfGroup);

  // Tell the pending-send store what is on screen, so a sent card leaves or returns to normal.
  const version = useSyncExternalStore(pendingStore.subscribe, pendingStore.version, pendingStore.version);
  useLayoutEffect(() => {
    pendingStore.observe(orgId, cosBusy, new Set(items.map((w) => w.code)), cosTurnStartedAt);
  }, [orgId, cosBusy, cosTurnStartedAt, items, version]);

  // The older-format hint goes directly under the last group that has an untagged item, and only when there is one.
  const lastUntagged = merged.reduce((last, r, i) => (!r.leaving && (isUntagged(r.item.item) || r.item.children.some(isUntagged)) ? i : last), -1);
  return (
    <section className="panel-section">
      <SectionHead
        section="waiting"
        title={t('waiting.title')}
        count={asking}
        you
        action={
          asking > 0 && onOpenFocus ? (
            <Tooltip
              label={t('waiting.focus.open')}
              content={
                <>
                  {t('waiting.focus.open')} <span className="muted">{t('waiting.focus.openShortcut')}</span>
                </>
              }
            >
              <button className="icon-btn s24" aria-label={t('waiting.focus.open')} onClick={onOpenFocus}>
                <Maximize2 size={14} />
              </button>
            </Tooltip>
          ) : undefined
        }
      />
      <Section section="waiting">
        {items.length === 0 && unparsed.length === 0 && (
          <p className="panel-empty muted small">
            <Check size={12} strokeWidth={2.5} className="ok-check" />
            {t('waiting.empty')}
          </p>
        )}
        {merged.map((r, i) => (
          <Fragment key={r.key}>
            <WaitingRow r={r} orgId={orgId} cosName={cosName} onAnswer={onAnswer} />
            {i === lastUntagged && <p className="panel-hint">{t('waiting.untaggedHint')}</p>}
          </Fragment>
        ))}
        {unparsed.map((w, i) =>
          isWaitingItem(w) ? null : (
            <div className="item neutral unparsed" key={`u${i}`}>
              <div className="muted small">
                <InlineMarkdown text={w.unparsed} />
              </div>
              <div className="w-actions-wrap">
                <Button small variant="quiet" onClick={() => onAnswer(null, w.unparsed.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''))}>{t('waiting.reply')}</Button>
              </div>
            </div>
          ),
        )}
      </Section>
    </section>
  );
}

function Initiatives({ cosName, initiatives }: Pick<Props, 'cosName' | 'initiatives'>) {
  const [showClosed, setShowClosed] = useState(false);
  const [view, setView] = useState<{ slug: string; title: string; open: boolean } | null>(null);
  const g = groupInitiatives(initiatives);
  const count = initiatives.filter((i) => i.state === 'active' || i.state === 'paused').length;
  const { orgId, expanded, toggleExpanded } = useContext(PanelContext);
  const item = (i: Initiative) => (
    <InitiativeCard
      key={i.slug}
      i={i}
      orgId={orgId}
      cosName={cosName}
      expanded={!!expanded[`i:${i.slug}`]}
      onToggleExpanded={() => toggleExpanded(`i:${i.slug}`)}
      onOpen={() => setView({ slug: i.slug, title: i.title, open: true })}
    />
  );
  return (
    <section className="panel-section">
      <SectionHead section="initiatives" title={t('initiatives.title')} count={count} />
      <Section section="initiatives">
        <p className="panel-explainer">{t('initiatives.explainer', { cosName })}</p>
        {initiatives.length === 0 && <p className="panel-empty muted small">{t('initiatives.empty', { cosName })}</p>}
        {/* Active initiatives sit directly under the section header; the other groups get a sub-header only when they have items. */}
        {g.inProgress.map(item)}
        {g.onHold.length > 0 && <h5 className="group-head">{t('initiatives.group.paused')}</h5>}
        {g.onHold.map(item)}
        {g.closed.length > 0 && (
          <>
            <h5 className="group-head">
              <button className="group-toggle" aria-expanded={showClosed} aria-controls={`closed-${orgId}`} onClick={() => setShowClosed(!showClosed)}>
                <Chevron open={showClosed} />
                {t('initiatives.group.closed', { count: g.closed.length })}
              </button>
            </h5>
            <Fold open={showClosed} id={`closed-${orgId}`}>
              {g.closed.map(item)}
            </Fold>
          </>
        )}
      </Section>
      {view && <InitiativeView orgId={orgId} slug={view.slug} title={view.title} open={view.open} onClose={() => setView({ ...view, open: false })} />}
    </section>
  );
}

function Departments({ departments, orgUnreadable, tabs, busyTabIds, looks, dispatches = NO_DISPATCHES, cosName, onChat, onOpenChart }: Pick<Props, 'departments' | 'orgUnreadable' | 'tabs' | 'busyTabIds' | 'looks' | 'dispatches' | 'cosName' | 'onChat' | 'onOpenChart'>) {
  return (
    <section className="panel-section">
      <SectionHead
        section="departments"
        title={t('departments.title')}
        count={departments.length}
        action={
          <Tooltip label={t('orgchart.open')}>
            <button className="icon-btn s24" aria-label={t('orgchart.open')} onClick={onOpenChart}>
              <Network />
            </button>
          </Tooltip>
        }
      />
      <Section section="departments">
        {departments.length === 0 && <p className="panel-empty muted small">{t(orgUnreadable ? 'departments.unreadable' : 'departments.empty')}</p>}
        {departments.map((d) => {
          const running = tabs.some((x) => x.agent === d.agent && busyTabIds.includes(x.tabId));
          const title = t('tab.title', { name: d.persona, role: d.role });
          return (
            <div className="dept" key={d.id}>
              <div className="dept-row">
                <DeptTile name={stripMarkdown(d.persona)} look={own(looks, d.id)} size="panel" />
                <span className="dept-name">
                  <InlineMarkdown text={title} noLinks />
                </span>
                {running && (
                  <Tooltip label={t('departments.running')} placement="top">
                    <span className="tab-dot" role="img" aria-label={t('departments.running')} />
                  </Tooltip>
                )}
                <Button small className="dept-chat" onClick={() => onChat(d.agent)}>{t('departments.chat')}</Button>
              </div>
              <DepartmentDispatches dispatches={dispatchesOfDepartment(dispatches, d.id)} name={stripMarkdown(d.persona)} cosName={cosName} />
            </div>
          );
        })}
      </Section>
    </section>
  );
}

export function SidePanel(p: Props) {
  const [panel, setPanel] = useState(() => ({ orgId: p.orgId, open: loadPanelState(localStorage, p.orgId) }));
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  let open = panel.open;
  if (panel.orgId !== p.orgId) {
    // another org selected: load its remembered state
    open = loadPanelState(localStorage, p.orgId);
    setPanel({ orgId: p.orgId, open });
  }
  // The CEO node of the org chart: open "Waiting on you" and bring it into view once the panel has room.
  const lastReveal = useRef(p.revealWaiting);
  useEffect(() => {
    if (p.revealWaiting === lastReveal.current) return;
    lastReveal.current = p.revealWaiting;
    if (!open.waiting) {
      const next = { ...open, waiting: true };
      savePanelState(localStorage, p.orgId, next);
      setPanel({ orgId: p.orgId, open: next });
    }
    const id = setTimeout(() => document.getElementById(sectionId(p.orgId, 'waiting'))?.closest('.panel-section')?.scrollIntoView({ block: 'start' }), 260);
    return () => clearTimeout(id);
  }, [p.revealWaiting, p.orgId, open]);
  const toggle = useCallback(
    (section: PanelSection) => {
      const next = { ...open, [section]: !open[section] };
      savePanelState(localStorage, p.orgId, next);
      setPanel({ orgId: p.orgId, open: next });
    },
    [open, p.orgId],
  );
  const ctx: PanelCtx = {
    orgId: p.orgId,
    open,
    toggle,
    // keyed by org, so a refresh of the same org keeps what is expanded
    expanded: Object.fromEntries(Object.entries(expanded).filter(([k]) => k.startsWith(`${p.orgId}|`)).map(([k, v]) => [k.slice(p.orgId.length + 1), v])),
    toggleExpanded: (key) => setExpanded((e) => ({ ...e, [`${p.orgId}|${key}`]: !e[`${p.orgId}|${key}`] })),
  };
  return (
    <PanelContext.Provider value={ctx}>
      <div className="panel-shell" data-hidden={p.hidden} id="side-panel">
        <aside className="side-panel" aria-label={t('panel.label')}>
          <Waiting key={`w-${p.orgId}`} orgId={p.orgId} cosName={p.cosName} cosBusy={p.cosBusy} cosTurnStartedAt={p.cosTurnStartedAt} waiting={p.waiting} onAnswer={p.onAnswer} onOpenFocus={p.onOpenFocus} />
          <Initiatives key={`i-${p.orgId}`} cosName={p.cosName} initiatives={p.initiatives} />
          <Departments
            key={`d-${p.orgId}`}
            departments={p.departments}
            orgUnreadable={p.orgUnreadable}
            tabs={p.tabs}
            busyTabIds={p.busyTabIds}
            looks={p.looks}
            dispatches={p.dispatches}
            cosName={p.cosName}
            onChat={p.onChat}
            onOpenChart={p.onOpenChart}
          />
          {p.tip && <TipCard key={`t-${p.orgId}`} tip={p.tip} onUse={(phrase) => p.onUseTip?.(phrase)} onDismiss={(id) => p.onDismissTip?.(id)} onNext={() => p.onNextTip?.()} many={(p.tipCount ?? 1) > 1} />}
        </aside>
      </div>
    </PanelContext.Provider>
  );
}
