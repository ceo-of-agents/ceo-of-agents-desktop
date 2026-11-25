import { useState } from 'react';
import type { HealthStatus } from '../shared/types';
import { t, tn } from '../shared/strings';
import { api } from './api';
import { Button } from './ui/Button';
import { broadRulesCounts, ignoredRulesCounts } from './logic';

/**
 * The health popover's one-line note on saved permission rules the app ignores (too broad): informational, it never
 * changes the indicator. "Show" unfolds the rules, one line each (full text on hover); "Clean up" removes the local ones
 * (settings.local.json) after an inline confirm. The hq's committed rules are listed apart and cannot be cleaned up here.
 * Above them, a warning when a settings file allows every Artifact action or AskUserQuestion: Claude Code reads those files
 * itself, so such a rule would run a publish, a delete or an answer with no card. Same Show and Clean up (local file only).
 */
export function IgnoredRules({ orgId, health, cosName }: { orgId: string; health: HealthStatus; cosName: string }) {
  const [shown, setShown] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const ignored = ignoredRulesCounts(health);
  const broad = broadRulesCounts(health);
  const { project } = ignored;
  const total = ignored.total + broad.total;
  const local = ignored.local + broad.local; // what Clean up removes
  const rules = health.droppedRules ?? { local: [], project: [] };
  const broadRules = health.broadRules ?? { local: [], project: [] };
  if (total === 0) return null;

  const remove = () => {
    setBusy(true);
    setFailed(false);
    api()
      .cleanUpIgnoredRules(orgId)
      .then(() => setConfirming(false))
      .catch(() => {
        setConfirming(false);
        setFailed(true);
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="popover-rules muted small">
      <div className="rules-line">
        <span className="rules-count">
          {broad.total > 0 && <strong>{tn('health.rules.broad.line', broad.total)}</strong>}
          {broad.total > 0 && ignored.total > 0 && ' '}
          {ignored.total > 0 && tn('health.rules.line', ignored.total)}
        </span>
        <div className="rules-actions">
          <Button small variant="quiet" aria-expanded={shown} onClick={() => setShown(!shown)}>
            {shown ? t('health.rules.hide') : t('health.rules.show')}
          </Button>
          {local > 0 && !confirming && (
            <Button small variant="secondary" onClick={() => { setFailed(false); setConfirming(true); }}>
              {t('health.rules.cleanUp')}
            </Button>
          )}
        </div>
      </div>
      {confirming && (
        <div
          className="auto-confirm"
          role="group"
          aria-label={t('health.rules.cleanUp')}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !busy) {
              e.stopPropagation();
              setConfirming(false);
            }
          }}
        >
          <p className="auto-confirm-text">{tn('health.rules.confirm', local)}</p>
          <div className="auto-confirm-actions">
            {/* The safe choice takes the focus when the confirm opens. */}
            <Button small variant="quiet" autoFocus disabled={busy} onClick={() => setConfirming(false)}>
              {t('health.rules.confirmNo')}
            </Button>
            <Button small variant="primary" loading={busy} loadingLabel={t('health.rules.removing')} onClick={remove}>
              {t('health.rules.confirmYes')}
            </Button>
          </div>
        </div>
      )}
      {failed && <p className="error-text" role="alert">{t('health.rules.error')}</p>}
      {shown && (
        <div className="rules-groups">
          {broad.local > 0 && <RuleGroup title={t('health.rules.broad.local')} rules={broadRules.local} note={t('health.rules.broad.localNote')} />}
          {broad.project > 0 && (
            <RuleGroup title={t('health.rules.broad.project')} rules={broadRules.project} note={t('health.rules.broad.projectNote', { cosName })} />
          )}
          {ignored.local > 0 && <RuleGroup title={t('health.rules.local')} rules={rules.local} />}
          {project > 0 && <RuleGroup title={t('health.rules.project')} rules={rules.project} note={t('health.rules.projectNote', { cosName })} />}
        </div>
      )}
    </div>
  );
}

function RuleGroup({ title, rules, note }: { title: string; rules: string[]; note?: string }) {
  return (
    <div className="rules-group">
      <h5 className="popover-sub">{title}</h5>
      {note && <p>{note}</p>}
      <ul className="rules-list">
        {rules.map((r, i) => (
          <li key={`${i}:${r}`} title={r}>
            <code>{r}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
