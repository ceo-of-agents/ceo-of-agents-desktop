import { useEffect, useRef, useState } from 'react';
import type { ConnectorDepartment, ConnectorsInfo, LoadedConnector } from '../shared/types';
import { t } from '../shared/strings';
import { api } from './api';
import { ipcReason } from './logic';
import { cleanReason, connectorChips, grantMessage, offerable, REASON_MAX, removeMessage, sentNote, sourceLabel, statusLabel, type SectionProps } from './settings-logic';
import { stripMarkdown } from './markdown-safety';
import { ChevronRight } from './icons';
import { Button } from './ui/Button';

/**
 * Connectors of one org: what each department is granted (org.yaml), the forbidden ones and what this hq offers, read only.
 * Granting or removing is a message to the chief of staff, who prepares a decision card; the app never writes a grant.
 * It also lists what the org's chats loaded (from the init message of their processes) and what is kept from starting.
 * It loads on open, on an org switch and when an `org-chart` event (org.yaml or an agent file changed) or a `connectors`
 * event (a chat reported another list) of its org arrives. Every value shown is React text: server names are untrusted.
 */
export function SettingsConnectors({ orgId, orgName, activeOrgId, cosName }: SectionProps) {
  const [info, setInfo] = useState<ConnectorsInfo | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    let live = true;
    const load = () => {
      const mine = ++seq.current;
      api()
        .getConnectors(orgId)
        .then((r) => {
          if (live && mine === seq.current) {
            setInfo(r);
            setFailed(null);
          }
        })
        .catch((e: unknown) => live && mine === seq.current && setFailed(ipcReason(e)));
    };
    setInfo(null);
    setFailed(null);
    load();
    const off = api().onEvent((e) => {
      if ((e.type === 'org-chart' || e.type === 'connectors') && e.orgId === orgId) load();
    });
    return () => {
      live = false;
      off();
    };
  }, [orgId]);

  return (
    <>
      <div className="settings-notes">
        <p className="setting-note muted">{t('settings.connectors.note.cards', { cosName })}</p>
        <p className="setting-note muted">{t('settings.connectors.note.scope')}</p>
      </div>
      {failed ? (
        <div className="settings-group">
          <p className="error-text">{t('settings.connectors.failed', { reason: failed })}</p>
        </div>
      ) : !info ? (
        <div className="settings-group">
          <p className="muted">{t('settings.connectors.loading')}</p>
        </div>
      ) : (
        <>
          {info.error && (
            <div className="settings-group">
              <p className="error-text">{t('settings.connectors.readError', { reason: info.error })}</p>
            </div>
          )}
          {info.session.mcpLocked && (
            <div className="settings-group">
              <p className="error-text" role="status">
                {t('settings.connectors.locked')}
              </p>
            </div>
          )}
          <section className="settings-group" aria-labelledby="conn-session">
            <h4 className="setting-label" id="conn-session">
              {t('settings.connectors.session')}
            </h4>
            <p className="setting-note muted">{t('settings.connectors.note.chats')}</p>
            {!info.session.started ? (
              <p className="rule-empty muted">{t('settings.connectors.session.notStarted')}</p>
            ) : info.session.loaded.length === 0 ? (
              <p className="rule-empty muted">{t('settings.connectors.session.none')}</p>
            ) : (
              <ul className="rule-list">
                {info.session.loaded.map((c) => (
                  <LoadedRow key={c.name} c={c} />
                ))}
              </ul>
            )}
            <h5 className="setting-sublabel">{t('settings.connectors.keptOut')}</h5>
            <p className="setting-note muted">{t('settings.connectors.keptOut.note')}</p>
            {info.session.keptOut.length === 0 && !info.session.claudeAiOff && <p className="rule-empty muted">{t('settings.connectors.keptOut.none')}</p>}
            {info.session.keptOut.length > 0 && <PatternList items={info.session.keptOut} empty="" />}
            {info.session.claudeAiOff && <p className="setting-note">{t('settings.connectors.claudeAiOff')}</p>}
          </section>
          <section className="settings-group" aria-labelledby="conn-departments">
            <h4 className="setting-label" id="conn-departments">
              {t('settings.connectors.departments')}
            </h4>
            {info.departments.length === 0 ? (
              <p className="rule-empty muted">{t('settings.connectors.noDepartments')}</p>
            ) : (
              <div className="conn-depts">
                {info.departments.map((d, i) => (
                  <DepartmentBlock key={`${i}|${d.id}`} orgId={orgId} orgName={orgName} activeOrgId={activeOrgId} cosName={cosName} dept={d} info={info} />
                ))}
              </div>
            )}
          </section>
          <section className="settings-group" aria-labelledby="conn-forbidden">
            <h4 className="setting-label" id="conn-forbidden">
              {t('settings.connectors.forbidden')}
            </h4>
            <p className="setting-note muted">{t('settings.connectors.forbidden.note')}</p>
            <PatternList items={info.forbidden} empty={t('settings.connectors.forbidden.none')} />
            <h5 className="setting-sublabel">{t('settings.connectors.forbidden.local')}</h5>
            <PatternList items={info.forbiddenLocal} empty={t('settings.connectors.forbidden.none')} />
            {info.forbiddenProblems.map((p, i) => (
              <p key={`${i}|${p}`} className="error-text">
                {t('settings.connectors.forbidden.problem', { reason: p })}
              </p>
            ))}
            {info.forbiddenWarnings.length > 0 && <h5 className="setting-sublabel">{t('settings.connectors.forbidden.warnings')}</h5>}
            {info.forbiddenWarnings.map((w, i) => (
              <p key={`${i}|${w}`} className="setting-note">
                {w}
              </p>
            ))}
          </section>
          <section className="settings-group" aria-labelledby="conn-available">
            <h4 className="setting-label" id="conn-available">
              {t('settings.connectors.available')}
            </h4>
            <p className="setting-note muted">{t('settings.connectors.available.note')}</p>
            <PatternList items={info.available.map((a) => a.pattern)} empty={t('settings.connectors.available.none')} />
            {info.notGrantable.length > 0 && <p className="setting-note muted">{t('settings.connectors.notGrantable', { names: info.notGrantable.join(', ') })}</p>}
          </section>
        </>
      )}
    </>
  );
}

/** One loaded connector: name, source, status, the chats that loaded it and how the deny rules cut it. */
function LoadedRow({ c }: { c: LoadedConnector }) {
  const source = sourceLabel(c.source);
  return (
    <li className="rule-row conn-loaded">
      <div className="conn-loaded-main">
        <span className="conn-loaded-name">
          <code className="rule-text">{c.name}</code>
          <span className={`rule-chip${c.status === 'failed' || c.status === 'needs-auth' ? ' conn-bad' : ''}`}>{statusLabel(c.status)}</span>
          {c.block && (
            <span className="rule-chip conn-blocked">
              {t(c.block.kind === 'all' ? 'settings.connectors.block.all' : 'settings.connectors.block.some')}
            </span>
          )}
        </span>
        <span className="setting-note muted">
          {source ? `${t('settings.connectors.session.source', { source })} · ` : ''}
          {t('settings.connectors.session.chats', { chats: c.chats.join(', ') })}
        </span>
        {c.block && <span className="setting-note muted">{t('settings.connectors.block.rule', { rule: c.block.rule })}</span>}
      </div>
    </li>
  );
}

function PatternList({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <p className="rule-empty muted">{empty}</p>;
  return (
    <ul className="rule-list">
      {items.map((p) => (
        <li key={p} className="rule-row">
          <code className="rule-text">{p}</code>
        </li>
      ))}
    </ul>
  );
}

type Outcome = { kind: 'sent' } | { kind: 'error'; text: string } | null;

/** One department: its connectors as chips (each with "Request removal"), the advisory note and the request form. */
function DepartmentBlock({ orgId, orgName, activeOrgId, cosName, dept, info }: { orgId: string; orgName: string; activeOrgId: string | null; cosName: string; dept: ConnectorDepartment; info: ConnectorsInfo }) {
  const chips = connectorChips(dept);
  const options = offerable(info.available, dept);
  const [form, setForm] = useState<{ pattern: string; reason: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const name = stripMarkdown(dept.displayName);

  const send = (text: string, key: string, done?: () => void) => {
    setBusy(key);
    setOutcome(null);
    api()
      .send(orgId, 'cos', text)
      .then(() => {
        setOutcome({ kind: 'sent' });
        done?.();
      })
      .catch((e: unknown) => setOutcome({ kind: 'error', text: t('settings.connectors.sendFailed', { reason: ipcReason(e) }) }))
      .finally(() => setBusy(null));
  };

  const open = () => {
    setOutcome(null);
    setForm({ pattern: options[0]?.pattern ?? '', reason: '' });
  };
  const reason = form ? cleanReason(form.reason) : '';
  // The offered list can change under an open form (a refetch): never send a pattern that is no longer offered.
  const pattern = form && options.some((o) => o.pattern === form.pattern) ? form.pattern : (options[0]?.pattern ?? '');

  return (
    <div className="conn-dept" role="group" aria-label={name}>
      <div className="conn-head">
        <span className="conn-name">{name}</span>
        <span className="muted conn-agent">{t('settings.connectors.agentLine', { agent: dept.agent })}</span>
        {dept.mcpLock !== null && <span className="conn-lock">{t('settings.connectors.deptLocked')}</span>}
      </div>
      {dept.advisory && <p className="setting-note muted">{t('settings.connectors.advisory')}</p>}
      {dept.mcpLock !== null && <p className="setting-note">{t(dept.mcpLock === 'all-tools' ? 'settings.connectors.lockedAllTools' : 'settings.connectors.lockedNoToolsLine')}</p>}
      {chips.length === 0 ? (
        <p className="rule-empty muted">{t('settings.connectors.none')}</p>
      ) : (
        <ul className="rule-list">
          {chips.map((c) => (
            <li key={c.pattern} className="rule-row">
              <code className="rule-text">{c.pattern}</code>
              {c.notInAgentFile && <span className="rule-source muted">{t('settings.connectors.notInAgentFile')}</span>}
              {c.notInOrgYaml && <span className="rule-source muted">{t('settings.connectors.notInOrgYaml')}</span>}
              <Button
                small
                variant="quiet"
                loading={busy === `remove|${c.pattern}`}
                disabled={busy !== null}
                aria-label={t('settings.connectors.removeRequestLabel', { pattern: c.pattern, department: name })}
                onClick={() => send(removeMessage(dept, c.pattern), `remove|${c.pattern}`)}
              >
                {t('settings.connectors.removeRequest')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {form ? (
        options.length === 0 ? (
          <div className="conn-form">
            <p className="setting-note muted">{t('settings.connectors.form.none')}</p>
            <div className="conn-actions">
              <Button small variant="quiet" onClick={() => setForm(null)}>
                {t('settings.connectors.form.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="conn-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (reason && busy === null) send(grantMessage(dept, pattern, reason), 'grant', () => setForm(null));
            }}
          >
            <label className="conn-field">
              <span className="setting-note muted">{t('settings.connectors.form.pattern')}</span>
              <span className="select-wrap">
                <select className="input mono-input" value={pattern} onChange={(e) => setForm({ ...form, pattern: e.target.value })}>
                  {options.map((o) => (
                    <option key={o.pattern} value={o.pattern}>
                      {o.pattern}
                    </option>
                  ))}
                </select>
                <ChevronRight size={12} className="select-chev" />
              </span>
            </label>
            <label className="conn-field">
              <span className="setting-note muted">{t('settings.connectors.form.reason')}</span>
              <input
                className="input"
                type="text"
                maxLength={REASON_MAX}
                value={form.reason}
                placeholder={t('settings.connectors.form.reasonPlaceholder', { department: name })}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                autoFocus
              />
            </label>
            <div className="conn-actions">
              <Button small variant="primary" type="submit" disabled={!reason} loading={busy === 'grant'} loadingLabel={t('settings.connectors.form.sending')}>
                {t('settings.connectors.form.send', { cosName })}
              </Button>
              <Button small variant="quiet" type="button" disabled={busy === 'grant'} onClick={() => setForm(null)}>
                {t('settings.connectors.form.cancel')}
              </Button>
            </div>
          </form>
        )
      ) : (
        <div className="conn-actions">
          <Button small variant="quiet" disabled={busy !== null} onClick={open}>
            {t('settings.connectors.request')}
          </Button>
        </div>
      )}
      {outcome?.kind === 'sent' && (
        <p className="setting-note muted" role="status">
          {sentNote({ cosName, orgName, orgId, activeOrgId })}
        </p>
      )}
      {outcome?.kind === 'error' && (
        <p className="error-text" role="alert">
          {outcome.text}
        </p>
      )}
    </div>
  );
}
