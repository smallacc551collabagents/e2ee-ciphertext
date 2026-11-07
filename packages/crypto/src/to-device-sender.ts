/**
 * Whether a decrypted Olm to-device event is from the device the envelope claims.
 *
 * An explicit `encryptionInfo.senderDevice` always decides. The Curve25519 fallback runs only when the
 * library left that field unset (`m.room_key` delays the check). A matching curve never overrides an
 * explicit device mismatch or a different sender user.
 */
export function acceptToDeviceSender(o: {
  /** `encryptionInfo.senderDevice` as a string. Undefined only when the library omitted it. */
  senderDevice: string | undefined;
  claimedDeviceId: string;
  /** Sender on the decrypted event (`raw.sender`). */
  rawSender: string;
  claimedUserId: string;
  /** Curve25519 key authenticated by the Olm session. */
  olmCurve25519: string;
  /** Published Curve25519 of the claimed device, when we have one. Ignored if senderDevice is set. */
  publishedCurve25519: string | undefined;
}): boolean {
  if (o.rawSender !== o.claimedUserId) return false;
  if (o.senderDevice !== undefined) return o.senderDevice === o.claimedDeviceId;
  return o.publishedCurve25519 !== undefined && o.publishedCurve25519 === o.olmCurve25519;
}
