import { getCandidate, getSimilarCandidates, searchCandidates } from '../../core/candidates.ts';
import { print, type Command } from '../command.ts';
import { CANDIDATE_FILTER_FLAGS, candidateFiltersFromFlags } from '../filters.ts';
import { candidateListText, candidateText, similarCandidatesText } from '../format.ts';

const CANDIDATE = '<candidate>';
const CANDIDATE_HELP = 'The candidate is a hash like a49535fea6, or a djinni profile URL.';
const SESSION = 'This needs a djinni session.';

export const candidateCommands: Command[] = [
  {
    name: 'candidates search',
    summary: `Search the anonymous djinni.co candidate profiles. The result has 10 candidates for each page. ${SESSION}`,
    flags: CANDIDATE_FILTER_FLAGS,
    async run(values, _args, env) {
      const page = await searchCandidates(env.ctx, candidateFiltersFromFlags(values));
      print(env, page, () => candidateListText(page));
    },
  },
  {
    name: 'candidates get',
    args: [CANDIDATE],
    summary: `Read one anonymous candidate profile. ${SESSION} ${CANDIDATE_HELP}`,
    async run(_values, [candidate], env) {
      const detail = await getCandidate(env.ctx, candidate!);
      print(env, detail, () => candidateText(detail));
    },
  },
  {
    name: 'candidates similar',
    args: [CANDIDATE],
    summary: `Read the candidates that djinni shows as similar to a candidate. ${SESSION} ${CANDIDATE_HELP}`,
    async run(_values, [candidate], env) {
      const candidates = await getSimilarCandidates(env.ctx, candidate!);
      print(env, candidates, () => similarCandidatesText(candidates));
    },
  },
];
