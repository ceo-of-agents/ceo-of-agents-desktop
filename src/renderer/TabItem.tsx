import { InlineMarkdown } from './Markdown';
import { X } from './icons';
import { Spinner } from './ui/Spinner';
import { Tooltip } from './ui/Tooltip';

interface Props {
  id: string;
  active: boolean;
  /** The tab's turn is running: a 6 px teal dot before the name. */
  busy: boolean;
  /** What the turn is doing, or "Handing over to <CoS>" while it hands over: the tab's tooltip. */
  tip: string;
  /** "<Name> (<Role>)", inline Markdown. */
  title: string;
  handingOver?: boolean;
  /** Aria label of the close button; none means no close button. */
  closeLabel?: string;
  onSelect(): void;
  onClose?(): void;
}

/** One tab of the strip (5.5): neutral when active, a dot while it works, a spinner and the name only while it hands over (the sentence is in the tooltip). */
export function TabItem({ id, active, busy, tip, title, handingOver, closeLabel, onSelect, onClose }: Props) {
  return (
    <div className={`tab-wrap${active ? ' active' : ''}`}>
      <Tooltip label={tip}>
        <button role="tab" data-thread-id={id} aria-selected={active} tabIndex={active ? 0 : -1} className="tab" onClick={onSelect}>
          {handingOver ? <Spinner /> : busy && <span className="tab-dot" aria-hidden="true" />}
          <span className="tab-name">
            <InlineMarkdown text={title} noLinks />
          </span>
        </button>
      </Tooltip>
      {closeLabel && (
        <button className="icon-btn tab-close" aria-label={closeLabel} onClick={onClose}>
          <X size={12} />
        </button>
      )}
    </div>
  );
}
