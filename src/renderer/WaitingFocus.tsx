import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { WaitingItem } from '../shared/types';
import { t, tn } from '../shared/strings';
import { api } from './api';
import {
  buildDeck, childCountOf, linkChipsOf, moveAnnouncement, moveForKey, moveIndex, newItemCount, newItemsAnnouncement, openingPosition, pendingAnnouncement, pendingStripText,
  positionText, recommendedKey, rememberCode, rememberedCode, resolveFocus, slideLabel, type FocusMove, type FocusPosition,
} from './focus-logic';
import { Check, ChevronLeft, ChevronRight, CircleDot, ExternalLink, GitPullRequest, X } from './icons';
import { ageText } from './logic';
import { InlineMarkdown, Markdown } from './Markdown';
import { stripMarkdown } from './markdown-safety';
import { dayLabel, pendingLabelKeyOf, waitingActionSpecs, waitingKindKey, type ActionSpec } from './panel-logic';
import { pendingStore, type Pending } from './pending-send';
import { startWaitingAction } from './waiting-actions';
import { asksTheCeo } from '../shared/waiting';
import { Button } from './ui/Button';
import { useDismiss, useFocusTrap } from './ui/hooks';
import { Presence } from './ui/Presence';
import { Tooltip } from './ui/Tooltip';

interface Props {
  open: boolean;
  orgId: string;
  /** The org's waiting items (parsed ones only), in any order. */
  items: WaitingItem[];
  onClose(): void;
  /** Reply and Answer: the view closes and the chief of staff tab opens with the item as a chip in the composer. */
  onReply(code: string | null, text?: string): void;
}

/** The focus view of "Waiting on you": one item at a time, large, over the whole window. */
export function WaitingFocus(p: Props) {
  return (
    <Presence present={p.open} exitMs={120}>
      {(state) => <FocusBody {...p} state={state} />}
    </Presence>
  );
}

type Dir = 'next' | 'previous';

const ACTION_LABEL: Record<string, string> = { approve: 'waiting.approve', decline: 'waiting.decline', done: 'waiting.done', answer: 'waiting.answer', reply: 'waiting.reply' };

function FocusBody({ state, orgId, items, onClose, onReply }: Props & { state: 'open' | 'closed' }) {
  const open = state === 'open';
  const sheet = useRef<HTMLDivElement>(null);
  const slideRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  const version = useSyncExternalStore(pendingStore.subscribe, pendingStore.version, pendingStore.version);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` is the store's change signal
  const pending = useMemo(() => pendingStore.list(orgId), [orgId, version]);
  const deck = useMemo(() => buildDeck(items, new Set(pending.map((x) => x.code))), [items, pending]);

  // Where the view stands: kept by the item's code, so a re-read of the hq never moves it.
  const nav = useRef<FocusPosition | null>(null);
  if (nav.current === null) nav.current = openingPosition(deck, rememberedCode(orgId));
  const pos = resolveFocus(deck, nav.current);
  nav.current = pos;
  const cur = deck.length > 0 ? deck[pos.index] : null;
  const curCode = cur?.code ?? null;

  const go = (move: FocusMove) => {
    if (deck.length === 0) return;
    const index = moveIndex(pos.index, deck.length, move);
    nav.current = { code: deck[index].code, index };
    rerender();
  };

  useFocusTrap(sheet, open);
  useDismiss(open, onClose);

  useEffect(() => rememberCode(orgId, curCode), [orgId, curCode]);

  // A move: the previous slide fades out (kept as a copy for 120 ms), the new one comes in, the body scrolls back to the top,
  // and focus goes to the slide region, never to an action button.
  const shown = useRef<{ item: WaitingItem; index: number } | null>(null);
  const [leaving, setLeaving] = useState<{ item: WaitingItem; dir: Dir; n: number } | null>(null);
  const [dir, setDir] = useState<Dir | null>(null);
  const moves = useRef(0);
  useLayoutEffect(() => {
    const prev = shown.current;
    if (prev && cur && prev.item.code !== cur.code) {
      const d: Dir = pos.index < prev.index ? 'previous' : 'next';
      setDir(d);
      setLeaving({ item: prev.item, dir: d, n: ++moves.current });
    }
    shown.current = cur ? { item: cur, index: pos.index } : null;
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    if (cur) slideRef.current?.focus({ preventScroll: true });
    else closeRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curCode]);
  useEffect(() => {
    if (!leaving) return;
    const id = setTimeout(() => setLeaving(null), 120);
    return () => clearTimeout(id);
  }, [leaving]);

  // Announcements (polite): each move, new items, an action that starts.
  const [moveLive, setMoveLive] = useState('');
  const [eventLive, setEventLive] = useState('');
  useEffect(() => {
    if (cur) setMoveLive(moveAnnouncement(pos.index, deck.length, cur));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curCode]);
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    // A `{wait}` group heading asks nothing: it is neither a slide nor a new item.
    const asks = items.filter(asksTheCeo);
    const codes = new Set(asks.map((i) => i.code));
    if (known.current) {
      const fresh = newItemCount(known.current, asks);
      if (fresh > 0) setEventLive(newItemsAnnouncement(fresh));
    }
    known.current = new Set([...(known.current ?? []), ...codes]);
  }, [items]);

  const start = (item: WaitingItem, kind: 'approve' | 'decline' | 'done' | 'option', optionKey?: string) => {
    if (startWaitingAction(orgId, item.code, kind, optionKey)) setEventLive(pendingAnnouncement(item.code, t(pendingLabelKeyOf(kind), { key: optionKey ?? '' })));
  };
  const act = (item: WaitingItem, s: ActionSpec) => {
    if (s.id === 'answer') onReply(item.code);
    else if (s.id === 'reply') onReply(item.code, item.text);
    else start(item, s.id === 'option' ? 'option' : s.id, s.optionKey);
  };

  const latestUndo: Pending | undefined = [...pending].reverse().find((x) => x.stage === 'undo');
  const undo = (x: Pending) => {
    // The item comes back to its sorted place and the view goes back to it.
    nav.current = { code: x.code, index: nav.current?.index ?? 0 };
    pendingStore.undo(orgId, x.code);
    rerender();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const move = moveForKey(e.key);
    if (!move) return;
    e.preventDefault();
    go(move);
  };

  const actions = cur ? waitingActionSpecs(cur).visible.filter((s) => s.id !== 'option') : [];
  const tagged = !!cur && cur.action !== null;

  return (
    <div className="modal-backdrop fv-backdrop" data-state={state} onClick={onClose}>
      <div ref={sheet} className="fv-sheet" role="dialog" aria-modal="true" aria-label={t('waiting.focus.label')} onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <header className="fv-head">
          <span className="fv-title">{t('waiting.title')}</span>
          <div className="fv-nav">
            {cur && (
              <>
                <Tooltip label={t('waiting.focus.previous')}>
                  <button className="icon-btn" aria-label={t('waiting.focus.previous')} disabled={pos.index === 0} onClick={() => go('previous')}>
                    <ChevronLeft />
                  </button>
                </Tooltip>
                <span className="fv-position tnum" aria-hidden="true">{positionText(pos.index, deck.length)}</span>
                <Tooltip label={t('waiting.focus.next')}>
                  <button className="icon-btn" aria-label={t('waiting.focus.next')} disabled={pos.index === deck.length - 1} onClick={() => go('next')}>
                    <ChevronRight />
                  </button>
                </Tooltip>
              </>
            )}
            <Tooltip label={t('waiting.focus.close')}>
              <button className="icon-btn" aria-label={t('waiting.focus.close')} onClick={onClose}>
                <X />
              </button>
            </Tooltip>
          </div>
        </header>
        <div className="fv-body" ref={bodyRef} data-tagged={tagged}>
          {cur ? (
            <div
              key={cur.code}
              ref={slideRef}
              className="fv-slide"
              data-dir={dir ?? undefined}
              role="group"
              aria-roledescription="slide"
              aria-label={slideLabel(pos.index, deck.length, cur.code)}
              tabIndex={-1}
            >
              <SlideContent item={cur} childCount={childCountOf(items, cur.code)} onOption={(key) => start(cur, 'option', key)} />
            </div>
          ) : (
            <div className="fv-empty">
              <p className="fv-empty-text">
                <Check size={14} strokeWidth={2.5} className="ok-check" />
                {t('waiting.empty')}
              </p>
              <button ref={closeRef} className="btn" onClick={onClose}>
                {t('waiting.focus.close')}
              </button>
            </div>
          )}
          {leaving && (
            <div key={`out-${leaving.n}`} className="fv-slide fv-leaving" data-dir={leaving.dir} aria-hidden="true" {...({ inert: '' } as object)}>
              <SlideContent item={leaving.item} childCount={childCountOf(items, leaving.item.code)} onOption={() => undefined} />
            </div>
          )}
        </div>
        <footer className="fv-foot">
          {latestUndo && <span className="undo-bar fv-undo-bar" key={`${latestUndo.code}-${latestUndo.startedAt}`} aria-hidden="true" />}
          <div className="fv-actions">
            {actions.map((s) => (
              <Button key={s.id} variant={s.variant} onClick={() => cur && act(cur, s)}>
                {t(ACTION_LABEL[s.id])}
              </Button>
            ))}
          </div>
          {latestUndo ? (
            <div className="fv-strip">
              <span className="muted small">{pendingStripText(t(pendingLabelKeyOf(latestUndo.kind), { key: latestUndo.optionKey ?? '' }), latestUndo.code)}</span>
              <Button small variant="quiet" onClick={() => undo(latestUndo)}>
                {t('waiting.undo')}
              </Button>
            </div>
          ) : (
            cur && <span className="fv-hint">{t('waiting.focus.hint')}</span>
          )}
        </footer>
        <div className="sr-only" role="status" aria-live="polite">{moveLive}</div>
        <div className="sr-only" role="status" aria-live="polite">{eventLive}</div>
      </div>
    </div>
  );
}

function LinkChips({ item }: { item: WaitingItem }) {
  const chips = linkChipsOf(item);
  if (chips.length === 0) return null;
  return (
    <div className="fv-links">
      {chips.map((c) => (
        <Tooltip key={c.url} label={c.url} placement="top">
          <button className="fv-chip" onClick={() => void api().openExternal(c.url)}>
            {c.kind === 'issue' ? <CircleDot size={12} /> : c.kind === 'pr' ? <GitPullRequest size={12} /> : <ExternalLink size={12} />}
            {c.label}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="fv-section">
      <h3 className="fv-label">{title}</h3>
      {children}
    </section>
  );
}

/** One item, large: meta row, text, status, link chips and, for a decide item, its card. */
function SlideContent({ item, childCount, onOption }: { item: WaitingItem; childCount: number; onOption(key: string): void }) {
  const kindKey = waitingKindKey(item);
  const day = dayLabel(item.since);
  const age = ageText(item.since);
  const card = item.card;
  const options = item.options ?? [];
  const recommended = card ? recommendedKey(card.recommendation, card.options) : null;
  return (
    <>
      <div className="fv-meta">
        {kindKey && <span className="chip kind">{t(kindKey)}</span>}
        {item.urgency === 'high' && <span className="chip high">{t('waiting.urgency.high')}</span>}
        {item.urgency === 'low' && <span className="muted fv-low">{t('waiting.urgency.low')}</span>}
        <code className="fv-code">{item.code}</code>
        {day && <span className="fv-since tnum">{t('waiting.focus.since', { date: day, age })}</span>}
      </div>
      {item.parent && <p className="muted fv-meta-line">{t('waiting.focus.partOf', { code: item.parent })}</p>}
      <div className="fv-text">
        <InlineMarkdown text={item.text} />
      </div>
      {childCount > 0 && <p className="muted fv-meta-line">{tn('waiting.focus.children', childCount)}</p>}
      {item.status && <p className="muted fv-status">{t('waiting.status', { status: item.status })}</p>}
      {item.action === null && <p className="muted fv-meta-line">{t('waiting.untaggedHint')}</p>}
      <LinkChips item={item} />
      {item.action === 'decide' && !card && <p className="muted fv-meta-line fv-nocard">{t('waiting.focus.noCard', { code: item.code })}</p>}
      {item.action === 'decide' && card && (
        <div className="fv-card">
          {card.context && (
            <Section title={t('waiting.focus.context')}>
              <div className="fv-md md">
                <Markdown text={card.context} />
              </div>
            </Section>
          )}
          {card.options.length > 0 && (
            <Section title={t('waiting.focus.options')}>
              {options.length >= 2 ? (
                <div className="fv-options" role="group" aria-label={t('waiting.focus.options.label', { code: item.code })}>
                  {options.map((o) => (
                    <button key={o.key} className="btn you-outline fv-option" aria-label={t('waiting.option', { key: o.key, label: stripMarkdown(o.label) })} onClick={() => onOption(o.key)}>
                      <span className="fv-option-key" aria-hidden="true">{o.key}</span>
                      <span className="fv-option-label" aria-hidden="true">
                        <InlineMarkdown text={o.label} noLinks />
                      </span>
                      {recommended === o.key && <span className="fv-rec">{t('waiting.focus.recommended')}</span>}
                    </button>
                  ))}
                </div>
              ) : (
                <ul className="fv-plain-options">
                  {card.options.map((o) => (
                    <li key={o.key}>
                      <span className="fv-option-key">{o.key}</span> <InlineMarkdown text={o.label} />
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          )}
          {card.recommendation && (
            <Section title={t('waiting.focus.recommendation')}>
              <div className="fv-md md">
                <Markdown text={card.recommendation} />
              </div>
            </Section>
          )}
          {(card.proposedBy || card.escalate) && (
            <p className="fv-meta-line muted">
              {card.proposedBy && <span>{t('waiting.focus.proposedBy', { who: card.proposedBy })}</span>}
              {card.escalate && <span className="chip fv-holding">{t('waiting.focus.holding')}</span>}
            </p>
          )}
        </div>
      )}
    </>
  );
}
