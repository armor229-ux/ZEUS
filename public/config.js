/* ============================================================
   ZEUS - config.js
   Central configuration: TMDB API credentials, image sizes
   and genre catalog.
   (Active streaming servers live in watch.js SERVER_URLS.)
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
