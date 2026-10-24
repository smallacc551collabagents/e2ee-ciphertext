// E2EE-47: encrypted attachment blob endpoints. The server is a dumb transport for OPAQUE
// ciphertext: it sees only a random ref, the conversation it was shared in, the ciphertext size
// and the ciphertext sha256. File keys, names, MIME types and plaintext travel only inside the
// Olm-encrypted message. The server never reads, transforms or derives media from blobs
// (no thumbnails/previews), it only hashes the ciphertext once to verify integrity.
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { q } from "../database/db.js";
import { me, requireAuth } from "../middleware/requireAuth.js";
import { objectStore } from "../services/objectStore.js";

// Mirrors packages/crypto/src/attachments.ts (blob format v1, docs/crypto-attachments.md).
// TODO(E2EE-47): import the max-ciphertext constant from @e2ee/crypto once it is exported.
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024; // plaintext product limit
const HEADER_BYTES = 24;
const CHUNK_BYTES = 64 * 1024;
const TAG_BYTES = 16;
/** Largest valid encrypted blob: 25 MiB + 24 + ceil(25 MiB / 64 KiB) * 16 = 26,220,824 bytes. */
export const ATTACHMENT_MAX_CIPHERTEXT_BYTES =
  ATTACHMENT_MAX_BYTES + HEADER_BYTES + Math.ceil(ATTACHMENT_MAX_BYTES / CHUNK_BYTES) * TAG_BYTES;
/** Smallest valid blob: header + one (empty) chunk's tag. */
const MIN_BLOB_BYTES = HEADER_BYTES + TAG_BYTES;

export const ATTACHMENT_TIMING = {
  uploadUrlSec: 5 * 60,      // presigned POST lifetime
  pendingTtlSec: 15 * 60,    // pending (never completed) uploads are reaped after this
  downloadUrlSec: 5 * 60,    // presigned GET lifetime
  storedTtlSec: 30 * 24 * 3600, // stored blobs are reaped after 30 days
};
const GC_PROBABILITY = 0.05;
const GC_BATCH = 50;

const REF_RE = "^[A-Za-z0-9_-]{43}$"; // 256-bit random, base64url
const objectKey = (ref: string) => `a/${ref}`;
const newRef = () => randomBytes(32).toString("base64url");

const err = (reply: FastifyReply, code: number, error: string, message: string) =>
  reply.code(code).send({ error, message });

interface AttRow { ref: string; owner_user_id: string; conversation_id: string; size_bytes: number; sha256: string; status: string; expired: boolean }

/** Expiry sweep: deletes objects + rows whose window lapsed (pending never completed, or stored past TTL). Bounded per call. */
export async function sweepAttachments(limit = GC_BATCH): Promise<number> {
  const r = await q().query<{ ref: string }>(
    `SELECT ref FROM attachments WHERE expires_at < now() ORDER BY expires_at LIMIT $1`, [limit]);
  let n = 0;
  for (const { ref } of r.rows) {
    await objectStore().delete(objectKey(ref)); // idempotent; missing objects are fine
    await q().query(`DELETE FROM attachments WHERE ref = $1 AND expires_at < now()`, [ref]);
    n++;
  }
  return n;
}

export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  const maybeSweep = async () => {
    if (Math.random() >= GC_PROBABILITY) return;
    try { await sweepAttachments(); } catch (e) { app.log.error({ err: { name: (e as Error)?.name } }, "attachment sweep failed"); }
  };
  // Fail-open like the other non-auth endpoints (skipOnError).
  const rl = (name: string, max: number) => ({
    rateLimit: { hook: "preHandler" as const, skipOnError: true, max, timeWindow: "1 minute",
      keyGenerator: (r: { user?: { id: string }; ip: string }) => `${name}:${r.user?.id ?? r.ip}` },
  });

  app.post<{ Body: { conversationId: string; size: number; sha256: string } }>("/attachments/upload-url", {
    schema: { body: { type: "object", additionalProperties: false, required: ["conversationId", "size", "sha256"], properties: {
      conversationId: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" },
      size: { type: "integer", minimum: MIN_BLOB_BYTES, maximum: ATTACHMENT_MAX_CIPHERTEXT_BYTES },
      sha256: { type: "string", pattern: "^[A-Za-z0-9+/]{43}=$" },
    } } },
    config: rl("att-up", 30),
  }, async (req, reply) => {
    const { conversationId, size, sha256 } = req.body;
    const m = await q().query(`SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`, [conversationId, me(req).id]);
    if (!m.rowCount) return err(reply, 404, "not_found", "Conversation not found.");
    const ref = newRef();
    await q().query(
      `INSERT INTO attachments (ref, owner_user_id, conversation_id, size_bytes, sha256, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', now() + make_interval(secs => $6))`,
      [ref, me(req).id, conversationId, size, sha256, ATTACHMENT_TIMING.pendingTtlSec]);
    const upload = await objectStore().presignPost(objectKey(ref), ATTACHMENT_MAX_CIPHERTEXT_BYTES, ATTACHMENT_TIMING.uploadUrlSec);
    await maybeSweep();
    return reply.code(201).send({
      ref, upload, maxBytes: ATTACHMENT_MAX_CIPHERTEXT_BYTES,
      expiresAt: new Date(Date.now() + ATTACHMENT_TIMING.uploadUrlSec * 1000).toISOString(),
    });
  });

  app.post<{ Params: { ref: string } }>("/attachments/:ref/complete", {
    schema: { params: { type: "object", required: ["ref"], properties: { ref: { type: "string", pattern: REF_RE } } } },
    config: rl("att-done", 30),
  }, async (req, reply) => {
    const { ref } = req.params;
    const r = await q().query<AttRow>(
      `SELECT ref, owner_user_id, size_bytes, sha256, status, expires_at < now() AS expired FROM attachments WHERE ref = $1`, [ref]);
    const a = r.rows[0];
    if (!a || a.owner_user_id !== me(req).id) return err(reply, 404, "not_found", "Attachment not found.");
    if (a.status === "stored") return reply.send({ ref, status: "stored" });
    if (a.expired) return err(reply, 410, "expired", "Upload window expired.");
    const key = objectKey(ref);
    const size = await objectStore().size(key);
    if (size === null) return err(reply, 409, "not_uploaded", "Blob not uploaded yet.");
    const reject = async () => {
      await objectStore().delete(key);
      await q().query(`DELETE FROM attachments WHERE ref = $1`, [ref]);
      return err(reply, 422, "integrity_mismatch", "Uploaded blob does not match the declared size/sha256.");
    };
    if (size !== Number(a.size_bytes)) return reject();
    if ((await objectStore().sha256(key)) !== a.sha256) return reject();
    await q().query(
      `UPDATE attachments SET status = 'stored', expires_at = now() + make_interval(secs => $2) WHERE ref = $1 AND status = 'pending'`,
      [ref, ATTACHMENT_TIMING.storedTtlSec]);
    return reply.send({ ref, status: "stored" });
  });

  app.get<{ Params: { ref: string } }>("/attachments/:ref/download-url", {
    schema: { params: { type: "object", required: ["ref"], properties: { ref: { type: "string", pattern: REF_RE } } } },
    config: rl("att-down", 120),
  }, async (req, reply) => {
    // Members of the conversation the blob was uploaded into only. Non-members, unknown refs,
    // pending and expired blobs all get the same 404 (no existence oracle).
    const r = await q().query(
      `SELECT 1 FROM attachments a JOIN conversation_members m ON m.conversation_id = a.conversation_id AND m.user_id = $2
       WHERE a.ref = $1 AND a.status = 'stored' AND a.expires_at > now()`, [req.params.ref, me(req).id]);
    if (!r.rowCount) return err(reply, 404, "not_found", "Attachment not found.");
    const downloadUrl = await objectStore().presignGet(objectKey(req.params.ref), ATTACHMENT_TIMING.downloadUrlSec);
    return reply.send({ downloadUrl, expiresAt: new Date(Date.now() + ATTACHMENT_TIMING.downloadUrlSec * 1000).toISOString() });
  });
}
