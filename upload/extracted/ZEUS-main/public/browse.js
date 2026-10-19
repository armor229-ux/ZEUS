/* ============================================================
   ZEUS - browse.js
   Browse page: powers the Movies / TV Shows / Top IMDB /
   Trending nav links and genre dropdown pages (?type= or
   ?genre=), with a responsive grid, skeletons, error retry
   and Load More pagination.
   ============================================================ */

'use strict';

/* ---------------- Page configurations ---------------- */
const BROWSE_MODES = {
  movie: {
    title: 'Popular Movies',
    subtitle: 'Discover the most-watched movies right now, updated daily.',
    fetch: (page) => getPopularMovies(page),
    nav: 'movie'
  },
  tv: {
    title: 'Popular TV Shows',
    subtitle: 'The shows everyone is talking about — stream every season in HD.',
    fetch: (page) => getPopularTV(page),
    nav: 'tv'
  },
  top: {
    title: 'Top IMDB Rated',
    subtitle: 'The highest-rated movies of all time, ranked by TMDB score.',
    fetch: (page) => getTopRatedMovies(page),
    nav: 'top'
  },
  trending: {
    title: 'Trending This Week',
    subtitle: 'What the world is watching and searching for right now.',
    fetch: (page) => getTrendingAll(page),
    nav: null
  }
};

/* ---------------- State ---------------- */
let browseMode = BROWSE_MODES.movie;
let browseGenreId = null;
let browseGenreName = '';
let currentPage = 1;
let totalPages = 1;
let isLoading = false;
let requestToken = 0;

let browseGrid, loadMoreWrap, loadMoreBtn;

document.addEventListener('DOMContentLoaded', () => {
  initCommonUI();

  browseGrid = $('#browse-grid');
  loadMoreWrap = $('#load-more-wrap');
  loadMoreBtn = $('#load-more');

  loadMoreBtn.addEventListener('click', loadNextPage);

  resolveModeFromUrl();
  applyHeader();
  loadFirstPage();
});

/* ============================================================
   MODE RESOLUTION (?type= / ?genre=)
   ============================================================ */
function resolveModeFromUrl() {
  const type = getUrlParam('type');
  const genreParam = getUrlParam('genre');

  if (genreParam && /^\d+$/.test(genreParam)) {
    browseGenreId = Number(genreParam);
    const knownGenre = GENRE_LIST.find((g) => g.id === browseGenreId);
    browseGenreName = knownGenre ? knownGenre.name : `Genre ${browseGenreId}`;
    return;
  }

  browseMode = BROWSE_MODES[type] || BROWSE_MODES.movie;
}

function applyHeader() {
  const titleText = $('#browse-title-text');
  const subtitle = $('#browse-subtitle');

  if (browseGenreId) {
    if (titleText) titleText.textContent = `${browseGenreName} Movies`;
    if (subtitle) subtitle.textContent = `The most popular ${browseGenreName.toLowerCase()} movies — stream online free in HD.`;
    document.title = `${browseGenreName} Movies - Watch Online Free | ZEUS`;
    setActiveNav('movie'); // genre pages highlight "Movies"
  } else {
    if (titleText) titleText.textContent = browseMode.title;
    if (subtitle) subtitle.textContent = browseMode.subtitle;
    document.title = `${browseMode.title} - Watch Online Free | ZEUS`;
    setActiveNav(browseMode.nav);
  }
}

function setActiveNav(navKey) {
  if (!navKey) return;
  $$('.nav-link[data-nav]').forEach((link) => {
    link.classList.toggle('active', link.dataset.nav === navKey);
  });
}

/* ============================================================
   DATA LOADING
   ============================================================ */
function fetchPage(page) {
  if (browseGenreId) {
    return discoverByGenre(browseGenreId, page, 'movie');
  }
  return browseMode.fetch(page);
}

function appendItems(items) {
  const fragment = document.createDocumentFragment();
  items.forEach((item) => fragment.appendChild(createMovieCard(item)));
  browseGrid.appendChild(fragment);
}

async function loadFirstPage() {
  currentPage = 1;
  requestToken += 1;
  const token = requestToken;

  showSkeletons(browseGrid, CONFIG.skeletonCards);
  loadMoreWrap.hidden = true;

  try {
    const data = await fetchPage(1);
    if (token !== requestToken) return;

    let items = (data.results || []);
    if (browseMode === BROWSE_MODES.trending) {
      items = items.filter((item) => item.media_type !== 'person');
    }
    items = items.filter((item) => item.poster_path);

    totalPages = data.total_pages || 1;

    if (!items.length) {
      showEmptyState(browseGrid, 'No titles found here. Try another category or genre.');
      return;
    }

    browseGrid.innerHTML = '';
    appendItems(items);
    loadMoreWrap.hidden = currentPage >= totalPages;

    // Ambient lighting: seed the glow with the first backdrop art
    if (typeof ambientBackdrop !== 'undefined' && ambientBackdrop.el) {
      const seed = items.find((item) => item.backdrop_path || item.poster_path);
      if (seed) ambientBackdrop.setBase(seed);
    }
  } catch (error) {
    if (token !== requestToken) return;
    browseGrid.innerHTML = '';
    showErrorState(browseGrid, error.message, () => loadFirstPage());
  }
}

async function loadNextPage() {
  if (isLoading || currentPage >= totalPages) return;

  isLoading = true;
  requestToken += 1;
  const token = requestToken;
  const nextPage = currentPage + 1;

  loadMoreBtn.disabled = true;
  loadMoreBtn.textContent = 'Loading…';

  try {
    const data = await fetchPage(nextPage);
    if (token !== requestToken) return;

    const items = (data.results || [])
      .filter((item) => item.poster_path)
      .filter((item) => item.media_type !== 'person');

    currentPage = nextPage;
    if (items.length) {
      appendItems(items);
    }
    loadMoreWrap.hidden = currentPage >= totalPages;
  } catch (error) {
    showErrorState(browseGrid, error.message, () => loadNextPage());
    loadMoreWrap.hidden = false;
  } finally {
    if (token === requestToken) {
      isLoading = false;
      loadMoreBtn.disabled = false;
      loadMoreBtn.innerHTML = `Load More
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>`;
    }
  }
}
