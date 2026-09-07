import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Copies the browser-facing files into public/ for a Vercel deploy.
 *
 * Locally the page is read from src/http/ui.html on every request, which is why
 * editing it needs no restart. On Vercel a request that reads a file is a
 * function invocation, and the page changes only when it is deployed — so the
 * same file is copied to public/index.html and served from the CDN instead.
 * public/ is generated and gitignored; src/http/ stays the only copy anyone
 * edits.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FROM = path.join(ROOT, "src", "http");
const TO = path.join(ROOT, "public");

const FILES = [
  ["ui.html", "index.html"],
  ["manifest.json", "manifest.json"],
  ["sw.js", "sw.js"],
  ["icons/icon-192.png", "icons/icon-192.png"],
  ["icons/icon-512.png", "icons/icon-512.png"],
  ["icons/icon-192.png", "favicon.ico"],
];

// Rebuilt from scratch, so a file removed from the list above does not linger
// in a previous build's output.
fs.rmSync(TO, { recursive: true, force: true });

for (const [source, target] of FILES) {
  const from = path.join(FROM, ...source.split("/"));
  if (!fs.existsSync(from)) {
    throw new Error(`build-public: ${path.relative(ROOT, from)} is missing.`);
  }
  const to = path.join(TO, ...target.split("/"));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

console.log(`build-public: wrote ${FILES.length} file(s) to public/`);
