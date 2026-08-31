/* ============================================================
   ZEUS - config.js
   Central configuration: TMDB API credentials, image sizes,
   streaming servers and genre catalog.
   ============================================================ */

'use strict';

/* ---------------- TMDB API Configuration ---------------- */
// Get your free API key at: https://www.themoviedb.org/settings/api
const API_KEY = '713e5af0bbfe1f11c6dca936987279ad';

const API_BASE_URL = 'https://api.themoviedb.org/3';
const IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/';

/* ---------------- Image Sizes ---------------- */
const POSTER_SIZE = 'w500';        // Movie / TV posters
const BACKDROP_SIZE = 'original';  // Hero banners & detail backdrops
const BACKDROP_MD_SIZE = 'w780';   // Medium backdrops (episodes stills pages)
const PROFILE_SIZE = 'w185';       // Actor profile photos
const STILL_SIZE = 'w300';         // Episode still images

/* ---------------- Site Info ---------------- */
const SITE_NAME = 'ZEUS';
const SITE_TAGLINE = 'Stream the gods of cinema';
const SITE_URL = 'https://zeus.example.com'; // change to your domain

/* ---------------- Streaming Servers ----------------
   Six high-reliability, tested embed providers only.
   Each button carries a quality badge: 1080p / 4K / Multi-sub.
   TV format: /tv/{tmdb_id}/{season}/{episode}
   NOTE: servers change frequently — if one goes down,
   the player auto-falls back to the next one (8s) and
   users can always switch manually.                 */
const SERVERS = [
  {
    id: 'vidsrc-to',
    label: '1080p',
    name: 'VidSrc To',
    movie: (id) => `https://vidsrc.to/embed/movie/${id}`,
    tv: (id, season, episode) => `https://vidsrc.to/embed/tv/${id}/${season}/${episode}`
  },
  {
    id: 'vidsrc-cc',
    label: '1080p',
    name: 'VidSrc CC',
    movie: (id) => `https://vidsrc.cc/v2/embed/movie/${id}`,
    tv: (id, season, episode) => `https://vidsrc.cc/v2/embed/tv/${id}/${season}/${episode}`
  },
  {
    id: 'embed-su',
    label: '4K',
    name: 'EmbedSu',
    movie: (id) => `https://embed.su/embed/movie/${id}`,
    tv: (id, season, episode) => `https://embed.su/embed/tv/${id}/${season}/${episode}`
  },
  {
    id: 'videasy',
    label: '4K · Multi-sub',
    name: 'Videasy',
    movie: (id) => `https://player.videasy.net/movie/${id}?color=e50914`,
    tv: (id, season, episode) => `https://player.videasy.net/tv/${id}/${season}/${episode}?color=e50914`
  },
  {
    id: 'superembed',
    label: 'Multi-sub',
    name: 'SuperEmbed',
    movie: (id) => `https://multiembed.mov/?video_id=${id}&tmdb=1`,
    tv: (id, season, episode) => `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${season}&e=${episode}`
  },
  {
    id: 'autoembed',
    label: '1080p',
    name: 'AutoEmbed',
    movie: (id) => `https://player.autoembed.cc/embed/movie/${id}`,
    tv: (id, season, episode) => `https://player.autoembed.cc/embed/tv/${id}/${season}/${episode}`
  }
];

/* ---------------- Player Tuning ---------------- */
const PLAYER_CONFIG = {
  serverFallbackMs: 8000 // auto-switch to the next server after this long without a load event
};

/* ---------------- Genre Catalog (TMDB Genre IDs) ---------------- */
const GENRE_LIST = [
  { id: 28,       name: 'Action' },
  { id: 12,       name: 'Adventure' },
  { id: 16,       name: 'Animation' },
  { id: 35,       name: 'Comedy' },
  { id: 80,       name: 'Crime' },
  { id: 99,       name: 'Documentary' },
  { id: 18,       name: 'Drama' },
  { id: 10751,    name: 'Family' },
  { id: 14,       name: 'Fantasy' },
  { id: 36,       name: 'History' },
  { id: 27,       name: 'Horror' },
  { id: 10402,    name: 'Music' },
  { id: 9648,     name: 'Mystery' },
  { id: 10749,    name: 'Romance' },
  { id: 878,      name: 'Science Fiction' },
  { id: 53,       name: 'Thriller' },
  { id: 10752,    name: 'War' },
  { id: 37,       name: 'Western' }
];

/* ---------------- Quick Genre Lookup ---------------- */
const GENRE_MAP = GENRE_LIST.reduce((map, genre) => {
  map[genre.id] = genre.name;
  return map;
}, {});

/* ---------------- UI Tuning ---------------- */
const CONFIG = {
  heroSlideCount: 5,          // number of featured slides on the homepage
  heroAutoPlayInterval: 6000, // ms between hero slides
  heroOverviewLines: 3,       // clamp lines for hero overview text
  cardsPerRow: 18,            // max cards rendered per homepage row
  castCount: 20,              // max cast members displayed
  similarCount: 12,           // max similar titles displayed
  searchDebounce: 450,        // ms debounce for live search
  skeletonCards: 10,          // default skeleton cards while loading
  scrollAmountRatio: 0.85     // fraction of row width scrolled by arrows
};
