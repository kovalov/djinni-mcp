import { describe, expect, test } from 'vitest';
import { EDITORIAL_VALUES, EXPERIENCE_VALUES, FILTER_DESCRIPTIONS, LANGUAGE_VALUES, SALARY_VALUES, parseJobFilters } from '../../src/core/filters.ts';

describe('job filter values', () => {
  test('holds the allowed values of the djinni API', () => {
    expect(EXPERIENCE_VALUES).toEqual([0, 1, 2, 3, 5]);
    expect(SALARY_VALUES).toEqual([1500, 2500, 3500, 4500, 5500]);
    expect(LANGUAGE_VALUES).toEqual(['no_eng', 'has_eng', 'pre', 'intermediate', 'upper', 'fluent']);
    expect(EDITORIAL_VALUES).toEqual(['nonhr', 'product', 'intl', 'relocate', 'hired', 'not-agency', 'is_parttime', 'has_public_salary']);
  });

  test('names the allowed values in the field descriptions', () => {
    expect(FILTER_DESCRIPTIONS.experience).toContain('Allowed values: 0, 1, 2, 3, 5.');
    expect(FILTER_DESCRIPTIONS.salary).toContain('Allowed values: 1500, 2500, 3500, 4500, 5500.');
    expect(FILTER_DESCRIPTIONS.language).toContain('Allowed values: no_eng, has_eng, pre, intermediate, upper, fluent.');
    expect(FILTER_DESCRIPTIONS.editorial).toContain('Allowed values: nonhr, product, intl, relocate, hired, not-agency, is_parttime, has_public_salary.');
  });
});

describe('parseJobFilters', () => {
  test('converts text values from a command line to typed filters', () => {
    const filters = parseJobFilters({
      category: 'python,golang',
      experience: ['2', '3'],
      location: 'kyiv',
      language: 'upper',
      salary: '2500',
      editorial: 'product',
      company_name: 'sigma software',
      query: 'django',
      full_text: true,
      domain: 'fintech',
      offset: '10',
    });

    expect(filters).toEqual({
      category: ['python', 'golang'],
      experience: [2, 3],
      location: ['kyiv'],
      language: ['upper'],
      salary: 2500,
      editorial: 'product',
      company_name: 'sigma software',
      query: 'django',
      full_text: true,
      domain: 'fintech',
      offset: 10,
    });
  });

  test('joins repeated and comma-separated values and drops empty items', () => {
    expect(parseJobFilters({ category: ['python, golang', 'java', ''], experience: '1,2' })).toEqual({
      category: ['python', 'golang', 'java'],
      experience: [1, 2],
    });
  });

  test('accepts typed values', () => {
    expect(parseJobFilters({ experience: [0, 5], salary: 5500, language: ['no_eng'], full_text: false, offset: 0 })).toEqual({
      experience: [0, 5],
      salary: 5500,
      language: ['no_eng'],
      full_text: false,
      offset: 0,
    });
  });

  test('leaves out fields without a value', () => {
    expect(parseJobFilters({ category: undefined, query: undefined, salary: null })).toEqual({});
  });

  test.each([
    ['experience', ['2', '4'], '"4"', 'Allowed values: 0, 1, 2, 3, 5.'],
    ['experience', 'two', '"two"', 'Allowed values: 0, 1, 2, 3, 5.'],
    ['salary', '2000', '"2000"', 'Allowed values: 1500, 2500, 3500, 4500, 5500.'],
    ['language', 'native', '"native"', 'Allowed values: no_eng, has_eng, pre, intermediate, upper, fluent.'],
    ['editorial', 'remote', '"remote"', 'Allowed values: nonhr, product, intl, relocate, hired, not-agency, is_parttime, has_public_salary.'],
  ])('rejects a bad %s value and names the allowed values', (field, value, shown, allowed) => {
    expect(() => parseJobFilters({ [field]: value })).toThrow(`job filter "${field}"`);
    expect(() => parseJobFilters({ [field]: value })).toThrow(shown);
    expect(() => parseJobFilters({ [field]: value })).toThrow(allowed);
  });

  test('rejects more than one salary or editorial value', () => {
    expect(() => parseJobFilters({ salary: ['1500', '2500'] })).toThrow('job filter "salary"');
    expect(() => parseJobFilters({ editorial: 'product,intl' })).toThrow('job filter "editorial"');
  });

  test.each([['-10'], ['1.5'], ['1.0'], ['10.'], [-1], ['ten']])('rejects the offset %s', offset => {
    expect(() => parseJobFilters({ offset })).toThrow('job filter "offset"');
  });

  test('rejects a text filter with a value that is not text', () => {
    expect(() => parseJobFilters({ query: 42 })).toThrow('job filter "query"');
    expect(() => parseJobFilters({ category: [1] })).toThrow('job filter "category"');
  });

  test('rejects a full_text value that is not true or false', () => {
    expect(() => parseJobFilters({ full_text: 'yes' })).toThrow('job filter "full_text"');
  });

  test.each([
    ['true', true],
    ['false', false],
    ['1', true],
    ['0', false],
    [' TRUE ', true],
  ])('accepts the full_text text %j from a command line', (value, expected) => {
    expect(parseJobFilters({ full_text: value })).toEqual({ full_text: expected });
  });

  test('rejects an offset when the filters are for a watch', () => {
    expect(() => parseJobFilters({ category: 'python', offset: '10' }, { allowOffset: false })).toThrow('"offset" is not a watch filter');
    expect(parseJobFilters({ category: 'python' }, { allowOffset: false })).toEqual({ category: ['python'] });
    expect(parseJobFilters({ offset: undefined }, { allowOffset: false })).toEqual({});
  });

  test('rejects an unknown filter and names the known filters', () => {
    expect(() => parseJobFilters({ city: 'kyiv' })).toThrow('"city" is not a job filter');
    expect(() => parseJobFilters({ city: 'kyiv' })).toThrow('category, experience, location');
  });
});
