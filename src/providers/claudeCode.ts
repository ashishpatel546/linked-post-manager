import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { config } from "../config.ts";
import {
  ProviderError,
  type ChatMessage,
  type CompleteOptions,
  type DraftProvider,
  type ProviderStatus,
} from "./types.ts";

/**
 * Headless Claude Code. Authenticates with the existing Claude subscription
 * rather than an API key, so drafting costs nothing extra — it does consume the
 * same subscription rate limits as interactive use.
 *
 * Invoked as a *sealed* session, not a coding session. Left at its defaults the
 * CLI runs in the project directory with every tool enabled and the user's
 * CLAUDE.md files loaded, which meant two things: it could read `.env` (the
 * LinkedIn secret, the AWS key) if it decided a file was relevant, and its
 * output was occasionally a conversational reply rather than the prose asked
 * for — the "no # headings" failure. So:
 *
 *   --tools ""                              nothing to read or run
 *   --system-prompt-file                    our prompt IS the system prompt
 *   --exclude-dynamic-system-prompt-sections  no CLAUDE.md, no memory
 *   --no-session-persistence                leaves nothing on disk
 *   --output-format json                    structured result, explicit is_error
 *   cwd = os.tmpdir()                       no project to discover
 *
 * `--bare` would be the obvious flag but it also skips the keychain read, so
 * subscription auth fails with "Not logged in". Verified, not assumed.
 */

/** Aliases the CLI accepts, offered in the UI. A full model id also works. */
export const CLAUDE_CODE_MODELS = ["sonnet", "opus", "fable"] as const;

type CliResult = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  modelUsage?: Record<string, unknown>;
};

function run(bin: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Only a .cmd/.bat shim needs an interpreter — bare spawn cannot execute
    // one. A native .exe must be spawned directly: routing it through cmd.exe
    // adds a shell that would mangle a path containing spaces.
    //
    // cmd.exe is invoked with an argument array rather than `shell: true`; the
    // latter concatenates args into an unescaped command line, which Node 24
    // deprecates for exactly that reason.
    const needsShim = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
    const [command, commandArgs] = needsShim
      ? [process.env.ComSpec ?? "cmd.exe", ["/c", bin, ...args]]
      : [bin, args];

    const child = spawn(command, commandArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: os.tmpdir(),
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new ProviderError(
            "claude-code",
            `Claude Code CLI not found at "${bin}". Install it with \`npm i -g @anthropic-ai/claude-code\`, or set CLAUDE_CODE_BIN in .env to its full path.`,
          ),
        );
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      // With --output-format json the CLI still writes the JSON envelope on a
      // failure, so prefer its message to a bare exit code when it has one.
      if (code !== 0) {
        const envelope = tryParse(stdout);
        const detail = envelope?.result || stderr.slice(0, 400) || "(no output)";
        reject(new ProviderError("claude-code", `Claude Code exited with ${code}: ${detail}`));
        return;
      }
      resolve(stdout);
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

function tryParse(text: string): CliResult | null {
  try {
    return JSON.parse(text) as CliResult;
  } catch {
    return null;
  }
}

/**
 * The system prompt goes through a file rather than argv. It is long, has
 * newlines, and on the .cmd path it would cross cmd.exe, whose quoting rules
 * are not worth betting a post on. A temp file has no such rules.
 */
async function withSystemPromptFile<T>(system: string, use: (file: string) => Promise<T>): Promise<T> {
  const file = path.join(os.tmpdir(), `linkedin-agent-system-${crypto.randomBytes(6).toString("hex")}.txt`);
  fs.writeFileSync(file, system, { encoding: "utf8", mode: 0o600 });
  try {
    return await use(file);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function resolveModel(requested: string | undefined): string | undefined {
  const model = (requested ?? config.claudeCodeModel).trim();
  return model.length > 0 ? model : undefined;
}

export const claudeCodeProvider: DraftProvider = {
  id: "claude-code",
  label: "Claude Code (subscription)",

  status(): ProviderStatus {
    return {
      id: "claude-code",
      label: "Claude Code (subscription)",
      configured: true,
      model: resolveModel(undefined) ?? "CLI default",
      models: [...CLAUDE_CODE_MODELS],
      endpoint: config.claudeCodeBin,
      metered: false,
    };
  },

  async probe(): Promise<ProviderStatus> {
    const base = this.status();
    try {
      // `claude --version` prints "2.1.263 (Claude Code)"; the suffix repeats
      // the label it sits next to in the picker, so drop it.
      const version = (await run(config.claudeCodeBin, ["--version"], ""))
        .replace(/\s*\(Claude Code\)\s*$/i, "")
        .trim();
      return {
        ...base,
        reachable: true,
        model: `${base.model}${version ? ` · v${version}` : ""}`,
      };
    } catch (error) {
      return {
        ...base,
        reachable: false,
        configured: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  },

  async complete(messages: ChatMessage[], options: CompleteOptions = {}): Promise<string> {
    const system = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const prompt = messages
      .filter((message) => message.role !== "system")
      .map((message) => message.content)
      .join("\n\n");

    const model = resolveModel(options.model);

    const raw = await withSystemPromptFile(system || "You are a careful writer.", (file) =>
      run(
        config.claudeCodeBin,
        [
          "-p",
          "--tools", "",
          "--no-session-persistence",
          "--output-format", "json",
          "--system-prompt-file", file,
          "--exclude-dynamic-system-prompt-sections",
          ...(model ? ["--model", model] : []),
        ],
        // Prompt over stdin, never argv: long, multi-line, and must not be
        // parsed by any shell.
        prompt,
      ),
    );

    const envelope = tryParse(raw);
    if (!envelope) {
      throw new ProviderError(
        "claude-code",
        `Claude Code did not return JSON. First bytes: ${raw.slice(0, 200)}`,
      );
    }
    if (envelope.is_error) {
      throw new ProviderError("claude-code", envelope.result || "Claude Code reported an error.");
    }

    const text = (envelope.result ?? "").trim();
    if (!text) throw new ProviderError("claude-code", "Claude Code returned an empty response.");
    return text;
  },
};
