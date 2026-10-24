/* eslint-disable @typescript-eslint/no-explicit-any -- test fake mirrors untyped HTTP JSON */
import type { BackendHttp } from '../src/index.js';

/** Fake of PR #13 /keys + /messages semantics and validation (docs/phase1-backend.md). */
export class FakeBackend {
  ids = new Map<string, { identityKey: any; signedPrekey: any }>();
  otks = new Map<string, Array<{ keyId: number; publicKey: string; version: number; consumed: boolean }>>();
  messages: any[] = [];
  acked = new Set<string>();
  bodies: string[] = [];
  bundleFetches = 0;
  identityFetches = 0;
  private canon(s: string, max: number) {
    const ok = /^[A-Za-z0-9+/]+={0,2}$/.test(s) && Buffer.from(s, 'base64').toString('base64') === s && Buffer.from(s, 'base64').length <= max;
    if (!ok) throw Object.assign(new Error('invalid_key'), { status: 400 });
  }
  private ver(v: unknown) { if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 65535) throw Object.assign(new Error('version'), { status: 400 }); }
  private kid(v: unknown) { if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 2147483647) throw Object.assign(new Error('keyId'), { status: 400 }); }
  http(user: string): BackendHttp {
    return { request: async (method, path, body) => { this.bodies.push(JSON.stringify(body ?? null)); return this.route(user, method, path, body as any); } };
  }
  private route(user: string, method: string, path: string, body: any): unknown {
    const pool = () => (this.otks.get(user) ?? []).filter((k) => !k.consumed).length;
    if (method === 'POST' && path === '/keys/publish') {
      const allowed = ['identityKey', 'signedPrekey', 'oneTimePrekeys'];
      if (!Object.keys(body).length || Object.keys(body).some((k) => !allowed.includes(k))) throw Object.assign(new Error('shape'), { status: 400 });
      const cur = this.ids.get(user);
      if (body.identityKey) { this.canon(body.identityKey.publicKey, 1024); this.ver(body.identityKey.version); }
      if (body.signedPrekey) { const s = body.signedPrekey; this.canon(s.publicKey, 1024); this.canon(s.signature, 1024); this.ver(s.version); this.kid(s.keyId); }
      if (!cur && !(body.identityKey && body.signedPrekey)) throw Object.assign(new Error('identity_required'), { status: 400 });
      if (body.identityKey && !body.signedPrekey) throw Object.assign(new Error('signed_prekey_required'), { status: 400 });
      if (body.identityKey) {
        this.ids.set(user, { identityKey: body.identityKey, signedPrekey: body.signedPrekey });
        // Rotation drops unused OTKs (PR #13); uniqueness is scoped to unused keys (agreed follow-up).
        if (cur) this.otks.set(user, (this.otks.get(user) ?? []).filter((k) => k.consumed));
      }
      else if (body.signedPrekey) cur!.signedPrekey = body.signedPrekey;
      const list = this.otks.get(user) ?? [];
      this.otks.set(user, list);
      for (const k of body.oneTimePrekeys ?? []) {
        this.canon(k.publicKey, 1024); this.ver(k.version); this.kid(k.keyId);
        if (list.some((x) => !x.consumed && x.keyId === k.keyId)) throw Object.assign(new Error('dup keyId'), { status: 409 });
        list.push({ ...k, consumed: false });
      }
      if ((body.oneTimePrekeys ?? []).length > 100) throw Object.assign(new Error('batch'), { status: 400 });
      this.otks.set(user, list);
      return { oneTimePrekeyCount: pool() };
    }
    if (method === 'GET' && path === '/keys/count') return { oneTimePrekeyCount: pool() };
    const mi = /^\/keys\/identity\/(.+)$/.exec(path);
    if (method === 'GET' && mi) {
      this.identityFetches++;
      const target = decodeURIComponent(mi[1]!);
      const id = this.ids.get(target);
      if (!id) throw Object.assign(new Error('not found'), { status: 404 });
      return { userId: `uuid-${target}`, username: target, identityKey: id.identityKey, signedPrekey: id.signedPrekey };
    }
    const m = /^\/keys\/bundle\/(.+)$/.exec(path);
    if (method === 'GET' && m) {
      this.bundleFetches++;
      const target = decodeURIComponent(m[1]!);
      const id = this.ids.get(target);
      if (!id) throw Object.assign(new Error('not found'), { status: 404 });
      const otk = (this.otks.get(target) ?? []).find((k) => !k.consumed) ?? null;
      if (otk) otk.consumed = true;
      return { userId: `uuid-${target}`, username: target, identityKey: id.identityKey, signedPrekey: id.signedPrekey,
        oneTimePrekey: otk && { keyId: otk.keyId, publicKey: otk.publicKey, version: otk.version } };
    }
    const cm = /^\/conversations\/([^/?]+)\/messages(?:\?(.*))?$/.exec(path);
    if (method === 'POST' && cm && !cm[2]) {
      const conversationId = decodeURIComponent(cm[1]!);
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(body.clientMsgId)) throw Object.assign(new Error('clientMsgId'), { status: 400 });
      this.canon(body.ciphertext, 32 * 1024); this.ver(body.version);
      const dup = this.messages.find((x) => x.senderId === user && x.clientMsgId === body.clientMsgId);
      if (dup) return { message: dup, duplicate: true };
      const seq = String(this.messages.filter((x) => x.conversationId === conversationId).length + 1);
      const msg = { id: `m${this.messages.length}`, conversationId, senderId: user, seq, createdAt: new Date().toISOString(), ...body };
      this.messages.push(msg);
      return { message: msg, duplicate: false };
    }
    if (method === 'GET' && cm) {
      // PR #13: ascending seq, exclusive `after` cursor, limit 1..100.
      const q = new URLSearchParams(cm[2] ?? '');
      const after = BigInt(q.get('after') ?? '0');
      const limit = Math.min(100, Math.max(1, Number(q.get('limit') ?? '100')));
      const all = this.messages.filter((x) => x.conversationId === decodeURIComponent(cm[1]!) && BigInt(x.seq) > after)
        .sort((x, y) => Number(BigInt(x.seq) - BigInt(y.seq)));
      const page = all.slice(0, limit);
      return { messages: page, nextCursor: page.length ? page[page.length - 1].seq : null, hasMore: all.length > limit };
    }
    if (method === 'POST' && path === '/messages/ack') {
      if (!Array.isArray(body.messageIds) || body.messageIds.length > 500) throw Object.assign(new Error('ack'), { status: 400 });
      let acked = 0;
      for (const id of body.messageIds) if (!this.acked.has(`${user}:${id}`) && this.messages.some((x) => x.id === id)) { this.acked.add(`${user}:${id}`); acked++; }
      return { acked };
    }
    throw Object.assign(new Error(`unrouted ${method} ${path}`), { status: 404 });
  }
}

