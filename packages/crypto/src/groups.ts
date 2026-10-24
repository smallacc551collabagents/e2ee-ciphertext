/**
 * Group messaging policy (E2EE-53). Decision: docs/crypto-group-decision.md.
 * Groups are DISABLED: the crypto layer only encrypts 1:1 to a single peer device.
 * Enabling requires a new reviewed decision + implementation, not flipping this flag.
 */
import { CryptoError } from './contract.js';

export const GROUPS_ENABLED = false as const;

/**
 * Call before encrypting for a conversation. Throws INVALID_OPTIONS unless it is a
 * direct conversation with exactly two distinct members including the local user.
 */
export function assertDirectConversation(memberUserIds: readonly string[], selfUserId: string): string {
  const unique = [...new Set(memberUserIds)];
  if (unique.length !== 2 || !unique.includes(selfUserId)) {
    throw new CryptoError('INVALID_OPTIONS', 'Group conversations are not supported (E2EE-53: groups disabled)');
  }
  return unique.find((u) => u !== selfUserId)!;
}
