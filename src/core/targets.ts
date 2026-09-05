import { config } from "../config.ts";
import { loadTokens, saveTokens } from "../state/tokens.ts";
import { getUserInfo, memberUrn } from "../linkedin/me.ts";

/**
 * Which surface a post goes to. Always explicit — there is deliberately no
 * default, so a malformed tool call cannot pick a feed on its own.
 */
export type Target = "me" | "company";

export async function resolveAuthorUrn(target: Target): Promise<string> {
  if (target === "company") {
    const urn = config.organizationUrn;
    if (!urn) {
      throw new Error(
        "LINKEDIN_ORGANIZATION_URN is not set in .env. Expected something like urn:li:organization:109594354.",
      );
    }
    return urn;
  }

  const tokens = loadTokens();
  if (tokens?.memberUrn) return tokens.memberUrn;

  // First use after auth, or a token file written before we cached the URN.
  const info = await getUserInfo();
  const urn = memberUrn(info.sub);
  if (tokens) {
    saveTokens({ ...tokens, memberUrn: urn, memberName: info.name ?? tokens.memberName });
  }
  return urn;
}

export function describeTarget(target: Target): string {
  return target === "company"
    ? `company page (${config.organizationUrn})`
    : "your personal profile";
}

export function auditTarget(target: Target): "member" | "organization" {
  return target === "company" ? "organization" : "member";
}
