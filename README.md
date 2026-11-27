# ZEUS — Static Movie & TV Streaming Front-End

ZEUS is a static streaming UI: browse trending movies & TV shows,
anime, genres and search via the [TMDB API](https://www.themoviedb.org/), then
watch through official third-party embeds. The entire site is plain
HTML/CSS/JavaScript served verbatim from [`public/`](public/) — **no build step,
no framework** — deployable to any static host and pre-configured for
Cloudflare Pages.

> ⚠️ **Disclaimer** — ZEUS does not host any videos. All content is provided by
> non-affiliated third parties. For informational and educational purposes only.

---

## Push this repo to GitHub

The repository ships with a clean, meaningful commit history on branch `main`
— no rewriting needed:

```bash
git remote add origin https://github.com/<your-username>/zeus.git
git push -u origin main
```

Then connect it to Cloudflare Pages for automated deploys (see
[Deploying to Cloudflare Pages](#deploying-to-cloudflare-pages)).

## Repository layout

| Path | What it is |
| --- | --- |
| `public/` | **The website.** All HTML pages, `style.css`, page scripts (`index.js`, `api.js`, `watch.js`, …), `config.js` (TMDB settings), assets and `_redirects` (clean-URL rules). This folder is the deployable site root. |
| `supabase/migrations/` | Schema, access rules and server-checked functions for the in-player Watch Party. |
| `party-worker/` | Legacy Worker backend for the separate `party.html` client; not used by the in-player party. |
| `party-server/` | Superseded Node/Socket.IO party backend. Dead code, kept for reference. |
| `src/`, `next.config.ts`, … | Next.js dev-server wrapper used for local development. Rewrites serve `public/index.html` at `/` and map the clean routes (`/anime`, `/genre`, `/discover`) so local URLs match production. |
| `worklog.md` | Detailed per-task development history. |

## Pages

Home (`index.html`) · Anime (`anime.html`) · Discover/Browse (`browse.html`) ·
Movie & TV detail (`movie.html`, `tv.html`) · Watch (`watch.html`) · Search
(`search.html`) · Genre (`genre.html`) · Watchlist (`watchlist.html`) · Login /
Settings / Account (`login.html`, `settings.html`, `account.html`) · Watch Party
(in the `watch.html` player; `party.html` is the older, separate client) · Legal
(`privacy.html`, `terms.html`, `dmca.html`).

## Local development

```bash
bun install          # or npm install
bun run dev          # Next.js dev server on http://localhost:3000
```

The dev server serves the static site at `/` (see the rewrites in
`next.config.ts`), so local URLs match the deployed clean routes.

Other scripts: `bun run lint` (ESLint), `bun run db:push` (Prisma schema →
SQLite; copy `.env.example` to `.env` first — only needed for the Next.js
scaffold, the static site itself uses no database).

> **Note:** the TMDB API key lives in `public/config.js`. A static site runs
> entirely in the browser, so the key is public by design — get your own free
> key at <https://www.themoviedb.org/settings/api> and swap it in.

## Deploying to Cloudflare Pages

ZEUS is pre-configured for a zero-build Cloudflare Pages deploy:

| Setting | Value |
| --- | --- |
| Framework preset | None |
| Build command | *(empty)* |
| Build output directory | `public` |

Option A — **Git integration (recommended):** push this repo, create a Pages
project, connect it, and enter the settings above. `public/_redirects` maps the
clean routes (`/anime`, `/genre`, `/discover` → their pages; everything else →
`index.html`).

Option B — **Direct upload:** upload the contents of `public/` as the site root.

## In-player Watch Party

The **Party** button over the movie or episode opens the ZEUS party panel on top
of the player (the top bar has the same button). Guests join by code or invite
link, see participants and chat. This is ZEUS UI over a cross-origin iframe, not
a modification of Vidora's own document. Use the ZEUS fullscreen button beside
**Party** to keep the overlay available in fullscreen; the iframe's own
fullscreen cannot show its parent page's controls. The server, not just the UI,
enforces the host role. Leaving restores ordinary Vidora viewing; the host can
leave and rejoin in the same tab, or end the room for everyone. Rooms expire 12
hours after creation. The host chooses a party player:

- **VidSpark** and **CineSrc** expose play/pause/seek controls. Playback and
  autoplay still depend on the third-party player, source and each device.
- **BingeAPI (experimental)** documents those controls too and advertises
  servers with up to 4K, plus OpenSubtitles search in 42 languages and custom
  subtitle files. Quality, titles and languages vary; no particular stream or
  subtitle is guaranteed. Real two-viewer playback has not been verified.
- **Vidora (manual follow)** is the default. The host's documented player
  events share an approximate play/pause state and timestamp; guests can compare
  their own reported time and get manual-follow instructions. A playing clock
  that stops receiving updates becomes stale instead of advancing indefinitely.
  Each viewer must play, pause, seek and select a server themselves: Vidora
  documents no inbound commands or server-selection API. **Try reload at host
  time** makes a best-effort `startAt` request, not a remote seek; Vidora's saved
  progress can override it. A newly created room can keep an already-loaded
  Vidora iframe playing rather than interrupting it. For TV, events that do not
  identify the current season and episode cannot be shared safely. Ordinary,
  non-party viewing remains Vidora.

For CineSrc and BingeAPI, the host can turn **Match host’s streaming server** on
or off (on by default). When the host player reports a server change, guests
reload once with that server as the documented *preference* and the current
room position. Neither provider documents a runtime server setter: they may
ignore the preference or fall back. The panel reports a match only after the
local player reports the same server; mismatches are shown and **Resync my
player** retries. If the host does not report a recognized server, matching
cannot be confirmed. VidSpark and Vidora do not expose the needed server API.

Click inside an iframe if autoplay is blocked. For VidSpark, CineSrc and
BingeAPI, **Resync my player** retries following the room or reloads an
unresponsive player. For Vidora, the reload button uses its documented start
parameter and cannot guarantee where the player resumes. A BingeAPI server event
permits a command attempt but does not prove that the stream has loaded. Episode
changes made inside an embed are not shared; return to the room's episode or
start a new room. A Realtime subscription being established is not proof of
broadcast delivery; the client also checks the room periodically.

The configured ZEUS Supabase project has the migrations below recorded and
anonymous sign-ins enabled. For a fresh project or fork, complete these steps
before creating rooms (do not reapply recorded migrations to ZEUS):

1. Review and apply, in order, `supabase/migrations/20261127142027_watch_party.sql`,
   `supabase/migrations/20261127153149_watch_party_source_sync.sql`, and
   `supabase/migrations/20261127172021_watch_party_vidora_assist.sql` to the
   intended project. The first creates room/member/chat tables with RLS,
   checked RPC functions, and a private Realtime Broadcast read policy. The
   second adds host-controlled server preferences and the additional players.
   The third adds host-only Vidora observations and distinguishes an actual
   observation from the initial room clock.
2. Enable **Anonymous Sign-Ins** under Supabase Authentication providers. The
   project's anonymous sign-in rate limits apply; before a public launch, add
   CAPTCHA-token handling and appropriate quotas/abuse monitoring. Enabling a
   CAPTCHA before the client handles its token will prevent guest sign-ins.
3. Make sure Supabase Realtime and the Data API are available. The client uses
   private channels and receives data-free wakeups; it fetches authorized room
   snapshots through RPC and falls back to periodic checks if Realtime fails.
4. `public/watchparty.js` contains this project's **publishable** URL/key. A fork
   should use its own project and publishable key; never place a secret or
   `service_role` key in the browser. The self-hosted Supabase JavaScript client
   is version 2.119.2, with its license in `public/vendor/`.

A room code is an invitation, so share it only with trusted people. The invite
uses a URL fragment, and the Supabase session survives a reload of the tab.
Browsers may copy session storage to a duplicated tab or one opened with an
opener, so use separate browsers/profiles or fresh tabs without an opener for
independent viewers. **Security note:** `watch.html` already loads third-party
advertising scripts in the page's own JavaScript
context. Such scripts can read the invitation and session storage and act as
the viewer. Audit or isolate those scripts before treating rooms as private in
production. Each room stores up to 200 chat messages and snapshots return the
latest 50. Expired rooms and their messages
are deleted lazily on new room creation, at least 12 hours after expiry. If no
new room is created, cleanup is delayed: configure a trusted scheduled job if
a firm deletion window is required. Supabase anonymous Auth users also need a
separate administrative retention/cleanup policy; deleting the Auth identity
prevents that session from rejoining as host. The migration and Auth settings
must be in place before this is a working live feature; a player iframe loading
alone does **not** prove that media or synchronization works.

For regression checks, run `node --test tests/*.test.mjs`. The optional SQL
test uses `@electric-sql/pglite` (set `ZEUS_PGLITE_MODULE` to its
`dist/index.js`). The optional `tests/watchparty-browser.mjs` and
`tests/watchparty-startup-browser.mjs` use Playwright/Chromium specified via
`ZEUS_PLAYWRIGHT_MODULE` and `ZEUS_CHROMIUM_PATH`. The SQL test stubs Supabase
Auth/Realtime; both browser tests mock Supabase and the player iframes. Passing
them does **not** verify actual video, Realtime delivery, or two-viewer sync.
To test those, open the preview in two independent browser sessions, create a
room and join it, then check host play/pause/seek, switch the host's internal
server and compare both player menus and timestamps. Check the fallback warning
if a server is unavailable. For Vidora, verify that host events update the
manual-follow display while the guest's player stays under the guest's control;
try a reload and check whether Vidora actually honors the requested time. Use
real devices/networks and verify subtitles and quality for the title being
watched.

The older `party.html` page is a separate YouTube/direct-MP4 client and still
requires the legacy Worker URL; the in-player Watch Party does not use it.

## Scroll performance architecture (the 60fps pipeline)

The site ships a permanent scroll-lag fix built on four layers:

1. **GPU acceleration** — the page wrapper, header and hero are compositor
   layers (`translateZ(0)` / `will-change: transform`); hero and background
   glow use `isolation: isolate` so their gradients never repaint the scroll
   layer.
2. **CSS containment** — rows, card grids and genre tiles use
   `content-visibility: auto` with `contain-intrinsic-size`, so offscreen
   content costs zero layout/paint on catalog pages with hundreds of cards.
3. **Passive + rAF JavaScript** — every `scroll` listener is
   `{ passive: true }` and rAF-throttled; hot paths read only
   compositor-cached values (`window.scrollY`, `row.scrollLeft`) — never
   `offsetHeight`/`getBoundingClientRect()` (no forced synchronous reflow).
   Layout metrics are cached on load/resize (discrete events).
4. **Velocity gating** — a scroll-velocity module flips
   `body[data-scroll-fast]` during fast flings and scrollbar drags: the
   frosted-glass `backdrop-filter` swaps to a pre-mixed translucent plate,
   card hover zoom is suppressed, and decorative lightning arcs pause. The
   full frosted look returns ~140 ms after the scroll settles.

The header/nav pill animates exclusively with `transform: translate3d()` and
`opacity`; gold scroll-state tinting is a pre-rendered opacity crossfade.
`prefers-reduced-motion` disables all of it.

## License

[MIT](LICENSE) — provided as-is for educational purposes. ZEUS hosts no
content; all metadata comes from TMDB and all playback from third-party embeds.
