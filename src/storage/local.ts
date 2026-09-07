import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";

import { assertSafeKey, type Storage } from "./types.ts";

/**
 * Keys map straight onto paths under `base`, so `drafts/x.md` is the file that
 * has always been at `drafts/x.md`. Nothing moves when this abstraction is
 * introduced, and a draft stays a markdown file you can open in an editor —
 * which was the point of drafts being files in the first place.
 */
export function localStorage(base: string): Storage {
  const resolve = (key: string): string => {
    assertSafeKey(key);
    return path.join(base, ...key.split("/"));
  };

  const missingIsNull = async <T>(read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };

  /** Temp-then-rename, so a crash mid-write cannot truncate the target. */
  const writeAtomic = async (key: string, data: string | Uint8Array): Promise<void> => {
    const file = resolve(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    try {
      // Same directory as the target, so the rename is atomic rather than a
      // cross-device copy.
      await fs.writeFile(temp, data, typeof data === "string" ? "utf8" : undefined);
      await fs.rename(temp, file);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
  };

  return {
    describe: `local (${base})`,

    getText: (key) => missingIsNull(() => fs.readFile(resolve(key), "utf8")),

    putText: (key, value) => writeAtomic(key, value),

    getBytes: (key) =>
      missingIsNull(async () => new Uint8Array(await fs.readFile(resolve(key)))),

    putBytes: (key, bytes) => writeAtomic(key, bytes),

    async list(prefix) {
      // A prefix may name a directory ("drafts/") or a partial file name
      // ("state/audit/2026-09-06"), so split at the last separator and filter.
      const slash = prefix.lastIndexOf("/");
      const dirKey = slash === -1 ? "" : prefix.slice(0, slash);
      const stem = slash === -1 ? prefix : prefix.slice(slash + 1);
      const dir = dirKey === "" ? base : resolve(dirKey);

      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }

      return entries
        // Files only. S3 has no directories, so returning one here would make
        // the two backends disagree — and a caller that read every listed key
        // would hit EISDIR on the local one and nothing on the other.
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((name) => name.startsWith(stem) && !name.endsWith(".tmp"))
        .map((name) => (dirKey === "" ? name : `${dirKey}/${name}`))
        .sort();
    },

    async remove(key) {
      await fs.rm(resolve(key), { force: true });
    },

    async exists(key) {
      try {
        await fs.access(resolve(key));
        return true;
      } catch {
        return false;
      }
    },

    async stat(key) {
      try {
        const info = await fs.stat(resolve(key));
        return { bytes: info.size };
      } catch {
        return null;
      }
    },
  };
}
