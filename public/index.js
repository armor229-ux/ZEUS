/* ============================================================
   ZEUS - index.js
   Homepage logic: hero slider (auto-sliding, dots, arrows,
   pause-on-hover) with a cinematic auto-playing muted direct-MP4
   <video> trailer layer + mute toggle (Ken Burns backdrop
   fallback when no stream is available), four content rows with
   skeletons, error handling and smooth horizontal scroll
   with arrow buttons.
   ============================================================ */

'use strict';

/* ============================================================
   STATE
   ============================================================ */
let heroSlides = [];
let heroGenreMap = {};
let currentSlide = 0;
let heroTimer = null;

/* Hero trailer state */
let heroTrailerHandle = null;  // the single shared <video> player handle
let heroTrailerMuted = true;   // sound state of the current trailer
let heroTrailerToken = 0;      // guards async work across slide changes

/* ============================================================
   INIT
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  initCommonUI();
  initSectionArrows();
  loadHero();
  loadHomeRows();
});

/* ============================================================
   HOMEPAGE CONTENT ROWS
   Existing rows (unchanged) + the five new sections.
   ============================================================ */
function loadHomeRows() {
  /* --- NEW: TOP 10 Today (below the hero, above everything else) --- */
  loadTop10Row();

  /* --- NEW: Streaming provider tabs (default: Netflix) --- */
  initProviderTabs();

  // Trending leads with an editorial widescreen (16:9 backdrop) row;
  // the remaining rows stay classic 2:3 poster rails.
  loadSection($('#trending-row'), getTrending, {
    filterPerson: true,
    requireBackdrop: true,
    wide: true,
    horizontal: true,
    emptyMessage: 'No trending titles available right now.'
  });
  loadSection($('#popular-row'), getPopularMovies, {
    requirePoster: true,
    horizontal: true,
    emptyMessage: 'No popular movies available right now.'
  });

  /* --- NEW: Current & upcoming TV shows (16:9 backdrop cards) --- */
  loadTvUpcomingRow();

  loadSection($('#top-rated-row'), getTopRatedMovies, {
    requirePoster: true,
    horizontal: true,
    emptyMessage: 'No top rated movies available right now.'
  });

  /* --- NEW: Recently added in 4K (16:9 backdrop cards + 4K pill) --- */
  loadRecent4KRow();

  loadSection($('#latest-tv-row'), getOnTheAirTV, {
    requirePoster: true,
    horizontal: true,
    emptyMessage: 'No TV shows airing right now.'
  });

  /* --- NEW: Popular Genres mood cards (very bottom, above footer) --- */
  loadGenreMoods();
}

/* ============================================================
   NEW SECTION 1 — TOP 10 TODAY
   ------------------------------------------------------------
   Ten 2:3 poster cards from /trending/all/day, each with a red
   "TOP / number" badge in the top-left corner. Same card
   component, hover trailers and watchlist hearts as every
   other row.
   ============================================================ */
async function loadTop10Row() {
  const row = $('#top10-row');
  if (!row) return;
  showSkeletons(row, 10, 'card');
  try {
    const data = await getTrendingToday();
    const items = ((data && data.results) || [])
      .filter((item) => item.media_type !== 'person' && item.poster_path)
      .slice(0, 10);
    if (!items.length) {
      showEmptyState(row, 'No trending titles available right now.');
      return;
    }
    row.innerHTML = '';
    const fragment = document.createDocumentFragment();
    items.forEach((item, index) => {
      fragment.appendChild(createMovieCard(item, { rank: index + 1 }));
    });
    row.appendChild(fragment);
  } catch (error) {
    showErrorState(row, error.message, loadTop10Row);
  }
}

/* ============================================================
   NEW SECTION 2 — STREAMING PROVIDER TABS (brand-coloured)
   ------------------------------------------------------------
   Seven provider tabs (Netflix, Prime Video, HBO Max, Disney+,
   Apple TV+, Paramount+, Hulu), each styled with its official
   brand colour. Clicking a tab loads that provider's most
   popular movies AND TV shows (mixed, 20+ titles, US region)
   into the row below and updates the section header ("Only on
   Netflix", ...). Hovering or clicking a tab bathes the whole
   section in a smooth gradient of that brand's colours and
   makes the brand name glow. Netflix is active by default.
   ============================================================ */

/* Brand colour data per provider id (mirrored by CSS in the
   [data-brand="..."] rules on the section element). */
const PROVIDER_BRANDS = {
  '8':    'netflix',
  '9':    'prime',
  '1899': 'hbo',
  '337':  'disney',
  '350':  'apple',
  '531':  'paramount',
  '15':   'hulu'
};

const PROVIDER_TABS_SECTION = () => $('#provider-section');

/** Paint the section background + brand glow for a provider id. */
function setProviderBrand(providerId) {
  const section = PROVIDER_TABS_SECTION();
  if (!section) return;
  const brand = PROVIDER_BRANDS[String(providerId)] || 'netflix';
  section.dataset.brand = brand;
}

/** Instantly rewrite the section header — "Only on NETFLIX",
    "Only on DISNEY+", ... The brand name is uppercased and
    painted in the brand's exact colour by the [data-brand]
    CSS. Used for hover previews AND for real tab clicks. */
function setProviderHeading(providerName) {
  const title = $('#provider-title');
  if (title) {
    title.innerHTML = `<span class="title-bar"></span>Only on <span class="brand-name">${escapeHtml(providerName)}</span>`;
  }
}

function initProviderTabs() {
  const tabs = $$('.provider-tab');
  if (!tabs.length) return;

  let activeTab = tabs.find((tab) => tab.classList.contains('active')) || tabs[0];

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      if (tab.classList.contains('active')) return;
      activeTab = tab;
      tabs.forEach((other) => {
        const isActive = other === tab;
        other.classList.toggle('active', isActive);
        other.setAttribute('aria-selected', String(isActive));
      });
      setProviderBrand(tab.dataset.provider);
      loadProviderContent(tab.dataset.provider, tab.dataset.name);
    });

    // Hovering a tab previews that brand instantly: the ambient
    // wash glides over, the tab scales + glows, and the header
    // text swaps to the hovered brand ("Only on DISNEY+", ...).
    tab.addEventListener('mouseenter', () => {
      setProviderBrand(tab.dataset.provider);
      setProviderHeading(tab.dataset.name);
    });
  });

  const strip = $('#provider-tabs');
  if (strip) {
    // Leaving the tab strip restores the ACTIVE brand + header.
    strip.addEventListener('mouseleave', () => {
      setProviderBrand(activeTab ? activeTab.dataset.provider : '8');
      setProviderHeading(activeTab ? activeTab.dataset.name : 'Netflix');
    });
  }

  // Default active tab: Netflix
  setProviderBrand('8');
  loadProviderContent('8', 'Netflix');
}

function loadProviderContent(providerId, providerName) {
  setProviderHeading(providerName);
  loadProviderMixedRail(providerId);
}

/** Fetch a provider's movies AND TV shows, merge them into one
    mixed rail (interleaved, de-duplicated, 24 titles) and render
    it with the standard card component. */
async function loadProviderMixedRail(providerId) {
  const row = $('#provider-row');
  if (!row) return;
  showSkeletons(row, 8, 'card');
  try {
    const [moviesRes, tvRes] = await Promise.allSettled([
      discoverByProvider(providerId),
      discoverTVByProvider(providerId)
    ]);

    const movies = moviesRes.status === 'fulfilled' ? (moviesRes.value.results || []) : [];
    const shows = tvRes.status === 'fulfilled' ? (tvRes.value.results || []) : [];

    // Tag the media type explicitly — discover endpoints return
    // bare results, and movie/tv id namespaces can collide.
    movies.forEach((m) => { m.media_type = 'movie'; });
    shows.forEach((s) => { s.media_type = 'tv'; });

    // Interleave movie/TV/movie/TV so both media are represented
    // along the whole rail, then drop numeric id collisions.
    const seen = new Set();
    const mixed = [];
    const maxLen = Math.max(movies.length, shows.length);
    for (let i = 0; i < maxLen; i++) {
      [movies[i], shows[i]].forEach((item) => {
        if (!item || !item.poster_path) return;
        const key = `${item.media_type}-${item.id}`;
        if (seen.has(key)) return;
        seen.add(key);
        mixed.push(item);
      });
    }

    const items = mixed.slice(0, 24); // 20+ titles per provider
    if (!items.length) {
      showEmptyState(row, 'No titles available for this service right now.');
      return;
    }

    row.innerHTML = '';
    const fragment = document.createDocumentFragment();
    items.forEach((item) => fragment.appendChild(createMovieCard(item)));
    row.appendChild(fragment);
  } catch (error) {
    showErrorState(row, error.message, () => loadProviderMixedRail(providerId));
  }
}

/* ============================================================
   NEW SECTION 3 — CURRENT & UPCOMING TV SHOWS
   ------------------------------------------------------------
   Wide 16:9 backdrop cards fed by /tv/on_the_air and
   /tv/airing_today (merged, de-duplicated). Cards carry red
   "New episode" / "New season" flags and "S1·E3" episode info
   in the metadata line, derived from the episode data TMDB
   attaches to those endpoints.
   ============================================================ */
async function loadTvUpcomingRow() {
  const row = $('#tv-upcoming-row');
  if (!row) return;
  showSkeletons(row, 8, 'card-wide');
  try {
    const [onAir, airingToday] = await Promise.allSettled([
      getOnTheAirTV(),
      getAiringTodayTV()
    ]);
    const onAirItems = onAir.status === 'fulfilled' ? (onAir.value.results || []) : [];
    const airingItems = airingToday.status === 'fulfilled' ? (airingToday.value.results || []) : [];
    if (!onAirItems.length && !airingItems.length) {
      throw new Error('No TV schedule data available.');
    }

    // Shows with an episode airing today come first, then the rest.
    const seen = new Set();
    const items = [...airingItems, ...onAirItems]
      .filter((show) => {
        if (!show || !show.backdrop_path || seen.has(show.id)) return false;
        seen.add(show.id);
        return true;
      })
      .slice(0, CONFIG.cardsPerRow);

    if (!items.length) {
      showEmptyState(row, 'No upcoming TV shows available right now.');
      return;
    }

    // List endpoints don't carry episode data — pull each show's
    // brief details (next/last episode) so cards can show the
    // "New episode" / "New season" flags and "S1·E3" info.
    // Requests are staggered to stay well inside TMDB rate limits.
    const enriched = await Promise.all(items.map(async (show, index) => {
      try {
        await new Promise((resolve) => setTimeout(resolve, index * 60));
        const detail = await getTVBrief(show.id);
        return {
          ...show,
          next_episode_to_air: detail.next_episode_to_air || null,
          last_episode_to_air: detail.last_episode_to_air || null
        };
      } catch (error) {
        return show; // episode info is optional decoration
      }
    }));

    row.innerHTML = '';
    const fragment = document.createDocumentFragment();
    enriched.forEach((show) => {
      const { badge, metaNote } = describeTvEpisode(show);
      fragment.appendChild(createMovieCard(show, { wide: true, badge, metaNote }));
    });
    row.appendChild(fragment);
  } catch (error) {
    showErrorState(row, error.message, loadTvUpcomingRow);
  }
}

/** Derive the "New episode" / "New season" flag and "S1·E3"
    metadata from a show's next/last episode data. */
function describeTvEpisode(show) {
  const next = show.next_episode_to_air;
  const last = show.last_episode_to_air;
  const today = new Date().toISOString().slice(0, 10);

  if (next && next.season_number && next.episode_number && next.air_date >= today) {
    return {
      badge: next.episode_number === 1 ? { text: 'New season' } : { text: 'New episode' },
      metaNote: `S${next.season_number}·E${next.episode_number}`
    };
  }
  if (last && last.season_number && last.episode_number) {
    const airedRecently = last.air_date &&
      (Date.now() - new Date(last.air_date).getTime()) / 86400000 <= 7;
    return {
      badge: airedRecently ? { text: 'New episode' } : null,
      metaNote: `S${last.season_number}·E${last.episode_number}`
    };
  }
  return { badge: null, metaNote: null };
}

/* ============================================================
   NEW SECTION 4 — RECENTLY ADDED IN 4K
   ------------------------------------------------------------
   Wide 16:9 backdrop cards from
   /discover/movie?sort_by=release_date.desc&vote_count.gte=50,
   filtered to already-released titles, each wearing a small
   red "4K" pill.
   ============================================================ */
async function loadRecent4KRow() {
  const row = $('#recent-4k-row');
  if (!row) return;
  showSkeletons(row, 8, 'card-wide');
  try {
    const data = await getRecentMovies();
    const today = new Date().toISOString().slice(0, 10);
    const items = ((data && data.results) || [])
      .filter((movie) => movie.backdrop_path && movie.release_date && movie.release_date <= today)
      .slice(0, CONFIG.cardsPerRow);

    if (!items.length) {
      showEmptyState(row, 'No recent releases available right now.');
      return;
    }

    row.innerHTML = '';
    const fragment = document.createDocumentFragment();
    items.forEach((movie) => {
      fragment.appendChild(createMovieCard(movie, {
        wide: true,
        badge: { text: '4K', modifier: 'card-flag--pill' }
      }));
    });
    row.appendChild(fragment);
  } catch (error) {
    showErrorState(row, error.message, loadRecent4KRow);
  }
}

/* ============================================================
   NEW SECTION 5 — POPULAR GENRES (mood cards)
   ------------------------------------------------------------
   Eight colored gradient cards (NOT posters): a representative
   movie backdrop under a strong per-genre color gradient, the
   genre name bottom-left. Clicking opens browse.html?genre={id}.
   ============================================================ */
const GENRE_MOODS = [
  { id: 35,    name: 'Comedy',           cls: 'comedy' },
  { id: 28,    name: 'Action',           cls: 'action' },
  { id: 18,    name: 'Drama',            cls: 'drama' },
  { id: 27,    name: 'Horror',           cls: 'horror' },
  { id: 10749, name: 'Romance',          cls: 'romance' },
  { id: 12,    name: 'Adventure',        cls: 'adventure' },
  { id: 878,   name: 'Science Fiction',  cls: 'scifi' },
  { id: 53,    name: 'Thriller',         cls: 'thriller' }
];

async function loadGenreMoods() {
  const row = $('#genre-row');
  if (!row) return;
  showSkeletons(row, 8, 'card-wide');
  try {
    const artPaths = await Promise.all(
      GENRE_MOODS.map(async (genre) => {
        try {
          const data = await discoverByGenre(genre.id);
          const hit = ((data && data.results) || []).find((movie) => movie.backdrop_path);
          return hit ? hit.backdrop_path : null;
        } catch (error) {
          return null; // gradient-only card still renders
        }
      })
    );

    row.innerHTML = '';
    const fragment = document.createDocumentFragment();
    GENRE_MOODS.forEach((genre, index) => {
      fragment.appendChild(createGenreCard(genre, artPaths[index]));
    });
    row.appendChild(fragment);
  } catch (error) {
    showErrorState(row, error.message, loadGenreMoods);
  }
}

/** Build one mood card: backdrop art + strong genre gradient. */
function createGenreCard(genre, backdropPath) {
  const card = document.createElement('a');
  card.className = `genre-card genre-card--${genre.cls}`;
  card.href = `browse.html?genre=${genre.id}`;
  card.setAttribute('aria-label', `Browse ${genre.name} movies`);
  if (backdropPath) {
    card.style.setProperty('--genre-art', `url('${IMAGE_BASE_URL}${BACKDROP_MD_SIZE}${backdropPath}')`);
  }
  card.innerHTML = `<span class="genre-name">${escapeHtml(genre.name)}</span>`;
  return card;
}

/* ============================================================
   HERO SLIDER
   ============================================================ */
async function loadHero() {
  try {
    // Genres are non-critical — failure just hides the chips.
    try {
      const genreData = await getGenres();
      heroGenreMap = {};
      (genreData.genres || []).forEach((g) => {
        heroGenreMap[g.id] = g.name;
      });
    } catch (genreError) {
      heroGenreMap = {};
    }

    const data = await getTrending();
    const results = (data.results || [])
      .filter((item) => item.media_type !== 'person' && item.backdrop_path)
      .slice(0, CONFIG.heroSlideCount);

    if (!results.length) {
      showHeroError('No featured titles could be loaded.');
      return;
    }

    heroSlides = results;
    renderHeroSlides();
    startAutoSlide();
  } catch (error) {
    showHeroError(error.message);
  }
}

function showHeroError(message) {
  const hero = $('#hero');
  if (!hero) return;
  // Hide (don't remove) controls so a later successful re-render can restore them
  ['#hero-skeleton', '#hero-dots', '#hero-prev', '#hero-next'].forEach((sel) => {
    const el = $(sel);
    if (el) el.setAttribute('hidden', '');
  });

  const existingError = $('#hero-error');
  if (existingError) existingError.remove();

  const errorBox = document.createElement('div');
  errorBox.className = 'hero-content';
  errorBox.id = 'hero-error';
  errorBox.innerHTML = `
    <div class="container">
      <div class="hero-text">
        <span class="hero-media-type">ZEUS</span>
        <h1 class="hero-title">Watch Movies &amp; TV Shows Online Free</h1>
        <p class="hero-overview">Failed to load featured titles. ${escapeHtml(message)}</p>
        <div class="hero-buttons">
          <button class="btn btn-primary" id="hero-retry">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
            Try Again
          </button>
          <a href="search.html" class="btn btn-glass">Browse Titles</a>
        </div>
      </div>
    </div>
  `;
  hero.appendChild(errorBox);
  const retry = errorBox.querySelector('#hero-retry');
  if (retry) {
    retry.addEventListener('click', async () => {
      errorBox.remove();
      const skeleton = document.createElement('div');
      skeleton.className = 'hero-skeleton';
      skeleton.id = 'hero-skeleton';
      skeleton.removeAttribute('hidden');
      hero.prepend(skeleton);
      await loadHero();
    });
  }
}

function renderHeroSlides() {
  const hero = $('#hero');
  if (!hero) return;

  // Remove skeleton + any stale error UI, restore controls
  const skeleton = $('#hero-skeleton');
  if (skeleton) skeleton.remove();
  const staleError = $('#hero-error');
  if (staleError) staleError.remove();
  // Clear any previously rendered slides (defensive against re-entry)
  $$('.hero-slide', hero).forEach((slide) => slide.remove());
  ['#hero-dots', '#hero-prev', '#hero-next'].forEach((sel) => {
    const el = $(sel);
    if (el) el.removeAttribute('hidden');
  });

  // Build slides
  const slidesHtml = heroSlides.map((item, index) => {
    const type = getMediaType(item);
    const title = getMediaTitle(item);
    const year = getMediaYear(item);
    const rating = item.vote_average ? item.vote_average.toFixed(1) : 'N/A';
    const backdrop = imageUrl(item.backdrop_path, BACKDROP_SIZE, FALLBACK_STILL);
    const genreNames = (item.genre_ids || [])
      .map((id) => heroGenreMap[id] || GENRE_MAP[id])
      .filter(Boolean)
      .slice(0, 3);
    const overview = item.overview || 'No description available.';

    return `
      <div class="hero-slide ${index === 0 ? 'active' : ''}" role="tabpanel" aria-hidden="${index !== 0}">
        <div class="hero-backdrop" style="background-image:url('${backdrop}')"></div>
        <div class="hero-trailer" aria-hidden="true"></div>
        <div class="hero-overlay"></div>
        <div class="hero-content">
          <div class="container">
            <div class="hero-text">
              <span class="hero-media-type">${type === 'tv' ? 'TV Series' : 'Movie'}</span>
              <h1 class="hero-title">${escapeHtml(title)}</h1>
              <div class="hero-meta">
                <span class="rating-badge">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                    <path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
                  </svg>
                  <span>${rating}</span>
                </span>
                <span class="dot"></span>
                <span>${year}</span>
                ${genreNames.length ? '<span class="dot"></span>' : ''}
              </div>
              ${genreNames.length ? `
              <div class="hero-genres">
                ${genreNames.map((name) => `<span class="hero-genre-chip">${escapeHtml(name)}</span>`).join('')}
              </div>` : ''}
              <p class="hero-overview">${escapeHtml(overview)}</p>
              <div class="hero-buttons">
                <a class="btn btn-primary" href="${getWatchHref(item)}">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                  Watch Now
                </a>
                <a class="btn btn-glass" href="${getMediaHref(item)}">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 7h2v2h2v2h-2v2h-2v-2H9V9h2V7zm7 3c0 4-3.1 7.4-7 8.9-3.9-1.5-7-4.9-7-8.9V6l7-3 7 3v4z"/></svg>
                  More Info
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  hero.insertAdjacentHTML('afterbegin', slidesHtml);

  // Build dots
  const dotsContainer = $('#hero-dots');
  if (dotsContainer) {
    dotsContainer.innerHTML = heroSlides
      .map((_, i) => `<button class="hero-dot ${i === 0 ? 'active' : ''}" data-index="${i}" role="tab" aria-label="Go to slide ${i + 1}"></button>`)
      .join('');
    dotsContainer.addEventListener('click', (event) => {
      const dot = event.target.closest('.hero-dot');
      if (dot) goToSlide(Number(dot.dataset.index), true);
    });
  }

  // Arrows
  const prev = $('#hero-prev');
  const next = $('#hero-next');
  if (prev) prev.addEventListener('click', () => goToSlide(currentSlide - 1, true));
  if (next) next.addEventListener('click', () => goToSlide(currentSlide + 1, true));

  // Trailer sound toggle
  const muteBtn = $('#hero-mute-btn');
  if (muteBtn) muteBtn.addEventListener('click', toggleHeroTrailerMute);

  // Pause auto-slide on hover
  hero.addEventListener('mouseenter', stopAutoSlide);
  hero.addEventListener('mouseleave', startAutoSlide);

  // Pause when tab is hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopAutoSlide();
    else startAutoSlide();
  });

  // Warm the trailer-key cache for every slide (staggered, cheap
  // JSON calls) so later transitions fade straight into video.
  heroSlides.forEach((item, i) => {
    setTimeout(() => getTrailerKey(item.id, getMediaType(item)), 300 + i * 250);
  });

  // Kick off the first slide's cinematic trailer
  syncHeroTrailer();
}

function goToSlide(index, manual = false) {
  if (!heroSlides.length) return;
  const slides = $$('.hero-slide');
  const dots = $$('.hero-dot');
  if (!slides.length) return;

  currentSlide = (index + heroSlides.length) % heroSlides.length;

  slides.forEach((slide, i) => {
    slide.classList.toggle('active', i === currentSlide);
    slide.setAttribute('aria-hidden', String(i !== currentSlide));
  });
  dots.forEach((dot, i) => dot.classList.toggle('active', i === currentSlide));

  syncHeroTrailer();

  if (manual) startAutoSlide(); // reset the timer
}

function startAutoSlide() {
  stopAutoSlide();
  if (!heroSlides.length) return;
  heroTimer = setInterval(() => goToSlide(currentSlide + 1), CONFIG.heroAutoPlayInterval);
}

function stopAutoSlide() {
  if (heroTimer) {
    clearInterval(heroTimer);
    heroTimer = null;
  }
}

/* ============================================================
   HERO TRAILER (Netflix-style auto-playing muted trailer)
   Every slide keeps an empty .hero-trailer layer between its
   backdrop image and the gradient overlay. While a slide is
   active we: show the backdrop for 2s, fetch the title's
   trailer key (cached), fade a single shared chrome-free
   <video> (direct MP4 sources — VidSrc trailer endpoint, then
   Invidious stream proxies) into that slide's layer, and swap
   it out again when the slide changes. When every source
   fails the backdrop itself gets the Ken Burns pan/zoom, so
   the hero never falls flat.
   ============================================================ */
const HERO_TRAILER_DELAY_MS = 2000; // backdrop-first delay before the video fades in

function syncHeroTrailer() {
  const token = ++heroTrailerToken;
  stopHeroTrailer();

  const item = heroSlides[currentSlide];
  if (!item || document.hidden) return;

  // Ambient lighting: the whole site glows with the active
  // slide's colours (Apple TV+ vibrancy).
  ambientBackdrop.setBase(item);

  const type = getMediaType(item);
  const delay = new Promise((resolve) => setTimeout(resolve, HERO_TRAILER_DELAY_MS));
  const keyPromise = getTrailerKey(item.id, type);

  Promise.all([delay, keyPromise]).then(([ , key]) => {
    // Slide changed (or trailer stopped) while we were waiting
    if (token !== heroTrailerToken) return;
    if (heroSlides[currentSlide] !== item || document.hidden) return;
    startHeroTrailer(item, key);
  });
}

function startHeroTrailer(item, videoKey) {
  const slide = $$('.hero-slide')[currentSlide];
  const layer = slide ? slide.querySelector('.hero-trailer') : null;
  if (!layer) return;

  const mediaType = getMediaType(item);
  const cached = trailerSourceCache.get(trailerCacheKey(item.id, mediaType));
  // Cached total failure or tripped session circuit breaker ->
  // no network, straight to Ken Burns.
  const sources = (cached && cached.status === 'failed') || !trailerChainEnabled()
    ? []
    : orderedTrailerSources(item, videoKey);
  if (!sources.length) {
    applyHeroKenBurns(slide);
    return;
  }

  // Baseline: the backdrop is alive (Ken Burns pan) while the
  // stream connects — the video fades in over it on playback.
  applyHeroKenBurns(slide);

  heroTrailerHandle = mountTrailerVideo(layer, sources, {
    watchdogMs: 5000,
    onSourceDead: noteSourceDead,
    onResolved(src) {
      rememberTrailerSource(item.id, mediaType, src);
      if (src) console.log('HERO TRAILER PLAYING', item.id, src);
    },
    onPlaying() {
      // Slide changed while the stream was connecting
      if (heroSlides[currentSlide] !== item) {
        stopHeroTrailer();
        return;
      }
      // The moving picture replaces the Ken Burns pan.
      removeHeroKenBurns(slide);
      heroTrailerMuted = true;
      updateHeroMuteButton();
      requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add('playing')));
      const muteBtn = $('#hero-mute-btn');
      if (muteBtn) muteBtn.hidden = false;
    },
    onFailed() {
      // Every direct source failed -> Ken Burns backdrop fallback
      // (already running — just make sure it is on).
      if (heroSlides[currentSlide] !== item) return;
      applyHeroKenBurns(slide);
    }
  });
}

/** Ken Burns fallback: the slide's backdrop slowly pans/zooms
    (20s loop) — premium even without video. */
function applyHeroKenBurns(slide) {
  const backdrop = slide ? slide.querySelector('.hero-backdrop') : null;
  if (backdrop) backdrop.classList.add('trailer-fallback');
}

function removeHeroKenBurns(slide) {
  const backdrop = slide ? slide.querySelector('.hero-backdrop') : null;
  if (backdrop) backdrop.classList.remove('trailer-fallback');
}

function stopHeroTrailer() {
  $$('.hero-slide .hero-trailer').forEach((layer) => layer.classList.remove('playing'));
  $$('.hero-slide .hero-backdrop.trailer-fallback').forEach((bd) => bd.classList.remove('trailer-fallback'));

  const muteBtn = $('#hero-mute-btn');
  if (muteBtn) muteBtn.hidden = true;

  if (heroTrailerHandle) {
    // Free the decoder immediately — no fade-out wait needed.
    heroTrailerHandle.destroy();
    heroTrailerHandle = null;
  }
  heroTrailerMuted = true;
}

function toggleHeroTrailerMute() {
  const video = heroTrailerHandle ? heroTrailerHandle.video : null;
  if (!video) return;
  heroTrailerMuted = !heroTrailerMuted;
  video.muted = heroTrailerMuted;
  if (!heroTrailerMuted) {
    try {
      video.volume = 1;
      const attempt = video.play();
      if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {});
    } catch (playError) { /* unmuted resume is best-effort */ }
  }
  updateHeroMuteButton();
}

function updateHeroMuteButton() {
  const btn = $('#hero-mute-btn');
  if (!btn) return;
  btn.classList.toggle('muted', heroTrailerMuted);
  btn.setAttribute('aria-pressed', String(!heroTrailerMuted));
  const label = heroTrailerMuted ? 'Unmute trailer' : 'Mute trailer';
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

/* ============================================================
   HORIZONTAL SCROLL ARROWS (all content rows)
   ============================================================ */
function initSectionArrows() {
  $$('.scroll-btn').forEach((button) => {
    const row = $(button.dataset.target);
    if (!row) return;

    // Scroll by ~85% of visible width
    button.addEventListener('click', () => {
      const amount = row.clientWidth * CONFIG.scrollAmountRatio;
      const direction = button.classList.contains('next') ? 1 : -1;
      row.scrollBy({ left: amount * direction, behavior: 'smooth' });
    });

    // Enable/disable arrows at row edges
    const updateArrows = () => {
      const prevBtn = row.parentElement.querySelector(`.scroll-btn.prev[data-target="${button.dataset.target}"]`);
      const nextBtn = row.parentElement.querySelector(`.scroll-btn.next[data-target="${button.dataset.target}"]`);
      const maxScroll = row.scrollWidth - row.clientWidth;
      if (prevBtn) prevBtn.disabled = row.scrollLeft <= 4;
      if (nextBtn) nextBtn.disabled = row.scrollLeft >= maxScroll - 4;
    };

    let ticking = false;
    row.addEventListener('scroll', () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          updateArrows();
          ticking = false;
        });
        ticking = true;
      }
    }, { passive: true });

    // Initial state + after content loads
    updateArrows();
    const afterLoad = () => updateArrows();
    setTimeout(afterLoad, 1500);
    setTimeout(afterLoad, 3500);
    window.addEventListener('resize', debounce(updateArrows, 200), { passive: true });
  });
}
