import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type JsonObject = Record<string, unknown>;

export function asObject(v: unknown): JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as JsonObject) : {};
}

/** Reads a JSON object from a file. Returns {} when the file is missing or is not a JSON object. */
export function readJsonObject(file: string): JsonObject {
  try {
    return asObject(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return {};
  }
}

export function hqLocalSettingsFile(hqPath: string): string {
  return path.join(hqPath, '.claude', 'settings.local.json');
}

export function hqSettingsFile(hqPath: string): string {
  return path.join(hqPath, '.claude', 'settings.json');
}

/** Writes a file atomically (temp file in the same folder, then rename). */
export function writeFileAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * Edits <hq>/.claude/settings.local.json by merging: reads the file, lets `mutate` change the object
 * (return false for "nothing changed": then nothing is written), and writes it back atomically.
 * Every key `mutate` does not touch is kept. A file that exists but is not valid JSON is left alone (throws).
 */
export function updateHqLocalSettings(hqPath: string, mutate: (data: JsonObject) => boolean | void): void {
  const file = hqLocalSettingsFile(hqPath);
  let data: JsonObject = {};
  let text: string | null = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = null;
  }
  if (text !== null && text.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('settings.local.json is not valid JSON; the app did not change it.');
    }
    data = asObject(parsed);
  }
  if (mutate(data) === false) return;
  writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n');
}
