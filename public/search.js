/* ============================================================
   ZEUS - search.js
   Search page: real-time debounced multi-search rendered as a
   responsive grid, with All / Movies / TV Shows filters,
   ?query= URL support, skeleton loading, empty & error states,
   Load More pagination, and a trending fallback when idle.
   ============================================================ */

'use strict';

/* ---------------- State ---------------- */
let searchQuery = '';
let activeFilter = 'all';      // 'all' | 'movie' | 'tv'
let results = [];              // fetched results (movies + tv only)
let currentPage = 1;
let totalPages = 1;
let totalResults = 0;
let isSearching = false;
let requestToken = 0;          // guards against stale responses

/* ---------------- Elements ---------------- */
let searchInput, clearButton, resultsCount, searchGrid, loadMoreWrap, loadMoreBtn;

document.addEventListener('DOMContentLoaded', () => {
  initCommonUI();

  searchInput = $('#search-input');
  clearButton = $('#search-clear');
  resultsCount = $('#results-count');
  searchGrid = $('#search-grid');
  loadMoreWrap = $('#load-more-wrap');
  loadMoreBtn = $('#load-more');

  // Live search (debounced)
  searchInput.addEventListener('input', debounce(() => {
    handleSearchInput(searchInput.value.trim());
  }, CONFIG.searchDebounce));

  // Enter key triggers search immediately
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleSearchInput(searchInput.value.trim(), true);
    }
  });

  // Clear button
  clearButton.addEventListener('click', () => {
    searchInput.value = '';
    handleSearchInput('');
    searchInput.focus();
  });

  // Filter tabs
  $$('.filter-tab').forEach((tab) => {
    tab.addEventListener('click', () => setFilter(tab.dataset.filter));
  });

  // Load more
  loadMoreBtn.addEventListener('click', loadNextPage);

  // Prefill from ?query=
  const initialQuery = getUrlParam('query');
  if (initialQuery) {
    searchInput.value = initialQuery;
    performSearch(initialQuery);
  } else {
    showTrendingFallback();
  }
});

/* ============================================================
   INPUT HANDLING
   ============================================================ */
function handleSearchInput(value, immediate = false) {
  clearButton.hidden = !value;

  if (!value) {
    // Empty query -> show trending + clean URL
    searchQuery = '';
    results = [];
    currentPage = 1;
    window.history.replaceState(null, '', 'search.html');
    showTrendingFallback();
    return;
  }

  if (immediate) {
    performSearch(value);
  } else {
    searchQuery = value;
    currentPage = 1;
    updateUrl(value);
    performSearch(value);
  }
}

function updateUrl(query) {
  const params = new URLSearchParams();
  params.set('query', query);
  window.history.replaceState(null, '', `search.html?${params.toString()}`);
}

/* ============================================================
   FILTERS
   ============================================================ */
function setFilter(filter) {
  if (activeFilter === filter) return;
  activeFilter = filter;

  $$('.filter-tab').forEach((tab) => {
    const isActive = tab.dataset.filter === filter;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-pressed', String(isActive));
  });

  renderResults();
}

function getFilteredResults() {
  if (activeFilter === 'all') return results;
  return results.filter((item) => getMediaType(item) === activeFilter);
}

/* ============================================================
   SEARCH EXECUTION
   ============================================================ */
async function performSearch(query) {
  if (!query || isSearching) return;

  isSearching = true;
  requestToken += 1;
  const token = requestToken;
  searchQuery = query;
  currentPage = 1;

  showSkeletons(searchGrid, 12);
  resultsCount.hidden = true;
  loadMoreWrap.hidden = true;

  try {
    const data = await searchMovies(query, 1);
    if (token !== requestToken) return; // stale response

    results = (data.results || []).filter(
      (item) => item.media_type === 'movie' || item.media_type === 'tv'
    );
    totalPages = data.total_pages || 1;
    totalResults = data.total_results || 0;

    renderResults();
  } catch (error) {
    if (token !== requestToken) return;
    searchGrid.innerHTML = '';
    showErrorState(searchGrid, error.message, () => performSearch(query));
  } finally {
    if (token === requestToken) isSearching = false;
  }
}

async function loadNextPage() {
  if (!searchQuery || currentPage >= totalPages || isSearching) return;

  isSearching = true;
  requestToken += 1;
  const token = requestToken;
  const nextPage = currentPage + 1;

  loadMoreBtn.disabled = true;
  loadMoreBtn.textContent = 'Loading…';

  try {
    const data = await searchMovies(searchQuery, nextPage);
    if (token !== requestToken) return;

    const newItems = (data.results || []).filter(
      (item) => item.media_type === 'movie' || item.media_type === 'tv'
    );
    // Deduplicate by id+type
    const seen = new Set(results.map((i) => `${getMediaType(i)}-${i.id}`));
    newItems.forEach((item) => {
      const key = `${getMediaType(item)}-${item.id}`;
      if (!seen.has(key)) {
        results.push(item);
        seen.add(key);
      }
    });
    currentPage = nextPage;
    renderResults();
  } catch (error) {
    showErrorState(searchGrid, error.message, () => loadNextPage());
  } finally {
    if (token === requestToken) {
      isSearching = false;
      loadMoreBtn.disabled = false;
      loadMoreBtn.innerHTML = `Load More
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>`;
    }
  }
}

/* ============================================================
   RENDERING
   ============================================================ */
function renderResults() {
  const filtered = getFilteredResults();

  // Results count line
  resultsCount.hidden = false;
  if (activeFilter === 'all') {
    resultsCount.innerHTML = `Found <strong>${totalResults.toLocaleString()}</strong> results for "<strong>${escapeHtml(searchQuery)}</strong>"${results.length < totalResults ? ` — showing ${results.length}` : ''}`;
  } else {
    const label = activeFilter === 'movie' ? 'movies' : 'TV shows';
    resultsCount.innerHTML = `<strong>${filtered.length}</strong> ${label} found for "<strong>${escapeHtml(searchQuery)}</strong>"`;
  }

  if (!filtered.length) {
    searchGrid.innerHTML = `
      <div class="state-message">
        <div class="state-icon empty" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.8">
            <circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/>
          </svg>
        </div>
        <h3>No results found</h3>
        <p>We couldn't find anything${searchQuery ? ` for "${escapeHtml(searchQuery)}"` : ''}. Try a different keyword, or check the spelling.</p>
      </div>`;
    loadMoreWrap.hidden = true;
    return;
  }

  searchGrid.innerHTML = '';
  const fragment = document.createDocumentFragment();
  filtered.forEach((item) => fragment.appendChild(createMovieCard(item)));
  searchGrid.appendChild(fragment);

  // Show "Load More" only for the All tab (fetch-level pagination)
  loadMoreWrap.hidden = !(activeFilter === 'all' && currentPage < totalPages);
}

/** Trending grid shown when there is no active query. */
function showTrendingFallback() {
  resultsCount.hidden = true;
  loadMoreWrap.hidden = true;
  loadSection(searchGrid, getTrending, {
    filterPerson: true,
    requirePoster: true,
    limit: 18,
    emptyMessage: 'Start typing above to search for movies and TV shows.'
  });

  // Section label above the fallback grid
  if (!$('#trending-label')) {
    const label = document.createElement('p');
    label.id = 'trending-label';
    label.className = 'results-count';
    label.style.display = 'block';
    label.innerHTML = '<strong>Trending</strong> this week — or search for something specific above';
    searchGrid.parentNode.insertBefore(label, searchGrid);
  }
}
