import http from "node:http";
import crypto from "node:crypto";
import { config, allScopes } from "../config.ts";
import { saveTokens, type TokenSet } from "../state/tokens.ts";
import { getUserInfo, memberUrn } from "../linkedin/me.ts";

const AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";

export function buildAuthorizeUrl(state: string, includeOrg: boolean): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", allScopes(includeOrg).join(" "));
  return url.toString();
}

export type TokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
};

/**
 * Exported so the deployed sign-in reuses this exact exchange rather than
 * growing a second copy: the redirect-uri mismatch hint below is the one that
 * explains almost every failure here, and it should not exist in two places
 * that can drift.
 */
export async function exchangeCode(code: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Token exchange failed (${response.status}): ${text}\n\nThe usual cause is LINKEDIN_REDIRECT_URI not matching the Authorized redirect URL on the app's Auth tab exactly.`,
    );
  }
  return JSON.parse(text) as TokenResponse;
}

function page(title: string, detail: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:16px system-ui;margin:4rem auto;max-width:34rem;color:#111">
<h1 style="font-size:1.3rem">${title}</h1><p>${detail}</p>
<p style="color:#666">You can close this tab and return to the terminal.</p>`;
}

/**
 * Runs the authorization-code flow against a one-shot local server. Resolves
 * once LinkedIn redirects back with a code and the token has been stored.
 */
export function authorize(
  includeOrg: boolean,
  onAuthorizeUrl?: (url: string) => void,
): Promise<TokenSet> {
  const state = crypto.randomBytes(16).toString("hex");
  const redirect = new URL(config.redirectUri);
  const port = Number(redirect.port || "80");

  return new Promise<TokenSet>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404).end("Not found");
        return;
      }

      const error = url.searchParams.get("error");
      if (error) {
        const description =
          url.searchParams.get("error_description") ?? "no description given";
        res
          .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
          .end(page("Authorization denied", `LinkedIn returned: ${description}`));
        server.close();
        reject(new Error(`LinkedIn returned ${error}: ${description}`));
        return;
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");

      if (returnedState !== state) {
        res
          .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
          .end(page("State mismatch", "The callback did not match this request."));
        server.close();
        reject(new Error("OAuth state mismatch — possible cross-site request. Nothing was stored."));
        return;
      }

      if (!code) {
        res.writeHead(400).end("Missing code");
        return;
      }

      void (async () => {
        try {
          const token = await exchangeCode(code);
          const scope = token.scope
            ? token.scope.split(/[\s,]+/).filter(Boolean)
            : allScopes(includeOrg);

          let tokens: TokenSet = {
            accessToken: token.access_token,
            expiresAt: Date.now() + token.expires_in * 1000,
            refreshToken: token.refresh_token,
            refreshTokenExpiresAt: token.refresh_token_expires_in
              ? Date.now() + token.refresh_token_expires_in * 1000
              : undefined,
            scope,
            obtainedAt: Date.now(),
          };
          await saveTokens(tokens);

          // Cache identity now so later publishes do not need a lookup.
          try {
            const info = await getUserInfo();
            tokens = {
              ...tokens,
              memberUrn: memberUrn(info.sub),
              memberName: info.name,
            };
            await saveTokens(tokens);
          } catch {
            // Identity scope may not have been granted; publishing as the
            // company page still works.
          }

          res
            .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
            .end(
              page(
                "LinkedIn connected",
                `Token stored for ${tokens.memberName ?? "your account"}. Scopes granted: ${scope.join(", ")}`,
              ),
            );
          server.close();
          resolve(tokens);
        } catch (cause) {
          res
            .writeHead(500, { "Content-Type": "text/html; charset=utf-8" })
            .end(page("Token exchange failed", String(cause)));
          server.close();
          reject(cause instanceof Error ? cause : new Error(String(cause)));
        }
      })();
    });

    server.on("error", reject);
    server.listen(port, () => {
      const authorizeUrl = buildAuthorizeUrl(state, includeOrg);
      console.log(`\nListening on ${config.redirectUri}`);
      console.log(
        "\nThis exact value must be registered in the LinkedIn Developer Portal:" +
          `\n  ${config.redirectUri}` +
          "\n  (Your app > Auth tab > OAuth 2.0 settings > Authorized redirect URLs" +
          "\n   for your app > pencil icon > + Add redirect URL)" +
          "\n  Matching is exact — no trailing slash, no wildcards.",
      );
      console.log("\nOpen this URL to authorize:\n");
      console.log(authorizeUrl);
      console.log(
        "\n(A browser should open automatically. If it lands on a LinkedIn error" +
          "\npage, copy the whole URL above by hand — it must include client_id.)\n",
      );
      // Hand the caller the real URL — it carries the state this server will
      // check, so it cannot be rebuilt elsewhere.
      onAuthorizeUrl?.(authorizeUrl);
    });
  });
}
