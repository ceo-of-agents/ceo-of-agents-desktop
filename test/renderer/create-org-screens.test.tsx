import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CreateOrgStep } from '../../src/renderer/create-org/CreateOrgStep';
import { FolderStep } from '../../src/renderer/create-org/FolderStep';
import { DoneView, FailedView } from '../../src/renderer/create-org/ResultViews';
import { RunView } from '../../src/renderer/create-org/RunView';
import { StepList } from '../../src/renderer/create-org/StepList';
import { AddOrgMenu } from '../../src/renderer/AddOrgMenu';
import { Welcome } from '../../src/renderer/Sidebar';
import { blankCustom, blankOwn, blankRepo, changePurposeOrLevel, emptyDraft, stepsFor, STEP_IDS, type Draft, type StepId } from '../../src/renderer/create-org-logic';
import { EMPTY_FACTS, type SetupData } from '../../src/shared/setup';
import { t } from '../../src/shared/strings';

const gate = (id: string, tier: 'free' | 'notice' | 'ok', locked = false) => ({ id, tier, meaning: `${id} meaning`, example: id, locked });
const data: SetupData = {
  pluginVersion: '0.19.0',
  catalog: [
    { id: 'engineering', role: 'Engineering', purpose: 'Code', advisory: false, personalOnly: false },
    { id: 'legal', role: 'Legal', purpose: 'Risk', advisory: true, personalOnly: false },
    { id: 'health', role: 'Health', purpose: 'Records', advisory: true, personalOnly: true },
  ],
  gates: [gate('comments', 'free'), gate('merge', 'notice'), gate('deploy', 'ok'), gate('make-payment', 'ok', true)],
  tiers: ['opus', 'sonnet', 'haiku'],
};
const noop = () => undefined;
const render = (step: Exclude<StepId, 'folder'>, draft: Draft, errors: Record<string, string> = {}) =>
  renderToStaticMarkup(<CreateOrgStep step={step} draft={draft} data={data} errors={errors} update={noop} changePurpose={noop} onEdit={noop} />);

describe('every step renders with nothing preselected', () => {
  const variants: Draft[] = [
    emptyDraft(),
    changePurposeOrLevel(emptyDraft(), { purpose: 'job' }).draft,
    changePurposeOrLevel(emptyDraft(), { purpose: 'personal' }).draft,
    changePurposeOrLevel(emptyDraft(), { purpose: 'company', level: 'holding' }).draft,
    changePurposeOrLevel(emptyDraft(), { purpose: 'product' }).draft,
  ];
  it('no radio or checkbox is checked and no text field has a value', () => {
    for (const d of variants) {
      // The purpose and level are what each variant picked: that step is the only one allowed to show a ticked card.
      for (const step of stepsFor(d).filter((s) => s !== 'folder' && s !== 'purpose-level')) {
        const html = render(step as Exclude<StepId, 'folder'>, d);
        expect(html, `${d.purpose}/${d.level} ${step}`).not.toMatch(/checked=""/);
        expect(html, `${d.purpose}/${d.level} ${step}`).not.toMatch(/<input[^>]*value="[^"]+"[^>]*type="text"/);
      }
    }
  });
  it('shows the wizard question text from the strings, not hard-coded copies', () => {
    expect(render('language-profile', emptyDraft())).toContain(t('createOrg.q.language.chat'));
    expect(render('name-id', emptyDraft())).toContain(t('createOrg.q.org.id'));
  });
});

describe('controls', () => {
  it('a suggestion is a quiet button, never a filled field', () => {
    const html = render('name-id', { ...emptyDraft(), name: 'Acme Labs' });
    expect(html).toContain(t('createOrg.useSuggestion', { suggestion: 'ACME' }));
    expect(html).not.toContain('value="ACME"');
  });
  it('personal departments carry the SUGGESTED chip, none of them ticked', () => {
    const html = render('departments', changePurposeOrLevel(emptyDraft(), { purpose: 'personal' }).draft);
    expect(html).toContain(t('createOrg.suggested'));
    expect(html).toContain('Health');
    expect(html).not.toMatch(/checked=""/);
  });
  it('a company does not offer the personal departments', () => {
    expect(render('departments', changePurposeOrLevel(emptyDraft(), { purpose: 'product' }).draft)).not.toContain('Health');
  });
  it('offers Later as a radio card where the logic allows it, and Answer later for text', () => {
    const d = changePurposeOrLevel(emptyDraft(), { purpose: 'product' }).draft;
    const html = render('repos-attribution', d);
    expect(html).toContain(t('createOrg.laterMeaning'));
    expect(html).toContain(t('createOrg.answerLater'));
  });
  it('an error links the field with aria-invalid and aria-describedby, with words and an icon', () => {
    const html = render('name-id', emptyDraft(), { 'org.name': 'createOrg.err.required' });
    expect(html).toContain('aria-invalid="true"');
    expect(html).toMatch(/aria-describedby="[^"]*co-org-name-error"/);
    expect(html).toContain(t('createOrg.err.required'));
  });
  it('repeating entries show a card with Remove and the Add buttons', () => {
    const d = { ...emptyDraft(), custom: [blankCustom()], own: [blankOwn()] };
    const html = render('departments', d);
    expect(html).toContain(t('createOrg.remove'));
    expect(html).toContain(t('createOrg.addCustom'));
    const repos = { ...changePurposeOrLevel(emptyDraft(), { purpose: 'product' }).draft };
    repos.repos = { mode: 'list', items: [blankRepo()] };
    expect(render('repos-attribution', repos)).toContain(t('createOrg.addRepo'));
  });
  it('lists the gates by group and notes an advisory department', () => {
    const d = { ...emptyDraft(), catalog: ['legal'] };
    const html = render('gates', d);
    expect(html).toContain('merge');
    expect(html).toContain(t('createOrg.n.advisory', { names: 'Legal' }));
  });
});

describe('summary', () => {
  it('has an Edit button per block, the to-do count and the plugin question with nothing ticked', () => {
    const d = { ...changePurposeOrLevel(emptyDraft(), { purpose: 'product' }).draft, name: 'Acme', id: 'ACME', language: { chat: 'en', files: 'en' }, remoteHq: { mode: 'later' as const, value: '' } };
    const html = render('summary', d);
    expect(html).toContain(t('createOrg.edit'));
    expect(html).toContain(t('createOrg.todos', { count: 1 }));
    expect(html).toContain(t('createOrg.deferred'));
    expect(html).not.toMatch(/checked=""/);
  });
});

describe('step list', () => {
  const html = (frozen: boolean) => renderToStaticMarkup(<StepList steps={stepsFor(emptyDraft())} current="about" done={['name-id']} attention={['purpose-level']} visited={['language-profile', 'purpose-level', 'name-id', 'about']} frozen={frozen} onGo={noop} />);
  it('marks the current step, done with a check and attention with a bang', () => {
    const h = html(false);
    expect(h.match(/aria-current="step"/g)).toHaveLength(1);
    expect(h).toContain(t('createOrg.needsAttention'));
    expect(h).toContain(t('prereq.status.done'));
    for (const s of STEP_IDS) expect(h).toContain(t(`createOrg.step.${s}`));
  });
  it('steps not visited yet are aria-disabled', () => {
    expect(html(false).match(/aria-disabled="true"/g)?.length).toBeGreaterThan(5);
  });
});

describe('folder, done and failed screens', () => {
  it('a folder that is not empty shows five entries and the rest', () => {
    const h = renderToStaticMarkup(<FolderStep pick={{ path: '/x/y', ok: false, entries: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }} error={null} reposGiven onChoose={noop} />);
    expect(h).toContain(t('createOrg.notEmpty'));
    expect(h).toContain(t('createOrg.moreEntries', { n: 2 }));
    expect(h).not.toContain('>f<');
    expect(h).toContain(t('createOrg.n.reposFolder'));
  });
  it('done: plugin and commit show real facts, with the install command when the plugin is missing', () => {
    const facts = { ...EMPTY_FACTS, orgYaml: true, commit: 'abc1234', orgName: 'Acme', cosName: 'Ada' };
    const h = renderToStaticMarkup(<DoneView name="Acme" cosName="Ada" folder="/x" facts={facts} todoCount={2} message={null} error={null} opening={false} onOpen={noop} onSend={noop} />);
    expect(h).toContain(t('createOrg.ready', { name: 'Acme' }));
    expect(h).toContain(t('createOrg.done.saved', { commit: 'abc1234' }));
    expect(h).toContain('claude plugin install ceo-of-agents@ceo-of-agents --scope project');
    expect(h).toContain(t('createOrg.openCos', { cosName: 'Ada' }));
    expect(h).not.toContain('id="co-reply"');
  });
  it('done without the plugin or a commit: the wizard last message and the reply box stay reachable in a fold', () => {
    const facts = { ...EMPTY_FACTS, orgYaml: true, state: true, orgName: 'Acme', cosName: 'Ada' };
    const view = (f: typeof facts) => renderToStaticMarkup(<DoneView name="Acme" cosName="Ada" folder="/x" facts={f} todoCount={2} message="Shall I install the plugin for this folder" error={null} opening={false} onOpen={noop} onSend={noop} />);
    const h = view(facts);
    expect(h).toContain(t('createOrg.lastMessage').replace("'", '&#x27;'));
    expect(h).toContain('Shall I install the plugin for this folder');
    expect(h).toContain('id="co-reply"');
    expect(h).toContain(t('composer.hint'));
    // Everything done: just the details fold, no reply box.
    const full = view({ ...facts, pluginEnabled: true, commit: 'abc1234' });
    expect(full).not.toContain('id="co-reply"');
    expect(full).toContain(t('createOrg.details'));
  });
  it('failed: the wizard text verbatim, the answers file, the terminal fallback; Try again only when allowed', () => {
    const props = { created: false, text: 'It broke at /tmp/x', answersFile: '/tmp/a.yaml', folder: '/x', steps: [], onRetry: noop, onBack: noop };
    const yes = renderToStaticMarkup(<FailedView {...props} canRetry />);
    expect(yes).toContain('It broke at /tmp/x');
    expect(yes).toContain(t('createOrg.terminal', { folder: '/x' }));
    expect(yes).toContain('<pre class="co-code">/ceo-of-agents:init-fleet /tmp/a.yaml</pre>');
    expect(yes).toContain(t('createOrg.tryAgain'));
    expect(renderToStaticMarkup(<FailedView {...props} canRetry={false} />)).not.toContain(t('createOrg.tryAgain'));
    expect(renderToStaticMarkup(<FailedView {...props} created canRetry={false} />)).toContain(t('createOrg.problems'));
  });
});

describe('run questions', () => {
  const view = (message: string) => renderToStaticMarkup(<RunView name="Acme" phase="asking" startedAt={Date.now()} facts={EMPTY_FACTS} thread={undefined} message={message} permissions={[]} onSend={noop} onStop={noop} />);
  it('order: message, Yes (primary) and No, the reply box with its label and the composer hint, then Stop', () => {
    const h = view('Do you confirm the summary?');
    const at = (x: string) => h.indexOf(x);
    expect(h).toMatch(/btn primary[^>]*>[^<]*Yes/);
    expect(at('Do you confirm the summary?')).toBeLessThan(at(t('createOrg.o.yes')));
    expect(at(t('createOrg.o.no'))).toBeGreaterThan(at(t('createOrg.o.yes')));
    expect(at(t('createOrg.replyOwn'))).toBeGreaterThan(at(t('createOrg.o.no')));
    expect(at(t('composer.hint'))).toBeGreaterThan(at('id="co-reply"'));
    expect(at(t('createOrg.send'))).toBeGreaterThan(at('id="co-reply"'));
    expect(at('co-run-foot')).toBeGreaterThan(at(t('createOrg.send')));
  });
  it('a wizard message about a folder that is not empty has no one-click Yes: only the reply box and Stop', () => {
    const h = view('The directory is not empty: it holds notes.txt. Do you want to continue?');
    expect(h).not.toContain(t('createOrg.o.yes'));
    expect(h).not.toContain(t('createOrg.o.no'));
    expect(h).toContain('id="co-reply"');
    expect(h).toContain(t('createOrg.stop'));
    expect(h).not.toContain(t('createOrg.replyOwn'));
  });
  it('a message that asks nothing has the reply box only', () => {
    const h = view('I wrote the files.');
    expect(h).not.toContain(t('createOrg.o.yes'));
    expect(h).toContain('id="co-reply"');
  });
});

describe('the folder picker messages', () => {
  it('tells the CEO to remove a .DS_Store, and refuses a link in its own words', () => {
    const ds = renderToStaticMarkup(<FolderStep pick={{ path: '/x', ok: false, entries: ['.DS_Store'] }} error={null} reposGiven={false} onChoose={noop} />);
    expect(ds).toContain(t('createOrg.dsStore'));
    const link = renderToStaticMarkup(<FolderStep pick={{ path: '/x', ok: false, entries: [], symlink: true }} error={null} reposGiven={false} onChoose={noop} />);
    expect(link).toContain(t('createOrg.symlink'));
    expect(link).not.toContain(t('createOrg.notEmpty'));
    expect(renderToStaticMarkup(<FolderStep pick={{ path: '/x', ok: false, entries: ['a'] }} error={null} reposGiven={false} onChoose={noop} />)).not.toContain(t('createOrg.dsStore'));
  });
});

describe('entry points', () => {
  it('the "+" menu is closed at first; Welcome has Create first (primary) then Open', () => {
    expect(renderToStaticMarkup(<AddOrgMenu onCreate={noop} onOpen={noop} />)).not.toContain('menuitem');
    const h = renderToStaticMarkup(<Welcome onOpen={noop} onCreate={noop} />);
    expect(h.indexOf(t('welcome.create'))).toBeGreaterThan(-1);
    expect(h.indexOf(t('welcome.create'))).toBeLessThan(h.indexOf(t('welcome.open')));
    expect(h).toMatch(/btn primary[^>]*>[^<]*Create a new org/);
  });
});
