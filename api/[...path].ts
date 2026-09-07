import type { IncomingMessage, ServerResponse } from "node:http";

import { handleHttp } from "../src/http/server.ts";

/**
 * The whole API on Vercel, in one function.
 *
 * `[...path]` catches every route under /api, so the routing table stays where
 * it already is — in http/server.ts — rather than being restated as a directory
 * of files that can fall out of step with the local server. Vercel hands this
 * function a Node request and response, which is exactly what handleHttp takes.
 *
 * The page itself is not served here: `scripts/build-public.mjs` copies it into
 * public/, so the HTML, the manifest, the worker and the icons come off the CDN
 * and only real work reaches a function.
 */
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    await handleHttp(req, res);
  } catch (error) {
    // A throw that escapes handleHttp is a bug or a misconfiguration — a
    // missing SESSION_SECRET, an unset bucket. Say which, rather than letting
    // the platform return an opaque 500 the operator cannot act on.
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: message }, null, 2));
    } else {
      res.end();
    }
  }
}
