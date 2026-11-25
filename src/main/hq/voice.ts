// The CEO's voice file: the path `ceo.voice` of org.yaml names (plugin schema `voice/1`), default `company/ceo-voice.md`.
// Same pattern as the org icon: a file in the hq working tree that the app reads and writes; it never commits or pushes it
// and keeps nothing in userData. Every read and write refuses links below the hq and paths outside it. Never throws.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_VOICE_PATH, MAX_VOICE_FILE } from '../../shared/voice';
import type { VoiceInfo, VoiceSaveResult } from '../../shared/types';

const MAX_ORG_YAML = 256 * 1024;

export interface VoiceLocation {
  /** Relative path in the hq, with `/` separators. */
  path: string;
  /** `ceo.voice` is set but is not a usable path inside the hq (`invalidPath`), or the path is not a `.md` file (`notMarkdown`). */
  error?: 'invalidPath' | 'notMarkdown';
}

/** Version token of a file's content: sha256 in hex, or `missing` when there is no file. */
export function versionOf(content: Buffer | null): string {
  return content === null ? MISSING : crypto.createHash('sha256').update(content).digest('hex');
}
const MISSING = 'missing';

/** A relative path inside the hq: no absolute path, no `..`, no `.git`, no empty or control-character parts; null otherwise. */
export function cleanRelativePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  // eslint-disable-next-line no-control-regex
  if (!raw || raw.length > 200 || /[\u0000-\u001f\u007f]/.test(raw) || raw.startsWith('/') || raw.startsWith('~') || raw.includes('\\')) return null;
  const parts = raw.split('/').filter((p) => p !== '.' && p !== '');
  if (parts.length === 0 || parts.some((p) => p === '..' || p === '.git')) return null;
  return parts.join('/');
}

/** Where the voice file is: `ceo.voice` of org.yaml when set (a string path), else `company/ceo-voice.md` (the plugin uses it either way). */
export function voiceLocation(hqPath: string): VoiceLocation {
  const fallback: VoiceLocation = { path: DEFAULT_VOICE_PATH };
  try {
    const file = path.join(hqPath, 'org.yaml');
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_ORG_YAML) return fallback;
    const doc: unknown = parseYaml(fs.readFileSync(file, 'utf8'));
    const ceo = doc && typeof doc === 'object' ? (doc as Record<string, unknown>).ceo : null;
    const voice = ceo && typeof ceo === 'object' ? (ceo as Record<string, unknown>).voice : null;
    if (voice === null || voice === undefined || voice === '') return fallback;
    const rel = cleanRelativePath(voice);
    if (!rel) return { ...fallback, error: 'invalidPath' };
    return /\.md$/i.test(rel) ? { path: rel } : { path: rel, error: 'notMarkdown' };
  } catch {
    return fallback;
  }
}

/** The file's real path when every part below the hq is a plain folder or file (no link) and it stays inside the hq. */
function plainPath(hqPath: string, rel: string, mustExist: boolean): { dir: string; file: string; exists: boolean } | null {
  const realHq = fs.realpathSync(hqPath);
  const parts = rel.split('/');
  let cur = realHq;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch {
      if (mustExist) return null;
      // The rest does not exist yet: only plain folders will be created below the last real one.
      return { dir: path.dirname(path.join(realHq, rel)), file: path.join(realHq, rel), exists: false };
    }
    const last = i === parts.length - 1;
    if (st.isSymbolicLink() || (last ? !st.isFile() : !st.isDirectory())) return null;
  }
  return { dir: path.dirname(cur), file: cur, exists: true };
}

/** The voice file for the editor and the Draft form, with its version token. */
export function readVoice(hqPath: string): VoiceInfo {
  const loc = voiceLocation(hqPath);
  const info: VoiceInfo = { path: loc.path, exists: false, text: '', version: MISSING };
  if (loc.error) return { ...info, error: loc.error };
  try {
    const p = plainPath(hqPath, loc.path, false);
    if (!p) return { ...info, error: 'invalidPath' };
    if (!p.exists) return info;
    const st = fs.statSync(p.file);
    if (st.size > MAX_VOICE_FILE) return { ...info, exists: true, error: 'tooLarge' };
    const buf = fs.readFileSync(p.file);
    return { ...info, exists: true, text: buf.toString('utf8'), version: versionOf(buf) };
  } catch {
    return { ...info, error: 'unreadable' };
  }
}

/** The version of the file as it is on disk right now (`missing` when there is none). Null when it cannot be read. */
function currentVersion(file: string, exists: boolean): string | null {
  if (!exists) return MISSING;
  try {
    return versionOf(fs.readFileSync(file));
  } catch {
    return null;
  }
}

/**
 * Writes the voice file (atomic: a temporary file, then a rename). Creates the folders of the path when they are missing.
 * `expectedVersion` is the token `readVoice` gave: right before the write the file is read again, and a different version
 * (including a file that appeared after a missing one) is a `conflict`, nothing is written.
 */
export function writeVoice(hqPath: string, text: string, expectedVersion: string): VoiceSaveResult {
  try {
    if (typeof text !== 'string' || typeof expectedVersion !== 'string') return { ok: false, error: 'writeFailed' };
    if (Buffer.byteLength(text, 'utf8') > MAX_VOICE_FILE) return { ok: false, error: 'tooLarge' };
    const loc = voiceLocation(hqPath);
    if (loc.error) return { ok: false, error: loc.error };
    const p = plainPath(hqPath, loc.path, false);
    if (!p) return { ok: false, error: 'invalidPath' };
    fs.mkdirSync(p.dir, { recursive: true });
    // Look again after the folders exist: nothing on the way may be a link.
    const again = plainPath(hqPath, loc.path, false);
    if (!again) return { ok: false, error: 'invalidPath' };
    if (currentVersion(again.file, again.exists) !== expectedVersion) return { ok: false, error: 'conflict' };
    const tmp = `${again.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, again.file);
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // nothing to clean
      }
      return { ok: false, error: 'writeFailed' };
    }
    return { ok: true, version: versionOf(Buffer.from(text, 'utf8')) };
  } catch {
    return { ok: false, error: 'writeFailed' };
  }
}
