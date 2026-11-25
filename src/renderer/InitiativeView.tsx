import { useEffect, useState } from 'react';
import { t } from '../shared/strings';
import { api } from './api';
import { X } from './icons';
import { InlineMarkdown, Markdown } from './Markdown';
import { stripMarkdown } from './markdown-safety';
import { Modal } from './ui/Modal';

/**
 * The status page of one initiative, read-only, in a dialog. The text comes from `readInitiative` (frontmatter already removed)
 * and is rendered with the same Markdown as the chat. Mount it when the user opens a page: it reads once, and `open` false lets it animate out.
 */
export function InitiativeView({ orgId, slug, title, open, onClose }: { orgId: string; slug: string; title: string; open: boolean; onClose(): void }) {
  // undefined: still reading; null: it could not be read.
  const [text, setText] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setText(undefined);
    api()
      .readInitiative(orgId, slug)
      .then((r) => live && setText(r), () => live && setText(null));
    return () => {
      live = false;
    };
  }, [orgId, slug]);
  return (
    <Modal open={open} onClose={onClose} label={stripMarkdown(title)}>
      <div className="iv-head">
        <h2>
          <InlineMarkdown text={title} noLinks />
        </h2>
        <button className="icon-btn" aria-label={t('initiatives.view.close')} onClick={onClose}>
          <X />
        </button>
      </div>
      <div className="iv-body md">
        {text === undefined ? <p className="muted small">{t('initiatives.view.loading')}</p> : text === null ? <p className="muted small">{t('initiatives.view.error')}</p> : <Markdown text={text} />}
      </div>
    </Modal>
  );
}
