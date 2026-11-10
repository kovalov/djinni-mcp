import { checkWatches, createWatch, deleteWatch, listWatches } from '../../core/watches.ts';
import { print, type Command } from '../command.ts';
import { FILTER_FLAGS, filtersFromFlags } from '../filters.ts';
import { watchChecksText, watchesText } from '../format.ts';

export const watchCommands: Command[] = [
  {
    name: 'watch add',
    args: ['<name>'],
    summary: 'Save a job watch on this computer. A watch is a saved set of job filters. This command changes nothing on djinni.',
    flags: FILTER_FLAGS,
    async run(values, [name], env) {
      // A watch always reads from the newest job, so it has no offset.
      const watch = createWatch(env.ctx, name!, filtersFromFlags(values, { allowOffset: false }));
      print(env, watch, () => `Created the watch ${watch.id} "${watch.name}".\n`);
    },
  },
  {
    name: 'watch list',
    summary: 'List the job watches of this computer.',
    async run(_values, _args, env) {
      const watches = listWatches(env.ctx);
      print(env, watches, () => watchesText(watches));
    },
  },
  {
    name: 'watch rm',
    args: ['<id>'],
    summary: 'Delete a job watch and its list of seen jobs from this computer.',
    async run(_values, [id], env) {
      const result = deleteWatch(env.ctx, id!);
      print(env, result, () => `Deleted the watch ${id}.\n`);
    },
  },
  {
    name: 'watch check',
    args: ['[<id>]'],
    summary:
      'Check the job watches for new jobs, or only the watch with the given ID. The new jobs become seen. ' +
      'The command exits with 1 when the check of a watch fails. You can run it from cron.',
    flags: [{ name: 'no-mark-seen', type: 'boolean', description: 'Keep the returned jobs as not seen.' }],
    async run(values, [id], env) {
      const results = await checkWatches(env.ctx, { id, markSeen: values['no-mark-seen'] !== true });
      print(env, results, () => watchChecksText(results), results[0]?.warning);
      return results.some(r => 'error' in r) ? 1 : 0;
    },
  },
];
