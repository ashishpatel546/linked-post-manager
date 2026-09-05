import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");

// Load .env by hand rather than pulling dotenv into every entrypoint: the MCP
// server runs with an inherited environment that may already carry these.
function parseDotEnv(): Map<string, string> {
  const parsed = new Map<string, string>();
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return parsed;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed.set(key, value);
  }
  return parsed;
}

function loadDotEnv(): void {
  for (const [key, value] of parseDotEnv()) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

/**
 * Read a key straight from .env on disk, ignoring what this process booted
 * with. The loader above only fills gaps in the inherited environment and runs
 * once, so a long-lived stdio server keeps its startup value forever: edit
 * .env while it is running and the file and the live config silently disagree.
 * Error messages use this to tell "you have not set it" apart from "you set it
 * but this process has not been restarted".
 */
export function envFileValue(key: string): string | undefined {
  return parseDotEnv().get(key);
}

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `Missing ${key}. Copy .env.example to .env and fill it in (see README, Phase 0).`,
    );
  }
  return value;
}

/** Exported so callers reading .env directly interpret it the same way. */
export function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return value.toLowerCase() === "true" || value === "1";
}

function bool(key: string, fallback: boolean): boolean {
  return parseBool(process.env[key], fallback);
}

function int(key: string, fallback: number): number {
  const value = process.env[key];
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  get clientId() {
    return required("LINKEDIN_CLIENT_ID");
  },
  get clientSecret() {
    return required("LINKEDIN_CLIENT_SECRET");
  },
  get redirectUri() {
    return process.env.LINKEDIN_REDIRECT_URI ?? "http://localhost:5599/callback";
  },
  get organizationUrn() {
    return process.env.LINKEDIN_ORGANIZATION_URN ?? "";
  },
  get apiVersion() {
    return process.env.LINKEDIN_API_VERSION ?? "202608";
  },
  get dailyPostLimit() {
    return int("LINKEDIN_DAILY_POST_LIMIT", 5);
  },
  /**
   * Appended to every post and every article's commentary when set. Empty
   * disables it entirely, which is the default — a link nobody configured
   * should never appear on someone's feed.
   */
  get profileLink() {
    return (process.env.LINKEDIN_PROFILE_LINK ?? "").trim();
  },
  get profileLinkLabel() {
    return (process.env.LINKEDIN_PROFILE_LINK_LABEL ?? "More:").trim();
  },
  /**
   * Kill switch. While true every publish path returns a preview instead of
   * calling LinkedIn, no matter what arguments a tool was given.
   */
  get forceDryRun() {
    return bool("LINKEDIN_FORCE_DRY_RUN", true);
  },
  stateDir: path.join(ROOT, ".state"),
  draftsDir: path.join(ROOT, "drafts"),

  // ---- Draft generation (used by the browser extension, not by MCP) ----
  // In Claude Code the drafting is done by Claude in your session, so none of
  // this is consulted. It only matters for front ends that have no model of
  // their own.
  get draftProvider(): string {
    return process.env.DRAFT_PROVIDER ?? "ollama";
  },
  get ollamaBaseUrl() {
    return process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  },
  get ollamaModel() {
    return process.env.OLLAMA_MODEL ?? "llama3.1";
  },
  get openaiBaseUrl() {
    return process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  },
  get openaiApiKey() {
    return process.env.OPENAI_API_KEY ?? "";
  },
  get openaiModel() {
    return process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  },
  get claudeCodeBin() {
    return process.env.CLAUDE_CODE_BIN ?? (process.platform === "win32" ? "claude.cmd" : "claude");
  },
} as const;

/** Scopes we request. Split by which LinkedIn product grants them. */
export const SCOPES = {
  /** "Sign In with LinkedIn using OpenID Connect" — self-serve. */
  identity: ["openid", "profile", "email"],
  /** "Share on LinkedIn" — self-serve. Publish to your own profile. */
  member: ["w_member_social"],
  /** "Community Management API" — requires admin verification / review. */
  organization: [
    "w_organization_social",
    "r_organization_social",
    "rw_organization_admin",
  ],
} as const;

export function allScopes(includeOrg: boolean): string[] {
  return [
    ...SCOPES.identity,
    ...SCOPES.member,
    ...(includeOrg ? SCOPES.organization : []),
  ];
}
