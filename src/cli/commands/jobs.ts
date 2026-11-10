import { getApplicantStats, getCompany, getJob, getSimilarJobs, hideJob, listFavoriteJobs, saveJob, searchJobs, unhideJob, unsaveJob } from '../../core/jobs.ts';
import { print, UsageError, type Command } from '../command.ts';
import { FILTER_FLAGS, filtersFromFlags, OFFSET_FLAG } from '../filters.ts';
import { companyText, jobsPageText, jobText, similarText, statsText } from '../format.ts';

const JOB = '<job>';
const JOB_HELP = 'The job is a job ID like 857417, or a djinni job URL.';

export const jobCommands: Command[] = [
  {
    name: 'jobs search',
    summary: 'Search the djinni.co jobs. The result has 10 jobs for each page.',
    flags: [...FILTER_FLAGS, OFFSET_FLAG],
    async run(values, _args, env) {
      const page = await searchJobs(env.ctx, filtersFromFlags(values));
      print(env, page, () => jobsPageText(page), page.warning);
    },
  },
  {
    name: 'jobs get',
    args: [JOB],
    summary: `Read one job with the full description. ${JOB_HELP}`,
    async run(_values, [job], env) {
      const detail = await getJob(env.ctx, job!);
      print(env, detail, () => jobText(detail), detail.warning);
    },
  },
  {
    name: 'jobs stats',
    args: [JOB],
    summary: `Read the statistics of the candidates who applied to a job. This needs a djinni session. ${JOB_HELP}`,
    async run(_values, [job], env) {
      const stats = await getApplicantStats(env.ctx, job!);
      print(env, stats, () => statsText(stats));
    },
  },
  {
    name: 'jobs similar',
    args: [JOB],
    summary: `Read the jobs that djinni shows as similar to a job. ${JOB_HELP}`,
    async run(_values, [job], env) {
      const jobs = await getSimilarJobs(env.ctx, job!);
      print(env, jobs, () => similarText(jobs));
    },
  },
  {
    name: 'jobs save',
    args: [JOB],
    summary: `Save a job to your favorites on djinni. This needs a djinni session. ${JOB_HELP}`,
    async run(_values, [job], env) {
      const result = await saveJob(env.ctx, job!);
      print(env, result, () => `Saved the job ${result.jobId}.\n`);
    },
  },
  {
    name: 'jobs unsave',
    args: [JOB],
    summary: `Remove a job from your favorites on djinni. This needs a djinni session. ${JOB_HELP}`,
    async run(_values, [job], env) {
      const result = await unsaveJob(env.ctx, job!);
      print(env, result, () => `Removed the job ${result.jobId} from the saved jobs.\n`);
    },
  },
  {
    name: 'jobs hide',
    args: [JOB],
    summary: `Hide a job from your djinni job lists. This needs a djinni session. ${JOB_HELP}`,
    async run(_values, [job], env) {
      const result = await hideJob(env.ctx, job!);
      print(env, result, () => `Hid the job ${result.jobId}.\n`);
    },
  },
  {
    name: 'jobs unhide',
    args: [JOB],
    summary: `Show a hidden job again in your djinni job lists. This needs a djinni session. ${JOB_HELP}`,
    async run(_values, [job], env) {
      const result = await unhideJob(env.ctx, job!);
      print(env, result, () => `The job ${result.jobId} is not hidden now.\n`);
    },
  },
  {
    name: 'jobs favorites',
    summary: 'Print the jobs that you saved on djinni. The result has 10 jobs for each page. This needs a djinni session.',
    flags: [OFFSET_FLAG],
    async run(values, _args, env) {
      const raw = values.offset as string | undefined;
      if (raw !== undefined && !/^\d+$/.test(raw.trim())) throw new UsageError('--offset must be a whole number of 0 or more.');
      const page = await listFavoriteJobs(env.ctx, { offset: raw === undefined ? undefined : Number(raw) });
      print(env, page, () => jobsPageText(page));
    },
  },
  {
    name: 'company',
    args: ['<company>'],
    summary: 'Read a company and its open jobs. The company is a slug like stellar-jet, or a djinni company URL.',
    async run(_values, [company], env) {
      const page = await getCompany(env.ctx, company!);
      print(env, page, () => companyText(page), page.warning);
    },
  },
];
