# linkedin-agent

An MCP server that lets Claude draft, review, and publish LinkedIn posts for
**your personal profile** and **your company page** (`urn:li:organization:109594354`).

The working loop is deliberately gated:

```
you: "draft a post about X"
  -> Claude writes drafts/<id>.md          (nothing sent to LinkedIn)
you: read it, edit it, or ask for changes  (any edit resets approval)
you: "looks good, post it"
  -> approve_draft, then publish_draft     (the only path that publishes)
```

Nothing reaches LinkedIn without an explicit `confirm: true` **and** an approved
draft **and** `LINKEDIN_FORCE_DRY_RUN=false`.

---

## Phase 0 — LinkedIn app setup (you must do this; ~20 minutes)

Everything below is blocked until this is done.

1. Go to <https://www.linkedin.com/developers/apps> and **Create app**.
2. Associate it with the company page **109594354**. This is required even for
   personal-profile posting.
3. On the app's **Settings** tab, click **Verify** and complete the page-admin
   verification. You administer the page, so you can approve your own request.
4. On the **Products** tab, request:
   - **Sign In with LinkedIn using OpenID Connect** — instant
   - **Share on LinkedIn** — instant

   **Do not request Community Management API on this app — you cannot.** It must
   be the only product on its application, so the moment this app has Share on
   LinkedIn, the CMA request button is greyed out. See "Company page access"
   below.
5. On the **Auth** tab, find **OAuth 2.0 settings → Authorized redirect URLs for
   your app**, click the **pencil icon**, then **+ Add redirect URL**, and add
   exactly:
   ```
   http://localhost:5599/callback
   ```
   Then click **Update**. Validation is an exact match on protocol, domain, and
   path — no wildcards, no prefix matching, no trailing slash.

   If that section is not visible at all, no OAuth product is provisioned yet.
   Check the **Products** tab shows *Sign In with LinkedIn using OpenID Connect*
   as **Added**, not merely requested.

   If LinkedIn refuses to save an `http://` URL, see "HTTPS redirect" below.
6. Copy the Client ID and Client Secret into `.env`.

**While Community Management API is pending**, personal-profile publishing works
fully. Authorize with member scopes only, or LinkedIn will reject the whole
consent screen for asking for scopes the app has not been granted:

```bash
npm run auth -- --member-only
```

## Phase 0b — Company page access (Community Management API)

This is a separate, slower track. Personal-profile publishing does not wait on it.

LinkedIn requires the Community Management API to be **the only product on its
application**. Your main app has Share on LinkedIn, so the request button there
is greyed out — that is the documented behaviour, not a fault.

1. Create a **second developer app**, verified against the **same** company page
   (109594354), with no other products requested.
2. Request **Community Management API — Development tier** on that app. Approval
   checks an approved use case, a verified business email, a verified
   organisation, a verified website/domain, and page-admin verification of the app.
3. Once approved, request **Standard tier**, which needs a screencast under five
   minutes showing the OAuth flow and the core functionality.
4. Then request Community Management API on this main app, entering the second
   app's client ID to skip most of the form. The second app can be discarded
   afterwards; it exists for verification.

Two things that fail applications:

- **The business email must match the organisation.** A personal address will not
  pass vetting, and neither will an address at a different company than the one
  on the application.
- **Registered legal organisations, commercial use cases only.**

Development tier limits are 500 API calls per app and 100 per member per 24
hours — ample here.

### HTTPS redirect (only if needed)

LinkedIn's documentation says to register the callback URL over HTTPS, and in
practice it accepts `http://localhost` for local development. If your app refuses
to save the `http://` URL, the callback server needs to run over TLS instead:
register `https://localhost:5599/callback`, generate a self-signed certificate,
and serve the callback over HTTPS. The browser will warn once about the untrusted
certificate; accepting it completes the flow normally. This is a small change to
[src/auth/oauth.ts](src/auth/oauth.ts) plus one dependency for certificate
generation — not yet implemented, since the `http://` form usually works.

## Phase 1 — Authorize

```bash
npm install
npm run auth        # opens the LinkedIn consent screen, stores the token
npm run whoami      # verifies identity, scopes, and administered pages
```

The token lands in `.state/tokens.json` (gitignored). LinkedIn member tokens
last **60 days**; `linkedin_token_status` warns as expiry approaches and
`npm run auth` refreshes it.

## Phase 2 — Connect it to Claude

From the project directory:

```bash
claude mcp add linkedin -- node "$(pwd)/src/mcp/server.ts"     # macOS / Linux
claude mcp add linkedin -- node "%CD%\src\mcp\server.ts"       # Windows cmd
```

Restart Claude Code, then ask it to `linkedin_token_status` to confirm the
connection.

## Platform support

Runs on Windows, macOS, and Linux with no build step — Node 24 executes the
TypeScript directly. The three places that touch the OS all branch and fall back
safely:

- **Opening the browser during auth** — `rundll32` on Windows, `open` on macOS,
  `xdg-open` elsewhere. If none works, the authorize URL is printed to copy by
  hand. Note the flow deliberately avoids `cmd /c start` on Windows: cmd treats
  `&` as a command separator and silently truncates the OAuth URL at the first
  query parameter.
- **The Claude Code provider** — goes through `cmd.exe` on Windows to run the
  `.cmd` shim, and execs directly elsewhere.
- **`CLAUDE_CODE_BIN`** — defaults to `claude.cmd` on Windows and `claude`
  elsewhere. Leave it unset in `.env` unless you need a specific path.

All file paths are built with `path.join`, so nothing assumes a separator.

## Phase 3 — Go live

`.env` ships with `LINKEDIN_FORCE_DRY_RUN=true`, so every publish returns a
preview and sends nothing. Leave it that way until you have seen a preview you
are happy with, then set it to `false`.

> **Restart the MCP server after changing `.env`.** The server is a long-lived
> stdio process that reads `.env` once, at startup, and the inherited
> environment wins over the file ([src/config.ts](src/config.ts)). Editing
> `.env` while it is running changes nothing — publishes keep coming back as
> dry runs even though the file says `false`. Run `/mcp` -> `linkedin` ->
> Reconnect, or restart Claude Code. The publish path detects this specific
> mismatch and says so rather than telling you to set a flag you have already
> set.

---

## Tools

**Identity**
| Tool | Purpose |
|---|---|
| `linkedin_token_status` | Auth state, scopes, expiry, dry-run flag, posts used today |
| `linkedin_whoami` | Your member URN and the pages you administer |

**Drafting — the normal path**
| Tool | Purpose |
|---|---|
| `linkedin_save_draft` | Write a draft to `drafts/<id>.md`; requires `format` (`post` or `article`); resets approval |
| `linkedin_list_drafts` | All drafts and their status |
| `linkedin_read_draft` | Read one draft in full |
| `linkedin_approve_draft` | Mark approved — only after you have said yes |
| `linkedin_publish_draft` | Publish an approved draft (needs `confirm: true`) |

**Direct posting**
| Tool | Purpose |
|---|---|
| `linkedin_preview_post` | Render the exact API payload; never publishes |
| `linkedin_publish_post` | Publish without a draft (needs `confirm: true`) |
| `linkedin_upload_image` | Upload a PNG/JPG/GIF, returns `urn:li:image:...` |
| `linkedin_delete_post` | Delete a post (needs `confirm: true`) |

**Company page** — all require Community Management API
| Tool | Purpose |
|---|---|
| `linkedin_list_company_posts` | Recent page posts |
| `linkedin_list_comments` | Comments on a post |
| `linkedin_reply_to_comment` | Comment as the page (needs `confirm: true`) |
| `linkedin_post_engagement` | Likes and comments for one post |
| `linkedin_company_analytics` | Impressions, clicks, engagement, followers |

**Audit**
| Tool | Purpose |
|---|---|
| `linkedin_audit_log` | Every write this agent made, with post URNs |

---

## Posts vs articles

Every draft declares a `format`, and there is no default — `linkedin_save_draft`
is written so Claude asks you rather than guessing, the same way it asks which
account to post to.

| `format` | Limit | In the feed |
|---|---|---|
| `post` | 3,000 characters | An ordinary post, optionally with images or a link |
| `article` | 300 pages | A titled, swipeable document deck |

An article keeps its prose in a companion `drafts/<id>.article.md`, so `body`
keeps one meaning in both formats: the text LinkedIn shows as the post itself.
For an article that is the commentary sitting above the deck.

```
linkedin_save_draft(
  topic: "...", target: "me", format: "article",
  articleTitle: "Stop handing the model a manual",
  body: "Short commentary shown above the deck.",
  article: "## First section\n\nProse...\n\n---\n\n## Second section\n...")
```

`## Heading` starts a section, `---` on its own line forces a page break, and
without either the prose is packed into pages on its own. The deck renders to
`drafts/<id>.pdf` on every publish call — dry runs included, since the PDF is
what there is to review — via [src/render/pdf.ts](src/render/pdf.ts), a
dependency-free writer using the PDF core fonts. No headless browser.

**A LinkedIn "Article" (the `/pulse` editor) is not this, and no integration can
publish one.** The [Articles API is read-only](https://learn.microsoft.com/en-us/linkedin/shared/references/migrations/article-migration) —
it retrieves articles and their social actions, and exposes no create endpoint.
A document post is the long-form format an API can actually publish, and the
only way past the 3,000-character cap without leaving LinkedIn.

## Profile link

Set `LINKEDIN_PROFILE_LINK` in `.env` and it is appended to **every** post and
every article's commentary, and printed on the last page of an article deck:

```
LINKEDIN_PROFILE_LINK=https://your-site.example/
LINKEDIN_PROFILE_LINK_LABEL=More:
```

Empty disables it, which is the default — a link nobody configured should never
appear on someone's feed.

It is applied in `publishPost`, the single choke point every publish path goes
through, so it cannot be bypassed by a tool that forgets it. Consequences worth
knowing:

- It is **not** stored in drafts. Change the URL in `.env` and every future
  publish picks it up; drafts written earlier need no edit.
- Dry-run previews show it, because the text being approved has to be the text
  that gets sent.
- Appending is **idempotent** — a body that already contains the URL is left
  alone rather than carrying it twice.
- If the link would push a post past 3,000 characters, the publish fails with a
  message naming the link rather than a bare length error.

## Images

Attach local files when saving a draft — paths relative to the project root, or
absolute:

```
linkedin_save_draft(topic: "...", body: "...", target: "me",
                    images: ["assets/dashboard.png"])
```

One image posts as a single image, several as a multi-image post. Images take
precedence over `link` — a LinkedIn post carries one or the other. Files are
checked when the draft is saved, so a bad path fails while you are still writing
rather than after you have approved.

Upload happens only at the moment of a real publish. A dry run never pushes
bytes, which keeps previews free and avoids orphaned assets on LinkedIn for posts
that are never published.

**There is no automatic image sourcing.** Nothing here searches the web for a
relevant picture, by design: publishing an image you do not hold rights to, under
a company page, is a real exposure. Point it at your own screenshots, product
shots, or photos. If you want stock imagery, wire a properly licensed source
(Unsplash or Pexels both have free APIs permitting commercial use) rather than
downloading from search results.

## Draft providers (browser extension only)

The MCP path needs none of this — in Claude Code, Claude writes the draft in
your session and the server only publishes it. A browser extension has no model
of its own, so it picks a backend:

| Provider | Cost | Needs |
|---|---|---|
| `ollama` | free | Ollama running locally, and enough free RAM to load the model |
| `openai` | metered | `OPENAI_API_KEY`. `OPENAI_BASE_URL` also points at any OpenAI-compatible endpoint |
| `claude-code` | free | `npm i -g @anthropic-ai/claude-code`; uses your existing subscription, no API key |

Set `DRAFT_PROVIDER` in `.env`, or pass a provider per request. Check what is
actually usable:

```bash
npm run providers                                  # probe all three
npm run providers -- --test "your topic here"      # generate a real draft
```

The provider is only asked for text. It never sees your LinkedIn token, and its
output goes into a draft file for review like any other — a bad draft from a
weak model is a draft you reject, not a post that goes out.

## What LinkedIn does not allow

These are API limits, not gaps in this project:

- **No reading your personal feed.** There is no endpoint behind
  `linkedin.com/feed/`. "Summarize my timeline" is not buildable.
- **No reading your own profile's posts, comments, or analytics.** The Posts API
  does support finding posts by a person author (version 202301 and later), but
  it needs `r_member_social`, which LinkedIn documents as a **closed permission**
  they are not granting. So this is blocked by entitlement, not by the endpoint.
  It is why the company page gets the listening tools and your profile does not.
- **No scheduling.** LinkedIn has no scheduled-post endpoint. Deliberately not
  built here; it would be a local queue plus a cron trigger.
- **No scraping.** Driving linkedin.com with a browser automates a surface the
  User Agreement forbids (§8.2) and risks the account. This project only calls
  the documented API.

## Guardrails

Four independent layers, all in [src/core/publish.ts](src/core/publish.ts):

1. **`LINKEDIN_FORCE_DRY_RUN`** — master switch; while true nothing is ever
   sent. Read at startup only, so a change needs a server restart.
2. **`confirm: true`** — required on every publish, delete, and comment.
3. **Approval state** — `publish_draft` refuses a draft that is not `approved`,
   and any edit knocks it back to `draft`.
4. **`LINKEDIN_DAILY_POST_LIMIT`** — hard cap per calendar day.

Plus an append-only audit log at `.state/audit.jsonl` recording every write,
dry runs included, with the URN of anything published so it can be found and
deleted.

`publishPost()` is the single choke point — every path reaches LinkedIn through
it, so adding a new caller cannot bypass these.

## Layout

```
src/
  config.ts          .env loading, scopes, typed config
  state/
    tokens.ts        token store, expiry, refresh
    audit.ts         append-only log, daily cap
  linkedin/          thin API wrapper — swappable
    client.ts        auth headers, versioning, error translation
    text.ts          Little Text Format escaping, length limits
    posts.ts  images.ts  social.ts  analytics.ts  me.ts
  core/              product logic — reused by every front end
    publish.ts       the single publish choke point
    drafts.ts        draft/approve/publish state machine
    targets.ts       me vs company resolution
  mcp/server.ts      MCP adapter (thin)
  auth/              one-time OAuth flow
```

`core/` holds the logic and `mcp/` is a thin adapter over it, so a second front
end — an HTTP server for a Chrome extension, or a swap to an official LinkedIn
MCP server underneath `linkedin/` — is an adapter, not a rewrite.

## Notes

- `LINKEDIN_API_VERSION` is pinned to `202608`. LinkedIn deprecates versions
  after roughly a year; the client says so explicitly when it goes stale.
- Post text is escaped for LinkedIn's Little Text Format, where `(`, `)`, `#`,
  `*`, `_` and others are markup and must be backslash-escaped. If a published
  post ever shows literal backslashes, narrow the set in
  [src/linkedin/text.ts](src/linkedin/text.ts). The dry-run preview shows the
  escaped payload so you can check before posting.
