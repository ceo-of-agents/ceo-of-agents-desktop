import { useEffect, useState } from 'react';
import type { AllowRuleEntry, DenyRuleEntry, PermissionMode, PermissionRules } from '../shared/types';
import { t } from '../shared/strings';
import { api } from './api';
import { AutoModeConfirm } from './AutoModeConfirm';
import { ipcReason, needsAutoConfirm, PERMISSION_MODES, settingSourceLabel } from './logic';
import type { SectionProps } from './settings-logic';
import { ApplyNote } from './SettingsApply';
import { Button } from './ui/Button';

/** Permissions of one org: the mode, then the rules (the hq's, the ones saved with Always allow, the denied ones). */
export function SettingsPermissions({ orgId, orgName, settings, pending, applying, onChange, onApply, onSessionChange, onError }: SectionProps) {
  // Switching the org to Auto mode waits for this inline confirm (same as the composer footer).
  const [confirmAuto, setConfirmAuto] = useState(false);
  const [rules, setRules] = useState<PermissionRules | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setRules(null);
    setFailed(null);
    api()
      .getPermissionRules(orgId)
      .then((r) => live && setRules(r))
      .catch((e: unknown) => live && setFailed(ipcReason(e)));
    return () => {
      live = false;
    };
  }, [orgId]);

  const remove = (rule: string) => {
    setRemoving(rule);
    api()
      .removeSavedRule(orgId, rule)
      .then((r) => {
        setRules(r);
        onSessionChange();
      })
      .catch((e: unknown) => onError(t('settings.rules.removeFailed', { file: '.claude/settings.local.json', reason: ipcReason(e) })))
      .finally(() => setRemoving(null));
  };

  const pick = (m: PermissionMode) => {
    if (!settings) return;
    if (needsAutoConfirm(settings.permissionMode, m)) setConfirmAuto(true);
    else {
      setConfirmAuto(false);
      onChange({ permissionMode: m });
    }
  };

  return (
    <>
      <ApplyNote orgName={orgName} pending={pending} applying={applying} onApply={onApply} />
      <div className="settings-group">
        {!settings ? (
          <p className="muted">{t('loading')}</p>
        ) : (
          <fieldset className="setting-modes">
            <legend className="setting-label">{t('settings.mode.label')}</legend>
            {PERMISSION_MODES.map((m) => (
              <label key={m} className="radio">
                <input type="radio" name="permissionMode" checked={settings.permissionMode === m} onChange={() => pick(m)} />
                {/* Claude Code's own name for the mode, with what it does under it. */}
                <span className="radio-text">
                  <span>{t(`settings.mode.${m}`)}</span>
                  <span className="radio-hint">{t(`settings.mode.${m}.hint`)}</span>
                </span>
              </label>
            ))}
            {confirmAuto && (
              <AutoModeConfirm
                onConfirm={() => {
                  setConfirmAuto(false);
                  onChange({ permissionMode: 'auto' });
                }}
                onCancel={() => setConfirmAuto(false)}
              />
            )}
            <p className="setting-note muted">
              {settingSourceLabel(settings.permissionModeSource)}. {t('settings.when.chats')}
            </p>
          </fieldset>
        )}
      </div>
      {failed ? (
        <div className="settings-group">
          <p className="error-text">{t('settings.rules.failed', { reason: failed })}</p>
        </div>
      ) : !rules ? (
        <div className="settings-group">
          <p className="muted">{t('settings.rules.loading')}</p>
        </div>
      ) : (
        <>
          <RuleGroup id="hq" title={t('settings.rules.hq')} note={t('settings.rules.hq.note')} empty={t('settings.rules.empty.hq')}>
            {rules.hqAllow.map((r) => (
              <AllowRow key={r.rule} entry={r} />
            ))}
          </RuleGroup>
          <RuleGroup id="saved" title={t('settings.rules.saved')} note={t('settings.rules.saved.note')} empty={t('settings.rules.empty.saved')}>
            {rules.savedAllow.map((r) => (
              <AllowRow key={r.rule} entry={r} onRemove={() => remove(r.rule)} removing={removing === r.rule} />
            ))}
          </RuleGroup>
          <RuleGroup id="denied" title={t('settings.rules.denied')} note={t('settings.rules.denied.note')} empty={t('settings.rules.empty.denied')}>
            {rules.deny.map((r) => (
              <DenyRow key={`${r.source}|${r.rule}`} entry={r} />
            ))}
          </RuleGroup>
        </>
      )}
    </>
  );
}

function RuleGroup({ id, title, note, empty, children }: { id: string; title: string; note: string; empty: string; children: React.ReactNode[] }) {
  return (
    <section className="settings-group" aria-labelledby={`rules-${id}`}>
      <h4 className="setting-label" id={`rules-${id}`}>
        {title}
      </h4>
      <p className="setting-note muted">{note}</p>
      {children.length === 0 ? <p className="rule-empty muted">{empty}</p> : <ul className="rule-list">{children}</ul>}
    </section>
  );
}

function AllowRow({ entry, onRemove, removing }: { entry: AllowRuleEntry; onRemove?: () => void; removing?: boolean }) {
  return (
    <li className="rule-row">
      <code className="rule-text">{entry.rule}</code>
      {entry.dropped && <span className="rule-chip">{t('settings.rules.dropped')}</span>}
      {onRemove && (
        <Button small variant="quiet" loading={removing} aria-label={t('settings.rules.removeLabel', { rule: entry.rule })} onClick={onRemove}>
          {t('settings.rules.remove')}
        </Button>
      )}
    </li>
  );
}

function DenyRow({ entry }: { entry: DenyRuleEntry }) {
  return (
    <li className="rule-row">
      <code className="rule-text">{entry.rule}</code>
      <span className="rule-source muted">{t(`settings.rules.source.${entry.source}`)}</span>
    </li>
  );
}
