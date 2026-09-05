import { apiGet } from "./client.ts";

export type UserInfo = {
  sub: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  email?: string;
  picture?: string;
};

/** OpenID Connect identity endpoint. `sub` is the member id. */
export async function getUserInfo(): Promise<UserInfo> {
  return apiGet<UserInfo>("/v2/userinfo");
}

export function memberUrn(sub: string): string {
  return `urn:li:person:${sub}`;
}

type OrganizationAclsResponse = {
  elements?: Array<{ organization: string; role: string; state: string }>;
};

type OrganizationResponse = {
  localizedName?: string;
  vanityName?: string;
};

export type AdministeredOrg = {
  urn: string;
  id: string;
  name: string | null;
};

/**
 * Organizations the authorized member administers. Requires the
 * rw_organization_admin scope from the Community Management API product, so
 * this throws a 403 until that product is approved for the app.
 */
export async function getAdministeredOrganizations(): Promise<AdministeredOrg[]> {
  const acls = await apiGet<OrganizationAclsResponse>("/rest/organizationAcls", {
    q: "roleAssignee",
    role: "ADMINISTRATOR",
    state: "APPROVED",
  });

  const orgs: AdministeredOrg[] = [];
  for (const element of acls.elements ?? []) {
    const id = element.organization.split(":").pop() ?? "";
    let name: string | null = null;
    try {
      const org = await apiGet<OrganizationResponse>(`/rest/organizations/${id}`);
      name = org.localizedName ?? org.vanityName ?? null;
    } catch {
      // Name lookup is a convenience; an ACL entry without it is still usable.
    }
    orgs.push({ urn: element.organization, id, name });
  }
  return orgs;
}
