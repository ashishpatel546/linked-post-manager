import crypto from "node:crypto";

import { config } from "../config.ts";
import { getJson, keys, putJson, storage } from "../storage/index.ts";

/**
 * Cost note, since this is the hot path on S3.
 *
 * Reading the log is one LIST plus one GET per entry actually shown, and the
 * daily count is a LIST alone. What used to happen: every `/api/status` — so
 * every page load and every Refresh — called countPublishedToday, which read
 * the 500 most recent entries in full to count today's. On a bucket with 77
 * entries that was 77 GETs to compute the number 1.
 */

export type AuditEntry = {
  ts: string;
  action: "publish" | "delete" | "comment";
  target: "member" | "organization";
  authorUrn: string;
  /** URN LinkedIn returned for the created object, when there is one. */
  urn?: string;
  summary: string;
  dryRun: boolean;
};

/**
 * One object per entry rather than one appended file.
 *
 * S3 has no append: writing entry N+1 into a single object means reading the
 * whole log, adding a line, and putting it back, which loses entries whenever
 * two writes overlap. An object per entry has no such window, and the key
 * carries the timestamp so a prefix listing answers "what went out today"
 * without reading anything.
 */
export async function appendAudit(entry: AuditEntry): Promise<void> {
  // A dry run sent nothing, so there is nothing to be accountable for — and on
  // S3 every one of them was a PUT. Previewing a post half a dozen times while
  // editing it wrote six objects recording that nothing happened. Off by
  // default; set LINKEDIN_AUDIT_DRY_RUNS=true to keep the full trace.
  if (entry.dryRun && !config.auditDryRuns) return;

  const nonce = crypto.randomBytes(4).toString("hex");
  // The action is in the key so "how many posts went out today" is answerable
  // from a listing alone. It used to read all 500 most recent entries — a GET
  // each — on every page load, to count a number that is almost always 0 or 1.
  //
  // A dry run is labelled "dryrun" rather than by its action, because the
  // counting is done on the key: labelling a preview "publish" would let
  // previews eat the daily cap for anyone who turns dry-run auditing on.
  const label = entry.dryRun ? "dryrun" : entry.action;
  await putJson(storage, keys.auditEntry(entry.ts, label, nonce), entry);
}

/**
 * Newest last, matching the old file order. Reads the per-entry objects and
 * folds in the legacy `.state/audit.jsonl` if it is still there, so upgrading
 * does not orphan the record of anything already published.
 */
export async function readAudit(limit = 50): Promise<AuditEntry[]> {
  const legacy = await readLegacyAudit();

  // Keys embed the timestamp, so a lexical sort is chronological and only the
  // tail needs fetching however long the log gets.
  //
  // The tail of *each* source is taken, then merged — never a budget shared
  // between them. Splitting the budget had two failure modes, both live: with
  // no legacy file, `slice(-0)` returned the whole array and fetched every
  // entry on every page load; with a legacy file longer than the limit, the
  // object entries were never read at all, so nothing published after the
  // split ever appeared in Recent activity.
  const objectKeys = (await storage.list(keys.auditPrefix)).sort();
  const wanted = objectKeys.slice(-limit);

  const loaded = await Promise.all(
    wanted.map((key) => getJson<AuditEntry>(storage, key)),
  );

  const entries = [
    ...legacy.slice(-limit),
    ...loaded.filter((e): e is AuditEntry => e !== null),
  ];
  entries.sort((a, b) => a.ts.localeCompare(b.ts));
  return entries.slice(-limit);
}

/**
 * Memoised for the life of the process: nothing writes this file any more, so
 * re-reading it on every status call and every audit read was a request per
 * page load to learn the same thing — usually that it does not exist.
 */
let legacyCache: AuditEntry[] | null = null;

async function readLegacyAudit(): Promise<AuditEntry[]> {
  if (legacyCache) return legacyCache;

  const raw = await storage.getText(keys.legacyAudit);
  if (raw === null) {
    legacyCache = [];
    return legacyCache;
  }

  const entries: AuditEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      // A malformed line should not make the whole log unreadable.
    }
  }
  legacyCache = entries;
  return entries;
}

/**
 * How many posts actually went out today, for the daily cap and the header.
 *
 * One LIST and, normally, no GETs: today's date and the action are both in the
 * key, and dry runs are not written at all. Only entries in the older
 * `<ts>-<nonce>` shape have to be opened to find out what they were, and only
 * those from today — a set that empties itself as the day rolls over.
 */
export async function countPublishedToday(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const keysToday = await storage.list(`${keys.auditPrefix}${today}`);

  let count = 0;
  const legacy: string[] = [];

  for (const key of keysToday) {
    const name = key.slice(keys.auditPrefix.length);
    if (name.includes("-publish-")) count += 1;
    else if (!/-(dryrun|delete|comment)-/.test(name)) legacy.push(key);
  }

  if (legacy.length > 0) {
    // Only entries written before the action was in the key, and only today's,
    // so this set is bounded and empties itself when the date rolls over. It
    // is still a GET each, which is why `npm run audit:prune` exists.
    const entries = await Promise.all(legacy.map((key) => getJson<AuditEntry>(storage, key)));
    count += entries.filter((e) => e?.action === "publish" && !e.dryRun).length;
  }

  // The pre-split log, if it is still around.
  const fromLegacyFile = (await readLegacyAudit()).filter(
    (entry) => entry.action === "publish" && !entry.dryRun && entry.ts.slice(0, 10) === today,
  ).length;

  return count + fromLegacyFile;
}

/**
 * Throws if publishing now would exceed the configured daily cap. Called on
 * every real publish, so no sequence of tool calls can run away with the feed.
 */
export async function assertUnderDailyLimit(): Promise<void> {
  const used = await countPublishedToday();
  const limit = config.dailyPostLimit;
  if (used >= limit) {
    throw new Error(
      `Daily publish limit reached (${used}/${limit} posts today). Raise LINKEDIN_DAILY_POST_LIMIT in .env if this is intentional.`,
    );
  }
}
