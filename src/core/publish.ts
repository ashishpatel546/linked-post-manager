import { config, envFileValue, parseBool } from "../config.ts";
import { appendAudit, assertUnderDailyLimit } from "../state/audit.ts";
import { buildPostPayload, createPost, deletePost } from "../linkedin/posts.ts";
import { withProfileLink } from "../linkedin/text.ts";
import type { PostContent, Visibility } from "../linkedin/posts.ts";
import {
  auditTarget,
  describeTarget,
  resolveAuthorUrn,
  type Target,
} from "./targets.ts";

export type PublishInput = {
  target: Target;
  text: string;
  visibility?: Visibility;
  content?: PostContent;
  /**
   * Must be explicitly true to actually publish. Anything else returns a
   * preview and touches nothing.
   */
  confirm?: boolean;
};

export type PublishResult =
  | {
      published: false;
      reason: string;
      preview: {
        target: string;
        authorUrn: string;
        characterCount: number;
        text: string;
        payload: Record<string, unknown>;
      };
    }
  | {
      published: true;
      urn: string;
      target: string;
      postUrl: string;
    };

/**
 * Explain the kill switch in terms of what the user still has to do. The flag
 * is read once at startup, so "it is true in .env" is a lie whenever someone
 * has already edited the file and is waiting for it to take effect — which is
 * exactly the moment they read this message.
 */
function killSwitchReason(): string {
  const onDisk = envFileValue("LINKEDIN_FORCE_DRY_RUN");

  if (onDisk !== undefined && !parseBool(onDisk, true)) {
    return (
      "Nothing was sent. .env now says LINKEDIN_FORCE_DRY_RUN=" +
      `${onDisk}, but this server process started while it was true and kept ` +
      "that value — .env is only read at startup. Restart the MCP server " +
      "(/mcp -> linkedin -> Reconnect, or restart Claude Code), then publish " +
      "again. The draft stays approved, so nothing needs redoing."
    );
  }

  return (
    "LINKEDIN_FORCE_DRY_RUN is true, so nothing was sent to LinkedIn. Set it " +
    "to false in .env when you are ready to publish for real, then restart " +
    "the MCP server so the change is picked up."
  );
}

function postUrlFor(urn: string): string {
  // Both urn:li:share:… and urn:li:ugcPost:… resolve through this path.
  return `https://www.linkedin.com/feed/update/${urn}/`;
}

/**
 * The single choke point for putting anything on LinkedIn. Every path — MCP
 * tool, draft publish, future HTTP endpoint for the browser extension — goes
 * through here, so the dry-run default, the daily cap, and the audit log cannot
 * be bypassed by adding a new caller.
 */
export async function publishPost(input: PublishInput): Promise<PublishResult> {
  const authorUrn = await resolveAuthorUrn(input.target);

  // Applied here rather than at draft time so it lands on every path — drafts,
  // direct posts, previews — and so changing the link in .env does not require
  // rewriting drafts that were saved before it.
  const text = withProfileLink(input.text, config.profileLink, config.profileLinkLabel);

  const payload = buildPostPayload({
    authorUrn,
    text,
    visibility: input.visibility,
    content: input.content,
  });

  const wouldPublish = input.confirm === true;
  const blockedByKillSwitch = config.forceDryRun;

  if (!wouldPublish || blockedByKillSwitch) {
    const reason = blockedByKillSwitch
      ? killSwitchReason()
      : "Not published: confirm was not set to true. Review the preview, then call again with confirm: true.";

    appendAudit({
      ts: new Date().toISOString(),
      action: "publish",
      target: auditTarget(input.target),
      authorUrn,
      summary: text.slice(0, 120),
      dryRun: true,
    });

    return {
      published: false,
      reason,
      preview: {
        target: describeTarget(input.target),
        authorUrn,
        // The preview must show exactly what would be posted, profile link
        // included — otherwise the thing being approved is not the thing sent.
        characterCount: [...text].length,
        text,
        payload,
      },
    };
  }

  assertUnderDailyLimit();

  const { urn } = await createPost({
    authorUrn,
    text,
    visibility: input.visibility,
    content: input.content,
  });

  appendAudit({
    ts: new Date().toISOString(),
    action: "publish",
    target: auditTarget(input.target),
    authorUrn,
    urn,
    summary: text.slice(0, 120),
    dryRun: false,
  });

  return {
    published: true,
    urn,
    target: describeTarget(input.target),
    postUrl: postUrlFor(urn),
  };
}

export async function removePost(input: {
  target: Target;
  postUrn: string;
  confirm?: boolean;
}): Promise<{ deleted: boolean; reason?: string }> {
  if (input.confirm !== true) {
    return {
      deleted: false,
      reason: `Not deleted: confirm was not set to true. This would permanently delete ${input.postUrn}.`,
    };
  }

  const authorUrn = await resolveAuthorUrn(input.target);
  await deletePost(input.postUrn);

  appendAudit({
    ts: new Date().toISOString(),
    action: "delete",
    target: auditTarget(input.target),
    authorUrn,
    urn: input.postUrn,
    summary: `deleted ${input.postUrn}`,
    dryRun: false,
  });

  return { deleted: true };
}
