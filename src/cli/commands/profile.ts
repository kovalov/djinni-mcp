import { readFileSync } from 'node:fs';
import { getMyProfile, getProfileDraft, prepareProfileUpdate, PROFILE_KEYS, submitProfileUpdate, type ProfileChanges, type ProfileKey } from '../../core/profile.ts';
import { print, terminalText, UsageError, type Command } from '../command.ts';
import { diffText, profileDraftText, profileSubmitText, profileText } from '../format.ts';
import { BIN } from '../../bin.ts';

const SESSION = 'This needs a djinni session.';
const NUMBER_KEYS = new Set<ProfileKey>(['salaryMin', 'salaryHour']);
const BOOLEAN_KEYS = new Set<ProfileKey>(['isDefender', 'hasMobilizationDeferment']);
const LIST_KEYS = new Set<ProfileKey>(['formats', 'employment', 'domainZones', 'uninterestedCompanyTypes', 'communicationLanguages']);
const YES = ['y', 'yes'];

const items = (value: string) =>
  value
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '');

// Splits "name:years" at the last colon when the part after it is a number.
function withYears(item: string): { name: string; years: number | null } {
  const i = item.lastIndexOf(':');
  const years = i < 0 ? '' : item.slice(i + 1).trim();
  if (i < 0 || years === '' || !Number.isFinite(Number(years))) return { name: item, years: null };
  return { name: item.slice(0, i).trim(), years: Number(years) };
}

// Converts the text of one --set value to the value type of the profile key.
function setValue(key: ProfileKey, value: string): unknown {
  if (NUMBER_KEYS.has(key)) {
    if (value.trim() === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new UsageError(`${key} needs a number, not "${value}".`);
    return n;
  }
  if (BOOLEAN_KEYS.has(key)) {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === 'yes') return true;
    if (v === 'false' || v === 'no') return false;
    throw new UsageError(`${key} needs true or false, not "${value}".`);
  }
  if (LIST_KEYS.has(key)) return items(value);
  if (key === 'skills') return items(value).map(withYears).map(r => ({ skill: r.name, years: r.years }));
  if (key === 'domains') return items(value).map(withYears).map(r => ({ domain: r.name, years: r.years }));
  if (key === 'languages') {
    return items(value).map(item => {
      const [code, level, ...rest] = item.split(':').map(s => s.trim());
      if (!code || !level || rest.length > 0) throw new UsageError(`languages needs items like eng:B2, not "${item}".`);
      return { code, level };
    });
  }
  if (key === 'certifications') {
    return items(value).map(item => {
      const i = item.indexOf(':');
      return i < 0 ? { name: item } : { name: item.slice(0, i).trim(), provider: item.slice(i + 1).trim() };
    });
  }
  return value;
}

function readChangesFile(file: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Cannot read the changes file ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`The file ${file} has no JSON object with profile changes.`);
  return value as Record<string, unknown>;
}

// Makes the changes from --file and the --set flags. A --set value overrides the same key of the file.
function changesFromFlags(sets: string[], file: string | undefined): ProfileChanges {
  const changes: Record<string, unknown> = file ? readChangesFile(file) : {};
  for (const set of sets) {
    const eq = set.indexOf('=');
    if (eq <= 0) throw new UsageError(`--set needs the form <key>=<value>, not "${set}".`);
    const key = set.slice(0, eq).trim();
    if (!(PROFILE_KEYS as readonly string[]).includes(key)) throw new UsageError(`Unknown profile key "${key}". The keys are: ${PROFILE_KEYS.join(', ')}.`);
    changes[key] = setValue(key as ProfileKey, set.slice(eq + 1));
  }
  return changes as ProfileChanges;
}

export const profileCommands: Command[] = [
  {
    name: 'profile show',
    summary: `Print your djinni candidate profile. With --json, the result also has the allowed values of each field. ${SESSION}`,
    async run(_values, _args, env) {
      const page = await getMyProfile(env.ctx);
      print(env, page, () => profileText(page));
    },
  },
  {
    name: 'profile prepare',
    summary:
      'Make a draft of a profile change and print the diff. This command changes nothing on djinni. ' +
      `Send the draft with "${BIN} profile submit". ` +
      'A list value replaces the full list, with comma-separated items, for example formats=remote,office or skills=CRM:2,TypeScript. ' +
      `Use the form code:level for languages, name:years for skills and domains, and name:provider for certifications. ${SESSION}`,
    flags: [
      { name: 'set', type: 'string', multiple: true, value: 'key=value', description: 'Set one profile field. Repeat the flag for more fields.' },
      { name: 'file', type: 'string', value: 'changes.json', description: 'Read the changes from a JSON object with the keys of the profile.' },
    ],
    async run(values, _args, env) {
      const sets = (values.set as string[] | undefined) ?? [];
      const file = values.file as string | undefined;
      if (sets.length === 0 && !file) throw new UsageError(`"${BIN} profile prepare" needs --set or --file.`);
      const draft = await prepareProfileUpdate(env.ctx, changesFromFlags(sets, file));
      print(env, draft, () => profileDraftText(draft));
    },
  },
  {
    name: 'profile submit',
    args: ['<draft-id>'],
    summary:
      'Send a profile draft to djinni. The command prints the diff and asks for your approval. ' +
      `Then it reads the profile again and tells which changes djinni saved. ${SESSION}`,
    flags: [{ name: 'yes', type: 'boolean', description: 'Send the draft without a question.' }],
    async run(values, [id], env) {
      if (values.yes !== true) {
        const draft = getProfileDraft(env.ctx, id!);
        const preview = terminalText(diffText(draft.diff));
        if (env.json) env.io.stderr(preview);
        else env.io.stdout(`${preview}\n`);
        const answer = await env.io.prompt('Send this change to djinni? [y/N] ');
        if (!YES.includes(answer.trim().toLowerCase())) {
          env.io.stderr('Canceled. Nothing was sent to djinni.\n');
          return 1;
        }
      }
      const result = await submitProfileUpdate(env.ctx, id!);
      print(env, result, () => profileSubmitText(result));
      return result.ok ? 0 : 1;
    },
  },
];
