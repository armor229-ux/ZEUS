/* ============================================================
   ZEUS - subtitle-prefs.js
   Global subtitle preferences: colour + timing offset.

   Loaded app-wide (every page, deferred). Persists to:
     zeus_sub_color     -> string hex   (default "#ffffff")
     zeus_sub_offset_ms -> integer ms   (default 0)

   Exposes window.ZEUS.subtitles for the Settings page UI:
     getColor, getOffset, saveColor, saveOffset,
     applyColor, applyToAllVideos

   • Colour is applied as the --zeus-sub-color CSS variable,
     consumed by the video::cue rule in style.css (and by any
     custom caption overlay that reuses the variable).
   • The timing offset shifts every VTTCue of every subtitles/
     captions track on every <video> on the page — including
     videos added later (MutationObserver) — clamped so cue
     start times never go below zero.
   ============================================================ */

'use strict';

window.ZEUS = window.ZEUS || {};

(function () {

  const LS_COLOR = 'zeus_sub_color';
  const LS_OFFSET = 'zeus_sub_offset_ms';
  const DEFAULT_COLOR = '#ffffff';
  const DEFAULT_OFFSET = 0;
  const originalTimes = new WeakMap(); // Map<VTTCue, {s:number,e:number}>

  function getColor() {
    return localStorage.getItem(LS_COLOR) || DEFAULT_COLOR;
  }

  function getOffset() {
    return parseInt(localStorage.getItem(LS_OFFSET) || DEFAULT_OFFSET, 10) || 0;
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
    document.querySelectorAll('video').forEach((v) => applyOffset(v, ms));
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

  // Expose small API for the settings UI to call
  window.ZEUS.subtitles = {
    getColor, getOffset, saveColor, saveOffset, applyColor, applyToAllVideos
  };

  // Boot
  applyColor();
  watchNewVideos();

})();
