import { expect, test } from 'vitest';
import { terminalText } from '../../src/cli/command.ts';

test('terminalText removes the bidi control characters', () => {
  const bidi = ['‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩', '‎', '‏'];

  expect(terminalText(`a${bidi.join('')}b`)).toBe('ab');
  expect(terminalText('invoice‮gpj.exe')).toBe('invoicegpj.exe');
});

test('terminalText keeps the tab, the line feed and other Unicode text', () => {
  expect(terminalText('Добрий\tдень\n‍👋 C++')).toBe('Добрий\tдень\n‍👋 C++');
});
