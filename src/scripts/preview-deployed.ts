/**
 * `npm run ui:deployed` — the deployed app, on your own machine.
 *
 * Runs the same server as `npm run ui`, with the front door swapped: no shared
 * token, sign in with LinkedIn instead, every request scoped to the member who
 * signed in. That is the whole difference between the two modes, and it is the
 * part worth testing before a deploy, because it is the part that decides who
 * gets in and whose drafts they see.
 *
 * What this does NOT reproduce, and why it does not matter much:
 *   - Static files come from src/http/ rather than public/. Same bytes; the
 *     build script copies them.
 *   - One long-lived process rather than a function per request. Nothing here
 *     keeps state in memory between requests, so behaviour is the same.
 *   - S3, unless you set STORAGE_BACKEND=s3 — which you can, and should before
 *     the first real deploy.
 *
 * Everything else — the OAuth round trip, the signed cookie, the allow-list
 * check on every request, the per-member workspace — is the same code.
 */

// Set before anything imports config: its .env loader only fills gaps in the
// environment, so whatever is set here wins over .env. That matters most for
// LINKEDIN_REDIRECT_URI, where .env holds the `npm run auth` callback and this
// mode needs the app's own route instead.
process.env.UI_AUTH = "oauth";
process.env.REQUIRE_IDENTITY ??= "true";
// Its own port, not the studio's 5601, so the normal install can keep running
// while you try this one. It also keeps the redirect URL you register stable:
// register 5602 once and it stays right.
process.env.UI_PORT ??= "5602";
process.env.UI_OPEN_BROWSER ??= "true";

const port = process.env.UI_PORT;
const base = `http://localhost:${port}`;
process.env.PUBLIC_URL ??= base;
const callback = `${process.env.PUBLIC_URL}/api/callback`;
process.env.LINKEDIN_REDIRECT_URI = callback;

const { config } = await import("../config.ts");
const { startServer } = await import("../http/server.ts");

console.log("");
console.log("  Deployed mode, running locally");
console.log("  ─────────────────────────────────");
console.log("");
console.log("  Before this can let you in, both of these must be true.");
console.log("");
console.log(`  1. This exact URL is an Authorized redirect URL on the LinkedIn app:`);
console.log(`       ${callback}`);
console.log("     (developers.linkedin.com > your app > Auth > OAuth 2.0 settings >");
console.log("      Authorized redirect URLs > pencil > + Add redirect URL.  Exact match:");
console.log("      no trailing slash. Adding it does not disturb the one already there.)");
console.log("");

const allowed = config.allowedMembers;
if (allowed.length === 0) {
  console.log("  2. LINKEDIN_ALLOWED_MEMBERS is EMPTY, so nobody can sign in.");
  console.log("     An empty list means nobody, never everybody — a forgotten env var");
  console.log("     must not become an open door. Put your member URN in .env:");
  console.log("       LINKEDIN_ALLOWED_MEMBERS=urn:li:person:xxxxxxxx");
  console.log("     `npm run whoami` prints yours.");
} else {
  console.log(`  2. LINKEDIN_ALLOWED_MEMBERS has ${allowed.length} entr${allowed.length === 1 ? "y" : "ies"}: ${allowed.join(", ")}`);
  console.log("     Anyone else who signs in is refused and told why.");
}
console.log("");
// Said plainly because the first reaction to it is "where did my drafts go".
console.log(`  Storage  ${config.storageBackend === "s3" ? "your S3 bucket" : "local files"}, under users/<your-member-id>/`);
console.log("           Your existing drafts live in the unscoped root and will NOT");
console.log("           appear here. Nothing was moved or lost — signing in puts you");
console.log("           in your own tree, which is the point of the scoping.");
console.log("");
console.log("  Sessions signed with .state/session-secret.txt, generated here and");
console.log("  local only. On Vercel, SESSION_SECRET is required and must stay fixed.");
console.log("");

startServer();
