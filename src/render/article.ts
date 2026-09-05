import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import {
  DARK_THEME,
  LAYOUT,
  layoutHeading,
  measureBody,
  renderSlidesPdf,
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

function splitParagraphs(chunk: string): string[] {
  return chunk
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);
}

/** Strip the markdown we allow in an article body but cannot typeset. */
function plain(text: string): string {
  return text
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
}): { file: string; absolutePath: string; pages: number } {
  const slides = articleToSlides(input);
  const bytes = renderSlidesPdf(slides, DARK_THEME);

  fs.mkdirSync(config.draftsDir, { recursive: true });
  const absolutePath = path.join(config.draftsDir, `${input.id}.pdf`);
  fs.writeFileSync(absolutePath, bytes);

  return { file: `drafts/${input.id}.pdf`, absolutePath, pages: slides.length };
}
