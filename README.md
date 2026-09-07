# Postwright — LinkedIn post studio

A web app and an MCP server over the same core, letting you (or Claude) draft,
review, and publish LinkedIn posts for **your personal profile** and **your
company page** (`urn:li:organization:109594354`).

Two front ends, one set of rules:

- **`npm run ui`** — the studio. Compose, research, design an image, preview the
  post as it will appear, publish. This is the one to use day to day.
- **`npm run mcp`** — the same actions as tools inside Claude Code.

Both reach LinkedIn only through `publishPost()`, so the dry-run switch, the
daily cap, the approval gate and the audit log apply identically to each.

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

## The web UI

```bash
npm run ui
```

It prints the URL and **opens your browser on it**. The URL carries the shared
token in its query string, which is why it is not worth retyping — see
[Starting it again](#starting-it-again-after-a-restart) below for the short
version you actually need day to day.

Compose from a topic, edit the text, attach or design an image, see the post as
it will appear, approve, publish. The dry-run state is a chip at the top, so
you always know whether the next click is live.

Two choices are made up front, on rows of cards, because they change what the
draft *is* rather than how it reads: **who it goes out as** (your profile or the
company page — each card names the account) and **what shape it takes**:

| Format | What goes out |
|---|---|
| **Text post** | An ordinary post, up to 3,000 characters |
| **Carousel post** | A post with a swipeable PDF attached, and your post text above it |
| **Long post** | The same ordinary post — written long-form, headings flattened at publish |
| **Article → LinkedIn editor** | Nothing. A full-length Article this app writes but cannot publish — you paste it into LinkedIn's editor |

The first three all arrive as posts, because that is the only thing the API can
create; see [What "article" means here](#what-article-means-here-and-what-linkedin-shows).
The cards used to be called *Article → PDF deck* and *Article → long text*, which
implied otherwise. The stored `format` and `articleMode` fields did not change,
so drafts written before the rename still open.

Next to the model picker is **Length** — brief, standard, or in-depth. For a
post that is a character budget; for a carousel it is how many slides and how
much goes on each.

### The one length limit, and where it applies

A **post** is capped at 3,000 characters by the API — `FIELD_LENGTH_TOO_LONG`
from the Posts API, and stated outright in the
[UGC Post docs](https://learn.microsoft.com/linkedin/compliance/integrations/shares/ugc-post-api#create-ugc-posts).
A LinkedIn **Article** (the `/pulse` editor) has no practical limit, but no
integration can publish one: the Articles API is read-only. So:

| Format | Cap |
|---|---|
| Text post | 3,000 |
| Long post | 3,000 — it *is* a post |
| Carousel post | **None** — each section is its own page |
| Article → LinkedIn editor | **None** — but published by hand, not by this app |

The carousel is the only way past 3,000 that this app can publish for you.

### What "article" means here, and what LinkedIn shows

Worth stating plainly, because the words do not line up. LinkedIn has exactly
one thing called an Article — the long-form piece with its own `/pulse` URL,
written in LinkedIn's own editor — and **no API can create one**. The Articles
API is read-only, with no create endpoint
([migration notes](https://learn.microsoft.com/linkedin/shared/references/migrations/article-migration)).

So every format here that this app publishes arrives in the feed as a *post*.
The difference is what is attached to it:

| You choose | What appears on LinkedIn |
|---|---|
| Text post | a post: text only, or text with your images |
| Carousel post | a post with a **document** attached — the swipeable PDF, with your post text above it |
| Long post | a post: the prose itself, headings flattened. Identical output to Text post; only the way you write it differs |
| Article → LinkedIn editor | nothing — until you paste it into <https://www.linkedin.com/article/new/> yourself |

If you were expecting a real Article page, the last row is the only route, and
it is a copy-paste by design rather than an omission.

The UI says this in three places now, because a name on a button is what people
actually read: a line above the format cards, the note under whichever card is
selected, and the Publish confirmation, which names what is about to go out.

### Approve saves what is on screen

Publishing reads the draft in storage, never the boxes in the browser — so what
is on screen has to be written down before it can go out. **Approve** does that
for you: it saves first, then approves, so the thing approved is the thing you
are looking at.

This used to save only when no draft existed yet. Everything after the first
Save — a rewritten body, a switched format — was silently left behind, and
publishing sent the older version. Switch a saved text post to a PDF deck and it
still went out as the old plain post.

Two things keep that from being possible now. The badge under the post box says
**unsaved changes** the moment the composer and storage disagree, and **Publish
refuses** while they do, rather than quietly sending the stored copy. It does
not save for you at that point on purpose: that would discard the approval and
publish text nobody had read as approved.

Saying so in the prompt is not enough. Asked for "about 2,500 characters" a
local model returned 4,272, and a draft that cannot even be saved is not a
draft — so `/api/compose` **measures what came back and cuts it to fit**, at
most twice, before returning. Cutting removes whole sentences and sections
rather than compressing every sentence, and the response says `shortened: true`
when it happened. The same guard runs on plain posts.

For prose you have edited by hand, the Article box shows the overage and a
**Shorten to fit 3000** button that does the same thing on demand.

### Nothing is stored until you press Save

Generating does not create a draft, and neither does **Render PDF preview** —
it posts the prose to `/api/render-deck`, which renders and streams the bytes
back without writing anywhere. It used to go through a dry-run publish, which
needed a draft id, which meant looking at a deck quietly created a draft.
Looking at something is not deciding to keep it.

Drafts you do keep can be thrown away from the list itself: each row has a **×**
that removes the record, its prose and its rendered deck, without opening it
first. Ingested images are content-addressed and shared between drafts, so they
are left alone.

### Reviewing what went out

Clicking a **Published** row reads the stored record back: the text exactly as
it was sent, the deck inline, the URN, and a link to the live post. Worth
having because it cannot be got any other way — the audit log keeps 120
characters, and a personal post cannot be fetched from the API, since
`r_member_social` is a permission LinkedIn does not grant.

Underneath it lists the files that post occupies — markdown record, article
prose, rendered PDF, attached images, with sizes — and offers **Delete the
stored copy**. That deletes locally only; the post stays live on LinkedIn. An
image shared with another record is marked *used elsewhere* and kept, because
`assets/` is keyed by content hash and deleting one would pull it out from
under the other post.

### What survives a publish

`LINKEDIN_KEEP_PUBLISHED` decides, and the default is **`stub`**:

| | kept | size |
|---|---|---|
| `stub` (default) | id, topic, target, URN, when | ~260 bytes |
| `full` | the record, the prose, the rendered deck | ~20 KB and up |

Under `stub` the markdown, the article prose and the PDF are deleted when the
post goes live — the post is on LinkedIn now, and what is worth keeping here is
the pointer to it. The Published list and its **View on LinkedIn** link work
exactly the same; opening the record says the text was not kept rather than
showing an empty card.

The tradeoff, stated once: `full` is the only way to read your own text back
later. LinkedIn will not serve a personal post to the API — `r_member_social`
is a closed permission — and the audit entry keeps 120 characters. Records
written while `full` was set stay readable; the setting only changes what
happens at the next publish.

### How it will look

**Preview post** renders the card the way the feed will: the author line, the
text *as the server will actually send it* (the profile link appended, an
article's prose flattened), folded at LinkedIn's "…see more" point, and the
attachment underneath — the image grid, or the rendered deck itself in an
inline frame. The raw API payload is still one click away underneath.

The fold matters more than it looks: roughly 210 characters is all anyone reads
before deciding, and this is the only place you see where the cut lands.

It is a second front end over the same `core/`, not a second implementation —
`publishPost()` is still the only way anything reaches LinkedIn, so the kill
switch, the daily cap, the approval state and the audit log all apply
identically to the UI and to Claude Code.

### Installable on a phone or tablet

The UI is a PWA — manifest, icons, and a service worker are served from the same
process. On Chrome and Edge an **Install app** banner appears (the browser's
`beforeinstallprompt`); on iOS Safari there is no programmatic install, so the
banner is the instruction instead: Share → Add to Home Screen. Neither shows
once running as an installed app.

The service worker caches **the shell only, never `/api/`**. A cached draft would
let you approve text that is not the text on the server and publish something you
did not read; offline here means "cannot reach LinkedIn anyway", so there is
nothing to gain by pretending otherwise.

Layout is checked at 390 (phone), 820 (tablet) and desktop widths. Two details
that are easy to miss: form controls are 16px because iOS Safari zooms the page
when a focused control is smaller and never zooms back, and touch input gets
44px targets via `@media (pointer: coarse)` — Publish sits next to Delete.

**Why it needs a token even on loopback.** Any page you have open can `fetch`
`http://127.0.0.1:5601`. Same-origin policy hides the *response*, but a plain
POST is still delivered and still acts — and acting here means publishing under
your name. Requiring a custom header makes every API call non-simple, so the
browser must preflight it, and the preflight is refused for unknown origins. The
token lives in `.state/ui-token.txt` and is stable across restarts.

The server binds to `127.0.0.1` only, never `0.0.0.0`.

### Themes

The header carries a switch that cycles **System → Light → Dark**. System is the
default and follows the OS, including a schedule that flips at sunset; the other
two pin it regardless. The choice is kept in `localStorage` per browser, and
applied by an inline script in `<head>` so the page never paints the wrong
theme and then flips.

---

## Starting it again after a restart

Nothing installs itself as a service, so after rebooting the machine the app is
simply not running. Two ways to start it:

**Double-click [start.cmd](start.cmd).** It changes to the project folder, runs
the server, and opens your browser. Right-click it → *Send to* → *Desktop
(create shortcut)* if you want it one click away.

**Or from a terminal:**

```bash
cd d:\Work\linkedIn
npm run ui
```

Either way the browser opens on `http://127.0.0.1:5601/?token=…` by itself —
no copying the URL out of the terminal. Set `UI_OPEN_BROWSER=false` in `.env` if
you would rather it did not.

Some things worth knowing:

- **Leave the window open.** The terminal window *is* the server; closing it
  stops the app. `Ctrl+C` to stop it deliberately.
- **The token survives restarts.** It lives in `.state/ui-token.txt`, so a page
  you have already loaded (or installed as an app) keeps working — the token is
  in that browser's `localStorage`. You only need the printed URL on a browser
  that has never opened the app.
- **Nothing else needs re-running.** Your LinkedIn authorization is a stored
  token, not a session: `npm run auth` is needed again only when it expires
  (60 days — the header chip counts down).
- **Address already in use** means it is already running; open
  `http://127.0.0.1:5601` in the browser, or change `UI_PORT` in `.env`.

## Deploying to Vercel

Once deployed there is no terminal and no token to copy. Open
`https://<your-app>.vercel.app`, press **Sign in with LinkedIn**, and the app is
there — on any machine, and installable from the browser as an app on a phone.

### How the deployed app differs

| | local | deployed |
|---|---|---|
| Who gets in | shared token, loopback only | sign in with LinkedIn, checked against the allow-list |
| Authorizing LinkedIn | `npm run auth`, separately | the same sign-in — there is no second step |
| Storage | files under the project | your S3 bucket, one tree per member |
| The page | read from disk per request | a static file on the CDN |
| Drafting model | Ollama, Claude Code or OpenAI | **OpenAI only** (see below) |

Signing in *is* the authorization. LinkedIn returns one access token; it says
who you are and it publishes on your behalf, so there is no way to be signed in
as one member while holding a token that posts as another.

### The pieces

- **[api/\[...path\].ts](api/[...path].ts)** — the whole API in one function. It
  calls `handleHttp` from [src/http/server.ts](src/http/server.ts), so the
  routing table is the same one the local server uses rather than a second copy
  that can drift.
- **[src/http/session.ts](src/http/session.ts)** — sign in, sign out, and the
  signed cookie. The member URN from that cookie wraps every request in
  `runAs(workspaceFor(urn))`, which is what makes two people's drafts disjoint.
- **[scripts/build-public.mjs](scripts/build-public.mjs)** — copies
  `src/http/ui.html` and the PWA files into `public/` at build time, so the page
  comes off the CDN and only real work reaches a function. `src/http/` stays the
  only place any of it is edited.
- **[vercel.json](vercel.json)** — the build command and a 60-second function
  limit, which is what generating a draft needs.

### Try it locally first

```bash
npm run ui:deployed
```

Same server, front door swapped: no shared token, sign in with LinkedIn instead,
every request scoped to whoever signed in. It runs on **port 5602** — its own,
so `npm run ui` can keep running on 5601 while you try this — opens your
browser, and prints what still needs doing before it can let you in.

**One setup step, once.** The OAuth callback is now a route of the app, so add
it to the LinkedIn app's Auth tab alongside the one already there:

```
http://localhost:5602/api/callback
```

*developers.linkedin.com → your app → Auth → OAuth 2.0 settings → Authorized
redirect URLs → pencil → + Add redirect URL.* Exact match, no trailing slash.
Adding it does not disturb `http://localhost:5599/callback`, which `npm run
auth` still uses. Use `localhost`, not `127.0.0.1`: a browser treats them as
different hosts, so mixing them leaves the sign-in cookie on the wrong origin —
the script prints the matching URL for whichever port you run on.

Then **`LINKEDIN_ALLOWED_MEMBERS` must contain you.** Empty means nobody, by
design. `npm run whoami` prints your member URN.

What to check while it is running:

- The page shows **Sign in with LinkedIn** instead of the studio.
- Signing in lands you back in the app with **Sign out** in the header.
- **Your existing drafts are not there** — and that is correct, not data loss.
  Signed in, you are in `users/<your-member-id>/`; the drafts you have now are in
  the unscoped root, where the local install keeps them. Save a new one to watch
  the scoped tree appear.
- Take yourself out of `LINKEDIN_ALLOWED_MEMBERS`, restart, and reload: you are
  refused on the next request and shown why.
- Set `STORAGE_BACKEND=s3` and run it again — that is the combination the
  deployment actually uses, and the last thing worth proving before deploying.

Two differences from the real thing, neither behavioural: the page is served
from `src/http/` rather than the copy in `public/` (same bytes — the build
script copies them), and it is one long-lived process rather than a function per
request (nothing here holds state in memory between requests). If you want the
genuine article, `npx vercel dev` runs the function and the static files exactly
as production does, once the project is linked.

### Steps

1. **A bucket.** `STORAGE_BACKEND=s3` is not optional: a Vercel filesystem is
   read-only and per-instance, so a draft written to disk is gone on the next
   request. See [S3](#s3) for the bucket policy and `npm run migrate:s3` to move
   what you already have.
2. **Register the callback.** On the LinkedIn app's Auth tab, add
   `https://<your-app>.vercel.app/api/callback` as an Authorized redirect URL.
   Matching is exact — no trailing slash.
3. **Set the environment variables** in the Vercel project:

   ```
   LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET
   LINKEDIN_REDIRECT_URI = https://<your-app>.vercel.app/api/callback
   LINKEDIN_ORGANIZATION_URN, LINKEDIN_ORGANIZATION_NAME
   SESSION_SECRET             (32+ chars, and never changed afterwards)
   LINKEDIN_ALLOWED_MEMBERS   (your member URN — empty means nobody)
   REQUIRE_IDENTITY = true
   STORAGE_BACKEND = s3, S3_BUCKET, AWS_REGION, S3_PREFIX
   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
   DRAFT_PROVIDER = openai, OPENAI_API_KEY
   LINKEDIN_FORCE_DRY_RUN = true   (until you have posted once from it)
   ```

   Generate the secret with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   Keep it stable: changing it signs everyone out.
4. **Deploy.** `npx vercel` from the project, or connect the repo in the Vercel
   dashboard.
5. **Sign in, then turn off the dry run** once a preview has gone through.

### Things worth knowing before you deploy

- **`REQUIRE_IDENTITY=true` matters more than it sounds.** Without it a request
  that somehow arrives with no session falls back to one shared tree — the
  second person to sign in would overwrite the first person's LinkedIn token,
  both sessions would keep working, and the next publish would go out under the
  wrong name. With it on, that request throws instead.
- **An empty `LINKEDIN_ALLOWED_MEMBERS` means nobody, not everybody.**
  Registering the LinkedIn app restricts nothing: it is an OAuth client, so any
  member can authorize it, exactly as anyone can "Sign in with Google" to a
  third-party site. On a public URL that list is what stands between a stranger
  and your provider key, your app's LinkedIn quota, and your name on whatever
  they post. Prefer the member URN over an email — an email can change hands.
- **Removing someone from the list signs them out on their next request.** The
  allow-list is checked on every call, not only at sign-in: the session cookie
  lasts 30 days, so checking once would have meant a removed member kept posting
  for up to a month, and revocation that takes a month is not revocation. The
  refused request also clears their cookie, and the app shows them the sign-in
  screen with the reason. Redeploy (or change the environment variable, which
  redeploys) and it takes effect.
- **Someone who was never on the list never gets a session at all.** The check
  runs in the OAuth callback before anything is written, so a refused sign-in
  leaves no workspace, no stored token, and no cookie.
- **Drafting is OpenAI-only there.** Ollama runs on localhost and Claude Code is
  a CLI on your machine; neither exists inside a function. Set
  `DRAFT_PROVIDER=openai`. The MCP server is unaffected — in Claude Code the
  model writes the draft itself.
- **`npm run auth` is still how the local install authorizes.** The two are
  separate stores, so a token obtained on your laptop is not the one the
  deployment uses, and vice versa.
- **Nothing local is uploaded.** [.vercelignore](.vercelignore) keeps `.env`,
  `.state/` (which holds a live 60-day token), and your drafts and published
  posts out of the deploy — `vercel deploy` uploads a directory, not a commit,
  so `.gitignore` is not what decides this.

## Storage

Everything persisted — tokens, drafts, the audit trail, images — goes through
one interface in [src/storage/types.ts](src/storage/types.ts), so the same code
runs against a local directory and against S3.

### What S3 actually costs, and what was done about it

Storage is not the bill. This app's whole store is a few hundred kilobytes —
fractions of a cent a month. S3 charges for **requests**: roughly $0.005 per
1,000 PUT/LIST and $0.0004 per 1,000 GET. So the thing worth minimising is
calls per page load, and the measured numbers were bad:

| | before | after |
|---|---|---|
| `countPublishedToday` — runs on every `/api/status` | **87** | 3 |
| `readAudit(8)` — Recent activity | **86** | 2 |
| `listDrafts` | 4 | 4 |
| `listPublished` | 5 (all records) | 5 (newest 25) |

Four changes, in order of how much they mattered:

- **The daily count no longer reads the log.** It called `readAudit(500)`,
  fetching up to 500 objects in full, to count today's publishes — a number
  that is almost always 0 or 1. The action now rides in the key
  (`<ts>-publish-<nonce>.json`), so the count is a listing with no reads.
- **Two bugs in `readAudit`, both live.** `slice(-take)` with `take === 0`
  returns the *whole* array, so once a legacy `audit.jsonl` was present it
  fetched every entry on every page load. And when that file held more entries
  than the limit, the per-object entries were never read at all — so nothing
  published after the split appeared in Recent activity. Each source is now
  tailed separately and merged.
- **Dry runs are not logged** (`LINKEDIN_AUDIT_DRY_RUNS=false`). They recorded
  that nothing was sent, at one PUT per preview click. `npm run audit:prune`
  clears the ones already there; it prints the plan first and never touches a
  real publish or delete.
- **Sizes come from `stat`**, not `getBytes`. Listing what a published post
  occupies used to download its 124 KB deck to print "124 KB".

The published list is capped at 25 with a **Show older** button rather than
loading every record, since each one is a separate object.

### Moving the local store into S3

```bash
npm run migrate:s3          # plan: lists every object and its size, writes nothing
npm run migrate:s3 -- --yes # copy
```

Because the two backends use identical keys, this is a straight copy — no
mapping, no rewriting. It reads local and writes S3, never the reverse, so
there is no path in it that can touch the working copy; it skips keys already
in the bucket unless `--force`; and it prints the plan and stops unless
`--yes`, because it copies `.state/tokens.json` — the token that publishes
under your name — into a bucket, and that deserves a look first. The UI's
shared secret is deliberately left behind: it is tied to this machine's
loopback listener and is regenerated anywhere else.

Then set `STORAGE_BACKEND=s3` and restart. The local files stay where they
are, so switching back is one variable.

**`STORAGE_BACKEND` is the switch, and it is never inferred.** Having AWS
credentials in the environment does not turn S3 on: this store holds the token
that publishes under your name, and which copy of that is authoritative should
be a decision, not a side effect of an unrelated variable being set. `local`
keeps drafts as files you can open in an editor; `s3` is required on Vercel,
where the filesystem is read-only and per-instance. The UI shows which one is
live as a chip in the header, because S3 settings sitting in `.env` under
`STORAGE_BACKEND=local` look active and do nothing.

Keys are relative POSIX paths and are **identical on both backends**:

```
.state/tokens.json           the LinkedIn token
.state/audit/<ts>-<n>.json   one object per write, never appended
drafts/<id>.md               still a markdown file you can open and edit
drafts/<id>.article.md       long-form prose for an article draft
published/<id>.md            what actually went out, in full
assets/<name>                images and rendered carousel PDFs
```

### Per-member scoping

Keys are prefixed with the signed-in member's workspace. Locally there is no
session and the prefix is empty, so `drafts/x.md` is the file it has always
been. Under a session it becomes `users/<memberId>/drafts/x.md`.

This is not cosmetic. With a single global `.state/tokens.json`, a second person
signing in **overwrites the first person's LinkedIn token** — both sessions keep
working, both pages look normal, and the next publish goes out under the wrong
name. Scoping makes that unexpressible.

The prefix travels in `AsyncLocalStorage` ([storage/workspace.ts](src/storage/workspace.ts))
rather than through every signature: an explicit parameter cannot be forgotten
in one place but cannot be enforced across a dozen, and a handler that forgot to
pass it would silently fall back to *someone's* data. Async context is scoped to
the request that set it, so concurrent requests cannot cross.

`REQUIRE_IDENTITY=true` makes an unscoped access throw instead of falling back
to the local tree — required on any deployment.

### Access control

`LINKEDIN_ALLOWED_MEMBERS` lists who may sign in, by email or member URN.
**Empty means nobody**, because a forgotten env var on a public URL must not
become an open door.

Registering the LinkedIn app restricts nothing on its own — it is an OAuth
client, so any member can authorize it, exactly as anyone can "Sign in with
Google" to a third-party site. This list is what stands between a stranger and
your provider key, your app's LinkedIn rate limit (limits are per *application*,
not per user), and your developer account's standing.

Prefer a URN over an email: an email can change hands, a URN cannot.

### Two things follow from the key shape

- **The audit log is one object per entry**, not one appended file. S3 has no
  append, so a single log object would mean read-modify-write, which loses
  entries when two writes overlap. The timestamp is in the key, so
  "what went out today" is a prefix listing rather than a read.
- **A published draft moves to `published/`** and leaves `drafts/`. The record
  is not merely deleted, because the audit entry keeps only a 120-character
  summary and a personal post cannot be read back from the API —
  `r_member_social` is a closed permission — so this file is the only full copy
  of what went out under your name. The copy is written before the original is
  removed, so a failure between the two leaves a duplicate, never a hole.

`STORAGE_BACKEND` selects the backend and defaults to `local`. It is never
inferred from the presence of AWS credentials: a store holding a token that
publishes under your name should be chosen deliberately.

### S3

```bash
STORAGE_BACKEND=s3
S3_BUCKET=your-bucket
AWS_REGION=ap-south-1
S3_PREFIX=linkedin-agent      # optional
```

Credentials come from the standard AWS chain (`AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`, or an instance role) — never from `.env`.
`S3_ENDPOINT` plus `S3_FORCE_PATH_STYLE=true` points the same backend at any
S3-compatible store: Cloudflare R2, MinIO, Backblaze.

Three details that are easy to get wrong and are handled here:

- **Absence vs. failure.** S3 signals a missing key with an error, not an empty
  result. Only 404/`NoSuchKey` becomes `null`; a denied or throttled request
  throws, because a permissions problem that read as "no drafts yet" would be
  worse than an outage.
- **Listings are paginated.** `ListObjectsV2` caps at 1000 keys and truncates
  silently, which would quietly hide older audit entries once the log grew.
- **One level only.** S3 has no directories, so a raw prefix query returns
  everything nested beneath it. Both backends filter to a single level so a
  draft listing cannot become a full-tree scan.

Objects are written with `ServerSideEncryption: AES256` regardless of the
bucket's default, since these hold a token that publishes as you.

**The bucket must be private.** Nothing here makes an object public, but a
bucket with public read configured would expose your token file.

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
| `linkedin_delete_draft` | Delete an unpublished draft, its prose and its deck (needs `confirm: true`) |
| `linkedin_archive_published_drafts` | Move drafts marked published out of `drafts/` |

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
- Changing `LINKEDIN_PROFILE_LINK_LABEL` reaches drafts written under the old
  one. Idempotence used to mean "leave it entirely alone", which froze the
  label: a draft signed off with `More: <url>` kept saying `More:` forever,
  because the URL was already in the text. A trailing sign-off line — a short
  label and the URL, nothing else — is now restamped with the configured label.
  The URL anywhere else is the author's own sentence and is untouched.
- `.env` is read once, at startup. Editing it while `npm run ui` is running
  changes nothing until you restart the process.
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

Nothing is ever attached on its own. Web image search exists (below) but every
import is an explicit click, because publishing an image you do not hold rights
to, under a company page, is a real exposure.

### Making one instead of finding one

**Design an image** draws a card — eyebrow, one line, footnote, in the deck's
own palette — on a `<canvas>` in the browser, and attaches the PNG. It is the
answer to the licence problem: an image you drew is one you own.

The browser is the renderer, so there is no headless Chrome to install and it
works identically on a deployment. Canvas 2D directly rather than HTML→PNG:
`foreignObject` rasterisation is fragile about fonts and taints the canvas in
some browsers, while drawing gives real font metrics and the same auto-fitting
headline the deck uses.

**Write the line with AI** asks the model for the one sentence worth putting on
a card — the post's central claim, stated so it stands alone when someone sees
the image without the post — under the same rule as everything else: nothing on
the card that is not already in the post, and never a `[MARKER]`.

## Research (Brave Search)

Set `BRAVE_API_KEY` (one free key covers web and image search) and three things
light up, in the UI and as MCP tools:

| | UI | MCP |
|---|---|---|
| Topic ideas that go where the coverage does not | **Suggest topics** | `linkedin_suggest_topics` |
| Sources to ground a draft in | **Find sources** | `linkedin_research` |
| Image search with explicit import | **Search images** | `linkedin_search_images`, `linkedin_import_image_url` |

Sources are handed to the model with one rule attached: **a figure may appear
in the post only if a supplied source says it**, cited inline as `[1]`, `[2]`;
anything else stays a `[NUMBER: …]` marker. Snippets are never copied — the
prompt forbids it, and the model only ever sees titles and excerpts.

**Topic ideas are written against the results, not from them.** The fifteen
results are treated as *what already exists*: the model is asked what they all
say, what they disagree on and what none of them touches, and every suggestion
has to go somewhere they do not — the counter-argument, the skipped tradeoff,
the failure mode, the practitioner's view under a vendor announcement. Each one
carries a `differs` line saying what the coverage says and how it departs.

That instruction is not self-enforcing, so it is also checked: a suggestion
sharing 70% of its content words with a result's headline — or with a topic you
have already drafted or published — is dropped before you see it, and the count
of dropped ones is reported. Restating a headline that is already on page one
of a search adds nothing and reads as a summary of someone else's article.

**Images: read this before importing one.** Brave's image API returns no
licence information at all. An image it finds is an image *you* are responsible
for having the rights to publish, under your name or the company page. So
import is never automatic — it is a click with a confirmation — and the source
URL and page are written beside the file (`assets/<name>.source.json`) so the
question can be answered later. If you want stock imagery that is safe by
construction, Unsplash and Pexels have free APIs with explicit licences; wiring
one of those is a small change to `core/research.ts`.

## Articles

An article draft has two ways to reach the feed, chosen per draft
(`articleMode`) and in the UI by the format buttons:

- **Carousel** (default) — the prose renders to a square PDF and posts as a
  LinkedIn document: a swipeable deck with `body` as the short summary above it.
  `# Headings` split the slides. **Render PDF preview** shows the exact bytes
  LinkedIn will receive, inline.

  Two colour schemes, `dark` and `light`. The **Deck theme** picker sets it per
  draft and remembers the choice for new ones, so it is a UI setting in
  practice; `LINKEDIN_DECK_THEME` only decides what "default" means for a draft
  that has never chosen.
- **Text post** — the prose is posted as the text itself, headings as their own
  lines, with `images` attached. Same 3000-character cap as any post, checked
  at save time.
- **Manual** (`articleMode: "manual"`) — a full-length article written for
  LinkedIn's own editor. Nothing publishes it, and that is not an omission:
  the Articles API has no create endpoint, so the honest thing is to write the
  piece well and hand it over rather than pretend.

  It has no length limit and is measured in words. The Article panel renders it
  as it reads on an article page, and **Copy for LinkedIn** puts *both*
  `text/html` and `text/plain` on the clipboard — so the editor receives real
  headings, bold and lists instead of literal `##`. `publishDraft` refuses it at
  the core, with the reason, so the MCP tools hit the same wall as the UI. The
  title is read from the article's own `# ` line rather than asked for twice.

The author link (`LINKEDIN_PROFILE_LINK`) lands on both: appended to the post
text at publish time in either mode, and printed on the deck's last page — a
carousel gets reshared away from the text that carried it.

### Pages that do not look empty

A 720pt square page holds roughly 130 words at the smallest body size. Asking a
model for "about 60 words a slide" therefore produced decks that were half
white space, which is the commonest way one of these looks unfinished. Three
things fix it, and they work together:

- The prompt asks for 90–130 words a section (`Length` moves that band), and
  says why: a section too thin for a page is not a section, it is a paragraph
  belonging to its neighbour.
- The renderer measures each page and **grows the body type to fill it**, 21pt
  up to 32pt. Pagination still measures at 21pt, so a page can only gain type,
  never overflow.
- A section that really is one sentence becomes a **statement page**: up to
  46pt, vertically centred, in the heading's colour. Deliberate, rather than a
  slide someone forgot to finish.

Lists survive too — `- item` lines are typeset as a real list with a hanging
indent instead of being joined into one run-on paragraph.

The Article box shows the section count and flags any section under 45 words
while the prose is still editable.

LinkedIn's own long-form Articles (the /pulse editor) are not reachable from
any API; the document post is the long-form an integration can publish.

## Draft providers (browser extension only)

The MCP path needs none of this — in Claude Code, Claude writes the draft in
your session and the server only publishes it. A browser extension has no model
of its own, so it picks a backend:

| Provider | Cost | Needs |
|---|---|---|
| `ollama` | free | Ollama running locally, and enough free RAM to load the model |
| `openai` | metered | `OPENAI_API_KEY`. `OPENAI_BASE_URL` also points at any OpenAI-compatible endpoint |
| `claude-code` | free | Claude Code CLI (npm or native install); uses your existing subscription, no API key. Model via `CLAUDE_CODE_MODEL` or the picker: `sonnet`, `opus`, `fable` |

Every provider takes a per-request model, and the UI shows a **Model** picker
beside the provider: Ollama lists what is installed, Claude Code its aliases,
OpenAI the configured model.

**Claude Code runs sealed.** Left at its defaults the CLI is an agentic coding
session in the project directory — every tool enabled, your `CLAUDE.md` files
loaded — which meant it could read `.env` if it judged a file relevant, and its
reply was occasionally conversational rather than the prose asked for. It now
runs with `--tools ""`, its own `--system-prompt-file`,
`--exclude-dynamic-system-prompt-sections`, `--no-session-persistence`, and
`--output-format json`, from a temp directory. (`--bare` would be the obvious
flag, but it skips the keychain read and breaks subscription auth.)

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

### The audit log — what "Recent activity" reads

Every write goes through `appendAudit`, called inside `publishPost()`, so a
publish cannot happen without a record of it. **Dry runs are recorded too**,
which is why the list fills up with them while you are testing.

One JSON object per entry, at `.state/audit/<timestamp>-<nonce>.json`:

```json
{ "ts": "2026-09-06T19:55:12.977Z", "action": "publish", "target": "member",
  "authorUrn": "urn:li:person:…", "urn": "urn:li:share:…",
  "summary": "first 120 characters of the post", "dryRun": true }
```

An object per entry rather than one appended file, because **S3 has no append**:
writing entry N+1 into a single object would mean read, add a line, put it back
— and two overlapping writes lose one. The key carries the timestamp, so a
prefix listing answers "what went out today" without reading anything, and a
lexical sort is chronological. `.state/audit.jsonl` from before this change is
still folded in on read, so nothing already published was orphaned.

It is not only a record: `countPublishedToday()` counts today's non-dry-run
entries, which is what enforces `LINKEDIN_DAILY_POST_LIMIT`. **Recent activity**
in the UI is the last few entries, newest first; `linkedin_audit_log` is the
same data in Claude Code.

`publishPost()` is the single choke point — every path reaches LinkedIn through
it, so adding a new caller cannot bypass these.

## Layout

```
start.cmd            double-click launcher: runs the UI, opens the browser
vercel.json          build command, function limits
.vercelignore        keeps .env, .state/ and your content off the deploy
api/
  [...path].ts       the whole API as one Vercel function; calls handleHttp
scripts/
  build-public.mjs   copies src/http/* into public/ at deploy time
src/
  config.ts          .env loading, scopes, typed config
  open.ts            hands a URL to the OS browser; shared by auth and the UI
  state/
    tokens.ts        token store, expiry, refresh
    audit.ts         append-only log, daily cap
  linkedin/          thin API wrapper — swappable
    client.ts        auth headers, versioning, error translation
    text.ts          Little Text Format escaping, length limits
    posts.ts  images.ts  social.ts  analytics.ts  me.ts
  scripts/
    migrate-storage.ts  copies the local store into S3; reads local, writes S3
    prune-audit.ts      deletes dry-run audit entries; never a real publish
  storage/           one interface, two backends — local files or S3
    types.ts         the contract, and why everything is async
    local.ts         keys map onto paths; a draft stays an editable file
  core/              product logic — reused by every front end
    publish.ts       the single publish choke point
    drafts.ts        draft/approve/publish state machine, archive, delete
    placeholders.ts  refuses to publish text with unfilled [MARKERS]
    research.ts      Brave web/image search, topic ideas, guarded image import
    compose.ts       house style, article prompt, source grounding
    access.ts        allowlist for deployments
    targets.ts       me vs company resolution
  mcp/server.ts      MCP adapter (thin)
  http/              web UI adapter — same core, two front doors
    server.ts        routes and handleHttp; local listener guarded to the entry
    auth.ts          loopback is not a trust boundary; see the note there
    session.ts       deployed sign-in: LinkedIn OAuth, signed cookie, workspace
    ui.html          the page itself, no build step
    manifest.json    PWA metadata
    sw.js            shell cache only — never /api/
    icons/           generated PNGs, 192 and 512
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
