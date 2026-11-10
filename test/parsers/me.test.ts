import { describe, expect, test } from 'vitest';
import { parseWhoami } from '../../src/parsers/me.ts';
import { fixture } from '../helpers.ts';

describe('parseWhoami', () => {
  test('reads the candidate ID, the headline and the public profile path', () => {
    expect(parseWhoami(fixture('my_profile.html'))).toEqual({
      candidateId: '100001',
      headline: 'Test Position',
      publicProfilePath: '/q/0000000000/',
    });
  });

  test('returns null for a page of a user who is not logged in', () => {
    expect(parseWhoami('<html><body><a href="/login">Увійти</a></body></html>')).toBeNull();
  });
});
