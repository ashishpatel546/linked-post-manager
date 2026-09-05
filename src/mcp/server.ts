import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { config } from "../config.ts";
import { tokenStatus } from "../state/tokens.ts";
import { readAudit, countPublishedToday } from "../state/audit.ts";
import { getAdministeredOrganizations, getUserInfo } from "../linkedin/me.ts";
import { listPostsByAuthor } from "../linkedin/posts.ts";
import { uploadImage } from "../linkedin/images.ts";
import {
  createComment,
  getEngagement,
  listComments,
} from "../linkedin/social.ts";
import {
  getFollowerStatistics,
  getShareStatistics,
} from "../linkedin/analytics.ts";
import { publishPost, removePost } from "../core/publish.ts";
import { resolveAuthorUrn } from "../core/targets.ts";
import {
  approveDraft,
  listDrafts,
  publishDraft,
  readDraft,
  saveDraft,
} from "../core/drafts.ts";

// NOTE: this process speaks MCP over stdout. Never console.log here — any
// stray write corrupts the protocol stream. Use console.error for diagnostics.

const server = new McpServer({ name: "linkedin-agent", version: "0.1.0" });

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(value: unknown): ToolResult {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

function fail(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/**
 * Wraps every tool so a thrown error comes back as readable text instead of
 * killing the request. The cast is needed because the SDK hands callbacks a
 * `{[key: string]: unknown}` bag, which is contravariant with the schema-derived
 * argument type — the validation itself still happens against `inputSchema`.
 */
function register<S extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: S,
  handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<unknown>,
): void {
  const callback = async (args: unknown): Promise<ToolResult> => {
    try {
      return ok(await handler(args as z.objectOutputType<S, z.ZodTypeAny>));
    } catch (error) {
      return fail(error);
    }
  };

  const registerTool = server.registerTool as unknown as (
    toolName: string,
    cfg: { description: string; inputSchema: S },
    cb: (args: unknown) => Promise<ToolResult>,
  ) => void;

  registerTool.call(server, name, { description, inputSchema }, callback);
}

const targetSchema = z
  .enum(["me", "company"])
  .describe(
    "Where to act: 'me' = the user's personal profile, 'company' = the configured company page. " +
      "REQUIRED, with no default — the two are different public audiences and posting to the wrong one cannot be undone quietly. " +
      "If the user has not said which they mean, ASK THEM before calling this tool. Do not infer it from the topic, and do not assume the last one used.",
  );

const formatSchema = z
  .enum(["post", "article"])
  .describe(
    "How this reaches the feed: 'post' = an ordinary text post, optionally with images or a link; " +
      "'article' = long-form, rendered to a PDF and published as a swipeable LinkedIn document post with a title. " +
      "REQUIRED, with no default — they look completely different in the feed and are written differently, " +
      "so a guess wastes the user's work. If the user has not said which they want, ASK THEM before calling this tool. " +
      "Note: LinkedIn's native long-form Articles (the /pulse editor) cannot be published by any API, so 'article' " +
      "means a document post — say so if the user asks for a native Article.",
  );

// ---------------------------------------------------------------- identity --

register(
  "linkedin_token_status",
  "Check whether LinkedIn is authorized, which scopes were granted, and when the token expires. Start here when anything fails.",
  {},
  async () => ({
    ...tokenStatus(),
    publishedToday: countPublishedToday(),
    dailyLimit: config.dailyPostLimit,
    forceDryRun: config.forceDryRun,
    apiVersion: config.apiVersion,
    configuredOrganization: config.organizationUrn || null,
  }),
);

register(
  "linkedin_whoami",
  "Fetch the authorized member's identity and the company pages they administer. Confirms the app is wired to the right account and page.",
  {},
  async () => {
    const info = await getUserInfo();
    let organizations: unknown = "unavailable — requires rw_organization_admin (Community Management API)";
    try {
      organizations = await getAdministeredOrganizations();
    } catch (error) {
      organizations = `unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
    return { member: info, organizations };
  },
);

// ------------------------------------------------------------------ drafts --

register(
  "linkedin_save_draft",
  "Write or overwrite a post draft as a markdown file the user can read and edit. This is the normal way to propose a post. Saving always resets the draft to unapproved.",
  {
    topic: z.string().describe("Short subject line; also used to build the draft id."),
    body: z
      .string()
      .describe(
        "The text as it appears on LinkedIn. For format 'post' this is the whole post. " +
          "For format 'article' this is the shorter commentary shown above the deck — " +
          "the long-form prose goes in `article`.",
      ),
    target: targetSchema,
    format: formatSchema,
    articleTitle: z
      .string()
      .optional()
      .describe(
        "Headline LinkedIn displays above the document deck. Required when format is 'article'.",
      ),
    article: z
      .string()
      .optional()
      .describe(
        "The long-form prose, as markdown. Required when format is 'article'; ignored otherwise. " +
          "Saved to drafts/<id>.article.md and rendered to a PDF deck at publish time. " +
          "Use '## Heading' to start a new section and '---' on its own line to force a page break.",
      ),
    id: z.string().optional().describe("Existing draft id to overwrite. Omit to create a new one."),
    visibility: z.enum(["PUBLIC", "CONNECTIONS", "LOGGED_IN"]).optional(),
    link: z.string().optional().describe("Optional URL to attach as a link preview."),
    images: z
      .array(z.string())
      .optional()
      .describe(
        "Local image files to attach (PNG/JPG/GIF, under 10 MB each), as paths relative to the project root or absolute paths. " +
          "One image posts as a single image, several as a multi-image post. Images take precedence over `link`. " +
          "Only use files the user pointed you at — never invent a path, and never attach an image the user has not seen.",
      ),
  },
  async (args) => {
    const draft = saveDraft({
      id: args.id,
      topic: args.topic,
      body: args.body,
      target: args.target,
      format: args.format,
      articleTitle: args.articleTitle,
      article: args.article,
      visibility: args.visibility,
      link: args.link,
      images: args.images,
    });
    return {
      draft,
      file: `drafts/${draft.id}.md`,
      ...(draft.format === "article"
        ? { articleFile: `drafts/${draft.id}.article.md` }
        : {}),
      next: "Ask the user to review it. When they approve, call linkedin_approve_draft, then linkedin_publish_draft with confirm: true.",
    };
  },
);

register("linkedin_list_drafts", "List all drafts with their status.", {}, async () =>
  listDrafts().map((draft) => ({
    id: draft.id,
    topic: draft.topic,
    target: draft.target,
    format: draft.format,
    status: draft.status,
    characters: [...draft.body].length,
    publishedUrn: draft.publishedUrn ?? null,
  })),
);

register(
  "linkedin_read_draft",
  "Read one draft in full, including its body text.",
  { id: z.string() },
  async (args) => readDraft(args.id),
);

register(
  "linkedin_approve_draft",
  "Mark a draft approved for publishing. Only call this after the user has read the text and explicitly said to go ahead. Editing the draft afterwards resets approval.",
  { id: z.string() },
  async (args) => ({
    draft: approveDraft(args.id),
    next: "Now call linkedin_publish_draft with confirm: true to post it.",
  }),
);

register(
  "linkedin_publish_draft",
  "Publish an approved draft to LinkedIn. Requires confirm: true; without it you get a preview and nothing is sent.",
  {
    id: z.string(),
    confirm: z
      .boolean()
      .default(false)
      .describe("Must be true to actually publish. Only set it when the user has approved this exact text."),
  },
  async (args) => publishDraft(args.id, args.confirm),
);

// ---------------------------------------------------------------- posting --

register(
  "linkedin_preview_post",
  "Render exactly what would be sent to LinkedIn for a given text, without publishing. Safe to call freely.",
  {
    target: targetSchema,
    text: z.string(),
    visibility: z.enum(["PUBLIC", "CONNECTIONS", "LOGGED_IN"]).optional(),
    link: z.string().optional(),
  },
  async (args) =>
    publishPost({
      target: args.target,
      text: args.text,
      visibility: args.visibility,
      content: args.link ? { kind: "article", url: args.link } : undefined,
      confirm: false,
    }),
);

register(
  "linkedin_publish_post",
  "Publish text directly to LinkedIn without going through a draft. Prefer the draft flow so the user can review first. Requires confirm: true.",
  {
    target: targetSchema,
    text: z.string(),
    confirm: z.boolean().default(false).describe("Must be true to actually publish."),
    visibility: z.enum(["PUBLIC", "CONNECTIONS", "LOGGED_IN"]).optional(),
    link: z.string().optional(),
    imageUrn: z.string().optional().describe("urn:li:image:... from linkedin_upload_image."),
    imageAltText: z.string().optional(),
  },
  async (args) => {
    const content = args.imageUrn
      ? ({ kind: "image", imageUrn: args.imageUrn, altText: args.imageAltText } as const)
      : args.link
        ? ({ kind: "article", url: args.link } as const)
        : undefined;

    return publishPost({
      target: args.target,
      text: args.text,
      visibility: args.visibility,
      content,
      confirm: args.confirm,
    });
  },
);

register(
  "linkedin_upload_image",
  "Upload a local image file and get back the urn:li:image:... to attach to a post.",
  {
    target: targetSchema,
    filePath: z.string().describe("Absolute path to a PNG, JPG, or GIF."),
  },
  async (args) => {
    const owner = await resolveAuthorUrn(args.target);
    return { imageUrn: await uploadImage(owner, args.filePath) };
  },
);

register(
  "linkedin_delete_post",
  "Permanently delete a post. Requires confirm: true.",
  {
    target: targetSchema,
    postUrn: z.string(),
    confirm: z.boolean().default(false),
  },
  async (args) => removePost(args),
);

// ------------------------------------------------------- company page reads --

register(
  "linkedin_list_company_posts",
  "List recent posts on the company page. Requires r_organization_social; LinkedIn has no equivalent for a personal profile.",
  { count: z.number().int().min(1).max(50).default(10) },
  async (args) => listPostsByAuthor(config.organizationUrn, args.count),
);

register(
  "linkedin_list_comments",
  "List comments on a company page post.",
  {
    postUrn: z.string().describe("urn:li:share:... or urn:li:ugcPost:..."),
    count: z.number().int().min(1).max(100).default(20),
  },
  async (args) => listComments(args.postUrn, args.count),
);

register(
  "linkedin_reply_to_comment",
  "Post a comment as the company page. Requires confirm: true — this is publicly visible under the company's name.",
  {
    postUrn: z.string(),
    text: z.string(),
    confirm: z.boolean().default(false),
  },
  async (args) => {
    if (!args.confirm) {
      return {
        posted: false,
        reason: "Not posted: confirm was not set to true.",
        preview: { postUrn: args.postUrn, text: args.text },
      };
    }
    const actorUrn = await resolveAuthorUrn("company");
    return { posted: true, ...(await createComment({ actorUrn, postUrn: args.postUrn, text: args.text })) };
  },
);

register(
  "linkedin_post_engagement",
  "Get like and comment counts for a single post.",
  { postUrn: z.string() },
  async (args) => getEngagement(args.postUrn),
);

register(
  "linkedin_company_analytics",
  "Lifetime share statistics and follower statistics for the company page.",
  {},
  async () => {
    const urn = config.organizationUrn;
    const [shares, followers] = await Promise.all([
      getShareStatistics(urn),
      getFollowerStatistics(urn),
    ]);
    return { organization: urn, shares, followers };
  },
);

// ------------------------------------------------------------------- audit --

register(
  "linkedin_audit_log",
  "Recent write activity by this agent, including dry runs, with the URN of anything actually published.",
  { limit: z.number().int().min(1).max(200).default(25) },
  async (args) => ({
    publishedToday: countPublishedToday(),
    dailyLimit: config.dailyPostLimit,
    entries: readAudit(args.limit),
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("linkedin-agent MCP server ready on stdio");
