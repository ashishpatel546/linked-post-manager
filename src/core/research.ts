import dns from "node:dns/promises";
import net from "node:net";

import { config } from "../config.ts";
import { getProvider } from "../providers/index.ts";
import type { Target } from "./targets.ts";

/**
 * Brave Search: web results to ground a draft in, topic ideas from what is
 * being written about right now, and image search with import.
 *
 * Two things this module refuses to do quietly:
 *
 * - It never lets a search snippet into a post verbatim. Results are handed
 *   to the model as *sources*, with the rule that a figure must trace to one
 *   or stay a marker. The point is to stop invented numbers, not to launder
 *   someone else's sentence under your name.
 * - It never attaches an image on its own. Brave's image API returns no
 *   licence metadata at all, so an image it finds is an image you are
 *   responsible for having the rights to. Import is an explicit click, and the
 *   source page is recorded beside the file so that question can be answered
 *   later.
 */

const WEB = "https://api.search.brave.com/res/v1/web/search";
const IMAGES = "https://api.search.brave.com/res/v1/images/search";

export type WebResult = { title: string; url: string; description: string; age?: string };
export type ImageResult = {
  title: string;
  /** The image itself. */
  url: string;
  thumbnail?: string;
  /** The page it was found on — where the licence question gets answered. */
  page: string;
  source?: string;
  width?: number;
  height?: number;
};

export function researchStatus(): { configured: boolean; reason?: string } {
  return config.braveApiKey
    ? { configured: true }
    : { configured: false, reason: "BRAVE_API_KEY is not set in .env." };
}

function requireKey(): string {
  if (!config.braveApiKey) {
    throw new Error(
      "Research needs BRAVE_API_KEY in .env. Get a free key at https://api-dashboard.search.brave.com.",
    );
  }
  return config.braveApiKey;
}

async function brave<T>(endpoint: string, params: Record<string, string>): Promise<T> {
  const url = new URL(endpoint);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": requireKey(),
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (response.status === 429) {
    throw new Error("Brave Search rate limit hit. The free tier is one request per second — wait a moment and retry.");
  }
  if (!response.ok) {
    throw new Error(`Brave Search returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return (await response.json()) as T;
}

export async function searchWeb(query: string, count = 8): Promise<WebResult[]> {
  type Raw = {
    web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string }> };
  };
  const data = await brave<Raw>(WEB, {
    q: query,
    count: String(Math.min(Math.max(count, 1), 20)),
    text_decorations: "false",
  });
  return (data.web?.results ?? [])
    .filter((r): r is Required<Pick<typeof r, "title" | "url">> & typeof r => !!r.title && !!r.url)
    .map((r) => ({
      title: r.title,
      url: r.url,
      description: (r.description ?? "").replace(/<[^>]+>/g, ""),
      ...(r.age ? { age: r.age } : {}),
    }));
}

export async function searchImages(query: string, count = 12): Promise<ImageResult[]> {
  type Raw = {
    results?: Array<{
      title?: string;
      url?: string;
      source?: string;
      thumbnail?: { src?: string };
      properties?: { url?: string; placeholder?: string };
      // Some responses carry dimensions here; treated as optional.
      width?: number;
      height?: number;
    }>;
  };
  const data = await brave<Raw>(IMAGES, {
    q: query,
    count: String(Math.min(Math.max(count, 1), 50)),
    safesearch: "strict",
  });
  return (data.results ?? [])
    .map((r) => ({
      title: r.title ?? "",
      url: r.properties?.url ?? "",
      thumbnail: r.thumbnail?.src ?? r.properties?.placeholder,
      page: r.url ?? "",
      source: r.source,
      width: r.width,
      height: r.height,
    }))
    .filter((r) => r.url.startsWith("http") && r.page.startsWith("http"));
}

export type TopicSuggestion = {
  title: string;
  angle: string;
  /** How this departs from what the search results already say. */
  differs?: string;
  /** Indices into the `sources` array returned alongside. */
  sources: number[];
};

/** Content words, for the "is this just the headline again?" check. */
const STOP = new Set(
  "a an and are as at be but by for from how in is it its of on or so that the this to vs was what when where which why with you your".split(" "),
);

function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOP.has(word)),
  );
}

/** Jaccard-ish overlap: shared content words over the shorter of the two. */
function overlap(a: string, b: string): number {
  const left = keywords(a);
  const right = keywords(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

/**
 * Searches around a seed and asks the model for post ideas grounded in what
 * came back. The model sees titles and snippets only — enough to spot an
 * angle, not enough to plagiarise a paragraph.
 *
 * The results are treated as *what has already been published*, not as a menu
 * to pick from. Restating a headline that is already on the first page of a
 * search is the one outcome this is meant to avoid: it adds nothing, and it
 * reads as a summary of someone else's article. So the model is asked what the
 * coverage has in common and what it leaves out, and anything that comes back
 * still looking like one of the headlines is dropped here rather than shown.
 */
export async function suggestTopics(input: {
  seed: string;
  target: Target;
  provider?: string;
  model?: string;
  count?: number;
  /** Topics already drafted or published, so ideas do not repeat your own work. */
  avoid?: string[];
}): Promise<{ topics: TopicSuggestion[]; sources: WebResult[]; dropped: number }> {
  // A wider net than the 8 used for grounding a draft: judging what is already
  // saturated needs more than the top handful.
  const sources = await searchWeb(input.seed, 15);
  if (sources.length === 0) return { topics: [], sources, dropped: 0 };

  const provider = getProvider(input.provider);
  const list = sources
    .map((s, i) => `[${i + 1}] ${s.title}${s.age ? ` (${s.age})` : ""}\n    ${s.description}\n    ${s.url}`)
    .join("\n\n");

  const avoid = (input.avoid ?? []).filter(Boolean).slice(0, 30);

  const raw = await provider.complete(
    [
      {
        role: "system",
        content:
          `You suggest LinkedIn post topics for ${input.target === "company" ? "a software company's page" : "an individual engineer's profile"}.\n\n` +
          "The search results you are given are what ALREADY EXISTS on this subject. They are evidence about the conversation, not a list to choose from. " +
          "Read them as a set first: what does nearly every one of them say, what do they disagree on, what does none of them address, and what would a practitioner who has actually done this work find missing or wrong?\n\n" +
          "Rules:\n" +
          "- Never restate a result's headline. If a suggestion could be the title of one of the listed pages, it is worthless — the reader can already read that page.\n" +
          "- Every suggestion must go somewhere the coverage does not: a counter-argument to the consensus, the tradeoff the articles skip, the failure mode nobody writes about, the practitioner's view under a vendor announcement, or two results put together to make a point neither makes alone.\n" +
          "- Ground it anyway. Cite the results the idea reacts to, and never assert a fact the snippets do not support.\n\n" +
          "Output ONLY a JSON array, no prose, no code fence. Each item: " +
          '{"title": "<6-12 word post idea>", "angle": "<one sentence: the specific, arguable take>", "differs": "<one sentence: what the existing coverage says, and how this departs from it>", "sources": [<1-based indices of the results it reacts to>]}. ' +
          `Produce ${input.count ?? 6} items.`,
      },
      {
        role: "user",
        content: [
          `Seed: ${input.seed}`,
          avoid.length
            ? `Already written by this author — do not suggest these again, or minor rewordings of them:\n${avoid.map((t) => `- ${t}`).join("\n")}`
            : "",
          `Search results (existing coverage):\n\n${list}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
    { model: input.model },
  );

  const json = raw.replace(/^```[a-z]*\n?|\n?```$/g, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`The model did not return JSON for topic suggestions. First bytes: ${raw.slice(0, 160)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("Topic suggestions were not a JSON array.");

  const all: TopicSuggestion[] = parsed
    .filter((t): t is { title: string; angle?: string; differs?: string; sources?: unknown } => !!t && typeof t === "object" && typeof (t as { title?: unknown }).title === "string")
    .map((t) => ({
      title: t.title,
      angle: typeof t.angle === "string" ? t.angle : "",
      ...(typeof t.differs === "string" && t.differs ? { differs: t.differs } : {}),
      sources: Array.isArray(t.sources)
        ? t.sources.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= sources.length).map((n) => n - 1)
        : [],
    }));

  // The instruction not to echo a headline is not self-enforcing — smaller
  // models in particular hand back a lightly reworded title. 0.7 of the shared
  // content words is close enough to be the same post.
  const titles = sources.map((s) => s.title);
  const kept = all.filter(
    (topic) =>
      !titles.some((title) => overlap(topic.title, title) >= 0.7) &&
      !avoid.some((written) => overlap(topic.title, written) >= 0.7),
  );

  return { topics: kept, sources, dropped: all.length - kept.length };
}

// -------------------------------------------------------------- image import --

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Magic bytes, not the Content-Type header: a server can say `image/png` about
 * anything, and what we upload to LinkedIn must actually be an image.
 */
function sniffImage(bytes: Uint8Array): ".png" | ".jpg" | ".gif" | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return ".png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
  if (bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return ".gif";
  return null;
}

function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") || v6.startsWith("::ffff:");
}

/**
 * Fetches an image for ingestion. The server holds credentials and sits on a
 * network, so a URL supplied from the browser is treated as hostile: only
 * http(s), and never a hostname that resolves to a loopback, link-local, or
 * private range — the classic way an image fetcher becomes a port scanner for
 * whatever is behind it.
 */
export async function fetchImageForImport(
  rawUrl: string,
): Promise<{ bytes: Uint8Array; extension: string; finalUrl: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http(s) image URLs can be imported, not ${url.protocol}`);
  }

  const host = url.hostname;
  if (host === "localhost" || net.isIP(host) ? isPrivateAddress(host) : false) {
    throw new Error("Refusing to fetch from a local or private address.");
  }
  if (!net.isIP(host)) {
    const addresses = await dns.lookup(host, { all: true }).catch(() => []);
    if (addresses.length === 0) throw new Error(`Could not resolve ${host}.`);
    if (addresses.some((a) => isPrivateAddress(a.address))) {
      throw new Error(`${host} resolves to a private address; refusing to fetch it.`);
    }
  }

  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
    headers: { Accept: "image/*", "User-Agent": "linkedin-agent/0.1 (image import)" },
  });
  if (!response.ok) throw new Error(`Image fetch failed: ${response.status} from ${host}`);

  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_IMAGE_BYTES) throw new Error("Image is over LinkedIn's 10 MB limit.");

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Image is over LinkedIn's 10 MB limit.");

  const extension = sniffImage(bytes);
  if (!extension) throw new Error("The URL did not return a PNG, JPEG or GIF.");

  return { bytes, extension, finalUrl: response.url || url.toString() };
}
