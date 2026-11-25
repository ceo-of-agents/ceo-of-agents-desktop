// The CEO's voice file (plugin schema `voice/1`, released in ceo-of-agents 0.21.0: schemas/ceo-voice.md) and the Draft
// action built on the plugin's `draft-as-ceo` skill. Pure: parsing, editing, extracting channels and audiences, the
// message the Draft form sends, and finding the draft in the agent's answer. The file lives in the hq (`ceo.voice` in
// org.yaml, default `company/ceo-voice.md`); the app only reads and writes it, it never commits it.
import { t } from './strings';
import type { ThreadEntry } from './types';

export const DEFAULT_VOICE_PATH = 'company/ceo-voice.md';
/** Largest voice file the app reads or writes. */
export const MAX_VOICE_FILE = 256 * 1024;
/** Longest pasted message the Draft form sends. */
export const MAX_DRAFT_MESSAGE = 20000;
/** Longest channel or audience name. */
export const MAX_VOICE_NAME = 60;

// ---------- the file ----------

export interface VoiceSection {
  /** The heading line as written (`## Base`). */
  heading: string;
  /** The heading text (`Base`). */
  title: string;
  /** The lines after the heading, up to the next H2 or the end. */
  lines: string[];
}

/** The file as raw pieces: nothing is dropped, so an unedited file serializes to the same bytes. */
export interface VoiceDoc {
  /** Everything before the first H2: the frontmatter and the title. */
  head: string[];
  sections: VoiceSection[];
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Per line: true when the line is inside a fenced code block or is a fence line (a heading there is not a heading). */
function fenceMask(lines: string[]): boolean[] {
  const mask: boolean[] = [];
  let open: { ch: string; len: number } | null = null;
  for (const line of lines) {
    const m = FENCE.exec(line);
    if (!open) {
      if (m && !(m[1][0] === '`' && line.slice(m[0].length).includes('`'))) {
        open = { ch: m[1][0], len: m[1].length };
        mask.push(true);
      } else mask.push(false);
    } else {
      mask.push(true);
      if (m && m[1][0] === open.ch && m[1].length >= open.len && line.slice(m[0].length).trim() === '') open = null;
    }
  }
  return mask;
}

function headingAt(line: string, level: 2 | 3): string | null {
  const m = (level === 2 ? /^##\s+(.+?)\s*#*\s*$/ : /^###\s+(.+?)\s*#*\s*$/).exec(line);
  return m ? m[1] : null;
}

export function parseVoice(text: string): VoiceDoc {
  const lines = text.split('\n');
  const mask = fenceMask(lines);
  const doc: VoiceDoc = { head: [], sections: [] };
  let cur: VoiceSection | null = null;
  lines.forEach((line, i) => {
    const title = mask[i] ? null : headingAt(line, 2);
    if (title !== null) {
      cur = { heading: line, title, lines: [] };
      doc.sections.push(cur);
    } else if (cur) cur.lines.push(line);
    else doc.head.push(line);
  });
  return doc;
}

export function serializeVoice(doc: VoiceDoc): string {
  return [...doc.head, ...doc.sections.flatMap((s) => [s.heading, ...s.lines])].join('\n');
}

const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const findSection = (doc: VoiceDoc, title: string) => doc.sections.find((s) => sameTitle(s.title, title));

// ---------- the text of a body, without its format comments ----------

const COMMENT = /<!--[\s\S]*?-->/g;

/** The text of a body as the editor shows it: the HTML format comments left out, blank lines collapsed, trimmed. */
export function editableText(body: string): string {
  return body.replace(COMMENT, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Body lines for new text: a blank line, the text, then the format comments the old body had, then a blank line. */
function bodyLines(text: string, oldBody: string): string[] {
  const comments = oldBody.match(COMMENT) ?? [];
  const parts = [text.trim(), ...comments].filter(Boolean);
  return ['', ...(parts.length ? parts.join('\n\n').split('\n') : []), ''];
}

// ---------- the editor's model ----------

/** One channel or audience: its name and its text (the rules and, for a channel, its examples). */
export interface VoiceEntry {
  name: string;
  text: string;
  /** The position of this entry in the file when it was loaded; absent for one added in the editor. */
  orig?: number;
}

export interface VoiceModel {
  base: string;
  channels: VoiceEntry[];
  audiences: VoiceEntry[];
}

interface Sub {
  heading: string;
  name: string;
  lines: string[];
}

/** A section's lines split at its H3 headings: what comes before the first one, then each subsection. */
function splitSubs(lines: string[]): { intro: string[]; subs: Sub[] } {
  const mask = fenceMask(lines);
  const intro: string[] = [];
  const subs: Sub[] = [];
  lines.forEach((line, i) => {
    const name = mask[i] ? null : headingAt(line, 3);
    if (name !== null) subs.push({ heading: line, name, lines: [] });
    else if (subs.length) subs[subs.length - 1].lines.push(line);
    else intro.push(line);
  });
  return { intro, subs };
}

const entriesOf = (section: VoiceSection | undefined): VoiceEntry[] =>
  section ? splitSubs(section.lines).subs.map((s, orig) => ({ name: s.name, text: editableText(s.lines.join('\n')), orig })) : [];

export function voiceModel(doc: VoiceDoc): VoiceModel {
  const base = findSection(doc, 'Base');
  return { base: base ? editableText(base.lines.join('\n')) : '', channels: entriesOf(findSection(doc, 'Channels')), audiences: entriesOf(findSection(doc, 'Audiences')) };
}

/** The channel names in the file, in order, without repeats. */
export function voiceChannels(text: string): string[] {
  return uniqueNames(voiceModel(parseVoice(text)).channels);
}

/** The audience names in the file, in order, without repeats. */
export function voiceAudiences(text: string): string[] {
  return uniqueNames(voiceModel(parseVoice(text)).audiences);
}

function uniqueNames(entries: VoiceEntry[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entries) {
    const n = e.name.trim();
    if (n && !seen.has(n.toLowerCase())) {
      seen.add(n.toLowerCase());
      out.push(n);
    }
  }
  return out;
}

/** A heading name from the editor: one line, no leading `#`, cut at MAX_VOICE_NAME. */
export function cleanVoiceName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim().slice(0, MAX_VOICE_NAME).trim();
}

function entryLines(e: VoiceEntry, orig: Sub | undefined): string[] {
  const name = cleanVoiceName(e.name);
  if (orig && orig.name === name && editableText(orig.lines.join('\n')) === e.text.trim()) return [orig.heading, ...orig.lines];
  return [orig && orig.name === name ? orig.heading : `### ${name}`, ...bodyLines(e.text, orig ? orig.lines.join('\n') : '')];
}

function subsLines(section: VoiceSection, entries: VoiceEntry[]): string[] {
  const { intro, subs } = splitSubs(section.lines);
  const out = [...intro];
  for (const e of entries) {
    if (!cleanVoiceName(e.name)) continue;
    out.push(...entryLines(e, e.orig !== undefined ? subs[e.orig] : undefined));
  }
  // A heading is followed by a blank line and so is the end of the section.
  return out.length === 0 ? [''] : out;
}

/** The file with the model's changes applied. Whatever the model did not change stays exactly as it was; unknown sections and the head stay. */
export function applyVoiceModel(text: string, model: VoiceModel): string {
  const doc = parseVoice(text);
  const ensure = (title: string): VoiceSection => {
    let s = findSection(doc, title);
    if (!s) {
      s = { heading: `## ${title}`, title, lines: [''] };
      doc.sections.push(s);
    }
    return s;
  };
  const base = ensure('Base');
  if (editableText(base.lines.join('\n')) !== model.base.trim()) base.lines = bodyLines(model.base, base.lines.join('\n'));
  const channels = ensure('Channels');
  channels.lines = subsLines(channels, model.channels);
  const audiences = ensure('Audiences');
  audiences.lines = subsLines(audiences, model.audiences);
  return serializeVoice(doc);
}

/** Sets `last_updated` in the frontmatter (adds the frontmatter when the file has none). */
export function touchVoiceDate(text: string, date: string): string {
  const lines = text.split('\n');
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (end > 0) {
      const at = lines.findIndex((l, i) => i > 0 && i < end && /^last_updated\s*:/.test(l));
      if (at > 0) lines[at] = `last_updated: ${date}`;
      else lines.splice(end, 0, `last_updated: ${date}`);
      return lines.join('\n');
    }
  }
  return `---\nschema: voice/1\nlast_updated: ${date}\n---\n\n${text}`;
}

/**
 * The plugin's template (templates/instance/company/ceo-voice.md of ceo-of-agents 0.22.0), used when the hq has no voice
 * file. The "How to use this file" block is fixed text the plugin owns: departments read it because they cannot load skills.
 */
export function voiceTemplate(date: string): string {
  return `---
schema: voice/1
last_updated: ${date}
---

# CEO voice

## How to use this file

Use this file only for text that goes out under the CEO's name (messages, mails, Slack, posts, slides, and GitHub pull requests, issues and comments made from the CEO's account). Never in chat with the CEO and never in hq files.

1. Build the voice in this order: Base, then the channel, then the audience. On a conflict the later one wins. There are no entries per combination.
2. Pick the channel from the request. If it does not say, take it from the pasted material (mail headers, a Slack thread). If that does not say either, ask ONE question that lists the channels in this file.
3. Pick the audience from the request or the recipient. If it is unclear, use Base and the channel only.
4. Channel mechanics. Slack: mrkdwn (\`*bold*\`), no headings, short; say whether it is a thread reply or a new message. Mail: a \`Subject:\` line, one blank line, then a plain body. GitHub: GitHub Markdown; in a public repo write nothing internal. Slides: short bullets, no full sentences.
5. Hand over the draft in exactly one fenced code block with no info string, and nothing else inside the block (if the draft contains a run of backticks, make the fence longer than the longest run, for example four backticks). Mail: the block's first line is \`Subject: <subject>\`, then one blank line, then the plain body. After the block, one short line saying which channel and audience you applied; any offer (set up the voice, add a channel section) comes after that line, outside the block.
6. Never send or post. Sending stays behind the approval gates (\`contact-people\`, \`publish\`).
7. Never invent numbers or facts. Never store raw samples of the CEO's or anyone's messages here, only the rules derived from them.
8. When the CEO corrects a draft or says it is too formal, too long and so on, propose ONE line for the right section below and add it only after a yes. A department proposes it in its handoff instead.
9. An empty or missing section never blocks: use the channel mechanics only.
10. Only the CEO decides what this file says.

## Base

<!-- One rule per line, e.g. "- Conclusion first." -->

## Channels

<!-- One "### <channel>" per channel you use (Slack, Mail, ...): only what differs from Base, then up to two examples: Example (YYYY-MM-DD): "..." -->

## Audiences

<!-- One "### <audience>" per audience (peers, management, ...): only what differs. -->
`;
}

// ---------- the Draft message ----------

/** `[channel, audience]` values as the message carries them: one line, no backtick, in a code span; empty is "(none)". */
function span(value: string): string {
  // eslint-disable-next-line no-control-regex
  const s = value.replace(/`/g, '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_VOICE_NAME);
  return `\`${s || '(none)'}\``;
}

/** A fence long enough that nothing in `text` can close it. */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

export interface DraftInput {
  channel: string;
  audience: string;
  /** The message to answer, pasted. */
  message: string;
  /** The chat is the chief of staff's (it loads skills) or a department's (it cannot, so it reads the voice file). */
  isCos: boolean;
  /** The voice file's path in the hq, when the hq names one that exists. */
  voicePath: string | null;
}

/**
 * The message the Draft form sends to the chat. The chief of staff is asked to use the plugin's `draft-as-ceo` skill (the
 * skill's own inputs are the request itself: channel, audience and the pasted material); a department cannot load skills,
 * so it is pointed at the voice file's "How to use this file" block (items 4 and 5). The draft format is the plugin's (0.22.0), not
 * the app's: the last line is only a fallback for older plugins.
 * The values are data, not instructions. The first line is `draft.msg.head`: `isDraftRequest` finds the answer by it.
 */
export function buildDraftPrompt(input: DraftInput): string {
  const message = input.message.slice(0, MAX_DRAFT_MESSAGE).trim();
  const fence = fenceFor(message);
  return [
    t('draft.msg.head'),
    t(input.isCos ? 'draft.msg.cos' : 'draft.msg.dept', { path: input.voicePath ? span(input.voicePath) : t('draft.msg.noVoice') }),
    t('draft.msg.channel', { channel: span(input.channel) }),
    t('draft.msg.audience', { audience: span(input.audience) }),
    t('draft.msg.material'),
    fence,
    message,
    fence,
    t('draft.msg.format'),
  ].join('\n');
}

// ---------- the draft in the answer ----------

/** A user message that is a Draft request (it starts with the fixed first line). */
export function isDraftRequest(text: string): boolean {
  return text.split('\n', 1)[0].trim() === t('draft.msg.head');
}

/**
 * The first complete draft block of a text: its content as written, or null. The plugin's draft format is a fence of three
 * or more backticks with no info string; the closing fence is backticks at least as long as the opening one (CommonMark),
 * so shorter runs inside are content. A block with an info string, or a tilde fence, is not a draft and is skipped.
 */
export function firstFencedBlock(text: string): string | null {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE.exec(lines[i]);
    if (!m || (m[1][0] === '`' && lines[i].slice(m[0].length).includes('`'))) continue;
    const plain = m[1][0] === '`' && lines[i].slice(m[0].length).trim() === '';
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const c = FENCE.exec(lines[j]);
      if (c && c[1][0] === m[1][0] && c[1].length >= m[1].length && lines[j].slice(c[0].length).trim() === '') {
        end = j;
        break;
      }
    }
    if (end < 0) return null; // an opening fence that never closes: not a finished block
    if (plain) return lines.slice(i + 1, end).join('\n');
    i = end; // a block that is not a draft (info string, tildes): look after it
  }
  return null;
}

export interface DraftResult {
  /** The text to copy as a whole (for mail, the subject line and the body together). */
  text: string;
  /** Mail: the `Subject:` value, copied apart. */
  subject: string | null;
  /** Mail: the body after the subject line; otherwise the same as `text`. */
  body: string;
}

/**
 * The draft in a block's content. Mail (the plugin's format) is split only when the first line is `Subject: <subject>` and
 * the second line is blank: the subject is the text after `Subject: `, the body starts on line 3. Otherwise one copy.
 */
export function draftFromBlock(block: string): DraftResult | null {
  const text = block.replace(/^\n+/, '').replace(/\s+$/, '');
  if (!text.trim()) return null;
  const lines = text.split('\n');
  const m = /^Subject: (.*)$/.exec(lines[0]);
  if (!m || !m[1].trim() || lines.length < 3 || lines[1].trim() !== '') return { text, subject: null, body: text };
  return { text, subject: m[1].trim(), body: lines.slice(2).join('\n') };
}

/**
 * The drafts of a thread, by the id of the assistant entry that holds them: an assistant message that follows a Draft
 * request (no other user message in between) and holds a fenced block. Without a block there is no draft to copy.
 */
export function draftResults(entries: ThreadEntry[]): Map<string, DraftResult> {
  const out = new Map<string, DraftResult>();
  let asked = false;
  for (const e of entries) {
    if (e.kind === 'user') asked = isDraftRequest(e.text);
    else if (e.kind === 'assistant' && asked) {
      const block = firstFencedBlock(e.text);
      const draft = block === null ? null : draftFromBlock(block);
      if (draft) out.set(e.id, draft);
    }
  }
  return out;
}
