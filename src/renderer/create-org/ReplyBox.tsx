// The reply box of the run: the wizard's question the app cannot read is answered in words. Enter sends (like the composer, whose hint
// is shown under the box), Shift+Enter makes a new line.
import { useState } from 'react';
import { t } from '../../shared/strings';
import { Button } from '../ui/Button';

export function ReplyBox({ label, onSend }: { label: string; onSend(text: string): void }) {
  const [reply, setReply] = useState('');
  const send = () => {
    const text = reply.trim();
    if (text === '') return;
    setReply('');
    onSend(text);
  };
  return (
    <div className="co-reply">
      <label className="co-label" htmlFor="co-reply">
        {label}
      </label>
      <textarea
        id="co-reply"
        className="co-area"
        rows={3}
        value={reply}
        aria-describedby="co-reply-hint"
        onChange={(e) => setReply(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="co-reply-foot">
        <span className="co-reply-hint" id="co-reply-hint">
          {t('composer.hint')}
        </span>
        <Button onClick={send} disabled={reply.trim() === ''}>
          {t('createOrg.send')}
        </Button>
      </div>
    </div>
  );
}
