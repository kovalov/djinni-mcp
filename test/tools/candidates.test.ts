import { afterEach, describe, expect, test } from 'vitest';
import { callTool, callToolJson, connect, fixture, loggedInStore, startFakeDjinni, tempStore, type FakeDjinni } from '../helpers.ts';

// The MCP contract of the candidate tools: names, annotations, descriptions, input validation and output shape.
// The behavior of the operations is in test/core/candidates.test.ts.

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

async function setup(routes: Parameters<typeof startFakeDjinni>[0], store = loggedInStore()) {
  djinni = await startFakeDjinni({ 'GET /my/profile/': fixture('my_profile.html'), ...routes });
  return connect({ store, baseUrl: djinni.url, minIntervalMs: 0 });
}

const dataRequests = () => djinni.requests.filter(r => r.url !== '/my/profile/');
const CANDIDATE_TOOLS = ['search_candidates', 'get_candidate', 'get_similar_candidates'];

describe('candidate tool list', () => {
  test('registers the candidate tools as read-only tools that use the network', async () => {
    const client = await setup({});
    const { tools } = await client.listTools();
    const hints = Object.fromEntries(tools.map(t => [t.name, t.annotations]));

    for (const name of CANDIDATE_TOOLS) expect(hints[name]).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });

  test('tells the agent the rules for the anonymous profiles', async () => {
    const client = await setup({});
    const { tools } = await client.listTools();

    for (const name of CANDIDATE_TOOLS) {
      const description = tools.find(t => t.name === name)!.description!;
      expect(description).toContain('The profiles are anonymous. Do not try to find out who a candidate is.');
      expect(description).toContain('compare them with the profile of the user from djinni_whoami');
      expect(description).toContain('suggest changes to the text of the user');
      expect(description).toContain('Do not copy text from other candidates into the profile of the user.');
      expect(description).not.toContain(';');
    }
  });

  test('lists the allowed filter values in the search_candidates input schema', async () => {
    const client = await setup({});
    const { tools } = await client.listTools();
    const props = tools.find(t => t.name === 'search_candidates')!.inputSchema.properties as Record<string, any>;

    expect(Object.keys(props)).toEqual([
      'keywords', 'keywords_options', 'title', 'region', 'location', 'knows_ukrainian', 'exp_from', 'exp_to', 'salary_min', 'salary_max',
      'english_level', 'language', 'language_level', 'employment', 'format', 'domain', 'domain_exclude', 'certifications', 'sortby', 'page',
    ]);
    expect(props.english_level.enum).toEqual(['no_english', 'basic', 'pre', 'intermediate', 'upper', 'fluent', 'proficient', 'native']);
    expect(props.sortby.enum).toEqual(['date', 'active', 'experience', 'salary_max', 'salary_min']);
    expect(props.domain.items.enum).toContain('fintech');
    expect(props.location.enum).toContain('kyiv');
    expect(props.english_level.description).toContain('Allowed values: no_english, basic');
    expect(props.region.type).toBe('string');
  });
});

describe('search_candidates', () => {
  test('sends the filters as the query and returns the page as JSON', async () => {
    const client = await setup({ 'GET /developers/': fixture('developers_list.html') });

    const page = await callToolJson(client, 'search_candidates', {
      keywords: 'python',
      title: ['Python', 'Golang'],
      region: 'UKR',
      english_level: 'upper',
      exp_from: 2.5,
      knows_ukrainian: true,
      domain: ['fintech', 'saas'],
      page: 2,
    });

    expect(dataRequests().map(r => r.url)).toEqual([
      '/developers/?keywords=python&title=Python%2CGolang&region=UKR&knows_ukrainian=True&exp_from=2.5&english_level=upper&domain=fintech&domain=saas&page=2',
    ]);
    expect(page).toMatchObject({ page: 1, hasNextPage: true, totalText: '1k+' });
    expect(page.candidates).toHaveLength(10);
    expect(page.candidates[0]).toMatchObject({ hash: 'a49535fea6', title: 'C++ Engineer', salary: '$3500' });
  });

  test.each([[{ english_level: 'B2' }], [{ page: 0 }], [{ exp_from: 1.3 }], [{ exp_to: 12 }], [{ salary_min: -1 }], [{ domain: ['banking'] }], [{ location: 'warsaw' }], [{ title: [''] }], [{ certifications: [''] }], [{ region: ['UKR', 'POL'] }]])(
    'rejects the input %j and sends no request',
    async args => {
      const client = await setup({});

      const res = await callTool(client, 'search_candidates', args);

      expect(res.isError).toBe(true);
      expect(res.text).toContain('Input validation error');
      expect(djinni.requests).toHaveLength(0);
    },
  );

  test('tells the agent to run djinni login when no session is saved', async () => {
    const client = await setup({}, tempStore());

    const res = await callTool(client, 'search_candidates', { keywords: 'python' });

    expect(res.isError).toBe(true);
    expect(res.text).toContain('Run in a separate terminal window: npx djinni-mcp login');
    expect(djinni.requests).toHaveLength(0);
  });
});

describe('get_candidate', () => {
  test('returns the profile as JSON', async () => {
    const client = await setup({ 'GET /q/a49535fea6/': fixture('candidate_profile.html') });

    const detail = await callToolJson(client, 'get_candidate', { candidate: '/q/a49535fea6/' });

    expect(detail).toMatchObject({ hash: 'a49535fea6', title: 'C++ Engineer', category: 'CPP' });
    expect(detail.languages).toEqual([
      { language: 'Англійська', level: 'B2 – Вище середнього' },
      { language: 'Українська', level: 'Носій мови' },
    ]);
  });

  test('returns an error result for a value without a hash', async () => {
    const client = await setup({});

    const res = await callTool(client, 'get_candidate', { candidate: 'python developer' });

    expect(res.isError).toBe(true);
    expect(res.text).toContain('has no djinni candidate hash');
    expect(djinni.requests).toHaveLength(0);
  });
});

describe('get_similar_candidates', () => {
  test('sends the HX-Request header and returns the candidates as a JSON list', async () => {
    const client = await setup({
      'GET /q/a49535fea6/': fixture('candidate_profile.html'),
      'GET /similar-candidates/q/952948/': fixture('candidate_similar.html'),
    });

    const similar = await callToolJson(client, 'get_similar_candidates', { candidate: 'a49535fea6' });

    const fragment = dataRequests().find(r => r.url.startsWith('/similar-candidates/'))!;
    expect(fragment.headers['hx-request']).toBe('true');
    expect(similar.map((c: { hash: string }) => c.hash)).toEqual(['b68a88b49c', '486bd02f61', '4a70043a44', 'c32aeedec2', '019734d3e3']);
  });
});
