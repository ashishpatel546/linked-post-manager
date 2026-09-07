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
    if (process.env.LINKEDIN_REDIRECT_URI) return process.env.LINKEDIN_REDIRECT_URI;
    // On a deployment the callback is a route of the app itself, so it can be
    // derived — but only as a convenience. LinkedIn matches this value against
    // the app's Authorized redirect URLs character for character, so whatever
    // it resolves to still has to be registered there.
    const base = config.publicUrl;
    if (base) return `${base}/api/callback`;
    return "http://localhost:5599/callback";
  },
  get organizationUrn() {
    return process.env.LINKEDIN_ORGANIZATION_URN ?? "";
  },
  /**
   * Display name for the company page. Cosmetic — it labels the author in the
   * post preview, so that a company post looks like one before it goes out.
   * The API identifies the page by URN regardless of what this says.
   */
  get organizationName() {
    return (process.env.LINKEDIN_ORGANIZATION_NAME ?? "").trim();
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
  assetsDir: path.join(ROOT, "assets"),

  // ---- Access control (deployments only) ----
  /**
   * Who may sign in. Emails and/or member URNs, comma separated.
   *
   * Registering the LinkedIn app does not restrict who can authorize it — it
   * is an OAuth client, like "Sign in with Google" — so on a public URL this
   * list is what stands between a stranger and your app's LinkedIn quota,
   * your provider key, and your name on whatever they post.
   */
  get allowedMembers(): string[] {
    return (process.env.LINKEDIN_ALLOWED_MEMBERS ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0);
  },

  /**
   * Whether a signed-in member is required for every storage access. Off for
   * the local single-user install; on for any deployment, where an unscoped
   * key would be one tree shared by everyone who signs in.
   */
  get requireIdentity() {
    return bool("REQUIRE_IDENTITY", false);
  },

  // ---- Local web UI ----
  // Bound to loopback only, always. This process holds a token that publishes
  // as you for 60 days; it must never be reachable from the network.
  get uiPort() {
    return int("UI_PORT", 5601);
  },

  // ---- Deployment ----
  /** True inside a Vercel build or function. */
  get isServerless(): boolean {
    return Boolean(process.env.VERCEL);
  },

  /**
   * How the web UI decides who is calling.
   *
   * "token" — the shared secret printed by `npm run ui`. Correct on a laptop,
   *           where the server is bound to loopback and the terminal that
   *           printed the secret belongs to the one person who can see it.
   * "oauth" — sign in with LinkedIn; a signed cookie carries the member URN,
   *           and every request runs inside that member's workspace.
   *
   * A deployment is not reachable only from loopback and has no terminal, so
   * "token" is not an option there — hence the default flips on Vercel rather
   * than waiting to be configured.
   */
  get authMode(): "token" | "oauth" {
    const explicit = (process.env.UI_AUTH ?? "").trim().toLowerCase();
    if (explicit === "oauth" || explicit === "token") return explicit;
    return config.isServerless ? "oauth" : "token";
  },

  /**
   * HMAC key for the session cookie. No default and no generated fallback: a
   * key invented per instance would sign cookies that the next cold start
   * cannot verify, so everyone would be signed out at random and the cause
   * would look like anything but this.
   */
  get sessionSecret(): string {
    return (process.env.SESSION_SECRET ?? "").trim();
  },

  /**
   * Where the app is reachable from outside, without a trailing slash. Used to
   * build the OAuth callback and to recognise the app's own origin.
   *
   * VERCEL_PROJECT_PRODUCTION_URL is the stable production hostname;
   * VERCEL_URL changes with every deployment, so it is only the fallback — a
   * per-deployment URL cannot be a registered OAuth redirect.
   */
  get publicUrl(): string {
    // APP_URL first: Vercel refuses to store any variable whose name begins
    // with PUBLIC_, on the grounds that some frameworks expose those to the
    // browser. PUBLIC_URL still works everywhere else, and is kept because it
    // is the name people reach for.
    const explicit = (process.env.APP_URL ?? process.env.PUBLIC_URL ?? "")
      .trim()
      .replace(/\/+$/, "");
    if (explicit) return explicit;
    const host =
      process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL ?? "";
    return host ? `https://${host}` : "";
  },

  /**
   * Whether signing in asks for the company-page scopes as well.
   *
   * Off by default because asking for a scope the LinkedIn app has not been
   * granted makes LinkedIn reject the whole consent screen — so an app still
   * waiting on Community Management API approval would be unable to sign
   * anyone in at all. Same reasoning as `npm run auth --member-only`.
   */
  get requestOrgScopes() {
    return bool("LINKEDIN_REQUEST_ORG_SCOPES", false);
  },

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
  /**
   * Claude Code ships two ways on Windows: the npm install puts a `claude.cmd`
   * shim on PATH, the native installer puts `claude.exe` in ~/.local/bin. The
   * old default assumed the shim, so a perfectly working native install
   * reported the provider as unavailable and greyed it out.
   *
   * `claude` resolves either through PATHEXT, so it is the better default.
   * The explicit ~/.local/bin probe covers a native install whose directory was
   * never added to PATH — common, and invisible from the error message.
   */
  /** Model alias or id for headless drafting. Empty means the CLI's default. */
  get claudeCodeModel(): string {
    return process.env.CLAUDE_CODE_MODEL ?? "";
  },

  /**
   * Whether a dry run is written to the audit log. Off by default: it records
   * that nothing happened, and on S3 each one is a PUT — previewing a post six
   * times while editing it wrote six objects saying so.
   */
  get auditDryRuns() {
    return bool("LINKEDIN_AUDIT_DRY_RUNS", false);
  },

  /**
   * What to keep once a post is live.
   *
   * "stub" — a few hundred bytes: id, topic, URN, when. Enough to list it and
   *          link straight to the post. The markdown and the rendered deck are
   *          deleted, because the post itself is now on LinkedIn.
   * "full" — the whole record, prose and deck included. The only way to read
   *          the text back later: LinkedIn will not serve a personal post to
   *          the API, since `r_member_social` is a closed permission.
   */
  get keepPublished(): "stub" | "full" {
    return (process.env.LINKEDIN_KEEP_PUBLISHED ?? "stub") === "full" ? "full" : "stub";
  },

  /** Default carousel colour scheme: dark | light. A draft can override it. */
  get deckTheme(): string {
    return process.env.LINKEDIN_DECK_THEME ?? "dark";
  },

  /**
   * Which store is actually in use. Surfaced so the UI can say so: with S3
   * configured but the backend left on "local", the bucket settings sit there
   * looking active while every draft is written to disk.
   */
  get storageBackend(): string {
    return (process.env.STORAGE_BACKEND ?? "local").toLowerCase();
  },

  // ---- Research ----
  /** Brave Search — web, topic suggestions, images. Optional. */
  get braveApiKey(): string {
    return process.env.BRAVE_API_KEY ?? "";
  },

  get claudeCodeBin() {
    if (process.env.CLAUDE_CODE_BIN) return process.env.CLAUDE_CODE_BIN;

    const home = process.env.USERPROFILE ?? process.env.HOME;
    if (home) {
      const native = path.join(
        home,
        ".local",
        "bin",
        process.platform === "win32" ? "claude.exe" : "claude",
      );
      if (fs.existsSync(native)) return native;
    }
    return "claude";
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
