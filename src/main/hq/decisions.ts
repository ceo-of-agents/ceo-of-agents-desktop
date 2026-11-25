import type { DecisionCard, DecisionOption } from '../../shared/types';

const CARD_RE = /^##\s+([A-Z0-9]+-D\d+)\b/;
const OPTION_RE = /^-\s+\(([a-z0-9]+)\)\s+(.*\S)\s*$/i;
const FIELD_RE = /^-\s+(proposed_by|escalate)\s*:\s*(.*\S)?\s*$/i;

type Section = 'context' | 'options' | 'recommendation' | null;

/**
 * Every open decision card in `company/decision-queue.md`, by card code.
 * Card format (plugin schemas/decision-card.md): `## <CODE>: question`, bullet fields (status, since, urgency, proposed_by,
 * escalate), then `### Context`, `### Options` with lettered lines `- (a) text`, and `### Recommendation`.
 * A section the card lacks is empty (`''`, or no options). Context and Recommendation are kept as Markdown source.
 */
export function parseDecisionCards(md: string): Map<string, DecisionCard> {
  const out = new Map<string, DecisionCard>();
  let code: string | null = null;
  let section: Section = null;
  let card: DecisionCard | null = null;
  let context: string[] = [];
  let recommendation: string[] = [];
  const flush = () => {
    if (code && card) {
      card.context = context.join('\n').trim();
      card.recommendation = recommendation.join('\n').trim();
      out.set(code, card);
    }
    card = null;
    context = [];
    recommendation = [];
  };
  let inComment = false;
  for (const line of md.split(/\r?\n/)) {
    // The skeleton at the top of the queue sits in an HTML comment: never a card.
    if (inComment) {
      if (line.includes('-->')) inComment = false;
      continue;
    }
    if (line.includes('<!--') && !line.includes('-->')) {
      inComment = true;
      continue;
    }
    const head = CARD_RE.exec(line);
    if (head) {
      flush();
      code = head[1];
      section = null;
      card = { context: '', options: [], recommendation: '', proposedBy: null, escalate: false };
      continue;
    }
    if (!code || !card) continue;
    if (/^###\s/.test(line)) {
      section = /^###\s+Context\s*$/i.test(line) ? 'context' : /^###\s+Options\s*$/i.test(line) ? 'options' : /^###\s+Recommendation\s*$/i.test(line) ? 'recommendation' : null;
      continue;
    }
    if (/^##\s/.test(line)) {
      flush();
      code = null;
      section = null;
      continue;
    }
    if (section === null) {
      const f = FIELD_RE.exec(line.trim());
      if (f) {
        const value = (f[2] ?? '').trim();
        if (f[1].toLowerCase() === 'proposed_by') card.proposedBy = value || null;
        else card.escalate = /^holding$/i.test(value);
      }
    } else if (section === 'context') context.push(line);
    else if (section === 'recommendation') recommendation.push(line);
    else {
      const m = OPTION_RE.exec(line.trim());
      if (m) card.options.push({ key: m[1].toLowerCase(), label: m[2].replace(/\s+/g, ' ') });
      else if (/^\s+\S/.test(line) && card.options.length > 0) card.options[card.options.length - 1].label += ' ' + line.trim();
    }
  }
  flush();
  return out;
}

/** Options of each open decision card, by card code. A card with fewer than two options is not listed. */
export function parseDecisionOptions(md: string): Map<string, DecisionOption[]> {
  const out = new Map<string, DecisionOption[]>();
  for (const [code, card] of parseDecisionCards(md)) if (card.options.length >= 2) out.set(code, card.options);
  return out;
}
