import { spawn } from "node:child_process";

/**
 * Hands a URL to whatever the OS considers the default browser.
 *
 * Best effort, always: every caller also prints the URL, and a machine with no
 * opener (a bare container, a headless server) is expected to fall back to
 * copying it. Nothing here is allowed to throw or to keep the process alive.
 *
 * Deliberately NOT `cmd /c start` on Windows: cmd.exe treats `&` as a command
 * separator, so a URL with query parameters is silently truncated at the first
 * one — an OAuth URL loses everything after `client_id` and LinkedIn replies
 * "You need to pass the client_id parameter". rundll32 execs directly with no
 * shell in the way, so the URL arrives intact. The UI's `?token=…` has exactly
 * the same problem, which is why both callers come through here.
 */
function browserOpener(url: string): { command: string; args: string[] } {
  switch (process.platform) {
    case "win32":
      return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
    case "darwin":
      return { command: "open", args: [url] };
    default:
      // Linux, BSD, WSL. xdg-open is not guaranteed to exist; the spawn error
      // handler below leaves the printed URL as the fallback.
      return { command: "xdg-open", args: [url] };
  }
}

export function openInBrowser(url: string): void {
  const { command, args } = browserOpener(url);
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    // No opener on this system — the printed URL is the fallback, so stay quiet.
    child.on("error", () => {});
    // Unref'd so a long-lived server is not held open by a detached child, and
    // so a short-lived script can exit the moment its own work is done.
    child.unref();
  } catch {
    // Opening a browser is a convenience; it must never break the caller.
  }
}
