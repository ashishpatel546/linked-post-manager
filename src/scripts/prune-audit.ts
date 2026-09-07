import { getJson, keys, storage } from "../storage/index.ts";
import type { AuditEntry } from "../state/audit.ts";

/**
 * Removes audit entries that record a dry run — a preview or a render, where
 * nothing was sent to LinkedIn.
 *
 * They are no longer written (see config.auditDryRuns), but a store that has
 * been used for a while is full of them, and each one is an object that gets
 * listed and sometimes read. Real publishes and deletes are never touched:
 * those are the record of what actually happened under your name, and the
 * daily cap is counted from them.
 *
 * Prints the plan and stops unless --yes. It deletes, so it asks.
 *
 *   npm run audit:prune           # what it would remove
 *   npm run audit:prune -- --yes  # remove it
 */

async function main(): Promise<void> {
  const write = process.argv.includes("--yes");
  const objectKeys = await storage.list(keys.auditPrefix);

  console.log(`\n  store  ${storage.describe}`);
  console.log(`  found  ${objectKeys.length} audit object(s)\n`);

  const doomed: string[] = [];
  let kept = 0;
  let unreadable = 0;

  for (const key of objectKeys) {
    const name = key.slice(keys.auditPrefix.length);

    // Recent entries say what they are in the key, so neither branch here
    // needs to open the object.
    if (name.includes("-dryrun-")) {
      doomed.push(key);
      continue;
    }
    if (/-(publish|delete|comment)-/.test(name)) {
      kept += 1;
      continue;
    }

    const entry = await getJson<AuditEntry>(storage, key);
    if (entry === null) {
      unreadable += 1;
      continue;
    }
    if (entry.dryRun) doomed.push(key);
    else kept += 1;
  }

  console.log(`  dry runs   ${doomed.length}`);
  console.log(`  real writes ${kept}  (never touched)`);
  if (unreadable > 0) console.log(`  unreadable  ${unreadable}  (left alone)`);

  if (doomed.length === 0) {
    console.log("\n  Nothing to prune.\n");
    return;
  }

  if (!write) {
    console.log(`\n  Re-run with --yes to delete those ${doomed.length} object(s).`);
    console.log("  Real publishes and deletes stay, whatever happens.\n");
    return;
  }

  for (const key of doomed) await storage.remove(key);
  console.log(`\n  Deleted ${doomed.length} dry-run entr${doomed.length === 1 ? "y" : "ies"}.\n`);
}

await main();
