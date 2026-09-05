/**
 * A minimal PDF writer, built for one job: turning an article into the page
 * deck LinkedIn renders as a swipeable document post.
 *
 * Why hand-rolled rather than a headless browser? The alternative is Playwright
 * plus a browser download — hundreds of megabytes, and a second runtime to keep
 * alive — to typeset large text on flat backgrounds. That is the whole job. The
 * PDF format's core-14 fonts cover it without embedding a single byte of font
 * data, so this file has no dependencies, in keeping with the rest of the repo.
 *
 * Deliberately not supported: images, hyphenation, bidi text, and any glyph
 * outside WinAnsi. `toWinAnsi` folds the typographic punctuation we actually
 * emit (em dashes, curly quotes) and drops the rest rather than writing bytes
 * that would render as mojibake.
 */

/** Helvetica advance widths, 1/1000 em, WinAnsi printable range. */
const HELVETICA: Record<string, number> = {
  " ": 278, "!": 278, '"': 355, "#": 556, $: 556, "%": 889, "&": 667, "'": 191,
  "(": 333, ")": 333, "*": 389, "+": 584, ",": 278, "-": 333, ".": 278, "/": 278,
  "0": 556, "1": 556, "2": 556, "3": 556, "4": 556, "5": 556, "6": 556, "7": 556,
  "8": 556, "9": 556, ":": 278, ";": 278, "<": 584, "=": 584, ">": 584, "?": 556,
  "@": 1015, A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722,
  I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722,
  S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611, "[": 278,
  "\\": 278, "]": 278, "^": 469, _: 556, "`": 333, a: 556, b: 556, c: 500,
  d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222,
  m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556,
  v: 500, w: 722, x: 500, y: 500, z: 500, "{": 334, "|": 260, "}": 334, "~": 584,
};

/** Helvetica-Bold advance widths, same units. */
const HELVETICA_BOLD: Record<string, number> = {
  " ": 278, "!": 333, '"': 474, "#": 556, $: 556, "%": 889, "&": 722, "'": 238,
  "(": 333, ")": 333, "*": 389, "+": 584, ",": 278, "-": 333, ".": 278, "/": 278,
  "0": 556, "1": 556, "2": 556, "3": 556, "4": 556, "5": 556, "6": 556, "7": 556,
  "8": 556, "9": 556, ":": 333, ";": 333, "<": 584, "=": 584, ">": 584, "?": 611,
  "@": 975, A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722,
  I: 278, J: 556, K: 722, L: 611, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722,
  S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611, "[": 333,
  "\\": 278, "]": 333, "^": 584, _: 556, "`": 333, a: 556, b: 611, c: 556,
  d: 611, e: 556, f: 333, g: 611, h: 611, i: 278, j: 278, k: 556, l: 278,
  m: 889, n: 611, o: 611, p: 611, q: 611, r: 389, s: 556, t: 333, u: 611,
  v: 556, w: 778, x: 556, y: 556, z: 500, "{": 389, "|": 280, "}": 389, "~": 584,
};

/**
 * Typographic characters we emit on purpose, mapped to their WinAnsi byte.
 * Anything else outside printable ASCII is dropped by `toWinAnsi`.
 */
const WIN_ANSI: Record<string, string> = {
  "—": "\x97", // em dash
  "–": "\x96", // en dash
  "‘": "\x91",
  "’": "\x92",
  "“": "\x93",
  "”": "\x94",
  "…": "\x85", // ellipsis
  "•": "\x95", // bullet
  " ": " ",
};

function toWinAnsi(text: string): string {
  let out = "";
  for (const char of text) {
    const mapped = WIN_ANSI[char];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e) out += char;
    // Everything else is dropped rather than emitted as a broken glyph.
  }
  return out;
}

export type FontWeight = "regular" | "bold";

function widthOf(text: string, size: number, weight: FontWeight): number {
  const table = weight === "bold" ? HELVETICA_BOLD : HELVETICA;
  let units = 0;
  for (const char of text) units += table[char] ?? 556;
  return (units / 1000) * size;
}

/**
 * Greedy wrap. A single word longer than the line is left to overflow rather
 * than hard-split: in practice that only happens with a URL, where a broken
 * word would be worse than a slightly wide line.
 */
export function wrapText(
  text: string,
  size: number,
  weight: FontWeight,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  let line = "";

  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && widthOf(candidate, size, weight) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export type Rgb = [number, number, number];

export type PdfTheme = {
  background: Rgb;
  heading: Rgb;
  body: Rgb;
  muted: Rgb;
  accent: Rgb;
};

export const DARK_THEME: PdfTheme = {
  background: [0.043, 0.055, 0.075],
  heading: [0.929, 0.937, 0.949],
  body: [0.784, 0.812, 0.855],
  muted: [0.49, 0.525, 0.596],
  accent: [0.549, 0.667, 0.961],
};

export type Slide = {
  /** Small uppercase label above the heading. */
  kicker?: string;
  heading?: string;
  /** Paragraphs; blank space is inserted between them. */
  body?: string[];
  /** Bottom-left note, e.g. a page marker or call to action. */
  footer?: string;
  /** Renders the heading in accent colour — used for the cover and outro. */
  emphasis?: boolean;
};

const PAGE = 720; // square, matching how LinkedIn crops document posts
const MARGIN = 64;
const CONTENT = PAGE - MARGIN * 2;

/**
 * Layout metrics, exported so pagination can measure a page instead of
 * guessing at it. Packing by character count either wastes half a page or
 * overflows it, and overflow used to be dropped silently.
 */
export const LAYOUT = {
  page: PAGE,
  margin: MARGIN,
  content: CONTENT,
  top: PAGE - MARGIN - 18,
  /** Text below this would collide with the footer row. */
  floor: MARGIN + 60,
  bodySize: 21,
  bodyLeading: 21 * 1.5,
  kickerDrop: 42,
  headingGap: 26,
  paragraphGap: 16,
} as const;

/**
 * Choose a heading size that fits in at most four lines, stepping down from the
 * base size. Shared so pagination and rendering agree on the height consumed.
 */
export function layoutHeading(
  heading: string,
  emphasis: boolean,
): { lines: string[]; size: number; height: number } {
  let size = emphasis ? 48 : 40;
  let lines = wrapText(heading, size, "bold", CONTENT);
  while (lines.length > 4 && size > 24) {
    size -= 3;
    lines = wrapText(heading, size, "bold", CONTENT);
  }
  return { lines, size, height: lines.length * size * 1.16 + LAYOUT.headingGap };
}

/** Vertical space a set of paragraphs needs at body size. */
export function measureBody(paragraphs: string[]): number {
  let height = 0;
  for (const paragraph of paragraphs) {
    const lines = wrapText(paragraph, LAYOUT.bodySize, "regular", CONTENT);
    height += lines.length * LAYOUT.bodyLeading + LAYOUT.paragraphGap;
  }
  return height;
}

function esc(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function color(rgb: Rgb): string {
  return `${rgb[0].toFixed(3)} ${rgb[1].toFixed(3)} ${rgb[2].toFixed(3)}`;
}

function textOp(
  text: string,
  x: number,
  y: number,
  size: number,
  weight: FontWeight,
  rgb: Rgb,
  charSpace = 0,
): string {
  const font = weight === "bold" ? "/F2" : "/F1";
  return [
    "BT",
    `${color(rgb)} rg`,
    `${font} ${size} Tf`,
    charSpace ? `${charSpace.toFixed(2)} Tc` : "0 Tc",
    `1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm`,
    `(${esc(toWinAnsi(text))}) Tj`,
    "ET",
  ].join("\n");
}

/**
 * Lay out one slide. Text flows from the top down; the heading is sized to fit
 * the space actually left over after the body, so a dense page shrinks its
 * headline instead of colliding with the text below it.
 */
function renderSlide(slide: Slide, theme: PdfTheme, pageNumber: number, total: number): string {
  const ops: string[] = [`${color(theme.background)} rg`, `0 0 ${PAGE} ${PAGE} re f`];

  let y = PAGE - MARGIN - 18;

  if (slide.kicker) {
    ops.push(textOp(slide.kicker.toUpperCase(), MARGIN, y, 13, "bold", theme.muted, 2.2));
    y -= 42;
  }

  if (slide.heading) {
    const { lines, size } = layoutHeading(slide.heading, slide.emphasis ?? false);
    const leading = size * 1.16;
    for (const line of lines) {
      ops.push(
        textOp(line, MARGIN, y - size, size, "bold", slide.emphasis ? theme.accent : theme.heading),
      );
      y -= leading;
    }
    y -= LAYOUT.headingGap;
  }

  // Pagination guarantees this fits, so nothing is dropped here. If a caller
  // hands over more than a page holds, it runs past the floor visibly rather
  // than disappearing — a layout bug you can see beats one you cannot.
  for (const paragraph of slide.body ?? []) {
    for (const line of wrapText(paragraph, LAYOUT.bodySize, "regular", CONTENT)) {
      ops.push(textOp(line, MARGIN, y - LAYOUT.bodySize, LAYOUT.bodySize, "regular", theme.body));
      y -= LAYOUT.bodyLeading;
    }
    y -= LAYOUT.paragraphGap;
  }

  if (slide.footer) {
    ops.push(textOp(slide.footer, MARGIN, MARGIN, 15, "bold", theme.accent));
  }

  const marker = `${pageNumber} / ${total}`;
  const markerWidth = widthOf(marker, 13, "regular");
  ops.push(textOp(marker, PAGE - MARGIN - markerWidth, MARGIN, 13, "regular", theme.muted));

  return ops.join("\n");
}

/**
 * Assemble the file. Object numbering: 1 catalog, 2 page tree, 3 and 4 the two
 * fonts, then a page object and a content stream per slide.
 */
export function renderSlidesPdf(slides: Slide[], theme: PdfTheme = DARK_THEME): Uint8Array {
  if (slides.length === 0) throw new Error("Cannot render a PDF with no slides.");

  const objects: string[] = [];
  const pageIds = slides.map((_, index) => 5 + index * 2);

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] =
    `<< /Type /Pages /Count ${slides.length} ` +
    `/Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`;
  objects[3] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";

  slides.forEach((slide, index) => {
    const pageId = pageIds[index] as number;
    const streamId = pageId + 1;
    const content = renderSlide(slide, theme, index + 1, slides.length);

    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE} ${PAGE}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamId} 0 R >>`;
    objects[streamId] = `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
  });

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];

  for (let id = 1; id < objects.length; id += 1) {
    const body = objects[id];
    if (body === undefined) continue;
    offsets[id] = Buffer.byteLength(pdf, "latin1");
    pdf += `${id} 0 obj\n${body}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  const count = objects.length;

  pdf += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id += 1) {
    const offset = offsets[id] ?? 0;
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(pdf, "latin1"));
}
