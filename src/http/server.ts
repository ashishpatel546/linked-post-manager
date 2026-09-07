import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { config } from "../config.ts";
import { openInBrowser } from "../open.ts";
import { keys, storage } from "../storage/index.ts";
import { tokenStatus } from "../state/tokens.ts";
import { countPublishedToday, readAudit } from "../state/audit.ts";
import { listProviderStatuses } from "../providers/index.ts";
import {
  asDepth,
  composeArticle,
  composeCardText,
  composeDraft,
  composeShorten,
} from "../core/compose.ts";
import { MAX_COMMENTARY_LENGTH } from "../linkedin/text.ts";
import {
  fetchImageForImport,
  researchStatus,
  searchImages,
  searchWeb,
  suggestTopics,
} from "../core/research.ts";
import { publishPost } from "../core/publish.ts";
import { renderArticlePdf } from "../render/article.ts";
import { assertPageCount } from "../linkedin/documents.ts";
import {
  approveDraft,
  archivePublishedDrafts,
  articleAsPostText,
  deleteDraft,
  deletePublished,
  publishedFiles,
  readPublished,
  ingestImageBytes,
  listDrafts,
  listPublished,
  publishDraft,
  readArticleBody,
  readDraft,
  saveDraft,
} from "../core/drafts.ts";
import type { Target } from "../core/targets.ts";
import { checkRequest, loadOrCreateToken, originAllowed, TOKEN_HEADER } from "./auth.ts";
import {
  accessStillGranted,
  handleCallback,
  handleLogin,
  handleLogout,
  originIsSelf,
  revokeSession,
  sessionFor,
} from "./session.ts";
import { runAs, workspaceFor } from "../storage/index.ts";

/**
 * A local HTTP adapter over `core/`, sitting beside the MCP server rather than
 * above it. Both front ends reach LinkedIn only through `publishPost()`, so the
 * dry-run switch, the daily cap, the approval state and the audit log apply
 * here exactly as they do in Claude Code — adding this UI cannot widen what the
 * agent is allowed to do.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_FILE = path.join(HERE, "ui.html");

const MAX_BODY_BYTES = 16 * 1024 * 1024; // generous, so image uploads fit
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif"]);

type Json = Record<string, unknown>;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body ?? null, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

async function readJsonBody(req: http.IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes.`);
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("body must be a JSON object");
    }
    return parsed as Json;
  } catch (error) {
    throw new HttpError(400, `Could not parse request body as JSON: ${String(error)}`);
  }
}

// -- narrow readers, so a malformed request fails here rather than deeper in ---

function str(body: Json, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function requiredStr(body: Json, key: string): string {
  const value = str(body, key);
  if (value === undefined) throw new HttpError(400, `Missing required field "${key}".`);
  return value;
}

/**
 * Never defaulted, on any path. The two targets are different public
 * audiences, and a request that forgot to say which one it meant is a bug, not
 * an invitation to guess.
 */
function target(body: Json): Target {
  const value = body.target;
  if (value === "me" || value === "company") return value;
  throw new HttpError(400, 'Field "target" must be exactly "me" or "company".');
}

function visibility(body: Json): "PUBLIC" | "CONNECTIONS" | "LOGGED_IN" | undefined {
  const value = body.visibility;
  if (value === "PUBLIC" || value === "CONNECTIONS" || value === "LOGGED_IN") return value;
  return undefined;
}

/** Research picked in the UI; only the three fields the prompt uses survive. */
function sourceList(body: Json): Array<{ title: string; url: string; description: string }> | undefined {
  const value = body.sources;
  if (!Array.isArray(value)) return undefined;
  const cleaned = value
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => ({
      title: typeof s.title === "string" ? s.title : "",
      url: typeof s.url === "string" ? s.url : "",
      description: typeof s.description === "string" ? s.description : "",
    }))
    .filter((s) => s.url.startsWith("http"))
    .slice(0, 12);
  return cleaned.length > 0 ? cleaned : undefined;
}

function stringArray(body: Json, key: string): string[] | undefined {
  const value = body[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * Writes an uploaded image into `assets/`. The name is rebuilt from scratch
 * rather than sanitised in place: anything the browser sent is treated as a
 * suggestion, and only the extension is carried across.
 */
async function saveUpload(name: string, base64: string): Promise<string> {
  const extension = path.extname(name).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) {
    throw new HttpError(
      400,
      `Unsupported image type "${extension}". LinkedIn accepts PNG, JPG, and GIF.`,
    );
  }

  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) throw new HttpError(400, "Uploaded file was empty.");
  if (bytes.length > 10 * 1024 * 1024) {
    throw new HttpError(400, "Image is larger than LinkedIn's 10 MB limit.");
  }

  const stem =
    path
      .basename(name, extension)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "image";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const key = keys.asset(`${stamp}-${stem}${extension}`);

  // Through storage, not the filesystem: on a deployment there is nowhere to
  // write, and this key is what the draft records either way.
  await storage.putBytes(key, new Uint8Array(bytes), MIME[extension]);
  return key;
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
};

// ------------------------------------------------------------------ routing --

async function handleApi(
  req: http.IncomingMessage,
  url: URL,
): Promise<unknown> {
  const method = req.method ?? "GET";
  const route = url.pathname;

  if (method === "GET" && route === "/api/status") {
    return {
      ...(await tokenStatus()),
      publishedToday: await countPublishedToday(),
      dailyLimit: config.dailyPostLimit,
      forceDryRun: config.forceDryRun,
      apiVersion: config.apiVersion,
      organizationUrn: config.organizationUrn || null,
      organizationName: config.organizationName || null,
      deckTheme: config.deckTheme,
      storageBackend: config.storageBackend,
      defaultProvider: config.draftProvider,
      // Which front door this instance uses, so the page can offer Sign out on
      // a deployment and say nothing about it on a laptop.
      authMode: config.authMode,
      // Guarded, not just optional-chained: sessionFor throws when no
      // SESSION_SECRET is set, which is the normal state on a laptop.
      signedInAs: config.authMode === "oauth" ? (sessionFor(req)?.name ?? null) : null,
    };
  }

  // Separate from /api/status because probing Ollama and Claude Code costs a
  // round trip each; the page should paint before that finishes.
  if (method === "GET" && route === "/api/providers") {
    return { providers: await listProviderStatuses(), current: config.draftProvider };
  }

  if (method === "GET" && route === "/api/drafts") {
    return { drafts: await listDrafts() };
  }

  // Posts that actually went out. Separate from /api/drafts because a
  // published post is no longer work in progress and should not clutter the
  // list of things still waiting on you.
  if (method === "GET" && route === "/api/published") {
    // Capped and paged: the list is a way back to your posts, not an archive
    // to load in full on every page open.
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
    const before = url.searchParams.get("before") ?? undefined;
    return listPublished({
      limit: Number.isFinite(limit) ? limit : 50,
      ...(before ? { before } : {}),
    });
  }

  // Sweeps drafts that went out before publishing archived them itself. Safe to
  // run repeatedly; it only touches records already marked published.
  if (method === "POST" && route === "/api/archive") {
    return archivePublishedDrafts();
  }

  const publishedMatch = /^\/api\/published\/([^/]+)$/.exec(route);
  if (publishedMatch) {
    const id = decodeURIComponent(publishedMatch[1] as string);

    // What actually went out, in full — the record plus its prose and the
    // files it is made of, so a post can be re-read months later without
    // hunting for it in the feed.
    if (method === "GET") {
      const [record, files] = await Promise.all([readPublished(id), publishedFiles(id)]);
      return { ...record, files };
    }

    // Forgets it locally; the post on LinkedIn is untouched. See the note on
    // deletePublished: this is the only full copy of the text.
    if (method === "DELETE") {
      return deletePublished(id, { includeImages: url.searchParams.get("images") === "true" });
    }
  }

  if (method === "GET" && route === "/api/audit") {
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "25", 10);
    return {
      publishedToday: await countPublishedToday(),
      dailyLimit: config.dailyPostLimit,
      entries: await readAudit(Number.isFinite(limit) ? limit : 25),
    };
  }

  const draftMatch = /^\/api\/drafts\/([^/]+)(\/approve|\/publish|\/article)?$/.exec(route);
  if (draftMatch) {
    const id = decodeURIComponent(draftMatch[1] as string);
    const action = draftMatch[2];

    if (method === "GET" && !action) return readDraft(id);

    if (method === "DELETE" && !action) return deleteDraft(id);

    // The long-form prose is a companion object, not part of the draft record,
    // so it is fetched on demand rather than inflating every draft listing.
    if (method === "GET" && action === "/article") {
      return { article: await readArticleBody(id) };
    }

    if (method === "POST" && action === "/approve") {
      return {
        draft: await approveDraft(id),
        next: "Publish it when you are ready — that step still needs an explicit confirm.",
      };
    }

    if (method === "POST" && action === "/publish") {
      const body = await readJsonBody(req);
      return publishDraft(id, body.confirm === true);
    }
  }

  if (method === "POST" && route === "/api/compose") {
    const body = await readJsonBody(req);

    const sources = sourceList(body);
    const depth = asDepth(body.depth);

    if (body.format === "article") {
      return composeArticle({
        topic: requiredStr(body, "topic"),
        target: target(body),
        provider: str(body, "provider"),
        model: str(body, "model"),
        instructions: str(body, "instructions"),
        depth,
        mode:
          body.articleMode === "text"
            ? "text"
            : body.articleMode === "manual"
              ? "manual"
              : "carousel",
        sources,
      });
    }

    return composeDraft({
      topic: requiredStr(body, "topic"),
      target: target(body),
      provider: str(body, "provider"),
      model: str(body, "model"),
      instructions: str(body, "instructions"),
      depth,
      sources,
      targetLength:
        typeof body.targetLength === "number" ? body.targetLength : undefined,
    });
  }

  if (method === "POST" && route === "/api/drafts") {
    const body = await readJsonBody(req);
    // A manual article has no post to write text for — the prose is the whole
    // artefact — so an empty body is valid there and required everywhere else.
    const isManual = body.format === "article" && body.articleMode === "manual";
    return saveDraft({
      id: str(body, "id"),
      topic: requiredStr(body, "topic"),
      body: isManual ? (str(body, "body") ?? "") : requiredStr(body, "body"),
      target: target(body),
      // "post" is the safe default here, unlike target: choosing wrong only
      // changes the attachment, and an article draft says so explicitly.
      format: body.format === "article" ? "article" : "post",
      articleTitle: str(body, "articleTitle"),
      article: str(body, "article"),
      articleMode:
        body.articleMode === "text" || body.articleMode === "manual" || body.articleMode === "carousel"
          ? body.articleMode
          : undefined,
      theme: body.theme === "light" ? "light" : body.theme === "dark" ? "dark" : undefined,
      visibility: visibility(body),
      link: str(body, "link"),
      images: stringArray(body, "images"),
    });
  }

  // Renders the exact payload without sending it. Deliberately has no way to
  // publish: the only publishing route is a draft that was approved first.
  //
  // It also answers the question the payload alone does not: what will this
  // look like in the feed. That means resolving the two things the client
  // cannot resolve for itself — the profile link the server appends at publish
  // time, and which of body/prose is actually the post text — and naming the
  // attachment, since an image or a deck is never in the payload until the
  // moment of a real publish.
  if (method === "POST" && route === "/api/preview") {
    const body = await readJsonBody(req);
    const where = target(body);
    const format = body.format === "article" ? "article" : "post";
    const mode = body.articleMode === "text" ? "text" : "carousel";
    const article = str(body, "article");
    const images = stringArray(body, "images") ?? [];
    const link = str(body, "link");

    // A text-mode article is the prose itself, headings flattened — the same
    // transform publishing applies, so the preview is not a different post.
    const text =
      format === "article" && mode === "text" && article
        ? articleAsPostText(article)
        : str(body, "text");
    if (!text) {
      throw new HttpError(
        400,
        format === "article" && mode === "text"
          ? "Nothing to preview: this format posts the prose itself, and the prose is empty."
          : "Nothing to preview: write the post text first.",
      );
    }

    const result = await publishPost({
      target: where,
      text,
      visibility: visibility(body),
      // Images and decks are uploaded only on a real publish, so the payload
      // here can carry a link and nothing else. `attachment` below says what
      // would actually be attached.
      content: link && images.length === 0 && !(format === "article" && mode === "carousel")
        ? { kind: "article", url: link }
        : undefined,
      confirm: false,
    });

    const attachment =
      format === "article" && mode === "carousel"
        ? { kind: "document" as const, title: str(body, "articleTitle") ?? str(body, "topic") ?? "Untitled deck" }
        : images.length > 0
          ? { kind: "images" as const, images }
          : link
            ? { kind: "link" as const, url: link }
            : { kind: "none" as const };

    const status = await tokenStatus();

    return {
      ...result,
      attachment,
      author: {
        name:
          where === "company"
            ? config.organizationName || "Company page"
            : status.memberName ?? "You",
        kind: where,
      },
    };
  }


  // ---- research ------------------------------------------------------------

  if (method === "GET" && route === "/api/research/status") {
    return researchStatus();
  }

  if (method === "POST" && route === "/api/research/web") {
    const body = await readJsonBody(req);
    return { results: await searchWeb(requiredStr(body, "query"), typeof body.count === "number" ? body.count : 8) };
  }

  if (method === "POST" && route === "/api/research/topics") {
    const body = await readJsonBody(req);
    // What you have already written is part of "what exists" too — a suggestion
    // that repeats one of your own posts is as useless as one that repeats a
    // search result.
    const [drafts, { published }] = await Promise.all([listDrafts(), listPublished({ limit: 50 })]);
    return suggestTopics({
      seed: requiredStr(body, "seed"),
      target: target(body),
      provider: str(body, "provider"),
      model: str(body, "model"),
      count: typeof body.count === "number" ? body.count : undefined,
      avoid: [...published, ...drafts].map((d) => d.topic).filter(Boolean),
    });
  }

  if (method === "POST" && route === "/api/research/images") {
    const body = await readJsonBody(req);
    return {
      results: await searchImages(requiredStr(body, "query"), typeof body.count === "number" ? body.count : 12),
      // Said here, in the payload, so a client cannot render results without
      // having been told: Brave returns no licence information at all.
      notice:
        "These are web images. Brave provides no licence data; importing one makes you responsible for having the rights to publish it. The source page is recorded with the import.",
    };
  }

  // Explicit import of one result. Never automatic — see research.ts.
  if (method === "POST" && route === "/api/research/import-image") {
    const body = await readJsonBody(req);
    const sourceUrl = requiredStr(body, "url");
    const fetched = await fetchImageForImport(sourceUrl);
    const stem = (str(body, "title") ?? "web-image").slice(0, 40);
    const key = await ingestImageBytes(`${stem}${fetched.extension}`, fetched.bytes, {
      sourceUrl: fetched.finalUrl,
      pageUrl: str(body, "page"),
      title: str(body, "title"),
    });
    return { path: key, bytes: fetched.bytes.byteLength, sourceUrl: fetched.finalUrl };
  }

  // Cuts prose to fit the post cap. Separate from /api/compose because the
  // input is text the author has already read, not a topic.
  if (method === "POST" && route === "/api/shorten") {
    const body = await readJsonBody(req);
    const limit = typeof body.limit === "number" ? body.limit : MAX_COMMENTARY_LENGTH;
    return composeShorten({
      text: requiredStr(body, "text"),
      limit: Math.min(Math.max(limit, 300), MAX_COMMENTARY_LENGTH),
      provider: str(body, "provider"),
      model: str(body, "model"),
    });
  }

  // The line for a generated image card. The card itself is drawn in the
  // browser — this is only the words on it.
  if (method === "POST" && route === "/api/card-text") {
    const body = await readJsonBody(req);
    return composeCardText({
      text: requiredStr(body, "text"),
      topic: str(body, "topic"),
      target: target(body),
      provider: str(body, "provider"),
      model: str(body, "model"),
    });
  }

  if (method === "POST" && route === "/api/upload") {
    const body = await readJsonBody(req);
    return { path: await saveUpload(requiredStr(body, "name"), requiredStr(body, "data")) };
  }

  throw new HttpError(404, `No route for ${method} ${route}.`);
}

/**
 * Renders a deck from prose held in the browser and streams the bytes back,
 * writing nothing anywhere.
 *
 * Previewing the PDF used to go through a dry-run publish, which needed a
 * draft id, which meant clicking "Render" silently created a draft. Looking at
 * something is not deciding to keep it: nothing reaches storage until Save.
 */
async function renderDeckPreview(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const article = requiredStr(body, "article");
  const title = str(body, "articleTitle") ?? str(body, "topic") ?? "Untitled";

  const rendered = renderArticlePdf({
    id: "preview",
    title,
    body: article,
    theme: str(body, "theme"),
  });
  assertPageCount(rendered.pages);

  res.writeHead(200, {
    "content-type": "application/pdf",
    "content-length": rendered.bytes.byteLength,
    "content-disposition": 'inline; filename="preview.pdf"',
    "x-deck-pages": String(rendered.pages),
    "cache-control": "no-store",
  });
  res.end(rendered.bytes);
}

/**
 * Streams a rendered deck. Looked up in `drafts/` first and then `published/`,
 * so a deck stays viewable after its draft has been archived.
 */
async function serveDraftPdf(id: string, res: http.ServerResponse): Promise<void> {
  const bytes =
    (await storage.getBytes(keys.draftPdf(id))) ??
    (await storage.getBytes(keys.publishedPdf(id)));

  if (!bytes) {
    throw new HttpError(
      404,
      `No rendered deck for "${id}". Render it first — a dry-run publish of an article draft writes drafts/${id}.pdf.`,
    );
  }

  res.writeHead(200, {
    "content-type": "application/pdf",
    "content-length": bytes.byteLength,
    // Inline, not attachment: the point is to look at it in the browser.
    "content-disposition": `inline; filename="${id}.pdf"`,
    "cache-control": "no-store",
  });
  res.end(bytes);
}

/**
 * Streams an ingested image, so the UI can show what is attached rather than a
 * filename. Confined to the assets prefix: the key comes from the caller, and
 * drafts, the audit trail, and the LinkedIn token live in the same store.
 */
async function serveAsset(key: string, res: http.ServerResponse): Promise<void> {
  const prefix = keys.asset("");
  if (!key.startsWith(prefix) || key.includes("..")) {
    throw new HttpError(400, `Only keys under ${prefix} can be read here.`);
  }
  // The provenance sidecar is JSON about an image, not an image.
  if (key.endsWith(".source.json")) throw new HttpError(400, "Not an image.");

  const bytes = await storage.getBytes(key);
  if (!bytes) throw new HttpError(404, `No asset at ${key}.`);

  res.writeHead(200, {
    "content-type": MIME[path.extname(key).toLowerCase()] ?? "application/octet-stream",
    "content-length": bytes.byteLength,
    "cache-control": "no-store",
  });
  res.end(bytes);
}

function serveUi(res: http.ServerResponse): void {
  // Read per request so editing the page does not need a restart.
  const html = fs.readFileSync(UI_FILE, "utf8");
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

/**
 * The PWA shell: manifest, icons, service worker. Served unauthenticated
 * alongside the page, because none of it carries data — and a service worker
 * that needed a token could not be registered at all.
 *
 * The allowlist is explicit rather than a directory walk, so adding a file to
 * `src/http/` cannot accidentally publish it.
 */
const STATIC: Record<string, { file: string; type: string }> = {
  "/manifest.json": { file: "manifest.json", type: "application/manifest+json" },
  "/sw.js": { file: "sw.js", type: "text/javascript; charset=utf-8" },
  "/icons/icon-192.png": { file: "icons/icon-192.png", type: "image/png" },
  "/icons/icon-512.png": { file: "icons/icon-512.png", type: "image/png" },
  "/favicon.ico": { file: "icons/icon-192.png", type: "image/png" },
};

function serveStatic(pathname: string, res: http.ServerResponse): boolean {
  const entry = STATIC[pathname];
  if (!entry) return false;

  const file = path.join(HERE, ...entry.file.split("/"));
  if (!fs.existsSync(file)) return false;

  res.writeHead(200, {
    "content-type": entry.type,
    // The worker must never be served from cache, or a fix to it can never
    // reach a browser that already has the broken one.
    "cache-control": pathname === "/sw.js" ? "no-store" : "public, max-age=3600",
  });
  res.end(fs.readFileSync(file));
  return true;
}

/**
 * The routes behind the front door. Reached only once the caller has been
 * identified — by the shared token locally, by the session cookie on a
 * deployment — and, in the second case, already inside that member's workspace.
 */
async function dispatch(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  try {
    // The one non-JSON endpoint. Bytes, so the deck can be opened in the
    // browser's own viewer exactly as LinkedIn will receive it.
    const pdfMatch = /^\/api\/drafts\/([^/]+)\/pdf$/.exec(url.pathname);
    if (pdfMatch && req.method === "GET") {
      await serveDraftPdf(decodeURIComponent(pdfMatch[1] as string), res);
      return;
    }

    if (url.pathname === "/api/render-deck" && req.method === "POST") {
      await renderDeckPreview(req, res);
      return;
    }

    if (url.pathname === "/api/asset" && req.method === "GET") {
      const key = url.searchParams.get("key");
      if (!key) throw new HttpError(400, "Missing ?key=");
      await serveAsset(key, res);
      return;
    }

    send(res, 200, await handleApi(req, url));
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 400;
    const message = error instanceof Error ? error.message : String(error);
    // Surfaced as text rather than swallowed: every error here is
    // something the operator has to act on.
    send(res, status, { error: message });
  }
}

/**
 * One request, whichever front end delivered it: the local `node:http` server
 * below, or the Vercel function in `api/`. Both hand over an IncomingMessage
 * and a ServerResponse, so there is one routing table rather than two that can
 * drift — and a route added here is reachable in both places by construction.
 */
export async function handleHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `127.0.0.1:${config.uiPort}`}`);
  const oauth = config.authMode === "oauth";

  if (req.method === "OPTIONS") {
    // A preflight cannot carry the token — the browser sends it before the
    // real request, listing only the header names it intends to use. So
    // the origin is the whole check here, and the token is enforced on the
    // request that follows.
    const origin = req.headers.origin;
    if (oauth) {
      // Nothing off-origin may call a cookie-authenticated API, so there is no
      // preflight to approve: the browser is told nothing is allowed.
      res.writeHead(originIsSelf(req) ? 204 : 403).end();
      return;
    }
    if (!originAllowed(typeof origin === "string" ? origin : undefined, config.uiPort)) {
      res.writeHead(403).end();
      return;
    }
    res.writeHead(204, {
      "access-control-allow-origin": typeof origin === "string" ? origin : "*",
      "access-control-allow-headers": `content-type, ${TOKEN_HEADER}`,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-max-age": "600",
    });
    res.end();
    return;
  }

  // The page itself carries no secrets, so it is served unauthenticated;
  // everything that reads or writes anything lives under /api and is not.
  //
  // On Vercel these never arrive: the page and the PWA files are static files
  // served from the CDN, and only /api/* reaches the function. Kept anyway,
  // because the local server is the same code path.
  if (!url.pathname.startsWith("/api/")) {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      serveUi(res);
    } else if (!serveStatic(url.pathname, res)) {
      send(res, 404, { error: "Not found." });
    }
    return;
  }

  if (oauth) {
    // First, and ahead of the sign-in routes too: a top-level navigation sends
    // no Origin, so LinkedIn's redirect back still passes, while a page on
    // another site cannot start or end a session on your behalf.
    if (!originIsSelf(req)) {
      send(res, 403, { error: `Origin ${String(req.headers.origin)} may not call this app.` });
      return;
    }

    // The way in and the way out, so necessarily reachable without a session.
    if (url.pathname === "/api/login") return handleLogin(res);
    if (url.pathname === "/api/callback") return handleCallback(req, res, url);
    if (url.pathname === "/api/logout") return handleLogout(res);

    const session = sessionFor(req);
    if (!session) {
      // `login` rather than a bare message: the page uses it to show a sign-in
      // button instead of an error nobody can act on.
      send(res, 401, {
        error: "Not signed in.",
        login: "/api/login",
      });
      return;
    }

    // Re-checked here, not only at sign-in. The cookie lasts 30 days, so
    // without this, taking someone off LINKEDIN_ALLOWED_MEMBERS left them
    // posting for up to a month. The cookie is cleared as well as refused, so
    // the browser stops presenting an identity the app no longer honours.
    const access = accessStillGranted(session);
    if (!access.allowed) {
      revokeSession(res);
      send(res, 403, { error: access.reason, login: "/api/login" });
      return;
    }

    // Every key this request touches is prefixed with the member's own tree.
    // Wrapping the dispatch rather than each handler is what makes that true
    // of code written later without it having to remember.
    await runAs(workspaceFor(session.memberUrn), () => dispatch(req, res, url));
    return;
  }

  const failure = checkRequest(req, uiToken());
  if (failure) {
    send(res, failure.status, { error: failure.message });
    return;
  }

  const origin = req.headers.origin;
  if (typeof origin === "string") {
    res.setHeader("access-control-allow-origin", origin);
  }

  await dispatch(req, res, url);
}

/**
 * The shared secret, read once. Not at module load: on a deployment there is no
 * writable disk to create it on, and `authMode` is "oauth" there — so the file
 * must never be touched unless token auth is actually in use.
 */
let cachedToken: string | null = null;
function uiToken(): string {
  cachedToken ??= loadOrCreateToken();
  return cachedToken;
}

export function startServer(): http.Server {
  // Only in token mode. Creating the shared secret under oauth would write a
  // file that nothing reads and imply a way in that does not exist.
  const token = config.authMode === "token" ? uiToken() : null;

  const server = http.createServer((req, res) => {
    void handleHttp(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) send(res, 500, { error: message });
      else res.end();
    });
  });

  // The one startup failure with an obvious cause and an obvious fix, and the
  // likeliest of all of them once there are two modes to run: a raw
  // EADDRINUSE stack trace answers neither question.
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EADDRINUSE") throw error;
    console.error("");
    console.error(`  Port ${config.uiPort} is already in use — something is listening there.`);
    console.error("");
    console.error("  Most likely another copy of this app is still running. Either close");
    console.error("  that terminal window, or start this one on a different port:");
    console.error(`    UI_PORT=5610 npm run ui        (bash)`);
    console.error(`    set UI_PORT=5610 && npm run ui (Windows cmd)`);
    console.error("");
    process.exit(1);
  });

  // 127.0.0.1, never 0.0.0.0 — see the note in http/auth.ts.
  server.listen(config.uiPort, "127.0.0.1", () => {
    // In oauth mode the URL has to be the one the OAuth callback comes back to.
    // 127.0.0.1 and localhost are different hosts to a browser, so opening one
    // while the callback returns to the other leaves the state cookie on the
    // wrong origin and every sign-in fails "could not be verified".
    const base =
      !token && config.publicUrl ? config.publicUrl : `http://127.0.0.1:${config.uiPort}`;
    const url = token ? `${base}/?token=${token}` : `${base}/`;
    const live = !config.forceDryRun;

    // A rule rather than a drawn box: a box has to be padded to the exact
    // width of its title, and the moment the title changes — or a terminal
    // renders the em dash at a different width — the right-hand edge is wrong.
    console.log("");
    console.log("  Postwright — LinkedIn post studio");
    console.log("  ─────────────────────────────────");
    console.log(`  Open   ${url}`);
    console.log(`  Mode   ${live ? "LIVE — publishing sends to LinkedIn" : "dry run — nothing will be sent"}`);
    console.log(`  Store  ${config.storageBackend === "s3" ? "S3 bucket" : "local files"}`);
    // Same five-character label column as the lines above it.
    console.log(`  Auth   ${token ? "shared token (loopback)" : "sign in with LinkedIn"}`);
    console.log("");
    console.log(
      token
        ? "  Bound to 127.0.0.1 only. The token is in .state/ui-token.txt."
        : "  Bound to 127.0.0.1 only. UI_AUTH=oauth — open the URL and sign in.",
    );
    console.log("  Ctrl+C to stop.");
    console.log("");

    // The URL is long and carries a secret, so retyping it is not an option and
    // copying it out of a terminal is a step that exists for no reason. Printed
    // first, either way, so a machine with no opener loses nothing.
    // UI_OPEN_BROWSER=false for a headless box, or when the terminal is the
    // point (a tunnel, a remote session).
    if (process.env.UI_OPEN_BROWSER !== "false") openInBrowser(url);
  });

  return server;
}

// Started only when this file is the process entry — `npm run ui`, or the
// double-click launcher. The Vercel function imports handleHttp from here, and
// an import that opened a listening socket would be a second server nobody
// asked for, on a platform with no port to give it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
