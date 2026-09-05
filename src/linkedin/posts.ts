import { apiGet, apiRequest, encodeUrn } from "./client.ts";
import { assertPostLength, escapeCommentary } from "./text.ts";

export type Visibility = "PUBLIC" | "CONNECTIONS" | "LOGGED_IN";

export type PostContent =
  | { kind: "text" }
  | {
      kind: "article";
      url: string;
      title?: string;
      description?: string;
      thumbnailUrn?: string;
    }
  | { kind: "image"; imageUrn: string; altText?: string }
  | {
      kind: "multiImage";
      images: Array<{ imageUrn: string; altText?: string }>;
    }
  | {
      /**
       * A PDF, rendered by LinkedIn as a swipeable deck in the feed. `title` is
       * shown above the pages and is required — LinkedIn falls back to the raw
       * file name without it.
       */
      kind: "document";
      documentUrn: string;
      title: string;
    };

export type CreatePostInput = {
  authorUrn: string;
  text: string;
  visibility?: Visibility;
  content?: PostContent;
  /** Blocks other members from resharing. */
  disableReshare?: boolean;
};

function buildContent(content: PostContent | undefined): unknown {
  if (!content || content.kind === "text") return undefined;

  if (content.kind === "article") {
    return {
      article: {
        source: content.url,
        ...(content.title ? { title: content.title } : {}),
        ...(content.description ? { description: content.description } : {}),
        ...(content.thumbnailUrn ? { thumbnail: content.thumbnailUrn } : {}),
      },
    };
  }

  if (content.kind === "image") {
    return {
      media: {
        id: content.imageUrn,
        ...(content.altText ? { altText: content.altText } : {}),
      },
    };
  }

  // A document post reuses the `media` shape, distinguished only by the URN
  // type and the required title.
  if (content.kind === "document") {
    return {
      media: {
        id: content.documentUrn,
        title: content.title,
      },
    };
  }

  return {
    multiImage: {
      images: content.images.map((image) => ({
        id: image.imageUrn,
        ...(image.altText ? { altText: image.altText } : {}),
      })),
    },
  };
}

/** The exact JSON that would be sent to /rest/posts. Used by dry-run previews. */
export function buildPostPayload(input: CreatePostInput): Record<string, unknown> {
  assertPostLength(input.text);
  const content = buildContent(input.content);

  return {
    author: input.authorUrn,
    commentary: escapeCommentary(input.text),
    visibility: input.visibility ?? "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: input.disableReshare ?? false,
    ...(content ? { content } : {}),
  };
}

export type CreatedPost = { urn: string };

export async function createPost(input: CreatePostInput): Promise<CreatedPost> {
  const payload = buildPostPayload(input);
  const { headers } = await apiRequest<unknown>("/rest/posts", {
    method: "POST",
    body: payload,
  });

  // LinkedIn returns 201 with an empty body; the new post's URN comes back in
  // this header.
  const urn = headers.get("x-restli-id") ?? headers.get("x-linkedin-id");
  if (!urn) {
    throw new Error(
      "LinkedIn accepted the post but returned no URN header. Check the page before retrying — the post may already be live.",
    );
  }
  return { urn };
}

export async function deletePost(postUrn: string): Promise<void> {
  await apiRequest<unknown>(`/rest/posts/${encodeUrn(postUrn)}`, {
    method: "DELETE",
  });
}

export type PostSummary = {
  urn: string;
  commentary: string;
  createdAt: string | null;
  lifecycleState: string;
  visibility: string;
};

type PostsResponse = {
  elements?: Array<{
    id: string;
    commentary?: string;
    createdAt?: number;
    lifecycleState?: string;
    visibility?: string;
  }>;
};

/**
 * Read back posts by author. Works for organizations with r_organization_social;
 * LinkedIn does not permit this for member (person) authors.
 */
export async function listPostsByAuthor(
  authorUrn: string,
  count = 10,
): Promise<PostSummary[]> {
  const response = await apiGet<PostsResponse>("/rest/posts", {
    q: "author",
    author: authorUrn,
    count,
    sortBy: "LAST_MODIFIED",
  });

  return (response.elements ?? []).map((element) => ({
    urn: element.id,
    commentary: element.commentary ?? "",
    createdAt: element.createdAt
      ? new Date(element.createdAt).toISOString()
      : null,
    lifecycleState: element.lifecycleState ?? "UNKNOWN",
    visibility: element.visibility ?? "UNKNOWN",
  }));
}
