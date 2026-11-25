import { t } from '../shared/strings';
import type { CloseChoice } from './logic';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';

interface BodyProps {
  persona: string;
  cosName: string;
  /** A turn is running: closing stops it. */
  busy: boolean;
  onChoose(choice: CloseChoice): void;
}

/** The dialog's content. "Hand over" is first, so it takes the initial focus (the modal focuses its first control). */
export function CloseChatBody({ persona, cosName, busy, onChoose }: BodyProps) {
  return (
    <>
      <h2>{t('tab.closeDialog.title', { persona })}</h2>
      <p id="close-chat-text">
        {t('tab.closeDialog.text', { persona, cosName })}
        {busy && ` ${t('tab.closeDialog.busy')}`}
      </p>
      <div className="row end close-chat-actions">
        <Button variant="primary" onClick={() => onChoose('handover')}>
          {t('tab.closeDialog.handOver', { cosName })}
        </Button>
        <Button onClick={() => onChoose('close')}>{t('tab.closeDialog.withoutHandover')}</Button>
        <Button variant="quiet" onClick={() => onChoose('cancel')}>
          {t('tab.closeDialog.cancel')}
        </Button>
      </div>
    </>
  );
}

/**
 * Asked when the user closes a department chat that has not handed over (the x and Cmd+W). Escape, a click outside and
 * Cancel all cancel; focus starts on "Hand over".
 */
export function CloseChatDialog({ open, ...body }: BodyProps & { open: boolean }) {
  return (
    <Modal open={open} onClose={() => body.onChoose('cancel')} label={t('tab.closeDialog.title', { persona: body.persona })} role="alertdialog" describedBy="close-chat-text">
      <CloseChatBody {...body} />
    </Modal>
  );
}
