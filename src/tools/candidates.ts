import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { getCandidate, getSimilarCandidates, searchCandidates } from '../core/candidates.ts';
import {
  CANDIDATE_DOMAIN_VALUES,
  CANDIDATE_FILTER_DESCRIPTIONS,
  CANDIDATE_LOCATION_VALUES,
  EMPLOYMENT_VALUES,
  ENGLISH_LEVEL_VALUES,
  FORMAT_VALUES,
  KEYWORDS_OPTIONS_VALUES,
  LANGUAGE_LEVEL_VALUES,
  SORTBY_VALUES,
} from '../core/filters.ts';
import { json, safely } from './result.ts';

const d = CANDIDATE_FILTER_DESCRIPTIONS;
const experience = (max: number) => z.number().min(0).max(max).multipleOf(0.5);

const filterShape = {
  keywords: z.string().optional().describe(d.keywords),
  keywords_options: z.enum(KEYWORDS_OPTIONS_VALUES).optional().describe(d.keywords_options),
  title: z.array(z.string().min(1)).optional().describe(d.title),
  region: z.string().optional().describe(d.region),
  location: z.enum(CANDIDATE_LOCATION_VALUES).optional().describe(d.location),
  knows_ukrainian: z.boolean().optional().describe(d.knows_ukrainian),
  exp_from: experience(10).optional().describe(d.exp_from),
  exp_to: experience(11).optional().describe(d.exp_to),
  salary_min: z.number().int().min(0).optional().describe(d.salary_min),
  salary_max: z.number().int().min(0).optional().describe(d.salary_max),
  english_level: z.enum(ENGLISH_LEVEL_VALUES).optional().describe(d.english_level),
  language: z.string().optional().describe(d.language),
  language_level: z.enum(LANGUAGE_LEVEL_VALUES).optional().describe(d.language_level),
  employment: z.enum(EMPLOYMENT_VALUES).optional().describe(d.employment),
  format: z.enum(FORMAT_VALUES).optional().describe(d.format),
  domain: z.array(z.enum(CANDIDATE_DOMAIN_VALUES)).optional().describe(d.domain),
  domain_exclude: z.array(z.enum(CANDIDATE_DOMAIN_VALUES)).optional().describe(d.domain_exclude),
  certifications: z.array(z.string().min(1)).optional().describe(d.certifications),
  sortby: z.enum(SORTBY_VALUES).optional().describe(d.sortby),
  page: z.number().int().min(1).optional().describe(d.page),
};

const candidateInput = z.string().describe('A candidate hash like a49535fea6, or a djinni profile URL or path like /q/a49535fea6/.');

// The same rules for all candidate tools.
const RULES =
  'The profiles are anonymous. Do not try to find out who a candidate is. ' +
  'Use the profiles to compare them with the profile of the user from djinni_whoami and to suggest changes to the text of the user. ' +
  'Do not copy text from other candidates into the profile of the user. ' +
  'This tool needs a djinni session.';

const readOnly = { readOnlyHint: true, openWorldHint: true };

export function registerCandidateTools(server: McpServer, ctx: Ctx) {
  server.registerTool(
    'search_candidates',
    {
      title: 'Search candidates',
      description:
        'Search the djinni.co candidate profiles with filters. Return the page number, the next page flag and 10 candidates for each page. ' +
        'Each candidate has a short summary and the skills of the card. Run get_candidate to read the full profile. ' +
        RULES,
      inputSchema: filterShape,
      annotations: readOnly,
    },
    safely(async args => json(await searchCandidates(ctx, args))),
  );

  server.registerTool(
    'get_candidate',
    {
      title: 'Read a candidate profile',
      description:
        'Read one djinni candidate profile. Return the skills with years, the domains, the languages, the certifications, ' +
        'the work experience, the achievements and the job expectations. ' +
        RULES,
      inputSchema: { candidate: candidateInput },
      annotations: readOnly,
    },
    safely(async ({ candidate }) => json(await getCandidate(ctx, candidate))),
  );

  server.registerTool(
    'get_similar_candidates',
    {
      title: 'Read similar candidates',
      description:
        'Read the candidates that djinni shows as similar to a candidate. For each candidate, return the hash, the URL, the title, ' +
        'the salary, the experience, a short summary and the skills. ' +
        RULES,
      inputSchema: { candidate: candidateInput },
      annotations: readOnly,
    },
    safely(async ({ candidate }) => json(await getSimilarCandidates(ctx, candidate))),
  );
}
