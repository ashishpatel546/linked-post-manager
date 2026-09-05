import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";

const TOKEN_FILE = path.join(config.stateDir, "tokens.json");

export type TokenSet = {
  accessToken: string;
  /** Epoch ms. LinkedIn member tokens are 60 days. */
  expiresAt: number;
  refreshToken?: string;
  refreshTokenExpiresAt?: number;
  scope: string[];
  /** urn:li:person:xxx, cached from /v2/userinfo at auth time. */
  memberUrn?: string;
  memberName?: string;
  obtainedAt: number;
};

export function loadTokens(): TokenSet | null {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")) as TokenSet;
  } catch {
    return null;
  }
}

export function saveTokens(tokens: TokenSet): void {
  fs.mkdirSync(config.stateDir, { recursive: true });
  // Write to a sibling temp file and rename, so a crash mid-write cannot leave
  // a truncated token file behind.
  const tmp = `${TOKEN_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(tokens, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tmp, TOKEN_FILE);
}

export type TokenStatus = {
  authorized: boolean;
  expired: boolean;
  expiresAt: string | null;
  daysRemaining: number | null;
  scope: string[];
  memberUrn: string | null;
  memberName: string | null;
  canPublishAsMember: boolean;
  canPublishAsOrganization: boolean;
  canReadOrganization: boolean;
  hint: string;
};

export function tokenStatus(): TokenStatus {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      authorized: false,
      expired: true,
      expiresAt: null,
      daysRemaining: null,
      scope: [],
      memberUrn: null,
      memberName: null,
      canPublishAsMember: false,
      canPublishAsOrganization: false,
      canReadOrganization: false,
      hint: "Not authorized yet. Run `npm run auth` and complete the LinkedIn consent screen in your browser.",
    };
  }

  const msRemaining = tokens.expiresAt - Date.now();
  const daysRemaining = Math.floor(msRemaining / 86_400_000);
  const expired = msRemaining <= 0;
  const has = (scope: string) => tokens.scope.includes(scope);

  let hint: string;
  if (expired) {
    hint = "Access token has expired. Run `npm run auth` again to re-authorize.";
  } else if (daysRemaining <= 7) {
    hint = `Access token expires in ${daysRemaining} day(s). Run \`npm run auth\` to refresh it.`;
  } else {
    hint = `Access token valid for ${daysRemaining} more day(s).`;
  }

  return {
    authorized: true,
    expired,
    expiresAt: new Date(tokens.expiresAt).toISOString(),
    daysRemaining,
    scope: tokens.scope,
    memberUrn: tokens.memberUrn ?? null,
    memberName: tokens.memberName ?? null,
    canPublishAsMember: has("w_member_social"),
    canPublishAsOrganization: has("w_organization_social"),
    canReadOrganization: has("r_organization_social"),
    hint,
  };
}

/**
 * Returns a usable access token, refreshing it first if LinkedIn issued a
 * refresh token and the current one is close to expiry. Throws with an
 * actionable message rather than letting a 401 surface from deep in a call.
 */
export async function requireAccessToken(): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) {
    throw new Error(
      "Not authorized with LinkedIn yet. Run `npm run auth` in the project directory, then retry.",
    );
  }

  const msRemaining = tokens.expiresAt - Date.now();
  if (msRemaining > 5 * 60_000) return tokens.accessToken;

  if (tokens.refreshToken) {
    const refreshed = await refreshAccessToken(tokens);
    if (refreshed) return refreshed.accessToken;
  }

  throw new Error(
    "LinkedIn access token has expired and could not be refreshed. Run `npm run auth` to re-authorize.",
  );
}

/**
 * LinkedIn only issues refresh tokens to apps enabled for them; most apps
 * re-run the consent flow every 60 days instead. Returns null on any failure so
 * callers can fall back to telling the user to re-auth.
 */
export async function refreshAccessToken(
  tokens: TokenSet,
): Promise<TokenSet | null> {
  if (!tokens.refreshToken) return null;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  const response = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) return null;

  const json = (await response.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
    scope?: string;
  };

  const next: TokenSet = {
    ...tokens,
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
    refreshToken: json.refresh_token ?? tokens.refreshToken,
    refreshTokenExpiresAt: json.refresh_token_expires_in
      ? Date.now() + json.refresh_token_expires_in * 1000
      : tokens.refreshTokenExpiresAt,
    scope: json.scope ? json.scope.split(/[\s,]+/).filter(Boolean) : tokens.scope,
    obtainedAt: Date.now(),
  };

  saveTokens(next);
  return next;
}
