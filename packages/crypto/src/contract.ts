/**
 * Client-only crypto adapter contract (E2EE-15, draft v1).
 *
 * This module defines the ONLY surface the frontend may use for end-to-end
 * encryption. Implementations wrap an audited library (see
 * docs/crypto-decision.md); no cryptographic primitive is implemented here.
 *
 * Invariants:
 * - Private keys, session state and plaintext never leave the client. The
 *   backend only ever sees public key bundles and opaque ciphertext envelopes.
 * - Nothing in this package logs plaintext or key material.
 */

/** A single device of a user. One account may own several devices. */
export interface DeviceAddress {
  readonly userId: string;
  readonly deviceId: string;
}

/** Public identity of the local device (safe to display / publish). */
export interface DeviceIdentity extends DeviceAddress {
  /** Base64 Ed25519 public signing key (fingerprint source for safety numbers). */
  readonly ed25519: string;
  /** Base64 Curve25519 public identity key. */
  readonly curve25519: string;
}

/** Protocol identifiers we accept. Anything else is rejected. */
export type EnvelopeAlgorithm = 'm.olm.v1.curve25519-aes-sha2';

/**
 * Opaque, versioned ciphertext envelope. The server stores and relays this
 * verbatim and must not parse `content` beyond size limits.
 */
export interface CiphertextEnvelope {
  readonly v: 1;
  readonly alg: EnvelopeAlgorithm;
  readonly sender: DeviceAddress;
  readonly recipient: DeviceAddress;
  /** Library-defined ciphertext object (JSON-serialisable, opaque to callers). */
  readonly content: Readonly<Record<string, unknown>>;
}

export interface DecryptedMessage {
  readonly ok: true;
  readonly sender: DeviceAddress;
  /** Sender device Curve25519 key that authenticated this message. */
  readonly senderCurve25519: string;
  readonly plaintext: string;
}

export interface FailedMessage {
  readonly ok: false;
  readonly envelope: CiphertextEnvelope;
  readonly error: CryptoError;
}

export type ReceiveResult = DecryptedMessage | FailedMessage;

/**
 * Requests the adapter needs the backend to perform. The backend contract is:
 * - `keys.upload`: store the device's signed public identity bundle and one-time
 *   prekeys (public only).
 * - `keys.query`: return published device bundles for the requested users.
 * - `keys.claim`: atomically remove and return ONE one-time prekey per device
 *   (never hand the same prekey to two claimers; fall back to the signed
 *   fallback key when exhausted).
 * - `envelopes.send`: persist ciphertext envelopes for the target device(s).
 * Bodies are library-defined JSON; the backend validates shape/size only.
 */
export type ServerRequestKind = 'keys.upload' | 'keys.query' | 'keys.claim' | 'envelopes.send' | 'other';

export interface ServerRequest {
  readonly kind: ServerRequestKind;
  /** JSON request body (public data / ciphertext only). */
  readonly body: string;
  /** Present for `envelopes.send`. */
  readonly eventType?: string;
}

/** Transport supplied by the app. Returns the JSON response body. */
export interface KeyServerTransport {
  send(request: ServerRequest, from: DeviceAddress): Promise<string>;
}

export interface CryptoAdapter {
  /** Public identity of this device. */
  identity(): DeviceIdentity;
  /** Flush pending key uploads / queries to the server. Idempotent. */
  sync(): Promise<void>;
  /**
   * Encrypt plaintext for one peer device, establishing a session first if
   * needed (fetch bundle, verify signatures, claim one-time prekey).
   */
  encrypt(peer: DeviceAddress, plaintext: string): Promise<CiphertextEnvelope>;
  /**
   * Decrypt received envelopes. Never throws for a bad envelope: tampered,
   * replayed, or undecryptable input is returned as a FailedMessage.
   */
  receive(envelopes: readonly CiphertextEnvelope[]): Promise<ReceiveResult[]>;
  /** Peer devices' Ed25519 fingerprints, for safety-number display. */
  peerIdentities(userId: string): Promise<DeviceIdentity[]>;
  /**
   * Tell the library how many unused one-time prekeys the server holds
   * (GET /keys/count). When low, the library generates and uploads more.
   */
  replenishPrekeys(serverCount: number): Promise<void>;
  /**
   * Force a fresh key query for a peer (GET /keys/identity) and return the
   * devices the library has VERIFIED. A changed key for a known device id is
   * not accepted by the library; compare against published keys separately.
   */
  refreshPeer(userId: string): Promise<DeviceIdentity[]>;
  /** Release in-memory state. Persistent state stays encrypted at rest. */
  close(): void;
}

export type CryptoErrorCode =
  | 'NOT_INITIALIZED'
  | 'UNSUPPORTED_ENVIRONMENT'
  | 'INVALID_ENVELOPE'
  | 'NO_DEVICE'
  | 'NO_SESSION'
  | 'DECRYPT_FAILED'
  | 'IDENTITY_CHANGED'
  | 'STORAGE_FAILED'
  | 'TRANSPORT_FAILED';

/** Typed error. Messages never contain plaintext or key material. */
export class CryptoError extends Error {
  readonly code: CryptoErrorCode;
  constructor(code: CryptoErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CryptoError';
    this.code = code;
  }
}
