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

/** White page, LinkedIn blue accent — reads as a native LinkedIn document. */
export const LIGHT_THEME: PdfTheme = {
  background: [1, 1, 1],
  heading: [0.09, 0.1, 0.12],
  body: [0.24, 0.26, 0.3],
  muted: [0.52, 0.55, 0.6],
  accent: [0.039, 0.4, 0.761],
};

export type ThemeName = "dark" | "light";

export function themeByName(name: string | undefined): PdfTheme {
  return name === "light" ? LIGHT_THEME : DARK_THEME;
}

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
  /**
   * The *smallest* body size, and the one pagination measures with — so a page
   * packed at this size can only ever end up with room to spare, never overflow.
   */
  bodySize: 21,
  /**
   * The largest. A slide carrying two short paragraphs was being typeset at the
   * same 21pt as a full one, leaving two thirds of a 720pt page empty and
   * reading as a blank slide. Type on a carousel is furniture: it should grow
   * to fill the page it is on.
   */
  maxBodySize: 32,
  /**
   * Ceiling for a page carrying a single short paragraph. Some sections really
   * are one sentence, and at 32pt one sentence still leaves half a page of
   * nothing. Set as a statement it reads as a designed pause in the deck
   * instead of a slide someone forgot to finish.
   */
  statementSize: 46,
  bodyLeading: 21 * 1.5,
  kickerDrop: 42,
  headingGap: 26,
  paragraphGap: 16,
} as const;

/** Leading and inter-paragraph space scale with the type, not with 21pt. */
function leadingFor(size: number): number {
  return size * 1.5;
}
function gapFor(size: number): number {
  return size * 0.76;
}

/**
 * List items arrive as paragraphs marked with a bullet. They are laid out with
 * a hanging indent — wrapped lines align under the text, not under the bullet —
 * which is the difference between a list and a paragraph that starts with a dot.
 */
const BULLET = "•";
const BULLET_PATTERN = /^[-*•]\s+/;

function paragraphLines(
  text: string,
  size: number,
): { bullet: boolean; indent: number; lines: string[] } {
  const bullet = BULLET_PATTERN.test(text);
  const content = bullet ? text.replace(BULLET_PATTERN, "") : text;
  const indent = bullet ? widthOf(`${BULLET}  `, size, "regular") : 0;
  return { bullet, indent, lines: wrapText(content, size, "regular", CONTENT - indent) };
}

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

/** Vertical space a set of paragraphs needs, at a given body size. */
export function measureBody(paragraphs: string[], size: number = LAYOUT.bodySize): number {
  let height = 0;
  for (const paragraph of paragraphs) {
    const { lines } = paragraphLines(paragraph, size);
    height += lines.length * leadingFor(size) + gapFor(size);
  }
  return height;
}

/**
 * The largest body size at which this page's text still fits the room it has.
 * Pagination has already guaranteed it fits at `bodySize`, so this only ever
 * scales up — a page can gain type, never lose it.
 */
export function fitBodySize(
  paragraphs: string[],
  room: number,
  ceiling: number = LAYOUT.maxBodySize,
): number {
  let best: number = LAYOUT.bodySize;
  for (let size = LAYOUT.bodySize + 1; size <= ceiling; size += 1) {
    if (measureBody(paragraphs, size) > room) break;
    best = size;
  }
  return best;
}

/**
 * A page whose whole body is one short paragraph. Not a length check on the
 * rendered height — a long single paragraph fills its page perfectly well; it
 * is specifically the one-line section that needs different treatment.
 */
export function isStatement(paragraphs: string[]): boolean {
  const [only] = paragraphs;
  if (paragraphs.length !== 1 || only === undefined) return false;
  if (BULLET_PATTERN.test(only)) return false;
  return only.split(/\s+/).filter(Boolean).length <= 34;
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

function rectOp(x: number, y: number, w: number, h: number, rgb: Rgb): string {
  return `${color(rgb)} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`;
}

/** Four Bézier arcs; 0.5523 is the standard circle approximation constant. */
function circleOp(cx: number, cy: number, r: number, rgb: Rgb): string {
  const k = 0.5523 * r;
  const f = (n: number) => n.toFixed(2);
  return [
    `${color(rgb)} rg`,
    `${f(cx + r)} ${f(cy)} m`,
    `${f(cx + r)} ${f(cy + k)} ${f(cx + k)} ${f(cy + r)} ${f(cx)} ${f(cy + r)} c`,
    `${f(cx - k)} ${f(cy + r)} ${f(cx - r)} ${f(cy + k)} ${f(cx - r)} ${f(cy)} c`,
    `${f(cx - r)} ${f(cy - k)} ${f(cx - k)} ${f(cy - r)} ${f(cx)} ${f(cy - r)} c`,
    `${f(cx + k)} ${f(cy - r)} ${f(cx + r)} ${f(cy - k)} ${f(cx + r)} ${f(cy)} c`,
    "f",
  ].join("\n");
}

/** A dimmed accent for secondary marks, mixed toward the background. */
function dim(theme: PdfTheme, amount = 0.55): Rgb {
  const mix = (a: number, b: number) => a + (b - a) * amount;
  return [
    mix(theme.accent[0], theme.background[0]),
    mix(theme.accent[1], theme.background[1]),
    mix(theme.accent[2], theme.background[2]),
  ];
}

/**
 * Lay out one slide. Text flows from the top down; the heading is sized to fit
 * the space actually left over after the body, so a dense page shrinks its
 * headline instead of colliding with the text below it.
 *
 * The furniture — accent bar on the cover, rule under a heading, progress dots,
 * section number — is what separates "a PDF of text" from something that reads
 * as designed. All of it is vector: rectangles and Bézier circles, so the file
 * stays a few kilobytes and embeds no fonts or images.
 */
function renderSlide(slide: Slide, theme: PdfTheme, pageNumber: number, total: number): string {
  const ops: string[] = [rectOp(0, 0, PAGE, PAGE, theme.background)];

  // Cover and outro: a full-height accent bar down the left edge, and the
  // heading sits lower so the page reads as a title card, not a text page.
  if (slide.emphasis) {
    ops.push(rectOp(0, 0, 14, PAGE, theme.accent));
  }

  // ---- measure, then draw -------------------------------------------------
  // The size of the body type and where the block starts both depend on how
  // much text there is, so nothing can be drawn until all of it is known.
  const body = slide.body ?? [];
  const kickerHeight = slide.kicker ? LAYOUT.kickerDrop : 0;
  const headingHeight = slide.heading
    ? layoutHeading(slide.heading, slide.emphasis ?? false).height
    : 0;
  const statement = isStatement(body);
  const room = LAYOUT.top - LAYOUT.floor - kickerHeight - headingHeight;
  const bodySize =
    body.length > 0
      ? fitBodySize(body, room, statement ? LAYOUT.statementSize : LAYOUT.maxBodySize)
      : LAYOUT.bodySize;
  const slack = body.length > 0 ? Math.max(0, room - measureBody(body, bodySize)) : 0;

  let y = PAGE - MARGIN - 18;

  // Nudge a light page down rather than leaving all the air at the bottom.
  // A statement page centres properly; an ordinary one only drifts a little,
  // because a heading that floats to the middle stops looking like a heading.
  if (body.length > 0) y -= statement ? slack * 0.45 : Math.min(slack * 0.4, 72);

  if (slide.kicker) {
    ops.push(textOp(slide.kicker.toUpperCase(), MARGIN, y, 13, "bold", theme.accent, 2.2));
    y -= 42;
  }

  // Section number, top right, on ordinary content pages only. Pages 2..n-1
  // when there is an outro, 2..n otherwise.
  if (!slide.emphasis && total > 1) {
    const n = String(pageNumber - 1).padStart(2, "0");
    const w = widthOf(n, 40, "bold");
    ops.push(textOp(n, PAGE - MARGIN - w, PAGE - MARGIN - 40, 40, "bold", dim(theme, 0.7)));
  }

  if (slide.heading) {
    const { lines, size } = layoutHeading(slide.heading, slide.emphasis ?? false);
    const leading = size * 1.16;

    // Title cards centre the heading block vertically so a short title does
    // not float at the top of an otherwise empty page.
    if (slide.emphasis && !slide.body?.length) {
      const block = lines.length * leading;
      y = PAGE / 2 + block / 2 + 10;
    }

    for (const line of lines) {
      ops.push(
        textOp(line, MARGIN, y - size, size, "bold", slide.emphasis ? theme.accent : theme.heading),
      );
      y -= leading;
    }

    // A short rule under a content heading anchors the eye; it is the single
    // most effective mark for making a slide look intentional.
    if (!slide.emphasis) {
      y -= 8;
      ops.push(rectOp(MARGIN, y, 56, 3, theme.accent));
      y -= LAYOUT.headingGap - 8;
    } else {
      y -= LAYOUT.headingGap;
    }
  }

  // Pagination guarantees this fits, so nothing is dropped here. If a caller
  // hands over more than a page holds, it runs past the floor visibly rather
  // than disappearing — a layout bug you can see beats one you cannot.
  for (const paragraph of body) {
    const { bullet, indent, lines } = paragraphLines(paragraph, bodySize);
    lines.forEach((line, index) => {
      if (bullet && index === 0) {
        ops.push(textOp(BULLET, MARGIN, y - bodySize, bodySize, "regular", theme.accent));
      }
      // A statement is the page, so it carries the heading's weight of colour
      // rather than body grey.
      ops.push(
        textOp(line, MARGIN + indent, y - bodySize, bodySize, "regular", statement ? theme.heading : theme.body),
      );
      y -= leadingFor(bodySize);
    });
    y -= gapFor(bodySize);
  }

  // Footer row: note left, progress dots centre, page marker right.
  if (slide.footer) {
    ops.push(textOp(slide.footer, MARGIN, MARGIN, 15, "bold", theme.accent));
  }

  if (total > 1 && total <= 24) {
    const gap = 12;
    const r = 3.2;
    const width = total * gap;
    let x = PAGE / 2 - width / 2 + gap / 2;
    for (let i = 1; i <= total; i += 1) {
      ops.push(circleOp(x, MARGIN + 5, i === pageNumber ? r + 0.8 : r, i === pageNumber ? theme.accent : dim(theme)));
      x += gap;
    }
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
