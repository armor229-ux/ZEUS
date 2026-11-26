# Zeus — clean route inventory (verification doc)
Main: e1d01358ac1cdba74ed636b21df288dc7fa4d99a.

## git-tracked HTML routes (`git ls-files public | grep '\.html$'`)
- `/` → public/index.html
- `/anime` → public/anime.html
- `/genre` → public/genre.html
- `/discover` → public/browse.html
- `/search` → public/search.html
- `/watchlist` → public/watchlist.html
- `/library` → public/watchlist.html
- `/settings` → public/settings.html
- `/account` → public/account.html
- `/login` → public/login.html
- `/movie` → public/movie.html
- `/tv` → public/tv.html
- `/watch` → public/watch.html
- `/party` → public/party.html
- `/terms` → public/terms.html
- `/privacy` → public/privacy.html
- `/dmca` → public/dmca.html

## clean-route rules in next.config.ts (`rewrites.beforeFiles`)
`/anime → /anime.html`, `/genre → /genre.html`, `/discover → /browse.html`,
`/search → /search.html`, `/watchlist → /watchlist.html`, `/library → /watchlist.html`,
`/settings → /settings.html`, `/account → /account.html`, `/login → /login.html`,
`/movie → /movie.html`, `/tv → /tv.html`, `/watch → /watch.html`,
`/party → /party.html`, `/terms → /terms.html`, `/privacy → /privacy.html`,
`/dmca → /dmca.html`, `/ → /index.html`. Fallback: `/* → /index.html` (afterFiles).

## details
movie.html?id= / tv.html?id= (from public/account.js detailHref + api.js),
plus vidora.ac/movie/{tmdbId} and vidora.ac/tv/{tmdbId}/{s}/{e}.
