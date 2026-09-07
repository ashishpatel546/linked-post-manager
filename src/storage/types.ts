/**
 * Everything this agent persists — tokens, drafts, the audit trail, images —
 * goes through one narrow interface, so the same code runs against a local
 * directory and against S3 without either knowing about the other.
 *
 * Two deliberate constraints:
 *
 * - **Keys are relative POSIX paths**, and they are the same on both backends.
 *   `drafts/2026-09-06-topic.md` is a file on disk locally and an object key on
 *   S3. Nothing translates between the two, so what you read in a bucket is
 *   what you would read in the working copy.
 *
 * - **Everything is async.** A local filesystem could answer synchronously, but
 *   exposing that would let callers depend on it, and every one of them would
 *   then have to be rewritten the day S3 is switched on. Paying that cost once,
 *   now, is cheaper than paying it under deadline later.
 */
export type Storage = {
  /** For diagnostics — "local (d:\\Work\\linkedIn)" or "s3 (bucket/prefix)". */
  readonly describe: string;

  getText(key: string): Promise<string | null>;
  putText(key: string, value: string): Promise<void>;

  getBytes(key: string): Promise<Uint8Array | null>;
  putBytes(key: string, bytes: Uint8Array, contentType?: string): Promise<void>;

  /**
   * Keys beginning with `prefix`, sorted. Not recursive: every namespace here
   * is intentionally flat, so a prefix names one level and a listing cannot
   * quietly become an expensive full scan.
   */
  list(prefix: string): Promise<string[]>;

  remove(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;

  /**
   * Size of an object without downloading it — HeadObject on S3, stat locally.
   *
   * Worth its own method: listing what a published post occupies used to call
   * getBytes on each file just to read `.byteLength`, which pulled a 124 KB PDF
   * across the wire to print "124 KB".
   */
  stat(key: string): Promise<{ bytes: number } | null>;
};

export async function getJson<T>(storage: Storage, key: string): Promise<T | null> {
  const text = await storage.getText(key);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    // A corrupt object should not take down the caller. Callers treat null as
    // "not there", which is the safe reading for every store we keep.
    return null;
  }
}

export function putJson(storage: Storage, key: string, value: unknown): Promise<void> {
  return storage.putText(key, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Keys are joined onto a base path, so a key containing `..` would escape it.
 * Rejected rather than normalised: no legitimate key needs it, and silently
 * rewriting one would hide a bug in whatever produced it.
 */
export function assertSafeKey(key: string): void {
  if (
    key.length === 0 ||
    key.startsWith("/") ||
    key.includes("\\") ||
    key.split("/").some((segment) => segment === ".." || segment === ".")
  ) {
    throw new Error(
      `Unsafe storage key ${JSON.stringify(key)}. Keys are relative POSIX paths with no "." or ".." segments.`,
    );
  }
}
