/* ============================================================
   ZEUS - anime.js  (v2.0)
   Anime page: powers the dedicated /anime route.

   v1.0 gave anime its own page with five rows (same components
   as every other row on the site). v2.0 (ZEUS FULL UPDATE,
   Part 2) makes the page look like Home: a full-bleed featured
   hero opens it — the EXACT Home hero structure (auto-sliding
   slides, dots, arrows, pause-on-hover, muted MP4 trailer layer
   with Ken Burns fallback, ambient lighting) — and the rows sit
   immediately under the banner. No spacer, no min-height block,
   no empty header zone: banner straight into the rows.

   Anime definition (TMDB): Animation (genre 16) with Japanese
   original language — the same content every anime row uses.

   Hero:   /discover/tv   popularity.desc   (top 5, with backdrop)
   Rows:
     Trending Anime Now      /discover/tv    popularity.desc
     Popular Anime Movies    /discover/movie popularity.desc
     Top Rated Anime          /discover/tv    vote_average.desc
     New & Recent Anime       /discover/tv    first_air_date.desc
     Top Rated Anime Movies   /discover/movie vote_average.desc

   Reuses api.js's shared hero/trailer machinery (getTrailerKey,
   mountTrailerVideo, orderedTrailerSources, ambientBackdrop…)
   and config.js's CONFIG knobs — no new styling (§7 hero), no
   new libraries, no duplicated logic.
   ============================================================ */

'use strict';

/* ---------------- Row configurations ---------------- */
const ANIME_ROWS = [
  {
    selector: '#anime-trending-row',
    type: 'tv',
    params: { sort_by: 'popularity.desc' },
    empty: 'No trending anime available right now.'
  },
  {
    selector: '#anime-movies-row',
    type: 'movie',
    params: { sort_by: 'popularity.desc' },
    empty: 'No anime movies available right now.'
  },
  {
    selector: '#anime-top-row',
    type: 'tv',
    params: { sort_by: 'vote_average.desc', 'vote_count.gte': 300 },
    empty: 'No top rated anime available right now.'
  },
  {
    selector: '#anime-new-row',
    type: 'tv',
    params: { sort_by: 'first_air_date.desc', 'vote_count.gte': 50 },
    empty: 'No new anime available right now.'
  },
  {
    selector: '#anime-top-movies-row',
    type: 'movie',
    params: { sort_by: 'vote_average.desc', 'vote_count.gte': 300 },
    empty: 'No top rated anime movies available right now.'
  }
];

const ANIME_GENRE_ID = 16;        // TMDB "Animation"
const ANIME_LANGUAGE = 'ja';      // Japanese original language

/* ---------------- Hero state (index.js hero, ported) ---------------- */
let animeHeroSlides = [];
let currentSlide = 0;
let heroTimer = null;

/* Hero trailer state */
let animeHeroTrailerHandle = null;  // the single shared <video> player handle
let animeHeroTrailerMuted = true;   // sound state of the current trailer
let animeHeroTrailerToken = 0;      // guards async work across slide changes

const ANIME_HERO_TRAILER_DELAY_MS = 2000; // backdrop-first delay before the video fades in

/* ---------------- Row loader (loadLanguageRow pattern) ---------------- */
async function loadAnimeRow(config) {
  const row = $(config.selector);
  if (!row) return;

  showSkeletons(row, 8, 'card');
  try {
    const data = await fetchFromTMDB(`/discover/${config.type}`, Object.assign({
      with_genres: ANIME_GENRE_ID,
      with_original_language: ANIME_LANGUAGE,
      include_adult: 'false',
      page: 1
    }, config.params));

    const items = ((data && data.results) || [])
      .filter((item) => item.poster_path)
      .slice(0, CONFIG.cardsPerRow);

    if (!items.length) {
      showEmptyState(row, config.empty);
      return;
    }

    // Tag the media type explicitly — discover endpoints return
    // bare results, and movie/tv id namespaces can collide.
    items.forEach((item) => { item.media_type = config.type; });

    row.innerHTML = '';
    const fragment = document.createDocumentFragment();
    items.forEach((item) => fragment.appendChild(createMovieCard(item)));
    row.appendChild(fragment);

    // Ambient lighting: seed the glow with the first backdrop art
    if (typeof ambientBackdrop !== 'undefined' && ambientBackdrop.el && !ambientBackdrop.baseUrl) {
      const seed = items.find((item) => item.backdrop_path || item.poster_path);
      if (seed) ambientBackdrop.setBase(seed);
    }
  } catch (error) {
    showErrorState(row, error.message, () => loadAnimeRow(config));
  }
}

/* ============================================================
   FEATURED ANIME HERO — the Home hero (index.js), ported.
   Same slides, same dots/arrows, same auto-advance, same muted
   trailer layer + Ken Burns fallback, same ambient glow.
   ============================================================ */
async function loadAnimeHero() {
  try {
    const data = await fetchFromTMDB('/discover/tv', {
      with_genres: ANIME_GENRE_ID,
      with_original_language: ANIME_LANGUAGE,
      include_adult: 'false',
      sort_by: 'popularity.desc',
      page: 1
    });

    const results = ((data && data.results) || [])
      .filter((item) => item.backdrop_path)
      .slice(0, CONFIG.heroSlideCount);

    if (!results.length) {
      showAnimeHeroError('No featured anime could be loaded.');
      return;
    }

    // Tag the media type explicitly (discover returns bare results)
    results.forEach((item) => { item.media_type = 'tv'; });

    animeHeroSlides = results;
    renderAnimeHeroSlides();
    startAnimeAutoSlide();
  } catch (error) {
    showAnimeHeroError(error.message);
  }
}

function showAnimeHeroError(message) {
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
        <span class="hero-media-type">ZEUS Anime</span>
        <h1 class="hero-title">Watch Anime Online Free</h1>
        <p class="hero-overview">Failed to load featured anime. ${escapeHtml(message)}</p>
        <div class="hero-buttons">
          <button class="btn btn-primary" id="hero-retry">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
            Try Again
          </button>
          <a href="/discover" class="btn btn-glass">Browse Titles</a>
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
      await loadAnimeHero();
    });
  }
}

function renderAnimeHeroSlides() {
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

  // Build slides — the exact Home hero markup (§7)
  const slidesHtml = animeHeroSlides.map((item, index) => {
    const type = getMediaType(item);
    const title = getMediaTitle(item);
    const year = getMediaYear(item);
    const rating = item.vote_average ? item.vote_average.toFixed(1) : 'N/A';
    const backdrop = imageUrl(item.backdrop_path, BACKDROP_SIZE, FALLBACK_STILL);
    const genreNames = getGenreNames(item.genre_ids);
    const overview = item.overview || 'No description available.';

    return `
      <div class="hero-slide ${index === 0 ? 'active' : ''}" role="tabpanel" aria-hidden="${index !== 0}">
        <div class="hero-backdrop" style="background-image:url('${backdrop}')"></div>
        <div class="hero-trailer" aria-hidden="true"></div>
        <div class="hero-overlay"></div>
        <div class="hero-content">
          <div class="container">
            <div class="hero-text">
              <span class="hero-media-type">${type === 'tv' ? 'Anime Series' : 'Anime Movie'}</span>
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
                <a class="btn btn-primary btn-watchnow" href="${getWatchHref(item)}">
                  <svg class="btn-watchnow-bolt" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2 4.5 13.5h5.2L8.6 22l8.9-11.8h-5.4L13 2z"/></svg>
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
    dotsContainer.innerHTML = animeHeroSlides
      .map((_, i) => `<button class="hero-dot ${i === 0 ? 'active' : ''}" data-index="${i}" role="tab" aria-label="Go to slide ${i + 1}"></button>`)
      .join('');
    dotsContainer.addEventListener('click', (event) => {
      const dot = event.target.closest('.hero-dot');
      if (dot) animeGoToSlide(Number(dot.dataset.index), true);
    });
  }

  // Arrows
  const prev = $('#hero-prev');
  const next = $('#hero-next');
  if (prev) prev.addEventListener('click', () => animeGoToSlide(currentSlide - 1, true));
  if (next) next.addEventListener('click', () => animeGoToSlide(currentSlide + 1, true));

  // Trailer sound toggle
  const muteBtn = $('#hero-mute-btn');
  if (muteBtn) muteBtn.addEventListener('click', toggleAnimeHeroTrailerMute);

  // Pause auto-slide on hover
  hero.addEventListener('mouseenter', stopAnimeAutoSlide);
  hero.addEventListener('mouseleave', startAnimeAutoSlide);

  // Pause when the tab is hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopAnimeAutoSlide();
    else startAnimeAutoSlide();
  });

  // Warm the trailer-key cache for every slide (staggered, cheap
  // JSON calls) so later transitions fade straight into video.
  animeHeroSlides.forEach((item, i) => {
    setTimeout(() => getTrailerKey(item.id, getMediaType(item)), 300 + i * 250);
  });

  // Kick off the first slide's cinematic trailer
  syncAnimeHeroTrailer();
}

function animeGoToSlide(index, manual = false) {
  if (!animeHeroSlides.length) return;
  const slides = $$('.hero-slide');
  const dots = $$('.hero-dot');
  if (!slides.length) return;

  currentSlide = (index + animeHeroSlides.length) % animeHeroSlides.length;

  slides.forEach((slide, i) => {
    slide.classList.toggle('active', i === currentSlide);
    slide.setAttribute('aria-hidden', String(i !== currentSlide));
  });
  dots.forEach((dot, i) => dot.classList.toggle('active', i === currentSlide));

  syncAnimeHeroTrailer();

  if (manual) startAnimeAutoSlide(); // reset the timer
}

function startAnimeAutoSlide() {
  stopAnimeAutoSlide();
  if (!animeHeroSlides.length) return;
  heroTimer = setInterval(() => animeGoToSlide(currentSlide + 1), CONFIG.heroAutoPlayInterval);
}

function stopAnimeAutoSlide() {
  if (heroTimer) {
    clearInterval(heroTimer);
    heroTimer = null;
  }
}

/* ---------------- Hero trailer (index.js trailer, ported) ----------------
   Every slide keeps an empty .hero-trailer layer between its
   backdrop image and the gradient overlay. While a slide is
   active we: show the backdrop for 2s, fetch the title's trailer
   key (cached), fade a single shared chrome-free <video> (direct
   MP4 sources) into that slide's layer, and swap it out again
   when the slide changes. When every source fails the backdrop
   itself gets the Ken Burns pan/zoom. */
function syncAnimeHeroTrailer() {
  const token = ++animeHeroTrailerToken;
  stopAnimeHeroTrailer();

  const item = animeHeroSlides[currentSlide];
  if (!item || document.hidden) return;

  // Ambient lighting: the whole site glows with the active
  // slide's colours (Apple TV+ vibrancy).
  ambientBackdrop.setBase(item);

  const type = getMediaType(item);
  const delay = new Promise((resolve) => setTimeout(resolve, ANIME_HERO_TRAILER_DELAY_MS));
  const keyPromise = getTrailerKey(item.id, type);

  Promise.all([delay, keyPromise]).then(([, key]) => {
    // Slide changed (or trailer stopped) while we were waiting
    if (token !== animeHeroTrailerToken) return;
    if (animeHeroSlides[currentSlide] !== item || document.hidden) return;
    startAnimeHeroTrailer(item, key);
  });
}

function startAnimeHeroTrailer(item, videoKey) {
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
    applyAnimeKenBurns(slide);
    return;
  }

  // Baseline: the backdrop is alive (Ken Burns pan) while the
  // stream connects — the video fades in over it on playback.
  applyAnimeKenBurns(slide);

  animeHeroTrailerHandle = mountTrailerVideo(layer, sources, {
    watchdogMs: 5000,
    onSourceDead: noteSourceDead,
    onResolved(src) {
      rememberTrailerSource(item.id, mediaType, src);
    },
    onPlaying() {
      // Slide changed while the stream was connecting
      if (animeHeroSlides[currentSlide] !== item) {
        stopAnimeHeroTrailer();
        return;
      }
      // The moving picture replaces the Ken Burns pan.
      removeAnimeKenBurns(slide);
      animeHeroTrailerMuted = true;
      updateAnimeHeroMuteButton();
      requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add('playing')));
      const muteBtn = $('#hero-mute-btn');
      if (muteBtn) muteBtn.hidden = false;
    },
    onFailed() {
      // Every direct source failed -> Ken Burns backdrop fallback
      if (animeHeroSlides[currentSlide] !== item) return;
      applyAnimeKenBurns(slide);
    }
  });
}

/** Ken Burns fallback: the slide's backdrop slowly pans/zooms
    (20s loop) — premium even without video. */
function applyAnimeKenBurns(slide) {
  const backdrop = slide ? slide.querySelector('.hero-backdrop') : null;
  if (backdrop) backdrop.classList.add('trailer-fallback');
}

function removeAnimeKenBurns(slide) {
  const backdrop = slide ? slide.querySelector('.hero-backdrop') : null;
  if (backdrop) backdrop.classList.remove('trailer-fallback');
}

function stopAnimeHeroTrailer() {
  $$('.hero-slide .hero-trailer').forEach((layer) => layer.classList.remove('playing'));
  $$('.hero-slide .hero-backdrop.trailer-fallback').forEach((bd) => bd.classList.remove('trailer-fallback'));

  const muteBtn = $('#hero-mute-btn');
  if (muteBtn) muteBtn.hidden = true;

  if (animeHeroTrailerHandle) {
    // Free the decoder immediately — no fade-out wait needed.
    animeHeroTrailerHandle.destroy();
    animeHeroTrailerHandle = null;
  }
  animeHeroTrailerMuted = true;
}

function toggleAnimeHeroTrailerMute() {
  const video = animeHeroTrailerHandle ? animeHeroTrailerHandle.video : null;
  if (!video) return;
  animeHeroTrailerMuted = !animeHeroTrailerMuted;
  video.muted = animeHeroTrailerMuted;
  if (!animeHeroTrailerMuted) {
    try {
      video.volume = 1;
      const attempt = video.play();
      if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {});
    } catch (playError) { /* unmuted resume is best-effort */ }
  }
  updateAnimeHeroMuteButton();
}

function updateAnimeHeroMuteButton() {
  const btn = $('#hero-mute-btn');
  if (!btn) return;
  btn.classList.toggle('muted', animeHeroTrailerMuted);
  btn.setAttribute('aria-pressed', String(!animeHeroTrailerMuted));
  const label = animeHeroTrailerMuted ? 'Unmute trailer' : 'Mute trailer';
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

/* ============================================================
   HORIZONTAL SCROLL ARROWS (all content rows — index.js, ported)
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

/* ---------------- Boot ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  initCommonUI();
  initSectionArrows();
  loadAnimeHero();
  ANIME_ROWS.forEach((config) => loadAnimeRow(config));
});
