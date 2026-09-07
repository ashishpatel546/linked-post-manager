import { AsyncLocalStorage } from "node:async_hooks";

import { config } from "../config.ts";

/**
 * Whose data a storage key refers to.
 *
 * Every key is built from a workspace prefix, so two people signed in at once
 * read and write disjoint trees. This exists because the alternative failure is
 * silent and severe: with one global `.state/tokens.json`, a second person
 * signing in overwrites the first person's LinkedIn token, both sessions keep
 * working, and the next publish goes out under the wrong name.
 *
 * The prefix is carried in async context rather than threaded through every
 * signature. That is a deliberate trade: an explicit parameter cannot be
 * forgotten, but it also cannot be enforced across a dozen call sites, and a
 * request handler that forgets to pass it would fall back to *someone's* data.
 * `AsyncLocalStorage` scopes it to the request that set it, so a leak between
 * concurrent requests is not expressible.
 */
export type Workspace = {
  /** Prepended to every key. Empty for the single-user local install. */
  prefix: string;
  /** urn:li:person:… once a session exists; null when running solo. */
  memberUrn: string | null;
  label: string;
};

/**
 * The local install: one person, one machine, guarded by the loopback bind and
 * the shared token. Keys are unprefixed, so `drafts/x.md` is the file it has
 * always been and stays editable by hand.
 */
export const SOLO: Workspace = { prefix: "", memberUrn: null, label: "solo" };

export function workspaceFor(memberUrn: string): Workspace {
  // The URN, not the email: an email is a mutable attribute of a LinkedIn
  // account and reusing one would hand a new owner the old owner's drafts.
  const id = memberUrn.replace(/^urn:li:person:/, "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new Error(`Refusing to build a workspace from malformed member URN ${JSON.stringify(memberUrn)}.`);
  }
  return { prefix: `users/${id}/`, memberUrn, label: id };
}

const context = new AsyncLocalStorage<Workspace>();

/** Runs `fn` with every storage key scoped to `workspace`. */
export function runAs<T>(workspace: Workspace, fn: () => T): T {
  return context.run(workspace, fn);
}

export function currentWorkspace(): Workspace {
  const active = context.getStore();
  if (active) return active;

  // Falling back to SOLO is right on a laptop and wrong on a deployment that
  // several people can reach: there, an unscoped key would be one shared tree.
  // So a multi-user install fails closed rather than guessing.
  if (config.requireIdentity) {
    throw new Error(
      "No signed-in member for this request, but REQUIRE_IDENTITY is on. " +
        "Every storage access must run inside runAs(workspaceFor(memberUrn)).",
    );
  }
  return SOLO;
}
