import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Pushes this project's environment into a linked Vercel project.
 *
 *   node scripts/vercel-env.mjs --url https://your-app.vercel.app
 *   node scripts/vercel-env.mjs --url https://your-app.vercel.app --apply
 *
 * Without --apply it prints the plan and changes nothing.
 *
 * Values are read from .env on this machine and handed to `vercel env add` on
 * its stdin. They are never printed, never passed as command-line arguments
 * (which would put them in the process list and the shell history), and never
 * written anywhere else. The plan shows key names and whether each has a value.
 *
 * Three groups, because "copy .env to production" would be wrong in all three
 * ways at once:
 *
 *   LOCAL_ONLY   — meaningless or harmful on a deployment. Ollama and Claude
 *                  Code both run on your machine; a function has neither.
 *   OVERRIDES    — must differ there. The filesystem is read-only, so storage
 *                  is S3; the callback is the deployment's own URL; identity is
 *                  required, because without it two people share one tree.
 *   PASS_THROUGH — the same in both places.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const urlIndex = args.indexOf("--url");
const rawUrl = urlIndex === -1 ? "" : (args[urlIndex + 1] ?? "");
const target = args.includes("--preview") ? "preview" : "production";

if (!rawUrl) {
  console.error("Usage: node scripts/vercel-env.mjs --url https://your-app.vercel.app [--apply]");
  console.error("");
  console.error("The URL is the deployment's own address. It becomes PUBLIC_URL and");
  console.error("the OAuth callback, so it has to be the real one, not a guess.");
  process.exit(1);
}

const url = rawUrl.replace(/\/+$/, "");
if (!url.startsWith("https://")) {
  console.error(`Refusing to use ${url}: the deployment URL must be https.`);
  console.error("Cookies are set Secure there, so a http:// origin could never sign in.");
  process.exit(1);
}

function readDotEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) {
    console.error("No .env in this directory. Nothing to read values from.");
    process.exit(1);
  }
  const map = new Map();
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    map.set(line.slice(0, eq).trim(), value);
  }
  return map;
}

/**
 * The session key, generated once and kept.
 *
 * Kept in .state/ rather than regenerated per run because changing it signs
 * everyone out — so re-running this script to fix one other variable must not
 * be the thing that does that.
 */
function sessionSecret() {
  const file = path.join(ROOT, ".state", "vercel-session-secret.txt");
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  }
  const generated = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${generated}\n`, "utf8");
  return generated;
}

const env = readDotEnv();

const LOCAL_ONLY = [
  ["UI_PORT", "the local server's port; a function has none"],
  ["UI_OPEN_BROWSER", "there is no browser to open on a server"],
  ["OLLAMA_BASE_URL", "Ollama runs on your machine, not in a function"],
  ["OLLAMA_MODEL", "same"],
  ["CLAUDE_CODE_MODEL", "Claude Code is a CLI on your machine"],
  ["CLAUDE_CODE_BIN", "same"],
];

const OVERRIDES = new Map([
  // APP_URL, not PUBLIC_URL: Vercel refuses to store any name starting with
  // PUBLIC_, because some frameworks expose those to the browser.
  ["APP_URL", [url, "the deployment's own address"]],
  ["LINKEDIN_REDIRECT_URI", [`${url}/api/callback`, "must also be registered on the LinkedIn app's Auth tab"]],
  ["SESSION_SECRET", [sessionSecret(), "signs the session cookie; changing it signs everyone out"]],
  ["STORAGE_BACKEND", ["s3", "a Vercel filesystem is read-only and per-instance"]],
  ["REQUIRE_IDENTITY", ["true", "without it, everyone who signs in shares one storage tree"]],
  ["DRAFT_PROVIDER", ["openai", "the only provider that exists inside a function"]],
  ["LINKEDIN_FORCE_DRY_RUN", ["true", "starts safe; turn it off once a preview has gone through"]],
]);

const PASS_THROUGH = [
  "LINKEDIN_CLIENT_ID",
  "LINKEDIN_CLIENT_SECRET",
  "LINKEDIN_ORGANIZATION_URN",
  "LINKEDIN_ORGANIZATION_NAME",
  "LINKEDIN_API_VERSION",
  "LINKEDIN_DAILY_POST_LIMIT",
  "LINKEDIN_ALLOWED_MEMBERS",
  "LINKEDIN_KEEP_PUBLISHED",
  "LINKEDIN_AUDIT_DRY_RUNS",
  "LINKEDIN_DECK_THEME",
  "LINKEDIN_PROFILE_LINK",
  "LINKEDIN_PROFILE_LINK_LABEL",
  "S3_BUCKET",
  "S3_PREFIX",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "BRAVE_API_KEY",
];

/** Never the value — only whether there is one, and roughly how long. */
const shape = (value) => (value ? `set (${value.length} chars)` : "EMPTY");

const plan = [];
for (const [key, [value, why]] of OVERRIDES) plan.push({ key, value, note: why, kind: "override" });
for (const key of PASS_THROUGH) {
  const value = env.get(key) ?? "";
  if (!value) continue;
  plan.push({ key, value, note: "from .env", kind: "pass" });
}

console.log("");
console.log(`  Vercel environment — ${target}`);
console.log("  ─────────────────────────────────");
console.log("");
console.log("  Set on the deployment, and why they differ from .env:");
for (const item of plan.filter((p) => p.kind === "override")) {
  console.log(`    ${item.key.padEnd(27)} ${item.key === "SESSION_SECRET" ? "generated, kept in .state/" : item.value}`);
  console.log(`    ${" ".repeat(27)} ${item.note}`);
}
console.log("");
console.log("  Copied from .env:");
for (const item of plan.filter((p) => p.kind === "pass")) {
  console.log(`    ${item.key.padEnd(27)} ${shape(item.value)}`);
}

const missing = PASS_THROUGH.filter((key) => !env.get(key));
if (missing.length) {
  console.log("");
  console.log("  Empty in .env, so not sent:");
  for (const key of missing) console.log(`    ${key}`);
}

console.log("");
console.log("  Deliberately NOT sent:");
for (const [key, why] of LOCAL_ONLY) console.log(`    ${key.padEnd(27)} ${why}`);

// The two that will break the deployment if they are wrong, checked here rather
// than discovered as a 500 after the first sign-in.
const problems = [];
if (!env.get("S3_BUCKET")) {
  problems.push("S3_BUCKET is empty. STORAGE_BACKEND=s3 on the deployment, so without a bucket every request fails at startup.");
}
if (!env.get("OPENAI_API_KEY")) {
  problems.push("OPENAI_API_KEY is empty. Drafting is OpenAI-only on the deployment; everything else works, but Generate will not.");
}
if (!env.get("LINKEDIN_ALLOWED_MEMBERS")) {
  problems.push("LINKEDIN_ALLOWED_MEMBERS is empty, which means NOBODY can sign in. That is the safe default, not a bug — but it is not what you want here.");
}
if (problems.length) {
  console.log("");
  console.log("  Worth fixing first:");
  for (const problem of problems) console.log(`    ! ${problem}`);
}

if (!apply) {
  console.log("");
  console.log("  Nothing was changed. Re-run with --apply to write these to Vercel.");
  console.log("  Requires a linked project: `npx vercel link` first.");
  console.log("");
  process.exit(0);
}

console.log("");
console.log(`  Writing ${plan.length} variables to Vercel (${target})...`);
console.log("");

let written = 0;
for (const item of plan) {
  try {
    // The value goes in on stdin, never as an argument: arguments are visible
    // in the process list and land in shell history.
    execFileSync("npx", ["--yes", "vercel", "env", "add", item.key, target, "--force"], {
      input: `${item.value}\n`,
      stdio: ["pipe", "ignore", "pipe"],
      cwd: ROOT,
      shell: process.platform === "win32",
    });
    console.log(`    ok    ${item.key}`);
    written += 1;
  } catch (error) {
    const detail = (error.stderr?.toString() ?? error.message ?? "").trim().split("\n").slice(-3).join(" ");
    console.log(`    FAIL  ${item.key} — ${detail}`);
  }
}

console.log("");
console.log(`  ${written}/${plan.length} written.`);
console.log("");
console.log("  Next:");
console.log("    1. Register this redirect URL on the LinkedIn app's Auth tab:");
console.log(`         ${url}/api/callback`);
console.log("    2. npx vercel --prod");
console.log("    3. Open the URL, sign in, check it works.");
console.log("    4. Set LINKEDIN_FORCE_DRY_RUN=false and redeploy, once a preview has gone through.");
console.log("");
