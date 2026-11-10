import { describe, expect, test } from 'vitest';
import { BIN, binName } from '../../src/bin.ts';
import * as format from '../../src/cli/format.ts';
import { applyCommands } from '../../src/cli/commands/apply.ts';
import { candidateCommands } from '../../src/cli/commands/candidates.ts';
import { cvCommands } from '../../src/cli/commands/cv.ts';
import { doctorCommands } from '../../src/cli/commands/doctor.ts';
import { draftCommands } from '../../src/cli/commands/drafts.ts';
import { inboxCommands } from '../../src/cli/commands/inbox.ts';
import { jobCommands } from '../../src/cli/commands/jobs.ts';
import { profileCommands } from '../../src/cli/commands/profile.ts';
import { sessionCommands } from '../../src/cli/commands/session.ts';
import { subsCommands } from '../../src/cli/commands/subs.ts';
import { watchCommands } from '../../src/cli/commands/watch.ts';
import { tempStore } from '../helpers.ts';
import { cli } from './helpers.ts';

const COMMANDS = [
  ...sessionCommands,
  ...jobCommands,
  ...watchCommands,
  ...candidateCommands,
  ...profileCommands,
  ...cvCommands,
  ...applyCommands,
  ...subsCommands,
  ...inboxCommands,
  ...draftCommands,
  ...doctorCommands,
];
const NAMES = COMMANDS.map(c => c.name);
const GROUPS = [...new Set(NAMES.filter(n => n.includes(' ')).map(n => n.split(' ')[0]!))];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TWO_WORDS = NAMES.filter(n => n.includes(' ')).map(escape);
const ONE_WORD = NAMES.filter(n => !n.includes(' ')).map(escape);
// A command line with the bare "djinni" bin. "npx djinni-mcp apply" does not match, because "-" follows "djinni".
const BARE_COMMAND = new RegExp(
  `(?<![\\w-])djinni (?:(?:${TWO_WORDS.join('|')})(?![\\w-])|(?:${ONE_WORD.join('|')})(?=$|["'\\n]| --| <| \\[)|(?:${GROUPS.join('|')})(?= <command>|")|<command>)`,
  'm',
);

function expectNoBareBin(text: string): void {
  expect(text).not.toMatch(/npx djinni(?!-mcp)/);
  expect(text).not.toMatch(BARE_COMMAND);
}

describe('binName', () => {
  test.each([
    ['/usr/local/bin/djinni', 'djinni'],
    ['/usr/local/bin/djinni-mcp', 'npx djinni-mcp'],
    ['/project/node_modules/.bin/djinni-mcp', 'npx djinni-mcp'],
    ['/project/dist/cli/index.js', 'npx djinni-mcp'],
    [undefined, 'npx djinni-mcp'],
  ])('returns the bin to show for the script %s', (script, bin) => {
    expect(binName(script)).toBe(bin);
  });

  test('the tests run without the global alias', () => {
    expect(BIN).toBe('npx djinni-mcp');
  });
});

describe('the CLI texts name the bin that runs', () => {
  const deps = () => ({ store: tempStore(), minIntervalMs: 0 });

  test('the main usage', async () => {
    const res = await cli(['--help'], deps());

    expect(res.out).toMatch(/^Usage: npx djinni-mcp <command> \[flags\]/);
    expect(res.out).toContain('Run "npx djinni-mcp <command> --help" for the flags of a command.');
    expectNoBareBin(res.out);
  });

  // "inbox" is a group and a command. "inbox --help" prints the usage of the command.
  test.each(GROUPS.filter(g => !NAMES.includes(g)))('the usage of the group %s', async group => {
    const res = await cli([group, '--help'], deps());

    expect(res.out).toContain(`Usage: npx djinni-mcp ${group} <command> [flags]`);
    expectNoBareBin(res.out);
  });

  test.each(NAMES)('the usage of the command %s', async name => {
    const res = await cli([...name.split(' '), '--help'], deps());

    expect(res.out).toContain(`Usage: npx djinni-mcp ${name}`);
    expectNoBareBin(res.out);
  });

  test.each([[['fly']], [['jobs']], [['jobs', 'get']], [['jobs', 'get', '1', '2']], [['apply', 'prepare', '1']]])('the usage error for %j', async argv => {
    const res = await cli(argv, deps());

    expect(res.code).toBe(2);
    expect(res.err).toContain('"npx djinni-mcp');
    expectNoBareBin(res.err);
  });

  test('the hints of the human texts', () => {
    const draft = { draftId: 'D1', expiresAt: '2026-11-11T12:00:00.000Z' };
    const texts = [
      format.companyText({ name: 'Acme', url: 'u', facts: {}, links: [], description: null, hasMoreJobs: true, jobs: [] } as never),
      format.watchesText([]),
      format.watchChecksText([]),
      format.profileDraftText({ ...draft, diff: [] } as never),
      format.cvDraftText({ ...draft, file: 'f.pdf', name: 'f.pdf', size: 1 } as never),
      format.cvSubmitText({ ok: false, status: 500, message: '' } as never, 'D1'),
      format.applicationDraftText({ ...draft, preview: { jobId: '1', title: 't', company: 'c', url: 'u', message: 'm', cvId: null, cvName: null, salary: null } }),
      format.applicationSubmitText({ ok: false, status: null, message: 'The application request failed.' }, 'D1'),
      format.subscriptionDraftText({ ...draft, preview: { name: 'n' } } as never),
      format.companySubscriptionDraftText({ ...draft, preview: { company: 'c', jobId: '1', title: 't' } } as never),
      format.inboxText({ threads: [{ id: '1', unread: false, date: 'd', label: null, jobTitle: null, preview: 'p' }] } as never),
    ].join('');

    expect(texts).toContain('npx djinni-mcp apply submit D1 --resend');
    expect(texts).toContain('Read a conversation: npx djinni-mcp inbox read <thread-id>');
    expectNoBareBin(texts);
  });
});

test('the text of a rejected application gives one hint and no resend command', () => {
  const text = format.applicationSubmitText(
    { ok: false, status: 403, message: 'djinni rejected the application with HTTP 403. Make a new draft to try again.' },
    'D1',
  );

  expect(text).toBe(['djinni does not show the application (HTTP 403).', 'djinni rejected the application with HTTP 403. Make a new draft to try again.', ''].join('\n'));
});
