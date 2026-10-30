/* ============================================================
   ZEUS - genre.js  (v1.0)
   Genre page: powers the dedicated /genre route (ZEUS FULL
   UPDATE, Part 1 — the Genre tab gets its own page instead of
   jumping to a Home anchor).

   One responsive grid (§43) of .genre-card tiles (§10 — the
   exact component the homepage "Popular Genres" row uses).
   Each tile is dressed with representative art from the most
   popular movies in that genre (same trick as the homepage
   mood cards) and opens the Discover page filtered to it:
   /discover?genre={id}

   Zero new styling beyond §43, no new libraries, all existing
   components (showSkeletons, showErrorState, ambient lighting).
   ============================================================ */

'use strict';

/* ---------------- Genre palette map ----------------
   The 8 homepage mood palettes (§10 .genre-card--* classes);
   every other genre falls back to the neutral base gradient. */
const GENRE_PAGE_PALETTES = {
  28: 'action',
  35: 'comedy',
  18: 'drama',
  27: 'horror',
  10749: 'romance',
  12: 'adventure',
  878: 'scifi',
  53: 'thriller'
};

/* ---------------- Boot ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  initCommonUI();
  loadGenrePage();
});

/* ---------------- Loader (loadGenreMoods pattern) ---------------- */
async function loadGenrePage() {
  const grid = $('#genre-page-grid');
  if (!grid) return;

  const genres = (typeof GENRE_LIST !== 'undefined' ? GENRE_LIST.slice() : [])
    .filter((g) => g && g.id && g.name);

  if (!genres.length) {
    showErrorState(grid, 'No genres available right now.', loadGenrePage);
    return;
  }

  showSkeletons(grid, genres.length, 'card-wide');
  try {
    // One cheap discover per genre -> the most popular movie with
    // a backdrop becomes the tile art (a miss just leaves the
    // gradient-only card, exactly like the homepage mood row).
    const artPaths = await Promise.all(
      genres.map(async (genre) => {
        try {
          const data = await discoverByGenre(genre.id);
          const hit = ((data && data.results) || []).find((movie) => movie.backdrop_path);
          return hit ? hit.backdrop_path : null;
        } catch (error) {
          return null; // gradient-only card still renders
        }
      })
    );

    grid.innerHTML = '';
    const fragment = document.createDocumentFragment();
    let ambientSeed = null;

    genres.forEach((genre, index) => {
      fragment.appendChild(createGenrePageCard(genre, artPaths[index]));
      if (!ambientSeed && artPaths[index]) {
        // Ambient lighting: seed the glow with the first tile's art
        ambientSeed = { backdrop_path: artPaths[index], poster_path: artPaths[index] };
      }
    });
    grid.appendChild(fragment);

    if (ambientSeed && typeof ambientBackdrop !== 'undefined' && ambientBackdrop.el) {
      ambientBackdrop.setBase(ambientSeed);
    }
  } catch (error) {
    showErrorState(grid, error.message, loadGenrePage);
  }
}

/** Build one tile: representative art + mood gradient, links
    straight into the Discover page filtered to this genre. */
function createGenrePageCard(genre, backdropPath) {
  const cls = GENRE_PAGE_PALETTES[genre.id] || '';
  const card = document.createElement('a');
  card.className = `genre-card${cls ? ` genre-card--${cls}` : ''}`;
  card.href = `/discover?genre=${genre.id}`;
  card.setAttribute('aria-label', `Browse ${genre.name} movies`);
  if (backdropPath) {
    card.style.setProperty('--genre-art', `url('${IMAGE_BASE_URL}${BACKDROP_MD_SIZE}${backdropPath}')`);
  }
  card.innerHTML = `<span class="genre-name">${escapeHtml(genre.name)}</span>`;
  return card;
}
