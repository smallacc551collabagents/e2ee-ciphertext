import { describe, expect, it } from 'vitest';
import { acceptToDeviceSender } from '../src/to-device-sender.js';

const alice = '@alice:e2ee.local';
const olm = 'OLM-CURVE-ALICE1';
const published = 'OLM-CURVE-ALICE1';
const other = 'PUBLISHED-CURVE-OTHER';

describe('acceptToDeviceSender', () => {
  it('unset senderDevice accepts only the claimed device\'s published Curve25519', () => {
    expect(acceptToDeviceSender({
      senderDevice: undefined, claimedDeviceId: 'ALICE1', rawSender: alice, claimedUserId: alice,
      olmCurve25519: olm, publishedCurve25519: published,
    })).toBe(true);
  });

  it('unset senderDevice rejects a wrong published Curve25519 key', () => {
    expect(acceptToDeviceSender({
      senderDevice: undefined, claimedDeviceId: 'ALICE1', rawSender: alice, claimedUserId: alice,
      olmCurve25519: olm, publishedCurve25519: other,
    })).toBe(false);
    expect(acceptToDeviceSender({
      senderDevice: undefined, claimedDeviceId: 'ALICE1', rawSender: alice, claimedUserId: alice,
      olmCurve25519: olm, publishedCurve25519: undefined,
    })).toBe(false);
  });

  it('explicit senderDevice mismatch is rejected even when the Curve25519 keys match', () => {
    expect(acceptToDeviceSender({
      senderDevice: 'ALICE1', claimedDeviceId: 'ALICE2', rawSender: alice, claimedUserId: alice,
      olmCurve25519: olm, publishedCurve25519: published,
    })).toBe(false);
  });

  it('wrong sender user is rejected even when the device and Curve25519 match', () => {
    expect(acceptToDeviceSender({
      senderDevice: 'ALICE1', claimedDeviceId: 'ALICE1', rawSender: alice, claimedUserId: '@carol:e2ee.local',
      olmCurve25519: olm, publishedCurve25519: published,
    })).toBe(false);
    expect(acceptToDeviceSender({
      senderDevice: undefined, claimedDeviceId: 'ALICE1', rawSender: alice, claimedUserId: '@carol:e2ee.local',
      olmCurve25519: olm, publishedCurve25519: published,
    })).toBe(false);
  });
});
