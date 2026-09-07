import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import {
  LAYOUT,
  layoutHeading,
  measureBody,
  renderSlidesPdf,
  themeByName,
  type Slide,
} from "./pdf.ts";

/**
 * Turns an article body into the slide deck published as a LinkedIn document
 * post. The source stays plain markdown so a draft is still a file you can read
 * and edit by hand — the split into pages is a rendering concern, not something
 * the author has to think about in a special format.
 *
 * Conventions, both optional:
 *   `---` on its own line  -> explicit page break
 *   `## Heading`           -> starts a page and becomes its headline
 *
 * An article with neither still renders: paragraphs are packed into pages up to
 * a conservative budget, so the worst case is unremarkable pagination rather
 * than a failure.
 */

/**
 * Pages are packed by measured height, not by character count, so a page fills
 * up properly and never overflows the space it has.
 */
function availableHeight(hasHeading: string | undefined, isFirst: boolean): number {
  let top = LAYOUT.top;
  if (hasHeading && !isFirst) top -= LAYOUT.kickerDrop; // continuation kicker
  if (hasHeading && isFirst) top -= layoutHeading(hasHeading, false).height;
  return top - LAYOUT.floor;
}

/**
 * Blocks become paragraphs — except a list, whose items become one paragraph
 * each. Joining them was turning "- one\n- two\n- three" into a single run-on
 * line reading "- one - two - three"; kept apart, the renderer can hang-indent
 * them as an actual list.
 */
const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)])\s+/;

function splitParagraphs(chunk: string): string[] {
  const out: string[] = [];

  for (const block of chunk.split(/\n\s*\n/)) {
    const lines = block
      .split(/\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;

    if (lines.every((line) => LIST_ITEM.test(line))) {
      for (const line of lines) out.push(`• ${line.replace(LIST_ITEM, "")}`);
      continue;
    }

    const joined = lines.join(" ").trim();
    if (joined) out.push(joined);
  }

  return out;
}

/** Strip the markdown we allow in an article body but cannot typeset. */
function plain(text: string): string {
  return text
    // A heading level the slide splitter does not recognise (#### and deeper)
    // would otherwise print its hashes on the page.
    .replace(/^#{1,6}\s+/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\[(.+?)\]\((.+?)\)/g, "$1")
    .trim();
}

function packIntoSlides(heading: string | undefined, paragraphs: string[]): Slide[] {
  const slides: Slide[] = [];
  let current: string[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    slides.push({
      // Only the first page of a section carries the headline; continuation
      // pages repeat it as a kicker so a reader landing mid-deck keeps context.
      ...(slides.length === 0
        ? { heading }
        : heading
          ? { kicker: heading }
          : {}),
      body: current,
    });
    current = [];
  };

  for (const paragraph of paragraphs) {
    const room = availableHeight(heading, slides.length === 0);
    if (current.length > 0 && measureBody([...current, paragraph]) > room) flush();
    current.push(paragraph);
  }
  flush();

  // A section that is nothing but a headline still deserves its page.
  if (slides.length === 0 && heading) slides.push({ heading });
  return slides;
}

export function articleToSlides(input: {
  title: string;
  body: string;
  kicker?: string;
  closing?: string;
}): Slide[] {
  const slides: Slide[] = [
    {
      kicker: input.kicker ?? "Article",
      heading: input.title,
      emphasis: true,
      // ASCII on purpose: WinAnsi has no arrow glyph, and toWinAnsi drops
      // what it cannot encode rather than emitting a broken character.
      footer: "Swipe ->",
    },
  ];

  for (const section of input.body.split(/^\s*---\s*$/m)) {
    if (!section.trim()) continue;

    // A section may open with a heading, and may contain more further down;
    // splitting on every heading keeps one headline per page group.
    for (const part of section.split(/^(?=#{1,3}\s)/m)) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      const headingMatch = trimmed.match(/^#{1,3}\s+(.+)/);
      const heading = headingMatch?.[1] ? plain(headingMatch[1]) : undefined;
      const rest = headingMatch ? trimmed.slice(headingMatch[0].length) : trimmed;

      slides.push(...packIntoSlides(heading, splitParagraphs(rest).map(plain)));
    }
  }

  if (input.closing) {
    slides.push({ heading: input.closing, emphasis: true });
  }

  // The link belongs on the deck as well as the commentary: a carousel gets
  // reshared and screenshotted away from the post text that carried it.
  const link = config.profileLink;
  if (link) {
    const last = slides[slides.length - 1];
    if (last) last.footer = link;
  }

  return slides;
}

/**
 * Render the deck to a PDF beside the draft. Written to disk rather than kept
 * in memory so the exact bytes that will be uploaded can be opened and checked
 * before anything is published.
 */
export function renderArticlePdf(input: {
  id: string;
  title: string;
  body: string;
  kicker?: string;
  closing?: string;
  /** "dark" | "light"; falls back to LINKEDIN_DECK_THEME, then dark. */
  theme?: string;
}): { file: string; bytes: Uint8Array; pages: number } {
  const slides = articleToSlides(input);
  const bytes = renderSlidesPdf(slides, themeByName(input.theme ?? config.deckTheme));

  // Returns bytes rather than writing them: on a deployment the filesystem is
  // read-only, and the caller is the one that knows which store the PDF belongs
  // in. `file` is the storage key it should be written to.
  return { file: `drafts/${input.id}.pdf`, bytes, pages: slides.length };
}
