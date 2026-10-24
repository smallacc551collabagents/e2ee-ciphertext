import { describe, expect, it } from 'vitest';
import { DISPLAY_MAX_CHARS, toDisplayText } from '../src/index.js';

describe('toDisplayText (E2EE-44 decrypt/render boundary)', () => {
  it('keeps ordinary text, newlines, tabs, emoji and markup-looking text verbatim', () => {
    expect(toDisplayText('hi\n\tthere 👋 <b>x</b>')).toBe('hi\n\tthere 👋 <b>x</b>');
  });
  it('strips bidi overrides/isolates used for spoofing', () => {
    expect(toDisplayText('pay \u202Eexe.txt\u202C now \u2066x\u2069')).toBe('pay exe.txt now x');
  });
  it('strips C0/C1 controls and normalises CRLF', () => {
    expect(toDisplayText('a\u0000b\u001bc\u0085d\r\ne\rf')).toBe('abcd\ne\nf');
  });
  it('caps length', () => {
    const out = toDisplayText('x'.repeat(DISPLAY_MAX_CHARS + 50));
    expect(out.length).toBe(DISPLAY_MAX_CHARS + 1);
    expect(out.endsWith('…')).toBe(true);
  });
});
