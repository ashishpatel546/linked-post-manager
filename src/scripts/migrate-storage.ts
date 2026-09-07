import fs from "node:fs/promises";
import path from "node:path";

import { ROOT } from "../config.ts";
import { localStorage } from "../storage/local.ts";
import { s3Storage } from "../storage/s3.ts";

/**
 * Copies the local store into S3, so switching STORAGE_BACKEND does not look
 * like the app forgot everything.
 *
 * The two backends use identical keys, so this is a straight copy — no
 * rewriting, no mapping table. What it is careful about:
 *
 * - It reads local and writes S3, never the reverse. There is no path here
 *   that can delete or truncate the working copy.
 * - It skips a key that already exists in the bucket unless --force, so
 *   running it twice cannot clobber something newer that was written on S3.
 * - It prints the plan and stops, unless --yes. This copies a LinkedIn token
 *   that publishes under your name into a bucket; that deserves a look first.
 *
 * Usage:
 *   node src/scripts/migrate-storage.ts          # plan only
 *   node src/scripts/migrate-storage.ts --yes    # copy
 *   node src/scripts/migrate-storage.ts --yes --force
 */

/** The whole key space, including per-member workspaces under users/. */
const ROOTS = [".state", "drafts", "published", "assets", "users"];

async function walk(dir: string, prefix: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const keys: string[] = [];
  for (const entry of entries) {
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      keys.push(...(await walk(path.join(dir, entry.name), key)));
    } else if (entry.isFile() && !entry.name.endsWith(".tmp")) {
      keys.push(key);
    }
  }
  return keys;
}

function contentType(key: string): string | undefined {
  const extension = path.extname(key).toLowerCase();
  const types: Record<string, string> = {
    ".md": "text/markdown; charset=utf-8",
    ".json": "application/json",
    ".jsonl": "application/x-ndjson",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".txt": "text/plain; charset=utf-8",
  };
  return types[extension];
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function main(): Promise<void> {
  const write = process.argv.includes("--yes");
  const force = process.argv.includes("--force");

  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error("S3_BUCKET is not set in .env — nothing to migrate into.");
  }

  const local = localStorage(ROOT);
  const remote = s3Storage({
    bucket,
    region: process.env.AWS_REGION,
    prefix: process.env.S3_PREFIX,
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  });

  const keys: string[] = [];
  for (const root of ROOTS) keys.push(...(await walk(path.join(ROOT, root), root)));

  // The UI's shared secret is deliberately excluded: it is server-level, tied
  // to this machine's loopback listener, and regenerated on first run anywhere
  // else. Copying it would put a live credential in the bucket for nothing.
  const migrating = keys.filter((key) => key !== ".state/ui-token.txt").sort();

  console.log(`\n  from  ${local.describe}`);
  console.log(`  to    ${remote.describe}`);
  console.log(`  mode  ${write ? (force ? "copy, overwriting" : "copy, skipping what is already there") : "plan only (pass --yes to copy)"}\n`);

  if (migrating.length === 0) {
    console.log("  Nothing to migrate — the local store is empty.\n");
    return;
  }

  let copied = 0;
  let skipped = 0;
  let bytes = 0;

  for (const key of migrating) {
    const data = await local.getBytes(key);
    if (!data) continue;

    if (!write) {
      console.log(`  would copy  ${key.padEnd(64)} ${human(data.byteLength)}`);
      bytes += data.byteLength;
      continue;
    }

    if (!force && (await remote.exists(key))) {
      console.log(`  skip        ${key} (already in the bucket)`);
      skipped += 1;
      continue;
    }

    await remote.putBytes(key, data, contentType(key));
    console.log(`  copied      ${key.padEnd(64)} ${human(data.byteLength)}`);
    copied += 1;
    bytes += data.byteLength;
  }

  console.log(
    write
      ? `\n  ${copied} object(s) copied, ${skipped} skipped, ${human(bytes)} transferred.`
      : `\n  ${migrating.length} object(s), ${human(bytes)}. Re-run with --yes to copy.`,
  );

  if (write) {
    console.log(
      "\n  Now set STORAGE_BACKEND=s3 in .env and restart. The local files stay\n" +
        "  where they are — nothing here deletes them — so you can switch back by\n" +
        "  setting it to local again.\n",
    );
  } else {
    console.log(
      "\n  Note: this includes .state/tokens.json, the LinkedIn token that\n" +
        "  publishes as you. The bucket must be private.\n",
    );
  }
}

await main();
