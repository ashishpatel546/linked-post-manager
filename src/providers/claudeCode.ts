import { spawn } from "node:child_process";
import { config } from "../config.ts";
import {
  ProviderError,
  type ChatMessage,
  type DraftProvider,
  type ProviderStatus,
} from "./types.ts";

/**
 * Headless Claude Code. Authenticates with the existing Claude subscription
 * rather than an API key, so drafting from the extension costs nothing extra —
 * it does consume the same subscription rate limits as interactive use.
 *
 * Requires the CLI on PATH: npm i -g @anthropic-ai/claude-code
 */
function run(bin: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // On Windows the CLI is a .cmd shim, which bare spawn cannot execute. Go
    // through cmd.exe explicitly with an argument array rather than
    // `shell: true` — the latter concatenates args into a command line
    // unescaped, which Node 24 deprecates for exactly that reason.
    const [command, commandArgs] =
      process.platform === "win32"
        ? [process.env.ComSpec ?? "cmd.exe", ["/c", bin, ...args]]
        : [bin, args];

    const child = spawn(command, commandArgs, {
      stdio: ["pipe", "pipe", "pipe"],
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
      if (code !== 0) {
        reject(
          new ProviderError(
            "claude-code",
            `Claude Code exited with ${code}: ${stderr.slice(0, 400) || "(no stderr)"}`,
          ),
        );
        return;
      }
      resolve(stdout.trim());
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

export const claudeCodeProvider: DraftProvider = {
  id: "claude-code",
  label: "Claude Code (subscription)",

  status(): ProviderStatus {
    return {
      id: "claude-code",
      label: "Claude Code (subscription)",
      configured: true,
      model: "whatever the CLI is configured to use",
      endpoint: config.claudeCodeBin,
      metered: false,
    };
  },

  async probe(): Promise<ProviderStatus> {
    const base = this.status();
    try {
      const version = await run(config.claudeCodeBin, ["--version"], "");
      return { ...base, reachable: true, model: version.trim() || base.model };
    } catch (error) {
      return {
        ...base,
        reachable: false,
        configured: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  },

  async complete(messages: ChatMessage[]): Promise<string> {
    // The CLI takes a single prompt, so flatten the system message into it.
    const system = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const rest = messages
      .filter((message) => message.role !== "system")
      .map((message) => message.content)
      .join("\n\n");
    const prompt = system ? `${system}\n\n---\n\n${rest}` : rest;

    // Prompt goes over stdin, never as an argv entry: it is long, contains
    // newlines and quotes, and must not be parsed by any shell.
    const text = await run(config.claudeCodeBin, ["-p"], prompt);
    if (!text) throw new ProviderError("claude-code", "Claude Code returned an empty response.");
    return text;
  },
};
