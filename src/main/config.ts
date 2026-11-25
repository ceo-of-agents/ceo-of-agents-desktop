// Product constants. No personal paths or names here.

/** Claude Code versions this app was tested with. Outside this range the app refuses to start sessions. */
export const SUPPORTED_CLAUDE = { min: '2.1.326', maxExclusive: '2.2.0' } as const;

/** Set to 1 to start sessions with an unsupported Claude Code version (development only). */
export const ALLOW_UNSUPPORTED_ENV = 'COA_ALLOW_UNSUPPORTED_CLAUDE';

export const PLUGIN_ID = 'ceo-of-agents@ceo-of-agents';
export const PLUGIN_MARKETPLACE_NAME = 'ceo-of-agents';
/** GitHub slug of the plugin's public repo (marketplace source and releases). */
export const PLUGIN_REPO = 'ceo-of-agents/ceo-of-agents-core';
/** GitHub source of the plugin marketplace (public repo). */
export const PLUGIN_MARKETPLACE_SOURCE = PLUGIN_REPO;
/** Public API URL of the plugin's latest GitHub release (no auth needed). */
export const PLUGIN_LATEST_RELEASE_URL = `https://api.github.com/repos/${PLUGIN_REPO}/releases/latest`;
/** GitHub slug of this app's own public repo: its releases carry the .dmg the in-app update installs. */
export const APP_REPO = 'ceo-of-agents/ceo-of-agents-desktop';
/** Oldest plugin version the app works with. */
export const MIN_PLUGIN_VERSION = '0.13.0';

/**
 * Until the plugin pre-allows its own skills (plugin issue #62), the app passes this rule. Claude Code already runs common
 * read-only commands and reads inside the working folder without asking, so the app adds no baseline of its own.
 */
export const ALLOWED_TOOLS = ['Skill(ceo-of-agents:*)'];

// Undocumented Claude Code variable that turns on the artifact tools in `claude -p`; checked with Claude Code 2.1.328, re-check on every `SUPPORTED_CLAUDE` move.
export const ARTIFACT_ENV = 'CLAUDE_CODE_ARTIFACT';

/** Development overrides, read from the environment. */
export const DEV = {
  /** Path to the claude binary. */
  claudeBin: process.env.COA_CLAUDE_BIN || null,
  /** --model for every session (for example haiku in live checks). */
  model: process.env.COA_MODEL || null,
  /** --plugin-dir for every session (hq copies where the plugin is not installed for the folder). */
  pluginDir: process.env.COA_PLUGIN_DIR || null,
  /** Data folder override (live checks use a temp folder). */
  userData: process.env.COA_USER_DATA || null,
  /** Folder searched at first launch instead of the home folder (live checks point it at a temp folder). */
  scanRoot: process.env.COA_SCAN_ROOT || null,
};
