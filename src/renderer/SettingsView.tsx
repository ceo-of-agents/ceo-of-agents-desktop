import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent } from 'react';
import type { EffortLevel, OrgId, OrgSummary, SettingsPatch } from '../shared/types';
import { t } from '../shared/strings';
import { ChevronRight, X } from './icons';
import { OrgIconOrInitials } from './OrgIcon';
import { removeOrgIconNotice, setOrgIcon } from './org-icon-actions';
import type { OrgIconNotice } from './settings-logic';
import { modelOptions, modelSourceNote, settingSourceLabel } from './logic';
import { stripMarkdown } from './markdown-safety';
import { SettingsAbout } from './SettingsAbout';
import { ApplyNote } from './SettingsApply';
import { SettingsConnectors } from './SettingsConnectors';
import { SettingsPermissions } from './SettingsPermissions';
import { SettingsVoice } from './SettingsVoice';
import { nextSection, type SectionProps } from './settings-logic';
import { useDismiss, useFocusTrap } from './ui/hooks';
import { Presence } from './ui/Presence';
import { Button } from './ui/Button';

const efforts: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The sections, in order. A new section is one line here: an id, its name and its panel. */
const SECTIONS: { id: string; label: string; Panel: ComponentType<SectionProps> }[] = [
  { id: 'general', label: 'settings.section.general', Panel: SettingsGeneral },
  { id: 'permissions', label: 'settings.section.permissions', Panel: SettingsPermissions },
  { id: 'connectors', label: 'settings.section.connectors', Panel: SettingsConnectors },
  { id: 'voice', label: 'settings.section.voice', Panel: SettingsVoice },
  { id: 'about', label: 'settings.section.about', Panel: SettingsAbout },
];
const SECTION_IDS = SECTIONS.map((s) => s.id);
export const ABOUT_SECTION = 'about';

interface Props {
  open: boolean;
  /** The section to open on (an id from SECTIONS); the first one when missing or unknown. */
  initialSection?: string;
  orgs: OrgSummary[];
  /** The org whose settings the window shows (it opens on the main window's org; switching it never changes the main window's). */
  orgId: OrgId;
  /** The main window's active org, which can differ from `orgId`. */
  activeOrgId: OrgId | null;
  settings: SectionProps['settings'];
  pending: boolean;
  applying: boolean;
  onOrg(orgId: OrgId): void;
  onChange(patch: SettingsPatch): void;
  onApply(): void;
  onSessionChange(): void;
  onError(text: string): void;
  onClose(): void;
}

/**
 * Settings of every org, in a full-window view like Claude desktop's: a side list of sections (and the org switcher) on the
 * left, the section on the right. It replaces the window's content below the 52 px drag strip. Escape and the close button
 * close it, Tab stays inside, focus goes back to where it was.
 */
export function SettingsView({ open, ...rest }: Props) {
  return (
    <Presence present={open} exitMs={120}>
      {(state) => <SettingsBody state={state} {...rest} />}
    </Presence>
  );
}

function SettingsBody({ state, initialSection, orgs, orgId, activeOrgId, settings, pending, applying, onOrg, onChange, onApply, onSessionChange, onError, onClose }: Omit<Props, 'open'> & { state: 'open' | 'closed' }) {
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const open = state === 'open';
  const [section, setSection] = useState(initialSection && SECTION_IDS.includes(initialSection) ? initialSection : SECTION_IDS[0]);
  useFocusTrap(ref, open);
  useDismiss(open, onClose);
  // The trap focuses the first control; the selected section is the better place to start.
  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, [open]);
  const org = orgs.find((o) => o.id === orgId);
  const orgName = stripMarkdown(org?.name ?? '');
  const cosName = stripMarkdown(org?.cosName ?? '') || t('cos.role');
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  const onKey = (e: KeyboardEvent) => {
    const next = nextSection(SECTION_IDS, current.id, e.key);
    if (!next) return;
    e.preventDefault();
    setSection(next);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus());
  };
  const Panel = current.Panel;
  return (
    <div ref={ref} className="settings-view" data-state={state} role="dialog" aria-modal="true" aria-label={t('settings.heading')} tabIndex={-1}>
      <header className="settings-strip">
        <h2>{t('settings.heading')}</h2>
        <button className="icon-btn" aria-label={t('settings.closeView')} onClick={onClose}>
          <X />
        </button>
      </header>
      <div className="settings-body">
        <aside className="settings-side">
          <OrgSwitcher orgs={orgs} orgId={orgId} onChange={onOrg} />
          <div className="settings-tabs" role="tablist" aria-orientation="vertical" aria-label={t('settings.sections')} ref={listRef} onKeyDown={onKey}>
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                id={`settings-tab-${s.id}`}
                role="tab"
                className="settings-tab"
                aria-selected={s.id === current.id}
                aria-controls="settings-panel"
                tabIndex={s.id === current.id ? 0 : -1}
                onClick={() => setSection(s.id)}
              >
                {t(s.label)}
              </button>
            ))}
          </div>
        </aside>
        <div className="settings-scroll">
          <div className="settings-content" id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${current.id}`} key={`${current.id}|${orgId}`}>
            <h3 className="settings-title">{t(current.label)}</h3>
            <Panel orgId={orgId} iconStamp={org?.iconStamp ?? null} orgName={orgName} activeOrgId={activeOrgId} cosName={cosName} settings={settings} pending={pending} applying={applying} onChange={onChange} onApply={onApply} onSessionChange={onSessionChange} onError={onError} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** The org whose settings are shown: its tile (as in the rail, 24 px) and a native select of every registered org. */
function OrgSwitcher({ orgs, orgId, onChange }: { orgs: OrgSummary[]; orgId: OrgId; onChange(id: OrgId): void }) {
  const selected = orgs.find((o) => o.id === orgId);
  return (
    <div className="org-switch">
      <span className="org-tile" aria-hidden="true">
        <OrgIconOrInitials orgId={orgId} iconStamp={selected?.iconStamp} name={stripMarkdown(selected?.name ?? '')} />
      </span>
      <span className="select-wrap">
        <select className="input" aria-label={t('settings.orgSwitcher')} value={orgId} onChange={(e) => onChange(e.target.value)}>
          {orgs.map((o) => (
            <option key={o.id} value={o.id} disabled={!o.available}>
              {o.available ? stripMarkdown(o.name) : t('sidebar.unavailable', { name: stripMarkdown(o.name) })}
            </option>
          ))}
        </select>
        <ChevronRight size={12} className="select-chev" />
      </span>
    </div>
  );
}

/** The org icon row: preview, "Choose image…" and "Remove", and one line about what happened. The file lives in the hq folder; nothing is committed here. */
function OrgIconRow({ orgId, orgName, iconStamp, cosName }: Pick<SectionProps, 'orgId' | 'orgName' | 'iconStamp' | 'cosName'>) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<OrgIconNotice | null>(null);
  const run = async (action: () => Promise<OrgIconNotice | null>) => {
    setBusy(true);
    try {
      const n = await action();
      if (n) setNotice(n);
    } catch {
      setNotice({ kind: 'error', key: 'orgIcon.error.writeFailed' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-group">
      <div className="setting-row">
        <span className="setting-label" id="setting-org-icon-label">
          {t('orgIcon.label')}
        </span>
        <span className="setting-control org-icon-row" role="group" aria-labelledby="setting-org-icon-label">
          <span className="org-icon-preview" aria-hidden="true">
            <OrgIconOrInitials orgId={orgId} iconStamp={iconStamp} name={orgName} />
          </span>
          <Button small disabled={busy} onClick={() => void run(async () => setOrgIcon(orgId))}>
            {t('orgIcon.choose')}
          </Button>
          <Button small disabled={busy || !iconStamp} onClick={() => void run(async () => removeOrgIconNotice(orgId))}>
            {t('orgIcon.remove')}
          </Button>
        </span>
        <p className="setting-note muted">{t('orgIcon.note')}</p>
        {notice && (
          <p className={`org-icon-msg${notice.kind === 'error' ? ' error' : ' muted'}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
            {notice.kind === 'error' ? t(notice.key) : t(notice.kind === 'saved' ? 'orgIcon.saved' : 'orgIcon.removed', { cosName })}
          </p>
        )}
      </div>
    </div>
  );
}

function SettingsGeneral({ orgId, orgName, iconStamp, cosName, settings, pending, applying, onChange, onApply }: SectionProps) {
  const icon = <OrgIconRow orgId={orgId} orgName={orgName} iconStamp={iconStamp} cosName={cosName} />;
  if (!settings) return (
    <>
      {icon}
      <p className="muted">{t('loading')}</p>
    </>
  );
  return (
    <>
      <ApplyNote orgName={orgName} pending={pending} applying={applying} onApply={onApply} />
      {icon}
      <div className="settings-group">
        <div className="setting-row">
          <label className="setting-label" htmlFor="setting-effort">
            {t('settings.effort')}
          </label>
          <span className="select-wrap setting-control">
            <select id="setting-effort" className="input" value={settings.effort} onChange={(e) => onChange({ effort: e.target.value as EffortLevel })}>
              {efforts.map((l) => (
                <option key={l} value={l}>
                  {t(`settings.effort.${l}`)}
                </option>
              ))}
            </select>
            <ChevronRight size={12} className="select-chev" />
          </span>
          <p className="setting-note muted">{settingSourceLabel(settings.effortSource)}. {t('settings.when.chats')}</p>
        </div>
        <div className="setting-row">
          <label className="setting-label" htmlFor="setting-model">
            {t('settings.model')}
          </label>
          <span className="select-wrap setting-control">
            <select id="setting-model" className="input" value={settings.model ?? ''} onChange={(e) => onChange({ model: e.target.value || null })}>
              {modelOptions(settings).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <ChevronRight size={12} className="select-chev" />
          </span>
          <p className="setting-note muted">{modelSourceNote(settings)}. {t('settings.when.chats')}</p>
        </div>
        <div className="setting-row">
          <label className="setting-label" htmlFor="setting-new-session">
            {t('settings.newSessionAfter')}
          </label>
          <span className="select-wrap setting-control">
            <select id="setting-new-session" className="input" value={settings.newSessionAfterMinutes} onChange={(e) => onChange({ newSessionAfterMinutes: Number(e.target.value) })}>
              {[15, 30, 60, 120, 240, 0].map((m) => (
                <option key={m} value={m}>
                  {t(`settings.newSessionAfter.${m}`)}
                </option>
              ))}
            </select>
            <ChevronRight size={12} className="select-chev" />
          </span>
          <p className="setting-note muted">{t('settings.source.autoPush')}. {t('settings.when.now')}</p>
        </div>
        <div className="setting-row">
          <label className="setting-label" htmlFor="setting-renew-session">
            {t('settings.renewSessionAt')}
          </label>
          <span className="select-wrap setting-control">
            <select id="setting-renew-session" className="input" value={settings.renewSessionAtTokens} onChange={(e) => onChange({ renewSessionAtTokens: Number(e.target.value) })}>
              {[50000, 100000, 150000, 200000, 400000, 0].map((n) => (
                <option key={n} value={n}>
                  {t(`settings.renewSessionAt.${n}`)}
                </option>
              ))}
            </select>
            <ChevronRight size={12} className="select-chev" />
          </span>
          <p className="setting-note muted">{t('settings.source.autoPush')}. {t('settings.when.now')}</p>
        </div>
        <div className="setting-row">
          <label className="setting-label" htmlFor="setting-autopush">
            {t('settings.autoPush')}
          </label>
          <span className="setting-control setting-check">
            <input id="setting-autopush" type="checkbox" checked={settings.autoPush} onChange={(e) => onChange({ autoPush: e.target.checked })} />
          </span>
          <p className="setting-note muted">{t('settings.source.autoPush')}. {t('settings.when.now')}</p>
        </div>
        <div className="setting-row">
          <label className="setting-label" htmlFor="setting-tips">
            {t('settings.tips')}
          </label>
          <span className="setting-control setting-check">
            <input id="setting-tips" type="checkbox" checked={settings.tips} onChange={(e) => onChange({ tips: e.target.checked })} />
          </span>
          <p className="setting-note muted">{t('settings.tips.hint')}. {t('settings.when.now')}</p>
        </div>
      </div>
    </>
  );
}
