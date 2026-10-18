/* ============================================================
   ZEUS - movie.js
   Movie details page: reads ?id= from the URL, renders the
   backdrop banner, poster, meta, overview, facts, cast and
   similar movies. Includes full error handling and retry.
   ============================================================ */

'use strict';

let currentMovieId = null;

document.addEventListener('DOMContentLoaded', () => {
  initCommonUI();

  const id = getUrlParam('id');
  if (!id || !/^\d+$/.test(id)) {
    showInvalidState($('#detail-container'), 'Missing or invalid movie ID. Please open this page from a valid movie link.');
    const skeletonEl = $('#detail-skeleton');
    if (skeletonEl) skeletonEl.remove();
    return;
  }
  currentMovieId = id;
  loadMovie(id);
});

async function loadMovie(id) {
  const container = $('#detail-container');
  const skeleton = $('#detail-skeleton');

  // Show skeleton while loading
  if (container && !skeleton) {
    container.innerHTML = `
      <div class="skeleton-detail" id="detail-skeleton">
        <div><div class="sk-poster shimmer"></div></div>
        <div>
          <div class="sk-line-lg shimmer" style="width: 65%;"></div>
          <div class="skeleton-line w-50 shimmer" style="margin-bottom: 22px;"></div>
          <div class="skeleton-line w-80 shimmer" style="margin-bottom: 10px;"></div>
          <div class="skeleton-line w-80 shimmer" style="margin-bottom: 10px;"></div>
          <div class="skeleton-line w-60 shimmer" style="margin-bottom: 24px;"></div>
          <div class="skeleton-line w-80 shimmer" style="height: 44px; border-radius: 10px;"></div>
        </div>
      </div>`;
  }

  try {
    const movie = await getMovieDetails(id);
    renderMovieDetails(movie);
    renderCast(movie.credits ? movie.credits.cast : []);
    renderSimilar(movie.similar ? movie.similar.results : []);
  } catch (error) {
    if (container) {
      showErrorState(container, error.message, () => loadMovie(id), 'page');
    }
  }
}

/* ============================================================
   RENDER: MAIN DETAILS
   ============================================================ */
function renderMovieDetails(movie) {
  const container = $('#detail-container');
  if (!container) return;

  const year = getMediaYear(movie);
  const rating = movie.vote_average ? movie.vote_average.toFixed(1) : 'N/A';
  const ratingClass = movie.vote_average >= 7.5 ? 'green' : '';

  // SEO + Open Graph
  updateMetaTags({
    title: `${movie.title} (${year}) - Watch Online Free | ZEUS`,
    description: movie.overview
      ? movie.overview.slice(0, 155)
      : `Watch ${movie.title} (${year}) online free in HD on ZEUS.`,
    image: movie.backdrop_path ? IMAGE_BASE_URL + BACKDROP_SIZE + movie.backdrop_path : undefined
  });

  // Backdrop
  const backdrop = $('#detail-backdrop');
  if (backdrop) {
    backdrop.src = imageUrl(movie.backdrop_path, BACKDROP_SIZE, FALLBACK_STILL);
    backdrop.alt = `${movie.title || 'Movie'} backdrop`;
    backdrop.onerror = () => handleImageError(backdrop);
    backdrop.dataset.fallback = 'still';
  }

  // Ambient lighting: the whole page glows with this movie's colours
  if (typeof ambientBackdrop !== 'undefined' && ambientBackdrop.el) {
    ambientBackdrop.setBase(movie);
  }

  const facts = [
    { label: 'Status', value: movie.status || 'N/A' },
    { label: 'Release Date', value: formatDate(movie.release_date) },
    { label: 'Runtime', value: formatRuntime(movie.runtime) },
    { label: 'Budget', value: formatMoney(movie.budget) },
    { label: 'Revenue', value: formatMoney(movie.revenue) },
    { label: 'Language', value: getLanguageName(movie.original_language) }
  ];

  container.innerHTML = `
    <div class="detail-poster fade-in-up">
      <img src="${imageUrl(movie.poster_path, POSTER_SIZE)}"
           alt="${escapeHtml(movie.title || 'Movie')} poster"
           loading="lazy"
           decoding="async"
           data-fallback="poster"
           onerror="handleImageError(this)">
      <span class="quality-badge">HD</span>
    </div>

    <div class="detail-info fade-in-up">
      <h1 class="detail-title">${escapeHtml(movie.title || 'Untitled')}</h1>
      ${movie.original_title && movie.original_title !== movie.title
        ? `<p class="original-title">Original title: ${escapeHtml(movie.original_title)}</p>` : ''}
      ${movie.tagline ? `<p class="tagline">"${escapeHtml(movie.tagline)}"</p>` : ''}

      <div class="detail-meta">
        <span class="rating-circle" title="TMDB user score">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
            <path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
          </svg>
          <span class="score ${ratingClass}">${rating}</span>
          <span class="votes">${formatCompactNumber(movie.vote_count)} votes</span>
        </span>
        <span class="meta-chip">
          <svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 10.4 4.2 2.5-.8 1.3L11 13V7h2v5.4z"/></svg>
          ${formatRuntime(movie.runtime)}
        </span>
        <span class="meta-chip">
          <svg viewBox="0 0 24 24"><path d="M9 11H7v9h2v-9zm4-7h-2v16h2V4zm4 4h-2v12h2V8z"/></svg>
          ${formatDate(movie.release_date)}
        </span>
      </div>

      <div class="genre-chips">
        ${(movie.genres || []).map((g) => `<span class="genre-chip">${escapeHtml(g.name)}</span>`).join('')}
      </div>

      <h2 class="detail-overview-label"><span class="title-bar"></span>Overview</h2>
      <p class="detail-overview">${escapeHtml(movie.overview || 'No overview available for this movie yet.')}</p>

      <div class="detail-actions">
        <a class="btn btn-primary" href="watch.html?id=${movie.id}&type=movie">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          Watch Now
        </a>
        ${typeof createWatchlistDetailButton === 'function' ? createWatchlistDetailButton(movie) : ''}
        <a class="btn btn-glass" href="javascript:history.back()">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
          Go Back
        </a>
      </div>

      <div class="detail-facts">
        ${facts.map((fact) => `
          <div class="fact-item">
            <span class="fact-label">${fact.label}</span>
            <span class="fact-value">${escapeHtml(String(fact.value))}</span>
          </div>`).join('')}
      </div>
    </div>
  `;
}

/* ============================================================
   RENDER: CAST
   ============================================================ */
function renderCast(cast) {
  const section = $('#cast-section');
  const row = $('#cast-row');
  if (!section || !row) return;

  const members = (cast || []).slice(0, CONFIG.castCount);
  if (!members.length) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  row.innerHTML = '';
  const fragment = document.createDocumentFragment();
  members.forEach((person) => fragment.appendChild(createCastCard(person)));
  row.appendChild(fragment);
}

/* ============================================================
   RENDER: SIMILAR MOVIES
   ============================================================ */
function renderSimilar(results) {
  const section = $('#similar-section');
  const grid = $('#similar-grid');
  if (!section || !grid) return;

  const items = (results || []).filter((item) => item.poster_path).slice(0, CONFIG.similarCount);
  if (!items.length) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  grid.innerHTML = '';
  const fragment = document.createDocumentFragment();
  items.forEach((item) => fragment.appendChild(createMovieCard(item)));
  grid.appendChild(fragment);
}
