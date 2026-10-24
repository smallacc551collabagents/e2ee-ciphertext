// E2EE-47: object storage for encrypted attachment blobs (Neon Object Storage, S3-compatible).
// The backend never proxies blob bytes from clients: browsers upload with a presigned POST and
// download with a presigned GET, both on ONE stable origin (the branch S3 endpoint, path-style).
// Objects are opaque ciphertext; we never set a content type, name, or any metadata, and never
// derive anything (no thumbnails/previews) from them.
import { createHash } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface PresignedPost { url: string; fields: Record<string, string> }

export interface ObjectStore {
  /** Presigned POST pinned to exactly `key` (eq condition), content-length-range [1, maxBytes] signed in the policy. */
  presignPost(key: string, maxBytes: number, expiresSec: number): Promise<PresignedPost>;
  presignGet(key: string, expiresSec: number): Promise<string>;
  /** Object size in bytes, or null if it doesn't exist. */
  size(key: string): Promise<number | null>;
  /** base64 SHA-256 of the object bytes, or null if it doesn't exist. */
  sha256(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

const isNotFound = (e: unknown): boolean => {
  const x = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return x?.name === "NotFound" || x?.name === "NoSuchKey" || x?.$metadata?.httpStatusCode === 404;
};

/**
 * Env (Vercel project env; values never committed). The AWS SDK reads these itself:
 *   AWS_ENDPOINT_URL_S3, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY  (Neon storage credential)
 *   ATTACHMENTS_BUCKET (optional, default "e2ee-attachments")
 */
export class S3ObjectStore implements ObjectStore {
  private readonly s3: S3Client;
  private readonly bucket: string;
  constructor() {
    this.bucket = process.env.ATTACHMENTS_BUCKET ?? "e2ee-attachments";
    // Neon requires path-style addressing, so every URL is on the single endpoint origin.
    this.s3 = new S3Client({ forcePathStyle: true, region: process.env.AWS_REGION ?? "us-east-1" });
  }
  async presignPost(key: string, maxBytes: number, expiresSec: number): Promise<PresignedPost> {
    const p = await createPresignedPost(this.s3, {
      Bucket: this.bucket, Key: key, Expires: expiresSec,
      Conditions: [["content-length-range", 1, maxBytes], ["eq", "$key", key]],
    });
    return { url: p.url, fields: p.fields };
  }
  presignGet(key: string, expiresSec: number): Promise<string> {
    return getSignedUrl(this.s3, new GetObjectCommand({
      Bucket: this.bucket, Key: key,
      ResponseContentType: "application/octet-stream", ResponseContentDisposition: "attachment",
    }), { expiresIn: expiresSec });
  }
  async size(key: string): Promise<number | null> {
    try {
      const h = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return Number(h.ContentLength ?? 0);
    } catch (e) { if (isNotFound(e)) return null; throw e; }
  }
  async sha256(key: string): Promise<string | null> {
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const h = createHash("sha256");
      for await (const chunk of r.Body as AsyncIterable<Uint8Array>) h.update(chunk);
      return h.digest("base64");
    } catch (e) { if (isNotFound(e)) return null; throw e; }
  }
  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

let store: ObjectStore | undefined;
export const objectStore = (): ObjectStore => (store ??= new S3ObjectStore());
/** Swap the store (tests use an in-memory fake). */
export function setObjectStore(s: ObjectStore): void { store = s; }
