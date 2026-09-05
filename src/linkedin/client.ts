import { config } from "../config.ts";
import { requireAccessToken } from "../state/tokens.ts";

const API_BASE = "https://api.linkedin.com";

export class LinkedInApiError extends Error {
  status: number;
  serviceErrorCode?: number;
  raw: string;

  constructor(
    message: string,
    status: number,
    raw: string,
    serviceErrorCode?: number,
  ) {
    super(message);
    this.name = "LinkedInApiError";
    this.status = status;
    this.raw = raw;
    this.serviceErrorCode = serviceErrorCode;
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Extra headers, merged last. */
  headers?: Record<string, string>;
};

function buildUrl(
  apiPath: string,
  query?: Record<string, string | number | undefined>,
): string {
  const url = new URL(apiPath.startsWith("http") ? apiPath : API_BASE + apiPath);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Turns a LinkedIn error body into something worth reading. The two failures
 * that actually happen in practice are an expired token and a scope the app was
 * never granted, and both are opaque unless spelled out.
 */
function explain(status: number, raw: string, apiPath: string): LinkedInApiError {
  let serviceErrorCode: number | undefined;
  let message = raw;

  try {
    const parsed = JSON.parse(raw) as {
      message?: string;
      serviceErrorCode?: number;
    };
    if (parsed.message) message = parsed.message;
    serviceErrorCode = parsed.serviceErrorCode;
  } catch {
    // Non-JSON error body; keep the raw text.
  }

  let hint = "";
  if (status === 401) {
    hint =
      " — the access token is invalid or expired. Run `npm run auth` to re-authorize.";
  } else if (status === 403) {
    hint =
      " — the token lacks a required scope, or the app has not been granted the product for this call. Organization endpoints need the Community Management API product; check `linkedin_token_status`.";
  } else if (status === 426 || /version/i.test(message)) {
    hint = ` — LINKEDIN_API_VERSION (${config.apiVersion}) may be deprecated. Bump it to a newer YYYYMM value in .env.`;
  } else if (status === 429) {
    hint = /share limit/i.test(message)
      ? " — the author hit LinkedIn's daily share limit. This is a per-member cap on LinkedIn's side, not our LINKEDIN_DAILY_POST_LIMIT; wait until tomorrow."
      : " — LinkedIn rate limit hit. Community Management Development tier allows 500 calls per app and 100 per member per 24h.";
  } else if (status === 422 && /duplicate/i.test(message)) {
    hint =
      " — LinkedIn rejected this as a duplicate of a recent post. Wait 10 minutes or change the text.";
  } else if (status === 400 && /unrecognized character escape/i.test(message)) {
    hint =
      " — the commentary escaped a character it should not have. See escapeCommentary() in src/linkedin/text.ts.";
  } else if (status === 401 && /unauthorized to create/i.test(message)) {
    hint =
      " — the authenticated member does not have permission to post on that company page. Confirm they hold an ADMINISTRATOR role on it.";
  }

  return new LinkedInApiError(
    `LinkedIn ${status} on ${apiPath}: ${message}${hint}`,
    status,
    raw,
    serviceErrorCode,
  );
}

export async function apiRequest<T>(
  apiPath: string,
  options: RequestOptions = {},
): Promise<{ data: T; headers: Headers }> {
  const token = await requireAccessToken();
  const method = options.method ?? "GET";

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "X-Restli-Protocol-Version": "2.0.0",
  };

  // Only the versioned /rest/ surface accepts (and requires) this header; the
  // legacy /v2/ endpoints reject it.
  if (apiPath.startsWith("/rest/")) {
    headers["LinkedIn-Version"] = config.apiVersion;
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  Object.assign(headers, options.headers ?? {});

  const response = await fetch(buildUrl(apiPath, options.query), {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  if (!response.ok) throw explain(response.status, text, apiPath);

  let data: T;
  if (!text) {
    data = undefined as T;
  } else {
    try {
      data = JSON.parse(text) as T;
    } catch {
      data = text as unknown as T;
    }
  }

  return { data, headers: response.headers };
}

export async function apiGet<T>(
  apiPath: string,
  query?: Record<string, string | number | undefined>,
): Promise<T> {
  const { data } = await apiRequest<T>(apiPath, { method: "GET", query });
  return data;
}

/** URNs must be percent-encoded when they appear in a path segment. */
export function encodeUrn(urn: string): string {
  return encodeURIComponent(urn);
}
