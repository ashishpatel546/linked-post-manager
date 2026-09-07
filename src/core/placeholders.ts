/**
 * Unfilled placeholders must never reach the feed.
 *
 * The drafting prompt deliberately forbids inventing figures: told to write
 * about results it does not know, the model emits `[NUMBER: tickets deflected]`
 * rather than a plausible lie. That is the right behaviour — but only if
 * something downstream notices. It did not, and a post went out publicly
 * reading "over [NUMBER] permutations of input".
 *
 * So the marker is a question addressed to the author, and this is the gate
 * that makes them answer it. Refusing to publish is the correct severity: the
 * alternative is a warning, and a warning that appears next to a Publish button
 * is a warning that gets clicked past.
 */

/**
 * Bracketed all-caps runs: `[NUMBER]`, `[NUMBER: deflected tickets]`,
 * `[CUSTOMER NAME]`, `[DATE]`.
 *
 * Deliberately narrow. Lowercase brackets are ordinary prose — "[see below]" —
 * and matching them would block real posts. An all-caps token inside brackets
 * is not something anyone writes by accident.
 */
const PLACEHOLDER = /\[[A-Z][A-Z0-9_-]{2,}(?:\s+[A-Z0-9_-]+)*(?::[^\]\n]{0,80})?\]/g;

export function findPlaceholders(text: string): string[] {
  return [...new Set(text.match(PLACEHOLDER) ?? [])];
}

/**
 * Called on the real publish path only. A preview should still render the
 * markers — seeing them in context is how the author knows what to fill in.
 */
export function assertNoPlaceholders(text: string): void {
  const found = findPlaceholders(text);
  if (found.length === 0) return;

  throw new Error(
    `Refusing to publish: the text still contains ${found.length} unfilled ` +
      `placeholder${found.length === 1 ? "" : "s"} — ${found.join(", ")}.\n\n` +
      "These are questions the draft is asking you. The model left them because " +
      "it does not know the real figures and was told not to invent them. Replace " +
      "each one with a number you can stand behind, or rewrite the sentence so it " +
      "does not need one, then save and approve again.",
  );
}
