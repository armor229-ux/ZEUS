# ZEUS — Static Movie & TV Streaming Front-End

ZEUS is a fast, dependency-free streaming UI: browse trending movies & TV shows,
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
| `party-worker/` | Watch Party backend — Cloudflare Worker + Durable Objects (WebSocket rooms, host sync, chat). Deploy once with `npx wrangler deploy`. |
| `party-server/` | Superseded Node/Socket.IO party backend. Dead code, kept for reference. |
| `src/`, `next.config.ts`, … | Next.js dev-server wrapper used for local development. Rewrites serve `public/index.html` at `/` and map the clean routes (`/anime`, `/genre`, `/discover`) so local URLs match production. |
| `worklog.md` | Detailed per-task development history. |

## Pages

Home (`index.html`) · Anime (`anime.html`) · Discover/Browse (`browse.html`) ·
Movie & TV detail (`movie.html`, `tv.html`) · Watch (`watch.html`) · Search
(`search.html`) · Genre (`genre.html`) · Watchlist (`watchlist.html`) · Login /
Settings / Account (`login.html`, `settings.html`, `account.html`) · Watch Party
(`party.html`) · Legal (`privacy.html`, `terms.html`, `dmca.html`).

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

## Watch Party backend

Party rooms need the Cloudflare Worker deployed once:

```bash
cd party-worker
npx wrangler deploy
```

Then open any party page, paste the worker URL
(`https://zeus-party.<your-subdomain>.workers.dev`) into the **Party backend
URL** field and press Save — it is remembered per browser
(`localStorage: zeus_party_backend`).

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
