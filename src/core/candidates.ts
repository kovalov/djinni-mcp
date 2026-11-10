import type { Ctx } from '../context.ts';
import {
  candidateUrl,
  parseCandidate,
  parseCandidateList,
  parseSimilarCandidates,
  similarCandidatesPath,
  type CandidateDetail,
  type CandidateList,
  type CandidateSummary,
} from '../parsers/candidates.ts';
import { CANDIDATE_FILTER_DESCRIPTIONS, type CandidateFilters } from './filters.ts';

// All candidate operations only read data. They need a valid djinni session.

// Returns the hash of a candidate profile from a hash, a profile URL or a profile path.
// A hash has only the characters 0-9 and a-f, so it cannot change the request path.
export function candidateHash(input: string): string {
  const value = input.trim();
  const hash = /^[0-9a-f]+$/.test(value) ? value : /\/q\/([0-9a-f]+)(?:[/?#]|$)/.exec(value)?.[1];
  if (!hash) throw new Error(`"${input}" has no djinni candidate hash. Use a hash like a49535fea6, or a profile URL.`);
  return hash;
}

const profilePath = (hash: string) => `/q/${encodeURIComponent(hash)}/`;

// The search form sends the title filter as one comma-separated value (data-value-format="comma").
const COMMA_FILTERS = new Set<keyof CandidateFilters>(['title']);

// Builds the query string for GET /developers/ in the order of the filter definition.
// The other list filters are repeated parameters. Empty list items are left out.
export function buildCandidatesQuery(filters: CandidateFilters): string {
  const params = new URLSearchParams();
  for (const name of Object.keys(CANDIDATE_FILTER_DESCRIPTIONS) as (keyof CandidateFilters)[]) {
    const value = filters[name];
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      const list = value.filter(item => item !== '');
      if (list.length === 0) continue;
      if (COMMA_FILTERS.has(name)) params.append(name, list.join(','));
      else for (const item of list) params.append(name, item);
    } else if (typeof value === 'boolean') {
      params.append(name, value ? 'True' : 'False');
    } else {
      params.append(name, String(value));
    }
  }
  return params.toString();
}

// Returns the session client. Throws NotLoggedInError if no valid session is saved.
async function sessionClient(ctx: Ctx) {
  await ctx.me();
  return ctx.client();
}

export async function searchCandidates(ctx: Ctx, filters: CandidateFilters): Promise<CandidateList> {
  const client = await sessionClient(ctx);
  const query = buildCandidatesQuery(filters);
  return parseCandidateList(await client.get(`/developers/${query ? `?${query}` : ''}`));
}

export async function getCandidate(ctx: Ctx, candidate: string): Promise<CandidateDetail> {
  const hash = candidateHash(candidate);
  const client = await sessionClient(ctx);
  return { ...parseCandidate(await client.get(profilePath(hash))), hash, url: candidateUrl(hash) };
}

// The profile page loads the similar candidates with hx-get from a path with the internal candidate ID.
// So the operation reads the profile page first and takes the path from it.
export async function getSimilarCandidates(ctx: Ctx, candidate: string): Promise<CandidateSummary[]> {
  const hash = candidateHash(candidate);
  const client = await sessionClient(ctx);
  const path = similarCandidatesPath(await client.get(profilePath(hash)));
  if (!path) return [];
  // The fragment can list the source candidate. Only the other candidates are similar.
  return parseSimilarCandidates(await client.get(path, { hx: true })).filter(c => c.hash !== hash);
}
