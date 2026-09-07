import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { allScopes, config } from "../config.ts";
import { buildAuthorizeUrl, exchangeCode } from "../auth/oauth.ts";
import { checkAccess, pinningHint, type AccessDecision } from "../core/access.ts";
import { memberUrn } from "../linkedin/me.ts";
import { saveTokens, type TokenSet } from "../state/tokens.ts";
import { runAs, workspaceFor } from "../storage/index.ts";

/**
 * Signing in, for the deployed app.
 *
 * The local install authenticates with a shared secret printed to the terminal,
 * which works because the server is bound to loopback and the terminal belongs
 * to the one person who can reach it. Neither holds on a public URL, so the
 * question there is not "do you have the secret" but "which LinkedIn member are
 * you" — and the answer decides both whether you are allowed in at all and
 * whose drafts you see.
 *
 * The same authorization does double duty. LinkedIn hands back one access
 * token; it identifies the member *and* publishes on their behalf, so signing
 * in is also the step that used to be `npm run auth`. There is no separate
 * "connect your LinkedIn" afterwards, and no way to be signed in as one member
 * while holding a token that posts as another.
 */

const SESSION_COOKIE = "pw_session";
const STATE_COOKIE = "pw_oauth";

/** 30 days. The LinkedIn token behind it lasts 60, so the session lapses first. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;

export type Session = {
  memberUrn: string;
  name: string | null;
  email: string | null;
  /**
   * Carried so the allow-list can be re-checked on every request exactly as it
   * was at sign-in. Without it a re-check would see `undefined` and skip the
   * unverified-email rejection that the original check applied.
   */
  emailVerified?: boolean;
  /** Epoch ms. */
  expiresAt: number;
};

/**
 * A signing key for a local run, kept in `.state/` so it survives restarts.
 *
 * Only ever off a deployment. On Vercel there is no writable disk to keep it
 * on, and a key invented per instance would sign cookies the next cold start
 * could not verify — everyone signed out at random, for a reason that looks
 * like anything but this. There, SESSION_SECRET is required and stays fixed.
 *
 * Locally the alternative was making anyone who wants to try the deployed mode
 * generate a key by hand first, which is a step that teaches nothing.
 */
function localSecret(): string {
  const file = path.join(config.stateDir, "session-secret.txt");
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  }
  const generated = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.writeFileSync(file, `${generated}\n`, "utf8");
  return generated;
}

function secret(): string {
  const value = config.sessionSecret;
  if (value.length < 32 && !config.isServerless) return localSecret();
  if (value.length < 32) {
    throw new Error(
      "SESSION_SECRET is missing or shorter than 32 characters. It signs the " +
        "cookie that says who you are, so a weak one is a forgeable identity. " +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return value;
}

function sign(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

/**
 * Verifies the signature before parsing, and compares in constant time. The
 * order matters: parsing first would run JSON.parse over attacker-chosen bytes
 * for every forged cookie.
 */
function unsign<T>(value: string | undefined): T | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;

  const body = value.slice(0, dot);
  const supplied = value.slice(dot + 1);
  const expected = crypto.createHmac("sha256", secret()).update(body).digest("base64url");

  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * Secure is set whenever the app is reachable over https, which on a deployment
 * is always. SameSite=Lax is the deliberate choice over Strict: the OAuth
 * callback arrives as a top-level navigation from linkedin.com, and Strict
 * would withhold the cookie on exactly that request. Lax still withholds it
 * from cross-site POSTs, which is the case that matters here.
 */
function setCookie(
  res: ServerResponse,
  name: string,
  value: string,
  maxAgeSeconds: number,
): void {
  const https = config.publicUrl.startsWith("https://") || config.isServerless;
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (https) parts.push("Secure");

  const existing = res.getHeader("set-cookie");
  const all = Array.isArray(existing) ? existing : existing ? [String(existing)] : [];
  res.setHeader("set-cookie", [...all, parts.join("; ")]);
}

function clearCookie(res: ServerResponse, name: string): void {
  setCookie(res, name, "", 0);
}

export function sessionFor(req: IncomingMessage): Session | null {
  const session = unsign<Session>(readCookie(req, SESSION_COOKIE));
  if (!session || typeof session.memberUrn !== "string") return null;
  if (!(session.expiresAt > Date.now())) return null;
  return session;
}

/**
 * Re-checks a signed-in member against the allow-list.
 *
 * The cookie is valid for 30 days, so checking only at sign-in meant removing
 * someone from LINKEDIN_ALLOWED_MEMBERS did nothing until their cookie lapsed —
 * they kept posting under your app for up to a month. Revocation that takes a
 * month is not revocation.
 *
 * The list is an environment variable, so this is a string comparison with no
 * I/O: cheap enough to run on every request, which is what makes removal take
 * effect on the next one.
 */
export function accessStillGranted(session: Session): AccessDecision {
  return checkAccess({
    memberUrn: session.memberUrn,
    email: session.email,
    ...(session.emailVerified === undefined ? {} : { emailVerified: session.emailVerified }),
    name: session.name,
  });
}

/** Ends the session from the server's side — used when access is withdrawn. */
export function revokeSession(res: ServerResponse): void {
  clearCookie(res, SESSION_COOKIE);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, "cache-control": "no-store" });
  res.end();
}

/**
 * A whole page rather than JSON, because these are the two moments the user is
 * looking at a browser tab and not at the app: the consent screen refused, or
 * the account is not on the allowlist.
 */
function page(title: string, detail: string): string {
  const escape = (text: string) =>
    text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
  return `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font:16px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;background:#0b0d12;color:#e6e9ef">
<div style="max-width:34rem;margin:4rem auto;padding:0 1.25rem">
<h1 style="font-size:1.3rem;margin:0 0 .75rem">${escape(title)}</h1>
<p style="color:#8b93a3;white-space:pre-wrap">${escape(detail)}</p>
<p><a href="/" style="color:#4a9eff">Back to Postwright</a></p>
</div>`;
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

/** GET /api/login — start the LinkedIn consent flow. */
export function handleLogin(req: IncomingMessage, res: ServerResponse): void {
  // Caught here rather than at LinkedIn, which answers a mismatch with "Bummer,
  // something went wrong. The redirect_uri does not match the registered value"
  // — true, but it names neither value, so the actual cause (a domain that
  // moved while LINKEDIN_REDIRECT_URI stayed behind) is invisible.
  const mismatch = redirectOriginMismatch(req);
  if (mismatch) {
    html(res, 500, page("Sign-in is misconfigured", mismatch));
    return;
  }

  // Random, signed, and short-lived. It comes back through LinkedIn, so the
  // only thing proving the callback belongs to a flow this app started is that
  // the returned value matches a cookie only this app could have written.
  const state = crypto.randomBytes(16).toString("hex");
  setCookie(res, STATE_COOKIE, sign({ state, expiresAt: Date.now() + STATE_TTL_MS }), STATE_TTL_MS / 1000);
  redirect(res, buildAuthorizeUrl(state, config.requestOrgScopes));
}

/**
 * Whether the configured callback points somewhere other than the host being
 * browsed. Returns the explanation, or null when they agree.
 *
 * Renaming a deployment's domain does not touch its environment variables, so
 * the two drift apart silently and the only symptom is LinkedIn's generic
 * refusal. It is also not merely cosmetic: the state cookie is set on the host
 * you are on, so even a registered-but-different callback host would come back
 * without it and fail verification.
 */
function redirectOriginMismatch(req: IncomingMessage): string | null {
  const host = req.headers.host;
  if (!host) return null;

  let configured: URL;
  try {
    configured = new URL(config.redirectUri);
  } catch {
    return `LINKEDIN_REDIRECT_URI is not a valid URL: ${config.redirectUri}`;
  }

  // Compare hosts, not full origins: a proxy can terminate TLS and forward as
  // http, which would make the scheme differ for reasons that are not a fault.
  if (configured.host === host) return null;

  return (
    `This app is being served from ${host}, but LINKEDIN_REDIRECT_URI says the ` +
    `LinkedIn callback is ${config.redirectUri}.\n\n` +
    `Sign-in cannot work while those disagree. Set LINKEDIN_REDIRECT_URI to ` +
    `https://${host}/api/callback, redeploy so the change takes effect, and make ` +
    `sure that same URL is an Authorized redirect URL on the LinkedIn app's Auth tab.\n\n` +
    `The usual cause is a domain that was renamed: changing it does not update ` +
    `the environment variables that referred to the old one.`
  );
}

/** LinkedIn's OIDC identity endpoint, called with a token that is not stored yet. */
async function fetchUserInfo(accessToken: string): Promise<{
  sub: string;
  name?: string;
  email?: string;
  email_verified?: boolean;
}> {
  const response = await fetch("https://api.linkedin.com/v2/userinfo", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `LinkedIn would not say who you are (${response.status}): ${text}\n\n` +
        "This needs the openid, profile and email scopes on the app's Sign In with LinkedIn product.",
    );
  }
  return JSON.parse(text) as { sub: string; name?: string; email?: string; email_verified?: boolean };
}

/** GET /api/callback — LinkedIn redirects here with a code. */
export async function handleCallback(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const denied = url.searchParams.get("error");
  if (denied) {
    html(res, 400, page(
      "Sign-in cancelled",
      `LinkedIn returned: ${url.searchParams.get("error_description") ?? denied}`,
    ));
    return;
  }

  const expected = unsign<{ state: string; expiresAt: number }>(readCookie(req, STATE_COOKIE));
  const returned = url.searchParams.get("state");
  clearCookie(res, STATE_COOKIE);

  if (!expected || !(expected.expiresAt > Date.now()) || !returned || returned !== expected.state) {
    html(res, 400, page(
      "Sign-in could not be verified",
      "The reply from LinkedIn did not match a sign-in this app started, or it took too long. " +
        "Nothing was stored. Start again from the app.",
    ));
    return;
  }

  const code = url.searchParams.get("code");
  if (!code) {
    html(res, 400, page("Sign-in incomplete", "LinkedIn sent no authorization code."));
    return;
  }

  const token = await exchangeCode(code);
  const info = await fetchUserInfo(token.access_token);
  const urn = memberUrn(info.sub);

  // Checked before anything is written. An account that is not allowed must
  // leave no trace: no workspace, no stored token, no session.
  const decision = checkAccess({
    memberUrn: urn,
    email: info.email ?? null,
    emailVerified: info.email_verified,
    name: info.name ?? null,
  });
  if (!decision.allowed) {
    html(res, 403, page("Not on the allowlist", decision.reason));
    return;
  }

  const scope = token.scope
    ? token.scope.split(/[\s,]+/).filter(Boolean)
    : allScopes(config.requestOrgScopes);

  const tokens: TokenSet = {
    accessToken: token.access_token,
    expiresAt: Date.now() + token.expires_in * 1000,
    refreshToken: token.refresh_token,
    refreshTokenExpiresAt: token.refresh_token_expires_in
      ? Date.now() + token.refresh_token_expires_in * 1000
      : undefined,
    scope,
    memberUrn: urn,
    memberName: info.name,
    obtainedAt: Date.now(),
  };

  // Into this member's own tree, never the shared root — the whole reason the
  // workspace layer exists is that one global tokens.json means the second
  // person to sign in publishes as the first.
  await runAs(workspaceFor(urn), () => saveTokens(tokens));

  const hint = pinningHint({ memberUrn: urn, email: info.email ?? null, name: info.name ?? null });
  if (hint) console.log(`[postwright] ${hint}`);

  setCookie(
    res,
    SESSION_COOKIE,
    sign({
      memberUrn: urn,
      name: info.name ?? null,
      email: info.email ?? null,
      ...(info.email_verified === undefined ? {} : { emailVerified: info.email_verified }),
      expiresAt: Date.now() + SESSION_TTL_MS,
    } satisfies Session),
    SESSION_TTL_MS / 1000,
  );
  redirect(res, "/");
}

/**
 * POST /api/logout — forgets the session cookie only.
 *
 * The stored LinkedIn token stays: signing out of a browser is not a request to
 * revoke publishing rights, and re-authorizing takes another trip through
 * LinkedIn. Revoking is done on LinkedIn's side, under Data privacy >
 * Permitted services.
 */
export function handleLogout(res: ServerResponse): void {
  clearCookie(res, SESSION_COOKIE);
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify({ signedOut: true }));
}

/**
 * Same-origin check for cookie-authenticated requests.
 *
 * SameSite=Lax already keeps the cookie off cross-site POSTs, so this is the
 * second lock rather than the first — and it is the one that still holds if a
 * browser's SameSite behaviour turns out to be more permissive than assumed.
 */
export function originIsSelf(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== "string") return true; // same-origin GETs send none
  const host = req.headers.host;
  if (host && origin === `https://${host}`) return true;
  if (host && origin === `http://${host}`) return true;
  return Boolean(config.publicUrl) && origin === config.publicUrl;
}
