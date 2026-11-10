import { deleteDraft, listDrafts } from '../../core/drafts.ts';
import { print, type Command } from '../command.ts';
import { draftsText } from '../format.ts';

export const draftCommands: Command[] = [
  {
    name: 'drafts list',
    summary: 'List the drafts on this computer that did not expire. A draft expires 24 hours after it was made.',
    async run(_values, _args, env) {
      const drafts = listDrafts(env.ctx);
      print(
        env,
        drafts.map(({ payload: _payload, ...draft }) => draft),
        () => draftsText(drafts),
      );
    },
  },
  {
    name: 'drafts rm',
    args: ['<id>'],
    summary: 'Delete a draft from this computer. This command changes nothing on djinni.',
    async run(_values, [id], env) {
      const result = deleteDraft(env.ctx, id!);
      print(env, result, () => `Deleted the draft ${id}.\n`);
    },
  },
];
