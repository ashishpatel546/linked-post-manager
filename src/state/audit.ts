import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";

const AUDIT_FILE = path.join(config.stateDir, "audit.jsonl");

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
 * Append-only. Every write against LinkedIn lands here before it is reported as
 * successful, so anything this agent published can be found and deleted later.
 */
export function appendAudit(entry: AuditEntry): void {
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(entry)}\n`, "utf8");
}

export function readAudit(limit = 50): AuditEntry[] {
  if (!fs.existsSync(AUDIT_FILE)) return [];
  const lines = fs
    .readFileSync(AUDIT_FILE, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const entries: AuditEntry[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      // A malformed line should not make the whole log unreadable.
    }
  }
  return entries;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function countPublishedToday(): number {
  const today = todayKey();
  return readAudit(500).filter(
    (entry) =>
      entry.action === "publish" &&
      !entry.dryRun &&
      entry.ts.slice(0, 10) === today,
  ).length;
}

/**
 * Throws if publishing now would exceed the configured daily cap. Called on
 * every real publish, so no sequence of tool calls can run away with the feed.
 */
export function assertUnderDailyLimit(): void {
  const used = countPublishedToday();
  const limit = config.dailyPostLimit;
  if (used >= limit) {
    throw new Error(
      `Daily publish limit reached (${used}/${limit} posts today). Raise LINKEDIN_DAILY_POST_LIMIT in .env if this is intentional.`,
    );
  }
}
