import { getProvider } from "../providers/index.ts";
import type { ChatMessage } from "../providers/types.ts";
import { MAX_COMMENTARY_LENGTH } from "../linkedin/text.ts";
import { articleAsPostText } from "./drafts.ts";
import type { Target } from "./targets.ts";

/**
 * How much there should be of it. One control over both formats: for a post it
 * sets the character budget, for a deck it sets how many slides and how much
 * goes on each. "standard" is what an unset value means everywhere.
 */
export type Depth = "brief" | "standard" | "deep";

export function asDepth(value: unknown): Depth | undefined {
  return value === "brief" || value === "standard" || value === "deep" ? value : undefined;
}

/** Character budget for a plain post, by depth. */
const POST_LENGTH: Record<Depth, number> = { brief: 500, standard: 900, deep: 1800 };

/**
 * Deck shape, by depth. The word counts are the reason a deck stops looking
 * empty: a 720pt page holds roughly 130 words at the smallest body size, and
 * asking for "about 60" was filling barely half of one.
 */
const DECK_SHAPE: Record<Depth, { sections: string; words: string }> = {
  brief: { sections: "4 to 6", words: "60 to 90" },
  standard: { sections: "6 to 9", words: "90 to 130" },
  deep: { sections: "10 to 14", words: "110 to 150" },
};

/**
 * A long-text article is a *post*, so it lives under LinkedIn's 3,000-character
 * cap — where a deck has no such limit, because each section gets its own page.
 * The two therefore cannot share a shape: asking for deck-sized sections here
 * produced 3,800 characters that could not be saved, let alone published.
 *
 * The budgets leave room for the author link appended at publish time (~60
 * characters) and a little slack for a model that overshoots.
 */
const LONG_TEXT_LENGTH: Record<Depth, number> = { brief: 1200, standard: 1900, deep: 2500 };

/**
 * A manual article is pasted into LinkedIn's own editor, which has no
 * meaningful limit — so this is the one path measured in words rather than
 * characters, and the only one where "in-depth" means what it says.
 */
const ARTICLE_WORDS: Record<Depth, string> = {
  brief: "600 to 800",
  standard: "1000 to 1400",
  deep: "1800 to 2500",
};

export type ComposeInput = {
  topic: string;
  target: Target;
  /** Provider id; falls back to DRAFT_PROVIDER in .env. */
  provider?: string;
  /** Model within that provider; falls back to the provider's configured one. */
  model?: string;
  /** Freeform steer: "make it punchy", "mention the pilot in Pune". */
  instructions?: string;
  /** How much to write. Overrides targetLength for posts when both are given. */
  depth?: Depth;
  /**
   * For an article: where the prose is going. A deck has no length limit —
   * each section gets a page — long text is a post and is capped at 3,000
   * characters by the API, and a manual article is bound by neither because
   * it is pasted into LinkedIn's own editor by hand. One request, three shapes.
   */
  mode?: "carousel" | "text" | "manual";
  /** Rough length to aim for, in characters. */
  targetLength?: number;
  /**
   * Research to ground the draft in. The model may use a figure only if it
   * appears here; anything else stays a [NUMBER: …] marker for the author.
   */
  sources?: Array<{ title: string; url: string; description: string }>;
};

/**
 * Sources are rendered as numbered snippets, with the rule attached right
 * there rather than buried in the house style: it is the part of the prompt
 * the model is most tempted to bend, so it sits next to the material.
 */
export function sourcesBlock(sources: ComposeInput["sources"]): string {
  if (!sources || sources.length === 0) return "";
  const list = sources
    .map((s, i) => `[${i + 1}] ${s.title}\n${s.description}\nSource: ${s.url}`)
    .join("\n\n");
  return (
    `Research you may draw on. Rules: a number, name, or claim may appear in the post ONLY if one of these sources says it — and then cite it inline as [1], [2]. ` +
    `Do not copy a sentence from a source; say it in your own words. Anything you want to state that is not supported here stays a [NUMBER: …] or [FACT: …] marker.\n\n${list}`
  );
}

export type ComposeResult = {
  text: string;
  provider: string;
  characterCount: number;
  /** True when the model overshot the cap and the text was cut to fit. */
  shortened?: boolean;
};

const HOUSE_STYLE = `You write LinkedIn posts. Follow these rules exactly:

- Output ONLY the post text. No preamble, no explanation, no surrounding quotes,
  no "Here's a draft:".
- LinkedIn renders plain text. Never use markdown: no **bold**, no ##headings,
  no bullet characters like * or -. Use line breaks and, if a list is genuinely
  needed, short lines each starting with a plain word.
- Open with something concrete. No "I'm thrilled to announce", "humbled to
  share", "game-changer", "in today's fast-paced world".
- NEVER INVENT FACTS. Do not make up statistics, percentages, customer names,
  project sizes, dates, timelines, or outcomes. You do not know them. Writing
  "support tickets fell 30%" when nobody told you that is fabrication, and it
  will be published under a real person's name.
- Do not invent personal anecdotes either. No "last week I met a customer who",
  no "I spent a month testing this", unless the instructions actually say so. You
  do not know what the author did.
- Use only what appears in the topic and instructions. Where a specific figure
  would strengthen the post but you have not been given one, write a marker like
  [NUMBER: tickets deflected] or [CUSTOMER NAME] and leave it for the author to
  fill in. A post with visible gaps is fine; an invented number is not.
- Specifics beat adjectives — but only real ones. With no facts to hand, write
  about the mechanism, the tradeoff, or the reason something matters, rather than
  inflating it with numbers you cannot support.
- Short paragraphs, one to three sentences each, separated by a blank line.
- At most three hashtags, at the very end, and only if they are genuinely useful.
- No emoji unless the instructions ask for them.
- End with something a reader can respond to: a question, an invitation, or a
  clear next step. Not every post needs a call to action; do not force one.`;

function audienceRule(target: Target): string {
  return target === "company"
    ? `This post goes out from a company page. Write in the first person plural
("we", "our team"). Never write as an individual. Keep it professional but not
corporate-bland — the reader should still hear a human.`
    : `This post goes out from a personal profile. Write in the first person
singular ("I", "my"). It should read like the person actually talking, not a
press release.`;
}

export function buildMessages(input: ComposeInput): ChatMessage[] {
  // An explicit depth wins: it is a choice made in the UI for this request,
  // where targetLength is usually just the default that came with the caller.
  const length = input.depth ? POST_LENGTH[input.depth] : (input.targetLength ?? 900);
  const user = [
    `Topic: ${input.topic}`,
    input.instructions ? `Additional instructions: ${input.instructions}` : "",
    sourcesBlock(input.sources),
    `Aim for roughly ${length} characters. The hard maximum is ${MAX_COMMENTARY_LENGTH}.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    { role: "system", content: `${HOUSE_STYLE}\n\n${audienceRule(input.target)}` },
    { role: "user", content: user },
  ];
}

/** Strips wrappers a model may add despite being told not to. */
function clean(text: string): string {
  let out = text.trim();

  // Reasoning models (Qwen, DeepSeek-R1 and friends) emit their scratchpad
  // before the answer. It must never reach a post.
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  // An unterminated block means the model ran out of budget mid-thought.
  if (/^<think>/i.test(out)) {
    throw new Error(
      "The model returned only reasoning and no post text — it likely hit its token limit. Try a larger model or a shorter topic.",
    );
  }

  const fence = out.match(/^```[a-z]*\n([\s\S]*?)\n```$/);
  if (fence?.[1]) out = fence[1].trim();

  if (out.length > 1 && out.startsWith('"') && out.endsWith('"')) {
    out = out.slice(1, -1).trim();
  }

  // "Here is a draft post:" style lead-ins on their own first line.
  out = out.replace(/^(here(?:'s| is)[^\n]{0,80}:)\s*\n+/i, "");

  return out.trim();
}

/**
 * The prose behind a carousel. Written as its own call rather than asked for
 * alongside the commentary: the two have different jobs — one is a deck, the
 * other is the line that makes someone swipe it — and a single response that
 * tries to be both tends to be a post with headings bolted on.
 */
function articleStyle(depth: Depth): string {
  const shape = DECK_SHAPE[depth];
  return `You write the long-form body of a LinkedIn document post: a dense deck
a reader swipes through.

Structure, exactly:
- Split the piece into ${shape.sections} sections. Start each with a markdown H1 — a
  line beginning "# " — which becomes that slide's heading.
- Headings are 2 to 6 words. Concrete, not clever. "Where the cost actually is",
  not "The Journey Begins".
- Under each heading write ${shape.words} words: two or three full paragraphs,
  separated by a blank line. This is a hard floor, not a target to undershoot.
  Each section is printed on its own page, so a section of two thin sentences
  renders as a page that is mostly empty — the commonest way one of these decks
  looks unfinished. If a section has less than that to say, it is not a section:
  fold it into its neighbour.
- Never repeat the heading as the first sentence underneath it. The reader has
  just read it.
- A short list is allowed at most twice in the deck: lines starting with "- ",
  three to five of them, each a few words. They are typeset as a real list. Do
  not build the whole deck out of them — prose carries an argument, a list only
  labels one.
- No other markdown. No bold, no numbering, no images, no links.

Substance:
- NEVER INVENT FACTS. No statistics, percentages, customer names, dates,
  timelines, or outcomes you were not given. Where a figure would help but you
  have not been told one, write a marker like [NUMBER: deflected tickets] and
  leave it. The author fills it in; an invented number gets published under a
  real person's name.
- Explain a mechanism or a tradeoff. A deck that only asserts things is filler.
  Say why something is true, or what it costs, not merely that it matters.
- Open on the problem, not on throat-clearing. Close on what the reader should
  do or reconsider.

Output only the prose, starting with the first "# " heading. No preamble.`;
}

/**
 * The same piece, written to be posted as text rather than rendered to pages.
 *
 * The hard cap is the whole difference. A LinkedIn *Article* — the /pulse
 * editor — has no practical limit, but no API can publish one: the Articles
 * API is read-only. What this mode publishes is a post, and a post's
 * commentary is capped at 3,000 characters by the API itself
 * (FIELD_LENGTH_TOO_LONG). So the model is given a budget here, where the deck
 * prompt deliberately has none.
 */
function longTextStyle(depth: Depth): string {
  const budget = LONG_TEXT_LENGTH[depth];
  return `You write a long-form LinkedIn post — one that goes out as text in the
feed, not as an attachment.

Length is a hard constraint, not a target:
- Write about ${budget} characters. ${MAX_COMMENTARY_LENGTH} is the API's absolute
  maximum and a link is appended after you, so anything above ${budget + 200} is
  unpublishable and will be thrown away.
- Fewer, fuller sections beat more thin ones. Cut a section rather than
  shortening every sentence into a list of assertions.

Structure:
- 3 to 6 sections, each opening with a markdown H1 — a line beginning "# ".
  These become plain lines in the post; LinkedIn renders no markup.
- Two or three short paragraphs under each, separated by a blank line.
- No bold, no bullets, no numbering, no links.

Substance:
- NEVER INVENT FACTS. No statistics, percentages, customer names, dates, or
  outcomes you were not given. Where a figure would help but you were not told
  one, write a marker like [NUMBER: deflected tickets] and leave it.
- Explain a mechanism or a tradeoff. Open on the problem, close on what the
  reader should do or reconsider.

Output only the prose, starting with the first "# " heading. No preamble.`;
}

/**
 * A full-length article for LinkedIn's own editor. Nothing here publishes it —
 * the Articles API cannot create one — so the output is written to be read on
 * an article page and copied into that editor by hand.
 *
 * Formatting is therefore allowed, and wanted: that editor renders headings,
 * bold and lists, unlike the feed, where every one of those prints literally.
 */
function manualArticleStyle(depth: Depth): string {
  return `You write a full-length LinkedIn article — the kind published through
LinkedIn's own article editor and read on its own page, not a feed post.

Shape:
- Open with a single "# " line: the title. 6 to 12 words, concrete, no colon-
  subtitle construction, no clickbait.
- Then a one or two paragraph opening that states the problem and what the
  reader will get. Do not begin with "In today's world" or a dictionary
  definition.
- ${ARTICLE_WORDS[depth]} words in total, in 4 to 8 sections, each under a "## "
  heading. Sections are prose, three to six paragraphs.
- Close with a short section that says what to do or reconsider, and one
  question worth answering in the comments.

Formatting: markdown, and only what the editor supports — "#", "##", **bold**
sparingly, and "- " lists used at most twice in the whole piece. No tables, no
code fences, no images, no footnotes.

Substance:
- NEVER INVENT FACTS. No statistics, percentages, customer names, dates,
  timelines, or outcomes you were not given. Where a figure would carry the
  argument but you have not been told one, write a marker like
  [NUMBER: deflected tickets] and leave it for the author.
- Length is earned by explaining mechanisms, tradeoffs and consequences, not by
  restating the thesis in new words. A padded article is worse than a short one:
  it is read for longer before being abandoned.
- Write for one reader who does this work. Assume competence; skip the primer.

Output only the article, starting with the "# " title. No preamble.`;
}

/**
 * Cuts prose down to a limit. Its own call rather than a regeneration: the
 * author has already read and possibly edited this text, so the job is to
 * remove from it, not to write a different piece and hope it is as good.
 */
export async function composeShorten(input: {
  text: string;
  limit: number;
  provider?: string;
  model?: string;
}): Promise<{ text: string; characterCount: number; provider: string }> {
  const provider = getProvider(input.provider);
  // Aimed under the limit, because a model asked for "at most N" lands on N.
  const target = Math.max(300, Math.round(input.limit * 0.88));

  const shortened = clean(
    await provider.complete(
      [
        {
          role: "system",
          content:
            `You shorten a piece of writing to fit a hard limit. Cut it to about ${target} characters — ` +
            `${input.limit} is the absolute ceiling.\n\n` +
            "Rules:\n" +
            "- Remove whole sentences and whole sections. Do not compress every sentence into a shorter, denser one: that produces a wall of assertions nobody reads.\n" +
            "- Keep the opening and the closing. They are what the piece is judged on.\n" +
            "- Keep the markdown '# ' headings on the sections that survive.\n" +
            "- Add nothing. No new claims, no new numbers, no summary line of your own. Leave any [MARKER] exactly as it is.\n" +
            "- Output only the shortened prose. No preamble, no note about what you cut.",
        },
        { role: "user", content: input.text },
      ],
      { model: input.model },
    ),
  );

  if (!shortened) throw new Error(`${provider.label} returned nothing usable.`);

  return { text: shortened, characterCount: [...shortened].length, provider: provider.id };
}

/**
 * Room for the author link appended at publish time, plus a little slack. A
 * draft that is exactly 3,000 characters fails the moment the link is added.
 */
const POST_FIT_LIMIT = 2900;

/**
 * Brings prose under the post cap, cutting at most twice. Two attempts because
 * a model that overshoots by a factor is unlikely to land in one pass, and
 * because a loop that keeps calling a model on its own output is how a draft
 * turns into a paraphrase of a paraphrase.
 */
async function fitToPostLimit(
  markdown: string,
  options: { provider?: string; model?: string },
): Promise<{ text: string; shortened: boolean }> {
  let text = markdown;
  let shortened = false;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if ([...articleAsPostText(text)].length <= MAX_COMMENTARY_LENGTH) break;
    const cut = await composeShorten({ text, limit: POST_FIT_LIMIT, ...options });
    text = cut.text;
    shortened = true;
  }

  return { text, shortened };
}

export async function composeArticle(
  input: ComposeInput,
): Promise<{ article: string; commentary: string; provider: string; shortened?: boolean }> {
  const provider = getProvider(input.provider);
  const options = { model: input.model };

  const depth = input.depth ?? "standard";
  const article = clean(
    await provider.complete([
      {
        role: "system",
        content:
          input.mode === "manual"
            ? manualArticleStyle(depth)
            : input.mode === "text"
              ? longTextStyle(depth)
              : articleStyle(depth),
      },
      {
        role: "user",
        content: [
          `Topic: ${input.topic}`,
          input.instructions ? `Additional instructions: ${input.instructions}` : "",
          sourcesBlock(input.sources),
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ], options),
  );

  // Nothing publishes a manual article, so nothing measures it either: no post
  // cap, and no commentary, since there is no feed post for one to sit above.
  if (input.mode === "manual") {
    return { article, commentary: "", provider: provider.id };
  }

  if (!article.includes("#")) {
    throw new Error(
      `${provider.label} returned prose with no "# " headings, so it cannot be split into slides. Try again, or write the sections yourself.`,
    );
  }

  // In text mode the prose *is* the post, so there is nothing for a commentary
  // to sit above — writing one would be a second model call whose output the
  // publish path then ignores.
  if (input.mode === "text") {
    // And it is a post, so it has to fit. Telling the model the budget is not
    // enough — a local model asked for "about 2500 characters" returned 4272 —
    // and handing back something that cannot even be saved is not a draft. So
    // the limit is enforced here rather than left as the author's problem.
    const fitted = await fitToPostLimit(article, {
      provider: input.provider,
      model: input.model,
    });
    return {
      article: fitted.text,
      commentary: "",
      provider: provider.id,
      ...(fitted.shortened ? { shortened: true } : {}),
    };
  }

  // The commentary is written against the finished deck rather than the topic,
  // so it can point at what is actually in the slides.
  const commentary = clean(
    await provider.complete([
      { role: "system", content: `${HOUSE_STYLE}\n\n${audienceRule(input.target)}` },
      {
        role: "user",
        content:
          `You wrote the carousel below. Now write the short post that sits above it in ` +
          `the feed — 400 to 700 characters, whose only job is to make someone swipe. ` +
          `Do not summarise every slide. Do not repeat its headings verbatim.\n\n---\n\n${article}`,
      },
    ], options),
  );

  return { article, commentary, provider: provider.id };
}

/**
 * The two lines that go on a generated image card. Written by the model
 * against the finished post, because the line worth putting on a card is
 * rarely the post's first sentence — it is the claim the post is built on,
 * said in fewer words.
 *
 * Under the same no-invention rule as everything else: the card is the most
 * screenshotted, most decontextualised thing you publish, so a number on it
 * that nobody supplied would be the worst possible place for one.
 */
export async function composeCardText(input: {
  text: string;
  topic?: string;
  target: Target;
  provider?: string;
  model?: string;
}): Promise<{ eyebrow: string; headline: string; provider: string }> {
  const provider = getProvider(input.provider);

  const raw = await provider.complete(
    [
      {
        role: "system",
        content:
          "You write the text on a square image card that accompanies a LinkedIn post.\n" +
          "Output ONLY a JSON object, no prose, no code fence: " +
          '{"eyebrow": "<2-4 words, a label>", "headline": "<the one line worth putting on a card>"}.\n' +
          "The headline is 6 to 16 words. It is the post's central claim, stated flatly enough to stand alone " +
          "when someone sees the image without the post. Not a summary, not a teaser, not a question, no hashtags, no quote marks.\n" +
          "Never state a fact, number, or name that is not already in the post. If the post carries a [MARKER], leave it out of the card entirely.",
      },
      {
        role: "user",
        content: [input.topic ? `Topic: ${input.topic}` : "", `Post:\n\n${input.text.slice(0, 6000)}`]
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
    throw new Error(`${provider.label} did not return JSON for the card text. First bytes: ${raw.slice(0, 160)}`);
  }
  const object = (parsed ?? {}) as { eyebrow?: unknown; headline?: unknown };
  const headline = typeof object.headline === "string" ? object.headline.trim() : "";
  if (!headline) throw new Error("The model returned no headline for the card.");

  return {
    eyebrow: typeof object.eyebrow === "string" ? object.eyebrow.trim() : (input.topic ?? ""),
    headline,
    provider: provider.id,
  };
}

/**
 * Generates draft text with a configurable model backend. Only used by front
 * ends that have no model of their own — in Claude Code the assistant writes the
 * draft directly and calls linkedin_save_draft with it.
 */
export async function composeDraft(input: ComposeInput): Promise<ComposeResult> {
  const provider = getProvider(input.provider);
  const raw = await provider.complete(buildMessages(input), { model: input.model });
  const text = clean(raw);

  if (!text) {
    throw new Error(`${provider.label} returned nothing usable.`);
  }

  // A post over the cap cannot be saved, let alone published, so it is cut here
  // rather than handed back as a draft the author has to discover is unusable.
  const fitted = await fitToPostLimit(text, { provider: input.provider, model: input.model });

  return {
    text: fitted.text,
    provider: provider.id,
    characterCount: [...fitted.text].length,
    ...(fitted.shortened ? { shortened: true } : {}),
  };
}
