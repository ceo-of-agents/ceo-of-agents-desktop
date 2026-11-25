// Settings per org. No app-wide level.
//  - permissionMode, effort, model: the hq's git-ignored .claude/settings.local.json (the same keys Claude Code reads),
//    so a terminal session in that hq sees the same values. Written only when the user changes a value.
//  - autoPush, newSessionAfterMinutes, renewSessionAtTokens, tips and tipsDismissed (not Claude Code settings): <dataDir>/orgs/<orgId>/settings.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseOrgYaml } from './hq/parse';
import { anchorPathRule, readDenyRules } from './claude/rules';
import { asObject, hqLocalSettingsFile, hqSettingsFile, readJsonObject, updateHqLocalSettings, writeFileAtomic, type JsonObject } from './claude/local-settings';
import { SeenModels } from './claude/seen-models';
import type { EffortLevel, ModelSource, OrgId, PermissionMode, SettingSource, Settings, SettingsPatch } from '../shared/types';

export const MODES: PermissionMode[] = ['default', 'acceptEdits', 'auto', 'plan'];
export const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Minutes of inactivity after which the CoS thread starts a new session (0: never, only on app start, a new day or an explicit request). */
export const NEW_SESSION_AFTER_MINUTES = [15, 30, 60, 120, 240, 0];
/** Context size (tokens) at which the CoS thread continues in a new session (0: never). */
export const RENEW_SESSION_AT_TOKENS = [50000, 100000, 150000, 200000, 400000, 0];
export const DEFAULTS = { permissionMode: 'default' as PermissionMode, effort: 'high' as EffortLevel, autoPush: true, newSessionAfterMinutes: 30, renewSessionAtTokens: 100000 };

const isMode = (v: unknown): v is PermissionMode => MODES.includes(v as PermissionMode);
const isEffort = (v: unknown): v is EffortLevel => EFFORTS.includes(v as EffortLevel);
const isNewSessionAfter = (v: unknown): v is number => typeof v === 'number' && NEW_SESSION_AFTER_MINUTES.includes(v);
const isRenewAt = (v: unknown): v is number => typeof v === 'number' && RENEW_SESSION_AT_TOKENS.includes(v);
export const isModel = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]*$/.test(v);

/** The only keys read from a settings file: permissions.defaultMode and effortLevel (and model, from the hq's local file). */
export interface SettingsFileValues {
  permissionMode?: unknown;
  effort?: unknown;
  model?: unknown;
}

export function pickValues(file: JsonObject): SettingsFileValues {
  return { permissionMode: asObject(file.permissions).defaultMode, effort: file.effortLevel, model: file.model };
}

/** The user's Claude Code settings file: $CLAUDE_CONFIG_DIR/settings.json if set, else ~/.claude/settings.json. */
export function userSettingsFile(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  return path.join(dir ? dir : path.join(home, '.claude'), 'settings.json');
}

export interface ResolveInput {
  hqLocal: SettingsFileValues;
  hq: SettingsFileValues;
  user: SettingsFileValues;
  autoPush: boolean;
  newSessionAfterMinutes: number;
  renewSessionAtTokens: number;
  /** Contextual tips on (default). */
  tips?: boolean;
  /** models.cos and models.tiers from the hq's org.yaml. */
  orgYamlModel: string | null;
  modelTiers: string[];
  /** Model ids the app has seen (default: none). */
  seenModels?: string[];
}

/** Pure: the effective settings and where each value came from. Unknown values fall through to the next source. */
export function resolveSettings(i: ResolveInput): Settings {
  const sources: [SettingSource, SettingsFileValues][] = [['hq-local', i.hqLocal], ['hq', i.hq], ['user', i.user]];
  let permissionMode = DEFAULTS.permissionMode;
  let permissionModeSource: SettingSource = 'default';
  let effort = DEFAULTS.effort;
  let effortSource: SettingSource = 'default';
  for (const [src, v] of [...sources].reverse()) {
    if (isMode(v.permissionMode)) {
      permissionMode = v.permissionMode;
      permissionModeSource = src;
    }
    if (isEffort(v.effort)) {
      effort = v.effort;
      effortSource = src;
    }
  }
  const model = isModel(i.hqLocal.model) ? i.hqLocal.model : null;
  const cosModel = model ?? i.orgYamlModel;
  const cosModelSource: ModelSource = model ? 'override' : i.orgYamlModel ? 'org-yaml' : 'default';
  return {
    permissionMode,
    permissionModeSource,
    effort,
    effortSource,
    model,
    cosModel,
    cosModelSource,
    orgYamlModel: i.orgYamlModel,
    modelTiers: i.modelTiers,
    seenModels: i.seenModels ?? [],
    autoPush: i.autoPush,
    newSessionAfterMinutes: isNewSessionAfter(i.newSessionAfterMinutes) ? i.newSessionAfterMinutes : DEFAULTS.newSessionAfterMinutes,
    renewSessionAtTokens: isRenewAt(i.renewSessionAtTokens) ? i.renewSessionAtTokens : DEFAULTS.renewSessionAtTokens,
    tips: i.tips !== false,
  };
}

export interface SettingsStoreOptions {
  dataDir: string;
  /** Path of the user's Claude Code settings file (default: see userSettingsFile). */
  userFile?: string;
}

/** A JSON object from a file: {} when the file is missing, null when it exists but is not a valid JSON object. */
function readJsonStrict(file: string): JsonObject | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  if (text.trim() === '') return {};
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as JsonObject) : null;
  } catch {
    return null;
  }
}

export class SettingsStore {
  private readonly userFile: string;
  /** Per org: the model ids seen in that org's init messages (<dataDir>/orgs/<orgId>/models-seen.json). */
  private readonly seenByOrg = new Map<OrgId, SeenModels>();

  constructor(private readonly o: SettingsStoreOptions) {
    this.userFile = o.userFile ?? userSettingsFile();
  }

  /** The model ids seen in this org's init messages, offered in its pickers. Kept per org: an id seen in one org is not offered in another. */
  seen(orgId: OrgId): SeenModels {
    let s = this.seenByOrg.get(orgId);
    if (!s) {
      s = new SeenModels(path.join(this.o.dataDir, 'orgs', orgId, 'models-seen.json'));
      this.seenByOrg.set(orgId, s);
    }
    return s;
  }

  private orgFile(orgId: OrgId): string {
    return path.join(this.o.dataDir, 'orgs', orgId, 'settings.json');
  }

  /**
   * `permissions.deny` of the user's own Claude Code settings (read only that key). Sessions run with
   * `--setting-sources project,local`, which drops these rules, so the app passes them itself. A path rule starting with
   * a single `/` is anchored to the settings file's folder (its meaning in a settings file), in the `//abs` form. Claude Code docs
   * (permissions, path rules): "`/path` is relative to the settings source", so in user settings `/secrets/**` means `~/.claude/secrets/**`.
   */
  userDenyRules(): string[] {
    const dir = path.dirname(this.userFile);
    return readDenyRules(this.userFile).map((r) => anchorPathRule(r, dir));
  }

  /**
   * The only keys of the user's own Claude Code settings that decide whether the app turns the artifact tools on: `enableArtifact`
   * and `env.CLAUDE_CODE_DISABLE_ARTIFACT` (nothing else is kept). Sessions run with `--setting-sources project,local`, which drops
   * the user's file, so Claude Code cannot see these switches itself. Missing or invalid file: `{}`.
   */
  userArtifactSettings(): JsonObject {
    const o = readJsonObject(this.userFile);
    const out: JsonObject = {};
    if ('enableArtifact' in o) out.enableArtifact = o.enableArtifact;
    const flag = asObject(o.env).CLAUDE_CODE_DISABLE_ARTIFACT;
    if (flag !== undefined) out.env = { CLAUDE_CODE_DISABLE_ARTIFACT: flag };
    return out;
  }

  /** The org's auto push setting (default on). */
  autoPush(orgId: OrgId): boolean {
    const v = readJsonObject(this.orgFile(orgId)).autoPush;
    return typeof v === 'boolean' ? v : DEFAULTS.autoPush;
  }

  /** Minutes of inactivity after which the CoS starts a new session (default 30; 0 means never). */
  newSessionAfterMinutes(orgId: OrgId): number {
    const v = readJsonObject(this.orgFile(orgId)).newSessionAfterMinutes;
    return isNewSessionAfter(v) ? v : DEFAULTS.newSessionAfterMinutes;
  }

  /** Context size (tokens) at which the CoS continues in a new session (default 100000; 0 means never). */
  renewSessionAtTokens(orgId: OrgId): number {
    const v = readJsonObject(this.orgFile(orgId)).renewSessionAtTokens;
    return isRenewAt(v) ? v : DEFAULTS.renewSessionAtTokens;
  }

  /** Contextual tips on for this org (default on; the "Show tips" switch in Settings). */
  tipsOn(orgId: OrgId): boolean {
    return readJsonObject(this.orgFile(orgId)).tips !== false;
  }

  /** Ids of the tips the user chose not to see again in this org. */
  tipsDismissed(orgId: OrgId): string[] {
    const v = readJsonObject(this.orgFile(orgId)).tipsDismissed;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  }

  /** "Got it" on a tip: adds the tip id to this org's list (ignores anything that is not a plausible id). */
  dismissTip(orgId: OrgId, tipId: string): void {
    if (typeof tipId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(tipId)) return;
    const current = this.tipsDismissed(orgId);
    if (current.includes(tipId)) return;
    const file = this.orgFile(orgId);
    writeFileAtomic(file, JSON.stringify({ ...readJsonObject(file), tipsDismissed: [...current, tipId] }, null, 2) + '\n');
  }

  get(orgId: OrgId, hqPath: string): Settings {
    let org = parseOrgYaml('');
    try {
      org = parseOrgYaml(fs.readFileSync(path.join(hqPath, 'org.yaml'), 'utf8'));
    } catch {
      // no org.yaml: no models
    }
    return resolveSettings({
      hqLocal: pickValues(readJsonObject(hqLocalSettingsFile(hqPath))),
      hq: pickValues(readJsonObject(hqSettingsFile(hqPath))),
      user: pickValues(readJsonObject(this.userFile)),
      autoPush: this.autoPush(orgId),
      newSessionAfterMinutes: this.newSessionAfterMinutes(orgId),
      renewSessionAtTokens: this.renewSessionAtTokens(orgId),
      tips: this.tipsOn(orgId),
      orgYamlModel: org.models.cos,
      modelTiers: org.models.tiers,
      seenModels: this.seen(orgId).list(),
    });
  }

  /** Applies a change. Writes only the keys in the patch (invalid values are ignored); returns the new effective settings. */
  set(orgId: OrgId, hqPath: string, patch: SettingsPatch): Settings {
    const appPatch: JsonObject = {};
    if (typeof patch.autoPush === 'boolean') appPatch.autoPush = patch.autoPush;
    if (isNewSessionAfter(patch.newSessionAfterMinutes)) appPatch.newSessionAfterMinutes = patch.newSessionAfterMinutes;
    if (isRenewAt(patch.renewSessionAtTokens)) appPatch.renewSessionAtTokens = patch.renewSessionAtTokens;
    if (typeof patch.tips === 'boolean') appPatch.tips = patch.tips;
    if (Object.keys(appPatch).length > 0) {
      const file = this.orgFile(orgId);
      writeFileAtomic(file, JSON.stringify({ ...readJsonObject(file), ...appPatch }, null, 2) + '\n');
    }
    const wantsMode = isMode(patch.permissionMode);
    const wantsEffort = isEffort(patch.effort);
    const wantsModel = patch.model === null || isModel(patch.model);
    if (wantsMode || wantsEffort || wantsModel) {
      updateHqLocalSettings(hqPath, (data) => {
        if (wantsMode) {
          const perms = asObject(data.permissions);
          perms.defaultMode = patch.permissionMode;
          data.permissions = perms;
        }
        if (wantsEffort) data.effortLevel = patch.effort;
        if (wantsModel) {
          if (patch.model === null) delete data.model;
          else data.model = patch.model;
        }
      });
    }
    return this.get(orgId, hqPath);
  }

  /**
   * Moves the old app-wide <dataDir>/settings.json into the orgs, then removes it. Its autoPush becomes each org's
   * value (only for an org without one); its permissionMode, if not `default`, goes to the hq's settings.local.json
   * only when neither hq settings file already sets permissions.defaultMode. The old file is removed only when every
   * registered org was migrated or already had its values; it stays when there are no orgs, an org folder is missing,
   * a settings file is not valid JSON or a write fails (the next start tries again).
   */
  migrateLegacy(orgs: { id: OrgId; path: string }[]): void {
    const legacy = path.join(this.o.dataDir, 'settings.json');
    if (!fs.existsSync(legacy)) return;
    const old = readJsonStrict(legacy);
    if (!old || orgs.length === 0) return;
    let allDone = true;
    for (const org of orgs) if (!this.migrateOrg(org, old)) allDone = false;
    if (!allDone) return;
    try {
      fs.unlinkSync(legacy);
    } catch {
      // already gone
    }
  }

  /** True when the org has its values (migrated now or already there). */
  private migrateOrg(org: { id: OrgId; path: string }, old: JsonObject): boolean {
    try {
      if (!fs.existsSync(org.path)) return false;
      const orgFile = this.orgFile(org.id);
      const current = readJsonStrict(orgFile);
      if (!current) return false;
      if (typeof old.autoPush === 'boolean' && typeof current.autoPush !== 'boolean') {
        writeFileAtomic(orgFile, JSON.stringify({ ...current, autoPush: old.autoPush }, null, 2) + '\n');
      }
      if (isMode(old.permissionMode) && old.permissionMode !== 'default') {
        const local = readJsonStrict(hqLocalSettingsFile(org.path));
        const shared = readJsonStrict(hqSettingsFile(org.path));
        if (!local || !shared) return false;
        const has = (d: JsonObject) => asObject(d.permissions).defaultMode !== undefined;
        if (!has(local) && !has(shared)) {
          updateHqLocalSettings(org.path, (data) => {
            const perms = asObject(data.permissions);
            perms.defaultMode = old.permissionMode;
            data.permissions = perms;
          });
        }
      }
      return true;
    } catch {
      return false;
    }
  }
}
