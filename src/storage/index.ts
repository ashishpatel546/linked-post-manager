import { ROOT } from "../config.ts";
import { localStorage } from "./local.ts";
import { s3Storage } from "./s3.ts";
import { currentWorkspace } from "./workspace.ts";
import type { Storage } from "./types.ts";

export type { Storage } from "./types.ts";
export { getJson, putJson } from "./types.ts";
export { currentWorkspace, runAs, workspaceFor, SOLO, type Workspace } from "./workspace.ts";

/**
 * Which backend the process uses, decided once at startup.
 *
 * `local` is the default everywhere, including on a developer machine that has
 * S3 credentials lying around in the environment: a store that publishes under
 * your name should be chosen deliberately, not inherited from an env var that
 * happened to be exported.
 */
function select(): Storage {
  const backend = (process.env.STORAGE_BACKEND ?? "local").toLowerCase();

  switch (backend) {
    case "local":
      return localStorage(ROOT);
    case "s3": {
      const bucket = process.env.S3_BUCKET;
      if (!bucket) {
        throw new Error(
          "STORAGE_BACKEND=s3 but S3_BUCKET is not set. Credentials come from the " +
            "standard AWS chain (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, or an " +
            "instance role).",
        );
      }
      return s3Storage({
        bucket,
        region: process.env.AWS_REGION,
        prefix: process.env.S3_PREFIX,
        endpoint: process.env.S3_ENDPOINT,
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      });
    }
    default:
      throw new Error(
        `Unknown STORAGE_BACKEND "${backend}". Expected "local" or "s3".`,
      );
  }
}

export const storage: Storage = select();

// ---------------------------------------------------------------- key space --
//
// One place that names every key, so the layout can be read at a glance and a
// typo in a prefix cannot quietly split a namespace in two.

/**
 * Every key is prefixed with the current workspace, so the same call reads one
 * person's data under a session and the plain local files when running solo.
 * Getters rather than constants because the prefix is per request, not per
 * process — a constant captured at module load would pin the first caller's
 * scope onto everyone.
 */
const scope = (): string => currentWorkspace().prefix;

export const keys = {
  get tokens() {
    return `${scope()}.state/tokens.json`;
  },
  /** Server-level, not per member: the local UI's shared secret. Never scoped. */
  uiToken: ".state/ui-token.txt",

  /** Where a member's own provider key lives, encrypted. Never plaintext. */
  get providerKey() {
    return `${scope()}.state/provider-key.enc`;
  },

  /** Legacy single-file audit log, folded in on read. See state/audit.ts. */
  get legacyAudit() {
    return `${scope()}.state/audit.jsonl`;
  },
  get auditPrefix() {
    return `${scope()}.state/audit/`;
  },
  /**
   * `<timestamp>-<action>-<nonce>.json`. The action rides in the key so the
   * daily cap can be enforced from a listing, with no object reads at all.
   * Entries written before this carry no action segment and are read normally.
   */
  auditEntry: (ts: string, action: string, nonce: string) =>
    `${scope()}.state/audit/${ts.replace(/[:.]/g, "-")}-${action}-${nonce}.json`,

  get draftsPrefix() {
    return `${scope()}drafts/`;
  },
  draft: (id: string) => `${scope()}drafts/${id}.md`,
  draftArticle: (id: string) => `${scope()}drafts/${id}.article.md`,
  /** Rendered carousel. Regenerated on every publish call, so safe to delete. */
  draftPdf: (id: string) => `${scope()}drafts/${id}.pdf`,

  /**
   * Where a draft goes once it is live. Kept because the audit entry stores
   * only a 120-character summary, and a personal post cannot be read back from
   * the API — `r_member_social` is a closed permission — so deleting the draft
   * outright would destroy the only full copy of what was published.
   */
  get publishedPrefix() {
    return `${scope()}published/`;
  },
  published: (id: string) => `${scope()}published/${id}.md`,
  /**
   * The lightweight record kept under LINKEDIN_KEEP_PUBLISHED=stub: a few
   * hundred bytes naming the post and its URN, so the list can still link
   * straight to it once the markdown and the deck are gone.
   */
  publishedStub: (id: string) => `${scope()}published/${id}.json`,
  /** The prose and the deck that actually went out, kept beside the record. */
  publishedArticle: (id: string) => `${scope()}published/${id}.article.md`,
  publishedPdf: (id: string) => `${scope()}published/${id}.pdf`,

  asset: (name: string) => `${scope()}assets/${name}`,
} as const;
