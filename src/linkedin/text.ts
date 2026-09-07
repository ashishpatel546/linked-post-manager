/**
 * The Posts API `commentary` field is not plain text — it is LinkedIn's `little`
 * Text Format, where these characters carry markup meaning and must be
 * backslash-escaped to appear literally. An unescaped `(` in ordinary prose is
 * the usual cause of a 422 from /rest/posts.
 *
 * This set is verified against the official grammar (little Text Format,
 * version 202608): Text ::= NON_RESERVED | \| \{ \} \@ \[ \] \( \) \< \> \# \\
 * \* \_ \~ . The docs are explicit that reserved characters must be escaped
 * "even if those characters are not used in one of the supported elements".
 */
const RESERVED = new Set([
  "\\",
  "|",
  "{",
  "}",
  "@",
  "[",
  "]",
  "(",
  ")",
  "<",
  ">",
  "#",
  "*",
  "_",
  "~",
]);

/**
 * A hashtag is '#' followed by a single word, and LinkedIn only renders it as a
 * real clickable hashtag when the '#' is left UNescaped — the official Posts API
 * example posts `Follow best practices #coding` verbatim. Escaping it would
 * publish the literal text "#coding" instead, silently killing every hashtag.
 *
 * Word characters only (no underscore): '_' is itself reserved, so `#my_tag`
 * escapes from the underscore onward rather than risking a malformed element.
 */
const HASHTAG = /^#[A-Za-z0-9]+/;

export function escapeCommentary(text: string): string {
  let out = "";
  let index = 0;

  while (index < text.length) {
    const char = text[index] as string;

    if (char === "#") {
      const hashtag = HASHTAG.exec(text.slice(index));
      if (hashtag) {
        out += hashtag[0];
        index += hashtag[0].length;
        continue;
      }
    }

    if (RESERVED.has(char)) out += "\\";
    out += char;
    index += 1;
  }

  return out;
}

/** Posts are capped at 3000 characters; fail before the API does. */
export const MAX_COMMENTARY_LENGTH = 3000;

/**
 * Append the configured profile link to a post's text.
 *
 * Idempotent on purpose: a draft body that already carries the URL — because
 * the author wrote it in, or because the text was round-tripped — must not end
 * up with it twice.
 *
 * But idempotent used to mean "leave it entirely alone", and that froze the
 * label: a draft written when LINKEDIN_PROFILE_LINK_LABEL was "More:" kept
 * saying "More:" no matter what the variable was changed to afterwards,
 * because the URL was already in the text. So a trailing sign-off line — a
 * short label and the URL, nothing else — is restamped with the configured
 * label. The URL anywhere else is the author's own sentence and is untouched.
 */
export function withProfileLink(text: string, link: string, label: string): string {
  const url = link.trim();
  if (!url) return text;

  const suffix = label ? `${label} ${url}` : url;
  const body = text.trimEnd();
  let combined: string;

  if (body.includes(url)) {
    const lines = body.split("\n");
    const lastIndex = lines.length - 1;
    const last = (lines[lastIndex] ?? "").trim();
    const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // "<short label>: <url>", or the bare url, as the final line.
    const signOff = new RegExp(`^(?:.{0,40}?:\\s*)?${escaped}$`);

    if (!signOff.test(last)) return text;
    if (last === suffix) return text;
    lines[lastIndex] = suffix;
    combined = lines.join("\n");
  } else {
    combined = `${body}\n\n${suffix}`;
  }

  if ([...combined].length > MAX_COMMENTARY_LENGTH) {
    throw new Error(
      `Adding the profile link (${[...suffix].length} characters) pushes this post to ` +
        `${[...combined].length}, over LinkedIn's ${MAX_COMMENTARY_LENGTH}-character limit. ` +
        "Shorten the body, or clear LINKEDIN_PROFILE_LINK.",
    );
  }
  return combined;
}

export function assertPostLength(text: string): void {
  const length = [...text].length;
  if (length === 0) {
    throw new Error("Post text is empty.");
  }
  if (length > MAX_COMMENTARY_LENGTH) {
    throw new Error(
      `Post is ${length} characters; LinkedIn's limit is ${MAX_COMMENTARY_LENGTH}. Trim it before publishing.`,
    );
  }
}
