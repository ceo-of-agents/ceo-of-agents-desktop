import { useState } from 'react';
import type { Initiative } from '../shared/types';
import { t } from '../shared/strings';
import { api } from './api';
import { ClampText } from './ClampText';
import { daysSince, isStale } from './initiative-logic';
import { shortDate } from './logic';
import { InlineMarkdown } from './Markdown';
import { stripMarkdown } from './markdown-safety';
import { dayLabel } from './panel-logic';
import { Button } from './ui/Button';
import { Fold } from './ui/Fold';
import { Tooltip } from './ui/Tooltip';

type Ask = 'close' | 'abandon' | 'update';

const CONFIRM_KEY: Record<Ask, string> = {
  close: 'initiatives.confirm.close',
  abandon: 'initiatives.confirm.abandon',
  update: 'initiatives.confirm.update',
};
const MESSAGE_KEY: Record<Ask, string> = {
  close: 'cos.msg.closeInitiative',
  abandon: 'cos.msg.abandonInitiative',
  update: 'cos.msg.updateInitiative',
};

/**
 * One initiative of the side panel: the title (a button that opens the status page), its goal on one line, its state and next step
 * (2 lines, "Show more"), the update date, and Close / Abandon / "Ask for an update" with the same confirm before anything is sent.
 * Plain props, so it does not depend on the panel's private context.
 */
export function InitiativeCard({ i, orgId, cosName, expanded, onToggleExpanded, onOpen, now }: {
  i: Initiative;
  orgId: string;
  cosName: string;
  expanded: boolean;
  onToggleExpanded(): void;
  onOpen(): void;
  /** For tests and shots; the current time otherwise. */
  now?: Date;
}) {
  const [ask, setAsk] = useState<Ask>('close');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const open = i.state === 'active' || i.state === 'paused';
  const days = isStale(i, now) ? daysSince(i.updated, now) : null;
  const send = () => {
    void api().send(orgId, 'cos', t(MESSAGE_KEY[ask], { title: i.title, slug: i.slug, date: i.updated ?? '' }));
    setConfirmOpen(false);
  };
  const choose = (kind: Ask) => {
    setAsk(kind);
    setConfirmOpen(true);
  };
  const prose = [i.stateText, i.nextStep ? t('initiatives.next', { step: i.nextStep }) : ''].filter(Boolean);
  return (
    <div className={`item initiative${confirmOpen ? ' confirming' : ''}`}>
      <div className="item-title">
        <button className="i-title" onClick={onOpen}>
          <InlineMarkdown text={i.title} noLinks />
        </button>
      </div>
      {i.goal && (
        <Tooltip label={stripMarkdown(i.goal)}>
          <div className="i-goal muted small">
            <InlineMarkdown text={i.goal} noLinks />
          </div>
        </Tooltip>
      )}
      {(i.updated || open) && (
        <div className="i-meta">
          <span className="muted small">{i.updated ? t('initiatives.updated', { date: dayLabel(i.updated) || shortDate(i.updated) }) : ''}</span>
          {open && (
            <span className="i-actions">
              <Button small onClick={() => choose('close')}>{t('initiatives.close')}</Button>
              <Button small onClick={() => choose('abandon')}>{t('initiatives.abandon')}</Button>
            </span>
          )}
        </div>
      )}
      {days !== null && (
        <div className="i-stale">
          <span className="i-stale-text">{t('initiatives.stale', { days })}</span>
          <Button small variant="quiet" onClick={() => choose('update')}>{t('initiatives.askUpdate', { cosName })}</Button>
        </div>
      )}
      {prose.length > 0 && (
        <ClampText open={expanded} onToggle={onToggleExpanded} lines={2} text={prose.join(' ')} className="muted small">
          {prose.map((p, n) => (
            <span key={n}>
              {n > 0 && ' '}
              <InlineMarkdown text={p} />
            </span>
          ))}
        </ClampText>
      )}
      <Fold open={confirmOpen}>
        <div className="confirm">
          <span className="small">{t(CONFIRM_KEY[ask], { cosName, title: stripMarkdown(i.title) })}</span>
          <div className="row">
            <Button small variant="primary" onClick={send}>{t('initiatives.confirm.yes')}</Button>
            <Button small variant="quiet" onClick={() => setConfirmOpen(false)}>{t('initiatives.confirm.no')}</Button>
          </div>
        </div>
      </Fold>
    </div>
  );
}
