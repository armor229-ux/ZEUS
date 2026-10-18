/* ============================================================
   ZEUS - api.js
   TMDB API layer (all fetch functions) + shared UI helpers
   used by every page: card builders, skeletons, error states,
   lazy-image fallbacks and the common UI initializer.
   ============================================================ */

'use strict';

/* ============================================================
   1. CORE FETCH LAYER (with full error handling)
   ============================================================ */

/**
 * Build a fully-qualified TMDB endpoint URL.
 * @param {string} endpoint  e.g. '/movie/popular'
 * @param {Object} params    query-string parameters
 * @returns {string} URL with api_key attached
 */
function buildTMDBUrl(endpoint, params = {}) {
  const url = new URL(API_BASE_URL + endpoint);
  url.searchParams.append('api_key', API_KEY);
  Object.keys(params).forEach((key) => {
    if (params[key] !== undefined && params[key] !== null) {
      url.searchParams.append(key, params[key]);
    }
  });
  return url.toString();
}

/**
 * Generic TMDB request wrapper. Handles HTTP errors, TMDB
 * error payloads and network failures, always rejecting with
 * a readable Error message.
 */
async function fetchFromTMDB(endpoint, params = {}) {
  const url = buildTMDBUrl(endpoint, params);
  let response;
  try {
    response = await fetch(url);
  } catch (networkError) {
    throw new Error('Network error — please check your internet connection.');
  }

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      const errorBody = await response.json();
      if (errorBody && errorBody.status_message) {
        message = errorBody.status_message; // e.g. "Invalid API key: ..."
        if (response.status === 401) {
          message += ' — add your TMDB API key in config.js';
        }
      }
    } catch (parseError) {
      /* response was not JSON, keep default message */
    }
    throw new Error(message);
  }

  try {
    return await response.json();
  } catch (parseError) {
    throw new Error('Received an invalid response from TMDB.');
  }
}

/* ============================================================
   2. TMDB ENDPOINT FUNCTIONS
   ============================================================ */

/** Trending movies + TV this week (mixed media). */
async function getTrending(page = 1) {
  return fetchFromTMDB('/trending/all/week', { page });
}

/** Trending movies + TV TODAY — powers the "TOP 10 Today" rail. */
async function getTrendingToday(page = 1) {
  return fetchFromTMDB('/trending/all/day', { page });
}

/** TV shows with an episode airing today. */
async function getAiringTodayTV(page = 1) {
  return fetchFromTMDB('/tv/airing_today', { page });
}

/** Alias used by the browse page. */
async function getTrendingAll(page = 1) {
  return getTrending(page);
}

/** Popular movies. */
async function getPopularMovies(page = 1) {
  return fetchFromTMDB('/movie/popular', { page });
}

/** Top-rated movies (Top IMDB). */
async function getTopRatedMovies(page = 1) {
  return fetchFromTMDB('/movie/top_rated', { page });
}

/** TV shows currently on the air (Latest TV Shows). */
async function getOnTheAirTV(page = 1) {
  return fetchFromTMDB('/tv/on_the_air', { page });
}

/** Popular TV shows. */
async function getPopularTV(page = 1) {
  return fetchFromTMDB('/tv/popular', { page });
}

/** Movie details with credits (cast) and similar movies attached. */
async function getMovieDetails(movieId) {
  return fetchFromTMDB(`/movie/${movieId}`, {
    append_to_response: 'credits,similar'
  });
}

/** TV details with credits (cast) and similar shows attached. */
async function getTVDetails(tvId) {
  return fetchFromTMDB(`/tv/${tvId}`, {
    append_to_response: 'credits,similar'
  });
}

/** Lightweight TV details (no credits/similar) — used to read a
    show's next/last episode info for the "Current & upcoming TV
    shows" row (list endpoints don't include episode data). */
async function getTVBrief(tvId) {
  return fetchFromTMDB(`/tv/${tvId}`);
}

/** Full episode list for one season of a TV show. */
async function getSeasonDetails(tvId, seasonNumber) {
  return fetchFromTMDB(`/tv/${tvId}/season/${seasonNumber}`);
}

/** Multi search (movies, TV and people — people filtered by caller). */
async function searchMovies(query, page = 1) {
  return fetchFromTMDB('/search/multi', {
    query,
    page,
    include_adult: 'false'
  });
}

/** Movie genre catalog. */
async function getGenres() {
  return fetchFromTMDB('/genre/movie/list');
}

/** TV genre catalog. */
async function getTVGenres() {
  return fetchFromTMDB('/genre/tv/list');
}

/** Discover movies by genre, sorted by popularity. */
async function discoverByGenre(genreId, page = 1, type = 'movie') {
  return fetchFromTMDB(`/discover/${type}`, {
    with_genres: genreId,
    page,
    sort_by: 'popularity.desc',
    include_adult: 'false'
  });
}

/** Popular movies on one streaming provider (US region) — Netflix, Disney+, ... */
async function discoverByProvider(providerId, page = 1) {
  return fetchFromTMDB('/discover/movie', {
    with_watch_providers: providerId,
    watch_region: 'US',
    sort_by: 'popularity.desc',
    page,
    include_adult: 'false'
  });
}

/** Popular TV shows on one streaming provider (US region) —
    paired with discoverByProvider so each brand tab can show a
    mixed movies + TV rail. */
async function discoverTVByProvider(providerId, page = 1) {
  return fetchFromTMDB('/discover/tv', {
    with_watch_providers: providerId,
    watch_region: 'US',
    sort_by: 'popularity.desc',
    page,
    include_adult: 'false'
  });
}

/** Newest movie releases with real traction (>= 50 votes) — "Recently added in 4K". */
async function getRecentMovies(page = 1) {
  return fetchFromTMDB('/discover/movie', {
    sort_by: 'release_date.desc',
    'vote_count.gte': 50,
    page,
    include_adult: 'false'
  });
}

/* ============================================================
   2b. TRAILER VIDEO SOURCES (shared: hero + card hover)
   ------------------------------------------------------------
   CARD HOVER trailers play through a privacy-enhanced
   youtube-nocookie.com <iframe> with controls=0 +
   modestbranding=1 (zero player UI) and the crucial
   allow="autoplay; encrypted-media; picture-in-picture"
   attribute — modern browsers block iframe video autoplay
   without it, which is why hover trailers stayed black.
   The HERO trailer keeps the native HTML5 <video> chain below
   (it powers the hero mute toggle). While any trailer loads,
   the Ken Burns artwork pan keeps the card/slide alive; when
   every source fails the pan/zoom simply continues.
   ============================================================ */

/** In-memory cache: `${mediaType}-${id}` -> YouTube video key (or null). */
const trailerKeyCache = new Map();

/**
 * Fetch a title's trailer key from TMDB (/movie/{id}/videos or
 * /tv/{id}/videos). Picks the first result with type "Trailer"
 * (falling back to a Teaser / any video), and caches the outcome
 * in memory so repeated hero slide changes and card hovers never
 * re-fetch. Resolves null when the title has no usable trailer —
 * callers then go straight to the Ken Burns fallback.
 */
async function getTrailerKey(id, mediaType = 'movie') {
  const type = mediaType === 'tv' ? 'tv' : 'movie';
  const cacheKey = `${type}-${id}`;
  if (trailerKeyCache.has(cacheKey)) return trailerKeyCache.get(cacheKey);

  let key = null;
  try {
    const data = await fetchFromTMDB(`/${type}/${id}/videos`);
    const videos = (data && data.results) || [];
    // YouTube-hosted keys are what the direct-stream proxies serve,
    // so prefer them — but any video key is worth a try.
    const trailer =
      videos.find((v) => v.site === 'YouTube' && v.type === 'Trailer') ||
      videos.find((v) => v.type === 'Trailer') ||
      videos.find((v) => v.site === 'YouTube' && v.type === 'Teaser') ||
      videos.find((v) => v.type === 'Teaser') ||
      videos.find((v) => v.site === 'YouTube') ||
      null;
    key = trailer ? trailer.key : null;
  } catch (error) {
    key = null;
  }
  trailerKeyCache.set(cacheKey, key);
  return key;
}

/**
 * Build the ordered list of DIRECT video stream URLs for a title.
 *
 * The chain is ordered by real-world reliability of public
 * direct-MP4 proxies (every URL feeds a native <video> tag, so
 * no player UI can ever appear):
 *   1. Invidious "latest_version" endpoints — healthy public
 *      instances first (720p itag 22, then 360p itag 18), plus a
 *      &local=true variant that streams the bytes through the
 *      instance itself (works even when googlevideo redirects
 *      are region-locked).
 *   2. VidSrc trailer endpoint (movies only) — last resort.
 * If a source errors or hangs, mountTrailerVideo() advances to
 * the next one; the winning source is cached per title so
 * repeat hovers are instant.
 */
function buildTrailerVideoSources(tmdbId, youtubeKey, mediaType = 'movie') {
  const sources = [];
  if (youtubeKey) {
    sources.push(`https://inv.nadeko.net/latest_version?id=${youtubeKey}&itag=22`);
    sources.push(`https://inv.nadeko.net/latest_version?id=${youtubeKey}&itag=18&local=true`);
    sources.push(`https://yewtu.be/latest_version?id=${youtubeKey}&itag=18`);
    sources.push(`https://invidious.nerdvpn.de/latest_version?id=${youtubeKey}&itag=18`);
    sources.push(`https://iv.ggtyler.dev/latest_version?id=${youtubeKey}&itag=18`);
    sources.push(`https://invidious.f5.si/latest_version?id=${youtubeKey}&itag=18`);
    sources.push(`https://iv.melmac.space/latest_version?id=${youtubeKey}&itag=18`);
  }
  if (tmdbId && mediaType !== 'tv') {
    sources.push(`https://vidsrc.xyz/movies/latest/trailer/${tmdbId}`);
  }
  return sources;
}

/* ============================================================
   1b. TRAILER SOURCE RESOLUTION CACHE
   ------------------------------------------------------------
   Remembers, per title, WHICH direct stream actually played
   (or that they all failed). Repeat hovers then start the
   winning source instantly — or skip the network entirely and
   go straight to the Ken Burns fallback.
   ============================================================ */
const trailerSourceCache = new Map(); // `${mediaType}-${id}` -> { status:'ok', src } | { status:'failed' }

function trailerCacheKey(id, mediaType = 'movie') {
  return `${mediaType === 'tv' ? 'tv' : 'movie'}-${id}`;
}

/** Ordered source list for a title, with a previously winning
 *  source promoted to the front (cached playback is instant)
 *  and sources that already proved dead on this network
 *  filtered out (see noteSourceDead). */
function orderedTrailerSources(item, youtubeKey) {
  const mediaType = getMediaType(item);
  const sources = buildTrailerVideoSources(item.id, youtubeKey, mediaType)
    .filter((src) => (deadTrailerSourceCounts.get(src) || 0) < 2);
  const cached = trailerSourceCache.get(trailerCacheKey(item.id, mediaType));
  if (cached && cached.status === 'ok' && cached.src && sources.includes(cached.src)) {
    return [cached.src, ...sources.filter((s) => s !== cached.src)];
  }
  return sources;
}

/* ---- Per-source dead tracking ---------------------------------
   Fired the moment a source errors or times out (even if the
   chain is later torn down by a slide change). After two
   strikes a source is skipped for the rest of the session, so
   hanging endpoints never cost their watchdog twice. */
const deadTrailerSourceCounts = new Map();
let trailerDeadUrlCount = 0;    // total dead-source strikes this session
let trailerSuccessCount = 0;    // total streams that actually played

function noteSourceDead(src) {
  if (!src) return;
  deadTrailerSourceCounts.set(src, (deadTrailerSourceCounts.get(src) || 0) + 1);
  trailerDeadUrlCount += 1;
  // A long run of dead URLs with zero successes anywhere means
  // this network blocks the proxies — stop burning watchdogs on
  // every hover and go straight to the Ken Burns fallback.
  if (trailerSuccessCount === 0 && trailerDeadUrlCount >= 12) {
    trailerChainDisabled = true;
  }
}

function rememberTrailerSource(id, mediaType, src) {
  trailerSourceCache.set(trailerCacheKey(id, mediaType),
    src ? { status: 'ok', src } : { status: 'failed' });
  if (src) trailerSuccessCount += 1;
  noteTrailerOutcome(src);
}

/* ---- Session circuit breaker ----------------------------------
   If SEVERAL titles in a row exhaust every source (proxy-hostile
   network), stop attempting the chain at all for this page load:
   hovers go straight to the instant Ken Burns fallback instead
   of walking dead endpoints with multi-second watchdogs. A
   single success anywhere resets the streak. */
const TRAILER_FAILURE_STREAK_LIMIT = 3;
let trailerFailureStreak = 0;
let trailerChainDisabled = false;

function noteTrailerOutcome(src) {
  if (src) {
    trailerFailureStreak = 0;
    return;
  }
  trailerFailureStreak += 1;
  if (trailerFailureStreak >= TRAILER_FAILURE_STREAK_LIMIT) {
    trailerChainDisabled = true;
  }
}

/** True when the direct-stream chain is still worth attempting. */
function trailerChainEnabled() {
  return !trailerChainDisabled;
}

/**
 * Mount a silent, looping, chrome-free <video> into `container`
 * and walk the `sources` chain until one actually plays.
 *
 *   <video autoplay muted loop playsinline preload="metadata"
 *          class="trailer-video">
 *     <source src="{DIRECT_MP4_URL}" type="video/mp4">
 *   </video>
 *
 * The element NEVER has a `controls` attribute, so it renders
 * nothing but the moving picture (pointer-events: none in CSS
 * makes it untouchable as well). onPlaying fires once playback
 * truly starts (callers fade the layer in then); onFailed fires
 * only after EVERY source has errored, timed out or hung — the
 * caller then applies the Ken Burns backdrop fallback.
 * onResolved(src|null) fires exactly once with the winning
 * source URL (or null on total failure) so callers can cache
 * the outcome and make repeat hovers instant.
 *
 * Returns a handle { video, destroy() } so callers can tear the
 * player down the instant it is no longer needed.
 */
function mountTrailerVideo(container, sources, { onPlaying, onFailed, onResolved, onSourceDead, watchdogMs = 6000 } = {}) {
  const video = document.createElement('video');
  video.className = 'trailer-video';
  video.autoplay = true;
  video.muted = true;                            // autoplay policy + courtesy
  video.loop = true;                             // replay forever
  video.playsInline = true;                      // inline playback on iOS
  video.preload = 'metadata';                    // headers + first frames only
  video.setAttribute('playsinline', '');          // legacy Safari spelling
  video.setAttribute('muted', '');                // autoplay gate for old Chrome
  video.setAttribute('disableremoteplayback', '');
  video.setAttribute('disablepictureinpicture', '');
  video.setAttribute('aria-hidden', 'true');
  video.setAttribute('tabindex', '-1');

  let index = 0;         // which source we are trying
  let loading = false;   // guards double-advance (source + element error events)
  let settled = false;   // playing or failed — stop reacting afterwards
  let watchdog = null;

  const clearWatchdog = () => {
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
  };

  const succeed = () => {
    if (settled) return;
    settled = true;
    loading = false;
    clearWatchdog();
    if (typeof onResolved === 'function') onResolved(sources[index] || null);
    if (typeof onPlaying === 'function') onPlaying(video);
  };

  const fail = () => {
    if (settled) return;
    settled = true;
    loading = false;
    clearWatchdog();
    try { video.pause(); } catch (pauseError) { /* already gone */ }
    video.remove();
    if (typeof onResolved === 'function') onResolved(null);
    if (typeof onFailed === 'function') onFailed();
  };

  const tryNext = () => {
    if (settled || !loading) return;
    loading = false;
    // The current source just errored / timed out — report it
    // so callers can avoid it for the rest of the session.
    if (typeof onSourceDead === 'function') onSourceDead(sources[index]);
    index += 1;
    loadCurrent();
  };

  const nudgePlay = () => {
    try {
      const attempt = video.play();
      if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {});
    } catch (playError) { /* autoplay hiccup — events still drive us */ }
  };

  const loadCurrent = () => {
    if (settled) return;
    if (index >= sources.length) { fail(); return; }
    loading = true;

    video.innerHTML = '';
    const source = document.createElement('source');
    source.src = sources[index];
    source.type = 'video/mp4';
    // A dead source fires `error` on itself (and the element fires
    // one more once it runs out of children) — `loading` absorbs
    // the double report so we advance exactly one step.
    source.addEventListener('error', tryNext);
    video.appendChild(source);
    video.load();
    nudgePlay();

    // Some proxies accept the request then trickle forever — if we
    // are still without frames after the watchdog, move along.
    clearWatchdog();
    watchdog = setTimeout(() => {
      if (!settled && video.readyState < 2) tryNext();
    }, watchdogMs);
  };

  video.addEventListener('error', tryNext);
  video.addEventListener('playing', succeed);
  video.addEventListener('canplay', () => { if (!settled) nudgePlay(); });
  // Playback silently stalls (proxy dropped mid-stream) -> next source.
  video.addEventListener('stalled', () => {
    if (!settled) clearWatchdog();
    watchdog = setTimeout(() => { if (!settled && video.readyState < 2) tryNext(); }, 2500);
  });

  container.appendChild(video);
  loadCurrent();

  return {
    video,
    destroy() {
      settled = true;
      loading = false;
      clearWatchdog();
      try { video.pause(); } catch (pauseError) { /* already gone */ }
      video.remove();
    }
  };
}

/* ============================================================
   3. IMAGE HELPERS + FALLBACKS
   ============================================================ */

/** Inline SVG placeholder used when a poster is missing. */
const FALLBACK_POSTER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750" viewBox="0 0 500 750">
      <rect width="500" height="750" fill="#1a1a2e"/>
      <g fill="#3a3a5c" transform="translate(250 340)">
        <path d="M-36 -52 h72 a10 10 0 0 1 10 10 v84 a10 10 0 0 1 -10 10 h-72 a10 10 0 0 1 -10 -10 v-84 a10 10 0 0 1 10 -10 z" fill="none" stroke="#3a3a5c" stroke-width="8"/>
        <polygon points="-8,-26 -8,26 34,0" fill="#3a3a5c" transform="translate(-6 0)"/>
      </g>
      <text x="250" y="480" font-family="Arial, sans-serif" font-size="28" fill="#555577" text-anchor="middle">No Poster</text>
    </svg>`
  );

/** Inline SVG placeholder for actor photos. */
const FALLBACK_PROFILE =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="185" height="278" viewBox="0 0 185 278">
      <rect width="185" height="278" fill="#1a1a2e"/>
      <circle cx="92" cy="110" r="42" fill="#3a3a5c"/>
      <path d="M30 240 q62 -70 125 0 v20 h-125 z" fill="#3a3a5c"/>
    </svg>`
  );

/** Inline SVG placeholder for episode stills. */
const FALLBACK_STILL =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="169" viewBox="0 0 300 169">
      <rect width="300" height="169" fill="#1a1a2e"/>
      <polygon points="130,55 130,113 178,84" fill="#3a3a5c"/>
    </svg>`
  );

/** Build a TMDB image URL, or a fallback when the path is missing. */
function imageUrl(path, size = POSTER_SIZE, fallback = FALLBACK_POSTER) {
  return path ? IMAGE_BASE_URL + size + path : fallback;
}

/**
 * Global <img onerror> handler — swaps a broken image for a
 * themed placeholder (type set via data-fallback attribute).
 */
function handleImageError(img) {
  const type = img.dataset.fallback || 'poster';
  const map = {
    poster: FALLBACK_POSTER,
    profile: FALLBACK_PROFILE,
    still: FALLBACK_STILL
  };
  img.onerror = null; // prevent infinite loop if fallback also fails
  img.src = map[type] || FALLBACK_POSTER;
}
window.handleImageError = handleImageError;

/* ============================================================
   4. DATA FORMAT HELPERS
   ============================================================ */

/** Unified title for movies (.title) and TV shows (.name). */
function getMediaTitle(item) {
  return item.title || item.name || item.original_title || item.original_name || 'Untitled';
}

/** Release year as string ('2024') or 'N/A'. */
function getMediaYear(item) {
  const date = item.release_date || item.first_air_date;
  return date ? date.split('-')[0] : 'N/A';
}

/** Human readable date ('Jan 5, 2024') or 'N/A'. */
function formatDate(dateString) {
  if (!dateString) return 'N/A';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

/** Resolve media type: explicit media_type, else infer from fields. */
function getMediaType(item) {
  if (item.media_type && item.media_type !== 'person') return item.media_type;
  if (item.first_air_date || item.name || item.original_name) {
    if (item.title || item.release_date || item.original_title) {
      return item.media_type === 'tv' ? 'tv' : 'movie';
    }
    return 'tv';
  }
  return 'movie';
}

/** Detail-page href for any movie/TV item. */
function getMediaHref(item) {
  const type = getMediaType(item);
  return `${type === 'tv' ? 'tv' : 'movie'}.html?id=${item.id}`;
}

/** Watch-page href for any movie/TV item. */
function getWatchHref(item, season = null, episode = null) {
  const type = getMediaType(item);
  let href = `watch.html?id=${item.id}&type=${type}`;
  if (type === 'tv') {
    href += `&season=${season || 1}&episode=${episode || 1}`;
  }
  return href;
}

/** '2h 14m' runtime formatting. */
function formatRuntime(minutes) {
  if (!minutes || minutes <= 0) return 'N/A';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

/** '$150,000,000' money formatting. */
function formatMoney(amount) {
  if (!amount || amount <= 0) return 'N/A';
  return '$' + amount.toLocaleString('en-US');
}

/** '12.4K' style compact counts (vote counts, episode counts). */
function formatCompactNumber(value) {
  if (value === undefined || value === null) return 'N/A';
  if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M';
  if (value >= 1000) return (value / 1000).toFixed(1) + 'K';
  return String(value);
}

/** Map genre_ids array to readable names using local catalog. */
function getGenreNames(genreIds) {
  if (!Array.isArray(genreIds)) return [];
  return genreIds
    .map((id) => GENRE_MAP[id])
    .filter(Boolean)
    .slice(0, 3);
}

/** TMDB language code -> display name. */
const LANGUAGE_NAMES = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
  ja: 'Japanese', ko: 'Korean', zh: 'Chinese', hi: 'Hindi', ru: 'Russian',
  pt: 'Portuguese', ar: 'Arabic', th: 'Thai', tr: 'Turkish', nl: 'Dutch',
  sv: 'Swedish', da: 'Danish', fi: 'Finnish', nb: 'Norwegian', pl: 'Polish'
};
function getLanguageName(code) {
  if (!code) return 'N/A';
  return LANGUAGE_NAMES[code] || code.toUpperCase();
}

/* ============================================================
   5. DOM HELPERS
   ============================================================ */

/** querySelector shorthand. */
function $(selector, root = document) {
  return root.querySelector(selector);
}

/** querySelectorAll shorthand returning a real Array. */
function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

/** Debounce helper (used by live search). */
function debounce(fn, wait = 400) {
  let timeoutId = null;
  return function debounced(...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn.apply(this, args), wait);
  };
}

/** Read a query-string parameter from the current URL. */
function getUrlParam(name) {
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

/**
 * Standard movie-card markup used by every listing surface
 * (homepage rows, grids, search results, similar sections).
 *
 * Apple TV style: the card IS the artwork — a rounded 16px
 * image and nothing else. No badges, no overlay text, no
 * borders. Title + year (+ rating) fade in BELOW the artwork
 * on hover. `wide: true` renders an editorial 16:9 backdrop
 * card (used by the Trending row); default cards are 2:3
 * posters. Optional extras, all non-breaking:
 *   rank     — TOP 10 number badge (top-left, red)
 *   badge    — { text, modifier } flag badge ("New episode", "4K", ...)
 *   metaNote — extra text appended to the metadata line (e.g. "S1·E3")
 */
/* element -> TMDB item, read by the desktop hover-trailer system */
const cardItemData = new WeakMap();

function createMovieCard(item, { wide = false, rank = null, badge = null, metaNote = null } = {}) {
  const title = getMediaTitle(item);
  const year = getMediaYear(item);
  const rating = item.vote_average ? item.vote_average.toFixed(1) : '';
  const href = getMediaHref(item);

  // Wide cards lead with the cinematic backdrop; poster cards
  // stay 2:3 — each gracefully falls back to the other image.
  const artPath = wide
    ? (item.backdrop_path || item.poster_path)
    : (item.poster_path || item.backdrop_path);
  const artSrc = artPath
    ? IMAGE_BASE_URL + (wide ? BACKDROP_MD_SIZE : POSTER_SIZE) + artPath
    : FALLBACK_POSTER;

  const rankHtml = rank
    ? `<div class="top10-badge" aria-label="Ranked number ${rank} today">
         <span class="top10-label">TOP</span>
         <span class="top10-number">${rank}</span>
       </div>`
    : '';
  const badgeHtml = badge
    ? `<span class="card-flag${badge.modifier ? ' ' + badge.modifier : ''}">${escapeHtml(badge.text)}</span>`
    : '';

  const card = document.createElement('article');
  card.className = `movie-card${wide ? ' wide' : ''}`;
  cardItemData.set(card, item);
  card.innerHTML = `
    <a href="${href}" class="card-link" title="${escapeHtml(title)} (${year})">
      <div class="poster-wrap">
        <img class="poster-img"
             src="${artSrc}"
             alt="${escapeHtml(title)} ${wide ? 'backdrop' : 'poster'}"
             loading="lazy"
             decoding="async"
             data-fallback="${wide ? 'still' : 'poster'}"
             onerror="handleImageError(this)">
      </div>
    </a>
    ${rankHtml}
    ${badgeHtml}
    ${typeof createWatchlistCardButton === 'function' ? createWatchlistCardButton(item) : ''}
    <div class="card-caption">
      <h3 class="card-caption-title">${escapeHtml(title)}</h3>
      <p class="card-caption-meta">
        <span>${escapeHtml(year)}</span>
        ${rating ? `
        <span class="caption-star" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
        </span>
        <span>${rating}</span>` : ''}
        ${metaNote ? `<span class="dot"></span><span class="meta-note">${escapeHtml(metaNote)}</span>` : ''}
      </p>
    </div>
  `;
  return card;
}

/** Cast card (photo, name, character). */
function createCastCard(person) {
  const card = document.createElement('div');
  card.className = 'cast-card';
  card.innerHTML = `
    <div class="cast-photo">
      <img src="${imageUrl(person.profile_path, PROFILE_SIZE, FALLBACK_PROFILE)}"
           alt="${escapeHtml(person.name)}"
           loading="lazy"
           decoding="async"
           data-fallback="profile"
           onerror="handleImageError(this)">
    </div>
    <div class="cast-info">
      <p class="cast-name" title="${escapeHtml(person.name)}">${escapeHtml(person.name)}</p>
      <p class="cast-character" title="${escapeHtml(person.character || '')}">${escapeHtml(person.character || '')}</p>
    </div>
  `;
  return card;
}

/** Escape user/API text before injecting into HTML. */
function escapeHtml(text) {
  if (text === undefined || text === null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Render N skeleton cards into a container. */
function showSkeletons(container, count = CONFIG.skeletonCards, type = 'card') {
  if (!container) return;
  container.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const skeleton = document.createElement('div');
    if (type === 'cast') {
      skeleton.className = 'skeleton-cast';
    } else {
      skeleton.className = type === 'card-wide' ? 'skeleton-card wide' : 'skeleton-card';
    }
    skeleton.innerHTML = type === 'cast'
      ? `<div class="skeleton-cast-photo shimmer"></div>
         <div class="skeleton-line w-80 shimmer"></div>
         <div class="skeleton-line w-60 shimmer"></div>`
      : `<div class="skeleton-poster shimmer"></div>
         <div class="skeleton-line w-80 shimmer"></div>
         <div class="skeleton-line w-50 shimmer"></div>`;
    container.appendChild(skeleton);
  }
}

/** Full-width inline error state with a retry button. */
function showErrorState(container, message, onRetry, context = 'section') {
  if (!container) return;
  container.innerHTML = `
    <div class="state-message ${context === 'page' ? 'state-page' : ''}">
      <div class="state-icon error" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.8">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="7" x2="12" y2="13"/><circle cx="12" cy="16.5" r="0.6" fill="currentColor"/>
        </svg>
      </div>
      <h3>Something went wrong</h3>
      <p>${escapeHtml(message || 'Failed to load content.')}</p>
      <button class="btn btn-outline btn-retry">Try Again</button>
    </div>
  `;
  const retryBtn = container.querySelector('.btn-retry');
  if (retryBtn && typeof onRetry === 'function') {
    retryBtn.addEventListener('click', onRetry);
  }
}

/** Inline empty state ('no results' / 'nothing here'). */
function showEmptyState(container, message = 'Nothing to display right now.') {
  if (!container) return;
  container.innerHTML = `
    <div class="state-message">
      <div class="state-icon empty" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.8">
          <rect x="3" y="5" width="18" height="14" rx="2"/>
          <path d="M10 9.5l5 2.5-5 2.5z" fill="currentColor" stroke="none"/>
        </svg>
      </div>
      <h3>Nothing here yet</h3>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

/** Fatal 'invalid page' state — bad/missing id. */
function showInvalidState(container, message, showHomeLink = true) {
  if (!container) return;
  container.innerHTML = `
    <div class="state-message state-page">
      <div class="state-icon error" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.8">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="7" x2="12" y2="13"/><circle cx="12" cy="16.5" r="0.6" fill="currentColor"/>
        </svg>
      </div>
      <h3>Page not found</h3>
      <p>${escapeHtml(message)}</p>
      ${showHomeLink ? '<a class="btn btn-primary" href="index.html">Go to Homepage</a>' : ''}
    </div>
  `;
}

/**
 * Reusable section loader: skeletons -> data -> cards,
 * with error + retry handling. Returns the fetched results.
 */
async function loadSection(container, fetchFn, options = {}) {
  if (!container) return [];
  const {
    filterPerson = false,
    requirePoster = false,
    requireBackdrop = false,
    wide = false,
    limit = CONFIG.cardsPerRow,
    emptyMessage = 'Nothing to display right now.',
    horizontal = false,
    cardBuilder = null
  } = options;

  showSkeletons(container, horizontal ? 8 : CONFIG.skeletonCards, wide ? 'card-wide' : 'card');
  try {
    const data = await fetchFn();
    let items = (data && data.results) || [];
    if (filterPerson) items = items.filter((i) => i.media_type !== 'person');
    if (requirePoster) items = items.filter((i) => i.poster_path);
    if (requireBackdrop) items = items.filter((i) => i.backdrop_path);
    items = items.slice(0, limit);

    if (!items.length) {
      showEmptyState(container, emptyMessage);
      return [];
    }

    container.innerHTML = '';
    const build = cardBuilder || ((item) => createMovieCard(item, { wide }));
    const fragment = document.createDocumentFragment();
    items.forEach((item, index) => fragment.appendChild(build(item, index)));
    container.appendChild(fragment);
    return items;
  } catch (error) {
    showErrorState(container, error.message, () => loadSection(container, fetchFn, options));
    return [];
  }
}

/** Update document title + Open Graph / Twitter meta tags. */
function updateMetaTags({ title, description, image }) {
  if (title) {
    document.title = title;
    setMeta('property', 'og:title', title);
    setMeta('name', 'twitter:title', title);
  }
  if (description) {
    setMeta('name', 'description', description);
    setMeta('property', 'og:description', description);
    setMeta('name', 'twitter:description', description);
  }
  if (image) {
    setMeta('property', 'og:image', image);
    setMeta('name', 'twitter:image', image);
  }
}

function setMeta(attribute, key, value) {
  let tag = document.head.querySelector(`meta[${attribute}="${key}"]`);
  if (!tag) {
    tag = document.createElement('meta');
    tag.setAttribute(attribute, key);
    document.head.appendChild(tag);
  }
  tag.setAttribute('content', value);
}

/* ============================================================
   6. COMMON UI INITIALIZER (runs on every page)
   ============================================================ */

function initCommonUI() {
  initPageLoader();
  initSmoothNavigation();
  initNavbar();
  initHamburgerMenu();
  initGenreDropdown();
  initBackToTop();
  initFooterYear();
  initDisclaimerBanner();
  initCardHoverTrailers();
  initPlayLightning();
  initLogoLightning();
  initRandomPageFlashes();
  if (typeof initWatchlistUI === 'function') initWatchlistUI();
}

/* ============================================================
   6c. PLAY-BUTTON LIGHTNING FLASH
   ------------------------------------------------------------
   Clicking a primary "Play"-style CTA fires a brief electric
   lightning flash across the screen before the page transitions
   to the player — the ZEUS signature. Normal card/link clicks
   are never intercepted; modified clicks (new tab, etc.) pass
   straight through untouched.
   ============================================================ */
const PLAY_FLASH_MS = 420; // flash duration before navigation

function initPlayLightning() {
  document.addEventListener('click', (event) => {
    const link = event.target instanceof Element
      ? event.target.closest('a.btn-primary')
      : null;
    if (!link) return;

    const href = link.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    // Never hijack modified clicks (new tab / window)
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target === '_blank') return;

    event.preventDefault();
    flashLightning();

    // Let the flash land, then navigate. If something goes wrong
    // the safety timeout below still moves the page along.
    setTimeout(() => { window.location.href = href; }, PLAY_FLASH_MS);
    setTimeout(() => { window.location.href = href; }, PLAY_FLASH_MS + 1500);
  });
}

/** Full-screen yellow lightning flash overlay (one shot). */
function flashLightning() {
  if (document.querySelector('.lightning-overlay')) return;
  const overlay = document.createElement('div');
  overlay.className = 'lightning-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML = `
    <svg class="lightning-bolt" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M13 2 4.5 13.5h5.2L8.6 22l8.9-11.8h-5.4L13 2z"/>
    </svg>
  `;
  document.body.appendChild(overlay);
  setTimeout(() => overlay.remove(), 700);
}

/* ============================================================
   6d. LOGO LIGHTNING — yellow bolt, electric arcs, bursts
   ------------------------------------------------------------
   The ZEUS logo wears a real lightning-strike animation (CSS:
   @keyframes lightning-strike, 6s loop). This JS layer adds the
   living electricity around it:
     • random electric-arc particles flicker near the navbar
       logo every ~1-2.5s (small yellow jagged SVG lines)
     • hovering ANY .nav-logo fires an intense burst: the bolt
       flashes brighter while 4 arcs shoot outward and fade
   Everything is decorative, pointer-events: none, and skipped
   entirely for prefers-reduced-motion users.
   ============================================================ */

const LOGO_ARC_SVG =
  '<svg viewBox="0 0 14 18" aria-hidden="true"><polyline points="8,1 4,7 7,8 3,14 5,14.5 2,17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function initLogoLightning() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // Hover burst on every logo instance (navbar + footer).
  $$('.nav-logo').forEach((logo) => {
    logo.addEventListener('mouseenter', () => burstLogoArcs(logo));
  });

  // Ambient arc particles only around the navbar logo (cheap).
  const navLogo = document.querySelector('.navbar .nav-logo');
  if (!navLogo) return;

  const scheduleArc = () => {
    setTimeout(() => {
      spawnLogoArc(navLogo, false);
      scheduleArc();
    }, 900 + Math.random() * 1600);
  };
  scheduleArc();
}

/** One small jagged arc near the logo; `shooting` arcs fly
    outward (hover burst), ambient ones just flicker in place. */
function spawnLogoArc(logo, shooting) {
  if (!logo || !logo.isConnected) return;
  const arc = document.createElement('span');
  arc.className = shooting ? 'logo-arc logo-arc--burst' : 'logo-arc';
  arc.setAttribute('aria-hidden', 'true');
  arc.innerHTML = LOGO_ARC_SVG;

  const box = logo.getBoundingClientRect();
  if (shooting) {
    // Pick a random angle; the CSS animation shoots the arc
    // outward along --tx / --ty (scaled to the logo size).
    const angle = Math.random() * Math.PI * 2;
    const reach = Math.max(box.width, box.height) * (0.55 + Math.random() * 0.5);
    arc.style.setProperty('--tx', `${Math.cos(angle) * reach}px`);
    arc.style.setProperty('--ty', `${Math.sin(angle) * reach}px`);
    // Start somewhere on the logo's perimeter, biased to the bolt side.
    arc.style.left = `${(0.05 + Math.random() * 0.9) * box.width}px`;
    arc.style.top = `${(0.1 + Math.random() * 0.8) * box.height}px`;
  } else {
    // Flicker somewhere around the logo's edges.
    const side = Math.floor(Math.random() * 4);
    const x = side === 0 ? -8 - Math.random() * 8
            : side === 1 ? box.width + Math.random() * 8
            : Math.random() * box.width;
    const y = side === 2 ? -10 - Math.random() * 8
            : side === 3 ? box.height + Math.random() * 6
            : Math.random() * box.height;
    arc.style.left = `${x}px`;
    arc.style.top = `${y}px`;
  }

  logo.appendChild(arc);
  setTimeout(() => arc.remove(), shooting ? 520 : 420);
}

/** Intense hover burst: 4 arcs shoot outward from the logo. */
function burstLogoArcs(logo) {
  for (let i = 0; i < 4; i++) {
    setTimeout(() => spawnLogoArc(logo, true), i * 45);
  }
}

/* ============================================================
   6e. RANDOM PAGE LIGHTNING FLASHES
   ------------------------------------------------------------
   Every 8-12 seconds a small yellow lightning flash flickers
   somewhere around the edges of the viewport (top of the
   navbar, corners of the hero, page sides) — a ~200ms zap
   that makes the whole site feel statically alive. Purely
   decorative; disabled for reduced-motion users.
   ============================================================ */
function initRandomPageFlashes() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const schedule = () => {
    setTimeout(() => {
      spawnPageFlash();
      schedule();
    }, 8000 + Math.random() * 4000);
  };
  schedule();
}

/** One brief yellow flash at a random viewport edge. */
function spawnPageFlash() {
  const flash = document.createElement('div');
  flash.className = 'page-flash';
  flash.setAttribute('aria-hidden', 'true');
  flash.innerHTML =
    '<svg viewBox="0 0 24 24"><path d="M13 2 4.5 13.5h5.2L8.6 22l8.9-11.8h-5.4L13 2z"/></svg>';

  // Random spot along the top strip or the left/right edges.
  const zone = Math.random();
  if (zone < 0.45) {
    flash.style.top = `${Math.random() * 90}px`;
    flash.style.left = `${8 + Math.random() * 84}%`;
  } else if (zone < 0.725) {
    flash.style.top = `${15 + Math.random() * 70}%`;
    flash.style.left = `${1 + Math.random() * 3}%`;
  } else {
    flash.style.top = `${15 + Math.random() * 70}%`;
    flash.style.right = `${1 + Math.random() * 3}%`;
  }
  flash.style.setProperty('--flash-scale', String(0.6 + Math.random() * 0.7));
  flash.style.setProperty('--flash-rotate', `${(Math.random() * 30 - 15).toFixed(1)}deg`);

  document.body.appendChild(flash);
  setTimeout(() => flash.remove(), 300);
}

/* ============================================================
   6a. AMBIENT BACKDROP — the Apple TV+ cinematic colour glow
   ------------------------------------------------------------
   A fixed, full-screen layer (#ambient-bg, present on every
   page) that lives behind all content (z-index: -2). Its
   ::before paints the page's "base" image — the hero slide /
   featured title backdrop — blurred 120px, saturated 180%, at
   40% opacity, so the whole site floats in the colours of
   whatever is on screen. Hovering a card temporarily repaints
   the glow with THAT title's backdrop; leaving the cards
   restores the page's base image. A drifting light beam
   (::after) and a vignette overlay (#ambient-vignette) finish
   the theatre look.
   ============================================================ */

const AMBIENT_FADE_DELAY_MS = 160; // grace so gliding between cards never flickers

const ambientBackdrop = {
  el: null,
  baseUrl: null,     // the page's resting image (hero / detail backdrop)
  resetTimer: null,

  init() {
    this.el = document.getElementById('ambient-bg');
  },

  /** Paint a URL into the glow layer via the --ambient-image var. */
  paint(url) {
    if (!this.el || !url) return;
    this.el.style.setProperty('--ambient-image', `url("${url}")`);
  },

  /** Set the page's resting ambient image (hero slide, detail
      backdrop, first browse result...). Call it whenever the
      featured content changes. */
  setBase(item) {
    const path = item && (item.backdrop_path || item.poster_path);
    this.baseUrl = path ? IMAGE_BASE_URL + BACKDROP_MD_SIZE + path : this.baseUrl;
    if (this.baseUrl) this.paint(this.baseUrl);
  },

  /** Card hover: temporarily repaint the glow with this title. */
  show(item) {
    if (!this.el) return;
    const path = item && (item.backdrop_path || item.poster_path);
    if (!path) return;
    clearTimeout(this.resetTimer);
    this.paint(IMAGE_BASE_URL + BACKDROP_MD_SIZE + path);
  },

  /** Cursor left the cards: restore the page's base image. */
  reset() {
    if (!this.el) return;
    clearTimeout(this.resetTimer);
    this.resetTimer = setTimeout(() => {
      if (this.baseUrl) this.paint(this.baseUrl);
    }, AMBIENT_FADE_DELAY_MS);
  }
};

/* ============================================================
   6b. CARD HOVER — ambient glow + silent trailers (desktop)
   ------------------------------------------------------------
   Dwelling 400ms on a card fades its muted, chrome-free
   <video> trailer in over the artwork, clipped to the card's
   rounded corners — the video acts as a silent background
   layer (a <video> without `controls` has NO UI of its own;
   pointer-events: none keeps it untouchable). When every
   direct-MP4 source fails, the artwork itself gets a subtle
   Ken Burns pan/zoom so the card still feels alive.
   Performance rules: the dwell timer is cancelled the moment
   the cursor leaves (no wasted video loads) and ONLY ONE
   trailer video is ever alive — hovering a new card destroys
   the previous one immediately. The ambient glow reacts the
   instant the cursor arrives and reverts to the page's base
   image on leave. Touch devices get neither (static artwork
   + always-visible captions).
   ============================================================ */

const CARD_TRAILER_DELAY_MS = 400; // dwell time before the trailer fades in
const CARD_HOVER_GRACE_MS = 160;   // grace when the mouse dips off a card

/* Feature state (single active card at a time). */
const hoverTrailerState = {
  card: null,
  dwellTimer: null,
  hideTimer: null
};

/** Attach the delegated hover system (once per page, desktop only). */
function initCardHoverTrailers() {
  ambientBackdrop.init();

  // Desktop detection via REAL pointer events: touch and pen
  // input never report pointerType "mouse", so phones and tablets
  // never trigger hover trailers. Unlike the (hover:hover) media
  // query — which fails on touchscreen laptops, headless browsers
  // and embedded previews — this fires for ANY device that
  // actually moves a real mouse over a card.
  document.addEventListener('pointerover', onCardHoverPointerOver);
  // Cursor left the window entirely -> tidy up (no pointerover follows).
  document.addEventListener('pointerout', (event) => {
    if (event.pointerType && event.pointerType !== 'mouse') return;
    if (!event.relatedTarget) endCardHover();
  });
}

/** Pointer-aware wrapper: filters out touch/pen, forwards mouse. */
function onCardHoverPointerOver(event) {
  if (event.pointerType && event.pointerType !== 'mouse') return;
  onCardHoverMouseOver(event);
}

/** Delegated mouse tracking: cards vs everywhere else. */
function onCardHoverMouseOver(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const card = target.closest('.movie-card');
  if (card) {
    cancelCardHoverTeardown();
    if (card !== hoverTrailerState.card) startCardHover(card);
  } else if (hoverTrailerState.card) {
    scheduleCardHoverTeardown();
  }
}

/** Mouse arrived on a new card — glow now, trailer after 800ms. */
function startCardHover(card) {
  endCardHover();
  hoverTrailerState.card = card;

  // The ambient glow reacts immediately (no dwell delay).
  ambientBackdrop.show(cardItemData.get(card));

  hoverTrailerState.dwellTimer = setTimeout(() => confirmCardHover(card), CARD_TRAILER_DELAY_MS);
}

/** Hover confirmed after the dwell delay: the card comes
    alive IMMEDIATELY (Ken Burns on the artwork) while the
    trailer stream connects; if a stream starts it fades in
    over the artwork, otherwise the pan/zoom simply continues. */
function confirmCardHover(card) {
  if (hoverTrailerState.card !== card || !card.isConnected) return;
  const item = cardItemData.get(card);
  if (!item) return;

  // Baseline "alive" state from the very first moment of the
  // dwell — the card never sits frozen, even offline.
  applyCardKenBurns(card);
  console.log('TRAILER HOVER OK', item.id, getMediaType(item));

  const mediaType = getMediaType(item);
  // Titles whose trailer embed already failed this session skip
  // the network entirely (straight to the Ken Burns fallback).
  if (cardTrailerEmbedFailed.has(trailerCacheKey(item.id, mediaType))) return;

  getTrailerKey(item.id, mediaType).then((videoKey) => {
    // User may have left while the key was resolving
    if (hoverTrailerState.card !== card || !card.isConnected) return;
    if (!videoKey) {
      // No trailer at all -> Ken Burns artwork fallback stays.
      return;
    }
    playCardTrailer(card, videoKey, item);
  });
}

/** Ken Burns fallback: the artwork slowly pans/zooms while the
    cursor stays (used while connecting and whenever no trailer
    stream is playable). */
function applyCardKenBurns(card) {
  const img = card.querySelector('.poster-img');
  if (img) img.classList.add('trailer-fallback');
}

function removeCardKenBurns(card) {
  const img = card.querySelector('.poster-img');
  if (img) img.classList.remove('trailer-fallback');
}

/* Titles whose trailer embed failed to load this session — later
   hovers skip the iframe mount and keep the Ken Burns fallback. */
const cardTrailerEmbedFailed = new Set();

/** Fade the muted, chrome-free trailer embed in over the card's
 *  artwork.
 *
 *  The youtube-nocookie <iframe> is created exactly with the
 *  permissions modern browsers require for autoplay inside a
 *  third-party frame — `allow="autoplay; encrypted-media;
 *  picture-in-picture"` — plus autoplay=1&mute=1&controls=0&
 *  modestbranding=1 in the URL, so no player UI ever shows.
 *  While the embed connects the Ken Burns artwork zoom (applied
 *  the instant the dwell was confirmed) keeps the card moving;
 *  the iframe fades in over it once loaded. If the embed never
 *  loads (blocked / offline / watchdog timeout) the layer is
 *  removed and the already-running Ken Burns pan continues —
 *  a dead hover is impossible. */
function playCardTrailer(card, trailerKey, item) {
  const wrap = card.querySelector('.poster-wrap');
  if (!wrap || wrap.querySelector('.card-trailer')) return;

  // Performance: only ONE hover-trailer embed may exist at a
  // time — destroy any straggler from a previous card instantly
  // (no fade-out wait, no second decoder burning CPU).
  destroyStaleCardTrailers(card);

  const layer = document.createElement('div');
  // The layer clips the embed to the card's rounded corners and
  // stays pointer-events: none — clicks fall straight through to
  // the card link, so the trailer is purely a live background.
  layer.className = 'card-trailer';
  layer.setAttribute('aria-hidden', 'true');

  const mediaType = getMediaType(item);

  const iframe = document.createElement('iframe');
  iframe.src = `https://www.youtube-nocookie.com/embed/${trailerKey}?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0&enablejsapi=1&loop=1&playlist=${trailerKey}`;
  // THE fix: without an explicit allow="autoplay" the browser
  // silently blocks video playback inside the frame.
  iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
  iframe.setAttribute('allowfullscreen', 'true');
  iframe.className = 'card-trailer-iframe';
  iframe.setAttribute('title', `${getMediaTitle(item)} trailer preview`);
  iframe.setAttribute('tabindex', '-1');
  iframe.setAttribute('loading', 'eager');

  let settled = false;   // loaded or failed — stop reacting afterwards
  let verified = false;  // the player API spoke — genuine playback
  let watchdog = null;   // iframe never fired `load`
  let verifyTimer = null; // loaded but the player never spoke

  /* ---- Real-playback verification (a dead hover is impossible) ---
     With enablejsapi=1 the embed answers a "listening" handshake
     with player API messages (infoDelivery / onStateChange). A
     walled or blocked embed — e.g. YouTube's bot check on some
     networks — loads its shell but NEVER speaks; in that case the
     layer is dropped and the Ken Burns artwork zoom carries the
     hover instead of a frozen "sign in" screen. */
  const onYTMessage = (event) => {
    if (event.origin !== 'https://www.youtube-nocookie.com' &&
        event.origin !== 'https://www.youtube.com') return;
    verified = true;
    cleanupYTVerification();
  };

  const cleanupYTVerification = () => {
    window.removeEventListener('message', onYTMessage);
    if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = null; }
  };
  // haltTrailerLayerMedia() calls this when the layer is torn down.
  layer._ytCleanup = cleanupYTVerification;

  const failEmbed = () => {
    if (settled) return;
    settled = true;
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    cleanupYTVerification();
    cardTrailerEmbedFailed.add(trailerCacheKey(item.id, mediaType));
    layer.remove();
    // Ken Burns artwork fallback (already running — make sure
    // it is on so the hover is never dead).
    if (hoverTrailerState.card === card && card.isConnected) applyCardKenBurns(card);
  };

  iframe.addEventListener('load', () => {
    if (settled) return;
    // User may have moved on while the embed was connecting.
    if (hoverTrailerState.card !== card || !card.isConnected) {
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      settled = true;
      cleanupYTVerification();
      layer.remove();
      return;
    }
    settled = true;
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    console.log('TRAILER VIDEO PLAYING', item.id, iframe.src);
    // The moving picture replaces the Ken Burns pan.
    removeCardKenBurns(card);
    card.classList.add('trailer-playing');
    requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add('playing')));

    // Handshake: ask the embedded player to talk to us. A genuine
    // player answers within a second or two; a walled one stays
    // silent and triggers the Ken Burns fallback below.
    try {
      iframe.contentWindow.postMessage(
        JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }),
        'https://www.youtube-nocookie.com'
      );
    } catch (pmError) { /* cross-origin handshake is best-effort */ }
    window.addEventListener('message', onYTMessage);
    verifyTimer = setTimeout(() => {
      if (verified) return;
      // Loaded but silent -> walled/blocked embed: swap the frozen
      // shell for the living Ken Burns artwork zoom.
      cleanupYTVerification();
      console.log('TRAILER EMBED SILENT -> KEN BURNS', item.id);
      cardTrailerEmbedFailed.add(trailerCacheKey(item.id, mediaType));
      card.classList.remove('trailer-playing');
      layer.classList.remove('playing');
      haltTrailerLayerMedia(layer);
      layer.remove();
      if (hoverTrailerState.card === card && card.isConnected) applyCardKenBurns(card);
    }, 4500);
  });

  // The embed page can also hard-error (blocked domain).
  iframe.addEventListener('error', failEmbed);

  // If the embed never reports load (network stall / blocked),
  // tear it down and let the Ken Burns pan carry the hover.
  watchdog = setTimeout(failEmbed, 6000);

  layer.appendChild(iframe);
  wrap.appendChild(layer);
}

/** Hard-remove every hover-trailer layer that is not inside
    `keepCard` — guarantees at most one embed is ever alive. */
function destroyStaleCardTrailers(keepCard) {
  $$('.card-trailer').forEach((layer) => {
    if (keepCard && keepCard.contains(layer)) return;
    const owner = layer.closest('.movie-card');
    if (owner) {
      owner.classList.remove('trailer-playing');
      const img = owner.querySelector('.poster-img');
      if (img) img.classList.remove('trailer-fallback');
    }
    haltTrailerLayerMedia(layer);
    layer.remove();
  });
}

/** Stop every media element inside a trailer layer (video from
    the hero-era chain, or the youtube-nocookie iframe) so the
    decoder/stream is freed the moment the layer is dropped. */
function haltTrailerLayerMedia(layer) {
  if (typeof layer._ytCleanup === 'function') {
    try { layer._ytCleanup(); } catch (cleanupError) { /* noop */ }
  }
  const video = layer.querySelector('video');
  if (video) { try { video.pause(); } catch (pauseError) { /* noop */ } }
  const iframe = layer.querySelector('iframe');
  if (iframe) { try { iframe.src = 'about:blank'; } catch (iframeError) { /* noop */ } }
}

/** Full teardown of the hovered card (trailer + glow). */
function endCardHover() {
  clearTimeout(hoverTrailerState.dwellTimer);
  hoverTrailerState.dwellTimer = null;
  cancelCardHoverTeardown();
  ambientBackdrop.reset();

  const card = hoverTrailerState.card;
  hoverTrailerState.card = null;
  if (card) removeCardTrailer(card);
}

/** Fade back to the artwork, then free the decoder. */
function removeCardTrailer(card) {
  card.classList.remove('trailer-playing');
  const img = card.querySelector('.poster-img');
  if (img) img.classList.remove('trailer-fallback');
  const layer = card.querySelector('.card-trailer');
  if (!layer) return;
  layer.classList.remove('playing');
  haltTrailerLayerMedia(layer);
  setTimeout(() => layer.remove(), 480);
}

/** Tear the hover state down after a short grace period. */
function scheduleCardHoverTeardown() {
  cancelCardHoverTeardown();
  hoverTrailerState.hideTimer = setTimeout(() => endCardHover(), CARD_HOVER_GRACE_MS);
}

function cancelCardHoverTeardown() {
  if (hoverTrailerState.hideTimer) {
    clearTimeout(hoverTrailerState.hideTimer);
    hoverTrailerState.hideTimer = null;
  }
}

/** Page loading animation — POWER RANGERS sky-to-ground ⚡ entrance.
    Dark prelude with volumetric god-rays and floating electric
    dust (0–1s), then a massive jagged SVG bolt cracks down the
    full screen in 0.2s with branching tendrils (1.0–1.2s) while
    the screen flashes, the camera shakes and shockwave rings
    burst from the impact core. The metallic ZEUS resolves out
    of the afterglow (1.3–2.8s), then the overlay dissolves
    slowly into the site (1s scale + blur + fade) while the page
    content gently scales in. Majestic ~3.8s total; click
    anywhere to skip instantly. */
function initPageLoader() {
  const loader = $('#page-loader');
  if (!loader) return;

  // Arriving via an in-site navigation transition: skip the
  // cinematic entrance entirely — the content reveal (now with a
  // gentle scale) takes over, so menu clicks read as one smooth
  // crossfade with no reload flash.
  let viaTransition = false;
  try {
    viaTransition = sessionStorage.getItem('zeus_nav_transition') === '1';
    if (viaTransition) sessionStorage.removeItem('zeus_nav_transition');
  } catch (storageError) {
    /* private mode — fall through to the branded entrance */
  }
  if (viaTransition) {
    loader.remove();
    return;
  }

  const reducedMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let dismissed = false;
  const dismissLoader = () => {
    if (dismissed) return;
    dismissed = true;
    loader.classList.add('hidden');            // blur + scale + fade out
    document.body.classList.remove('cine-hold'); // content scales in below
    setTimeout(() => loader.remove(), 1100);
    loader.removeEventListener('click', dismissLoader);
  };

  // Click anywhere on the overlay to skip instantly
  loader.addEventListener('click', dismissLoader);

  // The watch page runs its own cinematic overlay (#cine-overlay)
  // and hides this loader at DOMContentLoaded — leave its entrance
  // untouched (no bolt, no particles, no content hold).
  const watchOwnsEntrance = !!document.getElementById('cine-overlay');

  if (!watchOwnsEntrance) {
    spawnLoaderParticles(loader);
    injectSkyBolt(loader);
    // Arm the sequence: .pr-go starts every timed animation (shake,
    // bolt crack, flash, rings, ZEUS reveal, bar) in this same
    // frame, so the choreography always plays in lockstep —
    // regardless of how late first paint or parsing happened.
    loader.classList.add('pr-go');
    // Hold the page content at scale(0.97)/opacity(0) behind the
    // opaque overlay; removing this class triggers zeusPageIn at
    // the exact moment the loader starts dissolving.
    document.body.classList.add('cine-hold');

    if (reducedMotion) {
      // Quiet, fast path: brief static hold, then straight out.
      setTimeout(dismissLoader, 250);
    } else {
      // Master handoff: the ZEUS name-reveal animation starts at
      // the loader's first rendered frame and ends at exactly
      // 1.45s delay + 1.35s duration = 2.8s — the precise moment
      // the dissolution should begin. Keying the exit to this
      // animationend (not navigationStart, not script-run time)
      // keeps the ~3.8s entrance perfectly synced to the CSS
      // clock no matter how late first paint happens.
      const nameEl = loader.querySelector('.loader-name');
      const onRevealEnd = (e) => {
        if (e.animationName === 'name-reveal') dismissLoader();
      };
      if (nameEl) {
        const reveal = typeof nameEl.getAnimations === 'function'
          ? nameEl.getAnimations().find((a) => a.animationName === 'name-reveal')
          : null;
        if (reveal && reveal.playState === 'finished') {
          // Parsing was so slow the reveal already completed before
          // this script ran — dissolve right away.
          dismissLoader();
        } else {
          nameEl.addEventListener('animationend', onRevealEnd);
        }
      }
      // Safety net: if the reveal animation never completes (exotic
      // engines, hard tab throttling), leave anyway.
      setTimeout(dismissLoader, 6000);
    }
  }
}

/** Floating electric dust field for the cinematic loader —
    randomised gold particles drifting slowly across the screen
    (negative animation delays start them mid-flight). */
function spawnLoaderParticles(loader) {
  if (!loader || loader.querySelector('.loader-particles')) return;
  const field = document.createElement('div');
  field.className = 'loader-particles';
  field.setAttribute('aria-hidden', 'true');
  const COUNT = window.innerWidth < 640 ? 10 : 18;
  for (let i = 0; i < COUNT; i++) {
    const dot = document.createElement('span');
    dot.className = 'loader-particle';
    const size = 1.5 + Math.random() * 3;
    dot.style.left = `${(Math.random() * 100).toFixed(2)}%`;
    dot.style.top = `${(6 + Math.random() * 94).toFixed(2)}%`;
    dot.style.width = `${size.toFixed(2)}px`;
    dot.style.height = `${size.toFixed(2)}px`;
    dot.style.setProperty('--p-dx', `${Math.round(Math.random() * 120 - 60)}px`);
    dot.style.setProperty('--p-dy', `${Math.round(-40 - Math.random() * 150)}px`);
    dot.style.setProperty('--p-opacity', (0.25 + Math.random() * 0.5).toFixed(2));
    dot.style.animationDuration = `${(7 + Math.random() * 8).toFixed(2)}s`;
    dot.style.animationDelay = `${(-Math.random() * 12).toFixed(2)}s`;
    field.appendChild(dot);
  }
  loader.appendChild(field);
}

/** Sky-to-ground lightning strike — a full-screen SVG whose
    jagged main bolt (gold glow + white-hot core, pathLength="1"
    stroke-dash trick) cracks from the very top of the screen
    down to the bottom in 0.2s, with randomly forking tendrils
    ("sky cracks"). The path is regenerated on every visit, so
    no two strikes are ever the same. Also drops the impact FX
    layers: screen flash, shockwave rings and the ground burst. */
function injectSkyBolt(loader) {
  if (!loader || loader.querySelector('.loader-skybolt')) return;

  const w = Math.max(window.innerWidth || 320, 320);
  const h = Math.max(window.innerHeight || 480, 480);
  const rand = (min, max) => min + Math.random() * (max - min);

  // Main bolt: a random walk from the sky, pulled through the
  // screen centre so the strike core lines up with the shockwave
  // rings and the emerging ZEUS word, then free to drift as it
  // races for the ground.
  const pts = [];
  let x = w * 0.5 + rand(-0.07, 0.07) * w;
  let y = 0;
  pts.push([x, y]);
  while (y < h) {
    y += rand(0.055, 0.1) * h;
    if (y > h) y = h;
    const pull = y < h * 0.5 ? (w * 0.5 - x) * 0.28 : 0;
    x = Math.min(Math.max(x + pull + rand(-0.09, 0.09) * w, w * 0.22), w * 0.78);
    pts.push([x, y]);
  }
  const mainD = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');

  // Branching tendrils forking off mid-bolt vertices (the tip
  // reaches each fork between 1.06s and 1.16s — their draw
  // delays are tuned to match).
  const tendrilPaths = [];
  const forkCount = 2 + (Math.random() < 0.6 ? 1 : 0);
  const anchorMax = Math.max(1, Math.round(pts.length * 0.55));
  for (let t = 0; t < forkCount; t++) {
    const anchor = pts[1 + Math.floor(Math.random() * anchorMax)];
    if (!anchor) continue;
    const dir = Math.random() < 0.5 ? -1 : 1;
    let tx = anchor[0];
    let ty = anchor[1];
    const d = [`M${tx.toFixed(1)} ${ty.toFixed(1)}`];
    const segs = 2 + Math.floor(Math.random() * 2);
    for (let s = 0; s < segs; s++) {
      tx += dir * rand(0.06, 0.16) * w;
      ty += rand(0.06, 0.14) * h;
      d.push(`L${tx.toFixed(1)} ${ty.toFixed(1)}`);
    }
    tendrilPaths.push(d.join(' '));
  }

  // Assemble the SVG in pixel space (viewBox == viewport) so the
  // stroke widths render exactly as designed on every screen.
  const NS = 'http://www.w3.org/2000/svg';
  const wrap = document.createElement('div');
  wrap.className = 'loader-skybolt';
  wrap.setAttribute('aria-hidden', 'true');

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${Math.round(w)} ${Math.round(h)}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('focusable', 'false');

  const addPath = (d, cls, delay) => {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('pathLength', '1');
    path.setAttribute('class', cls);
    if (typeof delay === 'number') path.style.animationDelay = `${delay.toFixed(2)}s`;
    svg.appendChild(path);
  };

  addPath(mainD, 'sky-glow');   // Electric Yellow halo (35px glow)
  addPath(mainD, 'sky-core');   // white-hot core on the same path
  tendrilPaths.forEach((d, i) => addPath(d, 'sky-tendril', 1.06 + i * 0.05));

  wrap.appendChild(svg);
  loader.appendChild(wrap);

  // Impact FX layers (positioned/animated purely by CSS)
  const fx = document.createElement('div');
  fx.className = 'loader-flash';
  fx.setAttribute('aria-hidden', 'true');
  loader.appendChild(fx);

  const shock = document.createElement('div');
  shock.className = 'loader-shockwave';
  shock.setAttribute('aria-hidden', 'true');
  loader.appendChild(shock);

  const ground = document.createElement('div');
  ground.className = 'loader-impact-glow';
  ground.setAttribute('aria-hidden', 'true');
  loader.appendChild(ground);
}

/* ============================================================
   6b. SMOOTH MENU TRANSITIONS (no black reload flash)
   ------------------------------------------------------------
   Internal links (nav menu, genre dropdown, Top IMDB, Watchlist,
   footer, cards) fade the page content out — the navbar and the
   dark surface stay on screen — then navigate. The destination
   page detects the transition, skips its black loading screen,
   and fades the new content in. Modified clicks (new tab /
   window), external URLs, anchors and the lightning-flash Play
   CTAs are never intercepted.
   ============================================================ */
const NAV_FADE_MS = 200; // content fade-out before navigating

function initSmoothNavigation() {
  const reducedMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    // Never hijack modified clicks (new tab / window / download)
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const link = event.target instanceof Element ? event.target.closest('a') : null;
    if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
    // Play CTAs run their own lightning-flash transition
    if (link.classList.contains('btn-primary')) return;

    const href = link.getAttribute('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:')
      || href.startsWith('mailto:') || href.startsWith('tel:')) return;

    let url;
    try {
      url = new URL(link.href, window.location.href);
    } catch (urlError) {
      return;
    }
    if (url.origin !== window.location.origin) return;
    if (!/\.html?$/i.test(url.pathname)) return;

    event.preventDefault();

    // Flag the arrival page (its <head> script + initPageLoader
    // consume this) so the black loader never flashes there.
    try { sessionStorage.setItem('zeus_nav_transition', '1'); } catch (storageError) { /* private mode */ }

    const go = () => { window.location.href = url.href; };
    if (reducedMotion) {
      go();
      return;
    }

    document.body.classList.add('nav-leaving');
    setTimeout(go, NAV_FADE_MS);
    setTimeout(go, NAV_FADE_MS + 1500); // safety net if navigation stalls
  });

  // Back/forward cache: drop the leaving state if the page is restored
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) document.body.classList.remove('nav-leaving');
  });
}

/** Navbar background + shadow after scrolling past 30px. */
function initNavbar() {
  const navbar = $('#navbar');
  if (!navbar) return;
  const onScroll = () => {
    navbar.classList.toggle('scrolled', window.scrollY > 30);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

/** Mobile hamburger menu (slide-in panel + body scroll lock). */
function initHamburgerMenu() {
  const hamburger = $('#hamburger');
  const navMenu = $('#nav-menu');
  if (!hamburger || !navMenu) return;

  const closeMenu = () => {
    hamburger.classList.remove('active');
    navMenu.classList.remove('open');
    hamburger.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('no-scroll');
  };

  hamburger.addEventListener('click', (event) => {
    event.stopPropagation();
    const isOpen = navMenu.classList.toggle('open');
    hamburger.classList.toggle('active', isOpen);
    hamburger.setAttribute('aria-expanded', String(isOpen));
    document.body.classList.toggle('no-scroll', isOpen);
  });

  // Close when a link inside the mobile menu is clicked
  navMenu.addEventListener('click', (event) => {
    if (event.target.closest('a') && !event.target.closest('.dropdown-toggle')) {
      closeMenu();
    }
  });

  // Close when clicking outside
  document.addEventListener('click', (event) => {
    if (
      navMenu.classList.contains('open') &&
      !navMenu.contains(event.target) &&
      !hamburger.contains(event.target)
    ) {
      closeMenu();
    }
  });

  // Close on Escape
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });
}

/**
 * Genre dropdown: CSS handles hover on desktop; this adds
 * click-toggle support (mobile menu + keyboard/touch users).
 */
function initGenreDropdown() {
  const dropdown = $('.nav-dropdown');
  if (!dropdown) return;
  const toggle = dropdown.querySelector('.dropdown-toggle');
  const menu = dropdown.querySelector('.dropdown-menu');
  if (!toggle || !menu) return;

  toggle.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const isOpen = dropdown.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(isOpen));
  });

  document.addEventListener('click', (event) => {
    if (!dropdown.contains(event.target)) {
      dropdown.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      dropdown.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
}

/** Floating 'Back to Top' button — visible after 400px scroll. */
function initBackToTop() {
  const button = $('#back-to-top');
  if (!button) return;
  const onScroll = () => {
    button.classList.toggle('visible', window.scrollY > 400);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  button.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

/** Auto current year in the footer copyright line. */
function initFooterYear() {
  const yearEl = $('#current-year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();
}

/* ============================================================
   7. DISCLAIMER BANNER (dismissible, remembered in localStorage)
   ============================================================ */
const DISCLAIMER_STORAGE_KEY = 'streamverse_disclaimer_dismissed';

/**
 * Show the top disclaimer banner unless the user dismissed it
 * before. Dismissal is persisted in localStorage and shared by
 * every page, so it only ever appears once per browser.
 */
function initDisclaimerBanner() {
  const banner = $('#disclaimer-banner');
  if (!banner) return;

  let dismissed = false;
  try {
    dismissed = window.localStorage.getItem(DISCLAIMER_STORAGE_KEY) === '1';
  } catch (storageError) {
    dismissed = false;
  }
  if (dismissed) return;

  banner.hidden = false;
  document.body.classList.add('banner-visible');

  const closeBtn = $('#disclaimer-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      banner.hidden = true;
      document.body.classList.remove('banner-visible');
      try {
        window.localStorage.setItem(DISCLAIMER_STORAGE_KEY, '1');
      } catch (storageError) {
        /* private mode — banner will simply reappear next visit */
      }
    });
  }
}
