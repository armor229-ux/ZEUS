/* ============================================================
   ZEUS - tv.js
   TV show details page: reads ?id= from the URL, renders the
   backdrop banner, poster, meta, seasons list, episode
   selector (season dropdown + episode list linking to the
   player), cast and similar shows.
   ============================================================ */

'use strict';

let currentTVId = null;
let tvSeasons = [];       // [{ season_number, ... }]
let currentSeason = null; // selected season number

document.addEventListener('DOMContentLoaded', () => {
  initCommonUI();

  const id = getUrlParam('id');
  if (!id || !/^\d+$/.test(id)) {
    showInvalidState($('#detail-container'), 'Missing or invalid TV show ID. Please open this page from a valid TV show link.');
    const skeletonEl = $('#detail-skeleton');
    if (skeletonEl) skeletonEl.remove();
    return;
  }
  currentTVId = id;
  loadTVShow(id);
});

async function loadTVShow(id) {
  const container = $('#detail-container');
  const skeleton = $('#detail-skeleton');

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
    const show = await getTVDetails(id);
    renderTVDetails(show);
    renderCast(show.credits ? show.credits.cast : []);
    renderSimilar(show.similar ? show.similar.results : []);
    renderSeasons(show.seasons || []);
  } catch (error) {
    if (container) {
      showErrorState(container, error.message, () => loadTVShow(id), 'page');
    }
  }
}

/* ============================================================
   RENDER: MAIN DETAILS
   ============================================================ */
function renderTVDetails(show) {
  const container = $('#detail-container');
  if (!container) return;

  const year = getMediaYear(show);
  const rating = show.vote_average ? show.vote_average.toFixed(1) : 'N/A';
  const ratingClass = show.vote_average >= 7.5 ? 'green' : '';
  const totalSeasons = show.number_of_seasons || (show.seasons || []).length;
  const totalEpisodes = show.number_of_episodes ||
    (show.seasons || []).reduce((sum, s) => sum + (s.episode_count || 0), 0);
  const firstSeasonNumber = tvFirstSeasonNumber(show);

  // SEO + Open Graph
  updateMetaTags({
    title: `${show.name} (${year}) - Watch Online Free | ZEUS`,
    description: show.overview
      ? show.overview.slice(0, 155)
      : `Watch ${show.name} (${year}) online free in HD on ZEUS.`,
    image: show.backdrop_path ? IMAGE_BASE_URL + BACKDROP_SIZE + show.backdrop_path : undefined
  });

  // Backdrop
  const backdrop = $('#detail-backdrop');
  if (backdrop) {
    backdrop.src = imageUrl(show.backdrop_path, BACKDROP_SIZE, FALLBACK_STILL);
    backdrop.alt = `${show.name || 'TV show'} backdrop`;
    backdrop.dataset.fallback = 'still';
    backdrop.onerror = () => handleImageError(backdrop);
  }

  // Ambient lighting: the whole page glows with this show's colours
  if (typeof ambientBackdrop !== 'undefined' && ambientBackdrop.el) {
    ambientBackdrop.setBase(show);
  }

  const facts = [
    { label: 'Status', value: show.status || 'N/A' },
    { label: 'First Air Date', value: formatDate(show.first_air_date) },
    { label: 'Last Episode', value: show.last_episode_to_air
      ? `S${show.last_episode_to_air.season_number} E${show.last_episode_to_air.episode_number}` : 'N/A' },
    { label: 'Seasons', value: String(totalSeasons) },
    { label: 'Episodes', value: String(totalEpisodes) },
    { label: 'Language', value: getLanguageName(show.original_language) }
  ];

  container.innerHTML = `
    <div class="detail-poster fade-in-up">
      <img src="${imageUrl(show.poster_path, POSTER_SIZE)}"
           alt="${escapeHtml(show.name || 'TV show')} poster"
           loading="lazy"
           decoding="async"
           data-fallback="poster"
           onerror="handleImageError(this)">
      <span class="quality-badge">HD</span>
    </div>

    <div class="detail-info fade-in-up">
      <h1 class="detail-title">${escapeHtml(show.name || 'Untitled')}</h1>
      ${show.original_name && show.original_name !== show.name
        ? `<p class="original-title">Original title: ${escapeHtml(show.original_name)}</p>` : ''}
      ${show.tagline ? `<p class="tagline">"${escapeHtml(show.tagline)}"</p>` : ''}

      <div class="detail-meta">
        <span class="rating-circle" title="TMDB user score">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
            <path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
          </svg>
          <span class="score ${ratingClass}">${rating}</span>
          <span class="votes">${formatCompactNumber(show.vote_count)} votes</span>
        </span>
        <span class="meta-chip">
          <svg viewBox="0 0 24 24"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/></svg>
          ${totalSeasons} Season${totalSeasons === 1 ? '' : 's'}
        </span>
        <span class="meta-chip">
          <svg viewBox="0 0 24 24"><path d="M15 2l-1.5 3H15v2h-2v12c0 1.1.9 2 2 2v2h-8v-2c1.1 0 2-.9 2-2V7H7V5h2.5L8 2h7z"/></svg>
          ${totalEpisodes} Episodes
        </span>
        <span class="meta-chip">
          <svg viewBox="0 0 24 24"><path d="M9 11H7v9h2v-9zm4-7h-2v16h2V4zm4 4h-2v12h2V8z"/></svg>
          ${formatDate(show.first_air_date)}
        </span>
      </div>

      <div class="genre-chips">
        ${(show.genres || []).map((g) => `<span class="genre-chip">${escapeHtml(g.name)}</span>`).join('')}
      </div>

      <h2 class="detail-overview-label"><span class="title-bar"></span>Overview</h2>
      <p class="detail-overview">${escapeHtml(show.overview || 'No overview available for this show yet.')}</p>

      <div class="detail-actions">
        <a class="btn btn-primary" href="watch.html?id=${show.id}&type=tv&season=${firstSeasonNumber}&episode=1">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          Watch Now
        </a>
        ${typeof createWatchlistDetailButton === 'function' ? createWatchlistDetailButton(show) : ''}
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

function tvFirstSeasonNumber(show) {
  const seasons = (show.seasons || []).filter((s) => s.season_number > 0);
  return seasons.length ? seasons[0].season_number : 1;
}

/* ============================================================
   RENDER: SEASONS LIST + SELECTOR
   ============================================================ */
function renderSeasons(seasons) {
  const section = $('#seasons-section');
  const row = $('#seasons-row');
  const select = $('#season-select');
  if (!section || !row || !select) return;

  // Filter out specials (season 0)
  tvSeasons = seasons.filter((s) => s.season_number > 0);
  if (!tvSeasons.length) {
    section.hidden = true;
    $('#episodes-section').hidden = true;
    return;
  }

  section.hidden = false;
  $('#episodes-section').hidden = false;

  // Season cards
  row.innerHTML = '';
  tvSeasons.forEach((season) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'season-card';
    card.dataset.season = season.season_number;
    card.setAttribute('aria-label', `View season ${season.season_number} episodes`);
    card.innerHTML = `
      <div class="season-poster">
        <img src="${imageUrl(season.poster_path, POSTER_SIZE)}"
             alt="${escapeHtml(season.name || `Season ${season.season_number}`)} poster"
             loading="lazy"
             decoding="async"
             data-fallback="poster"
             onerror="handleImageError(this)">
        <span class="card-play" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </span>
      </div>
      <div class="season-info">
        <p class="season-name">${escapeHtml(season.name || `Season ${season.season_number}`)}</p>
        <p class="season-meta">${season.air_date ? season.air_date.split('-')[0] + ' · ' : ''}${season.episode_count || 0} Episodes</p>
      </div>
    `;
    card.addEventListener('click', () => selectSeason(season.season_number));
    row.appendChild(card);
  });

  // Season dropdown
  select.innerHTML = tvSeasons
    .map((s) => `<option value="${s.season_number}">${escapeHtml(s.name || `Season ${s.season_number}`)}</option>`)
    .join('');
  select.addEventListener('change', () => selectSeason(Number(select.value)));

  // Default: first season
  selectSeason(tvSeasons[0].season_number);
}

function selectSeason(seasonNumber) {
  currentSeason = seasonNumber;

  // Sync UI states
  const select = $('#season-select');
  if (select) select.value = String(seasonNumber);
  $$('.season-card').forEach((card) => {
    card.classList.toggle('active', Number(card.dataset.season) === seasonNumber);
  });

  loadEpisodes(currentTVId, seasonNumber);
}

/* ============================================================
   RENDER: EPISODE LIST
   ============================================================ */
async function loadEpisodes(tvId, seasonNumber) {
  const list = $('#episodes-list');
  if (!list) return;

  // Skeleton while loading
  list.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton-episode';
    skeleton.innerHTML = `
      <div class="sk-still shimmer"></div>
      <div>
        <div class="skeleton-line w-60 shimmer" style="margin-bottom: 10px;"></div>
        <div class="skeleton-line w-80 shimmer" style="margin-bottom: 8px;"></div>
        <div class="skeleton-line w-80 shimmer"></div>
      </div>`;
    list.appendChild(skeleton);
  }

  try {
    const seasonData = await getSeasonDetails(tvId, seasonNumber);
    const episodes = seasonData.episodes || [];

    if (!episodes.length) {
      showEmptyState(list, `No episode information available for season ${seasonNumber}.`);
      return;
    }

    list.innerHTML = '';
    const fragment = document.createDocumentFragment();

    episodes.forEach((episode) => {
      const item = document.createElement('a');
      item.className = 'episode-item';
      item.href = `watch.html?id=${tvId}&type=tv&season=${seasonNumber}&episode=${episode.episode_number}`;
      item.innerHTML = `
        <div class="episode-still">
          <img src="${imageUrl(episode.still_path, STILL_SIZE, FALLBACK_STILL)}"
               alt="${escapeHtml(episode.name || `Episode ${episode.episode_number}`)} still"
               loading="lazy"
               decoding="async"
               data-fallback="still"
               onerror="handleImageError(this)">
          <span class="episode-num">${episode.episode_number}</span>
          <div class="episode-play"><span>
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </span></div>
        </div>
        <div class="episode-details">
          <div class="episode-top">
            <h3 class="episode-name">${escapeHtml(episode.name || `Episode ${episode.episode_number}`)}</h3>
            <span class="episode-air">${formatDate(episode.air_date)}</span>
          </div>
          <p class="episode-overview">${escapeHtml(episode.overview || 'No description available for this episode.')}</p>
          ${episode.vote_average ? `
          <span class="episode-rating">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
              <path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
            </svg>
            ${episode.vote_average.toFixed(1)}
          </span>` : ''}
        </div>
      `;
      fragment.appendChild(item);
    });

    list.appendChild(fragment);
  } catch (error) {
    showErrorState(list, error.message, () => loadEpisodes(tvId, seasonNumber));
  }
}

/* ============================================================
   RENDER: CAST & SIMILAR
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
