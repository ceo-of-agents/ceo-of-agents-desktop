import { useEffect, useRef, useState } from 'react';
import type { VoiceInfo } from '../shared/types';
import { t } from '../shared/strings';
import { MAX_VOICE_NAME, type VoiceEntry, type VoiceModel } from '../shared/voice';
import { api } from './api';
import { ipcReason } from './logic';
import { stripMarkdown } from './markdown-safety';
import { type SectionProps } from './settings-logic';
import { initialModel, localDate, voiceSaveText } from './voice-logic';
import { Button } from './ui/Button';

/** An error line for a voice file that could not be read. */
function loadError(info: VoiceInfo): string | null {
  if (!info.error) return null;
  if (info.error === 'tooLarge') return t('voice.error.tooLarge');
  if (info.error === 'invalidPath') return t('voice.error.invalidPath');
  if (info.error === 'notMarkdown') return t('voice.error.notMarkdown');
  return t('voice.error.load', { reason: info.error });
}

/**
 * "Your voice (drafts under your name)": the CEO's voice file in the hq (plugin schema `voice/1`) as three sections, Base,
 * Channels and Audiences. It loads the file named by `ceo.voice` of org.yaml (default `company/ceo-voice.md`) and writes
 * it back keeping everything it does not edit (the "How to use this file" block, comments, other sections). The app
 * never commits or pushes it: the chief of staff saves it with the next hq changes. With no file it starts from the
 * plugin's template.
 */
export function SettingsVoice({ orgId, cosName }: SectionProps) {
  const [info, setInfo] = useState<VoiceInfo | null>(null);
  const [model, setModel] = useState<VoiceModel | null>(null);
  const [saved, setSaved] = useState<VoiceModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [conflict, setConflict] = useState(false);
  const seq = useRef(0);

  const load = async (keepNotice = false) => {
    const mine = ++seq.current;
    try {
      const r = await api().getVoice(orgId);
      if (mine !== seq.current) return;
      const m = initialModel(r, localDate());
      setInfo(r);
      setModel(m);
      setSaved(m);
      if (!keepNotice) {
        setError('');
        setDone(false);
        setConflict(false);
      }
    } catch (e) {
      if (mine === seq.current) setError(t('voice.error.load', { reason: ipcReason(e) }));
    }
  };
  useEffect(() => {
    setInfo(null);
    setModel(null);
    void load();
    const token = seq;
    return () => {
      token.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  if (!info || !model || !saved) return error ? <p className="org-icon-msg error" role="alert">{error}</p> : <p className="muted">{t('voice.loading')}</p>;

  const blocked = !!info.error;
  const dirty = JSON.stringify(model) !== JSON.stringify(saved);
  const change = (patch: Partial<VoiceModel>) => {
    setModel({ ...model, ...patch });
    setDone(false);
  };
  const save = async () => {
    const text = voiceSaveText(info, model, localDate());
    if (text === null) return;
    setBusy(true);
    setError('');
    setConflict(false);
    try {
      const r = await api().saveVoice(orgId, text, info.version);
      if (r.ok) {
        setDone(true);
        await load(true);
      } else {
        setError(t(`voice.error.${r.error}`));
        setConflict(r.error === 'conflict');
      }
    } catch {
      setError(t('voice.error.writeFailed'));
    } finally {
      setBusy(false);
    }
  };
  const loadFailure = loadError(info);
  return (
    <div className="voice-editor">
      <h4 className="setting-label">{t('voice.title')}</h4>
      <p className="setting-note muted">{t('voice.intro', { cosName: stripMarkdown(cosName) })}</p>
      <p className="setting-note muted">
        {t('voice.path', { path: info.path })}
        {!info.exists && !blocked ? ` ${t('voice.new')}` : ''}
      </p>
      {loadFailure && (
        <p className="org-icon-msg error" role="alert">
          {loadFailure}
        </p>
      )}
      <div className="settings-group">
        <label className="setting-label" htmlFor="voice-base">
          {t('voice.base')}
        </label>
        <p className="setting-note muted">{t('voice.base.hint')}</p>
        <textarea id="voice-base" className="input voice-text" rows={5} disabled={blocked} value={model.base} placeholder={t('voice.base.placeholder')} onChange={(e) => change({ base: e.target.value })} />
      </div>
      <EntryGroup kind="channels" entries={model.channels} disabled={blocked} onChange={(channels) => change({ channels })} />
      <EntryGroup kind="audiences" entries={model.audiences} disabled={blocked} onChange={(audiences) => change({ audiences })} />
      <p className="setting-note muted">{t('voice.privacy')}</p>
      <div className="row voice-actions">
        <Button variant="primary" loading={busy} disabled={blocked || !dirty} onClick={() => void save()}>
          {t('voice.save')}
        </Button>
        {dirty && !busy && <span className="muted small">{t('voice.unsaved')}</span>}
      </div>
      {done && !dirty && (
        <p className="org-icon-msg muted" role="status">
          {t('voice.saved', { path: info.path })}
        </p>
      )}
      {error && (
        <p className="org-icon-msg error" role="alert">
          {error}
        </p>
      )}
      {conflict && (
        <div>
          <Button small onClick={() => void load()}>
            {t('voice.reload')}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Channels or Audiences: one block per entry (a name and its text), with add and remove. */
function EntryGroup({ kind, entries, disabled, onChange }: { kind: 'channels' | 'audiences'; entries: VoiceEntry[]; disabled: boolean; onChange(entries: VoiceEntry[]): void }) {
  const set = (i: number, patch: Partial<VoiceEntry>) => onChange(entries.map((e, k) => (k === i ? { ...e, ...patch } : e)));
  return (
    <div className="settings-group">
      <span className="setting-label">{t(`voice.${kind}`)}</span>
      <p className="setting-note muted">{t(`voice.${kind}.hint`)}</p>
      {entries.map((e, i) => (
        <div className="voice-entry" key={e.orig ?? `new${i}`}>
          <div className="row voice-entry-head">
            <input
              className="input"
              type="text"
              aria-label={t(`voice.${kind}.name`)}
              maxLength={MAX_VOICE_NAME}
              disabled={disabled}
              value={e.name}
              onChange={(ev) => set(i, { name: ev.target.value })}
            />
            <Button small disabled={disabled} aria-label={t('voice.remove', { name: e.name })} onClick={() => onChange(entries.filter((_, k) => k !== i))}>
              {t('voice.removeShort')}
            </Button>
          </div>
          <textarea
            className="input voice-text"
            rows={4}
            aria-label={e.name}
            disabled={disabled}
            value={e.text}
            placeholder={t(`voice.${kind}.placeholder`)}
            onChange={(ev) => set(i, { text: ev.target.value })}
          />
        </div>
      ))}
      <div>
        <Button small disabled={disabled} onClick={() => onChange([...entries, { name: '', text: '' }])}>
          {t(`voice.${kind}.add`)}
        </Button>
      </div>
    </div>
  );
}
