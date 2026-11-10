import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { EDITORIAL_VALUES, EXPERIENCE_VALUES, FILTER_DESCRIPTIONS, LANGUAGE_VALUES, SALARY_VALUES } from '../core/filters.ts';
import { getApplicantStats, getCompany, getJob, getSimilarJobs, hideJob, listFavoriteJobs, saveJob, searchJobs, unhideJob, unsaveJob } from '../core/jobs.ts';
import { checkWatches, createWatch, deleteWatch, listWatches } from '../core/watches.ts';
import { json, safely } from './result.ts';

const d = FILTER_DESCRIPTIONS;
const filterShape = {
  category: z.array(z.string()).optional().describe(d.category),
  experience: z.array(z.literal(EXPERIENCE_VALUES)).optional().describe(d.experience),
  location: z.array(z.string()).optional().describe(d.location),
  language: z.array(z.enum(LANGUAGE_VALUES)).optional().describe(d.language),
  salary: z.literal(SALARY_VALUES).optional().describe(d.salary),
  editorial: z.enum(EDITORIAL_VALUES).optional().describe(d.editorial),
  company_name: z.string().optional().describe(d.company_name),
  query: z.string().optional().describe(d.query),
  full_text: z.boolean().optional().describe(d.full_text),
  domain: z.string().optional().describe(d.domain),
};

const jobInput = z.string().describe('A job ID like 857417, or a djinni job URL or path.');

const readOnly = { readOnlyHint: true, openWorldHint: true };
const localWrite = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
// A small change on djinni that the user can undo with the opposite tool.
const djinniToggle = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export function registerJobTools(server: McpServer, ctx: Ctx) {
  server.registerTool(
    'search_jobs',
    {
      title: 'Search jobs',
      description:
        'Search the djinni.co jobs with filters. Return the total count, the next page flag and 10 jobs for each page. ' +
        'Each job has a short description. Run get_job to read the full description. ' +
        'With a djinni session, the result has no jobs that the user hid. The hiddenOmitted field gives the number of hidden jobs that the result does not show.',
      inputSchema: {
        ...filterShape,
        offset: z.number().int().min(0).optional().describe(d.offset),
      },
      annotations: readOnly,
    },
    safely(async args => json(await searchJobs(ctx, args))),
  );

  server.registerTool(
    'get_job',
    {
      title: 'Read a job',
      description:
        'Read one djinni job. Return the full description, the required skills, the languages, the company text, the recruiter ' +
        'and the apply status of the user. After you read the job, you can research the company and the requirements with your own web search.',
      inputSchema: { job: jobInput },
      annotations: readOnly,
    },
    safely(async ({ job }) => json(await getJob(ctx, job))),
  );

  server.registerTool(
    'get_job_applicant_stats',
    {
      title: 'Read the applicant statistics of a job',
      description:
        'Read the statistics of the candidates who applied to a djinni job. Return the top skills of the candidates and each distribution, ' +
        'for example of experience and of English level. In a distribution, the bucket of the user has the value true in the "you" field. ' +
        'If the job has no applicants, the result has no statistics and the note field tells this. ' +
        'This tool needs a djinni session.',
      inputSchema: { job: jobInput },
      annotations: readOnly,
    },
    safely(async ({ job }) => json(await getApplicantStats(ctx, job))),
  );

  server.registerTool(
    'get_similar_jobs',
    {
      title: 'Read similar jobs',
      description:
        'Read the jobs that djinni shows as similar to a job. For each job, return the ID, the URL, the title, the company, ' +
        'the relative salary level, a short description and the published date text.',
      inputSchema: { job: jobInput },
      annotations: readOnly,
    },
    safely(async ({ job }) => json(await getSimilarJobs(ctx, job))),
  );

  server.registerTool(
    'get_company',
    {
      title: 'Read a company',
      description:
        'Read a djinni company. Return the description, the facts, the links and the open jobs of the company from the first page of the djinni search. ' +
        'To read more jobs of the company, run search_jobs with the company_name filter. The company_name filter also finds companies with a similar name.',
      inputSchema: { company: z.string().describe('A company slug like stellar-jet, or a djinni company URL or path.') },
      annotations: readOnly,
    },
    safely(async ({ company }) => json(await getCompany(ctx, company))),
  );

  server.registerTool(
    'create_watch',
    {
      title: 'Create a job watch',
      description:
        'Save a job watch on this computer. A watch is a saved set of job filters. Run check_watches to get the new jobs of the watches. ' +
        'This tool changes nothing on djinni.',
      inputSchema: {
        name: z.string().min(1).describe('A short name for the watch.'),
        filters: z.object(filterShape).describe('The job filters. They are the same as the filters of search_jobs, without offset.'),
      },
      annotations: localWrite,
    },
    safely(async ({ name, filters }) => json(createWatch(ctx, name, filters))),
  );

  server.registerTool(
    'list_watches',
    {
      title: 'List the job watches',
      description: 'Return all job watches from this computer.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safely(async () => json(listWatches(ctx))),
  );

  server.registerTool(
    'delete_watch',
    {
      title: 'Delete a job watch',
      description: 'Delete a job watch and its list of seen jobs from this computer. This tool changes nothing on djinni.',
      inputSchema: { id: z.string().describe('The watch ID from list_watches.') },
      annotations: { ...localWrite, destructiveHint: true },
    },
    safely(async ({ id }) => json(deleteWatch(ctx, id))),
  );

  server.registerTool(
    'check_watches',
    {
      title: 'Check the job watches',
      description:
        'Check the job watches for new jobs. For each watch, return the jobs that the user did not see before. ' +
        'On the first check of a watch, firstCheck is true and the result has the newest jobs, at most 50, not only new jobs. Tell this to the user. ' +
        'If the check of one watch fails, the result of that watch has an error field and its jobs stay not seen. ' +
        'With a djinni session, the result has no jobs that the user hid. ' +
        'You can run this tool on a schedule to monitor the jobs.',
      inputSchema: {
        id: z.string().optional().describe('The ID of one watch. If you do not set it, the tool checks all watches.'),
        markSeen: z.boolean().optional().describe('Set to false to keep the returned jobs as not seen. The default is true.'),
      },
      // The tool writes the seen jobs and the check time to local files.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safely(async ({ id, markSeen }) => json(await checkWatches(ctx, { id, markSeen }))),
  );

  server.registerTool(
    'save_job',
    {
      title: 'Save a job',
      description: 'Save a job to the favorites of the user on djinni. Run unsave_job to remove it. This tool needs a djinni session.',
      inputSchema: { job: jobInput },
      annotations: djinniToggle,
    },
    safely(async ({ job }) => json(await saveJob(ctx, job))),
  );

  server.registerTool(
    'unsave_job',
    {
      title: 'Remove a saved job',
      description: 'Remove a job from the favorites of the user on djinni. This tool needs a djinni session.',
      inputSchema: { job: jobInput },
      annotations: djinniToggle,
    },
    safely(async ({ job }) => json(await unsaveJob(ctx, job))),
  );

  server.registerTool(
    'hide_job',
    {
      title: 'Hide a job',
      description: 'Hide a job from the djinni job lists of the user. Run unhide_job to show it again. This tool needs a djinni session.',
      inputSchema: { job: jobInput },
      annotations: djinniToggle,
    },
    safely(async ({ job }) => json(await hideJob(ctx, job))),
  );

  server.registerTool(
    'unhide_job',
    {
      title: 'Show a hidden job',
      description: 'Show a hidden job again in the djinni job lists of the user. This tool needs a djinni session.',
      inputSchema: { job: jobInput },
      annotations: djinniToggle,
    },
    safely(async ({ job }) => json(await unhideJob(ctx, job))),
  );

  server.registerTool(
    'list_favorite_jobs',
    {
      title: 'List the saved jobs',
      description:
        'Return a page of the jobs that the user saved on djinni. A page has at most 10 jobs. Return the total count and the next page flag. ' +
        'This tool needs a djinni session.',
      inputSchema: { offset: z.number().int().min(0).optional().describe(d.offset) },
      annotations: readOnly,
    },
    safely(async ({ offset }) => json(await listFavoriteJobs(ctx, { offset }))),
  );
}
