import { useEffect, useRef, useState } from 'react';
import type { AppUpdateStatus, HealthStatus, PlanUsage, PluginActionState, PluginStatus } from '../shared/types';
import { t, tn } from '../shared/strings';
import { api } from './api';
import { IgnoredRules } from './IgnoredRules';
import { LeftoverProcesses } from './LeftoverProcesses';
import { InlineMarkdown } from './Markdown';
import { stripMarkdown } from './markdown-safety';
import { AlertCircle, Check, Network, PanelRight } from './icons';
import { Button } from './ui/Button';
import { Popover } from './ui/Popover';
import { StatusMark, type StatusState } from './ui/StatusMark';
import { Tooltip } from './ui/Tooltip';
import { appUpdateView, healthLabel, leftoverOnly, pluginActions, pluginBadgeView, shortDateTime } from './logic';
import { usageView } from './usage-view';

const MARKS: Record<HealthStatus['color'], StatusState> = { green: 'ok', yellow: 'attention', orange: 'degraded', red: 'error' };

function Health({ orgId, health, cosName, askFixPending, onAskFix }: { orgId: string; health: HealthStatus | null; cosName: string; askFixPending: boolean; onAskFix(): void }) {
  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  if (!health) return null;
  const syncing = health.syncing;
  const label = syncing ? t('health.label.syncing') : leftoverOnly(health) ? t('health.label.leftover') : healthLabel(health.color);
  const needsSync = health.color === 'yellow' && !leftoverOnly(health);
  return (
    <div className="health no-drag" ref={wrap}>
      <button className="health-btn" aria-label={t('health.aria', { label })} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
        <StatusMark state={syncing ? 'syncing' : MARKS[health.color]} label={label} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} container={wrap} label={t('health.aria', { label })}>
        <p>{health.sentence}</p>
        <ul className="muted small">
          {health.hasRemote && <li>{tn('health.ahead', health.ahead)}</li>}
          {health.hasRemote && <li>{tn('health.behind', health.behind)}</li>}
          <li>{health.lastSyncAt ? t('health.lastSync', { time: shortDateTime(health.lastSyncAt) }) : t('health.neverSynced')}</li>
        </ul>
        <IgnoredRules orgId={orgId} health={health} cosName={cosName} />
        <LeftoverProcesses orgId={orgId} health={health} />
        {(needsSync || health.conflict || health.autoPushFailing || health.color === 'orange') && (
          <div className="popover-actions">
            {needsSync && (
              // One primary per group: with a failing push, "Try again" is the primary and Sync is secondary.
              <Button variant={health.autoPushFailing ? 'secondary' : 'primary'} loading={health.syncing} loadingLabel={t('health.syncing')} onClick={() => void api().sync(orgId)}>
                {t('health.sync')}
              </Button>
            )}
            {health.conflict ? (
              // A conflict needs hands: a retry cannot fix it, so the action asks the chief of staff.
              // Disabled while the request is queued or its turn runs, so a second click cannot send it twice.
              <Button
                variant="primary"
                loading={askFixPending}
                loadingLabel={t('waiting.sent', { cosName })}
                onClick={() => {
                  setOpen(false);
                  onAskFix();
                }}
              >
                {t('health.askCos', { cosName })}
              </Button>
            ) : (
              health.autoPushFailing && (
                <Button
                  variant="primary"
                  loading={retrying}
                  loadingLabel={t('health.tryingAgain')}
                  onClick={() => {
                    setRetrying(true);
                    void api()
                      .retryPush(orgId)
                      .catch(() => undefined)
                      .finally(() => setRetrying(false));
                  }}
                >
                  {t('health.tryAgain')}
                </Button>
              )
            )}
            {health.color === 'orange' && (
              <Tooltip label={t('health.connect.tooltip')} placement="top">
                <span className="tt-wrap">
                  <Button disabled>{t('health.connect')}</Button>
                </span>
              </Tooltip>
            )}
          </div>
        )}
      </Popover>
    </div>
  );
}

/** Plan usage (5-hour window, weekly limits) as Claude Code last reported it; reset times and the age of the reading in
 * the tooltip. A click reads `/usage` now (a local Claude Code command: no model call). */
function Usage({ usage }: { usage: PlanUsage | null }) {
  const [now, setNow] = useState(() => new Date());
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // The age and the countdowns move on their own while nothing new arrives.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    setNow(new Date());
    setNote(null);
  }, [usage]);
  const refresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    setNote(null);
    api()
      .refreshUsage()
      .then((r) => setNote(r === 'failed' || r === 'off' ? t('usage.refreshFailed') : r === 'unavailable' ? t('usage.refreshUnavailable') : null))
      .catch(() => setNote(t('usage.refreshFailed')))
      .finally(() => {
        setRefreshing(false);
        setNow(new Date());
      });
  };
  const v = usageView(usage, now, refreshing);
  const rows = note ? [...v.rows, note] : v.rows;
  return (
    <Tooltip label={rows.join('\n')} content={<div className="usage-tip">{rows.map((r) => <div key={r}>{r}</div>)}</div>}>
      <button type="button" className="usage no-drag" aria-label={v.aria} aria-busy={refreshing} onClick={refresh}>
        {v.chips.length === 0 ? (
          <span className="muted small">{t('usage.unknown')}</span>
        ) : (
          v.chips.map((c) => (
            <span key={c.key} className={`usage-chip small usage-${c.level}`}>
              {c.text}
            </span>
          ))
        )}
      </button>
    </Tooltip>
  );
}

const DONE_MS = 1200;

function PluginBadge({ orgId, plugin, action, cosName, onRetry }: { orgId: string; plugin: PluginStatus | null; action: PluginActionState | null; cosName: string; onRetry(): void }) {
  // "Updated" shows for a moment after a run ends well; an action that was already finished when this mounted does not flash.
  const [showDone, setShowDone] = useState(false);
  const seen = useRef(action);
  useEffect(() => {
    if (seen.current === action) return;
    seen.current = action;
    if (!action?.done) {
      setShowDone(false);
      return;
    }
    setShowDone(true);
    const id = setTimeout(() => setShowDone(false), DONE_MS);
    return () => clearTimeout(id);
  }, [action]);
  if (!plugin) return null;
  const show = pluginActions(plugin);
  const updating = action?.running && action.action === 'update';
  const view = pluginBadgeView(plugin, action, cosName, showDone);
  return (
    <div className="plugin-badge">
      {view.kind === 'error' ? (
        <span className="error-text small plugin-activity" role="alert">
          <AlertCircle size={12} /> {view.text}
        </span>
      ) : view.kind === 'done' ? (
        <span className="muted small plugin-activity" role="status">
          <Check size={12} /> {view.text}
        </span>
      ) : (
        <span className="muted small plugin-activity" role={view.kind === 'step' ? 'status' : undefined}>
          {view.text}
        </span>
      )}
      {(show.update || updating) && (
        <Button small loading={updating} loadingLabel={t('plugin.updating')} onClick={() => void api().updateOrg(orgId)}>
          {action?.error ? t('plugin.retry') : t('plugin.update')}
        </Button>
      )}
      {show.retry && !updating && (
        <Button small onClick={onRetry}>
          {t('plugin.retry')}
        </Button>
      )}
    </div>
  );
}

function AppUpdateBadge({ status }: { status: AppUpdateStatus | null }) {
  const view = appUpdateView(status);
  if (!view) return null;
  return (
    <div className="plugin-badge">
      {view.error ? (
        <span className="error-text small plugin-activity" role="alert">
          <AlertCircle size={12} /> {view.error}
        </span>
      ) : view.label ? (
        <span className="muted small plugin-activity" role="status">
          {view.label}
        </span>
      ) : null}
      <Button small title={view.title} disabled={view.disabled} loading={view.busy} loadingLabel={view.button} onClick={() => void api().updateApp()}>
        {view.button}
      </Button>
    </div>
  );
}

interface Props {
  orgId: string;
  name: string;
  health: HealthStatus | null;
  plugin: PluginStatus | null;
  /** The app's own update (app-wide), null until read. */
  appUpdate: AppUpdateStatus | null;
  pluginAction: PluginActionState | null;
  /** App-wide plan usage, null when not known yet. */
  usage: PlanUsage | null;
  cosName: string;
  onRetryPlugin(): void;
  /** The whole side panel is hidden. */
  panelHidden: boolean;
  /** Items waiting on the user: shown as a badge on the toggle while the panel is hidden. */
  waitingCount: number;
  onTogglePanel(): void;
  /** Send the chief of staff the request to fix a conflict between the hq and GitHub (and show that tab). */
  onAskFix(): void;
  /** That request was sent and its chief of staff turn has not ended yet. */
  askFixPending: boolean;
  /** The Org chart is shown in place of the thread. */
  chartOpen: boolean;
  onToggleChart(): void;
}

export function TopBar({ orgId, name, health, plugin, appUpdate, pluginAction, usage, cosName, onRetryPlugin, panelHidden, waitingCount, onTogglePanel, onAskFix, askFixPending, chartOpen, onToggleChart }: Props) {
  return (
    <header className="topbar">
      <h2 title={stripMarkdown(name)}>
        <InlineMarkdown text={name} noLinks />
      </h2>
      <div className="topbar-right">
        <PluginBadge orgId={orgId} plugin={plugin} action={pluginAction} cosName={cosName} onRetry={onRetryPlugin} />
        <AppUpdateBadge status={appUpdate} />
        <Usage usage={usage} />
        <Health orgId={orgId} health={health} cosName={cosName} askFixPending={askFixPending} onAskFix={onAskFix} />
        <Tooltip label={t('orgchart.open')}>
          <button className="icon-btn chart-toggle" aria-label={t('orgchart.open')} aria-pressed={chartOpen} onClick={onToggleChart}>
            <Network />
          </button>
        </Tooltip>
        <Tooltip label={t(panelHidden ? 'panel.show' : 'panel.hide')}>
          <button className="icon-btn panel-toggle" aria-label={t(panelHidden ? 'panel.show' : 'panel.hide')} aria-expanded={!panelHidden} aria-controls="side-panel" onClick={onTogglePanel}>
            <PanelRight />
            {panelHidden && waitingCount > 0 && (
              <span className="badge" key={waitingCount} aria-label={t('sidebar.waiting', { count: waitingCount })}>
                {waitingCount}
              </span>
            )}
          </button>
        </Tooltip>
      </div>
    </header>
  );
}
