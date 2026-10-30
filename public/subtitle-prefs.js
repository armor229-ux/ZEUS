/* ============================================================
   ZEUS - subtitle-prefs.js
   Global subtitle preferences: colour + timing offset +
   preferred language (auto-select).

   Loaded app-wide (every page, deferred). Persists to:
     zeus_sub_color     -> string hex   (default "#ffffff")
     zeus_sub_offset_ms -> integer ms   (default 0)
     zeus_sub_pref      -> ISO code, e.g. "ar" (default "")

   Exposes window.ZEUS.subtitles for the Settings page UI:
     getColor, getOffset, saveColor, saveOffset,
     applyColor, applyToAllVideos,
     getPref, savePref

   • Colour is applied as the --zeus-sub-color CSS variable,
     consumed by the video::cue rule in style.css (and by any
     custom caption overlay that reuses the variable).
   • The timing offset shifts every VTTCue of every subtitles/
     captions track on every <video> on the page — including
     videos added later (MutationObserver) — clamped so cue
     start times never go below zero.
   • The preferred language auto-selects the matching track
     (e.g. Arabic: srclang="ar" / language starting with "ar" /
     labels like "Arabic", "عربي") whenever a video plays or is
     added — on every page, including watch parties. Other
     subtitle tracks are switched off so captions never double.

   v1.2 — ANIME SUBTITLE DEFAULT (board fix): watch.js flags the
   current playback as anime (TMDB genre 16 = Animation) via
   setAnimeMode(true). For anime, subtitles default ON:
     1. preferred language track wins (existing behavior),
     2. otherwise the FIRST available subtitle/captions track
        is auto-selected,
     3. videos without any subtitle track are left alone —
        playback is never forced or broken.
   Non-anime playback keeps the exact previous behavior.
   ============================================================ */

'use strict';

window.ZEUS = window.ZEUS || {};

(function () {

  const LS_COLOR = 'zeus_sub_color';
  const LS_OFFSET = 'zeus_sub_offset_ms';
  const LS_PREF = 'zeus_sub_pref';
  const DEFAULT_COLOR = '#ffffff';
  const DEFAULT_OFFSET = 0;
  const originalTimes = new WeakMap(); // Map<VTTCue, {s:number,e:number}>
  const prefApplied = new WeakMap();   // Map<HTMLVideoElement, selection key already applied>
  const hookedVideos = new WeakSet();  // videos with play/load listeners attached
  let animeMode = false;               // anime playback: subtitles default ON (set by watch.js)

  /* Words a track LABEL may carry for a preference code — lets
     "Arabic" match labels like "Arabic", "عربي", "Arabic (forced)". */
  const PREF_LABEL_WORDS = {
    ar: ['arabic', 'عربي', 'عربية', 'عرب'],
    tr: ['turkish', 'türkçe', 'turkce'],
    en: ['english'],
    es: ['spanish', 'español', 'espanol'],
    fr: ['french', 'français', 'francais'],
    de: ['german', 'deutsch']
  };

  function getColor() {
    return localStorage.getItem(LS_COLOR) || DEFAULT_COLOR;
  }

  function getOffset() {
    return parseInt(localStorage.getItem(LS_OFFSET) || DEFAULT_OFFSET, 10) || 0;
  }

  function getPref() {
    return (localStorage.getItem(LS_PREF) || '').toLowerCase();
  }

  /* Does a text track match the preferred language? Matches the
     track's language code ("ar", "ar-SA", "ar_EG") or a label
     containing a friendly name for the preference ("Arabic",
     "عربي", "Türkçe", ...). */
  function trackMatchesPref(track, pref) {
    if (!pref) return false;
    const lang = String(track.language || '').toLowerCase();
    if (lang === pref || lang.indexOf(pref + '-') === 0 || lang.indexOf(pref + '_') === 0) {
      return true;
    }
    const label = String(track.label || '').toLowerCase();
    const words = PREF_LABEL_WORDS[pref] || [pref];
    return words.some((word) => label.indexOf(word) !== -1);
  }

  /* Auto-select the best subtitle track on one video.
     Priority: preferred language (Settings) → first available
     track when the playback is flagged anime → nothing.
     Runs at most once per (video, selection key) pair so a
     user's manual track choice is never fought on every play
     event; picking a different preference in Settings or
     toggling anime mode re-triggers it exactly once. */
  function applyPrefToVideo(video) {
    if (!video || !video.textTracks) return;

    const pref = getPref();
    const selectionKey = (pref || '-') + '|' + (animeMode ? 'anime' : '-');
    if (prefApplied.get(video) === selectionKey) return;

    const tracks = video.textTracks;

    /* Show exactly one track and disable every other
       subtitle/captions track — captions never double. */
    function showOnly(track) {
      for (let j = 0; j < tracks.length; j++) {
        if (tracks[j] !== track && (tracks[j].kind === 'subtitles' || tracks[j].kind === 'captions')) {
          tracks[j].mode = 'disabled';
        }
      }
      track.mode = 'showing';
      prefApplied.set(video, selectionKey);
    }

    // 1) the user's preferred language always wins
    if (pref) {
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        if ((track.kind === 'subtitles' || track.kind === 'captions') && trackMatchesPref(track, pref)) {
          showOnly(track);
          return;
        }
      }
    }

    // 2) anime playback: subtitles default ON — first valid track
    if (animeMode) {
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        if (track.kind === 'subtitles' || track.kind === 'captions') {
          showOnly(track);
          return;
        }
      }
    }

    // 3) no preference, not anime (or no tracks at all): untouched
  }

  /* Anime flag — set by watch.js when the loaded title's TMDB
     genres include Animation (16). Re-applies to every video so
     an already-present player picks the track up immediately. */
  function setAnimeMode(on) {
    animeMode = !!on;
    applyToAllVideos();
  }

  /* "On any video play" hook — tracks and cues often appear
     only after playback starts, so re-check on every play /
     metadata / load event. Attached once per video. */
  function hookVideo(video) {
    if (!video || hookedVideos.has(video)) return;
    hookedVideos.add(video);
    const reselect = () => applyPrefToVideo(video);
    video.addEventListener('play', reselect);
    video.addEventListener('loadedmetadata', reselect);
    video.addEventListener('loadstart', reselect);
  }

  function applyColor() {
    document.documentElement.style.setProperty('--zeus-sub-color', getColor());
  }

  function applyOffsetToTrack(track, ms) {
    // Ensure cues are loaded
    if (!track || !track.cues) return;
    const offset = (ms | 0) / 1000;
    for (let i = 0; i < track.cues.length; i++) {
      const cue = track.cues[i];
      if (!originalTimes.has(cue)) {
        originalTimes.set(cue, { s: cue.startTime, e: cue.endTime });
      }
      const base = originalTimes.get(cue);
      let ns = base.s + offset;
      let ne = base.e + offset;
      if (ns < 0) { ne -= ns; ns = 0; } // clamp start >= 0
      cue.startTime = ns;
      cue.endTime = Math.max(ne, ns + 0.05);
    }
  }

  function applyOffset(video, ms) {
    if (!video) return;
    const tracks = video.textTracks || [];
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t.kind === 'subtitles' || t.kind === 'captions') {
        if (t.mode === 'disabled') t.mode = 'hidden'; // ensure cues load
        // If cues are not ready yet, wait until they are
        if (!t.cues || t.cues.length === 0) {
          const onCueLoad = () => {
            applyOffsetToTrack(t, ms);
            t.removeEventListener('cuechange', onCueLoad);
          };
          t.addEventListener('cuechange', onCueLoad);
        } else {
          applyOffsetToTrack(t, ms);
        }
      }
    }
  }

  function applyToAllVideos() {
    const ms = getOffset();
    document.querySelectorAll('video').forEach((v) => {
      hookVideo(v);
      applyOffset(v, ms);
      applyPrefToVideo(v);
    });
  }

  function watchNewVideos() {
    // Coalesce mutation bursts into a single rAF pass so long
    // listing pages stay silky while still catching every new
    // <video> the moment it appears.
    let rafPending = false;
    const mo = new MutationObserver(() => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        applyToAllVideos();
      });
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('DOMContentLoaded', applyToAllVideos);
  }

  function saveColor(hex) {
    localStorage.setItem(LS_COLOR, hex);
    applyColor();
  }

  function saveOffset(ms) {
    localStorage.setItem(LS_OFFSET, String(ms | 0));
    applyToAllVideos();
  }

  function savePref(code) {
    try {
      localStorage.setItem(LS_PREF, String(code || '').toLowerCase());
    } catch (err) { /* storage blocked — preference stays for this page load */ }
    applyToAllVideos(); // re-select on every video right now (guard is per-pref)
  }

  // Expose small API for the settings UI + watch page to call
  window.ZEUS.subtitles = {
    getColor, getOffset, saveColor, saveOffset, applyColor, applyToAllVideos,
    getPref, savePref, setAnimeMode
  };

  // Boot
  applyColor();
  watchNewVideos();

})();
