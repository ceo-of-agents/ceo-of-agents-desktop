import { t } from '../shared/strings';
import { Button } from './ui/Button';

/**
 * Inline confirm before switching an org to Auto mode (composer footer and Settings). Auto mode applies to every chat of
 * the org and to Claude Code in a terminal in that hq, and runs commands without asking, so the switch is never one click.
 * Cancel has the focus; Escape cancels.
 */
export function AutoModeConfirm({ onConfirm, onCancel }: { onConfirm(): void; onCancel(): void }) {
  return (
    <div
      className="auto-confirm"
      role="group"
      aria-label={t('settings.mode.auto')}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <p className="auto-confirm-text">{t('settings.mode.auto.confirm')}</p>
      <div className="auto-confirm-actions">
        {/* The safe choice takes the focus when the confirm opens. */}
        <Button small variant="quiet" autoFocus onClick={onCancel}>
          {t('settings.mode.auto.confirmNo')}
        </Button>
        <Button small variant="primary" onClick={onConfirm}>
          {t('settings.mode.auto.confirmYes')}
        </Button>
      </div>
    </div>
  );
}
