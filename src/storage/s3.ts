import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { assertSafeKey, type Storage } from "./types.ts";

/**
 * The same key space as the local backend, as objects in a bucket.
 *
 * Required on Vercel, where the filesystem is read-only outside `/tmp` and
 * `/tmp` is per-instance: a token written by one invocation is simply not there
 * for the next, so every draft and every session would evaporate at random.
 */
export type S3Options = {
  bucket: string;
  region?: string;
  /** Optional path prefix, so one bucket can hold more than this app. */
  prefix?: string;
  /** For S3-compatible stores — Cloudflare R2, MinIO, Backblaze. */
  endpoint?: string;
  forcePathStyle?: boolean;
};

export function s3Storage(options: S3Options): Storage {
  const client = new S3Client({
    ...(options.region ? { region: options.region } : {}),
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    ...(options.forcePathStyle ? { forcePathStyle: true } : {}),
  });

  const base = (options.prefix ?? "").replace(/^\/+|\/+$/g, "");
  const full = (key: string): string => {
    assertSafeKey(key);
    return base ? `${base}/${key}` : key;
  };
  const strip = (key: string): string =>
    base && key.startsWith(`${base}/`) ? key.slice(base.length + 1) : key;

  /**
   * S3 signals absence with an error, not an empty result. Only the two
   * not-found shapes become null — anything else (denied, throttled, network)
   * must surface, or a permissions problem would read as "no drafts yet".
   */
  const isNotFound = (error: unknown): boolean => {
    const name = (error as { name?: string })?.name;
    const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
      ?.httpStatusCode;
    return name === "NoSuchKey" || name === "NotFound" || status === 404;
  };

  const get = async (key: string): Promise<Uint8Array | null> => {
    try {
      const result = await client.send(
        new GetObjectCommand({ Bucket: options.bucket, Key: full(key) }),
      );
      const body = result.Body;
      if (!body) return null;
      return await body.transformToByteArray();
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  };

  const put = async (
    key: string,
    body: Uint8Array | string,
    contentType?: string,
  ): Promise<void> => {
    await client.send(
      new PutObjectCommand({
        Bucket: options.bucket,
        Key: full(key),
        Body: typeof body === "string" ? new TextEncoder().encode(body) : body,
        ...(contentType ? { ContentType: contentType } : {}),
        // Belt and braces on top of the bucket policy: these objects hold a
        // token that publishes under your name, and a bucket whose default
        // encryption was never configured should still not store them in clear.
        ServerSideEncryption: "AES256",
      }),
    );
  };

  return {
    describe: `s3 (${options.bucket}${base ? `/${base}` : ""})`,

    async getText(key) {
      const bytes = await get(key);
      return bytes === null ? null : new TextDecoder().decode(bytes);
    },

    putText: (key, value) => put(key, value, "text/plain; charset=utf-8"),

    getBytes: (key) => get(key),

    putBytes: (key, bytes, contentType) => put(key, bytes, contentType),

    async list(prefix) {
      assertSafeKey(prefix.endsWith("/") ? `${prefix}x` : prefix);
      const found: string[] = [];
      let token: string | undefined;

      // Paginated because ListObjectsV2 caps at 1000 keys and silently
      // truncates; stopping at the first page would quietly hide older entries
      // once the audit log grows past that.
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: options.bucket,
            Prefix: full(prefix),
            ContinuationToken: token,
          }),
        );
        for (const object of page.Contents ?? []) {
          if (object.Key) found.push(strip(object.Key));
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);

      // Match the local backend: one level only. S3 has no directories, so a
      // raw prefix query would also return everything nested beneath — and a
      // draft listing that swept the whole tree would grow without bound.
      //
      // Segment count does both cases: "drafts/" splits to 2 and so does
      // "drafts/x.md" (but "drafts/sub/x.md" splits to 3), while a partial name
      // like ".state/audit/2026-09" splits to 3 and matches keys at that depth.
      const depth = prefix.split("/").length;
      return found.filter((key) => key.split("/").length === depth).sort();
    },

    async remove(key) {
      await client.send(
        new DeleteObjectCommand({ Bucket: options.bucket, Key: full(key) }),
      );
    },

    async exists(key) {
      try {
        await client.send(
          new HeadObjectCommand({ Bucket: options.bucket, Key: full(key) }),
        );
        return true;
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },

    async stat(key) {
      try {
        const head = await client.send(
          new HeadObjectCommand({ Bucket: options.bucket, Key: full(key) }),
        );
        return { bytes: head.ContentLength ?? 0 };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
  };
}
