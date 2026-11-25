import { t } from '../shared/strings';
import { InlineMarkdown } from './Markdown';
import { stripMarkdown } from './markdown-safety';
import { useDelayed } from './ui/hooks';

/** Loading an org (7): the layout stays; static placeholders (no shimmer) show after 300 ms, so a quick load never flashes them. */
export function Loading({ name }: { name?: string }) {
  const show = useDelayed(true);
  return (
    <>
      <header className="topbar">
        {name && (
          <h2 title={stripMarkdown(name)}>
            <InlineMarkdown text={name} noLinks />
          </h2>
        )}
      </header>
      <div className="org-body" role="status" aria-busy="true" aria-label={t('loading')}>
        <div className="center-col">
          <div className="ph-thread">
            {show && (
              <>
                <span className="ph-bar" style={{ width: '60%' }} />
                <span className="ph-bar" style={{ width: '80%' }} />
                <span className="ph-bar" style={{ width: '40%' }} />
              </>
            )}
          </div>
        </div>
        <div className="panel-shell">
          <div className="side-panel">
            {show && (
              <>
                <span className="ph-card" />
                <span className="ph-card" />
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
