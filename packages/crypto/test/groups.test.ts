import { describe, expect, it } from 'vitest';
import { GROUPS_ENABLED, assertDirectConversation } from '../src/index.js';

describe('group policy (E2EE-53)', () => {
  it('groups are disabled', () => expect(GROUPS_ENABLED).toBe(false));
  it('returns the peer for a 1:1 conversation', () => {
    expect(assertDirectConversation(['@a:x', '@b:x'], '@a:x')).toBe('@b:x');
    expect(assertDirectConversation(['@b:x', '@a:x', '@b:x'], '@a:x')).toBe('@b:x');
  });
  it('refuses groups, self-only and conversations without the local user', () => {
    for (const m of [['@a:x', '@b:x', '@c:x'], ['@a:x'], ['@a:x', '@a:x'], ['@b:x', '@c:x'], []]) {
      expect(() => assertDirectConversation(m, '@a:x')).toThrow(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
    }
  });
});
