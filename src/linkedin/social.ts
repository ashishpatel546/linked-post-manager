import { apiGet, apiRequest, encodeUrn } from "./client.ts";

export type Comment = {
  urn: string;
  actor: string;
  text: string;
  createdAt: string | null;
  likesCount: number;
  repliesCount: number;
};

type CommentsResponse = {
  elements?: Array<{
    $URN?: string;
    id?: string;
    actor?: string;
    created?: { time?: number };
    message?: { text?: string };
    likesSummary?: { totalLikes?: number };
    commentsSummary?: { aggregatedTotalComments?: number };
  }>;
};

/**
 * Comments on a post. Reading these requires r_organization_social and only
 * works for organization-authored posts — LinkedIn exposes no equivalent for a
 * member's own posts.
 */
export async function listComments(
  postUrn: string,
  count = 20,
): Promise<Comment[]> {
  const response = await apiGet<CommentsResponse>(
    `/rest/socialActions/${encodeUrn(postUrn)}/comments`,
    { count },
  );

  return (response.elements ?? []).map((element) => ({
    urn: element.$URN ?? element.id ?? "",
    actor: element.actor ?? "",
    text: element.message?.text ?? "",
    createdAt: element.created?.time
      ? new Date(element.created.time).toISOString()
      : null,
    likesCount: element.likesSummary?.totalLikes ?? 0,
    repliesCount: element.commentsSummary?.aggregatedTotalComments ?? 0,
  }));
}

export async function createComment(input: {
  actorUrn: string;
  postUrn: string;
  text: string;
}): Promise<{ urn: string }> {
  const { data, headers } = await apiRequest<{ $URN?: string; id?: string }>(
    `/rest/socialActions/${encodeUrn(input.postUrn)}/comments`,
    {
      method: "POST",
      body: {
        actor: input.actorUrn,
        object: input.postUrn,
        message: { text: input.text },
      },
    },
  );

  const urn =
    data?.$URN ?? data?.id ?? headers.get("x-restli-id") ?? "(urn not returned)";
  return { urn };
}

type SocialMetadataResponse = {
  elements?: Array<{
    likesSummary?: { totalLikes?: number };
    commentsSummary?: { aggregatedTotalComments?: number };
  }>;
};

export async function getEngagement(
  postUrn: string,
): Promise<{ likes: number; comments: number }> {
  const response = await apiGet<SocialMetadataResponse>("/rest/socialActions", {
    ids: postUrn,
  });
  const first = response.elements?.[0];
  return {
    likes: first?.likesSummary?.totalLikes ?? 0,
    comments: first?.commentsSummary?.aggregatedTotalComments ?? 0,
  };
}
