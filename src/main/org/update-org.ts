// The one Update button: update the plugin when it is behind, restart the chats, then ask the chief of staff to apply the hq migrations and wait for the result.
import type { PluginActionState, PluginStatus } from '../../shared/types';
import { t } from '../../shared/strings';

export interface UpdateOrgDeps {
  /** Reads the plugin status for this org (fresh: called before and after each step). */
  status(): Promise<PluginStatus | null>;
  /** The plugin update (Claude Code's own commands, project scope). */
  updatePlugin(): Promise<{ ok: boolean; error: string | null }>;
  /** Lets turns in flight finish, then restarts the org's chats so they load the new plugin. */
  restart(): Promise<void>;
  /** Sends one message to the chief of staff thread (a call to `waitForCos` follows right away). */
  sendToCos(text: string): void;
  /** Resolves when the chief of staff turn that handles the message just sent ends, or when the hq no longer lags. Rejects when the org goes away. */
  waitForCos(): Promise<void>;
  emit(state: PluginActionState): void;
  /** The message that tells the chief of staff to apply the pending hq migrations. */
  message: string;
  /** The chief of staff's display name, for the messages. */
  cosName: string;
  /**
   * When the hq still lags after the chief of staff's turn, the status is read once more after this delay before the
   * error is shown (a commit or a file write can land just after the reply). Default 3000 ms.
   */
  recheckMs?: number;
}

export type UpdateOrgOutcome = 'status-failed' | 'plugin-failed' | 'plugin-not-applied' | 'hq-not-applied' | 'failed' | 'nothing-to-do' | 'hq-current' | 'asked-cos';

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim();

/**
 * Steps: checking, (a) update + restart when the plugin is behind and not a dev folder, (b) read the status again,
 * (c) ask the chief of staff when the hq is behind and wait for the turn, (d) read the status again, and once more
 * after `recheckMs` when the hq still lags.
 * Exactly one final emit with `running: false` on every path.
 */
export async function runOrgUpdate(d: UpdateOrgDeps): Promise<UpdateOrgOutcome> {
  const emit = (step: PluginActionState['step']) => d.emit({ running: true, action: 'update', error: null, step });
  let outcome: UpdateOrgOutcome = 'nothing-to-do';
  let error: string | null = null;
  const fail = (o: UpdateOrgOutcome, msg: string): UpdateOrgOutcome => {
    error = msg;
    return o;
  };
  const readable = (s: PluginStatus | null): s is PluginStatus => !!s && s.state === 'ok';
  try {
    emit('checking');
    let status = await d.status();
    if (!readable(status)) {
      outcome = fail('status-failed', t('plugin.err.status'));
      return outcome;
    }
    if (!status.dev && status.updateAvailable) {
      emit('plugin');
      const res = await d.updatePlugin();
      if (!res.ok) {
        outcome = fail('plugin-failed', t('plugin.err.updateFailed', { error: oneLine(res.error ?? '') }));
        return outcome;
      }
      emit('restart');
      await d.restart();
      status = await d.status();
      if (!readable(status)) {
        outcome = fail('status-failed', t('plugin.err.status'));
        return outcome;
      }
      if (status.updateAvailable) {
        outcome = fail('plugin-not-applied', t('plugin.err.notApplied', { installed: status.installed ?? '?' }));
        return outcome;
      }
      outcome = 'hq-current';
    }
    if (status.orgUpdateAvailable) {
      emit('cos');
      d.sendToCos(d.message);
      await d.waitForCos();
      status = await d.status();
      if (readable(status) && status.orgUpdateAvailable) {
        await new Promise((r) => setTimeout(r, d.recheckMs ?? 3000));
        status = await d.status();
      }
      if (!readable(status)) {
        outcome = fail('status-failed', t('plugin.err.status'));
        return outcome;
      }
      if (status.orgUpdateAvailable) {
        outcome = fail('hq-not-applied', t('plugin.err.hqNotApplied', { org: status.hqFrameworkVersion ?? '?', cosName: d.cosName }));
        return outcome;
      }
      outcome = 'asked-cos';
    }
    return outcome;
  } catch (e) {
    outcome = fail('failed', t('plugin.err.stopped', { message: oneLine(e instanceof Error ? e.message : String(e)).replace(/\.$/, '') }));
    return outcome;
  } finally {
    d.emit({ running: false, action: 'update', error, step: null, ...(error === null ? { done: true } : {}) });
  }
}
