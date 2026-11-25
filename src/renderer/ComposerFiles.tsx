// Files around the composer: the chips waiting in the box, and the ones shown with a user message.
import { sizeText, fileKind } from '../shared/attachments';
import { t } from '../shared/strings';
import type { AttachmentKind, ThreadFileRef } from '../shared/types';
import type { DraftFile } from './composer-files';
import { File as FileIcon, Film, Music, FileText, X } from './icons';
import { Tooltip } from './ui/Tooltip';

function KindIcon({ kind }: { kind: AttachmentKind }) {
  if (kind === 'video') return <Film size={14} />;
  if (kind === 'audio') return <Music size={14} />;
  if (kind === 'pdf') return <FileText size={14} />;
  return <FileIcon size={14} />;
}

function Chip({ name, size, kind, onRemove }: { name: string; size: number; kind: AttachmentKind; onRemove?: () => void }) {
  return (
    <li className="file-chip" title={name}>
      <KindIcon kind={kind} />
      <span className="file-chip-name">{name}</span>
      <span className="file-chip-size">{sizeText(size)}</span>
      {onRemove && (
        <Tooltip label={t('composer.removeFile', { name })} placement="top">
          <button type="button" className="file-chip-x" aria-label={t('composer.removeFile', { name })} onClick={onRemove}>
            <X size={12} />
          </button>
        </Tooltip>
      )}
    </li>
  );
}

/** The chips of the files waiting in the composer box, each with a remove button. */
export function ComposerFiles({ files, onRemove }: { files: DraftFile[]; onRemove(key: string): void }) {
  if (files.length === 0) return null;
  return (
    <ul className="file-chips" aria-label={t('composer.attachedFiles')}>
      {files.map((f) => (
        <Chip key={f.key} name={f.attachment.name} size={f.attachment.data.byteLength} kind={fileKind(f.attachment.name, f.attachment.mediaType)} onRemove={() => onRemove(f.key)} />
      ))}
    </ul>
  );
}

/** The files of a user message, above its text. */
export function MessageFiles({ files }: { files: ThreadFileRef[] }) {
  return (
    <ul className="file-chips msg-files" aria-label={t('composer.attachedFiles')}>
      {files.map((f, i) => (
        <Chip key={`${f.id}-${i}`} name={f.name} size={f.size} kind={f.kind} />
      ))}
    </ul>
  );
}

/** True when one of the files is a video: the composer then says the model does not read video natively. */
export function hasVideo(files: DraftFile[]): boolean {
  return files.some((f) => fileKind(f.attachment.name, f.attachment.mediaType) === 'video');
}
