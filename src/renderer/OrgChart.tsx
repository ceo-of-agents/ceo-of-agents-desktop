// The live org chart (org chart spec): CEO, chief of staff and the departments as a tree or a balanced grid, with
// status marks, worker chips, a legend and the error and empty states. Where everything goes comes from the pure
// `layoutChart`; this file renders it, measures what only the DOM knows (the canvas width, the chip blocks) and handles
// clicks, the keyboard and the node menu.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import type { Dispatch, OrgChart as Chart, OrgChartDepartment, OrgChartLive, OrgChartWorker, TabInfo } from '../shared/types';
import { own } from '../shared/own';
import { t } from '../shared/strings';
import { DeptTile } from './DeptTile';
import { DepartmentDispatchLine, DispatchTip, HelpersDispatchLine } from './DispatchIndicator';
import { departmentNodeDispatch, dispatchesOfDepartment, helpersNodeDispatch, NO_DISPATCHES, runningHelpers } from './dispatch-logic';
import { ArrowRightLeft, Ellipsis, Plus } from './icons';
import { fixAgentFileMessage, fixOrgYamlMessage } from './logic';
import { stripMarkdown } from './markdown-safety';
import { fitChips, fitRoleModel } from './org-chart-chips';
import { layoutChart, NODE_W, type Cell, type ChartLayout } from './org-chart-layout';
import { chartChangeMessage, modelName, nextChartNode, nodeAccessibleName, nodeStatus, statusWords, workerModels, type ChartNodeId, type NodeStatus } from './org-chart-logic';
import { mergeLeaving, type LeavingRow } from './panel-logic';
import { Button } from './ui/Button';
import { Popover } from './ui/Popover';
import { Spinner } from './ui/Spinner';
import { Tooltip } from './ui/Tooltip';

/** "+ Add department" is designed (spec section 5) but not built: the layout already counts it as a cell when this is on. */
export const ADD_DEPARTMENT_ENABLED = false;

/** Canvas width before it is measured (a 1280 px window with the side panel open). */
const DEFAULT_WIDTH = 858;
/** A removed node fades for this long (`--fade-fast`) before the others move. */
const LEAVE_MS = 120;

export interface OrgChartProps {
  chart: Chart | null;
  live: OrgChartLive | null;
  cosName: string;
  /** The org's folder, for the legend tooltip. */
  orgPath: string;
  /** Items waiting on the CEO (the same count as the top bar). */
  waitingCount: number;
  /** The department's role as its tab words it ("Design and brand"), by department id. */
  roles: Record<string, string>;
  tabs: TabInfo[];
  /** "Ask {cosName} to fix it" was sent and its turn has not ended. */
  askFixPending: boolean;
  onAskFix(message: string): void;
  /** The chief of staff's dispatches of this org: a department's tasks show on its node, helpers on the chief of staff's. */
  dispatches?: Dispatch[];
  onCos(): void;
  onCeo(): void;
  onDepartment(d: { id: string; agent: string }): void;
  /** Starts a chat with the department, or focuses its open one. */
  onChat(agent: string): void;
}

/** "10:42" for the time of the last good read. */
export function clockTime(iso: string | null): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// ---------- pieces ----------

function StatusLine({ status, words }: { status: NodeStatus | null; words: string }) {
  if (!status) return <div className="oc-status" />;
  const mark =
    status === 'agentMissing' ? <span className="oc-mark bang" aria-hidden="true">!</span>
    : status === 'handingOver' ? <span className="oc-mark"><Spinner size={12} delay={0} /></span>
    : status === 'handoffWaiting' ? <span className="oc-mark handoff"><ArrowRightLeft size={12} /></span>
    : status === 'working' ? <span className="oc-mark"><span className="tab-dot" aria-hidden="true" /></span>
    : null;
  // Keyed by the status, so a change cross-fades (120 ms) instead of swapping.
  return (
    <div className="oc-status" key={status}>
      {mark}
      <span>{words}</span>
    </div>
  );
}

/** The chips of a worker list; each has the first sentence of its description as a tooltip. */
function Chips({ workers }: { workers: OrgChartWorker[] }) {
  return (
    <>
      {workers.map((w) => (
        <Tooltip key={w.name} label={w.description} placement="bottom">
          <span className="chip">{w.name}</span>
        </Tooltip>
      ))}
    </>
  );
}

function DeptChips({ workers, cell, leaving, enterOnMount, measure }: { workers: OrgChartWorker[]; cell: Cell; leaving: boolean; enterOnMount: boolean; measure(el: HTMLDivElement | null): void }) {
  const [enter] = useState(enterOnMount);
  // One line inside the node's column: the model text goes first, then the extra chips fold into "+{n}" (never wraps).
  const fit = fitChips(workers, workerModels(workers));
  return (
    <div
      className="oc-chips"
      aria-hidden="true"
      ref={measure}
      data-leaving={leaving || undefined}
      data-enter={enter || undefined}
      style={{ transform: `translate(${cell.chipX}px, ${cell.chipY}px)`, maxWidth: cell.chipMaxWidth }}
    >
      <Chips workers={fit.shown} />
      {fit.folded.length > 0 && (
        <Tooltip label={fit.folded.map((w) => w.name).join(', ')} placement="bottom">
          <span className="chip more">{`+${fit.folded.length}`}</span>
        </Tooltip>
      )}
      {fit.showModel && <span className="oc-chip-model">{workerModels(workers)}</span>}
    </div>
  );
}

function CosChips({ workers, place }: { workers: OrgChartWorker[]; place?: { x: number; y: number; maxWidth: number } }) {
  const models = workerModels(workers);
  return (
    <div className="oc-chips cos" aria-hidden="true" style={place ? { transform: `translate(${place.x}px, ${place.y}px)`, maxWidth: place.maxWidth } : undefined}>
      <div className="oc-chip-row">
        <Chips workers={workers} />
      </div>
      {models && <span className="oc-chip-model">{models}</span>}
    </div>
  );
}

interface NodeProps {
  id: ChartNodeId;
  x: number;
  y: number;
  label: string;
  tip: ReactNode;
  tipLabel: string;
  level: 1 | 2 | 3;
  pos?: [number, number];
  tabIndex: 0 | -1;
  /** A broken department: clicking opens nothing. */
  inert?: boolean;
  leaving?: boolean;
  /** Mounted after the chart was first shown: appears with a pop. */
  enterOnMount?: boolean;
  setRef(id: ChartNodeId, el: HTMLDivElement | null): void;
  onFocusNode(id: ChartNodeId): void;
  onActivate(): void;
  /** Opens the node menu (right-click, the Menu key, Shift+F10 and the `···` button); only departments have one. */
  onMenu?(): void;
  menuOpen?: boolean;
  menuButtonLabel?: string;
  menu?(container: RefObject<HTMLElement>): ReactNode;
  children: ReactNode;
}

/** One node: a positioned wrapper (focus ring, tooltip, roving tabindex) around the card. */
function Node(p: NodeProps) {
  const [enter] = useState(!!p.enterOnMount);
  const self = useRef<HTMLDivElement | null>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      p.onActivate();
    } else if (p.onMenu && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) {
      e.preventDefault();
      p.onMenu();
    }
  };
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    // A click inside the menu popover is the menu's own; the `···` button stops its click.
    if ((e.target as HTMLElement).closest('.oc-body')) p.onActivate();
  };
  return (
    <Tooltip label={p.tipLabel} content={p.tip} placement="bottom">
      <div
        className={`oc-node${p.onMenu ? ' has-menu' : ''}`}
        ref={(el) => {
          self.current = el;
          p.setRef(p.id, el);
        }}
        role="treeitem"
        aria-level={p.level}
        aria-posinset={p.pos?.[0]}
        aria-setsize={p.pos?.[1]}
        aria-label={p.label}
        tabIndex={p.tabIndex}
        data-node={p.id}
        data-inert={p.inert || undefined}
        data-menu-open={p.menuOpen || undefined}
        data-leaving={p.leaving || undefined}
        data-enter={enter || undefined}
        style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
        onFocus={() => p.onFocusNode(p.id)}
        onKeyDown={onKeyDown}
        onClick={onClick}
        onContextMenu={
          p.onMenu
            ? (e) => {
                e.preventDefault();
                p.onMenu?.();
              }
            : undefined
        }
      >
        <div className="oc-body">
          {p.children}
          {p.onMenu && (
            <button
              className="icon-btn s24 oc-menu-btn"
              tabIndex={-1}
              aria-label={p.menuButtonLabel}
              aria-haspopup="menu"
              aria-expanded={!!p.menuOpen}
              onClick={(e) => {
                e.stopPropagation();
                p.onMenu?.();
              }}
            >
              <Ellipsis size={16} />
            </button>
          )}
        </div>
        {p.menu?.(self as RefObject<HTMLElement>)}
      </div>
    </Tooltip>
  );
}

/** The menu of a department node: its chat (starts one, or focuses the open one), or the fix for a broken one. */
function NodeMenu(p: {
  dept: OrgChartDepartment;
  name: string;
  cosName: string;
  broken: boolean;
  open: boolean;
  onClose(): void;
  container: RefObject<HTMLElement>;
  onChat(agent: string): void;
  onFix(): void;
  fixPending: boolean;
}) {
  const run = (fn: () => void) => () => {
    p.onClose();
    fn();
  };
  return (
    <Popover open={p.open} onClose={p.onClose} container={p.container} className="oc-menu" label={t('orgchart.menu.button', { name: p.name })}>
      <div className="oc-menu-list" role="menu">
        {p.broken ? (
          <button role="menuitem" className="oc-menu-item" disabled={p.fixPending} onClick={run(p.onFix)}>
            {t('orgchart.fix', { cosName: p.cosName })}
          </button>
        ) : (
          <button role="menuitem" className="oc-menu-item" onClick={run(() => p.onChat(p.dept.agent))}>
            {t('orgchart.menu.chat')}
          </button>
        )}
      </div>
    </Popover>
  );
}

function Legend({ cosName, noDepartments, readAt, path, left, chartWidth }: { cosName: string; noDepartments: boolean; readAt: string | null; path: string; left: number; chartWidth: number }) {
  // Same width and centring as the chart, so `left` (the chart's leftmost element) is measured from the same edge.
  return (
    <ul className="oc-legend" style={{ width: chartWidth - Math.max(0, left), marginLeft: `calc((100% - ${chartWidth}px) / 2 + ${left}px)`, marginRight: 'auto' }}>
      <li>
        <span className="oc-sample line" aria-hidden="true" />
        <span>{t(noDepartments ? 'orgchart.legend.talkOnly' : 'orgchart.legend.talk', { cosName })}</span>
      </li>
      <li>
        <span className="oc-sample handoff" aria-hidden="true">
          <ArrowRightLeft />
        </span>
        <span>{t('orgchart.legend.handoff', { cosName })}</span>
      </li>
      <li>
        <span className="oc-sample pill" aria-hidden="true" />
        <span>{t('orgchart.legend.helpers')}</span>
      </li>
      {readAt && (
        <li className="noicon">
          <Tooltip label={path} placement="top">
            <span>{t('orgchart.updated', { time: clockTime(readAt) })}</span>
          </Tooltip>
        </li>
      )}
    </ul>
  );
}

function ErrorPlate({ detail, stale, readAt, cosName, pending, onFix }: { detail: string; stale: boolean; readAt: string | null; cosName: string; pending: boolean; onFix(): void }) {
  return (
    <div className={`plate error oc-plate${stale ? ' stale' : ''}`} role="alert">
      <span className="err-mark" aria-hidden="true">
        !
      </span>
      <div className="plate-text">
        <span>{stale ? t('orgchart.error.stale', { time: clockTime(readAt) }) : t('orgchart.error')}</span>
        {detail && <span className="detail">{detail}</span>}
      </div>
      <Button variant="quiet" small loading={pending} loadingLabel={t('waiting.sent', { cosName })} onClick={onFix}>
        {t('orgchart.fix', { cosName })}
      </Button>
    </div>
  );
}

// ---------- the chart ----------

type DeptRow = LeavingRow<OrgChartDepartment>;
const NO_DEPARTMENTS: OrgChartDepartment[] = [];
const NO_WORKERS: OrgChartWorker[] = [];

export function OrgChart(p: OrgChartProps) {
  const { chart, live, cosName } = p;
  const dispatches = p.dispatches ?? NO_DISPATCHES;
  const canvas = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [chipHeights, setChipHeights] = useState<ReadonlyMap<string, number>>(new Map());
  const [cosChipsWidth, setCosChipsWidth] = useState(0);
  const [emptyHeight, setEmptyHeight] = useState(72);
  const [focusId, setFocusId] = useState<ChartNodeId>('cos');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const nodeRefs = useRef(new Map<ChartNodeId, HTMLDivElement>());
  const chipRefs = useRef(new Map<string, HTMLDivElement>());
  const measureCos = useRef<HTMLDivElement>(null);
  const emptyRef = useRef<HTMLDivElement>(null);
  const prevChart = useRef<Chart | null>(null);
  // Nodes that mount after the chart has been on screen once appear with a pop; the first ones are just there.
  const shownOnce = useRef(false);

  const usable = !!chart && !chart.error;
  const departments = usable ? chart.departments : NO_DEPARTMENTS;

  // Departments, plus the ones that just left: they fade out (120 ms), then the others move.
  const [rows, setRows] = useState<DeptRow[]>(() => mergeLeaving([], departments, (d) => d.id));
  const shown = useMemo(() => mergeLeaving(rows, departments, (d) => d.id), [rows, departments]);
  const anyLeaving = shown.some((r) => r.leaving);
  useLayoutEffect(() => {
    if (shown.length !== rows.length || shown.some((r, i) => r.key !== rows[i].key || r.leaving !== rows[i].leaving || r.item !== rows[i].item)) setRows(shown);
  }, [shown, rows]);
  useEffect(() => {
    if (!anyLeaving) return;
    const id = setTimeout(() => setRows((cur) => cur.filter((r) => !r.leaving)), LEAVE_MS);
    return () => clearTimeout(id);
  }, [anyLeaving]);
  useEffect(() => {
    if (usable) shownOnce.current = true;
  }, [usable]);

  // The canvas width, measured. When the side panel opens or closes it changes over 240 ms: the layout follows once it has settled.
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const read = () => Math.max(NODE_W, el.clientWidth - 48);
    setWidth(read());
    if (typeof ResizeObserver === 'undefined') return;
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setWidth(read()), reduced ? 0 : 260);
    });
    ro.observe(el);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
    };
  }, [usable]);

  // What only the DOM knows: the CoS chips' natural width, the departments' chip block heights, the placeholder's height.
  // After every render, on purpose: each setter keeps the old value when nothing changed, so this settles at once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const w = measureCos.current ? Math.ceil(measureCos.current.offsetWidth) : 0;
    setCosChipsWidth((old) => (old === w ? old : w));
    const next = new Map<string, number>();
    for (const [id, el] of chipRefs.current) next.set(id, Math.ceil(el.offsetHeight));
    setChipHeights((old) => (next.size === old.size && [...next].every(([k, v]) => old.get(k) === v) ? old : next));
    const eh = emptyRef.current ? Math.ceil(emptyRef.current.offsetHeight) : 72;
    setEmptyHeight((old) => (old === eh ? old : eh));
  });

  const cosWorkers = chart?.workers.types ?? [];
  const layout: ChartLayout = useMemo(
    () =>
      layoutChart({
        width,
        departments: shown.length,
        addCell: ADD_DEPARTMENT_ENABLED,
        chipHeights: shown.map((r) => (r.item.agentFile.found && r.item.workers.length > 0 ? chipHeights.get(r.key) ?? 0 : 0)),
        cosChipsWidth: usable && cosWorkers.length > 0 ? cosChipsWidth : 0,
        emptyHeight,
      }),
    [width, shown, chipHeights, cosChipsWidth, emptyHeight, usable, cosWorkers.length],
  );

  // The live region: one polite message per change of the chart.
  useEffect(() => {
    if (!chart) return;
    const msg = chartChangeMessage(prevChart.current, chart);
    prevChart.current = chart;
    if (msg) setMessage(msg);
  }, [chart]);

  const setNodeRef = useCallback((id: ChartNodeId, el: HTMLDivElement | null) => {
    if (el) nodeRefs.current.set(id, el);
    else nodeRefs.current.delete(id);
  }, []);

  if (!chart) {
    return (
      <div className="org-chart">
        <p className="oc-loading muted">{t('orgchart.loading')}</p>
      </div>
    );
  }
  const askFix = (detail: string) => () => p.onAskFix(fixOrgYamlMessage(detail));
  if (chart.error) {
    return (
      <div className="org-chart" ref={canvas}>
        <ErrorPlate detail={chart.error} stale={false} readAt={null} cosName={cosName} pending={p.askFixPending} onFix={askFix(chart.error)} />
      </div>
    );
  }

  const staying = shown.filter((r) => !r.leaving);
  const ids = staying.map((r) => r.key);
  const known = (id: ChartNodeId): boolean => id === 'ceo' || id === 'cos' || ids.includes(id.slice(5));
  const current: ChartNodeId = known(focusId) ? focusId : 'cos';
  const onTreeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!(e.target as HTMLElement).matches('[role="treeitem"]')) return;
    const next = nextChartNode(e.key, current, ids);
    if (!next) return;
    e.preventDefault();
    setFocusId(next);
    nodeRefs.current.get(next)?.focus();
  };

  const enterOnMount = shownOnce.current;
  const cosModel = modelName(chart.cos.model);
  const cosHandoffs = live?.cos.handoffsWaiting ?? 0;
  const cosStatus = nodeStatus({ handoffWaiting: cosHandoffs > 0, working: !!live?.cos.busy });
  // The chief of staff's status: a handoff waiting first, then its running helpers, then the rest.
  const helpersShown = cosStatus !== 'handoffWaiting' && runningHelpers(dispatches).length > 0;
  const cosWords = helpersShown ? helpersNodeDispatch(dispatches, 0)?.words ?? '' : cosStatus ? statusWords(cosStatus, cosHandoffs) : '';
  const ceoName = chart.ceo.displayName || t('orgchart.ceo.name');
  const waitingText = p.waitingCount > 0 ? t('orgchart.waiting', { count: p.waitingCount }) : t('orgchart.waiting.none');
  const mono = (path: string) => <div className="tt-mono">{path}</div>;
  const initial = (name: string) => stripMarkdown(name).trim().charAt(0).toUpperCase();

  const deptNodes = shown.map((r, index) => {
    const d = r.item;
    const cell = layout.cells[index];
    if (!cell) return null;
    const ld = own(live?.departments, d.id);
    const openTab = ld?.openTabId ? p.tabs.find((x) => x.tabId === ld.openTabId) : undefined;
    const broken = !d.agentFile.found;
    // A missing agent file says nothing about helpers: no chip row (and none from an earlier read).
    const helpers = broken ? NO_WORKERS : d.workers;
    // Priority: agent file missing, then the dispatch indicator, then the other statuses.
    const dispatched = broken ? NO_DISPATCHES : dispatchesOfDepartment(dispatches, d.id);
    const status = nodeStatus({ agentMissing: broken, handingOver: ld?.handingOver, handoffWaiting: ld?.handoffWaiting, working: ld?.running, chatOpen: !!openTab });
    const dispatchWords = dispatched.length > 0 ? departmentNodeDispatch(dispatched, 0)?.words : undefined;
    const words = dispatchWords ?? (status ? statusWords(status) : '');
    const name = stripMarkdown(d.displayName);
    const roleRaw = stripMarkdown(own(p.roles, d.id) ?? d.catalogRole ?? '');
    // "Persona equals role": the role line stays empty.
    const role = roleRaw.toLowerCase() === name.toLowerCase() ? '' : roleRaw;
    const model = modelName(d.model);
    const id: ChartNodeId = `dept:${d.id}`;
    return (
      <div key={r.key} style={{ display: 'contents' }}>
        <Node
          id={id}
          x={cell.x}
          y={cell.y}
          label={nodeAccessibleName({ name, role, model: d.model, status: words, workers: helpers })}
          tipLabel={name}
          tip={
            <>
              <div>{name}</div>
              {roleRaw && <div>{roleRaw}</div>}
              {model && <div>{t('orgchart.tip.model', { model })}</div>}
              {dispatched.length > 0 && <DispatchTip dispatches={dispatched} named={false} />}
              {mono(d.agentPath)}
            </>
          }
          level={3}
          pos={r.leaving ? undefined : [ids.indexOf(r.key) + 1, ids.length]}
          tabIndex={current === id ? 0 : -1}
          inert={broken}
          leaving={r.leaving}
          enterOnMount={enterOnMount}
          setRef={setNodeRef}
          onFocusNode={setFocusId}
          onActivate={() => !broken && p.onDepartment({ id: d.id, agent: d.agent })}
          onMenu={() => setMenuFor((cur) => (cur === d.id ? null : d.id))}
          menuOpen={menuFor === d.id}
          menuButtonLabel={t('orgchart.menu.button', { name })}
          menu={(container) => (
            <NodeMenu
              dept={d}
              name={name}
              cosName={cosName}
              broken={broken}
              open={menuFor === d.id}
              onClose={() => setMenuFor(null)}
              container={container}
              onChat={p.onChat}
              onFix={() => p.onAskFix(fixAgentFileMessage(name, d.agentPath))}
              fixPending={p.askFixPending}
            />
          )}
        >
          <DeptTile name={name} look={d.look} size="chart" />
          <div className="oc-text">
            <div className="oc-name">{name}</div>
            <div className="oc-sub">
              <span className="oc-role">{role}</span>
              {fitRoleModel(role, model) && <span className="oc-model">{model}</span>}
            </div>
            {dispatched.length > 0 ? <DepartmentDispatchLine dispatches={dispatched} /> : <StatusLine status={status} words={words} />}
          </div>
        </Node>
        {helpers.length > 0 && (
          <DeptChips
            workers={helpers}
            cell={cell}
            leaving={r.leaving}
            enterOnMount={enterOnMount}
            measure={(el) => {
              if (el) chipRefs.current.set(r.key, el);
              else chipRefs.current.delete(r.key);
            }}
          />
        )}
      </div>
    );
  });

  return (
    <div className="org-chart" ref={canvas}>
      {chart.staleError && <ErrorPlate detail={chart.staleError} stale readAt={chart.readAt} cosName={cosName} pending={p.askFixPending} onFix={askFix(chart.staleError)} />}
      <div className="oc-chart" role="tree" aria-label={t('orgchart.label')} style={{ width: layout.width, height: layout.height }} onKeyDown={onTreeKey}>
        <svg className="oc-edges" width={layout.width} height={layout.height} aria-hidden="true">
          {layout.edges.map((e) => (
            <path
              key={e.id}
              className={`oc-edge${e.dashed ? ' dashed' : ''}`}
              d={e.d}
              ref={(el) => {
                // `d` as a CSS property is what lets the edges follow the nodes over 240 ms.
                el?.style.setProperty('d', `path('${e.d}')`);
              }}
            />
          ))}
        </svg>

        <Node
          id="ceo"
          x={layout.ceo.x}
          y={layout.ceo.y}
          label={nodeAccessibleName({ name: ceoName, role: t('orgchart.ceo.role'), status: waitingText })}
          tipLabel={ceoName}
          tip={
            <>
              <div>{ceoName}</div>
              <div>{t('orgchart.ceo.role')}</div>
            </>
          }
          level={1}
          tabIndex={current === 'ceo' ? 0 : -1}
          setRef={setNodeRef}
          onFocusNode={setFocusId}
          onActivate={p.onCeo}
        >
          <span className="oc-avatar ceo" aria-hidden="true">
            {chart.ceo.displayName ? initial(chart.ceo.displayName) : ''}
          </span>
          <div className="oc-text">
            <div className="oc-name">{ceoName}</div>
            <div className="oc-sub">
              <span className="oc-role">{t('orgchart.ceo.role')}</span>
            </div>
            <div className={`oc-status${p.waitingCount > 0 ? ' you' : ''}`}>
              <span>{waitingText}</span>
            </div>
          </div>
        </Node>

        <Node
          id="cos"
          x={layout.cos.x}
          y={layout.cos.y}
          label={nodeAccessibleName({ name: cosName, role: t('orgchart.cos.role'), model: chart.cos.model, status: cosWords, workers: cosWorkers })}
          tipLabel={cosName}
          tip={
            <>
              <div>{cosName}</div>
              <div>{t('orgchart.cos.role')}</div>
              {cosModel && <div>{t('orgchart.tip.model', { model: cosModel })}</div>}
              {runningHelpers(dispatches).length > 0 && <DispatchTip dispatches={runningHelpers(dispatches)} named />}
              {mono('CLAUDE.md')}
            </>
          }
          level={2}
          tabIndex={current === 'cos' ? 0 : -1}
          setRef={setNodeRef}
          onFocusNode={setFocusId}
          onActivate={p.onCos}
        >
          <span className="oc-avatar cos" aria-hidden="true">
            {initial(cosName)}
          </span>
          <div className="oc-text">
            <div className="oc-name">{cosName}</div>
            <div className="oc-sub">
              <span className="oc-role">{t('orgchart.cos.role')}</span>
              {fitRoleModel(t('orgchart.cos.role'), cosModel) && <span className="oc-model">{cosModel}</span>}
            </div>
            {helpersShown ? <HelpersDispatchLine dispatches={dispatches} /> : <StatusLine status={cosStatus} words={cosWords} />}
          </div>
        </Node>
        {cosWorkers.length > 0 && layout.cosChips && <CosChips workers={cosWorkers} place={layout.cosChips} />}

        {layout.empty && (
          <div className="oc-empty" ref={emptyRef} style={{ transform: `translate(${layout.empty.x}px, ${layout.empty.y}px)` }}>
            <div className="oc-empty-title">{t('orgchart.empty.title')}</div>
            <div className="oc-empty-body">{t('orgchart.empty.body', { cosName })}</div>
          </div>
        )}

        {deptNodes}

        {ADD_DEPARTMENT_ENABLED && layout.cells.length > shown.length && (
          <button className="oc-add" style={{ transform: `translate(${layout.cells[shown.length].x}px, ${layout.cells[shown.length].y}px)` }}>
            <Plus />
            {t('orgchart.add')}
          </button>
        )}
      </div>

      {/* Natural size, off screen: the CoS chips decide how far the spine may sit from the right edge. */}
      {cosWorkers.length > 0 && (
        <div className="oc-measure" aria-hidden="true" ref={measureCos}>
          <CosChips workers={cosWorkers} />
        </div>
      )}

      <Legend cosName={cosName} noDepartments={staying.length === 0} readAt={chart.readAt} path={`${p.orgPath}/org.yaml`} left={layout.legendX} chartWidth={layout.width} />
      <div className="sr-only" role="status" aria-live="polite">
        {message}
      </div>
    </div>
  );
}
