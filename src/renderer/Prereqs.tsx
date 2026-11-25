import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PluginActionState, PrereqStatus, SignInState } from '../shared/types';
import { t } from '../shared/strings';
import { api } from './api';
import { Check, X } from './icons';
import { type PrereqId } from './logic';
import { prereqMark, prereqMarkKey, type PrereqMark } from './panel-logic';
import { Button } from './ui/Button';
import { Spinner } from './ui/Spinner';

interface Props {
  orgId: string;
  prereq: PrereqStatus;
  signIn: SignInState;
  pluginAction: PluginActionState | null;
  onRecheck(): void;
}

/** Longest wait for a recheck before the rows stop saying "Checking…" (a failed check never changes the status). */
const RECHECK_MAX_MS = 8000;

/** The 20 px status mark of a row (5.14). Pops in (240 ms) when a row turns done; never on the first paint. */
function Mark({ mark }: { mark: PrereqMark }) {
  const before = useRef<PrereqMark | null>(null);
  const pop = mark === 'done' && before.current !== null && before.current !== 'done';
  useEffect(() => {
    before.current = mark;
  }, [mark]);
  return (
    <span className={`mark20 ${mark}${pop ? ' pop' : ''}`} key={mark} role="img" aria-label={t(prereqMarkKey(mark))}>
      {mark === 'done' && <Check size={12} strokeWidth={3} />}
      {mark === 'action' && <span className="bang">!</span>}
      {mark === 'failed' && <X size={12} strokeWidth={3} />}
      {mark === 'checking' && <Spinner delay={0} className="lg" />}
    </span>
  );
}

function Row({ mark, words, children, actions }: { mark: PrereqMark; words: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <li>
      <Mark mark={mark} />
      <div className="check-body">
        {children}
        <div className={`check-state ${mark}`}>{words}</div>
      </div>
      {actions}
    </li>
  );
}

export function Prereqs({ orgId, prereq, signIn, pluginAction, onRecheck }: Props) {
  const [rechecking, setRechecking] = useState(false);
  // A recheck shows "Checking…" on the rows that are not done until the new status arrives.
  useEffect(() => setRechecking(false), [prereq.checkedAt]);
  useEffect(() => {
    if (!rechecking) return;
    const id = setTimeout(() => setRechecking(false), RECHECK_MAX_MS);
    return () => clearTimeout(id);
  }, [rechecking]);
  const recheck = () => {
    setRechecking(true);
    onRecheck();
  };
  const { claude, git, plugin } = prereq;
  const installing = pluginAction?.running && pluginAction.action === 'install';
  const mark = (id: PrereqId) => prereqMark(id, prereq, signIn, pluginAction, rechecking);
  const words = (m: PrereqMark, id?: PrereqId) => (id === 'signin' && m === 'checking' && signIn.running ? t('prereq.signIn.signingIn') : t(prereqMarkKey(m)));

  const claudeText = !claude.found
    ? t('claude.missing')
    : !claude.supported
      ? t('claude.unsupported', { version: claude.version ?? '?', range: claude.range })
      : t('prereq.claude.ok', { version: claude.version ?? '?' });

  const pluginText = !plugin
    ? t('prereq.plugin.none')
    : plugin.state === 'ok'
      ? t('prereq.plugin.ok')
      : plugin.state === 'missing'
        ? t('prereq.plugin.missing')
        : plugin.state === 'enabled-not-installed'
          ? t('prereq.plugin.enabledNotInstalled')
          : t('prereq.plugin.unknown');

  const mClaude = mark('claude');
  const mSignin = mark('signin');
  const mGit = mark('git');
  const mPlugin = mark('plugin');

  return (
    <div className="prereqs">
      <h1>{t('prereq.title')}</h1>
      <p className="muted">{t('prereq.subtitle')}</p>
      <ul className="checklist">
        <Row
          mark={mClaude}
          words={words(mClaude)}
        >
          <div>{claudeText}</div>
        </Row>

        <Row
          mark={mSignin}
          words={words(mSignin, 'signin')}
          actions={
            signIn.running ? (
              <div className="check-actions">
                <Button small onClick={() => void api().openTerminal()}>{t('prereq.signIn.openTerminal')}</Button>
                <Button small variant="quiet" onClick={() => void api().cancelSignIn()}>{t('prereq.cancel')}</Button>
              </div>
            ) : (
              prereq.signedIn === false && (
                <Button variant="primary" small onClick={() => void api().signIn()}>{t('prereq.signIn')}</Button>
              )
            )
          }
        >
          {signIn.running ? (
            <>
              {signIn.url ? (
                <a
                  href={signIn.url}
                  className="link"
                  onClick={(e) => {
                    e.preventDefault();
                    void api().openExternal(signIn.url as string);
                  }}
                >
                  {signIn.url}
                </a>
              ) : (
                <span className="muted">{t('prereq.signIn.starting')}</span>
              )}
              <p className="hint">{t('signin.pasteCodeHint')}</p>
            </>
          ) : (
            <>
              <div>{prereq.signedIn === true ? t('prereq.signedIn.ok') : prereq.signedIn === false ? t('prereq.signedIn.no') : t('prereq.signedIn.unknown')}</div>
              {signIn.error && <div className="error-text">{signIn.error}</div>}
            </>
          )}
        </Row>

        <Row
          mark={mGit}
          words={words(mGit)}
        >
          <div>{!git.found ? t('prereq.git.missing') : t('prereq.git.ok', { version: git.version ?? '?' })}</div>
          {git.devToolsMissing && <div className="hint">{t('git.devToolsMissing')}</div>}
        </Row>

        <Row
          mark={mPlugin}
          words={words(mPlugin)}
          actions={
            plugin &&
            plugin.state !== 'ok' && (
              <Button variant="primary" small loading={installing} loadingLabel={t('prereq.plugin.installing')} onClick={() => void api().installPlugin(orgId)}>
                {t('prereq.plugin.install')}
              </Button>
            )
          }
        >
          <div>{pluginText}</div>
          {plugin?.installed && <div className="hint">{t('prereq.plugin.version', { version: plugin.installed })}</div>}
          {plugin?.belowMinimum && <div className="hint">{t('prereq.plugin.minimum', { minimum: plugin.minimum })}</div>}
          {pluginAction?.error && <div className="error-text">{pluginAction.error}</div>}
        </Row>
      </ul>
      {/* One "Check again" for the whole list: the rows that need you carry their own primary (Sign in, Install). */}
      <div className="prereqs-foot">
        <Button onClick={recheck}>{t('prereq.checkAgain')}</Button>
      </div>
    </div>
  );
}
