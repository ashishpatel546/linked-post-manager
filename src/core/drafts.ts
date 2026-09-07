import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config, ROOT } from "../config.ts";
import { getJson, keys, putJson, storage } from "../storage/index.ts";
import { assertPostLength } from "../linkedin/text.ts";
import { uploadImage } from "../linkedin/images.ts";
import { assertPageCount, uploadDocument } from "../linkedin/documents.ts";
import { renderArticlePdf } from "../render/article.ts";
import type { PostContent, Visibility } from "../linkedin/posts.ts";
import { resolveAuthorUrn, type Target } from "./targets.ts";
import { publishPost, type PublishResult } from "./publish.ts";

/**
 * A draft is a plain markdown file you can open and edit by hand. That is the
 * point: the review step is reading a file, not trusting a tool's summary of
 * what it is about to post.
 */
export type DraftStatus = "draft" | "approved" | "published";

/**
 * How the draft reaches the feed.
 *
 * "post"    — ordinary text post, optionally with images or a link preview.
 * "article" — long-form. The prose lives in a companion `<id>.article.md`,
 *             renders to a PDF, and publishes as a LinkedIn document post: a
 *             titled, swipeable deck with `body` as the text above it.
 *
 * Note that LinkedIn's native long-form Articles (the /pulse editor) are NOT
 * this, and cannot be reached from any API — the Articles API is read-only.
 * A document post is the long-form format an integration can actually publish.
 */
export type DraftFormat = "post" | "article";

/**
 * How an article reaches the feed — including the one route that does not go
 * through this tool at all.
 *
 * "carousel" — rendered to a PDF and posted as a document. No length limit.
 * "text"     — the prose is the post's own text. Capped at 3,000 like any post.
 * "manual"   — a full-length article for LinkedIn's own /pulse editor. Nothing
 *              can publish this: the Articles API is read-only, with no create
 *              endpoint. The draft exists to be written, kept, and copied out.
 */
export type ArticleMode = "carousel" | "text" | "manual";
export type DeckTheme = "dark" | "light";

export type Draft = {
  id: string;
  topic: string;
  target: Target;
  format: DraftFormat;
  visibility: Visibility;
  status: DraftStatus;
  /** The commentary LinkedIn shows as the post's own text, in both formats. */
  body: string;
  /** Headline LinkedIn displays above the deck. Articles only. */
  articleTitle?: string;
  /**
   * How an article reaches the feed. "carousel" renders the prose to a deck
   * and posts a document; "text" posts the prose itself as a long text post,
   * with `images` attached. Unset means carousel.
   */
  articleMode?: ArticleMode;
  /** Deck colour scheme. Unset means LINKEDIN_DECK_THEME, then dark. */
  theme?: DeckTheme;
  link?: string;
  images: string[];
  created: string;
  publishedUrn?: string;
  publishedAt?: string;
};

/**
 * Still a plain markdown file locally — the storage key *is* `drafts/<id>.md`,
 * so nothing moved when this went through the storage layer, and the draft
 * stays a document you can open in an editor. On S3 the same text is the
 * object body, so a bucket is as readable as the working copy.
 */

/**
 * The long-form prose sits beside the draft rather than inside it: `body` keeps
 * its single meaning — what appears as the post's text — and the article stays
 * a document you can open and read on its own.
 */
export async function readArticleBody(id: string): Promise<string> {
  const raw = await storage.getText(keys.draftArticle(id));
  if (raw === null) {
    throw new Error(
      `Draft ${id} is marked as an article but drafts/${id}.article.md is missing. ` +
        "Save the draft again with the `article` argument.",
    );
  }
  return raw.trim();
}

/**
 * An image the draft still lists but the store no longer holds — deleted from
 * `assets/`, or written under a different backend. Its own type so callers can
 * offer to drop it instead of surfacing a dead end: a stale image reference
 * must not be able to block saving, rendering, or previewing a draft that may
 * not even use images.
 */
export class MissingAssetError extends Error {
  key: string;
  constructor(key: string) {
    super(
      `The image ${key} is no longer in storage. It was attached to this draft, ` +
        "then removed from the store. Remove it from the draft, or re-attach the file.",
    );
    this.name = "MissingAssetError";
    this.key = key;
  }
}

/**
 * A draft's images are storage keys, not filesystem paths — a deployment has no
 * filesystem to point at. Anything that is not already in the store is copied
 * in, so "use this photo on my desktop" still works locally and the draft that
 * results is portable.
 */
export async function ingestImage(pathOrKey: string): Promise<string> {
  // Membership of the assets prefix, not mere existence, decides whether this
  // is already ingested. On the local backend keys map onto project paths, so
  // *any* file lying in the working tree "exists" as a key — testing existence
  // alone would leave `tmp/photo.png` in the draft as though it were stored,
  // and that key means nothing on another machine or in a bucket.
  const assets = keys.asset("");
  if (pathOrKey.startsWith(assets)) {
    if (await storage.exists(pathOrKey)) return pathOrKey;
    // An ingested asset that is no longer there. Saying "give a path to a
    // local file" would be misleading — this key was written by this app and
    // has since been removed from the store, which is a different problem with
    // a different fix.
    throw new MissingAssetError(pathOrKey);
  }

  const absolute = path.isAbsolute(pathOrKey) ? pathOrKey : path.resolve(ROOT, pathOrKey);
  if (!fs.existsSync(absolute)) {
    throw new Error(
      `Image not found: ${pathOrKey}. Give a path to a local file, or a key already under ${assets}`,
    );
  }

  return ingestImageBytes(path.basename(absolute), new Uint8Array(fs.readFileSync(absolute)));
}

/**
 * The bytes-level ingest, shared by local files, browser uploads, and URL
 * imports. `provenance`, when given, is stored beside the asset: for an image
 * pulled off the web it is the only record of where it came from, which is
 * the first thing anyone asks when the licence question comes up.
 */
export async function ingestImageBytes(
  name: string,
  bytes: Uint8Array,
  provenance?: { sourceUrl: string; pageUrl?: string; title?: string },
): Promise<string> {
  const extension = path.extname(name).toLowerCase();
  const stem =
    path
      .basename(name, extension)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "image";

  // Content hash rather than a timestamp: two different photos both called
  // "screenshot.png" must not overwrite each other, and re-ingesting the same
  // file must not pile up copies.
  const digest = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  const key = keys.asset(`${stem}-${digest}${extension}`);

  if (!(await storage.exists(key))) await storage.putBytes(key, bytes);
  if (provenance) {
    await storage.putText(
      `${key}.source.json`,
      `${JSON.stringify({ ...provenance, importedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  }
  return key;
}

async function assertImagesExist(images: string[]): Promise<void> {
  const present = await Promise.all(images.map((image) => storage.exists(image)));
  const missing = images.filter((_, index) => !present[index]);
  if (missing.length > 0) {
    throw new Error(
      `Image(s) not found in storage: ${missing.join(", ")}. Save the draft again to re-ingest them.`,
    );
  }
}

export function slugify(topic: string): string {
  const stub = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const date = new Date().toISOString().slice(0, 10);
  return `${date}-${stub || "post"}`;
}

function serialize(draft: Draft): string {
  const front = [
    "---",
    `id: ${draft.id}`,
    `topic: ${JSON.stringify(draft.topic)}`,
    `target: ${draft.target}`,
    `format: ${draft.format}`,
    `visibility: ${draft.visibility}`,
    `status: ${draft.status}`,
    `articleTitle: ${JSON.stringify(draft.articleTitle ?? "")}`,
    `articleMode: ${draft.articleMode ?? ""}`,
    `theme: ${draft.theme ?? ""}`,
    `link: ${JSON.stringify(draft.link ?? "")}`,
    `images: ${JSON.stringify(draft.images)}`,
    `created: ${draft.created}`,
    `publishedUrn: ${JSON.stringify(draft.publishedUrn ?? "")}`,
    `publishedAt: ${JSON.stringify(draft.publishedAt ?? "")}`,
    "---",
    "",
  ].join("\n");
  return front + draft.body.trimEnd() + "\n";
}

function parse(id: string, raw: string): Draft {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(
      `Draft ${id} has no frontmatter block. Expected the file to start with a --- fenced header.`,
    );
  }

  const [, header = "", body = ""] = match;
  const fields = new Map<string, string>();
  for (const line of header.split(/\r?\n/)) {
    const eq = line.indexOf(":");
    if (eq === -1) continue;
    fields.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }

  const readString = (key: string, fallback = ""): string => {
    const value = fields.get(key);
    if (value === undefined || value === "") return fallback;
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string" ? parsed : value;
    } catch {
      return value;
    }
  };

  let images: string[] = [];
  const rawImages = fields.get("images");
  if (rawImages) {
    try {
      const parsed: unknown = JSON.parse(rawImages);
      if (Array.isArray(parsed)) images = parsed.filter((v): v is string => typeof v === "string");
    } catch {
      images = [];
    }
  }

  const target = readString("target", "me") === "company" ? "company" : "me";
  const status = readString("status", "draft") as DraftStatus;
  // Drafts written before formats existed have no field and are plain posts.
  const format = readString("format", "post") === "article" ? "article" : "post";
  const modeValue = readString("articleMode");
  const articleMode: ArticleMode | undefined =
    modeValue === "text" || modeValue === "manual" || modeValue === "carousel" ? modeValue : undefined;
  const themeValue = readString("theme");
  const theme = themeValue === "light" || themeValue === "dark" ? themeValue : undefined;

  return {
    id,
    topic: readString("topic"),
    target,
    format,
    ...(articleMode ? { articleMode } : {}),
    ...(theme ? { theme } : {}),
    visibility: (readString("visibility", "PUBLIC") || "PUBLIC") as Visibility,
    status: ["draft", "approved", "published"].includes(status) ? status : "draft",
    body: body.trim(),
    articleTitle: readString("articleTitle") || undefined,
    link: readString("link") || undefined,
    images,
    created: readString("created", new Date().toISOString()),
    publishedUrn: readString("publishedUrn") || undefined,
    publishedAt: readString("publishedAt") || undefined,
  };
}

export async function saveDraft(input: {
  id?: string;
  topic: string;
  target: Target;
  format: DraftFormat;
  body: string;
  articleTitle?: string;
  article?: string;
  articleMode?: ArticleMode;
  theme?: DeckTheme;
  visibility?: Visibility;
  link?: string;
  images?: string[];
}): Promise<Draft & { droppedImages?: string[] }> {
  // A manual article is not a post and never becomes one, so neither the empty
  // check nor the 3,000-character cap applies to it — that is the whole point
  // of the mode.
  const isManual = input.format === "article" && input.articleMode === "manual";
  if (!isManual || input.body) assertPostLength(input.body);

  // A text-mode article *is* the post text, so it lives under the same cap —
  // and the failure belongs here, while the author is still writing, not at
  // publish time after approval.
  if (input.format === "article" && input.articleMode === "text" && input.article) {
    assertPostLength(articleAsPostText(input.article));
  }
  // Copied into storage now, not at publish time: a missing file should surface
  // while the draft is being written, not once the user has approved it — and a
  // draft that points at a file which later moves would fail at the worst
  // moment.
  //
  // An image that was ingested and has since vanished from the store is the one
  // case that does not block: it is dropped from the draft and reported back.
  // Refusing the save instead made a stale reference fatal to everything —
  // including rendering a carousel, which does not use images at all — and left
  // no way to fix it from the UI, because fixing it required saving.
  const ingested: string[] = [];
  const droppedImages: string[] = [];
  if (input.images) {
    for (const image of input.images) {
      try {
        ingested.push(await ingestImage(image));
      } catch (error) {
        if (error instanceof MissingAssetError) {
          droppedImages.push(error.key);
          continue;
        }
        throw error;
      }
    }
  }

  const id = input.id ?? slugify(input.topic);
  const existing = (await storage.exists(keys.draft(id))) ? await readDraft(id) : null;

  if (existing?.status === "published") {
    throw new Error(
      `Draft ${id} was already published (${existing.publishedUrn}). Create a new draft instead of editing a published one.`,
    );
  }

  // A manual article carries its title in the prose, as the "# " line the
  // author will paste into LinkedIn's title field — so it is read from there
  // rather than demanded twice.
  const derivedTitle = isManual
    ? input.article?.match(/^#\s+(.+)$/m)?.[1]?.trim()
    : undefined;
  const articleTitle = input.articleTitle ?? existing?.articleTitle ?? derivedTitle;

  if (input.format === "article") {
    // Write the prose before the draft that points at it, so a failure here
    // cannot leave a draft claiming an article that does not exist.
    const article = input.article?.trim();
    if (!article && !(await storage.exists(keys.draftArticle(id)))) {
      throw new Error(
        "An article draft needs its prose: pass `article` with the long-form markdown.",
      );
    }
    if (!articleTitle) {
      throw new Error(
        "An article draft needs `articleTitle` — LinkedIn shows it above the deck.",
      );
    }
    if (article) await storage.putText(keys.draftArticle(id), `${article}\n`);
  }

  const draft: Draft = {
    id,
    topic: input.topic,
    target: input.target,
    format: input.format,
    visibility: input.visibility ?? existing?.visibility ?? "PUBLIC",
    // Any edit drops approval — approving text and then changing it must not
    // carry the approval forward.
    status: "draft",
    body: input.body,
    articleTitle,
    // Inherited only while the draft is still an article. A draft switched back
    // to a plain post that kept `articleMode: carousel` is a record that
    // contradicts itself, and every reader of it has to know which field wins.
    ...(input.format === "article" && (input.articleMode ?? existing?.articleMode)
      ? { articleMode: input.articleMode ?? existing?.articleMode }
      : {}),
    ...((input.theme ?? existing?.theme) ? { theme: input.theme ?? existing?.theme } : {}),
    link: input.link ?? existing?.link,
    images: input.images ? ingested : (existing?.images ?? []),
    created: existing?.created ?? new Date().toISOString(),
  };

  await storage.putText(keys.draft(id), serialize(draft));
  // Reported rather than hidden: the caller has to be able to say which images
  // were dropped, or "my picture disappeared" becomes a mystery.
  return droppedImages.length > 0 ? { ...draft, droppedImages } : draft;
}

export async function readDraft(id: string): Promise<Draft> {
  const raw = await storage.getText(keys.draft(id));
  if (raw === null) {
    throw new Error(`No draft with id "${id}". Use linkedin_list_drafts to see what exists.`);
  }
  return parse(id, raw);
}

export async function listDrafts(): Promise<Draft[]> {
  const objectKeys = await storage.list(keys.draftsPrefix);
  const ids = objectKeys
    .map((key) => key.slice(keys.draftsPrefix.length))
    // `.article.md` companions are part of a draft, not drafts of their own.
    .filter((name) => name.endsWith(".md") && !name.endsWith(".article.md"))
    .map((name) => name.slice(0, -".md".length));

  const loaded = await Promise.all(
    ids.map(async (id) => {
      try {
        return await readDraft(id);
      } catch {
        // One unparseable draft should not hide the rest of the list.
        return null;
      }
    }),
  );

  return loaded
    .filter((draft): draft is Draft => draft !== null)
    .sort((a, b) => b.created.localeCompare(a.created));
}

/**
 * Removes a draft and everything that belongs only to it — the prose companion
 * and the rendered deck.
 *
 * Ingested images are deliberately left alone: `assets/` is keyed by content
 * hash and shared between drafts, so deleting one draft's picture could pull it
 * out from under another.
 */
/**
 * Copies a draft and its companions into `published/`, then removes the
 * originals. Each file is copied before any is removed, so an interruption
 * leaves duplicates rather than a partially-archived post.
 */
async function moveAll(id: string): Promise<void> {
  const pairs: Array<[string, string]> = [
    [keys.draft(id), keys.published(id)],
    [keys.draftArticle(id), keys.publishedArticle(id)],
    [keys.draftPdf(id), keys.publishedPdf(id)],
  ];

  const moved: string[] = [];
  for (const [from, to] of pairs) {
    if (!(await storage.exists(from))) continue;
    const bytes = await storage.getBytes(from);
    if (bytes) await storage.putBytes(to, bytes);
    moved.push(from);
  }
  for (const from of moved) await storage.remove(from);
}

export async function deleteDraft(id: string): Promise<{ deleted: string[] }> {
  const draft = await readDraft(id);

  // A published draft is the only full copy of what went out — the audit entry
  // keeps 120 characters, and a personal post cannot be read back from the API.
  // Deleting it would destroy the record, so send it to the archive instead.
  if (draft.status === "published") {
    throw new Error(
      `Draft ${id} is already published (${draft.publishedUrn || "no URN recorded"}). ` +
        "Deleting it would destroy the only full copy of what you posted. " +
        "Use archivePublishedDrafts to move it to published/ instead.",
    );
  }

  const removed: string[] = [];
  for (const key of [keys.draft(id), keys.draftArticle(id), keys.draftPdf(id)]) {
    if (await storage.exists(key)) {
      await storage.remove(key);
      removed.push(key);
    }
  }
  return { deleted: removed };
}

/**
 * Moves any draft still marked `published` out of `drafts/`.
 *
 * Publishing has done this itself since the `published/` split, but drafts that
 * went out before it are still sitting in the working list pretending to be
 * work in progress. Idempotent, so it is safe to run whenever.
 */
export async function archivePublishedDrafts(): Promise<{ archived: string[] }> {
  const archived: string[] = [];
  for (const draft of await listDrafts()) {
    if (draft.status !== "published") continue;

    if (config.keepPublished === "full") {
      // Copy first, remove second: a failure between them leaves a duplicate
      // rather than a hole. The prose and the deck move with the record — they
      // are what went out, not scratch files.
      await moveAll(draft.id);
    } else {
      // Same retention as a fresh publish: keep the pointer, drop the copies.
      await putJson(storage, keys.publishedStub(draft.id), stubOf(draft));
      for (const key of [keys.draft(draft.id), keys.draftArticle(draft.id), keys.draftPdf(draft.id)]) {
        await storage.remove(key);
      }
    }
    archived.push(draft.id);
  }
  return { archived };
}

/**
 * The published record in its light form. Written when
 * LINKEDIN_KEEP_PUBLISHED=stub, which is the default: the post is on LinkedIn,
 * and what is worth keeping here is the pointer to it.
 */
export type PublishedStub = {
  id: string;
  topic: string;
  target: Target;
  format: DraftFormat;
  articleMode?: ArticleMode;
  publishedUrn?: string;
  publishedAt: string;
  /** Set on a stub, so a reader knows the text was deliberately not kept. */
  textKept: false;
};

function stubOf(draft: Draft): PublishedStub {
  return {
    id: draft.id,
    topic: draft.topic,
    target: draft.target,
    format: draft.format,
    ...(draft.articleMode ? { articleMode: draft.articleMode } : {}),
    ...(draft.publishedUrn ? { publishedUrn: draft.publishedUrn } : {}),
    publishedAt: draft.publishedAt ?? new Date().toISOString(),
    textKept: false,
  };
}

/** A stub read back as the same shape the rest of the code expects. */
function stubAsDraft(stub: PublishedStub): Draft & { textKept: false } {
  return {
    id: stub.id,
    topic: stub.topic,
    target: stub.target,
    format: stub.format,
    ...(stub.articleMode ? { articleMode: stub.articleMode } : {}),
    visibility: "PUBLIC",
    status: "published",
    body: "",
    images: [],
    created: stub.publishedAt,
    ...(stub.publishedUrn ? { publishedUrn: stub.publishedUrn } : {}),
    publishedAt: stub.publishedAt,
    textKept: false,
  };
}

/**
 * What went out, newest first.
 *
 * Capped, and paginated by key rather than by reading everything: ids begin
 * with the publish date, so a lexical sort is chronological and only the page
 * being shown is fetched. Reading every record to show the most recent handful
 * is the kind of thing that costs nothing on a filesystem and grows without
 * bound against a bucket.
 */
export async function listPublished(
  options: { limit?: number; before?: string } = {},
): Promise<{ published: Array<Draft & { textKept?: false }>; nextCursor?: string }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

  const objectKeys = (await storage.list(keys.publishedPrefix))
    .filter((key) => key.endsWith(".md") || key.endsWith(".json"))
    .sort()
    .reverse();

  const before = options.before;
  const after = before ? objectKeys.filter((key) => key < before) : objectKeys;
  const page = after.slice(0, limit);

  const loaded = await Promise.all(
    page.map(async (key) => {
      try {
        if (key.endsWith(".json")) {
          const stub = await getJson<PublishedStub>(storage, key);
          return stub ? stubAsDraft(stub) : null;
        }
        const id = key.slice(keys.publishedPrefix.length, -".md".length);
        const raw = await storage.getText(key);
        return raw === null ? null : parse(id, raw);
      } catch {
        return null;
      }
    }),
  );

  const published = loaded
    .filter((draft): draft is Draft => draft !== null)
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));

  const last = page[page.length - 1];
  return after.length > limit && last ? { published, nextCursor: last } : { published };
}

export type StoredFile = {
  key: string;
  kind: "record" | "prose" | "deck" | "image";
  bytes: number;
  /** True when another draft or published record also points at this file. */
  shared?: boolean;
};

/**
 * Every file that makes up a published post: the markdown record, the article
 * prose, the rendered PDF, and any attached images. Listed rather than assumed,
 * because "delete the stored copy" should say what it is about to remove.
 *
 * Images are marked `shared` when another record points at the same key —
 * `assets/` is keyed by content hash, so the same picture can belong to several
 * posts and deleting it would pull it out from under them.
 */
export async function publishedFiles(id: string): Promise<StoredFile[]> {
  const record = await readPublished(id);
  const files: StoredFile[] = [];

  // stat, not getBytes: the size is metadata, and downloading a 124 KB deck to
  // print "124 KB" is the kind of thing that only shows up on the bill.
  const add = async (key: string, kind: StoredFile["kind"]): Promise<void> => {
    const info = await storage.stat(key);
    if (info) files.push({ key, kind, bytes: info.bytes });
  };

  await add(keys.publishedStub(id), "record");
  await add(keys.published(id), "record");
  await add(keys.publishedArticle(id), "prose");
  await add(keys.publishedPdf(id), "deck");

  if (record.images.length > 0) {
    const [drafts, { published }] = await Promise.all([listDrafts(), listPublished({ limit: 200 })]);
    const others = [...drafts, ...published].filter((other) => other.id !== id);

    for (const image of record.images) {
      const info = await storage.stat(image);
      if (!info) continue;
      const shared = others.some((other) => other.images.includes(image));
      files.push({ key: image, kind: "image", bytes: info.bytes, ...(shared ? { shared } : {}) });
    }
  }

  return files;
}

/**
 * One published record. Full when the text was kept, otherwise the stub —
 * which carries the URN, so the post can still be opened even though its words
 * live only on LinkedIn now.
 */
export async function readPublished(
  id: string,
): Promise<Draft & { article?: string; textKept?: false }> {
  const raw = await storage.getText(keys.published(id));

  if (raw === null) {
    const stub = await getJson<PublishedStub>(storage, keys.publishedStub(id));
    if (stub) return stubAsDraft(stub);
    throw new Error(`No published record with id "${id}".`);
  }

  const record = parse(id, raw);
  const article = await storage.getText(keys.publishedArticle(id));
  return article === null ? record : { ...record, article: article.trim() };
}

/**
 * Deletes the stored copy of a published post — the record, its prose, its
 * deck. The post on LinkedIn is untouched; this only forgets it locally.
 *
 * Worth knowing before calling: this is the *only* full copy of what went out.
 * The audit entry keeps 120 characters, and a personal post cannot be read back
 * from the API — `r_member_social` is a closed permission LinkedIn does not
 * grant — so once this is gone, the text is only on LinkedIn.
 */
export async function deletePublished(
  id: string,
  options: { includeImages?: boolean } = {},
): Promise<{ deleted: string[]; kept: string[]; urn?: string }> {
  const record = await readPublished(id);
  const files = await publishedFiles(id);

  const deleted: string[] = [];
  const kept: string[] = [];

  for (const file of files) {
    // An image is only removed when asked for, and never when another record
    // still points at it: `assets/` is content-addressed and shared.
    if (file.kind === "image" && (!options.includeImages || file.shared)) {
      kept.push(file.key);
      continue;
    }
    await storage.remove(file.key);
    deleted.push(file.key);
  }

  return record.publishedUrn ? { deleted, kept, urn: record.publishedUrn } : { deleted, kept };
}

/**
 * Marks a draft publishable. Separate from publishing on purpose: approval is
 * an explicit act recorded in the file, and any later edit resets it.
 */
export async function approveDraft(id: string): Promise<Draft> {
  const draft = await readDraft(id);
  if (draft.status === "published") {
    throw new Error(`Draft ${id} is already published.`);
  }
  const approved: Draft = { ...draft, status: "approved" };
  await storage.putText(keys.draft(id), serialize(approved));
  return approved;
}

/**
 * Markdown prose as LinkedIn plain text. Headings become their own line —
 * LinkedIn renders no markup, so a `#` would print literally — and everything
 * else is left as the paragraphs the author wrote.
 */
export function articleAsPostText(article: string): string {
  return article
    .split(/\r?\n/)
    .map((line) => line.replace(/^#{1,3}\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1"))
    .join("\n")
    .replace(/^\s*---\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The text that goes above the attachment — or is the whole post. */
async function postText(draft: Draft): Promise<string> {
  if (draft.format === "article" && draft.articleMode === "text") {
    return articleAsPostText(await readArticleBody(draft.id));
  }
  return draft.body;
}

/**
 * Turns a draft's attachments into post content. Images win over a link — a
 * LinkedIn post carries one or the other, not both.
 *
 * Uploading is deferred until the moment of a real publish: a dry run must not
 * push bytes to LinkedIn, and an image uploaded during a preview that is never
 * published would be an orphan asset.
 */
async function buildDraftContent(
  draft: Draft,
  willPublish: boolean,
): Promise<{ content?: PostContent; pages?: number }> {
  // A text-mode article is a long post with pictures: the prose is the text
  // (see postText) and the attachments follow the ordinary image path below.
  if (draft.format === "article" && draft.articleMode !== "text") {
    // Render on every call, dry run included: the PDF is the thing the user
    // reviews before approving, so it must exist without publishing anything.
    const rendered = renderArticlePdf({
      id: draft.id,
      title: draft.articleTitle ?? draft.topic,
      body: await readArticleBody(draft.id),
      theme: draft.theme,
    });
    assertPageCount(rendered.pages);

    // Persisted even on a dry run: the PDF is the thing being reviewed before
    // approval, so it has to be openable without publishing anything.
    await storage.putBytes(rendered.file, rendered.bytes, "application/pdf");

    if (!willPublish || config.forceDryRun) return { pages: rendered.pages };

    const owner = await resolveAuthorUrn(draft.target);
    const documentUrn = await uploadDocument(owner, `${draft.id}.pdf`, rendered.bytes);
    return {
      pages: rendered.pages,
      content: {
        kind: "document",
        documentUrn,
        title: draft.articleTitle ?? draft.topic,
      },
    };
  }

  if (draft.images.length > 0) {
    await assertImagesExist(draft.images);

    if (!willPublish || config.forceDryRun) {
      // Nothing is sent, so there is no image URN yet. Report the intent
      // instead, and let the article/text path render the preview.
      return draft.link ? { content: { kind: "article", url: draft.link } } : {};
    }

    const owner = await resolveAuthorUrn(draft.target);
    const urns: string[] = [];
    for (const image of draft.images) {
      const bytes = await storage.getBytes(image);
      if (!bytes) throw new Error(`Image ${image} vanished from storage between save and publish.`);
      urns.push(await uploadImage(owner, image, bytes));
    }

    const [first] = urns;
    if (urns.length === 1 && first) {
      return { content: { kind: "image", imageUrn: first } };
    }
    return {
      content: {
        kind: "multiImage",
        images: urns.map((imageUrn) => ({ imageUrn })),
      },
    };
  }

  return draft.link ? { content: { kind: "article", url: draft.link } } : {};
}

export async function publishDraft(
  id: string,
  confirm: boolean,
): Promise<PublishResult & { draftId: string; articlePdf?: string; articlePages?: number }> {
  const draft = await readDraft(id);

  // Refused at the choke point rather than hidden in the UI, so the MCP tools
  // and anything added later hit the same wall with the same explanation.
  if (draft.articleMode === "manual") {
    throw new Error(
      `Draft ${id} is a manual article, written for LinkedIn's own article editor. ` +
        "No integration can publish one: the Articles API is read-only, with no create endpoint " +
        "(https://learn.microsoft.com/linkedin/shared/references/migrations/article-migration). " +
        "Copy it out of the app and paste it into the editor at https://www.linkedin.com/article/new/. " +
        "To publish long-form from here instead, switch the draft to the carousel mode.",
    );
  }

  if (draft.status === "published") {
    throw new Error(
      `Draft ${id} was already published as ${draft.publishedUrn}. Refusing to post it twice.`,
    );
  }
  if (draft.status !== "approved" && confirm) {
    throw new Error(
      `Draft ${id} has not been approved. Read it, then approve it with linkedin_approve_draft before publishing.`,
    );
  }

  const { content, pages } = await buildDraftContent(draft, confirm);

  const result = await publishPost({
    target: draft.target,
    text: await postText(draft),
    visibility: draft.visibility,
    content,
    confirm,
  });

  if (result.published) {
    const done: Draft = {
      ...draft,
      status: "published",
      publishedUrn: result.urn,
      publishedAt: new Date().toISOString(),
    };

    // What survives a publish, and why it is a choice.
    //
    // `drafts/` means work in progress, so a live post does not belong there.
    // What replaces it depends on LINKEDIN_KEEP_PUBLISHED:
    //
    //   stub (default) — a few hundred bytes: topic, URN, when. The post is on
    //     LinkedIn; this is the pointer to it. The markdown, the prose and the
    //     rendered deck are deleted.
    //   full — the whole record. Worth knowing before choosing it away: this is
    //     the only copy of the text you can read back. The audit entry keeps
    //     120 characters, and LinkedIn will not serve a personal post to the
    //     API — `r_member_social` is a closed permission.
    //
    // Either way the new record is written before the old files are removed, so
    // a failure between them leaves a duplicate rather than a hole.
    if (config.keepPublished === "full") {
      await storage.putText(keys.published(id), serialize(done));
      await storage.remove(keys.draft(id));
    } else {
      await putJson(storage, keys.publishedStub(id), stubOf(done));
      for (const key of [keys.draft(id), keys.draftArticle(id), keys.draftPdf(id)]) {
        await storage.remove(key);
      }
    }
  }

  return {
    ...result,
    draftId: id,
    // Surfaced on dry runs too: the deck is what there is to review.
    ...(draft.format === "article" ? { articlePdf: `drafts/${id}.pdf` } : {}),
    ...(pages !== undefined ? { articlePages: pages } : {}),
  };
}
