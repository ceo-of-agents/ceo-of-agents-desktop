import { useEffect, useState } from 'react';
import type { VoiceInfo } from '../shared/types';
import { t } from '../shared/strings';
import { buildDraftPrompt, MAX_DRAFT_MESSAGE, MAX_VOICE_NAME, type DraftResult } from '../shared/voice';
import { api } from './api';
import { ChevronRight } from './icons';
import { choiceValue, draftOptions, OTHER } from './voice-logic';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';

interface BodyProps {
  /** The chat's speaker, for the note ("Ada writes the draft..."). */
  name: string;
  /** The chat is the chief of staff's. */
  isCos: boolean;
  orgId: string;
  /** Sends the message to this same chat. */
  onSubmit(text: string): void;
  onCancel(): void;
}

/** A channel or audience: a list of the names in the voice file with "Not set" and "Other…", or only a text box when the file has none. */
function ChoiceField({ id, label, names, select, typed, onSelect, onTyped }: { id: string; label: string; names: string[]; select: string; typed: string; onSelect(v: string): void; onTyped(v: string): void }) {
  const free = names.length === 0 || select === OTHER;
  return (
    <div className="draft-field">
      <label className="setting-label" htmlFor={id}>
        {label}
      </label>
      {names.length > 0 && (
        <span className="select-wrap">
          <select id={id} className="input" value={select} onChange={(e) => onSelect(e.target.value)}>
            <option value="">{t('draft.unset')}</option>
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
            <option value={OTHER}>{t('draft.other')}</option>
          </select>
          <ChevronRight size={12} className="select-chev" />
        </span>
      )}
      {free && <input id={names.length === 0 ? id : undefined} className="input" type="text" maxLength={MAX_VOICE_NAME} aria-label={t('draft.otherName', { what: label.toLowerCase() })} value={typed} onChange={(e) => onTyped(e.target.value)} />}
    </div>
  );
}

/**
 * The Draft form: channel and audience from the voice file (free text when it lists none) and the message
 * to answer. Submitting sends one message to the same chat (`buildDraftPrompt`); the app sends nothing outward.
 */
export function DraftFormBody({ name, isCos, orgId, onSubmit, onCancel }: BodyProps) {
  const [voice, setVoice] = useState<VoiceInfo | null>(null);
  const [channel, setChannel] = useState('');
  const [channelText, setChannelText] = useState('');
  const [audience, setAudience] = useState('');
  const [audienceText, setAudienceText] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    let live = true;
    api()
      .getVoice(orgId)
      .then((v) => live && setVoice(v))
      .catch(() => live && setVoice(null));
    return () => {
      live = false;
    };
  }, [orgId]);
  const opts = draftOptions(voice);
  const ready = message.trim().length > 0;
  const submit = () => {
    if (!ready) return;
    onSubmit(
      buildDraftPrompt({
        channel: choiceValue(opts.channels.length === 0 ? OTHER : channel, channelText),
        audience: choiceValue(opts.audiences.length === 0 ? OTHER : audience, audienceText),
        message,
        isCos,
        voicePath: voice && voice.exists ? voice.path : null,
      }),
    );
  };
  return (
    <form
      className="draft-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h2>{t('draft.title')}</h2>
      <p className="muted" id="draft-note">
        {t('draft.note', { name })}
      </p>
      {voice && !voice.exists && <p className="muted small">{t('draft.noVoice')}</p>}
      <ChoiceField id="draft-channel" label={t('draft.channel')} names={opts.channels} select={channel} typed={channelText} onSelect={setChannel} onTyped={setChannelText} />
      <ChoiceField id="draft-audience" label={t('draft.audience')} names={opts.audiences} select={audience} typed={audienceText} onSelect={setAudience} onTyped={setAudienceText} />
      <div className="draft-field">
        <label className="setting-label" htmlFor="draft-message">
          {t('draft.message')}
        </label>
        <textarea id="draft-message" className="input draft-message" rows={8} maxLength={MAX_DRAFT_MESSAGE} placeholder={t('draft.messagePlaceholder')} value={message} onChange={(e) => setMessage(e.target.value)} autoFocus />
      </div>
      <div className="row end">
        <Button variant="quiet" type="button" onClick={onCancel}>
          {t('draft.cancel')}
        </Button>
        <Button variant="primary" type="submit" disabled={!ready}>
          {t('draft.submit')}
        </Button>
      </div>
    </form>
  );
}

export function DraftForm({ open, ...body }: BodyProps & { open: boolean }) {
  return (
    <Modal open={open} onClose={body.onCancel} label={t('draft.title')} describedBy="draft-note">
      <DraftFormBody {...body} />
    </Modal>
  );
}

/** What a copy button copies for a draft: the whole text, or for mail the subject and the body apart. */
export function copyParts(d: DraftResult): { key: 'all' | 'subject' | 'body'; label: string; text: string }[] {
  if (d.subject === null) return [{ key: 'all', label: t('draft.copy'), text: d.text }];
  return [
    { key: 'subject', label: t('draft.copySubject'), text: d.subject },
    { key: 'body', label: t('draft.copyBody'), text: d.body },
  ];
}

/** Copy buttons under a draft in the chat. Copies exactly the draft text; shows "Copied" for a moment. */
export function DraftCopy({ draft }: { draft: DraftResult }) {
  const [state, setState] = useState<{ key: string; ok: boolean } | null>(null);
  useEffect(() => {
    if (!state) return;
    const id = setTimeout(() => setState(null), 1600);
    return () => clearTimeout(id);
  }, [state]);
  const copy = (key: string, text: string) => {
    navigator.clipboard.writeText(text).then(
      () => setState({ key, ok: true }),
      () => setState({ key, ok: false }),
    );
  };
  return (
    <div className="draft-copy">
      {copyParts(draft).map((p) => (
        <Button key={p.key} small onClick={() => copy(p.key, p.text)}>
          {state?.key === p.key ? t(state.ok ? 'draft.copied' : 'draft.copyFailed') : p.label}
        </Button>
      ))}
    </div>
  );
}
