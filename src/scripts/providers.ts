import { config } from "../config.ts";
import { listProviderStatuses } from "../providers/index.ts";
import { composeDraft } from "../core/compose.ts";

/**
 * `npm run providers` — show which draft backends are usable.
 * `npm run providers -- --test "<topic>"` — actually generate a draft with the
 * selected provider, without touching LinkedIn.
 */
async function main(): Promise<void> {
  console.log(`Selected provider: ${config.draftProvider}  (DRAFT_PROVIDER in .env)\n`);

  for (const status of await listProviderStatuses()) {
    const mark = status.configured && status.reachable !== false ? "✓" : "✗";
    const cost = status.metered ? "metered" : "free";
    console.log(`${mark} ${status.label}  [${cost}]`);
    console.log(`    model:    ${status.model}`);
    console.log(`    endpoint: ${status.endpoint}`);
    if (status.reason) console.log(`    note:     ${status.reason}`);
    console.log("");
  }

  const testIndex = process.argv.indexOf("--test");
  if (testIndex === -1) return;

  const topic = process.argv[testIndex + 1];
  if (!topic) {
    console.log('Pass a topic: npm run providers -- --test "your topic"');
    return;
  }

  console.log(`Generating a draft about "${topic}"...\n`);
  const result = await composeDraft({ topic, target: "me" });
  console.log("-".repeat(60));
  console.log(result.text);
  console.log("-".repeat(60));
  console.log(`${result.characterCount} characters via ${result.provider}`);
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
