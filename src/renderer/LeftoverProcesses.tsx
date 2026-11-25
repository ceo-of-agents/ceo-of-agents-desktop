import { useState } from 'react';
import type { HealthStatus } from '../shared/types';
import { t } from '../shared/strings';
import { api } from './api';
import { Button } from './ui/Button';
import { leftoverStartedLabel } from './logic';

/**
 * The health popover's list of `claude -p` processes an earlier run of the app left running (a crash, a force quit), found
 * from the app's own process ledger. One line each with a "Stop" button. The main process checks again that the pid is one
 * the app started in this org, so a process the app did not start can never be stopped from here.
 */
export function LeftoverProcesses({ orgId, health }: { orgId: string; health: HealthStatus }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [failed, setFailed] = useState<number | null>(null);
  const list = health.leftoverProcesses ?? [];
  if (list.length === 0) return null;

  const stop = (pid: number) => {
    setBusy(pid);
    setFailed(null);
    api()
      .stopLeftoverProcess(orgId, pid)
      .then((ok) => {
        if (!ok) setFailed(pid);
      })
      .catch(() => setFailed(pid))
      .finally(() => setBusy(null));
  };

  return (
    <div className="popover-rules muted small">
      {list.map((p) => (
        <div key={p.pid}>
          <div className="rules-line">
            <span className="rules-count">{t('health.leftover.line', { pid: String(p.pid), time: leftoverStartedLabel(p.startedAt) })}</span>
            <div className="rules-actions">
              <Button small variant="secondary" disabled={busy !== null} loading={busy === p.pid} loadingLabel={t('health.leftover.stopping')} onClick={() => stop(p.pid)}>
                {t('health.leftover.stop')}
              </Button>
            </div>
          </div>
          {failed === p.pid && <p className="error-text" role="alert">{t('health.leftover.error', { pid: String(p.pid) })}</p>}
        </div>
      ))}
    </div>
  );
}
