import { config } from "../config.ts";
import { tokenStatus } from "../state/tokens.ts";
import { getAdministeredOrganizations, getUserInfo } from "../linkedin/me.ts";

/** `npm run whoami` — the fastest check that Phase 0 and Phase 1 are done. */
async function main(): Promise<void> {
  const status = await tokenStatus();
  console.log("Token");
  console.log(`  authorized: ${status.authorized}`);
  console.log(`  expires:    ${status.expiresAt ?? "—"} (${status.hint})`);
  console.log(`  scopes:     ${status.scope.join(", ") || "—"}`);
  console.log(`  publish as: me=${status.canPublishAsMember} company=${status.canPublishAsOrganization}`);
  console.log(`  dry run:    ${config.forceDryRun ? "ON (nothing will be posted)" : "off"}`);

  if (!status.authorized) {
    console.log("\nRun `npm run auth` first.");
    return;
  }

  console.log("\nMember");
  const info = await getUserInfo();
  console.log(`  ${info.name ?? "(no name)"} — urn:li:person:${info.sub}`);

  console.log("\nAdministered pages");
  try {
    const orgs = await getAdministeredOrganizations();
    if (orgs.length === 0) {
      console.log("  (none returned)");
    }
    for (const org of orgs) {
      const configured = org.urn === config.organizationUrn ? "  <- configured" : "";
      console.log(`  ${org.name ?? "(unnamed)"} — ${org.urn}${configured}`);
    }
  } catch (error) {
    console.log(`  unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
