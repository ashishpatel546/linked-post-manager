import { authorize } from "./oauth.ts";
import { openInBrowser } from "../open.ts";
import { tokenStatus } from "../state/tokens.ts";

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

  const status = await tokenStatus();
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
