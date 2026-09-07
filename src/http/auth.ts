import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "node:http";

import { config } from "../config.ts";

/**
 * Why this exists at all, given the server only listens on 127.0.0.1:
 *
 * Loopback is not a trust boundary in a browser. Any page you have open — a
 * blog, an ad iframe — can issue `fetch("http://127.0.0.1:5601/api/...")`. The
 * same-origin policy stops it from *reading* the reply, but a plain POST is
 * still delivered and still acts. Since acting here means publishing under your
 * name, the request itself has to be rejected, not just its response hidden.
 *
 * Requiring a custom header does that: a custom header is not a CORS-simple
 * request, so the browser must send a preflight first, and the preflight is
 * refused for any origin we do not recognise. Attaching the shared secret to
 * that same header means a leaked preflight still gets nowhere.
 */

const TOKEN_FILE = path.join(config.stateDir, "ui-token.txt");

export const TOKEN_HEADER = "x-agent-token";

/** Stable across restarts, so the extension does not need re-pairing daily. */
export function loadOrCreateToken(): string {
  if (fs.existsSync(TOKEN_FILE)) {
    const existing = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (existing.length >= 32) return existing;
  }
  const token = crypto.randomBytes(24).toString("hex");
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, `${token}\n`, "utf8");
  return token;
}

/** Constant-time compare, so a wrong token cannot be guessed byte by byte. */
function tokenMatches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * An origin we are willing to talk to. The UI itself is same-origin (browsers
 * omit Origin on same-origin GETs and send our own on POSTs), and a packed
 * extension sends `chrome-extension://<id>`.
 */
export function originAllowed(origin: string | undefined, port: number): boolean {
  if (!origin) return true; // non-browser client, e.g. curl or the extension's service worker
  if (origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://")) {
    return true;
  }
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

export type AuthFailure = { status: number; message: string };

export function checkRequest(
  req: IncomingMessage,
  expectedToken: string,
): AuthFailure | null {
  const origin = req.headers.origin;
  if (!originAllowed(typeof origin === "string" ? origin : undefined, config.uiPort)) {
    return { status: 403, message: `Origin ${String(origin)} is not allowed to call this server.` };
  }

  const header = req.headers[TOKEN_HEADER];
  const supplied = Array.isArray(header) ? header[0] : header;
  if (!supplied || !tokenMatches(supplied, expectedToken)) {
    return {
      status: 401,
      message:
        "Missing or wrong agent token. Open the UI using the URL printed by `npm run ui`, " +
        "which carries the token in its query string.",
    };
  }

  return null;
}
