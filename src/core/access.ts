import { config } from "../config.ts";

/**
 * Who is allowed to use a deployed instance.
 *
 * The LinkedIn app being registered under your account restricts nothing: it is
 * an OAuth client, so any LinkedIn member can authorize it, exactly as anyone
 * can "Sign in with Google" to a third-party site. On a public URL this list is
 * the only thing between a stranger and your provider key, your app's LinkedIn
 * rate limit, and your developer account's standing with LinkedIn.
 */

export type Identity = {
  /** urn:li:person:… — stable and unique. The strong identifier. */
  memberUrn: string;
  /** From the OIDC `email` claim, when the scope was granted. */
  email?: string | null;
  emailVerified?: boolean;
  name?: string | null;
};

export type AccessDecision =
  | { allowed: true; matchedOn: "member-urn" | "email" }
  | { allowed: false; reason: string };

export function checkAccess(identity: Identity): AccessDecision {
  const list = config.allowedMembers;

  // Fails closed. An empty list on a deployment means nobody configured one,
  // and the safe reading of that is "nobody", not "everybody" — the opposite
  // default turns a forgotten env var into an open door.
  if (list.length === 0) {
    return {
      allowed: false,
      reason:
        "No members are allowed: LINKEDIN_ALLOWED_MEMBERS is empty. Set it to your " +
        "LinkedIn email or member URN. It is deliberately not permissive by default.",
    };
  }

  if (list.includes(identity.memberUrn.toLowerCase())) {
    return { allowed: true, matchedOn: "member-urn" };
  }

  const email = identity.email?.trim().toLowerCase();
  if (email && list.includes(email)) {
    // LinkedIn only returns the address once the member has confirmed it, but
    // check anyway: matching an unverified address would let anyone who typed
    // the right email into their own account inherit the allowance.
    if (identity.emailVerified === false) {
      return {
        allowed: false,
        reason: `${email} matches the allowlist but LinkedIn reports it as unverified.`,
      };
    }
    return { allowed: true, matchedOn: "email" };
  }

  return {
    allowed: false,
    reason: `${identity.email ?? identity.memberUrn} is not on the allowlist.`,
  };
}

export function assertAccess(identity: Identity): void {
  const decision = checkAccess(identity);
  if (!decision.allowed) throw new Error(decision.reason);
}

/**
 * An allowlist entry that is an email is only as stable as the address on the
 * account. Once someone has signed in, their URN is known, and pinning the list
 * to that removes the ambiguity — so surface the swap rather than leaving it to
 * be discovered.
 */
export function pinningHint(identity: Identity): string | null {
  const decision = checkAccess(identity);
  if (!decision.allowed || decision.matchedOn !== "email") return null;
  return (
    `Allowed by email. Consider replacing it in LINKEDIN_ALLOWED_MEMBERS with ` +
    `${identity.memberUrn}, which cannot change or be reassigned.`
  );
}
