// Images around the composer: the thumbnails waiting in the box, and the ones shown with a user message in the thread.
import { useEffect, useState } from 'react';
import { t } from '../shared/strings';
import type { ThreadImageRef } from '../shared/types';
import type { DraftImage } from './composer-images';
import { X } from './icons';
import { loadImage } from './image-cache';
import { Tooltip } from './ui/Tooltip';

/** The row of thumbnails inside the composer box, each with a remove button. */
export function ComposerThumbs({ images, onRemove }: { images: DraftImage[]; onRemove(key: string): void }) {
  if (images.length === 0) return null;
  return (
    <ul className="thumbs">
      {images.map((img, i) => (
        <li key={img.key} className="thumb">
          <img src={`data:${img.attachment.mediaType};base64,${img.attachment.data}`} alt={t('images.attached', { n: i + 1 })} draggable={false} />
          <Tooltip label={t('composer.removeImage')} placement="top">
            <button type="button" className="thumb-x" aria-label={t('composer.removeImage')} onClick={() => onRemove(img.key)}>
              <X size={12} />
            </button>
          </Tooltip>
        </li>
      ))}
    </ul>
  );
}

/** One image of a message: `src` undefined while it loads, null when it is gone. */
export function MessageImage({ src, n }: { src: string | null | undefined; n: number }) {
  if (src === null) return <span className="msg-image missing">{t('images.notAvailable')}</span>;
  if (src === undefined) return <span className="msg-image loading" aria-hidden="true" />;
  return <img className="msg-image" src={src} alt={t('images.attached', { n })} draggable={false} />;
}

/** The images of a user message, above its text. */
export function MessageImages({ orgId, images }: { orgId: string; images: ThreadImageRef[] }) {
  const [urls, setUrls] = useState<Record<string, string | null>>({});
  const ids = images.map((i) => i.id).join(',');
  useEffect(() => {
    let alive = true;
    for (const img of images) {
      void loadImage(orgId, img.id).then((url) => alive && setUrls((u) => (img.id in u && u[img.id] === url ? u : { ...u, [img.id]: url })));
    }
    return () => {
      alive = false;
    };
    // `ids` stands for the list: a new array with the same ids must not reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, ids]);
  return (
    <div className="msg-images">
      {images.map((img, i) => (
        <MessageImage key={`${img.id}-${i}`} src={urls[img.id]} n={i + 1} />
      ))}
    </div>
  );
}
