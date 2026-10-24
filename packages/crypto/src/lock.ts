/**
 * Serialises crypto state mutations. In browsers this uses the Web Locks API
 * so only one tab mutates a device's ratchet state at a time. Outside browsers
 * (Node tests) it falls back to an in-process queue.
 */
type LockManagerLike = { request<T>(name: string, cb: () => Promise<T>): Promise<T> };

const local = new Map<string, Promise<unknown>>();

export function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
  if (locks) return locks.request(name, fn);
  const prev = local.get(name) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  local.set(
    name,
    next.catch(() => undefined),
  );
  return next;
}
