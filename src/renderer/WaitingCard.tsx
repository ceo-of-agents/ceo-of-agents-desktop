import { useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { WaitingItem } from '../shared/types';
import { t, tn } from '../shared/strings';
import { ClampText } from './ClampText';
import { ChevronRight } from './icons';
import { ageText } from './logic';
import { InlineMarkdown } from './Markdown';
import { stripMarkdown } from './markdown-safety';
import { hasLongOption, pendingLabelKeyOf, sinceLabel, waitingActionSpecs, waitingKindKey, type ActionSpec } from './panel-logic';
import { pendingStore, type Pending } from './pending-send';
import { startWaitingAction } from './waiting-actions';
import { Button } from './ui/Button';
import { Fold } from './ui/Fold';
import { Spinner } from './ui/Spinner';
import { Tooltip } from './ui/Tooltip';

interface Props {
  item: WaitingItem;
  orgId: string;
  cosName: string;
  expanded: boolean;
  onToggleExpanded(): void;
  /** The card is on its way out (the item left the list): it keeps its last look while it collapses. */
  leaving: boolean;
  onAnswer(code: string | null, text?: string): void;
  /** A parent with children (plugin "Parent and child items"): how many, whether they are shown, the toggle and the child cards. A card without them is a plain item. */
  group?: { count: number; open: boolean; onToggle(): void; children: ReactNode };
}

/** `asText`: some option label is long, so the labels are listed as text and each button reads "Option a" (no label is ever only in a tooltip). */
function ActionButton({ spec, onClick, asText }: { spec: ActionSpec; onClick(): void; asText: boolean }) {
  if (spec.id !== 'option') {
    const key = spec.id === 'decline' ? 'waiting.decline' : spec.id === 'reply' ? 'waiting.reply' : spec.id === 'answer' ? 'waiting.answer' : spec.id === 'done' ? 'waiting.done' : 'waiting.approve';
    return <Button small variant={spec.variant} onClick={onClick}>{t(key)}</Button>;
  }
  const ariaLabel = t('waiting.option', { key: spec.optionKey ?? '', label: stripMarkdown(spec.optionLabel ?? '') });
  if (asText) {
    return <Button small variant="you-outline" aria-label={ariaLabel} onClick={onClick}>{t('waiting.option.pick', { key: spec.optionKey ?? '' })}</Button>;
  }
  return (
    <Button small variant="you-outline" className="option" aria-label={ariaLabel} onClick={onClick}>
      <span className="option-text" aria-hidden="true">
        {spec.optionKey} · <InlineMarkdown text={spec.optionLabel ?? ''} noLinks />
      </span>
    </Button>
  );
}

/** One waiting item (5.9): what it asks (kind chip), how urgent and old it is, its text, and the actions of its kind. */
export function WaitingCard({ item, orgId, cosName, expanded, onToggleExpanded, leaving, onAnswer, group }: Props) {
  const live = useSyncExternalStore(pendingStore.subscribe, () => pendingStore.get(orgId, item.code), () => undefined);
  // While the card collapses out, the item is gone and so is its pending state: keep the last one it showed.
  const last = useRef<Pending | undefined>();
  if (live) last.current = live;
  const pending = live ?? (leaving ? last.current : undefined);
  const [more, setMore] = useState(false);
  const untagged = item.action === null;
  // A `{wait}` group heading asks nothing: no buttons, no violet bar.
  const heading = item.action === 'wait';
  const { visible, more: rest } = waitingActionSpecs(item);
  const optionsAsText = hasLongOption(item);
  const kindKey = waitingKindKey(item);
  const age = ageText(item.since);
  const since = sinceLabel(item.since);

  const act = (s: ActionSpec) => {
    if (s.id === 'answer') return onAnswer(item.code);
    if (s.id === 'reply') return onAnswer(item.code, item.text);
    startWaitingAction(orgId, item.code, s.id === 'option' ? 'option' : s.id, s.optionKey);
  };
  const moreOptions = rest.length > 0;

  return (
    <div className={`item waiting${untagged || heading ? ' neutral' : ''}${item.parent ? ' child' : ''}`}>
      <div className="w-head">
        {kindKey && <span className={`chip${heading ? '' : ' kind'}`}>{t(kindKey)}</span>}
        {item.urgency === 'high' && <span className="chip high">{t('waiting.urgency.high')}</span>}
        {item.urgency === 'low' && <span className="muted">{t('waiting.urgency.low')}</span>}
        <code className="code">{item.code}</code>
        {age && (
          <Tooltip label={since ? t('waiting.since', { date: since }) : ''} placement="top">
            <span className="age tnum">{age}</span>
          </Tooltip>
        )}
      </div>
      <ClampText open={expanded} onToggle={onToggleExpanded} lines={3} text={item.text} className="item-text">
        <InlineMarkdown text={item.text} />
      </ClampText>
      {item.status && <p className="muted small w-status">{t('waiting.status', { status: item.status })}</p>}
      {optionsAsText && (
        <ul className="w-options">
          {(item.options ?? []).map((o) => (
            <li key={o.key}>
              {o.key} · <InlineMarkdown text={o.label} noLinks />
            </li>
          ))}
        </ul>
      )}
      {pending ? (
        <div className="w-pending" role="status" key={pending.stage}>
          {pending.stage === 'undo' ? (
            <>
              <span className="muted small">{t(pendingLabelKeyOf(pending.kind), { key: pending.optionKey ?? '' })}</span>
              <Button small variant="quiet" onClick={() => pendingStore.undo(orgId, item.code)}>{t('waiting.undo')}</Button>
            </>
          ) : (
            <>
              <Spinner delay={0} />
              <span className="muted small">{t('waiting.sent', { cosName })}</span>
            </>
          )}
        </div>
      ) : visible.length === 0 ? null : (
        <div className="w-actions-wrap">
          <div className="w-actions">
            {visible.filter((s) => s.id !== 'reply').map((s) => (
              <ActionButton key={`${s.id}${s.optionKey ?? ''}`} spec={s} asText={optionsAsText} onClick={() => act(s)} />
            ))}
            {moreOptions && (
              <Button small variant="quiet" aria-expanded={more} onClick={() => setMore(!more)}>
                {t(more ? 'waiting.lessOptions' : 'waiting.moreOptions')}
              </Button>
            )}
            {visible.filter((s) => s.id === 'reply').map((s) => (
              <ActionButton key="reply" spec={s} asText={optionsAsText} onClick={() => act(s)} />
            ))}
          </div>
          {moreOptions && (
            <Fold open={more}>
              <div className="w-actions w-more">
                {rest.map((s) => (
                  <ActionButton key={s.optionKey} spec={s} asText={optionsAsText} onClick={() => act(s)} />
                ))}
              </div>
            </Fold>
          )}
        </div>
      )}
      {group && (
        <div className="w-group">
          <button className="group-toggle" aria-expanded={group.open} aria-controls={`wg-${orgId}-${item.code}`} onClick={group.onToggle}>
            <ChevronRight size={10} strokeWidth={2} className={`chev${group.open ? ' open' : ''}`} />
            {tn('waiting.group', group.count)}
          </button>
          <Fold open={group.open} id={`wg-${orgId}-${item.code}`}>
            <div className="w-children" role="group" aria-label={t('waiting.group.label', { code: item.code })}>
              {group.children}
            </div>
          </Fold>
        </div>
      )}
      {pending?.stage === 'undo' && <span className="undo-bar" aria-hidden="true" />}
    </div>
  );
}
