import { spawn } from "node:child_process";
import { authorize } from "./oauth.ts";
import { tokenStatus } from "../state/tokens.ts";

/**
 * Best effort convenience; the URL is always printed too.
 *
 * Deliberately NOT `cmd /c start`: cmd.exe treats `&` as a command separator, so
 * an OAuth URL gets truncated at the first query parameter and LinkedIn replies
 * "You need to pass the client_id parameter". rundll32 execs directly with no
 * shell in the way, so the URL arrives intact.
 */
function browserOpener(url: string): { command: string; args: string[] } {
  switch (process.platform) {
    case "win32":
      return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
    case "darwin":
      return { command: "open", args: [url] };
    default:
      // Linux, BSD, WSL. xdg-open is not guaranteed to exist; the spawn error
      // handler below falls back to the printed URL.
      return { command: "xdg-open", args: [url] };
  }
}

function openInBrowser(url: string): void {
  const { command, args } = browserOpener(url);
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    // No opener on this system — the printed URL is the fallback, so stay quiet.
    child.on("error", () => {});
    child.unref();
  } catch {
    // Never let opening a browser break the auth flow.
  }
}

/**
 * `npm run auth` — run once now, and again whenever the 60-day token lapses.
 * Pass --member-only to request just the personal-profile scopes, which is
 * useful while the Community Management API product is still pending: asking
 * for organization scopes the app has not been granted makes LinkedIn reject
 * the whole consent screen.
 */
async function main(): Promise<void> {
  const memberOnly = process.argv.includes("--member-only");
  const includeOrg = !memberOnly;

  console.log(
    includeOrg
      ? "Requesting member + organization scopes (needs Community Management API approved)."
      : "Requesting member scopes only.",
  );

  const tokens = await authorize(includeOrg, openInBrowser);
  console.log("\n✓ Authorized.");
  console.log(`  Member:  ${tokens.memberName ?? "(name unavailable)"}`);
  console.log(`  URN:     ${tokens.memberUrn ?? "(not cached)"}`);
  console.log(`  Scopes:  ${tokens.scope.join(", ")}`);

  const status = tokenStatus();
  console.log(`  ${status.hint}`);
  if (!status.canPublishAsOrganization) {
    console.log(
      "\nNote: w_organization_social was not granted, so company-page publishing is not available yet.\n" +
        "That scope comes with the Community Management API product.",
    );
  }
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
