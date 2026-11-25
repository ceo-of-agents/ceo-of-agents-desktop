import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { cleanAnswers, toAnswersYaml, type SetupAnswers } from '../../src/shared/setup';

const EXAMPLES = path.join(__dirname, '..', 'fixtures', 'setup-answers');

function base(over: Partial<SetupAnswers> = {}): SetupAnswers {
  return {
    schema: 'setup-answers/1',
    language: { chat: 'en', files: 'en' },
    org: { purpose: 'product', level: 'company', id: 'ACME', name: 'Acme' },
    ceo: { profile: 'technical' },
    about: { what: 'A thing', why: 'Because', stage: 'building' },
    departments: [{ from: 'catalog', id: 'engineering' }],
    names: { cos: 'Chief of staff', ceo: 'later', departments: { engineering: 'Max' } },
    gates: 'accept',
    models: { cos: 'opus', departments: 'opus' },
    remote: { hq: 'none' },
    attribution: 'default',
    enable_plugin: true,
    ...over,
  };
}

const roundTrip = (a: SetupAnswers): unknown => parse(toAnswersYaml(a));

/** The keys the app does not collect (`services`, a catalog department's `changes`) are not rendered. */
function normalize(raw: Record<string, unknown>): Record<string, unknown> {
  const o = { ...raw };
  delete o.services;
  o.departments = (o.departments as Array<Record<string, unknown>>).map((d) => {
    const c = { ...d };
    if (c.from === 'catalog') delete c.changes;
    if (c.from === 'custom') delete c.commands;
    return c;
  });
  const names = { ...(o.names as Record<string, unknown>) };
  delete names.agents;
  o.names = names;
  const pr = o.policies_repo as Record<string, unknown> | undefined;
  if (pr) o.policies_repo = { path: pr.path, remote: pr.remote };
  return o;
}

describe('toAnswersYaml', () => {
  const files = fs.existsSync(EXAMPLES) ? fs.readdirSync(EXAMPLES).filter((f) => f.endsWith('.yaml')) : [];
  it.skipIf(files.length === 0)('finds the sample answers', () => expect(files.length).toBeGreaterThan(0));
  for (const f of files) {
    it(`round-trips the example ${f}`, () => {
      const raw = parse(fs.readFileSync(path.join(EXAMPLES, f), 'utf8')) as Record<string, unknown>;
      const answers = cleanAnswers(raw as unknown as SetupAnswers);
      const back = roundTrip(answers) as Record<string, unknown>;
      expect(back).toEqual(JSON.parse(JSON.stringify(normalize(answers as unknown as Record<string, unknown>))));
    });
  }

  it('writes the schema first and keeps the schema key order', () => {
    const keys = Object.keys(parse(toAnswersYaml(base())) as object);
    expect(keys.slice(0, 4)).toEqual(['schema', 'language', 'org', 'ceo']);
    expect(keys.at(-1)).toBe('enable_plugin');
  });

  it('quotes words and shapes a YAML 1.1 reader would turn into a boolean, number, date or null', () => {
    const odd = ['no', 'yes', 'on', 'off', 'Y', 'NULL', '~', '1.0', '12', '2026-01-01', '0x1F', ''];
    const a = base({ language: { chat: 'no', files: 'en' }, org: { purpose: 'product', level: 'company', id: 'ON', name: 'NO' }, about: { what: 'yes', why: '1.0', stage: '2026-01-01' } });
    const text = toAnswersYaml(a);
    expect(text).toContain('chat: "no"');
    expect(text).toContain('id: "ON"');
    expect(text).toContain('name: "NO"');
    expect(text).toContain('what: "yes"');
    expect(text).toContain('why: "1.0"');
    expect(text).toContain('stage: "2026-01-01"');
    // Read as YAML 1.1 would: every one of these stays a string for the `yaml` reader too.
    for (const v of odd) {
      const back = parse(toAnswersYaml(base({ about: { what: v, why: 'w', stage: 's' } }))) as { about: { what: unknown } };
      expect(back.about.what).toBe(v);
      expect(toAnswersYaml(base({ about: { what: v, why: 'w', stage: 's' } }))).toMatch(/what: ""|what: "/);
    }
  });

  it('does not quote plain words', () => {
    expect(toAnswersYaml(base())).toContain('what: A thing');
  });

  it('writes multi-line text as a block literal and reads it back', () => {
    const what = '- one\n- two: "x"\n  indented\n';
    const text = toAnswersYaml(base({ about: { what, why: 'w', stage: 's' } }));
    expect(text).toMatch(/what: \|/);
    expect((parse(text) as { about: { what: string } }).about.what).toBe(what);
    const noTrailing = 'a\nb';
    expect((roundTrip(base({ about: { what: noTrailing, why: 'w', stage: 's' } })) as { about: { what: string } }).about.what).toBe(noTrailing);
  });

  it('double-quotes multi-line text with control characters instead of a block', () => {
    const what = 'a\nb\u0007';
    const text = toAnswersYaml(base({ about: { what, why: 'w', stage: 's' } }));
    expect(text).not.toMatch(/what: \|/);
    expect((parse(text) as { about: { what: string } }).about.what).toBe(what);
  });

  it('leaves out empty gates changes and empty model extras, and unset keys', () => {
    const out = roundTrip(base({ gates: { stricter: {}, looser: {} }, models: { cos: 'opus', departments: 'opus', overrides: {}, top_workers: [] } })) as Record<string, unknown>;
    expect(out.gates).toBe('accept');
    expect(out.models).toEqual({ cos: 'opus', departments: 'opus' });
    expect('destructive' in out).toBe(false);
    expect('policy' in out).toBe(false);
  });

  it('renders gate changes and object answers', () => {
    const a = base({
      gates: { stricter: { 'open-pr': 'ok' }, looser: { merge: 'free' } },
      policy: { repo: '', local: '/p', pin: '1234567' },
      attribution: { commit: 'c\nd', pr: 'p' },
      roadmap: { url: 'https://github.com/orgs/a/projects/1', status_field: 'Status' },
    });
    const out = roundTrip(a) as Record<string, unknown>;
    expect(out.gates).toEqual({ stricter: { 'open-pr': 'ok' }, looser: { merge: 'free' } });
    expect(out.policy).toEqual({ repo: '', local: '/p', pin: '1234567' });
    expect(out.attribution).toEqual({ commit: 'c\nd', pr: 'p' });
  });

  it('quotes a pin made only of digits so it stays a string', () => {
    const out = roundTrip(base({ policy: { repo: 'r', local: '/p', pin: '1234567' } })) as { policy: { pin: unknown } };
    expect(out.policy.pin).toBe('1234567');
    expect(toAnswersYaml(base({ policy: { repo: 'r', local: '/p', pin: '1234567' } }))).toContain('pin: "1234567"');
  });
});

describe('cleanAnswers', () => {
  const extras = {
    policy: 'none' as const,
    employer_rules: 'later',
    policies_repo: { path: '/x', remote: 'none' },
    repos: [{ slug: 'a/b', role: 'code', visibility: 'private' as const, protected: false, exists: true }],
    issues_home: 'a/b',
    roadmap: 'none' as const,
  };
  const full = (org: SetupAnswers['org'], remote: SetupAnswers['remote'] = { hq: 'none', hosted_on: 'personal' }) => base({ org, remote, ...extras });
  const keys = (a: SetupAnswers) => Object.keys(a).filter((k) => ['policy', 'employer_rules', 'policies_repo', 'repos', 'issues_home', 'roadmap'].includes(k)).sort();

  it('product at company level keeps policy, repos, issues_home and roadmap only', () => {
    const c = cleanAnswers(full({ purpose: 'product', level: 'company', id: 'AB', name: 'n' }));
    expect(keys(c)).toEqual(['issues_home', 'policy', 'repos', 'roadmap']);
    expect(c.remote).toEqual({ hq: 'none' });
  });
  it('job keeps employer_rules and hosted_on, and no policy or repos', () => {
    const c = cleanAnswers(full({ purpose: 'job', level: 'company', id: 'AB', name: 'n' }));
    expect(keys(c)).toEqual(['employer_rules', 'issues_home', 'repos', 'roadmap']);
    expect(c.remote.hosted_on).toBe('personal');
  });
  it('personal keeps none of them', () => {
    const c = cleanAnswers(full({ purpose: 'personal', level: 'company', id: 'AB', name: 'n' }));
    expect(keys(c)).toEqual([]);
  });
  it('a holding keeps only policies_repo', () => {
    const c = cleanAnswers(full({ purpose: 'company', level: 'holding', id: 'AB', name: 'n' }));
    expect(keys(c)).toEqual(['policies_repo']);
  });
  it('drops issues_home when repos is not a list, and does not mutate the input', () => {
    const input = base({ repos: 'none', issues_home: 'x' });
    expect(cleanAnswers(input).issues_home).toBeUndefined();
    expect(input.issues_home).toBe('x');
  });
});
