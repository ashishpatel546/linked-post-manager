import { apiGet, encodeUrn } from "./client.ts";

type ShareStatisticsResponse = {
  elements?: Array<{
    totalShareStatistics?: {
      impressionCount?: number;
      uniqueImpressionsCount?: number;
      clickCount?: number;
      likeCount?: number;
      commentCount?: number;
      shareCount?: number;
      engagement?: number;
    };
  }>;
};

export type ShareStatistics = {
  impressions: number;
  uniqueImpressions: number;
  clicks: number;
  likes: number;
  comments: number;
  shares: number;
  /** LinkedIn's engagement rate, already a fraction of impressions. */
  engagementRate: number;
};

/** Lifetime aggregate stats for a page's posts. Community Management API. */
export async function getShareStatistics(
  organizationUrn: string,
): Promise<ShareStatistics> {
  const response = await apiGet<ShareStatisticsResponse>(
    "/rest/organizationalEntityShareStatistics",
    {
      q: "organizationalEntity",
      organizationalEntity: organizationUrn,
    },
  );

  const totals = response.elements?.[0]?.totalShareStatistics ?? {};
  return {
    impressions: totals.impressionCount ?? 0,
    uniqueImpressions: totals.uniqueImpressionsCount ?? 0,
    clicks: totals.clickCount ?? 0,
    likes: totals.likeCount ?? 0,
    comments: totals.commentCount ?? 0,
    shares: totals.shareCount ?? 0,
    engagementRate: totals.engagement ?? 0,
  };
}

type FollowerCountResponse = {
  firstDegreeSize?: number;
};

export async function getFollowerCount(
  organizationUrn: string,
): Promise<number> {
  const response = await apiGet<FollowerCountResponse>(
    `/rest/networkSizes/${encodeUrn(organizationUrn)}`,
    { edgeType: "CompanyFollowedByMember" },
  );
  return response.firstDegreeSize ?? 0;
}

type FollowerStatisticsResponse = {
  elements?: Array<{
    followerGains?: {
      organicFollowerGain?: number;
      paidFollowerGain?: number;
    };
    followerCountsByCountry?: Array<{
      country?: string;
      followerCounts?: { organicFollowerCount?: number };
    }>;
  }>;
};

export type FollowerStatistics = {
  totalFollowers: number;
  organicGain: number;
  paidGain: number;
  topCountries: Array<{ country: string; followers: number }>;
};

export async function getFollowerStatistics(
  organizationUrn: string,
): Promise<FollowerStatistics> {
  const [total, response] = await Promise.all([
    getFollowerCount(organizationUrn),
    apiGet<FollowerStatisticsResponse>(
      "/rest/organizationalEntityFollowerStatistics",
      {
        q: "organizationalEntity",
        organizationalEntity: organizationUrn,
      },
    ),
  ]);

  const first = response.elements?.[0];
  const topCountries = (first?.followerCountsByCountry ?? [])
    .map((entry) => ({
      country: entry.country ?? "unknown",
      followers: entry.followerCounts?.organicFollowerCount ?? 0,
    }))
    .sort((a, b) => b.followers - a.followers)
    .slice(0, 10);

  return {
    totalFollowers: total,
    organicGain: first?.followerGains?.organicFollowerGain ?? 0,
    paidGain: first?.followerGains?.paidFollowerGain ?? 0,
    topCountries,
  };
}
