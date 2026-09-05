import { getProvider } from "../providers/index.ts";
import type { ChatMessage } from "../providers/types.ts";
import { MAX_COMMENTARY_LENGTH } from "../linkedin/text.ts";
import type { Target } from "./targets.ts";

export type ComposeInput = {
  topic: string;
  target: Target;
  /** Provider id; falls back to DRAFT_PROVIDER in .env. */
  provider?: string;
  /** Freeform steer: "make it punchy", "mention the pilot in Pune". */
  instructions?: string;
  /** Rough length to aim for, in characters. */
  targetLength?: number;
};

export type ComposeResult = {
  text: string;
  provider: string;
  characterCount: number;
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
  const length = input.targetLength ?? 900;
  const user = [
    `Topic: ${input.topic}`,
    input.instructions ? `Additional instructions: ${input.instructions}` : "",
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
 * Generates draft text with a configurable model backend. Only used by front
 * ends that have no model of their own — in Claude Code the assistant writes the
 * draft directly and calls linkedin_save_draft with it.
 */
export async function composeDraft(input: ComposeInput): Promise<ComposeResult> {
  const provider = getProvider(input.provider);
  const raw = await provider.complete(buildMessages(input));
  const text = clean(raw);

  if (!text) {
    throw new Error(`${provider.label} returned nothing usable.`);
  }

  return {
    text,
    provider: provider.id,
    characterCount: [...text].length,
  };
}
