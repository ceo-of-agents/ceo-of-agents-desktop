// Step 13 (spec section 7): where the hq lives. The folder must be empty (only .git or .claude/settings.json inside); the app never overwrites.
import type { SetupFolderPick } from '../../shared/setup';
import { t } from '../../shared/strings';
import { shortList } from '../create-org-flow';
import { Button } from '../ui/Button';
import { ErrorLine, Notice } from './fields';

export function FolderStep({ pick, error, reposGiven, onChoose }: { pick: SetupFolderPick | null; error: string | null; reposGiven: boolean; onChoose(): void }) {
  const { shown, more } = shortList(pick?.entries ?? []);
  return (
    <>
      <div className="co-field" data-invalid={pick && !pick.ok ? 'true' : undefined}>
        {pick ? (
          <div className="co-folder">
            <code className="co-path" id="co-folder-path">
              {pick.path}
            </code>
            <Button id="co-folder-change" small aria-describedby={!pick.ok ? 'co-folder-error' : undefined} onClick={onChoose}>
              {t('createOrg.change')}
            </Button>
          </div>
        ) : (
          <div>
            <Button id="co-folder-change" onClick={onChoose}>
              {t('createOrg.folderButton')}
            </Button>
          </div>
        )}
        {pick && !pick.ok && (
          <div id="co-folder-error">
            <ErrorLine text={t(pick.symlink ? 'createOrg.symlink' : 'createOrg.notEmpty')} />
            {pick.entries.some((e) => e === '.DS_Store' || e.endsWith('/.DS_Store')) && <p className="co-help">{t('createOrg.dsStore')}</p>}
            {shown.length > 0 && (
              <ul className="co-entries mono">
                {shown.map((e) => (
                  <li key={e}>{e}</li>
                ))}
                {more > 0 && <li className="co-more">{t('createOrg.moreEntries', { n: more })}</li>}
              </ul>
            )}
          </div>
        )}
        {error && <ErrorLine id="co-folder-start-error" text={error} />}
      </div>
      {reposGiven && <Notice>{t('createOrg.n.reposFolder')}</Notice>}
    </>
  );
}
