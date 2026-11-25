// Department liveness (read-only): what the chief of staff has dispatched, shown on the org chart node and under the
// department's row in the side panel. It shows state only: it opens no transcript and no chat, and takes no clicks.
import type { Dispatch } from '../shared/types';
import { t } from '../shared/strings';
import { Check } from './icons';
import {
  departmentNodeDispatch, dispatchLineParts, dispatchTip, dispatchTipLines, helpersNodeDispatch, isRunning, runningHelpers,
  type LineParts, type NodeDispatch,
} from './dispatch-logic';
import { useNow } from './useDispatchAck';
import { Tooltip } from './ui/Tooltip';

type Shown = Dispatch['state'];

/** The mark of a state: a pulsing dot while running, a static mark once ended (never colour alone: the text says it too). */
function Mark({ state }: { state: Shown }) {
  return (
    <span className="dp-mark" data-state={state} aria-hidden="true">
      {state === 'running' ? <span className="tab-dot dp-pulse" /> : state === 'done' ? <Check size={12} /> : state === 'failed' ? '!' : state === 'unknown' ? '?' : <span className="dp-square" />}
    </span>
  );
}

/** The text of a line: the description is the part that is cut with an ellipsis, the state and the time stay whole. */
function LineText({ parts }: { parts: LineParts }) {
  return (
    <span className="dp-text">
      <span className="dp-before">{parts.before}</span>
      {parts.description && <span className="dp-desc">{parts.description}</span>}
      {parts.after && <span className="dp-after">{parts.after}</span>}
    </span>
  );
}

/** One dispatch under a department row of the side panel. Several of them make a list: one line per dispatch. */
function Row({ dispatch, now, cosName }: { dispatch: Dispatch; now: number; cosName: string }) {
  const tip = dispatchTip(dispatch, now, cosName);
  const line = (
    <li className="dp-row" data-state={dispatch.state}>
      <Mark state={dispatch.state} />
      <LineText parts={dispatchLineParts(dispatch, now)} />
    </li>
  );
  return tip ? <Tooltip label={tip} placement="top">{line}</Tooltip> : line;
}

/** The dispatches of one department in the side panel (nothing when there are none). Ticks once per second while one runs. */
export function DepartmentDispatches({ dispatches, name, cosName }: { dispatches: Dispatch[]; name: string; cosName: string }) {
  const now = useNow(dispatches.some(isRunning));
  if (dispatches.length === 0) return null;
  return (
    <ul className="dp-list" aria-label={t('dispatch.list.label', { name })}>
      {[...dispatches].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)).map((d) => (
        <Row key={d.id} dispatch={d} now={now} cosName={cosName} />
      ))}
    </ul>
  );
}

/** The one status line of an org chart node (same box as the node's other statuses: one line, fixed 200 px node). */
function NodeLine({ view }: { view: NodeDispatch }) {
  return (
    <div className="oc-status dp-status" data-state={view.state}>
      <span className="oc-mark">
        <Mark state={view.state} />
      </span>
      <LineText parts={view.parts} />
    </div>
  );
}

/** The status line of a department node: its dispatch (one), "n tasks working" (several running), or the newest ended one. */
export function DepartmentDispatchLine({ dispatches }: { dispatches: Dispatch[] }) {
  const now = useNow(dispatches.some(isRunning));
  const view = departmentNodeDispatch(dispatches, now);
  return view ? <NodeLine view={view} /> : null;
}

/** The status line of the chief of staff node for helpers (`reader`, `worker`): "2 helpers working · 20 s". */
export function HelpersDispatchLine({ dispatches }: { dispatches: Dispatch[] }) {
  const now = useNow(runningHelpers(dispatches).length > 0);
  const view = helpersNodeDispatch(dispatches, now);
  return view ? <NodeLine view={view} /> : null;
}

/** Every dispatch of a node as a line of its tooltip (the node's one status line may summarise them). */
export function DispatchTip({ dispatches, named }: { dispatches: Dispatch[]; named: boolean }) {
  const now = useNow(dispatches.some(isRunning));
  return (
    <>
      {dispatchTipLines(dispatches, now, named).map((line, i) => (
        <div key={i}>{line}</div>
      ))}
    </>
  );
}
