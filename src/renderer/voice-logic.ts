// Pure helpers of the voice editor and the Draft form.
import type { VoiceInfo } from '../shared/types';
import { applyVoiceModel, parseVoice, touchVoiceDate, voiceAudiences, voiceChannels, voiceModel, voiceTemplate, type VoiceModel } from '../shared/voice';

/** Today's date in the user's time zone, `YYYY-MM-DD`. */
export function localDate(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** The editor's starting model: the file's, or the plugin template's (all empty) when the hq has none. */
export function initialModel(info: Pick<VoiceInfo, 'exists' | 'text'>, date: string): VoiceModel {
  return voiceModel(parseVoice(info.exists ? info.text : voiceTemplate(date)));
}

/**
 * The text to write: the file (or the template, when there is none) with the model's changes, and `last_updated` set to
 * today. Null when nothing changed and the file exists, so there is nothing to write.
 */
export function voiceSaveText(info: Pick<VoiceInfo, 'exists' | 'text'>, model: VoiceModel, date: string): string | null {
  const base = info.exists ? info.text : voiceTemplate(date);
  const next = applyVoiceModel(base, model);
  if (info.exists && next === base) return null;
  return touchVoiceDate(next, date);
}

export interface DraftOptions {
  channels: string[];
  audiences: string[];
}

/** The channel and audience names the Draft form offers (empty lists when there is no voice file). */
export function draftOptions(info: Pick<VoiceInfo, 'exists' | 'text'> | null): DraftOptions {
  return info && info.exists ? { channels: voiceChannels(info.text), audiences: voiceAudiences(info.text) } : { channels: [], audiences: [] };
}

/** The value of a choice: the picked name, or the typed text when "Other" (or no list) is in use. */
export const OTHER = '__other__';
export function choiceValue(select: string, typed: string): string {
  return select === OTHER ? typed.trim() : select;
}
