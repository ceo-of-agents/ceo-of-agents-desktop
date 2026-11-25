import { useEffect, useState } from 'react';
import type { Tip } from '../shared/types';
import { t } from '../shared/strings';
import { api } from './api';
import { afterGotIt, nextTip } from './tip-logic';

/**
 * The org's contextual tips: the applicable, not dismissed ones in display order (empty: none, also when tips are off in Settings: the
 * main process returns none), the one shown now, "Got it" (dismisses it for good and shows the one after it), "Next tip" (the next one,
 * wrapping) and how many apply. The list is read again when the org's hq or settings change; the tip on screen stays when it is still
 * in the new list. Errors from the main process leave things as they were: a tip is never worth an error toast.
 */
export function useTip(orgId: string, enabled: boolean): [Tip | null, (id: string) => void, () => void, number] {
  const [state, setState] = useState<{ tips: Tip[]; id: string | null }>({ tips: [], id: null });
  useEffect(() => {
    if (!enabled) return;
    let stale = false;
    const load = () => {
      api()
        .getTips(orgId)
        .then((tips) => {
          if (stale) return;
          setState((s) => ({ tips, id: tips.some((x) => x.id === s.id) ? s.id : (tips[0]?.id ?? null) }));
        })
        .catch(() => undefined);
    };
    load();
    const off = api().onEvent((e) => {
      if ((e.type === 'org-view' || e.type === 'settings') && e.orgId === orgId) load();
    });
    return () => {
      stale = true;
      off();
    };
  }, [orgId, enabled]);
  const next = () => setState((s) => ({ tips: s.tips, id: nextTip(s.tips, s.id)?.id ?? null }));
  const gotIt = (id: string) => {
    setState((s) => {
      const r = afterGotIt(s.tips, id);
      return { tips: r.tips, id: r.current?.id ?? null };
    });
    void api()
      .dismissTip(orgId, id)
      .catch(() => undefined);
  };
  const tip = enabled ? (state.tips.find((x) => x.id === state.id) ?? null) : null;
  return [tip, gotIt, next, enabled ? state.tips.length : 0];
}

/**
 * The tip box of the org side panel, directly under Departments: a section framed like the others, with a static
 * header. The panel renders it only when there is a tip, so it takes no room otherwise. Click the text to put the phrase in the
 * chief of staff's box (it never sends; the app switches to that chat first); "Got it" hides this tip for good in this org and shows the next one; "Next tip" (only when several apply) shows the next one without dismissing.
 */
export function TipCard({ tip, onUse, onDismiss, onNext, many = false }: { tip: Tip; onUse(phrase: string): void; onDismiss(id: string): void; onNext?(): void; many?: boolean }) {
  return (
    <section className="panel-section tip-box" aria-label={t('tips.label')}>
      <h4 className="section-title">
        <span className="section-head static">
          <span className="section-name">{t('tips.title')}</span>
        </span>
      </h4>
      <div className="tip-body" role="note">
        <button type="button" className="tip-use" title={t('tips.use', { phrase: tip.phrase })} onClick={() => onUse(tip.phrase)}>
          {tip.text}
        </button>
        <div className="tip-actions">
          <button type="button" className="tip-dismiss" onClick={() => onDismiss(tip.id)}>
            {t('tips.dismiss')}
          </button>
          {many && (
            <button type="button" className="tip-next" onClick={() => onNext?.()}>
              {t('tips.next')}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
