import { afterEach, describe, expect, test } from 'vitest';
import { Ctx } from '../../src/context.ts';
import { buildCandidatesQuery, candidateHash, getCandidate, getSimilarCandidates, searchCandidates } from '../../src/core/candidates.ts';
import { NotLoggedInError } from '../../src/http.ts';
import { parseCandidateList } from '../../src/parsers/candidates.ts';
import type { Store } from '../../src/store.ts';
import { fixture, loggedInStore, startFakeDjinni, tempStore, type FakeDjinni, type Route } from '../helpers.ts';

let djinni: FakeDjinni;
afterEach(() => djinni?.close());

const profile = { 'GET /my/profile/': fixture('my_profile.html') };
const invalidSession = { 'GET /my/profile/': { status: 302, headers: { location: '/continue/' } } };

async function setup(routes: Record<string, Route>, store: Store = loggedInStore()) {
  djinni = await startFakeDjinni({ ...profile, ...routes });
  return new Ctx({ store, baseUrl: djinni.url, minIntervalMs: 0 });
}

// The requests to djinni without the session check.
const dataRequests = () => djinni.requests.filter(r => r.url !== '/my/profile/');

describe('candidateHash', () => {
  test.each([
    ['a49535fea6', 'a49535fea6'],
    [' a49535fea6 ', 'a49535fea6'],
    ['https://djinni.co/q/a49535fea6/', 'a49535fea6'],
    ['https://djinni.co/q/a49535fea6/?ref=search', 'a49535fea6'],
    ['/q/a49535fea6/', 'a49535fea6'],
    ['/q/a49535fea6', 'a49535fea6'],
  ])('reads the hash from %s', (input, hash) => {
    expect(candidateHash(input)).toBe(hash);
  });

  test.each([
    [''],
    ['A49535FEA6'],
    ['python developer'],
    ['../my/profile'],
    ['/q/../my/profile/'],
    ['/q/xyz/'],
    ['https://djinni.co/q/a49535fea6%2F..%2Fmy/'],
    ['https://djinni.co/developers/'],
  ])('rejects %j', input => {
    expect(() => candidateHash(input)).toThrow(`"${input}" has no djinni candidate hash. Use a hash like a49535fea6, or a profile URL.`);
  });
});

describe('searchCandidates', () => {
  test('sends the filters as the query of /developers/ and returns the page', async () => {
    const ctx = await setup({ 'GET /developers/': fixture('developers_list.html') });

    const page = await searchCandidates(ctx, {
      page: 3,
      keywords: 'python django',
      keywords_options: 'skills_only',
      title: ['Python', 'Golang'],
      region: 'UKR',
      location: 'lviv',
      knows_ukrainian: false,
      exp_from: 2.5,
      exp_to: 5,
      salary_min: 1500,
      salary_max: 3000,
      english_level: 'upper',
      language: 'deu',
      language_level: 'B2',
      employment: 'fulltime',
      format: 'remote',
      domain: ['fintech', 'saas'],
      domain_exclude: ['gambling'],
      certifications: ['76', 'any'],
      sortby: 'salary_max',
    });

    const req = dataRequests()[0]!;
    expect(req.url).toBe(
      '/developers/?keywords=python+django&keywords_options=skills_only&title=Python%2CGolang&region=UKR&location=lviv' +
        '&knows_ukrainian=False&exp_from=2.5&exp_to=5&salary_min=1500&salary_max=3000&english_level=upper&language=deu&language_level=B2' +
        '&employment=fulltime&format=remote&domain=fintech&domain=saas&domain_exclude=gambling&certifications=76&certifications=any' +
        '&sortby=salary_max&page=3',
    );
    expect(req.headers.cookie).toContain('sessionid=SESS');
    expect(page).toEqual(parseCandidateList(fixture('developers_list.html')));
  });

  test('sends knows_ukrainian=True for true', async () => {
    const ctx = await setup({ 'GET /developers/': fixture('developers_list.html') });

    await searchCandidates(ctx, { knows_ukrainian: true });

    expect(dataRequests().map(r => r.url)).toEqual(['/developers/?knows_ukrainian=True']);
  });

  test('leaves out empty list items and empty lists', () => {
    expect(buildCandidatesQuery({ title: ['', 'Python'], certifications: [''], domain: [], keywords: '' })).toBe('title=Python');
  });

  test('sends no query without filters', async () => {
    const ctx = await setup({ 'GET /developers/': fixture('developers_list.html') });

    await searchCandidates(ctx, {});

    expect(dataRequests().map(r => r.url)).toEqual(['/developers/']);
  });

  test('throws NotLoggedInError and sends no request when no session is saved', async () => {
    const ctx = await setup({ 'GET /developers/': fixture('developers_list.html') }, tempStore());

    await expect(searchCandidates(ctx, {})).rejects.toBeInstanceOf(NotLoggedInError);
    expect(djinni.requests).toHaveLength(0);
  });

  test('throws NotLoggedInError and sends no search request when the session is not valid', async () => {
    const ctx = await setup({ 'GET /developers/': fixture('developers_list.html'), ...invalidSession });

    await expect(searchCandidates(ctx, {})).rejects.toBeInstanceOf(NotLoggedInError);
    expect(dataRequests()).toHaveLength(0);
  });
});

describe('getCandidate', () => {
  test('reads the profile at /q/<hash>/ with the session', async () => {
    const ctx = await setup({ 'GET /q/a49535fea6/': fixture('candidate_profile.html') });

    const detail = await getCandidate(ctx, 'https://djinni.co/q/a49535fea6/');

    expect(dataRequests().map(r => r.url)).toEqual(['/q/a49535fea6/']);
    expect(dataRequests()[0]!.headers.cookie).toContain('sessionid=SESS');
    expect(detail).toMatchObject({ hash: 'a49535fea6', url: 'https://djinni.co/q/a49535fea6/', title: 'C++ Engineer', salary: '$3500 / місяць' });
    expect(detail.skills).toHaveLength(14);
  });

  test('takes the hash from the input when the page has no canonical link', async () => {
    const html = fixture('candidate_profile.html').replace(/<link rel="canonical"[^>]*>/, '');
    const ctx = await setup({ 'GET /q/a49535fea6/': html });

    expect(await getCandidate(ctx, 'a49535fea6')).toMatchObject({ hash: 'a49535fea6', url: 'https://djinni.co/q/a49535fea6/' });
  });

  test('throws for a value without a hash and sends no request', async () => {
    const ctx = await setup({});

    await expect(getCandidate(ctx, '../my/profile')).rejects.toThrow('has no djinni candidate hash');
    expect(djinni.requests).toHaveLength(0);
  });

  test('throws NotLoggedInError when the session is not valid', async () => {
    const ctx = await setup({ 'GET /q/a49535fea6/': fixture('candidate_profile.html'), ...invalidSession });

    await expect(getCandidate(ctx, 'a49535fea6')).rejects.toBeInstanceOf(NotLoggedInError);
    expect(dataRequests()).toHaveLength(0);
  });
});

describe('getSimilarCandidates', () => {
  // The profile page loads the fragment from the hx-get path with the internal candidate ID.
  test('reads the fragment path from the profile and sends the HX-Request header', async () => {
    const ctx = await setup({
      'GET /q/a49535fea6/': fixture('candidate_profile.html'),
      'GET /similar-candidates/q/952948/': fixture('candidate_similar.html'),
    });

    const similar = await getSimilarCandidates(ctx, 'a49535fea6');

    expect(dataRequests().map(r => r.url)).toEqual(['/q/a49535fea6/', '/similar-candidates/q/952948/']);
    const fragmentRequest = dataRequests()[1]!;
    expect(fragmentRequest.headers['hx-request']).toBe('true');
    expect(fragmentRequest.headers.cookie).toContain('sessionid=SESS');
    expect(similar.map(c => c.hash)).toEqual(['b68a88b49c', '486bd02f61', '4a70043a44', 'c32aeedec2', '019734d3e3']);
  });

  test('removes the source candidate from the similar candidates', async () => {
    const ctx = await setup({
      'GET /q/486bd02f61/': fixture('candidate_profile.html'),
      'GET /similar-candidates/q/952948/': fixture('candidate_similar.html'),
    });

    const similar = await getSimilarCandidates(ctx, '/q/486bd02f61/');

    expect(similar.map(c => c.hash)).toEqual(['b68a88b49c', '4a70043a44', 'c32aeedec2', '019734d3e3']);
  });

  test('returns an empty list when the profile has no similar candidates fragment', async () => {
    const html = fixture('candidate_profile.html').replace('hx-get="/similar-candidates/q/952948/"', '');
    const ctx = await setup({ 'GET /q/a49535fea6/': html });

    expect(await getSimilarCandidates(ctx, 'a49535fea6')).toEqual([]);
    expect(dataRequests().map(r => r.url)).toEqual(['/q/a49535fea6/']);
  });

  test('throws NotLoggedInError and sends no request when no session is saved', async () => {
    const ctx = await setup({}, tempStore());

    await expect(getSimilarCandidates(ctx, 'a49535fea6')).rejects.toBeInstanceOf(NotLoggedInError);
    expect(djinni.requests).toHaveLength(0);
  });
});
