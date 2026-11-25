import { useEffect, useState } from 'react';
import type { AboutInfo } from '../shared/types';
import { t } from '../shared/strings';
import { api } from './api';
import { ipcReason } from './logic';
import { aboutRows, type SectionProps } from './settings-logic';

/** Versions of the app, Claude Code, the plugin and the org, for the selected org. Read-only. */
export function SettingsAbout({ orgId }: SectionProps) {
  const [about, setAbout] = useState<AboutInfo | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setAbout(null);
    setFailed(null);
    api()
      .getAbout(orgId)
      .then((a) => live && setAbout(a))
      .catch((e: unknown) => live && setFailed(ipcReason(e)));
    return () => {
      live = false;
    };
  }, [orgId]);
  if (failed) return <p className="error-text">{failed}</p>;
  if (!about) return <p className="muted">{t('settings.about.loading')}</p>;
  return (
    <>
      <p className="muted small">{t('settings.about.note')}</p>
      <dl className="settings-group about-list">
        {aboutRows(about).map((r) => (
          <div className="about-row" key={r.key}>
            <dt className="setting-label">{r.label}</dt>
            <dd className={`about-value${r.known ? '' : ' muted'}${r.known && r.mono ? ' mono' : ''}`}>{r.value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
