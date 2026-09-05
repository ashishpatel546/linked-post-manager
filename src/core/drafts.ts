import fs from "node:fs";
import path from "node:path";
import { config, ROOT } from "../config.ts";
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
  link?: string;
  images: string[];
  created: string;
  publishedUrn?: string;
  publishedAt?: string;
};

function draftPath(id: string): string {
  return path.join(config.draftsDir, `${id}.md`);
}

/**
 * The long-form prose sits beside the draft rather than inside it: `body` keeps
 * its single meaning — what appears as the post's text — and the article stays
 * a document you can open and read on its own.
 */
export function articlePath(id: string): string {
  return path.join(config.draftsDir, `${id}.article.md`);
}

export function readArticleBody(id: string): string {
  const file = articlePath(id);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Draft ${id} is marked as an article but drafts/${id}.article.md is missing. ` +
        "Save the draft again with the `article` argument.",
    );
  }
  return fs.readFileSync(file, "utf8").trim();
}

/** Draft image paths may be relative to the project root, or absolute. */
export function resolveImagePath(image: string): string {
  return path.isAbsolute(image) ? image : path.resolve(ROOT, image);
}

function assertImagesExist(images: string[]): void {
  const missing = images.filter((image) => !fs.existsSync(resolveImagePath(image)));
  if (missing.length > 0) {
    throw new Error(
      `Image file(s) not found: ${missing.join(", ")}. Paths are relative to the project root, or give an absolute path.`,
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

  return {
    id,
    topic: readString("topic"),
    target,
    format,
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

export function saveDraft(input: {
  id?: string;
  topic: string;
  target: Target;
  format: DraftFormat;
  body: string;
  articleTitle?: string;
  article?: string;
  visibility?: Visibility;
  link?: string;
  images?: string[];
}): Draft {
  assertPostLength(input.body);
  // Fail now, not at publish time — a missing file should surface while the
  // draft is being written, not when the user has already approved it.
  if (input.images) assertImagesExist(input.images);
  fs.mkdirSync(config.draftsDir, { recursive: true });

  const id = input.id ?? slugify(input.topic);
  const existing = fs.existsSync(draftPath(id)) ? readDraft(id) : null;

  if (existing?.status === "published") {
    throw new Error(
      `Draft ${id} was already published (${existing.publishedUrn}). Create a new draft instead of editing a published one.`,
    );
  }

  const articleTitle = input.articleTitle ?? existing?.articleTitle;

  if (input.format === "article") {
    // Write the prose before the draft that points at it, so a failure here
    // cannot leave a draft claiming an article that does not exist.
    const article = input.article?.trim();
    if (!article && !fs.existsSync(articlePath(id))) {
      throw new Error(
        "An article draft needs its prose: pass `article` with the long-form markdown.",
      );
    }
    if (!articleTitle) {
      throw new Error(
        "An article draft needs `articleTitle` — LinkedIn shows it above the deck.",
      );
    }
    if (article) fs.writeFileSync(articlePath(id), `${article}\n`, "utf8");
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
    link: input.link ?? existing?.link,
    images: input.images ?? existing?.images ?? [],
    created: existing?.created ?? new Date().toISOString(),
  };

  fs.writeFileSync(draftPath(id), serialize(draft), "utf8");
  return draft;
}

export function readDraft(id: string): Draft {
  const file = draftPath(id);
  if (!fs.existsSync(file)) {
    throw new Error(`No draft with id "${id}". Use linkedin_list_drafts to see what exists.`);
  }
  return parse(id, fs.readFileSync(file, "utf8"));
}

export function listDrafts(): Draft[] {
  if (!fs.existsSync(config.draftsDir)) return [];
  return fs
    .readdirSync(config.draftsDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => {
      const id = name.replace(/\.md$/, "");
      try {
        return readDraft(id);
      } catch {
        return null;
      }
    })
    .filter((draft): draft is Draft => draft !== null)
    .sort((a, b) => b.created.localeCompare(a.created));
}

/**
 * Marks a draft publishable. Separate from publishing on purpose: approval is
 * an explicit act recorded in the file, and any later edit resets it.
 */
export function approveDraft(id: string): Draft {
  const draft = readDraft(id);
  if (draft.status === "published") {
    throw new Error(`Draft ${id} is already published.`);
  }
  const approved: Draft = { ...draft, status: "approved" };
  fs.writeFileSync(draftPath(id), serialize(approved), "utf8");
  return approved;
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
): Promise<PostContent | undefined> {
  if (draft.format === "article") {
    // Render on every call, dry run included: the PDF is the thing the user
    // reviews before approving, so it must exist without publishing anything.
    const rendered = renderArticlePdf({
      id: draft.id,
      title: draft.articleTitle ?? draft.topic,
      body: readArticleBody(draft.id),
    });
    assertPageCount(rendered.pages);

    if (!willPublish || config.forceDryRun) return undefined;

    const owner = await resolveAuthorUrn(draft.target);
    const documentUrn = await uploadDocument(owner, rendered.absolutePath);
    return {
      kind: "document",
      documentUrn,
      title: draft.articleTitle ?? draft.topic,
    };
  }

  if (draft.images.length > 0) {
    assertImagesExist(draft.images);

    if (!willPublish || config.forceDryRun) {
      // Nothing is sent, so there is no image URN yet. Report the intent
      // instead, and let the article/text path render the preview.
      return draft.link ? { kind: "article", url: draft.link } : undefined;
    }

    const owner = await resolveAuthorUrn(draft.target);
    const urns: string[] = [];
    for (const image of draft.images) {
      urns.push(await uploadImage(owner, resolveImagePath(image)));
    }

    const [first] = urns;
    if (urns.length === 1 && first) {
      return { kind: "image", imageUrn: first };
    }
    return {
      kind: "multiImage",
      images: urns.map((imageUrn) => ({ imageUrn })),
    };
  }

  return draft.link ? { kind: "article", url: draft.link } : undefined;
}

export async function publishDraft(
  id: string,
  confirm: boolean,
): Promise<PublishResult & { draftId: string; articlePdf?: string }> {
  const draft = readDraft(id);

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

  const result = await publishPost({
    target: draft.target,
    text: draft.body,
    visibility: draft.visibility,
    content: await buildDraftContent(draft, confirm),
    confirm,
  });

  if (result.published) {
    const done: Draft = {
      ...draft,
      status: "published",
      publishedUrn: result.urn,
      publishedAt: new Date().toISOString(),
    };
    fs.writeFileSync(draftPath(id), serialize(done), "utf8");
  }

  return {
    ...result,
    draftId: id,
    // Surfaced on dry runs too: the deck is what there is to review.
    ...(draft.format === "article" ? { articlePdf: `drafts/${id}.pdf` } : {}),
  };
}
