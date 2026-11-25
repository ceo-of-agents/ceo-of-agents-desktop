import { t } from '../shared/strings';
import type { SectionProps } from './settings-logic';
import { Button } from './ui/Button';

/** The persistent "when it applies" line, and "Apply now" while a change waits. */
export function ApplyNote({ orgName, pending, applying, onApply }: Pick<SectionProps, 'orgName' | 'pending' | 'applying' | 'onApply'>) {
  return (
    <div className="settings-apply">
      <p className="muted small">
        {t('settings.appliesNote', { org: orgName })}
        {pending && ` ${t('settings.applyNote')}`}
      </p>
      {pending && (
        <Button variant="primary" small loading={applying} loadingLabel={t('settings.applying')} onClick={onApply}>
          {t('settings.apply')}
        </Button>
      )}
    </div>
  );
}
