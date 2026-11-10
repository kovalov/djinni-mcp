import { afterEach, describe, expect, test } from 'vitest';
import { fixture, loggedInStore, startFakeDjinni, tempStore, type FakeDjinni } from '../helpers.ts';
import { cli } from './helpers.ts';

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

const COMMANDS = ['login', 'whoami', 'jobs search', 'jobs get', 'jobs stats', 'jobs similar', 'company', 'watch add', 'watch list', 'watch rm', 'watch check', 'candidates search', 'candidates get', 'candidates similar', 'profile show', 'profile prepare', 'profile submit', 'cv list', 'cv render', 'cv import', 'cv prepare', 'cv submit', 'drafts list', 'drafts rm', 'apply prepare', 'apply submit', 'applications', 'jobs save', 'jobs unsave', 'jobs hide', 'jobs unhide', 'jobs favorites', 'subs options', 'subs prepare', 'subs prepare-company', 'subs submit', 'subs list'];

describe('help', () => {
  test.each([[['--help']], [['-h']], [['help']], [[]]])('%j prints the usage with every command', async argv => {
    const res = await cli(argv, { store: tempStore() });

    expect(res.code).toBe(0);
    expect(res.out).toMatch(/^Usage: npx djinni-mcp <command>/);
    for (const name of COMMANDS) expect(res.out).toMatch(new RegExp(`^  ${name} `, 'm'));
    expect(res.out).toContain('--json');
    expect(res.err).toBe('');
  });

  test('no help text names the bin of another npm package or the Claude Code "!" form', async () => {
    const texts = await Promise.all([[], ...COMMANDS.map(c => c.split(' '))].map(async argv => (await cli([...argv, '--help'], { store: tempStore() })).out));

    for (const text of texts) expect(text).not.toMatch(/npx djinni(?!-mcp)|! npx/);
  });

  test.each(COMMANDS.map(c => [c]))('"%s --help" prints the usage of the command', async name => {
    const res = await cli([...name.split(' '), '--help'], { store: tempStore() });

    expect(res.code).toBe(0);
    expect(res.out).toMatch(new RegExp(`^Usage: npx djinni-mcp ${name}`));
    expect(res.out).toMatch(/^  -h, --help +Print the usage\.$/m);
    expect(res.out).toMatch(/^  --json +/m);
  });

  test('lists every flag of a command with one line each', async () => {
    const res = await cli(['jobs', 'search', '--help'], { store: tempStore() });

    for (const flag of ['category', 'experience', 'location', 'language', 'salary', 'editorial', 'company', 'query', 'full-text', 'domain', 'offset']) {
      expect(res.out).toMatch(new RegExp(`^  --${flag}( <\\w+>)? +\\S.*$`, 'm'));
    }
  });

  test('"candidates search --help" lists the candidate filter flags and --page', async () => {
    const res = await cli(['candidates', 'search', '--help'], { store: tempStore() });

    for (const flag of [
      'keywords', 'keywords-options', 'title', 'region', 'location', 'knows-ukrainian', 'exp-from', 'exp-to', 'salary-min', 'salary-max',
      'english-level', 'language', 'language-level', 'employment', 'format', 'domain', 'domain-exclude', 'certifications', 'sortby', 'page',
    ]) {
      expect(res.out).toMatch(new RegExp(`^  --${flag}( <\\w+>)? +\\S.*$`, 'm'));
    }
  });

  test('"watch add --help" has the filter flags without offset', async () => {
    const res = await cli(['watch', 'add', '--help'], { store: tempStore() });

    expect(res.out).toMatch(/^  --category <ids> /m);
    expect(res.out).not.toContain('--offset');
  });

  test('a group without a command prints the commands of the group with --help', async () => {
    const res = await cli(['jobs', '--help'], { store: tempStore() });

    expect(res.code).toBe(0);
    for (const name of ['search', 'get', 'stats', 'similar']) expect(res.out).toMatch(new RegExp(`^  jobs ${name} `, 'm'));
  });
});

describe('usage errors', () => {
  test.each([
    [['fly'], /Unknown command "fly"/],
    [['jobs'], /jobs search, jobs get, jobs stats, jobs similar/],
    [['jobs', 'fly'], /Unknown command "jobs fly"/],
    [['candidates'], /candidates search, candidates get, candidates similar/],
    [['candidates', 'get'], /needs <candidate>/],
    [['jobs', 'search', '--colour', 'red'], /--colour/],
    [['jobs', 'get'], /needs <job>/],
    [['jobs', 'get', '1', '2'], /too many arguments/i],
    [['jobs', 'search', '--salary', '1000'], /salary/],
    [['jobs', 'search', '--offset'], /--offset/],
    [['watch', 'add', 'Python', '--offset', '10'], /--offset/],
  ])('%j exits with 2 and prints one line to stderr', async (argv, message) => {
    djinni = await startFakeDjinni();
    const res = await cli(argv, { store: tempStore(), baseUrl: djinni.url, minIntervalMs: 0 });

    expect(res.code).toBe(2);
    expect(res.out).toBe('');
    expect(res.err).toMatch(message);
    expect(res.err.trimEnd().split('\n')).toHaveLength(1);
    expect(res.err).toContain('--help');
    expect(djinni.requests).toHaveLength(0);
  });
});

describe('errors', () => {
  test('a command that needs a session prints the login hint when no session is saved', async () => {
    djinni = await startFakeDjinni();
    const res = await cli(['whoami'], { store: tempStore(), baseUrl: djinni.url, minIntervalMs: 0 });

    expect(res.code).toBe(1);
    expect(res.err).toBe('No djinni session. Run in a separate terminal window: npx djinni-mcp login\n');
    expect(djinni.requests).toHaveLength(0);
  });

  test('an error from djinni exits with 1 and prints one line without a stack trace', async () => {
    djinni = await startFakeDjinni({ 'GET /my/profile/': fixture('my_profile.html'), 'GET /api/jobs/857417/': { status: 500, body: 'error' } });
    const res = await cli(['jobs', 'get', '857417'], { store: loggedInStore(), baseUrl: djinni.url, minIntervalMs: 0 });

    expect(res.code).toBe(1);
    expect(res.out).toBe('');
    expect(res.err).toBe('djinni returned HTTP 500 for GET /api/jobs/857417/\n');
  });

  test('an error of the core exits with 1', async () => {
    const res = await cli(['jobs', 'get', 'python'], { store: tempStore() });

    expect(res.code).toBe(1);
    expect(res.err).toContain('has no djinni job ID');
  });

  test('a saved session that is not valid prints the login hint of the core', async () => {
    djinni = await startFakeDjinni({ 'GET /my/profile/': { status: 302, headers: { location: '/continue/' } } });
    const res = await cli(['whoami'], { store: loggedInStore(), baseUrl: djinni.url, minIntervalMs: 0 });

    expect(res.code).toBe(1);
    expect(res.err).toBe('The djinni session is not valid. Run in a separate terminal window: npx djinni-mcp login.\n');
  });
});

describe('--json', () => {
  test.each([[['whoami', '--json']], [['--json', 'whoami']]])('%j prints the core result as one pretty JSON object', async argv => {
    djinni = await startFakeDjinni({ 'GET /my/profile/': fixture('my_profile.html') });
    const res = await cli(argv, { store: loggedInStore(), baseUrl: djinni.url, minIntervalMs: 0 });

    expect(res.code).toBe(0);
    const value = JSON.parse(res.out);
    expect(value).toMatchObject({ loggedIn: true, candidateId: '100001' });
    expect(res.out).toBe(`${JSON.stringify(value, null, 2)}\n`);
  });
});
