import { describe, expect, test } from 'vitest';
import { connect, tempStore } from './helpers.ts';

// The MCP prompts for the three main workflows.

const setup = () => connect({ store: tempStore() });

async function promptText(name: string, args: Record<string, string> = {}): Promise<string> {
  const client = await setup();
  const res = await client.getPrompt({ name, arguments: args });
  return res.messages.map(m => (m.content.type === 'text' ? m.content.text : '')).join('\n');
}

const CASES: [string, Record<string, string>][] = [
  ['adapt-profile', { role: 'Python developer' }],
  ['adapt-profile', {}],
  ['tailor-cv-and-apply', { job: '857417' }],
  ['daily-job-scan', {}],
];

describe('prompt list', () => {
  test('lists the three prompts with their arguments', async () => {
    const client = await setup();

    const { prompts } = await client.listPrompts();
    const args = Object.fromEntries(prompts.map(p => [p.name, (p.arguments ?? []).map(a => [a.name, a.required ?? false])]));

    expect(args).toEqual({
      'adapt-profile': [['role', false]],
      'tailor-cv-and-apply': [['job', true]],
      'daily-job-scan': [],
    });
    for (const p of prompts) expect(p.description).toBeTruthy();
  });
});

describe('prompt texts', () => {
  test.each(CASES)('%s %j is plain short numbered steps without semicolons', async (name, args) => {
    const text = await promptText(name, args);

    expect(text).not.toContain(';');
    expect(text).toMatch(/^1\. /m);
    expect(text).toMatch(/^2\. /m);
    for (const line of text.split('\n').filter(l => /^\d+\. /.test(l))) expect(line.split(' ').length).toBeLessThanOrEqual(40);
  });

  test.each(CASES)('%s %j names only tools that the server has', async (name, args) => {
    const client = await setup();
    const tools = new Set((await client.listTools()).tools.map(t => t.name));

    const text = await promptText(name, args);
    const named = text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [];

    expect(named.length).toBeGreaterThan(0);
    for (const tool of named) expect(tools.has(tool), tool).toBe(true);
  });

  test('adapt-profile compares with 10 to 20 competitors and proposes a diff for approval', async () => {
    const text = await promptText('adapt-profile', { role: 'Python developer' });

    expect(text).toContain('Python developer');
    for (const tool of ['get_my_profile', 'search_candidates', 'get_candidate', 'prepare_profile_update', 'submit_profile_update']) expect(text).toContain(tool);
    expect(text).toContain('10 to 20');
    expect(text).toContain('Wait for an explicit approval');
    expect(text).toContain('Never copy text from other candidates.');
    expect(text).toContain('Never add a fact that I did not confirm.');
  });

  test('adapt-profile without a role uses the position of the profile', async () => {
    const text = await promptText('adapt-profile');

    expect(text).toContain('Use the position in my profile as the target role.');
  });

  test('tailor-cv-and-apply asks for an approval before each submit', async () => {
    const text = await promptText('tailor-cv-and-apply', { job: '857417' });

    expect(text).toContain('857417');
    for (const tool of ['get_job', 'get_job_applicant_stats', 'render_cv_pdf', 'prepare_cv_upload', 'submit_cv_upload', 'prepare_application', 'submit_application']) {
      expect(text).toContain(tool);
    }
    expect(text).toContain('your own web search');
    expect(text).toContain('only true facts');
    expect(text).toContain('Wait for an explicit approval before each submit.');
  });

  test('tailor-cv-and-apply names djinni-mcp as the owner of the daily limit', async () => {
    const text = await promptText('tailor-cv-and-apply', { job: '857417' });

    expect(text).toContain('djinni-mcp sends at most 15 applications in one Europe/Kyiv day.');
    expect(text).not.toContain('djinni allows');
  });

  test('tailor-cv-and-apply asks whether to keep the current CV before the CV steps', async () => {
    const text = await promptText('tailor-cv-and-apply', { job: '857417' });

    const ask = text.indexOf('7. Ask me if I want a new CV for this job or my current CV. If I want my current CV, go to step 12.');
    expect(ask).toBeGreaterThan(0);
    expect(ask).toBeLessThan(text.indexOf('8. Write a CV in Markdown'));
    expect(text).toMatch(/^11\. Wait for an explicit approval\. Then call submit_cv_upload\.$/m);
    expect(text).toMatch(/^12\. Write a short cover letter/m);
  });

  test('the prompts use active voice', async () => {
    const client = await setup();
    const { prompts } = await client.listPrompts();
    const texts = [await promptText('tailor-cv-and-apply', { job: '1' }), JSON.stringify(prompts)];

    for (const text of texts) {
      expect(text).not.toContain('cannot be taken back');
      expect(text).not.toContain(' is used');
    }
  });

  test('daily-job-scan checks the watches and ranks the new jobs against the profile', async () => {
    const text = await promptText('daily-job-scan');

    for (const tool of ['check_watches', 'get_my_profile']) expect(text).toContain(tool);
    expect(text).toContain('the reason');
  });
});
